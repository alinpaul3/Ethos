import os
import json
from google import genai
from google.genai import types

def get_gemini_client():
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("GEMINI_API_KEY is not defined. Using fallback analysis.")
        return None
    try:
        # Use-Agent config is set via Client
        return genai.Client(api_key=api_key, http_options={"headers": {"User-Agent": "aistudio-build"}})
    except Exception as e:
        print(f"Failed to initialize Gemini Client: {e}")
        return None

async def analyze_video_metadata(metadata: dict) -> dict:
    client = get_gemini_client()
    if not client:
        return get_fallback_analysis()

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
    try:
        response = client.models.generate_content(
            model='gemini-3.5-flash',
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
            
        return json.loads(text)
    except Exception as e:
        print(f"Gemini API call failed: {e}. Using fallback analysis.")
        return get_fallback_analysis()

def get_fallback_analysis() -> dict:
    return {
        "video_summary": "Analysis unavailable. Fallback generated due to processing limitation.",
        "topic_tags": ["general", "uncategorized"],
        "primary_topic": "General Content",
        "content_category": "Other",
        "knowledge_domain": "General",
        "content_type": "Other",
        "estimated_user_intent": "Curiosity",
        "emotion_tone": "Neutral",
        "confidence_score": 0.5
    }
