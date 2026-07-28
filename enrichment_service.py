import os
from datetime import datetime
from youtube_service import extract_video_id, fetch_youtube_metadata
from gemini_service import analyze_video_metadata

async def enrich_event_pipeline(event_data: dict, db=None) -> dict:
    url = event_data.get("url", "")
    content_title = event_data.get("content_title", "")
    user_id = event_data.get("user_id", "")
    
    # 1. Extract Video ID
    video_id = extract_video_id(url)
    if not video_id:
        print(f"No YouTube video ID could be extracted from: {url}")
        # Not a watch event or non-parseable URL, return base event without enrichment fields
        return {
            "user_id": user_id,
            "platform": event_data.get("platform", "youtube"),
            "browser_event": {
                "content_title": content_title,
                "url": url,
                "timestamp_start": event_data.get("timestamp_start", ""),
                "timestamp_end": event_data.get("timestamp_end", ""),
                "duration_seconds": event_data.get("duration_seconds", 0),
                "created_at": datetime.utcnow().isoformat() + "Z"
            },
            "processing_status": {
                "youtube_metadata_fetched": False,
                "gemini_processed": False,
                "ready_for_processing": False,
                "processed_at": datetime.utcnow().isoformat() + "Z"
            }
        }
    
    # 2. Check for cached enriched document in MongoDB
    cached_doc = None
    if db is not None:
        try:
            # Check the 'enriched_events' collection for existing video_id
            cached_doc = await db.enriched_events.find_one({"youtube_metadata.video_id": video_id})
            if cached_doc:
                print(f"Found cached enrichment for video {video_id}! Reusing YouTube metadata and Gemini analysis.")
        except Exception as e:
            print(f"Error checking cache in MongoDB: {e}")
            
    youtube_metadata = None
    gemini_analysis = None
    
    if cached_doc:
        youtube_metadata = cached_doc.get("youtube_metadata")
        gemini_analysis = cached_doc.get("gemini_analysis")
        
    # 3. If not cached, fetch metadata and analyze with Gemini
    if not youtube_metadata:
        youtube_metadata = await fetch_youtube_metadata(video_id, content_title)
        
    if not gemini_analysis:
        gemini_analysis = await analyze_video_metadata(youtube_metadata)
        
    # 4. Form final enriched document
    enriched_doc = {
        "user_id": user_id,
        "platform": "youtube",
        "browser_event": {
            "content_title": content_title,
            "url": url,
            "timestamp_start": event_data.get("timestamp_start", ""),
            "timestamp_end": event_data.get("timestamp_end", ""),
            "duration_seconds": event_data.get("duration_seconds", 0),
            "created_at": datetime.utcnow().isoformat() + "Z"
        },
        "youtube_metadata": youtube_metadata,
        "gemini_analysis": gemini_analysis,
        "processing_status": {
            "youtube_metadata_fetched": youtube_metadata.get("official_title") != content_title or youtube_metadata.get("description") != "No description available (fallback metadata generated).",
            "gemini_processed": gemini_analysis.get("video_summary") != "Analysis unavailable. Fallback generated due to processing limitation.",
            "ready_for_processing": True,
            "processed_at": datetime.utcnow().isoformat() + "Z"
        }
    }
    
    # 5. Store in MongoDB if available
    if db is not None:
        try:
            # Insert the newly enriched document into the 'enriched_events' collection
            await db.enriched_events.insert_one(enriched_doc)
            print(f"Stored final enriched event in MongoDB 'enriched_events' collection for user {user_id}")
              
            # Update matching raw events with official title
            official_title = youtube_metadata.get("official_title") if youtube_metadata else None
            if official_title and official_title not in ["Unknown YouTube Video", "YouTube Video"]:
                await db.raw_events.update_many(
                    {"user_id": user_id, "url": url},
                    {"$set": {"content_title": official_title}}
                )
        except Exception as e:
            print(f"Failed to store enriched event in MongoDB: {e}")
            
    return enriched_doc
