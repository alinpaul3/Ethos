import { GoogleGenAI, Type } from "@google/genai";

let ai: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY" || apiKey === "YOUR_GEMINI_API_KEY" || apiKey.trim() === "") {
    console.warn("GEMINI_API_KEY is not defined or is set to a placeholder. Using local fallback analysis.");
    return null;
  }
  if (!ai) {
    ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
  }
  return ai;
}

export interface GeminiAnalysis {
  video_summary: string;
  topic_tags: string[];
  primary_topic: string;
  content_category: string;
  knowledge_domain: string;
  content_type: string;
  estimated_user_intent: string;
  emotion_tone: string;
  confidence_score: number;
}

export async function analyzeVideoMetadata(metadata: any): Promise<GeminiAnalysis> {
  const client = getGeminiClient();
  if (!client) {
    return getFallbackAnalysis();
  }

  const desc = metadata.description ? metadata.description.slice(0, 1000) : "";
  const prompt = `
Analyze the following YouTube video metadata and estimate its semantic and behavioral characteristics.

Video ID: ${metadata.video_id || ""}
Title: ${metadata.official_title || ""}
Description: ${desc}
Channel Name: ${metadata.channel_name || ""}
Category ID: ${metadata.category_id || ""}
Tags: ${metadata.tags && metadata.tags.length > 0 ? metadata.tags.join(", ") : "None"}

You must return a valid, minified JSON object with the following fields and constraints:
1. "video_summary": (string, max 3-sentence summary emphasizing semantic content, educational/entertainment value, or cognitive state/intent of someone watching)
2. "topic_tags": (array of 3-5 specific semantic topic tags or keywords)
3. "primary_topic": (string, the single most prominent topic of the video)
4. "content_category": (string, must be exactly one of: Educational, Entertainment, News/Documentary, Tech/Gaming, Self-Improvement/Lifestyle, Music/Art, Other)
5. "knowledge_domain": (string, broad academic or professional domain, e.g. Computer Science, Philosophy, Pop Culture, Fitness, Finance, etc.)
6. "content_type": (string, must be exactly one of: Long-form, Short-form, Lecture, Review, Gameplay, Music Video, Vlog, Essay, Other)
7. "estimated_user_intent": (string, must be exactly one of: Learning, Entertainment, Information_Seeking, Skill_Acquisition, Escapism, Relaxation, Curiosity, Other)
8. "emotion_tone": (string, comma-separated list of 1-3 dominant emotional or mental tones, e.g. Calming, Exciting, Analytical, Humorous, Inspiring, Tense, Academic, Casual, etc.)
9. "confidence_score": (float between 0.0 and 1.0 representing confidence in this classification)

Your response must contain ONLY the valid JSON object. No markdown formatting, no code blocks (do not wrap in \`\`\`json), no additional text.
`;

  try {
    const response = await client.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            video_summary: { type: Type.STRING },
            topic_tags: { type: Type.ARRAY, items: { type: Type.STRING } },
            primary_topic: { type: Type.STRING },
            content_category: { type: Type.STRING },
            knowledge_domain: { type: Type.STRING },
            content_type: { type: Type.STRING },
            estimated_user_intent: { type: Type.STRING },
            emotion_tone: { type: Type.STRING },
            confidence_score: { type: Type.NUMBER },
          },
          required: [
            "video_summary",
            "topic_tags",
            "primary_topic",
            "content_category",
            "knowledge_domain",
            "content_type",
            "estimated_user_intent",
            "emotion_tone",
            "confidence_score"
          ]
        }
      }
    });

    let text = response.text || "";
    text = text.trim();
    if (text.startsWith("```")) {
      const lines = text.split("\n");
      if (lines[0].startsWith("```")) {
        lines.shift();
      }
      if (lines[lines.length - 1].startsWith("```")) {
        lines.pop();
      }
      text = lines.join("\n").trim();
    }

    return JSON.parse(text) as GeminiAnalysis;
  } catch (err: any) {
    console.warn(
      `Gemini API key is invalid or not active yet. Falling back to local/simulated analysis. ` +
      `Ensure you have provided a valid GEMINI_API_KEY in the Settings > Secrets panel of your AI Studio workspace. ` +
      `Error details: ${err.message || err}`
    );
    return getFallbackAnalysis();
  }
}

export function getFallbackAnalysis(): GeminiAnalysis {
  return {
    video_summary: "Analysis unavailable. Fallback generated due to processing limitation.",
    topic_tags: ["general", "uncategorized"],
    primary_topic: "General Content",
    content_category: "Other",
    knowledge_domain: "General",
    content_type: "Other",
    estimated_user_intent: "Curiosity",
    emotion_tone: "Neutral",
    confidence_score: 0.5
  };
}
