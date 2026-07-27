from fastapi import FastAPI, HTTPException, Body, Request, Response, Depends, Cookie, BackgroundTasks
from pydantic import BaseModel, HttpUrl, EmailStr
from enrichment_service import enrich_event_pipeline
from motor.motor_asyncio import AsyncIOMotorClient
from datetime import datetime, timedelta
import os
import httpx
import logging
import statistics
import re
import jwt
import bcrypt
from uuid import uuid4
from typing import List, Optional
from dotenv import load_dotenv

load_dotenv()
# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

# Configuration
MONGODB_URI = os.getenv("MONGODB_URI")
if not MONGODB_URI:
    logger.warning("MONGODB_URI not set")

JWT_SECRET = os.getenv("JWT_SECRET", "default_secret_for_dev_only")
PROCESSING_THRESHOLD = 100
N8N_WEBHOOK_URL = os.getenv("N8N_WEBHOOK_URL")

# MongoDB Client
client = AsyncIOMotorClient(MONGODB_URI) if MONGODB_URI else None
db = client.get_database() if client else None

# --- AUTH HELPERS ---
def hash_password(password: str) -> str:
    pwd_bytes = password.encode('utf-8')
    salt = bcrypt.gensalt()
    hashed = bcrypt.hashpw(pwd_bytes, salt)
    return hashed.decode('utf-8')

def verify_password(plain_password: str, hashed_password: str) -> bool:
    password_byte_enc = plain_password.encode('utf-8')
    hashed_password_byte_enc = hashed_password.encode('utf-8')
    return bcrypt.checkpw(password_byte_enc, hashed_password_byte_enc)

def create_jwt(user_id: str, email: str) -> str:
    payload = {
        "user_id": user_id,
        "email": email,
        "exp": datetime.utcnow() + timedelta(days=7)
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")

# def decode_jwt(token: str) -> Optional[dict]:
#     try:
#         return jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
#     except Exception:
#         return None

def decode_jwt(token: str) -> Optional[dict]:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        print("JWT decoded successfully:", payload)
        return payload

    except Exception as e:
        print("JWT ERROR:", type(e).__name__, str(e))
        return None

# async def get_current_user(request: Request):
#     token = request.cookies.get("auth_token")
#     if not token:
#         raise HTTPException(status_code=401, detail="Authentication required")
#     payload = decode_jwt(token)
#     if not payload:
#         raise HTTPException(status_code=403, detail="Invalid or expired token")
#     return payload

async def get_current_user(request: Request):
    token = request.cookies.get("auth_token")

    print("TOKEN:", token)

    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")

    payload = decode_jwt(token)

    print("PAYLOAD:", payload)

    if not payload:
        raise HTTPException(status_code=403, detail="Invalid or expired token")

    return payload

# --- PYDANTIC SCHEMAS ---
class SignupRequest(BaseModel):
    email: str
    password: str

class LoginRequest(BaseModel):
    email: str
    password: str

class ConsentRequest(BaseModel):
    consent_given: bool

class ExtensionVerifyRequest(BaseModel):
    extension_id: str

class EventPayload(BaseModel):
    user_id: str
    platform: str
    content_title: str
    url: HttpUrl
    timestamp_start: str
    timestamp_end: str
    duration_seconds: float

class ProcessRequest(BaseModel):
    user_id: str

@app.on_event("startup")
async def startup_db_client():
    if not client:
        logger.error("MongoDB client not initialized")

@app.on_event("shutdown")
async def shutdown_db_client():
    if client:
        client.close()

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "db": "connected" if db is not None else "disconnected"
    }

@app.get("/api/ping")
async def ping():
    return {"status": "alive", "dbConnected": db is not None}

# --- PHASE 1: AUTHENTICATION ---
@app.post("/api/auth/signup")
async def signup(response: Response, payload: SignupRequest):
    if db is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    
    existing = await db.users.find_one({"email": payload.email})
    if existing:
        raise HTTPException(status_code=400, detail="User already exists")
    
    hashed = hash_password(payload.password)
    user_id = str(uuid4())
    
    user_doc = {
        "user_id": user_id,
        "email": payload.email,
        "password": hashed,
        "created_at": datetime.utcnow().isoformat()
    }
    
    await db.users.insert_one(user_doc)
    
    token = create_jwt(user_id, payload.email)
    response.set_cookie(
        key="auth_token",
        value=token,
        httponly=True,
        max_age=7 * 24 * 60 * 60,
        samesite="lax",
        secure=False
    )
    
    return {"user_id": user_id, "email": payload.email, "message": "User created successfully"}

