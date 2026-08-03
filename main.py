from fastapi import FastAPI, HTTPException, Body, Request, Response, Depends, Cookie, BackgroundTasks, Query
import asyncio
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse, Response
from pydantic import BaseModel, HttpUrl, EmailStr
from enrichment_service import enrich_event_pipeline
from motor.motor_asyncio import AsyncIOMotorClient
from datetime import datetime, timedelta, date
import os
import httpx
import logging
import statistics
import re
import math
import jwt
import bcrypt
import zipfile
import io
import subprocess
import json
import time
from uuid import uuid4
from typing import List, Optional, Dict, Any

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://ethos-analysis.onrender.com",
        "http://localhost:3000",
        "http://localhost:5173",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:5173",
    ],
    allow_origin_regex=r"https://.*\.onrender\.com|https://.*\.run\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configuration
MONGODB_URI = os.getenv("MONGODB_URI")
if not MONGODB_URI:
    logger.warning("MONGODB_URI not set")

JWT_SECRET = os.getenv("JWT_SECRET", "default_secret_for_dev_only")
PROCESSING_THRESHOLD = 1
N8N_WEBHOOK_URL = os.getenv("N8N_WEBHOOK_URL")

# MongoDB Client
client = AsyncIOMotorClient(MONGODB_URI) if MONGODB_URI else None
db = client.get_database() if client is not None else None

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

def sanitize_doc(doc):
    if doc is None:
        return None
    if isinstance(doc, list):
        return [sanitize_doc(d) for d in doc]
    if isinstance(doc, dict):
        new_doc = {}
        for k, v in doc.items():
            if v is None:
                new_doc[k] = None
            elif k == "_id" or type(v).__name__ in ("ObjectId", "Decimal128"):
                new_doc[k] = str(v)
            elif isinstance(v, (datetime, date)):
                new_doc[k] = v.isoformat()
            elif isinstance(v, float):
                if math.isnan(v) or math.isinf(v):
                    new_doc[k] = 0.0
                else:
                    new_doc[k] = v
            elif isinstance(v, (int, str, bool)):
                new_doc[k] = v
            elif isinstance(v, (dict, list)):
                new_doc[k] = sanitize_doc(v)
            else:
                try:
                    new_doc[k] = str(v)
                except Exception:
                    new_doc[k] = None
        return new_doc
    if type(doc).__name__ in ("ObjectId", "Decimal128"):
        return str(doc)
    if isinstance(doc, (datetime, date)):
        return doc.isoformat()
    return doc

async def get_current_user(request: Request):
    token = request.cookies.get("auth_token")
    auth_header = request.headers.get("authorization") or request.headers.get("Authorization")
    if not token and auth_header and auth_header.startswith("Bearer "):
        token = auth_header.split(" ")[1]

    if not token:
        user_id = request.query_params.get("user_id")
        if user_id:
            return {"user_id": user_id, "email": "user@ethos.io"}
        raise HTTPException(status_code=401, detail="Authentication required")

    payload = decode_jwt(token)
    if not payload:
        user_id = request.query_params.get("user_id")
        if user_id:
            return {"user_id": user_id, "email": "user@ethos.io"}
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

class BfiResponseItem(BaseModel):
    question_id: int
    score: int

class BfiSubmissionRequest(BaseModel):
    user_id: Optional[str] = None
    questionnaire_type: Optional[str] = "BFI-44"
    responses: List[Dict[str, Any]]
    consent_version: Optional[str] = "v1.0"

class ExtensionRegisterRequest(BaseModel):
    pairing_token: str

class MlPredictRequest(BaseModel):
    user_id: Optional[str] = None
    features: Optional[Dict[str, Any]] = None

pairing_tokens: Dict[str, Dict[str, Any]] = {}

