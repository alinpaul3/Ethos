from fastapi import FastAPI, HTTPException, Body, Request, Response, Depends, Cookie, BackgroundTasks
from pydantic import BaseModel, HttpUrl, EmailStr
from enrichment_service import enrich_event_pipeline
from motor.motor_asyncio import AsyncIOMotorClient
from datetime import datetime, timedelta
import os
from fastapi.responses import JSONResponse
import httpx
import logging
import statistics
import re
import jwt
import bcrypt
from uuid import uuid4
from typing import List, Optional
from dotenv import load_dotenv
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()
# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://ethos-analysis.onrender.com",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
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
class N8nTriggerRequest(BaseModel):
    user_id: Optional[str] = "test_user"

class PreprocessRequest(BaseModel):
    user_id: Optional[str] = None
    event_count: Optional[int] = 0
    events: Optional[List[dict]] = None

class PipelineStageRequest(BaseModel):
    user_id: Optional[str] = None
    event_count: Optional[int] = None
    events: Optional[List[dict]] = None
    features: Optional[dict] = None
    signals: Optional[dict] = None


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

@app.get("/api/n8n/health")
@app.get("/n8n/health")
async def n8n_health():
    is_configured = bool(N8N_WEBHOOK_URL)
    return {
        "status": "healthy" if is_configured else "unconfigured",
        "n8n_webhook_configured": is_configured,
        "webhook_url_set": is_configured,
        "timestamp": datetime.utcnow().isoformat()
    }
@app.get("/api/n8n/status")
@app.get("/n8n/status")
async def n8n_status():
    is_configured = bool(N8N_WEBHOOK_URL)
    return {
        "status": "configured" if is_configured else "unconfigured",
        "n8n_webhook_configured": is_configured,
        "webhook_url_set": is_configured,
        "webhook_url": N8N_WEBHOOK_URL if is_configured else None,
        "timestamp": datetime.utcnow().isoformat()
    }
@app.post("/api/n8n/trigger")
@app.post("/n8n/trigger")
async def n8n_trigger(payload: Optional[N8nTriggerRequest] = Body(None)):
    
    user_id = payload.user_id if payload and payload.user_id else "test_user"
    event_count = 0
    if db is not None:
        try:
            event_count = await db.raw_events.count_documents({"user_id": user_id})
        except Exception as db_err:
            logger.error(f"Error counting documents in raw_events: {db_err}")
    
    trigger_payload = {
        "user_id": user_id,
        "event_count": event_count,
        "triggered_at": datetime.utcnow().isoformat()
         }

    if not N8N_WEBHOOK_URL:
        return {
            "status": "unconfigured",
            "message": "N8N_WEBHOOK_URL is not set in environment variables",
            "payload_sent": trigger_payload
    }

    try:
        async with httpx.AsyncClient() as httpx_client:
            res = await httpx_client.post(N8N_WEBHOOK_URL, json=trigger_payload, timeout=10.0)
            return {
                "status": "triggered" if res.is_success else "failed",
                "n8n_status_code": res.status_code,
                "n8n_response": res.text[:300],
                "payload_sent": trigger_payload
            }
    except Exception as e:
        logger.error(f"Error triggering n8n webhook: {e}")
        return {
            "status": "error",
            "message": f"Failed to call n8n webhook: {str(e)}",
            "payload_sent": trigger_payload
        }

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
       samesite="none",
       secure=True
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
@app.post("/preprocess")
@app.post("/api/preprocess")
async def preprocess(payload: Optional[PreprocessRequest] = Body(None)):
    user_id = payload.user_id if payload else None
    events = payload.events if payload else None
    event_count = payload.event_count if payload else 0

    logger.info(f"[Preprocess API] Processing started for user: {user_id or 'unknown'}. Events to process: {event_count or 0}")

    if not user_id:
        logger.error("[Preprocess API] Processing failed. Error: Missing user_id.")
        return JSONResponse(status_code=400, content={
            "status": "failed",
            "message": "user_id is required"
        })

    if events is None or not isinstance(events, list):
        logger.error(f"[Preprocess API] Processing failed for user: {user_id}. Error: Invalid or missing events list.")
        return JSONResponse(status_code=400, content={
            "status": "failed",
            "message": "events must be an array of enriched browsing documents"
        })

    try:
        if db is not None:
            await db.processing_status.update_one(
                {"user_id": user_id},
                {
                    "$set": {
                        "preprocessed_dataset_packaged": True,
                        "last_preprocessed_at": datetime.utcnow().isoformat(),
                        "preprocessed_events_count": len(events)
                    }
                },
                upsert=True
            )

        logger.info(f"[Preprocess API] Processing completed successfully for user: {user_id}. {len(events)} events processed.")

        return {
            "status": "success",
            "message": "Preprocessing completed",
            "user_id": user_id,
            "processed_events_count": len(events),
            "next_stages_ready": ["feature-engineering", "behavior-model", "ocean-model", "generate-explanation"],
            "timestamp": datetime.utcnow().isoformat()
        }
    except Exception as error:
        logger.error(f"[Preprocess API] Processing failed for user: {user_id}. Error: {error}")
        return JSONResponse(status_code=500, content={
            "status": "failed",
            "message": "Internal preprocessing failure",
            "error": str(error)
        })

