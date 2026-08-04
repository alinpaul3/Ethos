let currentSession = null;
const MOCK_USER_ID = "U123_TEST";
const DEFAULT_SERVER_URL = "https://ethos-i8i4.onrender.com/events";

let activeUserId = MOCK_USER_ID;
let activeServerUrl = DEFAULT_SERVER_URL;

let appPorts = [];

// Listen for persistent port connections from the application's content script context (works perfectly inside iframes too!)
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "ethos-app-bridge") {
    console.log("Application node connected via persistent port:", port);
    appPorts.push(port);
    
    // Automatically trigger synchronization of any cached/failed events
    syncCachedEvents(port);

    port.onDisconnect.addListener(() => {
      console.log("Application node disconnected from persistent port");
      appPorts = appPorts.filter(p => p !== port);
    });
  }
});

async function syncCachedEvents(port) {
  try {
    chrome.storage.local.get(null, async (items) => {
      if (chrome.runtime.lastError) {
        console.warn("Failed to get storage for syncing:", chrome.runtime.lastError.message);
        return;
      }
      
      const failedKeys = Object.keys(items || {}).filter(key => key.startsWith("failed_event_"));
      if (failedKeys.length === 0) return;
      
      // Sort failed keys chronologically so they are sent in order
      failedKeys.sort();
      
      console.log(`Discovered ${failedKeys.length} cached events waiting for sync. Starting synchronization...`);
      
      for (const key of failedKeys) {
        // If port disconnected, stop syncing
        if (!appPorts.includes(port)) {
          console.warn("Port disconnected during sync. Suspending sync loop.");
          break;
        }
        
        const payload = items[key];
        try {
          const res = await new Promise((resolve) => {
            const responseHandler = (msg) => {
              if (msg && msg.type === "FORWARD_EVENT_RESPONSE") {
                port.onMessage.removeListener(responseHandler);
                resolve(msg);
              }
            };
            port.onMessage.addListener(responseHandler);
            port.postMessage({ type: "FORWARD_EVENT", payload });
            
            // 4 second timeout
            setTimeout(() => {
              port.onMessage.removeListener(responseHandler);
              resolve({ success: false, error: "Sync timeout" });
            }, 4000);
          });
          
          if (res && res.success) {
            console.log(`Successfully synced cached event ${key}`);
            chrome.storage.local.remove(key);
          } else {
            console.warn(`Failed to sync cached event ${key}:`, res ? res.error : "unknown error");
            // Stop syncing the rest if we fail once (maybe server error or session closed)
            break;
          }
        } catch (err) {
          console.error("Error syncing cached event:", err);
          break;
        }
      }
    });
  } catch (err) {
    console.error("Error during syncCachedEvents:", err);
  }
}

// Initialize on startup safely
try {
  chrome.storage.local.get(["user_id", "server_url"], (result) => {
    if (chrome.runtime.lastError) {
      console.warn("Storage retrieval runtime error:", chrome.runtime.lastError.message);
      return;
    }
    if (result) {
      if (result.user_id) activeUserId = result.user_id;
      if (result.server_url) activeServerUrl = result.server_url;
    }
    console.log("Loaded credentials from storage:", activeUserId, activeServerUrl);
  });
} catch (err) {
  console.error("Failed to query chrome.storage.local on startup:", err);
}

// Watch for changes dynamically
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes) {
    if (changes.user_id) {
      activeUserId = changes.user_id.newValue || MOCK_USER_ID;
      console.log("Updated activeUserId:", activeUserId);
    }
    if (changes.server_url) {
      activeServerUrl = changes.server_url.newValue || DEFAULT_SERVER_URL;
      console.log("Updated activeServerUrl:", activeServerUrl);
    }
  }
});

let finalizeTimer = null;

