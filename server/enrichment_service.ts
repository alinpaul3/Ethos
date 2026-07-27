import { extractVideoId, fetchYouTubeMetadata, YouTubeMetadata } from "./youtube_service";
import { analyzeVideoMetadata, GeminiAnalysis } from "./gemini_service";

export interface EnrichedEvent {
  user_id: string;
  platform: string;
  browser_event: {
    content_title: string;
    url: string;
    timestamp_start: string;
    timestamp_end: string;
    duration_seconds: number;
    created_at: string;
  };
  youtube_metadata?: YouTubeMetadata;
  gemini_analysis?: GeminiAnalysis;
  processing_status: {
    youtube_metadata_fetched: boolean;
    gemini_processed: boolean;
    ready_for_processing: boolean;
    processed_at: string;
  };
}

export async function enrichEventPipeline(eventData: any, db: any): Promise<EnrichedEvent> {
  const url = eventData.url || "";
  const contentTitle = eventData.content_title || "";
  const userId = eventData.user_id || "";

  // 1. Extract Video ID
  const videoId = extractVideoId(url);
  if (!videoId) {
    console.warn(`No YouTube video ID could be extracted from: ${url}`);
    return {
      user_id: userId,
      platform: eventData.platform || "youtube",
      browser_event: {
        content_title: contentTitle,
        url,
        timestamp_start: eventData.timestamp_start || "",
        timestamp_end: eventData.timestamp_end || "",
        duration_seconds: eventData.duration_seconds || 0,
        created_at: new Date().toISOString()
      },
      processing_status: {
        youtube_metadata_fetched: false,
        gemini_processed: false,
        ready_for_processing: false,
        processed_at: new Date().toISOString()
      }
    };
  }

  // 2. Check cache in enriched_events
  let cachedDoc: any = null;
  if (db) {
    try {
      const enrichedCollection = db.collection("enriched_events");
      cachedDoc = await enrichedCollection.findOne({ "youtube_metadata.video_id": videoId });
      if (cachedDoc) {
        console.log(`Found cached enrichment in server for video ${videoId}! Reusing metadata and analysis.`);
      }
    } catch (err) {
      console.error("Error checking cache in server database:", err);
    }
  }

  let youtubeMetadata: YouTubeMetadata | undefined = undefined;
  let geminiAnalysis: GeminiAnalysis | undefined = undefined;

  if (cachedDoc) {
    youtubeMetadata = cachedDoc.youtube_metadata;
    geminiAnalysis = cachedDoc.gemini_analysis;
  }

  // 3. If not cached, fetch metadata and analyze with Gemini
  if (!youtubeMetadata) {
    youtubeMetadata = await fetchYouTubeMetadata(videoId, contentTitle);
  }

  if (!geminiAnalysis) {
    geminiAnalysis = await analyzeVideoMetadata(youtubeMetadata);
  }

  // 4. Form final enriched document
  const enrichedDoc: EnrichedEvent = {
    user_id: userId,
    platform: "youtube",
    browser_event: {
      content_title: contentTitle,
      url,
      timestamp_start: eventData.timestamp_start || "",
      timestamp_end: eventData.timestamp_end || "",
      duration_seconds: eventData.duration_seconds || 0,
      created_at: new Date().toISOString()
    },
    youtube_metadata: youtubeMetadata,
    gemini_analysis: geminiAnalysis,
    processing_status: {
      youtube_metadata_fetched: youtubeMetadata.official_title !== contentTitle || youtubeMetadata.description !== "No description available (fallback metadata generated).",
      gemini_processed: geminiAnalysis.video_summary !== "Analysis unavailable. Fallback generated due to processing limitation.",
      ready_for_processing: true,
      processed_at: new Date().toISOString()
    }
  };

  // 5. Save in database
  if (db) {
    try {
      const enrichedCollection = db.collection("enriched_events");
      await enrichedCollection.insertOne(enrichedDoc);
      console.log(`Stored final enriched event in database collection 'enriched_events' for user ${userId}`);
    } catch (err) {
      console.error("Failed to save enriched event to database collection:", err);
    }
  }

  return enrichedDoc;
}