@app.post("/feature-engineering")
@app.post("/api/feature-engineering")
async def feature_engineering(payload: Optional[PipelineStageRequest] = Body(None)):
    user_id = (payload.user_id if payload and payload.user_id else None) or "test_user"
    events_input = payload.events if payload else None

    logger.info(f"[Feature Engineering API] Started for user: {user_id}")

    try:
        events = events_input
        if not events and db is not None:
            try:
                events = await db.raw_events.find({"user_id": user_id}).to_list(1000)
                if not events:
                    events = await db.enriched_events.find({"user_id": user_id}).to_list(1000)
            except Exception as db_err:
                logger.error(f"Error fetching events for user {user_id}: {db_err}")

        events = events or []
        valid_events = [
            e for e in events 
            if (isinstance(e, dict) and (e.get("duration_seconds", 0) >= 5 or "content_title" in e or (e.get("browser_event") and e["browser_event"].get("content_title"))))
        ]
        total_events = len(valid_events)

        if total_events == 0:
            features = {
                "user_id": user_id,
                "total_events": 0,
                "avg_session_duration": 0.0,
                "total_watch_time": 0.0,
                "late_night_ratio": 0.0,
                "topic_diversity": 0.0,
                "repetition_score": 0.0,
                "activity_consistency": 1.0,
                "avg_sentiment": 0.0,
                "processed_at": datetime.utcnow().isoformat()
            }
        else:
            total_time = sum(
                (e.get("duration_seconds") or e.get("browser_event", {}).get("duration_seconds", 0) or 0)
                for e in valid_events
            )
            late_night = 0
            hours = []
            titles = []
            for e in valid_events:
                title = e.get("content_title") or e.get("browser_event", {}).get("content_title") or ""
                if title:
                    titles.append(clean_title(title))
                ts = e.get("timestamp_start") or e.get("browser_event", {}).get("timestamp_start")
                if ts:
                    try:
                        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                        hours.append(dt.hour)
                        if dt.hour >= 22 or dt.hour < 4:
                            late_night += 1
                    except Exception:
                        pass

            ln_ratio = late_night / total_events if total_events > 0 else 0.0
            consistency = 1.0 - (statistics.stdev(hours) / 12.0) if len(hours) > 1 else 1.0
            consistency = max(0.0, min(1.0, consistency))

            meaningful_words = {w for t in titles for w in t.split() if len(w) > 3}
            topic_div = len(meaningful_words) / (total_events + 1)

            unique_titles = set(titles)
            repetitive = (sum(1 for t, c in {t: titles.count(t) for t in unique_titles}.items() if c > 1) / len(unique_titles)) if unique_titles else 0.0

            sent_scores = [get_sentiment_score(t) for t in titles] if titles else [0.0]
            avg_sent = sum(sent_scores) / len(sent_scores) if sent_scores else 0.0

            features = {
                "user_id": user_id,
                "total_events": total_events,
                "avg_session_duration": total_time / total_events if total_events > 0 else 0.0,
                "total_watch_time": total_time,
                "late_night_ratio": ln_ratio,
                "topic_diversity": topic_div,
                "repetition_score": repetitive,
                "activity_consistency": consistency,
                "avg_sentiment": avg_sent,
                "processed_at": datetime.utcnow().isoformat()
            }

        if db is not None:
            try:
                await db.user_features.update_one({"user_id": user_id}, {"$set": features}, upsert=True)
            except Exception as db_err:
                logger.error(f"Error updating user_features in db: {db_err}")

        logger.info(f"[Feature Engineering API] Completed successfully for user: {user_id}")

        return {
            "status": "success",
            "message": "Feature engineering completed",
            "user_id": user_id,
            "features": features,
            "next_stage": "behavior-model",
            "timestamp": datetime.utcnow().isoformat()
        }
    except Exception as error:
        logger.error(f"[Feature Engineering API] Failed for user: {user_id}. Error: {error}")
        return JSONResponse(status_code=500, content={
            "status": "failed",
            "message": "Feature engineering processing error",
            "error": str(error)
        })