def validate_bfi44_responses(responses: Any) -> Dict[str, Any]:
    if not isinstance(responses, list):
        return {"is_valid": False, "error": "responses field must be an array"}
    if len(responses) != 44:
        return {"is_valid": False, "error": f"responses array must contain exactly 44 items (received {len(responses)})"}
    seen_ids = set()
    for i, item in enumerate(responses):
        if not isinstance(item, dict):
            return {"is_valid": False, "error": f"Invalid response format at index {i}"}
        try:
            q_id = int(item.get("question_id"))
            score = int(item.get("score"))
        except (TypeError, ValueError):
            return {"is_valid": False, "error": f"Invalid question_id or score at index {i}"}

        if q_id < 1 or q_id > 44:
            return {"is_valid": False, "error": f"Invalid question_id '{q_id}' at index {i}. Must be 1..44."}
        if q_id in seen_ids:
            return {"is_valid": False, "error": f"Duplicate question_id {q_id} found in responses."}
        seen_ids.add(q_id)

        if score < 1 or score > 5:
            return {"is_valid": False, "error": f"Invalid score '{score}' for question_id {q_id}. Must be 1..5."}

    if len(seen_ids) != 44:
        return {"is_valid": False, "error": "All 44 question_ids (1 to 44) must be present in the responses."}

    return {"is_valid": True}

def calculate_bfi44_scores(responses: List[dict]) -> dict:
    score_map = {}
    for r in responses:
        score_map[int(r["question_id"])] = int(r["score"])

    def get_score(q_id: int, is_reverse: bool) -> int:
        raw = score_map.get(q_id, 3)
        return (6 - raw) if is_reverse else raw

    extraversion_items = [
        get_score(1, False), get_score(6, True), get_score(11, False), get_score(16, False),
        get_score(21, True), get_score(26, False), get_score(31, True), get_score(36, False)
    ]
    agreeableness_items = [
        get_score(2, True), get_score(7, False), get_score(12, True), get_score(17, False),
        get_score(22, False), get_score(27, True), get_score(32, False), get_score(37, True)
    ]
    conscientiousness_items = [
        get_score(3, False), get_score(8, True), get_score(13, False), get_score(18, True),
        get_score(23, True), get_score(28, False), get_score(33, False), get_score(38, False), get_score(43, True)
    ]
    neuroticism_items = [
        get_score(4, False), get_score(9, True), get_score(14, False), get_score(19, False),
        get_score(24, True), get_score(29, False), get_score(34, True), get_score(39, False)
    ]
    openness_items = [
        get_score(5, False), get_score(10, False), get_score(15, False), get_score(20, False),
        get_score(25, False), get_score(30, False), get_score(35, True), get_score(40, False),
        get_score(41, True), get_score(44, False)
    ]

    avg = lambda arr: round(sum(arr) / len(arr), 2)

    ext = avg(extraversion_items)
    agr = avg(agreeableness_items)
    con = avg(conscientiousness_items)
    neu = avg(neuroticism_items)
    ope = avg(openness_items)

    return {
        "extraversion": ext,
        "agreeableness": agr,
        "conscientiousness": con,
        "neuroticism": neu,
        "openness": ope,
        "normalized": {
            "extraversion": round((ext - 1) / 4, 2),
            "agreeableness": round((agr - 1) / 4, 2),
            "conscientiousness": round((con - 1) / 4, 2),
            "neuroticism": round((neu - 1) / 4, 2),
            "openness": round((ope - 1) / 4, 2)
        }
    }

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
    return {"status": "ok", "db": "connected" if db is not None else "disconnected"}

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
        secure=False,
        path="/"
    )
    
    return {"user_id": user_id, "email": payload.email, "token": token, "consent_given": False, "message": "User created successfully"}

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
        secure=False,
        path="/"
    )
    
    consent_doc = await db.consents.find_one({"user_id": user["user_id"]})
    consent_given = consent_doc.get("consent_given", False) if consent_doc else False

    return {"user_id": user["user_id"], "email": user["email"], "token": token, "consent_given": consent_given}

@app.get("/api/auth/me")
async def me(current_user: dict = Depends(get_current_user)):
    consent_given = False
    if db is not None:
        consent_doc = await db.consents.find_one({"user_id": current_user["user_id"]})
        consent_given = consent_doc.get("consent_given", False) if consent_doc else False
    return {"user_id": current_user["user_id"], "email": current_user.get("email", ""), "consent_given": consent_given}

