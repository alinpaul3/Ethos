import os
import json
import asyncio
from google import genai
from google.genai import types

def get_gemini_client():
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("GEMINI_API_KEY is not defined. Using fallback analysis.")
        return None
    try:
        # User-Agent config is set via Client
        return genai.Client(api_key=api_key, http_options={"headers": {"User-Agent": "aistudio-build"}})
    except Exception as e:
        print(f"Failed to initialize Gemini Client: {e}")
        return None

async def analyze_video_metadata(metadata: dict) -> dict:
    client = get_gemini_client()
    if not client:
        return get_fallback_analysis(metadata)

    video_id = metadata.get("video_id", "")
    title = metadata.get("official_title", "")
    desc = metadata.get("description", "")
    if desc:
        desc = desc[:1000]
    channel = metadata.get("channel_name", "")
    cat_id = metadata.get("category_id", "")
    tags = metadata.get("tags", [])

    prompt = f"""
Analyze the following YouTube video metadata and estimate its semantic and behavioral characteristics.

Video ID: {video_id}
Title: {title}
Description: {desc}
Channel Name: {channel}
Category ID: {cat_id}
Tags: {", ".join(tags) if tags else "None"}

You must return a valid, minified JSON object with the following fields and constraints:
1. "video_summary": (string, max 3-sentence summary emphasizing semantic content, educational/entertainment value, or cognitive state/intent of someone watching)
2. "topic_tags": (list of 3-5 specific semantic topic tags or keywords)
3. "primary_topic": (string, the single most prominent topic of the video)
4. "content_category": (string, must be exactly one of: Educational, Entertainment, News/Documentary, Tech/Gaming, Self-Improvement/Lifestyle, Music/Art, Other)
5. "knowledge_domain": (string, broad academic or professional domain, e.g. Computer Science, Philosophy, Pop Culture, Fitness, Finance, etc.)
6. "content_type": (string, must be exactly one of: Long-form, Short-form, Lecture, Review, Gameplay, Music Video, Vlog, Essay, Other)
7. "estimated_user_intent": (string, must be exactly one of: Learning, Entertainment, Information_Seeking, Skill_Acquisition, Escapism, Relaxation, Curiosity, Other)
8. "emotion_tone": (string, comma-separated list of 1-3 dominant emotional or mental tones, e.g. Calming, Exciting, Analytical, Humorous, Inspiring, Tense, Academic, Casual, etc.)
9. "confidence_score": (float between 0.0 and 1.0 representing confidence in this classification)

Your response must contain ONLY the valid JSON object. No markdown formatting, no code blocks (do not wrap in ```json), no additional text.
"""
    # Valid candidate models in order of preference according to AI Studio guidelines
    candidate_models = ['gemini-3.6-flash', 'gemini-flash-latest', 'gemini-3.1-flash-lite']

    for model_name in candidate_models:
        for attempt in range(2):
            try:
                response = client.models.generate_content(
                    model=model_name,
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                    ),
                )
                text = response.text.strip()
                
                # Clean up any potential markdown wrapper just in case
                if text.startswith("```"):
                    lines = text.split("\n")
                    if lines[0].startswith("```"):
                        lines = lines[1:]
                    if lines[-1].startswith("```"):
                        lines = lines[:-1]
                    text = "\n".join(lines).strip()
                    
                parsed = json.loads(text)
                if isinstance(parsed, dict) and "video_summary" in parsed:
                    return parsed
            except Exception as e:
                print(f"Gemini API call ({model_name}, attempt {attempt+1}) failed: {e}")
                if attempt < 1:
                    await asyncio.sleep(1)

    print("All Gemini models failed or busy. Using smart fallback analysis.")
    return get_fallback_analysis(metadata)

def get_fallback_analysis(metadata: dict = None) -> dict:
    if not metadata:
        metadata = {}
    title = metadata.get("official_title", "").strip() or "Untitled Video"
    channel = metadata.get("channel_name", "").strip()
    tags = metadata.get("tags", [])
    
    # Infer basic category heuristic based on title keywords
    title_lower = title.lower()
    category = "Other"
    intent = "Curiosity"
    domain = "General"
    
    if any(k in title_lower for k in ["tutorial", "how to", "guide", "explained", "learn", "course", "lecture"]):
        category = "Educational"
        intent = "Learning"
        domain = "Education & Tech"
    elif any(k in title_lower for k in ["review", "test", "vs", "code", "python", "javascript", "react", "tech"]):
        category = "Tech/Gaming"
        intent = "Skill_Acquisition"
        domain = "Technology"
    elif any(k in title_lower for k in ["song", "music", "audio", "remix", "official video", "band", "album"]):
        category = "Music/Art"
        intent = "Relaxation"
        domain = "Music"
    elif any(k in title_lower for k in ["funny", "vlog", "gameplay", "stream", "comedy", "movie"]):
        category = "Entertainment"
        intent = "Escapism"
        domain = "Pop Culture"

    topic_tags = [t for t in tags[:4]] if tags else [category.lower(), "video"]
    if not topic_tags:
        topic_tags = ["general"]

    summary_part = f"Video by {channel} titled '{title}'." if channel else f"Video titled '{title}'."

    return {
        "video_summary": f"{summary_part} Provides content focused on {domain.lower()} concepts.",
        "topic_tags": topic_tags,
        "primary_topic": title[:50] if title else "General Content",
        "content_category": category,
        "knowledge_domain": domain,
        "content_type": "Long-form",
        "estimated_user_intent": intent,
        "emotion_tone": "Informative, Casual",
        "confidence_score": 0.7
    }

