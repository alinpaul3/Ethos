function updateUI() {
  const statusDiv = document.getElementById("status");
  const backendUrlEl = document.getElementById("backend-url");
  const input = document.getElementById("user-id-input");

  const setTrackingStatus = (active, title, detail) => {
    const statusCard = document.getElementById("status-card");
    const statusDetail = document.getElementById("status-detail");
    const headerStatus = document.getElementById("header-status");
    const statusIcon = statusCard?.querySelector(".status-icon");
    const stateClass = active ? "active" : "inactive";

    if (statusCard) statusCard.className = `card status-card ${stateClass}`;
    if (statusDiv) statusDiv.innerText = title;
    if (statusDetail) statusDetail.innerText = detail;
    if (statusIcon) statusIcon.innerText = active ? "●" : "○";
    if (headerStatus) {
      headerStatus.className = `header-status ${stateClass}`;
      headerStatus.innerHTML = `<span class="status-dot"></span>${active ? "Active" : "Inactive"}`;
    }
  };

  if (backendUrlEl) backendUrlEl.innerText = ETHOS_EVENTS_URL;

  // Existing status behavior is preserved; only the presentation is updated.
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
    setTrackingStatus(false, "Developer Mock Mode", "Open the extension from the Chrome toolbar to connect.");
    return;
  }

  try {
    chrome.storage.local.get(["user_id"], (result) => {
      if (chrome.runtime.lastError) {
        console.warn("Storage runtime error:", chrome.runtime.lastError.message);
        return;
      }
      if (result?.user_id && input && document.activeElement !== input) {
        input.value = result.user_id;
      }
    });
  } catch (err) {
    console.error("Failed to query chrome.storage.local:", err);
  }

  try {
    if (chrome.tabs && chrome.tabs.query) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) {
          console.warn("Tabs query runtime error:", chrome.runtime.lastError.message);
          setTrackingStatus(false, "Tracking status unavailable", "Chrome could not read the active browser tab.");
          return;
        }
        const tab = tabs && tabs[0];
        if (tab && tab.url && tab.url.includes("youtube.com/watch")) {
          setTrackingStatus(true, "Tracking Active", "Monitoring YouTube activity");
        } else {
          setTrackingStatus(false, "Tracking Inactive", "Visit YouTube to start tracking");
        }
      });
    } else {
      setTrackingStatus(false, "Tracking status unavailable", "Chrome tabs access is unavailable.");
    }
  } catch (err) {
    console.error("Failed to query chrome.tabs:", err);
  }
}

const copyBtn = document.getElementById("copy-btn");
if (copyBtn) {
  copyBtn.addEventListener("click", async () => {
    const input = document.getElementById("user-id-input");
    const value = input?.value.trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      copyBtn.innerText = "Copied";
      setTimeout(() => { copyBtn.innerText = "Copy"; }, 1400);
    } catch (err) {
      input?.select();
      document.execCommand("copy");
    }
  });
}

const saveBtn = document.getElementById("save-btn");
if (saveBtn) {
  saveBtn.addEventListener("click", () => {
    const inputVal = document.getElementById("user-id-input").value.trim();
    if (!inputVal) {
      alert("Please enter a valid Subject ID.");
      return;
    }
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
      alert("Extension APIs are not available in this tab view. Please open the extension from your browser toolbar.");
      return;
    }
    chrome.storage.local.set({ user_id: inputVal }, () => {
      if (chrome.runtime.lastError) {
        alert("Error saving credentials: " + chrome.runtime.lastError.message);
        return;
      }
      alert("Subject ID saved to the extension.");
      updateUI();
    });
  });
}

try {
  updateUI();
  setInterval(updateUI, 1000);
} catch (err) {
  console.error("Failed to initialize update loop:", err);
}
