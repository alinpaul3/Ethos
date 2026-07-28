let contextInvalidated = false;

function safeSendMessage(message, callback) {
  if (contextInvalidated) return;
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) {
    try {
      if (callback) {
        chrome.runtime.sendMessage(message, (response) => {
          // Guard callback against chrome.runtime.lastError
          if (chrome.runtime.lastError) {
            const errMsg = chrome.runtime.lastError.message || "";
            if (errMsg.includes("context invalidated") || errMsg.includes("Extension context invalidated")) {
              contextInvalidated = true;
              console.warn("Ethos Extension context is invalidated. Please refresh the page to reconnect.");
            } else {
              console.warn("safeSendMessage error response:", errMsg);
            }
          } else if (callback) {
            callback(response);
          }
        });
      } else {
        chrome.runtime.sendMessage(message);
      }
    } catch (e) {
      contextInvalidated = true;
      console.warn("Chrome extension context is invalidated. Please reload the page to reconnect.", e);
    }
  } else {
    contextInvalidated = true;
    console.warn("Chrome extension runtime is not available (context may be invalidated). Please reload the page.");
  }
}

if (location.hostname.includes("youtube.com")) {
  // YouTube watch tracking logic
  function getTitle() {
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) return ogTitle.content.replace(" - YouTube", "").trim();
    
    const h1 = document.querySelector('h1.style-scope.ytd-watch-metadata yt-formatted-string');
    if (h1) return h1.innerText.replace(" - YouTube", "").trim();
    
    return document.title.replace(" - YouTube", "").trim();
  }

  let lastUrl = location.href;

  function checkUrlChange() {
    if (lastUrl !== location.href) {
      if (location.href.includes("youtube.com/watch")) {
        notifyStart();
      } else {
        notifyStop();
      }
      lastUrl = location.href;
    }
  }

  function notifyStart() {
    const title = getTitle();
    if (title) {
      safeSendMessage({
        type: "WATCH_START",
        url: location.href,
        title: title
      });
    }
  }

  function notifyStop() {
    safeSendMessage({ type: "WATCH_STOP" });
  }

  // Initial detection
  if (location.href.includes("youtube.com/watch")) {
    setTimeout(notifyStart, 2000);
  }

  // Watch for navigation within YouTube SPA
  setInterval(checkUrlChange, 1000);

  // Watch for visibility changes
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      notifyStop();
    } else if (location.href.includes("youtube.com/watch")) {
      notifyStart();
    }
  });
} else {
  // Application page connection bridge
  console.log("Ethos content script loaded on application page. Listening for node linkage...");
  
  function getBackendEventsUrl() {
    if (typeof window !== "undefined") {
      if (window.ETHOS_API_BASE_URL) {
        return `${window.ETHOS_API_BASE_URL.replace(/\/$/, "")}/events`;
      }
      if (window.location.hostname.includes("ethos-analysis.onrender.com")) {
        return "https://ethos-i8i4.onrender.com/events";
      }
    }
    return "/events";
  }

  // Establish persistent port connection (extremely robust for iframes and cross-frame syncing)
  if (typeof chrome !== "undefined" && chrome.runtime) {
    try {
      const port = chrome.runtime.connect({ name: "ethos-app-bridge" });
      
      port.onMessage.addListener((message) => {
        if (message.type === "FORWARD_EVENT") {
          console.log("Forwarding event from background script via persistent port:", message.payload);
          
          fetch(getBackendEventsUrl(), {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify(message.payload)
          })
          .then(async (response) => {
            const isJson = response.headers.get("content-type")?.includes("application/json");
            const text = await response.text();
            if (!response.ok) {
              throw new Error(`HTTP error! status: ${response.status}, body: ${text}`);
            }
            const data = isJson ? JSON.parse(text) : { text };
            console.log("Forwarded event successfully stored:", data);
            port.postMessage({ type: "FORWARD_EVENT_RESPONSE", success: true, data });
          })
          .catch((error) => {
            console.error("Failed to forward event via port:", error);
            port.postMessage({ type: "FORWARD_EVENT_RESPONSE", success: false, error: error.message });
          });
        }
      });
    } catch (e) {
      console.warn("Failed to connect persistent port ethos-app-bridge:", e);
    }

    // Keep the tabs.sendMessage listener as a secondary fallback
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === "FORWARD_EVENT") {
        console.log("Forwarding event from background script via backup tabs.sendMessage:", message.payload);
        
        // Fetch from the page's own context to bypass any proxy auth/same-site cookie restrictions
        fetch(getBackendEventsUrl(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(message.payload)
        })
        .then(async (response) => {
          const isJson = response.headers.get("content-type")?.includes("application/json");
          const text = await response.text();
          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}, body: ${text}`);
          }
          const data = isJson ? JSON.parse(text) : { text };
          console.log("Forwarded event successfully stored:", data);
          sendResponse({ success: true, data });
        })
        .catch((error) => {
          console.error("Failed to forward event:", error);
          sendResponse({ success: false, error: error.message });
        });
        return true; // Keep message channel open for async response
      }
    });
  }

  window.addEventListener("message", (event) => {
    if (event.data && event.data.type === "ETHOS_CONNECT_REQUEST") {
      const userId = event.data.user_id;
      let serverUrl = event.data.server_url;
      if (serverUrl && serverUrl.includes("ais-dev-")) {
        serverUrl = serverUrl.replace("ais-dev-", "ais-pre-");
      }
      safeSendMessage({
        type: "SET_CONNECTION",
        user_id: userId,
        server_url: serverUrl
      }, (response) => {
        console.log("Connection credentials saved to extension:", { userId, serverUrl });
      });
    }
  });
}
