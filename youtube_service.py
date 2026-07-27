import os
import re
import httpx
from datetime import datetime
from typing import Optional

def extract_video_id(url: str) -> Optional[str]:
    if not url:
        return None
    
    # Common regex pattern for different YouTube URL styles
    patterns = [
        r"(?:v=|\/v\/|embed\/|shorts\/|youtu\.be\/|\/embed\/|\/v=|^v=)([^#\&\?]{11})"
    ]
    for pattern in patterns:
        match = re.search(pattern, str(url))
        if match:
            return match.group(1)
            
    # Fallback to parsing query parameters
    try:
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(url)
        q = parse_qs(parsed.query)
        if 'v' in q and q['v'] and len(q['v'][0]) == 11:
            return q['v'][0]
    except Exception:
        pass
        
    return None

async def fetch_youtube_metadata(video_id: str, content_title: str) -> dict:
    api_key = os.getenv("YOUTUBE_API_KEY")
    if not api_key:
        print("YOUTUBE_API_KEY is not defined. Using fallback metadata.")
        return create_fallback_metadata(video_id, content_title)

    url = f"https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id={video_id}&key={api_key}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(url)
            if response.status_code == 200:
                data = response.json()
                items = data.get("items", [])
                if items:
                    item = items[0]
                    snippet = item.get("snippet", {})
                    content_details = item.get("contentDetails", {})
                    statistics = item.get("statistics", {})
                    thumbnails = snippet.get("thumbnails", {})
                    thumbnail_url = (
                        thumbnails.get("high", {}).get("url") or 
                        thumbnails.get("medium", {}).get("url") or 
                        thumbnails.get("default", {}).get("url") or 
                        f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
                    )

                    return {
                        "video_id": video_id,
                        "official_title": snippet.get("title", content_title),
                        "description": snippet.get("description", ""),
                        "channel_name": snippet.get("channelTitle", "Unknown Channel"),
                        "published_at": snippet.get("publishedAt", datetime.utcnow().isoformat() + "Z"),
                        "tags": snippet.get("tags", []),
                        "category_id": snippet.get("categoryId", "24"),
                        "default_language": snippet.get("defaultLanguage") or snippet.get("defaultAudioLanguage") or "en",
                        "duration": content_details.get("duration", "PT0S"),
                        "thumbnail_url": thumbnail_url,
                        "statistics": {
                            "view_count": int(statistics.get("viewCount", 0)),
                            "like_count": int(statistics.get("likeCount", 0)),
                            "comment_count": int(statistics.get("commentCount", 0))
                        }
                    }
                else:
                    print(f"Video {video_id} not found or is private. Using fallback metadata.")
            else:
                print(f"YouTube Data API error: Status code {response.status_code}. Using fallback metadata.")
    except Exception as e:
        print(f"Error fetching YouTube metadata: {e}. Using fallback metadata.")
        
    return create_fallback_metadata(video_id, content_title)

def create_fallback_metadata(video_id: str, content_title: str) -> dict:
    cleaned_title = str(content_title).replace(" - YouTube", "").strip()
    return {
        "video_id": video_id,
        "official_title": cleaned_title or "Unknown YouTube Video",
        "description": "No description available (fallback metadata generated).",
        "channel_name": "Unknown Channel",
        "published_at": datetime.utcnow().isoformat() + "Z",
        "tags": [],
        "category_id": "24",
        "default_language": "en",
        "duration": "PT0S",
        "thumbnail_url": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
        "statistics": {
            "view_count": 0,
            "like_count": 0,
            "comment_count": 0
        }
    }