@app.post("/api/auth/login")
async def login(response: Response, payload: LoginRequest):
    if db is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    
    user = await db.users.find_one({"email": payload.email})
    if not user:
        raise HTTPException(status_code=400, detail="Invalid credentials")
    
    if not verify_password(payload.password, user["password"]):
        raise HTTPException(status_code=400, detail="Invalid credentials")
        
    token = create_jwt(user["user_id"], user["email"])
    response.set_cookie(
        key="auth_token",
        value=token,
        httponly=True,
        max_age=7 * 24 * 60 * 60,
        samesite="lax",
        secure=False
    )
    
    return {"user_id": user["user_id"], "email": user["email"]}

@app.get("/api/auth/me")
async def me(current_user: dict = Depends(get_current_user)):
    return {"user_id": current_user["user_id"], "email": current_user["email"]}

@app.post("/api/auth/logout")
async def logout(response: Response):
    response.delete_cookie("auth_token")
    return {"message": "Logged out"}

# --- PHASE 1: CONSENT ---
@app.post("/api/consent")
async def save_consent(payload: ConsentRequest, current_user: dict = Depends(get_current_user)):
    if db is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    
    user_id = current_user["user_id"]
    await db.consents.update_one(
        {"user_id": user_id},
        {"$set": {"consent_given": payload.consent_given, "updated_at": datetime.utcnow().isoformat()}},
        upsert=True
    )
    return {"user_id": user_id, "consent_given": payload.consent_given}

@app.get("/api/consent-status")
async def consent_status(current_user: dict = Depends(get_current_user)):
    if db is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
        
    user_id = current_user["user_id"]
    consent = await db.consents.find_one({"user_id": user_id})
    return {"user_id": user_id, "consent_given": consent.get("consent_given", False) if consent else False}

@app.post("/api/withdraw-consent")
async def withdraw_consent(current_user: dict = Depends(get_current_user)):
    if db is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
        
    user_id = current_user["user_id"]
    await db.consents.update_one(
        {"user_id": user_id},
        {"$set": {"consent_given": False, "updated_at": datetime.utcnow().isoformat()}}
    )
    return {"success": True, "message": "Consent withdrawn"}

@app.delete("/api/delete-data")
async def delete_data(response: Response, current_user: dict = Depends(get_current_user)):
    if db is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
        
    user_id = current_user["user_id"]
    await db.users.delete_one({"user_id": user_id})
    await db.consents.delete_one({"user_id": user_id})
    await db.raw_events.delete_many({"user_id": user_id})
    await db.user_features.delete_many({"user_id": user_id})
    await db.behavior_profiles.delete_many({"user_id": user_id})
    await db.processing_status.delete_many({"user_id": user_id})
    
    response.delete_cookie("auth_token")
    return {"success": True, "message": "User data deleted"}

@app.post("/api/verify-extension")
async def verify_extension(payload: ExtensionVerifyRequest, current_user: dict = Depends(get_current_user)):
    return {"verified": True, "extension_id": payload.extension_id}

# --- PHASE 3: EVENT STORAGE ---
@app.post("/events")
async def store_event(event: EventPayload, background_tasks: BackgroundTasks):
    if db is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    
    if event.duration_seconds < 5:
        raise HTTPException(status_code=400, detail="Duration must be at least 5 seconds")
    
    if not event.content_title.strip():
        raise HTTPException(status_code=400, detail="Content title is required")

    event_dict = event.dict()
    event_dict["url"] = str(event_dict["url"])
    event_dict["created_at"] = datetime.utcnow().isoformat()
    
    await db.raw_events.insert_one(event_dict)
    logger.info(f"Event stored for user {event.user_id}")

    # Enqueue enrichment pipeline to collect, enrich, and store in background
    background_tasks.add_task(enrich_event_pipeline, event_dict, db)

    count = await db.raw_events.count_documents({"user_id": event.user_id})

    if count >= PROCESSING_THRESHOLD:
        status = await db.processing_status.find_one({"user_id": event.user_id})
        
        if not status or not status.get("processing_triggered", False):
            trigger_payload = {
                "user_id": event.user_id,
                "event_count": count,
                "triggered_at": datetime.utcnow().isoformat()
            }

            await db.processing_status.update_one(
                {"user_id": event.user_id},
                {
                    "$set": {
                        "processing_triggered": True,
                        "total_events": count,
                        "last_triggered_at": trigger_payload["triggered_at"]
                    }
                },
                upsert=True
            )

            if N8N_WEBHOOK_URL:
                try:
                    async with httpx.AsyncClient() as httpx_client:
                        await httpx_client.post(N8N_WEBHOOK_URL, json=trigger_payload)
                except Exception as e:
                    logger.error(f"Error triggering n8n: {e}")

    return {"message": "Event stored"}