function getVideoId(urlStr) {
  if (!urlStr) return null;
  try {
    if (urlStr.includes("v=")) {
      return urlStr.split("v=")[1].split("&")[0].split("#")[0];
    }
    if (urlStr.includes("youtube.com/shorts/")) {
      return urlStr.split("youtube.com/shorts/")[1].split("?")[0].split("&")[0].split("#")[0];
    }
    if (urlStr.includes("youtu.be/")) {
      return urlStr.split("youtu.be/")[1].split("?")[0].split("&")[0].split("#")[0];
    }
    if (urlStr.includes("youtube.com/embed/")) {
      return urlStr.split("youtube.com/embed/")[1].split("?")[0].split("&")[0].split("#")[0];
    }
    return null;
  } catch (e) {
    return null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SET_CONNECTION") {
    activeUserId = message.user_id;
    activeServerUrl = message.server_url;
    chrome.storage.local.set({ 
      user_id: message.user_id,
      server_url: message.server_url 
    }, () => {
      console.log("Connection saved in extension:", message.user_id, message.server_url);
    });
    sendResponse({ success: true });
  } else if (message.type === "WATCH_START") {
    console.log("Tracking start request for:", message.url);
    const newVid = getVideoId(message.url);
    const currVid = currentSession ? getVideoId(currentSession.url) : null;

    // If already tracking the exact same video ID, cancel any pending pause timer and preserve session
    if (currentSession && currVid && newVid && currVid === newVid) {
      console.log("Same video already being tracked. Preserving current session for video ID:", currVid);
      currentSession.content_title = message.title || currentSession.content_title;
      currentSession.url = message.url || currentSession.url;
      if (finalizeTimer) {
        clearTimeout(finalizeTimer);
        finalizeTimer = null;
      }
      sendResponse({ success: true, resumed: true });
      return true;
    }

    if (finalizeTimer) {
      clearTimeout(finalizeTimer);
      finalizeTimer = null;
    }

    if (currentSession) {
      finalizeSession();
    }
    
    currentSession = {
      user_id: activeUserId,
      platform: "youtube",
      content_title: message.title || "YouTube Video",
      url: message.url,
      timestamp_start: new Date().toISOString(),
      tabId: sender.tab ? sender.tab.id : null
    };
    console.log("Session initialized for user:", activeUserId, "title:", currentSession.content_title);
  } else if (message.type === "WATCH_PAUSE") {
    console.log("Tracking pause requested.");
    if (currentSession && !finalizeTimer) {
      // 30 second grace period: if user unpauses or resumes within 30s, session is kept continuous
      finalizeTimer = setTimeout(() => {
        finalizeSession();
        finalizeTimer = null;
      }, 30000);
    }
  } else if (message.type === "WATCH_STOP") {
    console.log("Tracking stop requested.");
    if (finalizeTimer) {
      clearTimeout(finalizeTimer);
      finalizeTimer = null;
    }
    finalizeSession();
  }
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (currentSession && currentSession.tabId === tabId) {
    if (finalizeTimer) {
      clearTimeout(finalizeTimer);
      finalizeTimer = null;
    }
    finalizeSession();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (currentSession && currentSession.tabId === tabId && changeInfo.url) {
    if (!changeInfo.url.includes("youtube.com/watch") && !changeInfo.url.includes("youtube.com/shorts/")) {
      if (finalizeTimer) {
        clearTimeout(finalizeTimer);
        finalizeTimer = null;
      }
      finalizeSession();
    }
  }
});

