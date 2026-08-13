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
from fastapi.middleware.cors import CORSMiddleware

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
        "https://ethos-analysis.onrender.com"  # Add your deployed frontend URL here
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

def decode_jwt(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except Exception:
        return None

async def get_current_user(request: Request):
    token = request.cookies.get("auth_token")
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")
    payload = decode_jwt(token)
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
    return {"status": "ok", "db": "connected" if db else "disconnected"}

@app.get("/api/ping")
async def ping():
    return {"status": "alive", "dbConnected": db is not None}

# --- PHASE 1: AUTHENTICATION ---
@app.post("/api/auth/signup")
async def signup(response: Response, payload: SignupRequest):
    if not db:
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
    if not db:
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
    if not db:
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
    if not db:
        raise HTTPException(status_code=503, detail="Database unavailable")
        
    user_id = current_user["user_id"]
    consent = await db.consents.find_one({"user_id": user_id})
    return {"user_id": user_id, "consent_given": consent.get("consent_given", False) if consent else False}

@app.post("/api/withdraw-consent")
async def withdraw_consent(current_user: dict = Depends(get_current_user)):
    if not db:
        raise HTTPException(status_code=503, detail="Database unavailable")
        
    user_id = current_user["user_id"]
    await db.consents.update_one(
        {"user_id": user_id},
        {"$set": {"consent_given": False, "updated_at": datetime.utcnow().isoformat()}}
    )
    return {"success": True, "message": "Consent withdrawn"}

@app.delete("/api/delete-data")
async def delete_data(response: Response, current_user: dict = Depends(get_current_user)):
    if not db:
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

def safe_float(val, default=0.0):
    if val is None:
        return default
    try:
        f = float(val)
        if math.isnan(f) or math.isinf(f):
            return default
        return f
    except (ValueError, TypeError):
        return default

def safe_int(val, default=0):
    if val is None:
        return default
    try:
        return int(val)
    except (ValueError, TypeError):
        return default

active_processing_users = set()

def calculate_ocean_scores(features: dict) -> dict:
    td = safe_float(features.get("topic_diversity"), 0.3)
    ac = safe_float(features.get("activity_consistency"), 0.7)
    lr = safe_float(features.get("learning_ratio"), 0.4)
    ln = safe_float(features.get("late_night_ratio"), 0.1)

    return {
        "openness": round(min(5.0, max(1.0, 2.5 + td * 3.0)), 2),
        "conscientiousness": round(min(5.0, max(1.0, 2.0 + ac * 2.5 - ln * 1.5)), 2),
        "extraversion": round(min(5.0, max(1.0, 2.8 + lr * 1.5)), 2),
        "agreeableness": round(min(5.0, max(1.0, 3.2 + (1.0 - ln) * 1.0)), 2),
        "neuroticism": round(min(5.0, max(1.0, 1.8 + ln * 2.5)), 2)
    }

# --- PHASE 3: EVENT STORAGE ---
@app.post("/events")
async def store_event(event: EventPayload, background_tasks: BackgroundTasks):
    if not db:
        raise HTTPException(status_code=503, detail="Database unavailable")
    
    if event.duration_seconds < 5:
        raise HTTPException(status_code=400, detail="Duration must be at least 5 seconds")
    
    if not event.content_title.strip():
        raise HTTPException(status_code=400, detail="Content title is required")

    event_dict = event.dict()
    event_dict["url"] = str(event_dict["url"])
    event_dict["created_at"] = datetime.utcnow().isoformat()
    
    event_identity = {
        "user_id": event.user_id,
        "platform": event.platform,
        "url": event_dict["url"],
        "timestamp_start": event.timestamp_start,
        "timestamp_end": event.timestamp_end,
        "duration_seconds": event.duration_seconds,
    }
    duplicate_event = await db.raw_events.find_one(event_identity)

    if duplicate_event:
        logger.info(f"Ignored retry of existing watch event for user {event.user_id}")
    else:
        event_dict["updated_at"] = datetime.utcnow().isoformat()
        await db.raw_events.insert_one(event_dict)
        logger.info(f"Event stored for user {event.user_id}")

    background_tasks.add_task(enrich_event_pipeline, event_dict, db)
    background_tasks.add_task(run_pipeline_for_user, event.user_id)

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

def calculate_learning_ratio(valid_events: list) -> float:
    if not valid_events:
        return 0.0
    edu_keywords = {"tutorial", "course", "lecture", "how to", "python", "coding", "math", "science", "documentary", "history", "lesson", "guide", "tech", "physics", "chemistry", "biology", "engineering", "education"}
    learning_count = 0
    for e in valid_events:
        title = (e.get("content_title") or e.get("url") or "").lower()
        if any(kw in title for kw in edu_keywords):
            learning_count += 1
    return learning_count / len(valid_events)

def get_ocean_prediction(features: dict) -> dict:
    model_dir = os.path.join(os.getcwd(), "ml")
    scaler_path = os.path.join(model_dir, "scaler.pkl")
    has_model = os.path.exists(scaler_path) and (
        os.path.exists(os.path.join(model_dir, "personality_model.keras")) or
        os.path.exists(os.path.join(model_dir, "personality_model.pkl"))
    )

    if has_model:
        from ml.predict import predict_personality
        return predict_personality(features, model_dir=model_dir)
    else:
        use_fallback = os.getenv("USE_HEURISTIC_FALLBACK", "true").lower() in ("true", "1", "yes")
        if not use_fallback:
            raise FileNotFoundError("ML model files not found and USE_HEURISTIC_FALLBACK is disabled.")
        return calculate_ocean_scores(features)

async def process_data_for_user(user_id: str) -> Optional[dict]:
    if db is None:
        return None
    
    try:
        cursor = db.raw_events.find({"user_id": user_id})
        events = await cursor.to_list(length=None)
        
        if not events:
            return None

        valid_events = [e for e in events if isinstance(e, dict) and (e.get("content_title") or e.get("url"))]
        if not valid_events:
            valid_events = [e for e in events if isinstance(e, dict)]

        if not valid_events:
            return None

        total_events = len(valid_events)
        total_time = sum(safe_float(e.get("duration_seconds")) for e in valid_events)
        
        late_night = 0
        hours = []
        for e in valid_events:
            try:
                time_str = e.get("timestamp_start") or e.get("created_at") or ""
                if isinstance(time_str, datetime):
                    dt = time_str
                elif isinstance(time_str, str) and time_str.strip():
                    dt = datetime.fromisoformat(time_str.replace("Z", "+00:00"))
                else:
                    dt = None
                if dt:
                    hours.append(dt.hour)
                    if dt.hour >= 22 or dt.hour < 4:
                        late_night += 1
            except Exception:
                pass
        
        ln_ratio = late_night / total_events if total_events else 0.0
        try:
            consistency = 1.0 - (statistics.stdev(hours) / 12.0) if len(hours) > 1 else 1.0
        except Exception:
            consistency = 1.0
        consistency = max(0.0, min(1.0, consistency))

        all_titles = [clean_title(e.get("content_title") or e.get("url") or "") for e in valid_events]
        all_titles = [t for t in all_titles if t]

        meaningful_words = {w for t in all_titles for w in t.split() if len(w) > 3}
        topic_div = len(meaningful_words) / (total_events + 1) if total_events else 0.0

        unique_titles = set(all_titles)
        repetitive = (sum(1 for t, c in {t: all_titles.count(t) for t in unique_titles}.items() if c > 1) / len(unique_titles)) if unique_titles else 0.0

        sent_scores = [get_sentiment_score(t) for t in all_titles] if all_titles else [0.0]
        avg_sent = sum(sent_scores) / len(sent_scores) if sent_scores else 0.0
        try:
            sent_var = statistics.variance(sent_scores) if len(sent_scores) > 1 else 0.0
        except Exception:
            sent_var = 0.0

        learning_div = calculate_learning_ratio(valid_events)

        features = {
            "user_id": user_id,
            "total_events": total_events,
            "avg_session_duration": total_time / total_events if total_events else 0.0,
            "total_watch_time": total_time,
            "late_night_ratio": ln_ratio,
            "topic_diversity": topic_div,
            "learning_ratio": learning_div,
            "repetition_score": repetitive,
            "activity_consistency": consistency,
            "avg_sentiment": avg_sent,
            "processed_at": datetime.utcnow().isoformat()
        }

        await db.user_features.update_one({"user_id": user_id}, {"$set": features}, upsert=True)

        profile = {
            "user_id": user_id,
            "signals": {
                "curiosity_signal": "High" if topic_div > 0.5 else ("Moderate" if topic_div > 0.2 else "Low"),
                "discipline_signal": "High" if (consistency > 0.7 and ln_ratio < 0.2) else ("Low" if ln_ratio > 0.5 else "Moderate"),
                "engagement_signal": "High" if total_time > 3600 else ("Moderate" if total_time > 60 else "Low"),
                "emotional_stability_signal": "High" if sent_var < 1.0 else "Variable"
            },
            "derived_at": datetime.utcnow().isoformat()
        }

        await db.behavior_profiles.update_one({"user_id": user_id}, {"$set": profile}, upsert=True)
        return profile
    except Exception as err:
        logger.error(f"[process_data_for_user] Exception for user {user_id}: {err}")
        return None

async def run_pipeline_for_user(user_id: str) -> Optional[dict]:
    if db is None:
        return None

    if user_id in active_processing_users:
        logger.info(f"Processing already active for user {user_id}. Skipping duplicate request.")
        return {"status": "skipped", "reason": "already_processing"}

    active_processing_users.add(user_id)
    try:
        current_event_count = await db.raw_events.count_documents({"user_id": user_id})

        status_doc = await db.processing_status.find_one({"user_id": user_id})
        last_processed_count = 0
        if status_doc and "last_processed_event_count" in status_doc:
            last_processed_count = safe_int(status_doc.get("last_processed_event_count"), 0)
        else:
            profile_doc = await db.behavior_profiles.find_one({"user_id": user_id})
            if profile_doc and "last_processed_event_count" in profile_doc:
                last_processed_count = safe_int(profile_doc.get("last_processed_event_count"), 0)

        delta = current_event_count - last_processed_count
        if delta < PROCESSING_THRESHOLD:
            logger.info(f"Threshold not met for user {user_id}: current={current_event_count}, last_processed={last_processed_count}, delta={delta} < {PROCESSING_THRESHOLD}")
            return {
                "status": "skipped",
                "reason": "threshold_not_met",
                "current_event_count": current_event_count,
                "last_processed_event_count": last_processed_count,
                "delta": delta
            }

        now_iso = datetime.utcnow().isoformat()
        await db.processing_status.update_one(
            {"user_id": user_id},
            {
                "$set": {
                    "user_id": user_id,
                    "processing_status": "processing",
                    "processing_in_progress": True,
                    "started_at": now_iso
                }
            },
            upsert=True
        )

        profile = await process_data_for_user(user_id)
        if not profile:
            raise Exception("process_data_for_user returned None or failed")

        features = await db.user_features.find_one({"user_id": user_id}) or {}
        ocean_scores = get_ocean_prediction(features)

        prediction_doc = {
            "user_id": user_id,
            "scores": ocean_scores,
            "predicted_at": datetime.utcnow().isoformat(),
            "event_count_at_prediction": current_event_count,
            "prediction_version": "v1"
        }
        await db.personality_predictions.update_one(
            {"user_id": user_id},
            {"$set": prediction_doc},
            upsert=True
        )

        await db.ocean_predictions.update_one(
            {"user_id": user_id},
            {
                "$set": {
                    "user_id": user_id,
                    "scores": ocean_scores,
                    "updated_at": datetime.utcnow().isoformat(),
                    "event_count_at_prediction": current_event_count
                }
            },
            upsert=True
        )

        await db.behavior_profiles.update_one(
            {"user_id": user_id},
            {
                "$set": {
                    "last_processed_event_count": current_event_count,
                    "last_processed_at": datetime.utcnow().isoformat(),
                    "pipeline_status": "completed",
                    "pipeline_version": "v1"
                }
            },
            upsert=True
        )

        await db.processing_status.update_one(
            {"user_id": user_id},
            {
                "$set": {
                    "user_id": user_id,
                    "last_processed_event_count": current_event_count,
                    "last_processed_at": datetime.utcnow().isoformat(),
                    "processing_status": "completed",
                    "processing_in_progress": False,
                    "total_events": current_event_count
                }
            },
            upsert=True
        )

        if N8N_WEBHOOK_URL:
            try:
                async with httpx.AsyncClient() as httpx_client:
                    await httpx_client.post(
                        N8N_WEBHOOK_URL,
                        json={
                            "user_id": user_id,
                            "event_count": current_event_count,
                            "last_processed_event_count": current_event_count,
                            "processed": True,
                            "timestamp": datetime.utcnow().isoformat()
                        },
                        timeout=5.0
                    )
            except Exception as n8n_err:
                logger.warning(f"Optional n8n webhook notice failed: {n8n_err}")

        logger.info(f"[run_pipeline_for_user] Success for user {user_id} at {current_event_count} events.")
        return {
            "status": "success",
            "user_id": user_id,
            "processed_event_count": current_event_count,
            "ocean_scores": ocean_scores
        }
    except Exception as pipeline_err:
        logger.error(f"[run_pipeline_for_user] Exception for user {user_id}: {pipeline_err}")
        if db is not None:
            try:
                await db.processing_status.update_one(
                    {"user_id": user_id},
                    {
                        "$set": {
                            "user_id": user_id,
                            "processing_status": "failed",
                            "processing_in_progress": False,
                            "last_error": str(pipeline_err),
                            "failed_at": datetime.utcnow().isoformat()
                        }
                    },
                    upsert=True
                )
            except Exception as status_err:
                logger.error(f"Error recording failure status in db: {status_err}")
        return None
    finally:
        active_processing_users.discard(user_id)

@app.post("/process-data")
async def process_data(req: ProcessRequest):
    if not db:
        raise HTTPException(status_code=503, detail="Database unavailable")
    result = await run_pipeline_for_user(req.user_id)
    if not result:
        profile = await process_data_for_user(req.user_id)
        if not profile:
            raise HTTPException(status_code=404, detail="No events found or failed to process")
        return {"message": "Processing completed (fallback)", "user_id": req.user_id, "summary": profile["signals"]}
    return {"message": "Processing completed", "user_id": req.user_id, "result": result}