# --- PHASE 4: PROCESSING PIPELINE ---
def clean_title(title: str) -> str:
    title = title.lower().replace(" - youtube", "")
    title = re.sub(r'[^\w\s]', '', title)
    return re.sub(r'\s+', ' ', title).strip()

def get_sentiment_score(title: str) -> float:
    pos = {"happy", "good", "great", "awesome", "amazing", "love", "best", "funny", "laugh", "joy"}
    neg = {"sad", "bad", "worst", "hate", "terrible", "awful", "scary", "death", "angry", "pain"}
    words = title.lower().split()
    score = 0.0
    for w in words:
        if w in pos: score += 1.0
        if w in neg: score -= 1.0
    return score

@app.post("/process-data")
async def process_data(req: ProcessRequest):
    if db is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    
    cursor = db.raw_events.find({"user_id": req.user_id})
    events = await cursor.to_list(length=1000)
    
    if events is None:
        raise HTTPException(status_code=404, detail="No events found")

    valid_events = [e for e in events if e.get("duration_seconds", 0) >= 5 and e.get("content_title")]
    if not valid_events:
        raise HTTPException(status_code=400, detail="No valid events")

    total_events = len(valid_events)
    total_time = sum(e["duration_seconds"] for e in valid_events)
    
    late_night = 0
    hours = []
    for e in valid_events:
        dt = datetime.fromisoformat(e["timestamp_start"].replace("Z", "+00:00"))
        hours.append(dt.hour)
        if dt.hour >= 22 or dt.hour < 4:
            late_night += 1
    
    ln_ratio = late_night / total_events
    consistency = 1.0 - (statistics.stdev(hours) / 12.0) if len(hours) > 1 else 1.0
    consistency = max(0.0, min(1.0, consistency))

    meaningful_words = {w for t in [clean_title(e["content_title"]) for e in valid_events] for w in t.split() if len(w) > 3}
    topic_div = len(meaningful_words) / (total_events + 1)

    all_titles = [clean_title(e["content_title"]) for e in valid_events]
    repetitive = sum(1 for t, c in {t: all_titles.count(t) for t in set(all_titles)}.items() if c > 1) / len(set(all_titles))

    sent_scores = [get_sentiment_score(e["content_title"]) for e in valid_events]
    avg_sent = sum(sent_scores) / total_events
    sent_var = statistics.variance(sent_scores) if len(sent_scores) > 1 else 0.0

    features = {
        "user_id": req.user_id,
        "total_events": total_events,
        "avg_session_duration": total_time / total_events,
        "total_watch_time": total_time,
        "late_night_ratio": ln_ratio,
        "topic_diversity": topic_div,
        "repetition_score": repetitive,
        "activity_consistency": consistency,
        "avg_sentiment": avg_sent,
        "processed_at": datetime.utcnow().isoformat()
    }

    await db.user_features.update_one({"user_id": req.user_id}, {"$set": features}, upsert=True)

    profile = {
        "user_id": req.user_id,
        "signals": {
            "curiosity_signal": "High" if topic_div > 0.5 else ("Moderate" if topic_div > 0.2 else "Low"),
            "discipline_signal": "High" if (consistency > 0.7 and ln_ratio < 0.2) else ("Low" if ln_ratio > 0.5 else "Moderate"),
            "engagement_signal": "High" if total_time > 3600 else ("Moderate" if total_time > 1800 else "Low"),
            "emotional_stability_signal": "High" if sent_var < 1.0 else "Variable"
        },
        "derived_at": datetime.utcnow().isoformat()
    }

    await db.behavior_profiles.update_one({"user_id": req.user_id}, {"$set": profile}, upsert=True)

    return {"message": "Processing completed", "user_id": req.user_id, "summary": profile["signals"]}

