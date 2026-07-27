export interface YouTubeMetadata {
  video_id: string;
  official_title: string;
  description: string;
  channel_name: string;
  published_at: string;
  tags: string[];
  category_id: string;
  default_language: string;
  duration: string;
  thumbnail_url: string;
  statistics: {
    view_count: number;
    like_count: number;
    comment_count: number;
  };
}

export function extractVideoId(url: string): string | null {
  if (!url) return null;
  try {
    const match = url.match(/(?:v=|\/v\/|embed\/|shorts\/|youtu\.be\/|\/embed\/|\/v=|^v=)([^#\&\?]{11})/);
    if (match) return match[1];
    
    const urlObj = new URL(url);
    const v = urlObj.searchParams.get("v");
    if (v && v.length === 11) return v;
  } catch (e) {
    // Ignore
  }
  return null;
}

export async function fetchYouTubeMetadata(videoId: string, contentTitle: string): Promise<YouTubeMetadata> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.warn("YOUTUBE_API_KEY is not defined. Using fallback metadata.");
    return createFallbackMetadata(videoId, contentTitle);
  }

  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${videoId}&key=${apiKey}`;
  try {
    const res = await fetch(url);
    if (res.ok) {
      const data: any = await res.json();
      const items = data.items || [];
      if (items.length > 0) {
        const item = items[0];
        const snippet = item.snippet || {};
        const contentDetails = item.contentDetails || {};
        const statistics = item.statistics || {};
        const thumbnails = snippet.thumbnails || {};
        const thumbnailUrl = 
          thumbnails.high?.url || 
          thumbnails.medium?.url || 
          thumbnails.default?.url || 
          `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

        return {
          video_id: videoId,
          official_title: snippet.title || contentTitle,
          description: snippet.description || "",
          channel_name: snippet.channelTitle || "Unknown Channel",
          published_at: snippet.publishedAt || new Date().toISOString(),
          tags: snippet.tags || [],
          category_id: snippet.categoryId || "24",
          default_language: snippet.defaultLanguage || snippet.defaultAudioLanguage || "en",
          duration: contentDetails.duration || "PT0S",
          thumbnail_url: thumbnailUrl,
          statistics: {
            view_count: parseInt(statistics.viewCount || "0", 10),
            like_count: parseInt(statistics.likeCount || "0", 10),
            comment_count: parseInt(statistics.commentCount || "0", 10),
          }
        };
      } else {
        console.warn(`Video ${videoId} not found or is private. Using fallback metadata.`);
      }
    } else {
      console.error(`YouTube Data API returned status ${res.status}. Using fallback metadata.`);
    }
  } catch (error) {
    console.error(`Error fetching YouTube metadata: ${error}. Using fallback metadata.`);
  }

  return createFallbackMetadata(videoId, contentTitle);
}

function createFallbackMetadata(videoId: string, contentTitle: string): YouTubeMetadata {
  const cleanedTitle = contentTitle.replace(" - YouTube", "").trim();
  return {
    video_id: videoId,
    official_title: cleanedTitle || "Unknown YouTube Video",
    description: "No description available (fallback metadata generated).",
    channel_name: "Unknown Channel",
    published_at: new Date().toISOString(),
    tags: [],
    category_id: "24",
    default_language: "en",
    duration: "PT0S",
    thumbnail_url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    statistics: {
      view_count: 0,
      like_count: 0,
      comment_count: 0
    }
  };
}
