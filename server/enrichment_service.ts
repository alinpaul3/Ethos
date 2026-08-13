import { extractVideoId, fetchYouTubeMetadata, YouTubeMetadata } from "./youtube_service";
import { analyzeVideoMetadata, GeminiAnalysis, GeminiQuotaExhaustedError } from "./gemini_service";
import crypto from "crypto";

export interface EnrichedEvent {
  event_id: string;
  user_id: string;
  platform: string;
  enrichment_status: string;
  enrichment_version: number;
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
  updated_at?: string;
}

export const CURRENT_ENRICHMENT_VERSION = 1;

export function generateEventId(eventData: any): string {
  if (eventData.event_id) {
    return eventData.event_id;
  }
  const userId = eventData.user_id || "unknown_user";
  const url = eventData.url || "";
  const tsStart = eventData.timestamp_start || "";
  const rawStr = `${userId}_${url}_${tsStart}`;
  return crypto.createHash("sha256").update(rawStr).digest("hex").slice(0, 24);
}

export async function enrichEventPipeline(eventData: any, db: any): Promise<EnrichedEvent> {
  const url = eventData.url || "";
  const contentTitle = eventData.content_title || "";
  const userId = eventData.user_id || "";
  const eventId = generateEventId(eventData);

  // 1. Extract Video ID
  const videoId = extractVideoId(url);
  if (!videoId) {
    console.warn(`[ENRICHMENT] No YouTube video ID could be extracted from: ${url}`);
    return {
      event_id: eventId,
      user_id: userId,
      platform: eventData.platform || "youtube",
      enrichment_status: "skipped",
      enrichment_version: CURRENT_ENRICHMENT_VERSION,
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
  let cachedContentDoc: any = null;
  if (db) {
    try {
      const enrichedCollection = db.collection("enriched_events");
      cachedDoc = await enrichedCollection.findOne({ event_id: eventId });

      if (!cachedDoc || cachedDoc.enrichment_status !== "completed") {
        cachedContentDoc = await enrichedCollection.findOne({
          "youtube_metadata.video_id": videoId,
          enrichment_status: "completed",
          "processing_status.gemini_processed": true
        });
      }
    } catch (err) {
      console.error("[ENRICHMENT] Error checking cache in server database:", err);
    }
  }

  if (cachedDoc && cachedDoc.enrichment_status === "completed" && cachedDoc.enrichment_version === CURRENT_ENRICHMENT_VERSION) {
    console.log(`[ENRICHMENT] Found cached enrichment for event_id=${eventId}`);
    return cachedDoc;
  }

  let youtubeMetadata: YouTubeMetadata | undefined = undefined;
  let geminiAnalysis: GeminiAnalysis | undefined = undefined;

  if (cachedContentDoc) {
    console.log(`[ENRICHMENT] Reusing content analysis for video ${videoId}: event_id=${eventId}`);
    youtubeMetadata = cachedContentDoc.youtube_metadata;
    geminiAnalysis = cachedContentDoc.gemini_analysis;
  } else if (cachedDoc) {
    youtubeMetadata = cachedDoc.youtube_metadata;
    geminiAnalysis = cachedDoc.enrichment_status === "completed" ? cachedDoc.gemini_analysis : undefined;
  }

  // 3. If not cached, fetch metadata and analyze with Gemini
  if (!youtubeMetadata) {
    youtubeMetadata = await fetchYouTubeMetadata(videoId, contentTitle);
  }

  let quotaExhausted = false;
  if (!geminiAnalysis) {
    try {
      geminiAnalysis = await analyzeVideoMetadata(youtubeMetadata);
    } catch (err) {
      if (err instanceof GeminiQuotaExhaustedError) {
        console.warn(`[ENRICHMENT] Gemini quota exhausted for event_id=${eventId}`);
        quotaExhausted = true;
        geminiAnalysis = undefined;
      } else {
        console.error(`[ENRICHMENT] Gemini processing failed for event_id=${eventId}:`, err);
        geminiAnalysis = undefined;
      }
    }
  }

  const enrichmentStatus = geminiAnalysis ? "completed" : (quotaExhausted ? "quota_exhausted" : "failed");
  const geminiProcessed = !!geminiAnalysis;

  // 4. Form final enriched document
  const enrichedDoc: EnrichedEvent = {
    event_id: eventId,
    user_id: userId,
    platform: "youtube",
    enrichment_status: enrichmentStatus,
    enrichment_version: CURRENT_ENRICHMENT_VERSION,
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
      youtube_metadata_fetched: youtubeMetadata ? (youtubeMetadata.official_title !== contentTitle) : false,
      gemini_processed: geminiProcessed,
      ready_for_processing: true,
      processed_at: new Date().toISOString()
    },
    updated_at: new Date().toISOString()
  };

  // 5. Save in database using UPSERT
  if (db) {
    try {
      const enrichedCollection = db.collection("enriched_events");
      await enrichedCollection.updateOne(
        { event_id: eventId },
        { $set: enrichedDoc },
        { upsert: true }
      );
      console.log(`[ENRICHMENT] Stored final enriched event (event_id=${eventId}, status=${enrichmentStatus}) for user ${userId}`);
    } catch (err) {
      console.error("[ENRICHMENT] Failed to save enriched event to database collection:", err);
    }
  }

  return enrichedDoc;
}
