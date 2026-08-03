import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Chrome, Copy, Check, Link as LinkIcon, AlertCircle, Download, ExternalLink, ArrowRight, Sparkles, CheckCircle2, ShieldCheck, Zap, Radio, Layers, Server, RefreshCw, HelpCircle, Lock } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { apiFetch, API_BASE_URL } from "../lib/api";
import ethosLogo from "../assets/images/ethos_app_icon_1785067621741.jpg";

interface ExtensionConnectPageProps {
  user: { user_id: string; email: string };
}

type ExtensionStatus = "not_installed" | "installed" | "connected" | "collecting";

export function ExtensionConnectPage({ user }: ExtensionConnectPageProps) {
  const [copied, setCopied] = useState(false);
  const [consentGiven, setConsentGiven] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<ExtensionStatus>("not_installed");
  const [activeTab, setActiveTab] = useState<"onboard" | "architecture">("onboard");
  const [isDetecting, setIsDetecting] = useState(false);

  useEffect(() => {
    const checkConsentAndStatus = async () => {
      try {
        const res = await apiFetch(`/api/consent-status?user_id=${user.user_id}`);
        if (res.ok) {
          const contentType = res.headers.get("content-type");
          if (contentType && contentType.includes("application/json")) {
            const data = await res.json();
            setConsentGiven(data.consent_given);
          }
        }

        // Check recent telemetry events to verify if data is actively collecting
        const dashboardRes = await apiFetch(`/api/dashboard-data?user_id=${user.user_id}`);
        if (dashboardRes.ok) {
          const contentType = dashboardRes.headers.get("content-type");
          if (contentType && contentType.includes("application/json")) {
            const dashData = await dashboardRes.json();
            if (dashData.recent_events && dashData.recent_events.length > 0) {
              setStatus("collecting");
            }
          }
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    checkConsentAndStatus();
  }, [user.user_id]);

  // Simulated extension handshake ping for Web Store detection
  const handleDetectExtension = async () => {
    setIsDetecting(true);
    
    // Dispatch window event for installed extension content scripts
    let extensionFound = false;
    const handlePong = (event: MessageEvent) => {
      if (event.data && event.data.type === "ETHOS_EXTENSION_PONG") {
        extensionFound = true;
        setStatus("installed");
      }
    };
    window.addEventListener("message", handlePong);
    window.postMessage({ type: "ETHOS_EXTENSION_PING" }, "*");

    setTimeout(() => {
      window.removeEventListener("message", handlePong);
      if (!extensionFound && status === "not_installed") {
        // Fallback simulate finding extension for demo/testing
      }
      setIsDetecting(false);
    }, 1500);
  };

  const handleSimulateAutoConnect = async () => {
    setStatus("connected");
    setTimeout(() => {
      setStatus("collecting");
    }, 1200);
  };

  const copyId = () => {
    navigator.clipboard.writeText(user.user_id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) return null;

  if (consentGiven !== true) {
    return (
      <div className="max-w-md mx-auto py-24 text-center space-y-6">
        <AlertCircle className="w-12 h-12 text-rose-500 mx-auto opacity-80" />
        <div>
          <span className="editorial-label">Access Restricted</span>
          <h2 className="text-2xl font-bold text-slate-900">Consent Required</h2>
        </div>
        <p className="text-sm text-slate-600 leading-relaxed">
          The node remains locked. You must review and grant consent before connecting the browser environment to the telemetry cluster.
        </p>
        <div className="pt-4">
          <Link to="/consent" className="editorial-btn-primary">Return to Directives</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Header & Mode Switcher */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200 pb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="px-3 py-1 rounded-full text-[10px] font-mono font-bold uppercase tracking-wider bg-amber-50 text-amber-800 border border-amber-200">
              Zero-Touch Onboarding
            </span>
            <span className="text-xs font-mono text-slate-400">|</span>
            <span className="text-xs font-mono text-slate-500">Chrome Web Store Flow</span>
          </div>
          <h1 className="text-3xl lg:text-4xl font-bold text-slate-900">Node Extension Setup</h1>
        </div>

        <div className="flex items-center gap-2 bg-slate-100 p-1 rounded-xl">
          <button
            onClick={() => setActiveTab("onboard")}
            className={`px-4 py-2 rounded-lg text-xs font-mono font-semibold transition-all cursor-pointer flex items-center gap-2 ${
              activeTab === "onboard"
                ? "bg-white text-slate-900 shadow-sm border border-slate-200"
                : "text-slate-500 hover:text-slate-800"
            }`}
          >
            <Chrome className="w-3.5 h-3.5 text-amber-500" />
            Volunteer Flow
          </button>
          <button
            onClick={() => setActiveTab("architecture")}
            className={`px-4 py-2 rounded-lg text-xs font-mono font-semibold transition-all cursor-pointer flex items-center gap-2 ${
              activeTab === "architecture"
                ? "bg-white text-slate-900 shadow-sm border border-slate-200"
                : "text-slate-500 hover:text-slate-800"
            }`}
          >
            <Server className="w-3.5 h-3.5 text-cyan-500" />
            Architecture Blueprint
          </button>
        </div>
      </div>

      {/* Status Bar */}
      <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="space-y-1">
          <span className="text-[10px] font-mono uppercase text-slate-400 font-bold tracking-wider">Live Node Status</span>
          <div className="flex items-center gap-3">
            {status === "not_installed" && (
              <span className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-mono font-bold uppercase bg-rose-50 text-rose-700 border border-rose-200">
                <span className="w-2.5 h-2.5 rounded-full bg-rose-500" />
                Not Installed
              </span>
            )}
            {status === "installed" && (
              <span className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-mono font-bold uppercase bg-amber-50 text-amber-800 border border-amber-200">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse" />
                Extension Installed (Pending Auth)
              </span>
            )}
            {status === "connected" && (
              <span className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-mono font-bold uppercase bg-cyan-50 text-cyan-800 border border-cyan-200">
                <span className="w-2.5 h-2.5 rounded-full bg-cyan-500 animate-pulse" />
                Connected & Authenticated
              </span>
            )}
            {status === "collecting" && (
              <span className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-mono font-bold uppercase bg-emerald-50 text-emerald-800 border border-emerald-200">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                Collecting Telemetry Signals
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleDetectExtension}
            disabled={isDetecting}
            className="px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-mono text-xs font-semibold uppercase tracking-wider transition-all border border-slate-200 flex items-center gap-2 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-slate-600 ${isDetecting ? "animate-spin" : ""}`} />
            {isDetecting ? "Detecting..." : "Re-Check Status"}
          </button>

          {status !== "collecting" && (
            <button
              onClick={handleSimulateAutoConnect}
              className="px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-slate-950 font-mono text-xs font-bold uppercase tracking-wider transition-all shadow-sm flex items-center gap-2 cursor-pointer"
            >
              <Zap className="w-3.5 h-3.5" />
              Simulate Auto-Link
            </button>
          )}
        </div>
      </div>

      {activeTab === "onboard" ? (
        <div className="space-y-8">
          {/* Main 1-Click Installation Card */}
          <div className="bg-gradient-to-br from-slate-900 via-slate-850 to-slate-900 text-white rounded-2xl p-8 border border-slate-800 shadow-xl relative overflow-hidden space-y-6">
            <div className="absolute -top-12 -right-12 w-64 h-64 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />

            <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 relative z-10">
              <div className="flex items-start gap-4">
                <img
                  src={ethosLogo}
                  alt="Ethos Chrome Extension Logo"
                  referrerPolicy="no-referrer"
                  className="w-16 h-16 rounded-2xl border border-amber-500/30 shadow-md object-cover shrink-0"
                />
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Chrome className="w-5 h-5 text-amber-400" />
                    <h2 className="text-xl font-bold text-white">Ethos Research Extension</h2>
                  </div>
                  <p className="text-xs text-slate-300 max-w-xl leading-relaxed">
                    Available directly on the official Chrome Web Store. One click adds the extension to your browser and automatically links your volunteer profile securely.
                  </p>
                </div>
              </div>

              <a
                href="https://chromewebstore.google.com/"
                target="_blank"
                rel="noreferrer"
                className="px-6 py-4 rounded-xl bg-amber-500 hover:bg-amber-600 text-slate-950 font-mono text-xs font-bold uppercase tracking-wider transition-all shadow-lg flex items-center gap-3 shrink-0 cursor-pointer group"
              >
                <Chrome className="w-4 h-4 text-slate-950" />
                Add to Chrome (Web Store)
                <ExternalLink className="w-4 h-4 text-slate-950 group-hover:translate-x-0.5 transition-transform" />
              </a>
            </div>

            {/* Step-by-step Visual Progress */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4 border-t border-slate-800 relative z-10">
              <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800/80 space-y-1.5">
                <span className="text-[10px] font-mono text-amber-400 font-bold uppercase">1. One-Click Add</span>
                <p className="text-xs font-semibold text-slate-200">Click "Add to Chrome"</p>
                <p className="text-[11px] text-slate-400 leading-relaxed">No developer mode or ZIP unzipping required.</p>
              </div>

              <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800/80 space-y-1.5">
                <span className="text-[10px] font-mono text-cyan-400 font-bold uppercase">2. Auto-Detect</span>
                <p className="text-xs font-semibold text-slate-200">Web Portal Handshake</p>
                <p className="text-[11px] text-slate-400 leading-relaxed">The website automatically detects installation instantly.</p>
              </div>

              <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800/80 space-y-1.5">
                <span className="text-[10px] font-mono text-emerald-400 font-bold uppercase">3. Zero-Touch Auth</span>
                <p className="text-xs font-semibold text-slate-200">Auto Subject Linking</p>
                <p className="text-[11px] text-slate-400 leading-relaxed">No copying or pasting IDs required!</p>
              </div>
            </div>
          </div>

          {/* Developer / Manual Fallback Box */}
          <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-xs space-y-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <img
                  src={ethosLogo}
                  alt="Ethos Extension Logo"
                  referrerPolicy="no-referrer"
                  className="w-9 h-9 rounded-xl border border-slate-200 shadow-xs object-cover"
                />
                <div>
                  <h3 className="text-sm font-bold text-slate-900">Developer & Offline Zip Package</h3>
                  <p className="text-[11px] text-slate-500">Ethos Chrome Extension Manifest v3</p>
                </div>
              </div>
              <span className="text-[10px] font-mono text-slate-500 bg-slate-100 px-2.5 py-1 rounded-full font-semibold">Unpacked Chrome Extension</span>
            </div>
            
            <p className="text-xs text-slate-600 leading-relaxed">
              If you are testing the raw unpacked ZIP download, follow these steps to ensure Chrome loads the content script properly:
            </p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="p-3.5 bg-slate-50 border border-slate-200/80 rounded-xl space-y-1">
                <span className="text-[10px] font-mono text-amber-700 font-bold uppercase">Step 1: Download & Unzip</span>
                <p className="text-xs text-slate-700">Download <code className="text-[11px] bg-slate-200 px-1 py-0.5 rounded">ethos-chrome-extension.zip</code> and extract it to a folder on your computer.</p>
              </div>

              <div className="p-3.5 bg-slate-50 border border-slate-200/80 rounded-xl space-y-1">
                <span className="text-[10px] font-mono text-cyan-700 font-bold uppercase">Step 2: Load in Chrome</span>
                <p className="text-xs text-slate-700">Go to <code className="text-[11px] bg-slate-200 px-1 py-0.5 rounded">chrome://extensions</code>, turn on <strong>Developer mode</strong>, click <strong>Load unpacked</strong> and select the unzipped folder.</p>
              </div>

              <div className="p-3.5 bg-amber-50/60 border border-amber-200/80 rounded-xl space-y-1">
                <span className="text-[10px] font-mono text-amber-800 font-bold uppercase">Step 3: Refresh Active Tabs</span>
                <p className="text-xs text-amber-900 font-semibold">⚠️ Important: Refresh this web app page and any open YouTube tabs so Chrome injects the new extension script into active pages.</p>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-2 border-t border-slate-100">
              <a
                href={`${API_BASE_URL ? API_BASE_URL : ""}/download-extension`}
                download="ethos-chrome-extension.zip"
                className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-slate-950 font-mono text-xs font-bold uppercase tracking-wider transition-all shadow-sm flex items-center justify-center gap-2 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 text-slate-950" />
                Download Raw ZIP
              </a>

              <div className="flex items-center gap-3 w-full sm:w-auto justify-end">
                <button
                  onClick={() => {
                    const backendBaseUrl = API_BASE_URL || window.location.origin;
                    window.postMessage({
                      type: "ETHOS_CONNECT_REQUEST",
                      user_id: user.user_id,
                      server_url: `${backendBaseUrl.replace(/\/$/, "")}/events`
                    }, "*");
                    handleDetectExtension();
                  }}
                  className="px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-mono text-xs font-semibold uppercase tracking-wider transition-all flex items-center gap-2 cursor-pointer shadow-xs"
                >
                  <Zap className="w-3.5 h-3.5 text-amber-400" />
                  Sync Extension to Account Now
                </button>

                <div className="hidden sm:flex items-center gap-2 text-xs font-mono text-slate-500">
                  <span>ID:</span>
                  <code className="bg-slate-100 px-2 py-1 rounded text-slate-800 font-bold">{user.user_id}</code>
                  <button onClick={copyId} className="text-amber-600 hover:underline cursor-pointer">
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* Architecture Blueprint Tab */
        <div className="bg-white rounded-2xl border border-slate-200/80 p-8 shadow-xs space-y-8">
          <div className="space-y-2">
            <h2 className="text-xl font-bold text-slate-900">Production Architecture & Auto-Linking Specification</h2>
            <p className="text-xs text-slate-600 leading-relaxed max-w-3xl">
              Ethos production onboarding specification for zero-touch Chrome Web Store authentication, securely linking volunteer research participants without manual key entry.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="p-5 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
              <span className="text-[10px] font-mono text-amber-600 font-bold uppercase flex items-center gap-1.5">
                <Chrome className="w-4 h-4" /> 1. Detection via externally_connectable
              </span>
              <p className="text-xs text-slate-700 leading-relaxed">
                By declaring <code className="bg-slate-200 px-1 py-0.5 rounded text-slate-900 font-mono">externally_connectable</code> in <code className="bg-slate-200 px-1 py-0.5 rounded text-slate-900 font-mono">manifest.json</code> with the website domain, the Ethos web app can ping <code className="bg-slate-200 px-1 py-0.5 rounded text-slate-900 font-mono">chrome.runtime.sendMessage(EXTENSION_ID)</code> directly to detect presence in milliseconds.
              </p>
            </div>

            <div className="p-5 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
              <span className="text-[10px] font-mono text-cyan-600 font-bold uppercase flex items-center gap-1.5">
                <Lock className="w-4 h-4" /> 2. One-Time Token Exchange
              </span>
              <p className="text-xs text-slate-700 leading-relaxed">
                When logged in, the web app calls <code className="bg-slate-200 px-1 py-0.5 rounded text-slate-900 font-mono">/api/auth/extension-token</code> to issue a short-lived (5 min) single-use pairing token. The web page passes this token to the extension via message passing.
              </p>
            </div>

            <div className="p-5 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
              <span className="text-[10px] font-mono text-emerald-600 font-bold uppercase flex items-center gap-1.5">
                <Server className="w-4 h-4" /> 3. Secure Extension Registration
              </span>
              <p className="text-xs text-slate-700 leading-relaxed">
                The extension background service worker exchanges the pairing token with <code className="bg-slate-200 px-1 py-0.5 rounded text-slate-900 font-mono">POST /api/extension/register</code>, receiving an isolated JWT and storing it in encrypted <code className="bg-slate-200 px-1 py-0.5 rounded text-slate-900 font-mono">chrome.storage.local</code>.
              </p>
            </div>

            <div className="p-5 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
              <span className="text-[10px] font-mono text-violet-600 font-bold uppercase flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4" /> 4. Real-time Status Synchronization
              </span>
              <p className="text-xs text-slate-700 leading-relaxed">
                The web app updates the volunteer UI status bar from <strong>Not Installed</strong> → <strong>Installed</strong> → <strong>Connected</strong> → <strong>Collecting Data</strong> automatically, eliminating all participant friction.
              </p>
            </div>
          </div>

          <div className="bg-slate-900 text-slate-200 p-5 rounded-xl font-mono text-xs space-y-2 border border-slate-800">
            <span className="text-amber-400 font-bold uppercase text-[10px]">Sequence Overview:</span>
            <pre className="text-[11px] leading-relaxed text-slate-300 overflow-x-auto p-2 bg-slate-950 rounded-lg">
{`User -> Ethos Web App: Log in & Open Extension Connect Page
Ethos Web App -> Extension (externally_connectable): ping(EXTENSION_ID)
Extension -> Ethos Web App: pong("v1.0.0") -> Status: INSTALLED
Ethos Web App -> FastAPI Backend: GET /api/auth/extension-token
FastAPI Backend -> Ethos Web App: { pairing_token: "pt_8f92a..." }
Ethos Web App -> Extension: sendMessage({ type: "AUTHENTICATE", token })
Extension -> FastAPI Backend: POST /api/extension/register { pairing_token }
FastAPI Backend -> Extension: { status: "registered", subject_id: "user_..." }
Extension -> Ethos Web App: ack("CONNECTED") -> Status: CONNECTED & COLLECTING`}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}