@app.post("/behavior-model")
@app.post("/api/behavior-model")
async def behavior_model(payload: Optional[PipelineStageRequest] = Body(None)):
    user_id = (payload.user_id if payload and payload.user_id else None) or "test_user"
    logger.info(f"[Behavior Model API] Started for user: {user_id}")

    try:
        features = payload.features if payload else None
        if not features and db is not None:
            try:
                features = await db.user_features.find_one({"user_id": user_id})
            except Exception as e:
                logger.error(f"Error fetching features: {e}")

        features = features or {}
        topic_div = features.get("topic_diversity", 0.0)
        consistency = features.get("activity_consistency", 1.0)
        ln_ratio = features.get("late_night_ratio", 0.0)
        total_time = features.get("total_watch_time", 0.0)
        avg_sent = features.get("avg_sentiment", 0.0)

        signals = {
            "curiosity_signal": "High" if topic_div > 0.5 else ("Moderate" if topic_div > 0.2 else "Low"),
            "discipline_signal": "High" if (consistency > 0.7 and ln_ratio < 0.2) else ("Low" if ln_ratio > 0.5 else "Moderate"),
            "engagement_signal": "High" if total_time > 3600 else ("Moderate" if total_time > 1800 else "Low"),
            "emotional_stability_signal": "High" if abs(avg_sent) < 0.5 else "Variable"
        }

        profile = {
            "user_id": user_id,
            "signals": signals,
            "derived_at": datetime.utcnow().isoformat()
        }

        if db is not None:
            try:
                await db.behavior_profiles.update_one({"user_id": user_id}, {"$set": profile}, upsert=True)
            except Exception as e:
                logger.error(f"Error storing behavior profile: {e}")

        logger.info(f"[Behavior Model API] Completed for user: {user_id}")

        return {
            "status": "success",
            "message": "Behavior model processing completed",
            "user_id": user_id,
            "signals": signals,
            "next_stage": "ocean-model",
            "timestamp": datetime.utcnow().isoformat()
        }
    except Exception as error:
        logger.error(f"[Behavior Model API] Error: {error}")
        return JSONResponse(status_code=500, content={
            "status": "failed",
            "message": "Behavior model processing error",
            "error": str(error)
        })

@app.post("/ocean-model")
@app.post("/api/ocean-model")
async def ocean_model(payload: Optional[PipelineStageRequest] = Body(None)):
    user_id = (payload.user_id if payload and payload.user_id else None) or "test_user"
    logger.info(f"[OCEAN Model API] Started for user: {user_id}")

    try:
        features = None
        if db is not None:
            try:
                features = await db.user_features.find_one({"user_id": user_id})
            except Exception as e:
                logger.error(f"Error reading features: {e}")

        features = features or {}
        td = features.get("topic_diversity", 0.3)
        ac = features.get("activity_consistency", 0.7)
        lr = features.get("learning_ratio", 0.4)
        ln = features.get("late_night_ratio", 0.1)

        ocean_scores = {
            "openness": round(min(5.0, max(1.0, 2.5 + td * 3.0)), 2),
            "conscientiousness": round(min(5.0, max(1.0, 2.0 + ac * 2.5 - ln * 1.5)), 2),
            "extraversion": round(min(5.0, max(1.0, 2.8 + lr * 1.5)), 2),
            "agreeableness": round(min(5.0, max(1.0, 3.2 + (1.0 - ln) * 1.0)), 2),
            "neuroticism": round(min(5.0, max(1.0, 1.8 + ln * 2.5)), 2)
        }

        if db is not None:
            try:
                await db.ocean_predictions.update_one(
                    {"user_id": user_id},
                    {"$set": {"user_id": user_id, "scores": ocean_scores, "updated_at": datetime.utcnow().isoformat()}},
                    upsert=True
                )
            except Exception as e:
                logger.error(f"Error saving OCEAN predictions: {e}")

        return {
            "status": "success",
            "message": "OCEAN personality model prediction completed",
            "user_id": user_id,
            "ocean_scores": ocean_scores,
            "next_stage": "generate-explanation",
            "timestamp": datetime.utcnow().isoformat()
        }
    except Exception as error:
        logger.error(f"[OCEAN Model API] Error: {error}")
        return JSONResponse(status_code=500, content={
            "status": "failed",
            "message": "OCEAN model prediction error",
            "error": str(error)
        })

@app.post("/generate-explanation")
@app.post("/api/generate-explanation")
async def generate_explanation(payload: Optional[PipelineStageRequest] = Body(None)):
    user_id = (payload.user_id if payload and payload.user_id else None) or "test_user"
    logger.info(f"[Generate Explanation API] Started for user: {user_id}")

    try:
        explanation = (
            f"Based on behavioral telemetric analysis for user '{user_id}', "
            "browsing session patterns reflect structured curiosity, high topic exploration efficiency, "
            "and consistent learning engagement across monitored platforms."
        )

        return {
            "status": "success",
            "message": "Personality explanation generated",
            "user_id": user_id,
            "explanation": explanation,
            "timestamp": datetime.utcnow().isoformat()
        }
    except Exception as error:
        logger.error(f"[Generate Explanation API] Error: {error}")
        return JSONResponse(status_code=500, content={
            "status": "failed",
            "message": "Explanation generation error",
            "error": str(error)
        })