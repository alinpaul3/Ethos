function updateUI() {
  const statusDiv = document.getElementById("status");
  const userIdEl = document.getElementById("user-id");
  const serverUrlEl = document.getElementById("server-url");
  const input = document.getElementById("user-id-input");
  const serverInput = document.getElementById("server-url-input");

  // Safety check to ensure we are running inside a Chrome extension context
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
    if (statusDiv) {
      statusDiv.innerText = "Developer Mock Mode";
      statusDiv.className = "status inactive";
    }
    if (userIdEl) userIdEl.innerText = "Current Sync ID:\nU123_TEST (Guest)";
    if (serverUrlEl) serverUrlEl.innerText = "Server:\nhttps://ais-pre-n2ycjjeekyew6sh6nvvtzu-589922721576.asia-east1.run.app/events";
    return;
  }

  try {
    chrome.storage.local.get(["user_id", "server_url"], (result) => {
      try {
        if (chrome.runtime.lastError) {
          console.warn("Storage runtime error:", chrome.runtime.lastError.message);
          return;
        }

        const uid = (result && result.user_id) || "U123_TEST (Guest)";
        if (userIdEl) {
          userIdEl.innerText = "Current Sync ID:\n" + uid;
        }

        const currentServer = (result && result.server_url) || "https://ais-pre-n2ycjjeekyew6sh6nvvtzu-589922721576.asia-east1.run.app/events";
        if (serverUrlEl) {
          serverUrlEl.innerText = "Server:\n" + currentServer;
        }
        
        // Fill the inputs if not currently being edited
        if (result && result.user_id && input && document.activeElement !== input) {
          input.value = result.user_id;
        }

        if (result && result.server_url && serverInput && document.activeElement !== serverInput) {
          serverInput.value = result.server_url;
        }
      } catch (innerErr) {
        console.error("Error in storage callback handler:", innerErr);
      }
    });
  } catch (err) {
    console.error("Failed to query chrome.storage.local:", err);
  }

  try {
    if (chrome.tabs && chrome.tabs.query) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        try {
          if (chrome.runtime.lastError) {
            console.warn("Tabs query runtime error:", chrome.runtime.lastError.message);
            if (statusDiv) {
              statusDiv.innerText = "Tracking Status Unavailable";
              statusDiv.className = "status inactive";
            }
            return;
          }

          const tab = tabs && tabs[0];
          if (statusDiv) {
            if (tab && tab.url && tab.url.includes("youtube.com/watch")) {
              statusDiv.innerText = "Tracking Active: Watching YouTube";
              statusDiv.className = "status active";
            } else {
              statusDiv.innerText = "Tracking Inactive: Visit YouTube watch page";
              statusDiv.className = "status inactive";
            }
          }
        } catch (innerTabErr) {
          console.error("Error in tabs callback handler:", innerTabErr);
        }
      });
    } else {
      if (statusDiv) {
        statusDiv.innerText = "Tabs API unavailable";
        statusDiv.className = "status inactive";
      }
    }
  } catch (err) {
    console.error("Failed to query chrome.tabs:", err);
  }
}

// Add event listener for saving manually
const saveBtn = document.getElementById("save-btn");
if (saveBtn) {
  saveBtn.addEventListener("click", () => {
    const inputVal = document.getElementById("user-id-input").value.trim();
    const serverInputVal = document.getElementById("server-url-input")?.value.trim();

    if (!inputVal) {
      alert("Please enter a valid Subject ID.");
      return;
    }

    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
      alert("Extension APIs are not available in this tab view. Please open the extension from your browser toolbar.");
      return;
    }

    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        try {
          const tab = tabs && tabs[0];
          let serverUrl = serverInputVal || null;

          if (!serverUrl && tab && tab.url && (tab.url.includes(".run.app") || tab.url.includes("localhost") || tab.url.includes("127.0.0.1"))) {
            try {
              const urlObj = new URL(tab.url);
              let origin = urlObj.origin;
              if (origin.includes("ais-dev-")) {
                origin = origin.replace("ais-dev-", "ais-pre-");
              }
              serverUrl = origin + "/events";
            } catch (e) {
              console.error("URL parsing error:", e);
            }
          }

          if (!serverUrl) {
            serverUrl = "https://ais-pre-n2ycjjeekyew6sh6nvvtzu-589922721576.asia-east1.run.app/events";
          }

          const payload = { 
            user_id: inputVal,
            server_url: serverUrl
          };

          chrome.storage.local.set(payload, () => {
            if (chrome.runtime.lastError) {
              alert("Error saving credentials: " + chrome.runtime.lastError.message);
              return;
            }
            let msg = "Successfully synced Subject Credentials to extension node!";
            msg += "\n\nSynced Server: " + serverUrl;
            alert(msg);
            updateUI();
          });
        } catch (innerSaveErr) {
          console.error("Error during credentials save logic:", innerSaveErr);
        }
      });
    } catch (err) {
      console.error("Failed to query tabs for server discovery:", err);
    }
  });
}

// Run initial update and set up periodic refresh
try {
  updateUI();
  setInterval(updateUI, 1000);
} catch (err) {
  console.error("Failed to initialize update loop:", err);
}
