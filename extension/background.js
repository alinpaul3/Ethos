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
    console.log("Tracking started for:", message.url);
    if (currentSession) {
      finalizeSession();
    }
    
    currentSession = {
      user_id: activeUserId,
      platform: "youtube",
      content_title: message.title,
      url: message.url,
      timestamp_start: new Date().toISOString(),
      tabId: sender.tab.id
    };
    console.log("Session initialized for user:", activeUserId, "title:", message.title);
  } else if (message.type === "WATCH_STOP") {
    console.log("Tracking stopped.");
    finalizeSession();
  }
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (currentSession && currentSession.tabId === tabId) {
    finalizeSession();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (currentSession && currentSession.tabId === tabId && changeInfo.url) {
    if (!changeInfo.url.includes("youtube.com/watch")) {
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
    const eventPayload = {
      user_id: currentSession.user_id,
      platform: currentSession.platform,
      content_title: currentSession.content_title,
      url: currentSession.url,
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
