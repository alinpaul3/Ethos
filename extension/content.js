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

  let currentTrackingVid = null;

  function cleanExtractedTitle(rawTitle) {
    if (!rawTitle || typeof rawTitle !== "string") return null;
    const t = rawTitle
      .replace(/\s*-\s*YouTube\s*$/i, "")
      .replace(/\s*-\s*Shorts\s*$/i, "")
      .trim();
    if (!t) return null;
    const lower = t.toLowerCase();
    if (lower === "youtube" || lower === "shorts" || lower === "youtube shorts" || lower === "youtube video") {
      return null;
    }
    return t;
  }

  function getShortsTitle() {
    // 1. Check all active reel selectors in modern and legacy YouTube Shorts DOM
    const activeReel = document.querySelector(
      'ytd-reel-video-renderer[is-active], ytd-reel-video-renderer.ytd-shorts[is-active], ytd-reel-video-renderer[is-active="true"]'
    );
    if (activeReel) {
      const titleSelectors = [
        'yt-shorts-video-title-view-model',
        'ytd-reel-player-header-renderer h2',
        '.ytd-reel-player-header-renderer h2',
        'ytd-reel-player-header-renderer yt-formatted-string',
        '#overlay h2',
        'h2.title yt-formatted-string',
        'h2.title',
        '.title yt-formatted-string',
        '.title',
        '#shorts-player-overlay h2',
        '#overlay #video-title',
        '#title'
      ];
      for (const sel of titleSelectors) {
        const el = activeReel.querySelector(sel);
        if (el) {
          const text = (el.innerText || el.textContent || "").trim();
          const cleaned = cleanExtractedTitle(text);
          if (cleaned) return cleaned;
        }
      }
    }

    // 2. Secondary check for globally visible active short title view models
    const activeViewModel = document.querySelector('ytd-reel-video-renderer[is-active] yt-shorts-video-title-view-model');
    if (activeViewModel) {
      const text = (activeViewModel.innerText || activeViewModel.textContent || "").trim();
      const cleaned = cleanExtractedTitle(text);
      if (cleaned) return cleaned;
    }

    // DO NOT fall back to document.title on Shorts because YouTube SPA retains the previous video's document.title.
    return "YouTube Short";
  }

  function getWatchTitle() {
    // 1. Active watch metadata element
    const watchTitleEl = document.querySelector(
      'ytd-watch-metadata #title h1 yt-formatted-string, h1.style-scope.ytd-watch-metadata yt-formatted-string, #title h1, h1.ytd-watch-metadata, h1.title.ytd-video-primary-info-renderer, ytd-video-primary-info-renderer #title h1'
    );
    if (watchTitleEl) {
      const text = (watchTitleEl.innerText || watchTitleEl.textContent || "").trim();
      const cleaned = cleanExtractedTitle(text);
      if (cleaned) return cleaned;
    }

    // 2. Fallback to document.title for regular watch pages ONLY if watchTitleEl was absent
    const docTitle = cleanExtractedTitle(document.title);
    if (docTitle) {
      return docTitle;
    }

    return "YouTube Video";
  }

  function getTitle() {
    const url = location.href;
    if (url.includes("/shorts/")) {
      return getShortsTitle();
    }
    if (url.includes("/watch")) {
      return getWatchTitle();
    }
    const docTitle = cleanExtractedTitle(document.title);
    return docTitle || "YouTube Video";
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
        currentTrackingVid = newVid;
        notifyStart();
      } else {
        currentTrackingVid = null;
        notifyStop();
      }
      lastUrl = location.href;
    }
  }

  function notifyStart() {
    const targetVid = getVideoId(location.href);
    if (!targetVid) return;
    currentTrackingVid = targetVid;

    // Send immediate/slightly delayed notification
    setTimeout(() => {
      if (getVideoId(location.href) !== targetVid) return;
      const currentUrl = location.href;
      const initialTitle = getTitle() || (currentUrl.includes("/shorts/") ? "YouTube Short" : "YouTube Video");
      
      safeSendMessage({
        type: "WATCH_START",
        url: currentUrl,
        title: initialTitle
      });

      // If title was a placeholder, retry progressively as YouTube SPA renders the DOM
      if (initialTitle === "YouTube Short" || initialTitle === "YouTube Video") {
        const retryDelays = [600, 1400, 2600];
        retryDelays.forEach((delay) => {
          setTimeout(() => {
            if (getVideoId(location.href) === targetVid) {
              const updatedTitle = getTitle();
              if (updatedTitle && updatedTitle !== "YouTube Short" && updatedTitle !== "YouTube Video") {
                safeSendMessage({
                  type: "WATCH_START",
                  url: location.href,
                  title: updatedTitle
                });
              }
            }
          }, delay);
        });
      }
    }, 400);
  }

  function notifyStop() {
    safeSendMessage({ type: "WATCH_STOP" });
  }

  function notifyPause() {
    safeSendMessage({ type: "WATCH_PAUSE", url: location.href });
  }

  // Initial detection
  if (isWatchOrShorts(location.href)) {
    setTimeout(notifyStart, 1000);
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

  // Native YouTube SPA navigation event listeners
  window.addEventListener("yt-navigate-finish", () => {
    checkUrlChange();
  });
  window.addEventListener("yt-page-data-updated", () => {
    checkUrlChange();
  });
  window.addEventListener("popstate", () => {
    checkUrlChange();
  });

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
  
  // Establish persistent port connection (extremely robust for iframes and cross-frame syncing)
  if (typeof chrome !== "undefined" && chrome.runtime) {
    try {
      const port = chrome.runtime.connect({ name: "ethos-app-bridge" });
      
      port.onMessage.addListener((message) => {
        if (message.type === "FORWARD_EVENT") {
          console.log("Forwarding event from background script via persistent port:", message.payload);
          
          fetch(ETHOS_EVENTS_URL, {
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
        
        fetch(ETHOS_EVENTS_URL, {
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
      safeSendMessage({
        type: "SET_CONNECTION",
        user_id: userId
      }, (response) => {
        console.log("Subject ID saved to extension:", { userId });
      });
    }
  });
}
