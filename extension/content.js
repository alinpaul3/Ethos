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
  // YouTube watch & shorts tracking logic
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

  function isWatchOrShorts(urlStr) {
    if (!urlStr) return false;
    return urlStr.includes("youtube.com/watch") || urlStr.includes("youtube.com/shorts/");
  }

  function getTitle() {
    // Do NOT use og:title meta tag as YouTube SPA never updates it on internal navigation
    const h1 = document.querySelector('h1.style-scope.ytd-watch-metadata yt-formatted-string, #title h1, h1.ytd-watch-metadata, h1.title.ytd-video-primary-info-renderer, ytd-watch-metadata #title, ytd-reel-player-header-renderer h2, .ytd-reel-player-header-renderer');
    if (h1 && h1.innerText && h1.innerText.trim()) {
      return h1.innerText.replace(" - YouTube", "").trim();
    }
    
    const docTitle = document.title.replace(" - YouTube", "").trim();
    if (docTitle && docTitle.toLowerCase() !== "youtube") {
      return docTitle;
    }

    if (location.href.includes("/shorts/")) {
      return "YouTube Short";
    }

    return "YouTube Video";
  }

  let lastUrl = location.href;

  function checkUrlChange() {
    if (lastUrl !== location.href) {
      const prevVid = getVideoId(lastUrl);
      const newVid = getVideoId(location.href);

      // If both are the exact same video ID (e.g. timestamp param &t=39s appended on pause or seek), ignore!
      if (prevVid && newVid && prevVid === newVid) {
        lastUrl = location.href;
        return;
      }

      if (isWatchOrShorts(location.href) && newVid) {
        notifyStart();
      } else {
        notifyStop();
      }
      lastUrl = location.href;
    }
  }

  function notifyStart() {
    // Delay slightly to allow YouTube SPA to finish DOM title updates on new video load
    setTimeout(() => {
      const title = getTitle() || "YouTube Video";
      safeSendMessage({
        type: "WATCH_START",
        url: location.href,
        title: title
      });
    }, 1200);
  }

  function notifyStop() {
    safeSendMessage({ type: "WATCH_STOP" });
  }

  function notifyPause() {
    safeSendMessage({ type: "WATCH_PAUSE", url: location.href });
  }

  // Initial detection
  if (isWatchOrShorts(location.href)) {
    setTimeout(notifyStart, 1500);
  }

  // Watch for HTML5 video element play / pause events directly
  let attachedVideo = null;
  function attachVideoListeners() {
    const video = document.querySelector('video.html5-main-video, video');
    if (video && video !== attachedVideo) {
      attachedVideo = video;
      video.addEventListener('pause', () => {
        if (isWatchOrShorts(location.href)) {
          notifyPause();
        }
      });
      video.addEventListener('play', () => {
        if (isWatchOrShorts(location.href)) {
          notifyStart();
        }
      });
      video.addEventListener('ended', () => {
        notifyStop();
      });
    }
  }

  // Watch for navigation & video changes within YouTube SPA
  setInterval(() => {
    checkUrlChange();
    attachVideoListeners();
  }, 1000);

  // Watch for visibility changes
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      notifyPause();
    } else if (isWatchOrShorts(location.href)) {
      notifyStart();
    }
  });
} else {
  // Application page connection bridge
  console.log("Ethos content script loaded on application page. Listening for node linkage...");
  
  function getBackendEventsUrl() {
    if (typeof window !== "undefined" && window.location) {
      if (window.ETHOS_API_BASE_URL) {
        return `${window.ETHOS_API_BASE_URL.replace(/\/$/, "")}/events`;
      }
      if (window.location.hostname.includes("ethos-analysis.onrender.com")) {
        return "https://ethos-i8i4.onrender.com/events";
      }
      if (window.location.origin && window.location.origin !== "null") {
        return `${window.location.origin.replace(/\/$/, "")}/events`;
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
    if (event.data && event.data.type === "ETHOS_EXTENSION_PING") {
      window.postMessage({ type: "ETHOS_EXTENSION_PONG" }, "*");
    }
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