async function finalizeSession() {
  if (!currentSession) return;

  const endTime = new Date();
  const startTime = new Date(currentSession.timestamp_start);
  const durationSeconds = Math.round((endTime - startTime) / 1000);

  if (durationSeconds >= 5) {
    let cleanUrl = currentSession.url || "https://www.youtube.com";
    if (!cleanUrl.startsWith("http://") && !cleanUrl.startsWith("https://")) {
      cleanUrl = "https://" + cleanUrl;
    }

    const eventPayload = {
      user_id: String(currentSession.user_id || "U123_TEST"),
      platform: String(currentSession.platform || "youtube"),
      content_title: String(currentSession.content_title || "YouTube Video"),
      url: cleanUrl,
      timestamp_start: currentSession.timestamp_start,
      timestamp_end: endTime.toISOString(),
      duration_seconds: durationSeconds
    };

    console.log("Attempting to route event to backend:", eventPayload);

    let forwarded = false;

    // 1. Primary: Try to forward via connected persistent ports (extremely reliable, handles iframes & AI Studio previews perfectly!)
    if (appPorts.length > 0) {
      console.log(`Found ${appPorts.length} active persistent ports. Attempting to forward event...`);
      for (const port of appPorts) {
        try {
          const res = await new Promise((resolve) => {
            const responseHandler = (msg) => {
              if (msg && msg.type === "FORWARD_EVENT_RESPONSE") {
                port.onMessage.removeListener(responseHandler);
                resolve(msg);
              }
            };
            port.onMessage.addListener(responseHandler);
            port.postMessage({ type: "FORWARD_EVENT", payload: eventPayload });
            
            // Timeout after 4 seconds
            setTimeout(() => {
              port.onMessage.removeListener(responseHandler);
              resolve({ success: false, error: "Port forward timeout" });
            }, 4000);
          });

          if (res && res.success) {
            console.log("Event successfully forwarded and stored via active port!");
            forwarded = true;
            break;
          } else {
            console.warn("Port forwarding response was unsuccessful:", res ? res.error : "unknown error");
          }
        } catch (e) {
          console.warn("Error forwarding to persistent port:", e);
        }
      }
    }

    if (forwarded) {
      currentSession = null;
      return;
    }

    // 2. Secondary: Fallback to querying open tabs of our application or workspace to send via chrome.tabs.sendMessage
    chrome.tabs.query({}, async (tabs) => {
      const potentialTabs = (tabs || []).filter(tab => {
        if (!tab.url) return false;
        const url = tab.url.toLowerCase();
        return url.includes("localhost") || 
               url.includes("127.0.0.1") || 
               url.includes(".run.app") || 
               url.includes("aistudio.google.com") || 
               url.includes("ai.studio");
      });

      if (potentialTabs && potentialTabs.length > 0) {
        console.log(`Found ${potentialTabs.length} potential app/workspace tabs. Attempting tab message forwarding fallback...`);
        for (const tab of potentialTabs) {
          try {
            const res = await new Promise((resolve) => {
              chrome.tabs.sendMessage(tab.id, { type: "FORWARD_EVENT", payload: eventPayload }, (response) => {
                if (chrome.runtime.lastError) {
                  console.warn("Failed to contact tab:", tab.id, chrome.runtime.lastError.message);
                  resolve(null);
                } else {
                  resolve(response);
                }
              });
            });

            if (res && res.success) {
              console.log("Event successfully forwarded and saved via app tab ID:", tab.id);
              forwarded = true;
              break;
            } else if (res && !res.success) {
              console.warn("Tab failed to process event request:", res.error);
            }
          } catch (e) {
            console.warn("Error messaging tab:", tab.id, e);
          }
        }
      }

      if (forwarded) {
        return;
      }

      // 3. Tertiary Fallback: Direct fetch if forwarding is completely unavailable (e.g. no app pages open in browser at all)
      console.log("No active app tabs or ports found. Falling back to direct fetch...");
      try {
        const response = await fetch(activeServerUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(eventPayload)
        });

        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const data = await response.json();
          console.log("Backend direct response:", data);
        } else {
          const text = await response.text();
          console.warn("Backend returned non-JSON response:", text.slice(0, 250));
          if (text.trim().startsWith("<")) {
            throw new Error("Received HTML page instead of JSON. This typically happens when the AI Studio preview session is locked or requires authentication. Please open or refresh the application tab to sync.");
          }
        }
      } catch (error) {
        console.error("Failed to send event to:", activeServerUrl, error);
        // Store temporarily if failed
        chrome.storage.local.set({ ["failed_event_" + Date.now()]: eventPayload });
      }
    });
  } else {
    console.log("Session too short, ignored:", durationSeconds, "s");
  }

  currentSession = null;
}
