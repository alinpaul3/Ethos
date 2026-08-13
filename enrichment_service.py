import os
import hashlib
from datetime import datetime
from youtube_service import extract_video_id, fetch_youtube_metadata
from gemini_service import analyze_video_metadata, GeminiQuotaExhaustedError

CURRENT_ENRICHMENT_VERSION = 1

def generate_event_id(event_data: dict) -> str:
    """
    Generates a deterministic unique identifier for a specific watch event session.
    Format: SHA256(user_id_url_timestamp_start)
    """
    if event_data.get("event_id"):
        return event_data["event_id"]
    
    user_id = event_data.get("user_id", "unknown_user")
    url = event_data.get("url", "")
    ts_start = event_data.get("timestamp_start", "")
    
    raw_str = f"{user_id}_{url}_{ts_start}"
    return hashlib.sha256(raw_str.encode("utf-8")).hexdigest()[:24]

async def enrich_event_pipeline(event_data: dict, db=None) -> dict:
    url = event_data.get("url", "")
    content_title = event_data.get("content_title", "")
    user_id = event_data.get("user_id", "")
    ts_start = event_data.get("timestamp_start", "")
    ts_end = event_data.get("timestamp_end", "")
    duration = event_data.get("duration_seconds", 0)
    
    event_id = generate_event_id(event_data)
    video_id = extract_video_id(url)
    
    if not video_id:
        print(f"[ENRICHMENT] No YouTube video ID could be extracted from: {url}")
        return {
            "event_id": event_id,
            "user_id": user_id,
            "platform": event_data.get("platform", "youtube"),
            "enrichment_status": "skipped",
            "enrichment_version": CURRENT_ENRICHMENT_VERSION,
            "browser_event": {
                "content_title": content_title,
                "url": url,
                "timestamp_start": ts_start,
                "timestamp_end": ts_end,
                "duration_seconds": duration,
                "created_at": datetime.utcnow().isoformat() + "Z"
            },
            "processing_status": {
                "youtube_metadata_fetched": False,
                "gemini_processed": False,
                "ready_for_processing": False,
                "processed_at": datetime.utcnow().isoformat() + "Z"
            }
        }
    
    # 2. Check cache in enriched_events
    cached_doc = None
    cached_content_doc = None
    if db is not None:
        try:
            # Check by specific event_id first
            cached_doc = await db.enriched_events.find_one({"event_id": event_id})
            
            # Also check if another watch event for the same video has completed content analysis
            if not cached_doc or cached_doc.get("enrichment_status") != "completed":
                cached_content_doc = await db.enriched_events.find_one({
                    "youtube_metadata.video_id": video_id,
                    "enrichment_status": "completed",
                    "processing_status.gemini_processed": True
                })
        except Exception as e:
            print(f"[ENRICHMENT] Error checking cache in MongoDB: {e}")
            
    youtube_metadata = None
    gemini_analysis = None
    
    # Verify if cached_doc has completed enrichment
    if cached_doc and cached_doc.get("enrichment_status") == "completed" and cached_doc.get("enrichment_version") == CURRENT_ENRICHMENT_VERSION:
        print(f"[ENRICHMENT] Cache hit: event_id={event_id}")
        return cached_doc
    
    if cached_content_doc:
        print(f"[ENRICHMENT] Reusing cached content analysis for video {video_id}: event_id={event_id}")
        youtube_metadata = cached_content_doc.get("youtube_metadata")
        gemini_analysis = cached_content_doc.get("gemini_analysis")
    elif cached_doc:
        youtube_metadata = cached_doc.get("youtube_metadata")
        gemini_analysis = cached_doc.get("gemini_analysis") if cached_doc.get("enrichment_status") == "completed" else None

    # 3. If missing metadata, fetch YouTube metadata
    if not youtube_metadata:
        youtube_metadata = await fetch_youtube_metadata(video_id, content_title)
        
    # 4. If missing valid Gemini analysis, attempt Gemini API with bounded retries
    quota_exhausted = False
    if not gemini_analysis:
        try:
            print(f"[ENRICHMENT] Cache miss: event_id={event_id}, calling Gemini API...")
            gemini_analysis = await analyze_video_metadata(youtube_metadata, raise_on_quota=True)
        except GeminiQuotaExhaustedError as quota_err:
            print(f"[ENRICHMENT] Gemini quota exhausted: event_id={event_id}, preserving raw event for retry. Detail: {quota_err}")
            quota_exhausted = True
            gemini_analysis = None
        except Exception as gen_err:
            print(f"[ENRICHMENT] Gemini processing failed for event_id={event_id}: {gen_err}")
            gemini_analysis = None

    enrichment_status = "completed" if gemini_analysis else ("quota_exhausted" if quota_exhausted else "failed")
    gemini_processed = bool(gemini_analysis is not None)

    # 5. Form final enriched document
    enriched_doc = {
        "event_id": event_id,
        "user_id": user_id,
        "platform": "youtube",
        "enrichment_status": enrichment_status,
        "enrichment_version": CURRENT_ENRICHMENT_VERSION,
        "browser_event": {
            "content_title": content_title,
            "url": url,
            "timestamp_start": ts_start,
            "timestamp_end": ts_end,
            "duration_seconds": duration,
            "created_at": datetime.utcnow().isoformat() + "Z"
        },
        "youtube_metadata": youtube_metadata,
        "gemini_analysis": gemini_analysis,
        "processing_status": {
            "youtube_metadata_fetched": youtube_metadata.get("official_title") != content_title if youtube_metadata else False,
            "gemini_processed": gemini_processed,
            "ready_for_processing": True,
            "processed_at": datetime.utcnow().isoformat() + "Z"
        },
        "updated_at": datetime.utcnow().isoformat() + "Z"
    }
    
    # 6. Store in MongoDB via UPSERT (idempotent write by event_id)
    if db is not None:
        try:
            await db.enriched_events.update_one(
                {"event_id": event_id},
                {"$set": enriched_doc},
                upsert=True
            )
            print(f"[ENRICHMENT] Gemini {'success' if gemini_processed else 'quota exhausted'}: stored event_id={event_id} (status={enrichment_status}) for user {user_id}")
              
            # Update matching raw events with official title
            official_title = youtube_metadata.get("official_title") if youtube_metadata else None
            if official_title and official_title not in ["Unknown YouTube Video", "YouTube Video"]:
                await db.raw_events.update_many(
                    {"user_id": user_id, "url": url},
                    {"$set": {"content_title": official_title}}
                )
        except Exception as e:
            print(f"[ENRICHMENT] Failed to upsert enriched event in MongoDB: {e}")
            
    return enriched_doc