@app.post("/api/auth/logout")
async def logout(response: Response):
    response.delete_cookie(
        key="auth_token",
        path="/",
        samesite="lax",
        httponly=True
    )
    response.set_cookie(
        key="auth_token",
        value="",
        max_age=0,
        expires=0,
        path="/",
        httponly=True,
        samesite="lax"
    )
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
@app.post("/api/events")
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
    
    # Enhanced deduplication for pause/play events & same video/title session (within 30 mins)
    def extract_vid(u):
        if not u:
            return None
        if "v=" in u:
            return u.split("v=")[1].split("&")[0]
        if "youtu.be/" in u:
            return u.split("youtu.be/")[1].split("?")[0].split("&")[0]
        if "youtube.com/shorts/" in u:
            return u.split("youtube.com/shorts/")[1].split("?")[0].split("&")[0]
        if "youtube.com/embed/" in u:
            return u.split("youtube.com/embed/")[1].split("?")[0].split("&")[0]
        return None

    incoming_vid = extract_vid(event_dict.get("url", ""))
    incoming_title = clean_title(event_dict.get("content_title", ""))

    recent_dup = None
    existing_user_events = await db.raw_events.find({"user_id": event.user_id}).to_list(200)

    def parse_event_time(e):
        ts = e.get("updated_at") or e.get("timestamp_end") or e.get("created_at") or e.get("timestamp_start")
        if not ts:
            return 0.0
        try:
            if isinstance(ts, (datetime, date)):
                return ts.timestamp()
            dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
            return dt.timestamp()
        except Exception:
            return 0.0

    sorted_existing = sorted(existing_user_events, key=parse_event_time, reverse=True)
    now_ts = datetime.utcnow().timestamp()

    for e in sorted_existing:
        e_vid = extract_vid(e.get("url", ""))
        e_title = clean_title(e.get("content_title", ""))

        is_match = False
        if incoming_vid and e_vid and incoming_vid == e_vid:
            is_match = True
        elif incoming_title and e_title and incoming_title == e_title:
            is_match = True
        elif event_dict.get("url") and e.get("url") and event_dict["url"].split("?")[0] == e["url"].split("?")[0]:
            is_match = True

        if is_match:
            last_activity = parse_event_time(e)
            # Match if last activity on this video session was within 30 minutes (1800s)
            if (now_ts - last_activity < 1800) or last_activity == 0.0:
                recent_dup = e
                break

    if recent_dup:
        new_dur = max(safe_float(recent_dup.get("duration_seconds")), safe_float(event_dict.get("duration_seconds")))
        update_fields = {
            "duration_seconds": new_dur,
            "timestamp_end": event_dict.get("timestamp_end") or datetime.utcnow().isoformat(),
            "updated_at": datetime.utcnow().isoformat()
        }
        if event_dict.get("content_title"):
            update_fields["content_title"] = event_dict["content_title"]

        await db.raw_events.update_one(
            {"_id": recent_dup["_id"]},
            {"$set": update_fields}
        )
        logger.info(f"Merged duplicate/pause watch event for user {event.user_id}, video/title '{incoming_title or incoming_vid}'. New duration: {new_dur}s")
    else:
        event_dict["updated_at"] = datetime.utcnow().isoformat()
        await db.raw_events.insert_one(event_dict)
        logger.info(f"Event stored for user {event.user_id}")

    # Enqueue enrichment pipeline & behavior profile generation in background
    background_tasks.add_task(enrich_event_pipeline, event_dict, db)
    background_tasks.add_task(process_data_for_user, event.user_id)

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
def clean_title(title: Any) -> str:
    if not title or not isinstance(title, str):
        return ""
    title = title.lower().replace(" - youtube", "")
    title = re.sub(r'[^\w\s]', '', title)
    return re.sub(r'\s+', ' ', title).strip()

def get_sentiment_score(title: Any) -> float:
    if not title or not isinstance(title, str):
        return 0.0
    pos = {"happy", "good", "great", "awesome", "amazing", "love", "best", "funny", "laugh", "joy"}
    neg = {"sad", "bad", "worst", "hate", "terrible", "awful", "scary", "death", "angry", "pain"}
    words = title.lower().split()
    score = 0.0
    for w in words:
        if w in pos: score += 1.0
        if w in neg: score -= 1.0
    return score

async def process_data_for_user(user_id: str) -> Optional[dict]:
    if db is None:
        return None
    
    try:
        cursor = db.raw_events.find({"user_id": user_id})
        events = await cursor.to_list(length=1000)
        
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
                if isinstance(time_str, (datetime, date)):
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

        features = {
            "user_id": user_id,
            "total_events": total_events,
            "avg_session_duration": total_time / total_events if total_events else 0.0,
            "total_watch_time": total_time,
            "late_night_ratio": ln_ratio,
            "topic_diversity": topic_div,
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

@app.post("/process-data")
async def process_data(req: ProcessRequest):
    if db is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    profile = await process_data_for_user(req.user_id)
    if not profile:
        raise HTTPException(status_code=404, detail="No events found or failed to process")
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
            if (isinstance(e, dict) and (e.get("duration_seconds", 0) >= 5 or "content_title" in e or (isinstance(e.get("browser_event"), dict) and e["browser_event"].get("content_title"))))
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
            def get_be(e_dict):
                be_val = e_dict.get("browser_event")
                return be_val if isinstance(be_val, dict) else {}

            total_time = sum(
                float(e.get("duration_seconds") or get_be(e).get("duration_seconds", 0) or 0)
                for e in valid_events
            )
            late_night = 0
            hours = []
            titles = []
            for e in valid_events:
                be = get_be(e)
                title = e.get("content_title") or be.get("content_title") or ""
                if title:
                    titles.append(clean_title(title))
                ts = e.get("timestamp_start") or be.get("timestamp_start")
                if ts:
                    try:
                        if isinstance(ts, (datetime, date)):
                            dt = ts
                        elif isinstance(ts, str) and ts.strip():
                            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                        else:
                            dt = None
                        if dt:
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

@app.get("/api/dashboard-data")
@app.get("/api/dashboard")
async def get_dashboard(request: Request, user_id: Optional[str] = None):
    current_user_id = None
    token = request.cookies.get("auth_token")
    if token:
        payload = decode_jwt(token)
        if payload and "user_id" in payload:
            current_user_id = payload["user_id"]
    
    target_user_id = user_id or current_user_id
    if not target_user_id:
        # Fallback to test_user or first user if available
        target_user_id = "test_user"

    if db is None:
        return {
            "user_id": target_user_id,
            "features": None,
            "profile": None,
            "questionnaire_response": None,
            "recent_events": [],
            "recent_enriched_events": [],
            "total_captured_events": 0
        }

    try:
        raw_events = await db.raw_events.find({"user_id": target_user_id}).to_list(1000)
        enriched_events = await db.enriched_events.find({"user_id": target_user_id}).to_list(1000)

        # Auto-compute profile in background if missing or signals contain 'CALCULATING' while raw_events exist
        profile = await db.behavior_profiles.find_one({"user_id": target_user_id})
        signals_in_db = (profile.get("signals") or {}) if profile else {}
        is_calc = not signals_in_db or any(str(v).upper() == "CALCULATING" for v in signals_in_db.values())
        if (not profile or is_calc) and raw_events:
            asyncio.create_task(process_data_for_user(target_user_id))

        features = await db.user_features.find_one({"user_id": target_user_id})
        questionnaire = await db.questionnaire_responses.find_one({
            "user_id": target_user_id,
            "questionnaire_type": "BFI-44"
        })
        if not questionnaire:
            questionnaire = await db.questionnaire_responses.find_one({"user_id": target_user_id})

        # Build map of url / video_id -> official_title from enriched_events
        official_title_map = {}
        for ee in enriched_events:
            if not isinstance(ee, dict):
                continue
            be = ee.get("browser_event")
            be_dict = be if isinstance(be, dict) else {}
            ym = ee.get("youtube_metadata")
            ym_dict = ym if isinstance(ym, dict) else {}
            e_url = be_dict.get("url") or ""
            e_title = ym_dict.get("official_title")
            if e_url and e_title and e_title not in ["Unknown YouTube Video", "YouTube Video"]:
                official_title_map[e_url] = e_title
                if "v=" in e_url:
                    vid = e_url.split("v=")[1].split("&")[0]
                    if vid:
                        official_title_map[vid] = e_title

        for re in raw_events:
            if not isinstance(re, dict):
                continue
            r_url = re.get("url") or ""
            if r_url in official_title_map:
                re["content_title"] = official_title_map[r_url]
            elif "v=" in r_url:
                vid = r_url.split("v=")[1].split("&")[0]
                if vid in official_title_map:
                    re["content_title"] = official_title_map[vid]

        if raw_events:
            valid_raw = [e for e in raw_events if isinstance(e, dict)]
            total_time = sum(safe_float(e.get("duration_seconds")) for e in valid_raw)
            avg_dur = total_time / len(valid_raw) if valid_raw else 0.0
            sent_scores = [get_sentiment_score(e.get("content_title") or "") for e in valid_raw]
            avg_sent = (sum(sent_scores) / len(valid_raw)) if valid_raw else 0.0
            if not features:
                features = {
                    "user_id": target_user_id,
                    "total_events": len(valid_raw),
                    "avg_session_duration": avg_dur,
                    "total_watch_time": total_time,
                    "late_night_ratio": 0.0,
                    "topic_diversity": 0.5,
                    "learning_ratio": 0.5,
                    "repetition_score": 0.0,
                    "activity_consistency": 1.0,
                    "avg_sentiment": avg_sent,
                    "processed_at": datetime.utcnow().isoformat()
                }
            else:
                features["total_watch_time"] = max(safe_float(features.get("total_watch_time")), total_time)
                features["total_events"] = max(safe_int(features.get("total_events")), len(valid_raw))
                features["avg_session_duration"] = avg_dur

        def parse_time_str(val):
            if not val:
                return ""
            if isinstance(val, (datetime, date)):
                return val.isoformat()
            return str(val)

        def event_time(e):
            if not isinstance(e, dict):
                return ""
            return parse_time_str(e.get("created_at") or e.get("timestamp_start"))

        def enriched_time(e):
            if not isinstance(e, dict):
                return ""
            be = e.get("browser_event")
            be_dict = be if isinstance(be, dict) else {}
            return parse_time_str(be_dict.get("created_at") or be_dict.get("timestamp_start"))

        sorted_events = sorted(raw_events, key=event_time, reverse=True)
        sorted_enriched = sorted(enriched_events, key=enriched_time, reverse=True)

        return {
            "user_id": target_user_id,
            "features": sanitize_doc(features),
            "profile": sanitize_doc(profile),
            "questionnaire_response": sanitize_doc(questionnaire),
            "recent_events": sanitize_doc(sorted_events[:50]),
            "recent_enriched_events": sanitize_doc(sorted_enriched[:50]),
            "total_captured_events": len(raw_events)
        }
    except Exception as err:
        logger.error(f"[Dashboard API] Error fetching dashboard data: {err}")
        return JSONResponse(status_code=500, content={
            "status": "failed",
            "message": "Error fetching dashboard data",
            "error": str(err)
        })

# --- QUESTIONNAIRE ENDPOINTS ---
@app.post("/questionnaire/submit")
@app.post("/api/questionnaire/submit")
async def questionnaire_submit(payload: BfiSubmissionRequest, request: Request):
    try:
        user_id = payload.user_id
        if not user_id:
            token = request.cookies.get("auth_token")
            if token:
                auth_data = decode_jwt(token)
                if auth_data and "user_id" in auth_data:
                    user_id = auth_data["user_id"]

        if not user_id or not user_id.strip():
            return JSONResponse(status_code=400, content={
                "status": "failed",
                "error": "Missing or invalid user_id in request body."
            })

        if payload.questionnaire_type != "BFI-44":
            return JSONResponse(status_code=400, content={
                "status": "failed",
                "error": f"Invalid questionnaire_type '{payload.questionnaire_type}'. Expected 'BFI-44'."
            })

        validation = validate_bfi44_responses(payload.responses)
        if not validation["is_valid"]:
            return JSONResponse(status_code=400, content={
                "status": "failed",
                "error": validation["error"]
            })

        formatted_responses = sorted(
            [{"question_id": int(r["question_id"]), "score": int(r["score"])} for r in payload.responses],
            key=lambda x: x["question_id"]
        )

        scores = calculate_bfi44_scores(formatted_responses)

        questionnaire_doc = {
            "user_id": user_id.strip(),
            "questionnaire_type": "BFI-44",
            "responses": formatted_responses,
            "completed_at": datetime.utcnow().isoformat(),
            "consent_version": payload.consent_version or "v1.0",
            "status": "completed",
            "scores": scores
        }

        if db is not None:
            await db.questionnaire_responses.update_one(
                {"user_id": user_id.strip(), "questionnaire_type": "BFI-44"},
                {"$set": questionnaire_doc},
                upsert=True
            )

        return {
            "status": "success",
            "message": "Questionnaire responses stored successfully",
            "user_id": user_id.strip(),
            "questionnaire_type": "BFI-44",
            "completed_at": questionnaire_doc["completed_at"],
            "consent_version": questionnaire_doc["consent_version"],
            "scores": questionnaire_doc["scores"]
        }
    except Exception as error:
        logger.error(f"[BFI-44 Endpoint] Error: {error}")
        return JSONResponse(status_code=500, content={
            "status": "failed",
            "error": "Internal server error storing questionnaire response",
            "details": str(error)
        })

@app.get("/questionnaire/response")
@app.get("/api/questionnaire/response")
async def questionnaire_get(request: Request, user_id: Optional[str] = Query(None)):
    target_user_id = user_id
    if not target_user_id:
        token = request.cookies.get("auth_token")
        if token:
            auth_data = decode_jwt(token)
            if auth_data and "user_id" in auth_data:
                target_user_id = auth_data["user_id"]

    if not target_user_id:
        return JSONResponse(status_code=400, content={"status": "failed", "error": "user_id is required"})

    if db is None:
        return JSONResponse(status_code=500, content={"status": "failed", "error": "Database unavailable"})

    response_doc = await db.questionnaire_responses.find_one({
        "user_id": target_user_id.strip(),
        "questionnaire_type": "BFI-44"
    })

    if not response_doc:
        return JSONResponse(status_code=404, content={
            "status": "not_found",
            "message": "No completed BFI-44 response found for user_id",
            "user_id": target_user_id
        })

    return {
        "status": "success",
        "user_id": target_user_id,
        "data": sanitize_doc(response_doc)
    }

# --- EXPORT TRAINING DATASET ---
@app.get("/export-training-dataset")
@app.get("/api/export-training-dataset")
async def export_training_dataset(format: Optional[str] = Query(None)):
    if db is None:
        return JSONResponse(status_code=500, content={"status": "failed", "error": "Database unavailable"})

    try:
        all_user_features = await db.user_features.find({}).to_list(1000)
        all_questionnaires = await db.questionnaire_responses.find({"questionnaire_type": "BFI-44"}).to_list(1000)
        all_users = await db.users.find({}).to_list(1000)

        user_ids = set()
        features_map = {}
        for uf in all_user_features:
            if uf.get("user_id"):
                user_ids.add(uf["user_id"])
                features_map[uf["user_id"]] = uf

        questionnaires_map = {}
        for q in all_questionnaires:
            if q.get("user_id"):
                user_ids.add(q["user_id"])
                questionnaires_map[q["user_id"]] = q

        for u in all_users:
            if u.get("user_id"):
                user_ids.add(u["user_id"])

        dataset_rows = []
        for uid in user_ids:
            feat = features_map.get(uid)
            quest = questionnaires_map.get(uid)

            ocean_scores = quest.get("scores") if quest else None
            if not ocean_scores and quest and quest.get("responses"):
                ocean_scores = calculate_bfi44_scores(quest["responses"])

            row = {
                "user_id": uid,
                "avg_session_duration": round(feat.get("avg_session_duration", 0), 2) if feat else 0,
                "late_night_ratio": round(feat.get("late_night_ratio", 0), 3) if feat else 0,
                "topic_diversity": round(feat.get("topic_diversity", 0), 3) if feat else 0,
                "learning_ratio": round(feat.get("learning_ratio", 0), 3) if feat else 0,
                "activity_consistency": round(feat.get("activity_consistency", 0), 3) if feat else 0,
                "openness": ocean_scores.get("openness", "") if ocean_scores else "",
                "conscientiousness": ocean_scores.get("conscientiousness", "") if ocean_scores else "",
                "extraversion": ocean_scores.get("extraversion", "") if ocean_scores else "",
                "agreeableness": ocean_scores.get("agreeableness", "") if ocean_scores else "",
                "neuroticism": ocean_scores.get("neuroticism", "") if ocean_scores else ""
            }
            dataset_rows.append(row)

        csv_headers = [
            "user_id", "avg_session_duration", "late_night_ratio", "topic_diversity",
            "learning_ratio", "activity_consistency", "openness", "conscientiousness",
            "extraversion", "agreeableness", "neuroticism"
        ]

        csv_lines = [",".join(csv_headers)]
        for r in dataset_rows:
            csv_lines.append(",".join(str(r.get(h, "")) for h in csv_headers))

        csv_content = "\n".join(csv_lines) + "\n"

        csv_file_path = os.path.join(os.getcwd(), "training_dataset.csv")
        with open(csv_file_path, "w", encoding="utf-8") as f:
            f.write(csv_content)

        if format == "json":
            return {
                "status": "success",
                "count": len(dataset_rows),
                "file_path": "training_dataset.csv",
                "data": dataset_rows
            }

        return Response(
            content=csv_content,
            media_type="text/csv",
            headers={"Content-Disposition": 'attachment; filename="training_dataset.csv"'}
        )
    except Exception as error:
        logger.error(f"[Export Dataset] Error: {error}")
        return JSONResponse(status_code=500, content={
            "status": "failed",
            "error": "Internal server error exporting dataset",
            "details": str(error)
        })

# --- DOWNLOAD EXTENSION & PAIRING ---
@app.get("/download-extension")
@app.get("/api/download-extension")
async def download_extension():
    extension_dir = os.path.join(os.getcwd(), "extension")
    if not os.path.exists(extension_dir):
        return JSONResponse(status_code=404, content={"status": "failed", "error": "Extension package directory not found"})

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(extension_dir):
            for file in files:
                abs_file = os.path.join(root, file)
                rel_file = os.path.relpath(abs_file, extension_dir)
                zf.write(abs_file, rel_file)

    buffer.seek(0)
    return Response(
        content=buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="ethos-chrome-extension.zip"'}
    )

@app.get("/api/auth/extension-token")
async def get_extension_token(request: Request, user_id: Optional[str] = Query(None)):
    target_user_id = user_id
    auth_header = request.headers.get("authorization")
    if auth_header and auth_header.startswith("Bearer "):
        token = auth_header.split(" ")[1]
        try:
            decoded = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
            target_user_id = decoded.get("user_id", target_user_id)
        except Exception:
            pass

    if not target_user_id:
        return JSONResponse(status_code=401, content={"status": "failed", "error": "Authentication required"})

    pairing_token = "pt_" + uuid4().hex
    pairing_tokens[pairing_token] = {
        "user_id": target_user_id,
        "expires_at": time.time() + 300
    }

    return {
        "status": "success",
        "pairing_token": pairing_token,
        "expires_in": 300,
        "user_id": target_user_id
    }

@app.post("/api/extension/register")
async def register_extension(payload: ExtensionRegisterRequest):
    token = payload.pairing_token
    if not token or token not in pairing_tokens:
        return JSONResponse(status_code=400, content={"status": "failed", "error": "Invalid or expired pairing token"})

    data = pairing_tokens[token]
    if time.time() > data["expires_at"]:
        del pairing_tokens[token]
        return JSONResponse(status_code=400, content={"status": "failed", "error": "Pairing token expired"})

    target_user_id = data["user_id"]
    del pairing_tokens[token]

    ext_token = jwt.encode(
        {"user_id": target_user_id, "scope": "telemetry_ingest", "exp": datetime.utcnow() + timedelta(days=365)},
        JWT_SECRET,
        algorithm="HS256"
    )

    return {
        "status": "success",
        "message": "Extension auto-linked successfully",
        "user_id": target_user_id,
        "extension_auth_token": ext_token
    }

# --- ML PIPELINE ENDPOINTS ---
@app.post("/api/ml/train")
@app.get("/api/ml/train")
async def train_ml_model():
    ml_script = os.path.join(os.getcwd(), "ml", "train_personality_model.py")
    cmd = f"python3 {ml_script} /ml training_dataset.csv"
    logger.info(f"[ML Pipeline] Executing: {cmd}")

    try:
        proc = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if proc.returncode != 0:
            return JSONResponse(status_code=500, content={
                "status": "failed",
                "error": "ML training execution failed",
                "details": proc.stderr,
                "output": proc.stdout
            })

        history_path = os.path.join(os.getcwd(), "ml", "training_history.json")
        history_data = None
        if os.path.exists(history_path):
            try:
                with open(history_path, "r") as f:
                    history_data = json.load(f)
            except Exception as e:
                logger.warning(f"Could not parse training_history.json: {e}")

        return {
            "status": "success",
            "message": "TensorFlow personality model trained successfully",
            "output": proc.stdout,
            "artifacts": [
                "/ml/personality_model.keras",
                "/ml/scaler.pkl",
                "/ml/training_history.json",
                "/ml/training_loss.png",
                "/ml/training_mae.png"
            ],
            "results": history_data
        }
    except Exception as error:
        return JSONResponse(status_code=500, content={"status": "failed", "error": str(error)})

@app.get("/api/ml/metrics")
async def get_ml_metrics():
    history_path = os.path.join(os.getcwd(), "ml", "training_history.json")
    if not os.path.exists(history_path):
        return JSONResponse(status_code=404, content={"status": "error", "message": "No model training metrics found. Please trigger model training."})
    try:
        with open(history_path, "r") as f:
            history_data = json.load(f)
        return {"status": "success", "data": history_data}
    except Exception as error:
        return JSONResponse(status_code=500, content={"status": "error", "message": str(error)})

@app.post("/api/ml/predict")
async def ml_predict(payload: Optional[MlPredictRequest] = Body(None)):
    user_id = payload.user_id if payload else None
    feature_payload = payload.features if payload else None

    if not feature_payload and user_id and db is not None:
        user_feat = await db.user_features.find_one({"user_id": user_id})
        if user_feat:
            feature_payload = {
                "avg_session_duration": user_feat.get("avg_session_duration", 0),
                "late_night_ratio": user_feat.get("late_night_ratio", 0),
                "topic_diversity": user_feat.get("topic_diversity", 0),
                "learning_ratio": user_feat.get("learning_ratio", 0),
                "activity_consistency": user_feat.get("activity_consistency", 0)
            }

    if not feature_payload:
        return JSONResponse(status_code=400, content={"status": "failed", "error": "Missing feature vector or valid user_id"})

    predict_script = os.path.join(os.getcwd(), "ml", "predict.py")
    json_arg = json.dumps(feature_payload).replace('"', '\\"')

    try:
        proc = subprocess.run(f'python3 {predict_script} "{json_arg}"', shell=True, capture_output=True, text=True)
        if proc.returncode != 0:
            return JSONResponse(status_code=500, content={"status": "failed", "error": proc.stderr or proc.stdout})

        predictions = json.loads(proc.stdout.strip())
        return {
            "status": "success",
            "user_id": user_id,
            "input_features": feature_payload,
            "predictions": predictions
        }
    except Exception as error:
        return JSONResponse(status_code=500, content={"status": "failed", "error": str(error)})

@app.get("/ml/plot/loss")
async def plot_loss():
    plot_path = os.path.join(os.getcwd(), "ml", "training_loss.png")
    if os.path.exists(plot_path):
        return FileResponse(plot_path, media_type="image/png")
    return Response(content="Loss plot not found", status_code=404)

@app.get("/ml/plot/mae")
async def plot_mae():
    plot_path = os.path.join(os.getcwd(), "ml", "training_mae.png")
    if os.path.exists(plot_path):
        return FileResponse(plot_path, media_type="image/png")
    return Response(content="MAE plot not found", status_code=404)



