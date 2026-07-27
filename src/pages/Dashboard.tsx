import { useState, useEffect } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Activity, Clock, Database, Info, RefreshCw, Compass, Shield, Award, Brain, Tag, ChevronDown, ChevronUp, Play, Sparkles, Zap, Download, Layers, ArrowUpRight, BarChart3, Radio, CheckCircle2, Cpu, FileText, ShieldCheck, Chrome, HelpCircle } from 'lucide-react';
import { motion, AnimatePresence } from "motion/react";
import { apiFetch } from "../lib/api";
interface DashboardProps {
  user: { user_id: string; email: string };
}

export function Dashboard({ user }: DashboardProps) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [showInstructions, setShowInstructions] = useState(true);
  const [activeLogTab, setActiveLogTab] = useState<"ai" | "raw">("ai");
  const [expandedEnrichedIndex, setExpandedEnrichedIndex] = useState<number | null>(0);
  const [searchTerm, setSearchTerm] = useState("");
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const triggerToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  const fetchDashboardData = async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    
    try {
      const res = await apiFetch(`/api/dashboard-data?user_id=${user.user_id}`);
      const contentType = res.headers.get("content-type");
      
      if (!res.ok) {
        throw new Error(`Failed to load telemetry stream (HTTP ${res.status})`);
      }
      if (!contentType || !contentType.includes("application/json")) {
        throw new Error("Server returned an invalid response format.");
      }
      const json = await res.json();
      setData(json);
      setError("");
    } catch (err: any) {
      console.warn("Telemetry fetch error:", err);
      // Only set UI error if we don't have existing data or if it was an explicit foreground fetch
      if (!silent || !data) {
        setError(err.message || "An error occurred fetching dashboard data");
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchDashboardData();
    const interval = setInterval(() => {
      fetchDashboardData(true);
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleSimulateEvent = async () => {
    setSimulating(true);
    try {
      const sampleTitles = [
        "MIT AI & Neural Networks Deep Dive - Special Lecture",
        "How Quantum Computers Break Encryption - Tech Explained",
        "Building High Scale Web Apps in Rust & TypeScript",
        "Huberman Lab: Science of Focus, Motivation & Discipline",
        "SpaceX Starship Orbital Launch Keynote & Engineering"
      ];
      const randomTitle = sampleTitles[Math.floor(Math.random() * sampleTitles.length)];
      const startTime = new Date(Date.now() - 600000).toISOString();
      const endTime = new Date().toISOString();

      const res = await apiFetch("/events", {
        method: "POST",
        
        body: JSON.stringify({
          user_id: user.user_id,
          platform: "youtube",
          content_title: randomTitle,
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          timestamp_start: startTime,
          timestamp_end: endTime,
          duration_seconds: Math.floor(Math.random() * 600) + 300,
        }),
      });

      if (res.ok) {
        triggerToast("⚡ Simulated event broadcasted to cluster! Re-fetching stream...");
        await fetchDashboardData(true);
      } else {
        triggerToast("❌ Simulation request rejected");
      }
    } catch (e: any) {
      console.error(e);
      triggerToast("Error triggering simulation");
    } finally {
      setSimulating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-36 space-y-4">
        <div className="relative">
          <div className="w-12 h-12 rounded-full border-2 border-amber-500/20 border-t-amber-500 animate-spin" />
          <Cpu className="w-5 h-5 text-amber-500 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
        </div>
        <p className="text-xs font-mono uppercase tracking-widest text-slate-500">Synchronizing Telemetry Cluster...</p>
      </div>
    );
  }

  const hasEvents = data && data.total_captured_events > 0;
  const recentEvents = data?.recent_events || [];
  const recentEnrichedEvents = data?.recent_enriched_events || [];
  const features = data?.features || {};
  const profile = data?.profile || {};
  const signals = profile.signals || {};

  const filteredEnriched = recentEnrichedEvents.filter((item: any) => {
    if (!searchTerm) return true;
    const title = item.youtube_metadata?.official_title || item.browser_event?.content_title || "";
    const cat = item.gemini_analysis?.content_category || "";
    const topic = item.gemini_analysis?.primary_topic || "";
    return title.toLowerCase().includes(searchTerm.toLowerCase()) ||
           cat.toLowerCase().includes(searchTerm.toLowerCase()) ||
           topic.toLowerCase().includes(searchTerm.toLowerCase());
  });

  const chartData = recentEvents.length > 0 
    ? recentEvents.slice(0, 10).reverse().map((e: any) => ({
        name: e.content_title ? (e.content_title.length > 18 ? e.content_title.slice(0, 18) + "..." : e.content_title) : "Stream Packet",
        duration: e.duration_seconds || 0
      }))
    : [
        { name: '00:00', duration: 120 },
        { name: '04:00', duration: 240 },
        { name: '08:00', duration: 450 },
        { name: '12:00', duration: 300 },
        { name: '16:00', duration: 600 },
        { name: '20:00', duration: 420 },
        { name: '23:59', duration: 180 },
      ];

  const formatDuration = (seconds: number) => {
    if (!seconds) return "0s";
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `${mins}m ${secs}s`;
  };

  return (
    <div className="space-y-10">
      {/* Toast notification overlay */}
      <AnimatePresence>
        {toastMessage && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed top-20 right-8 z-50 bg-slate-900 text-amber-300 border border-amber-500/30 px-5 py-3 rounded-xl shadow-2xl font-mono text-xs flex items-center gap-3 backdrop-blur-xl"
          >
            <Sparkles className="w-4 h-4 text-amber-400" />
            <span>{toastMessage}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Hero Header Section */}
      <div className="bg-white rounded-2xl p-8 border border-slate-200/80 shadow-xs relative overflow-hidden">
        <div className="absolute -top-12 -right-12 w-64 h-64 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 relative z-10">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-mono font-bold uppercase tracking-wider bg-emerald-50 text-emerald-700 border border-emerald-200">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                {hasEvents ? "Live Stream Ingesting" : "Node Standby Ready"}
              </span>
              <span className="text-xs font-mono text-slate-400">|</span>
              <span className="text-xs font-mono text-slate-500">SUBJECT: {user.user_id.slice(0, 8)}...</span>
            </div>
            <h1 className="text-3xl lg:text-4xl font-bold text-slate-900">
              Telemetry & Behavioral Index
            </h1>
            <p className="text-xs font-sans text-slate-500 max-w-2xl leading-relaxed">
              Real-time browser telemetry capture paired with Gemini AI semantic classification and big five OCEAN personality estimation.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <button
              onClick={() => setShowInstructions(!showInstructions)}
              className="px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-mono text-xs font-bold uppercase tracking-wider transition-all shadow-sm flex items-center gap-2 cursor-pointer"
            >
              <HelpCircle className="w-3.5 h-3.5 text-amber-400" />
              {showInstructions ? "Hide Instructions" : "How It Works"}
            </button>

            <button
              onClick={handleSimulateEvent}
              disabled={simulating}
              className="px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-slate-950 font-mono text-xs font-bold uppercase tracking-wider transition-all shadow-sm flex items-center gap-2 cursor-pointer disabled:opacity-50"
              title="Post a test YouTube event to watch live charts & Gemini enrichment update"
            >
              <Zap className={`w-3.5 h-3.5 ${simulating ? "animate-bounce" : ""}`} />
              {simulating ? "Simulating..." : "Simulate Event"}
            </button>

            <button
              onClick={() => fetchDashboardData()}
              className="px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-mono text-xs font-semibold uppercase tracking-wider transition-all border border-slate-200 flex items-center gap-2 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 text-slate-600 ${refreshing ? "animate-spin" : ""}`} />
              Sync
            </button>
          </div>
        </div>
      </div>

      {/* Volunteer Quick-Start Instructions Banner */}
      <AnimatePresence>
        {showInstructions && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="bg-gradient-to-r from-slate-900 via-slate-850 to-slate-900 border border-slate-800 rounded-2xl p-6 text-white shadow-xl space-y-5 relative overflow-hidden"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-amber-500/10 rounded-xl border border-amber-500/20 text-amber-400">
                  <Sparkles className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">Volunteer Quick-Start Guide</h3>
                  <p className="text-xs text-slate-400">4 simple steps to complete your study contribution</p>
                </div>
              </div>
              <button
                onClick={() => setShowInstructions(false)}
                className="text-xs font-mono text-slate-400 hover:text-white px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 transition-colors cursor-pointer"
              >
                Dismiss ✕
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-2">
                <div className="flex items-center justify-between text-xs font-mono font-bold text-amber-400">
                  <span>STEP 01</span>
                  <FileText className="w-4 h-4 text-slate-500" />
                </div>
                <h4 className="text-xs font-semibold text-slate-200">Take BFI-44 Survey</h4>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Complete the 44-item Big Five personality questionnaire to set up your baseline psychometric profile.
                </p>
                <a href="/questionnaire" className="inline-block text-[11px] font-mono text-amber-400 hover:underline pt-1">
                  Start Survey →
                </a>
              </div>

              <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-2">
                <div className="flex items-center justify-between text-xs font-mono font-bold text-cyan-400">
                  <span>STEP 02</span>
                  <ShieldCheck className="w-4 h-4 text-slate-500" />
                </div>
                <h4 className="text-xs font-semibold text-slate-200">Review Directives</h4>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Confirm your data privacy directives and authorization consent for anonymized telemetry collection.
                </p>
                <a href="/consent" className="inline-block text-[11px] font-mono text-cyan-400 hover:underline pt-1">
                  View Consent →
                </a>
              </div>

              <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-2">
                <div className="flex items-center justify-between text-xs font-mono font-bold text-emerald-400">
                  <span>STEP 03</span>
                  <Chrome className="w-4 h-4 text-slate-500" />
                </div>
                <h4 className="text-xs font-semibold text-slate-200">Link Node Extension</h4>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Install the Chrome Extension zip and enter your Subject ID <code className="bg-slate-800 px-1 py-0.5 rounded text-amber-300">{user.user_id.slice(0, 8)}</code> into the popup.
                </p>
                <a href="/connect-extension" className="inline-block text-[11px] font-mono text-emerald-400 hover:underline pt-1">
                  Connect Extension →
                </a>
              </div>

              <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-2">
                <div className="flex items-center justify-between text-xs font-mono font-bold text-violet-400">
                  <span>STEP 04</span>
                  <Zap className="w-4 h-4 text-slate-500" />
                </div>
                <h4 className="text-xs font-semibold text-slate-200">Browse & Test</h4>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Watch YouTube videos as normal, or click "Simulate Event" above to test live Gemini AI semantic analysis instantly!
                </p>
                <button onClick={handleSimulateEvent} className="text-[11px] font-mono text-violet-400 hover:underline pt-1 cursor-pointer">
                  Test Simulation →
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {error && (
        <div className="bg-rose-50 border border-rose-200 text-rose-800 text-xs p-4 rounded-xl font-mono flex items-center gap-3">
          <Info className="w-4 h-4 text-rose-600 shrink-0" />
          <span>Stream Sync Notice: {error}</span>
        </div>
      )}

      {/* Stat Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        <StatCard
          icon={<Radio className="w-5 h-5 text-amber-500" />}
          label="Events Captured"
          value={data?.total_captured_events || "0"}
          badge="Live Feed"
          color="amber"
        />
        <StatCard
          icon={<Clock className="w-5 h-5 text-cyan-500" />}
          label="Avg Watch Time"
          value={features.avg_session_duration ? formatDuration(features.avg_session_duration) : "0s"}
          badge="Per Session"
          color="cyan"
        />
        <StatCard
          icon={<Database className="w-5 h-5 text-emerald-500" />}
          label="Total Ingestion"
          value={features.total_watch_time ? formatDuration(features.total_watch_time) : "0s"}
          badge="Cumulative"
          color="emerald"
        />
        <StatCard
          icon={<Brain className="w-5 h-5 text-violet-500" />}
          label="Sentiment Balance"
          value={features.avg_sentiment !== undefined ? `${features.avg_sentiment > 0 ? "+" : ""}${features.avg_sentiment.toFixed(1)}` : "0.0"}
          badge={features.avg_sentiment > 0 ? "Positive" : "Neutral"}
          color="violet"
        />
      </div>

      {/* Main Grid: Chart + AI Feed & Sidebar Insights */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">
          {/* Capture Intensity Chart Card */}
          <div className="bg-white rounded-2xl border border-slate-200/80 p-6 space-y-6 shadow-xs">
            <div className="flex items-center justify-between border-b border-slate-100 pb-4">
              <div>
                <span className="editorial-label">Stream Density</span>
                <h3 className="text-lg font-semibold text-slate-900">
                  Recent Dwell Duration (Seconds)
                </h3>
              </div>
              <span className="text-[10px] font-mono bg-slate-100 px-3 py-1 rounded-full text-slate-600 font-bold uppercase">
                Packet Intensity
              </span>
            </div>

            {!hasEvents ? (
              <div className="h-72 w-full bg-slate-50/80 border border-dashed border-slate-200 rounded-xl flex items-center justify-center p-8 text-center relative overflow-hidden">
                <div className="space-y-4 max-w-sm z-10">
                  <div className="w-12 h-12 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mx-auto text-amber-600">
                    <Radio className="w-6 h-6 animate-pulse" />
                  </div>
                  <div>
                    <h4 className="font-semibold text-slate-800 text-base">Awaiting Telemetry Signals</h4>
                    <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                      Click <strong className="text-slate-800 font-semibold">"Simulate Event"</strong> above or activate the browser extension to populate live stream metrics!
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="h-72 w-full pt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                    <XAxis dataKey="name" fontSize={10} stroke="#94a3b8" tickLine={false} />
                    <YAxis fontSize={10} stroke="#94a3b8" tickLine={false} unit="s" />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "#0f172a",
                        border: "1px solid #334155",
                        borderRadius: "12px",
                        color: "#f8fafc",
                        fontSize: "11px",
                        fontFamily: "monospace",
                        boxShadow: "0 10px 25px -5px rgba(0,0,0,0.3)"
                      }}
                      formatter={(value: any) => [`${value}s`, "Watch Time"]}
                    />
                    <Area type="monotone" dataKey="duration" stroke="#f59e0b" strokeWidth={2.5} fill="url(#areaGradient)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* Stream Log Terminal with Tabs */}
          {hasEvents && (
            <div className="bg-white rounded-2xl border border-slate-200/80 p-6 space-y-6 shadow-xs">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-slate-100 pb-4 gap-4">
                <div className="flex items-center gap-2 bg-slate-100 p-1 rounded-xl">
                  <button
                    onClick={() => setActiveLogTab("ai")}
                    className={`px-4 py-2 rounded-lg text-xs font-mono font-semibold transition-all cursor-pointer flex items-center gap-2 ${
                      activeLogTab === "ai"
                        ? "bg-white text-slate-900 shadow-sm border border-slate-200"
                        : "text-slate-500 hover:text-slate-800"
                    }`}
                  >
                    <Brain className="w-3.5 h-3.5 text-amber-500" />
                    AI Semantic Feed ({recentEnrichedEvents.length})
                  </button>
                  <button
                    onClick={() => setActiveLogTab("raw")}
                    className={`px-4 py-2 rounded-lg text-xs font-mono font-semibold transition-all cursor-pointer flex items-center gap-2 ${
                      activeLogTab === "raw"
                        ? "bg-white text-slate-900 shadow-sm border border-slate-200"
                        : "text-slate-500 hover:text-slate-800"
                    }`}
                  >
                    <Layers className="w-3.5 h-3.5 text-cyan-500" />
                    Raw Telemetry ({recentEvents.length})
                  </button>
                </div>

                {activeLogTab === "ai" && (
                  <input
                    type="text"
                    placeholder="Search topics or titles..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="px-3.5 py-1.5 rounded-xl border border-slate-200 text-xs font-mono bg-slate-50 focus:outline-none focus:border-amber-500 text-slate-800"
                  />
                )}
              </div>

              {activeLogTab === "ai" ? (
                <div className="space-y-4">
                  {filteredEnriched.length === 0 ? (
                    <div className="p-8 text-center bg-slate-50 rounded-xl border border-slate-200 text-slate-500 space-y-2">
                      <p className="text-sm font-semibold">No enriched logs match search filter</p>
                    </div>
                  ) : (
                    <div className="space-y-3 max-h-[550px] overflow-y-auto pr-1">
                      {filteredEnriched.map((enriched: any, idx: number) => {
                        const meta = enriched.youtube_metadata || {};
                        const aiAnalysis = enriched.gemini_analysis || {};
                        const browserEv = enriched.browser_event || {};
                        const isExpanded = expandedEnrichedIndex === idx;

                        return (
                          <div
                            key={idx}
                            className="border border-slate-200 rounded-xl overflow-hidden transition-all duration-200 hover:border-slate-300 bg-white"
                          >
                            <div
                              onClick={() => setExpandedEnrichedIndex(isExpanded ? null : idx)}
                              className="p-4 flex gap-4 items-center cursor-pointer hover:bg-slate-50/80 transition-colors"
                            >
                              {/* Thumbnail */}
                              <div className="w-20 h-12 bg-slate-900 rounded-lg overflow-hidden shrink-0 relative border border-slate-800">
                                {meta.thumbnail_url ? (
                                  <img
                                    src={meta.thumbnail_url}
                                    alt={meta.official_title}
                                    className="w-full h-full object-cover"
                                    referrerPolicy="no-referrer"
                                  />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center text-amber-400">
                                    <Play className="w-4 h-4 fill-amber-400" />
                                  </div>
                                )}
                              </div>

                              {/* Title & Category Badges */}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1 flex-wrap">
                                  <span className="text-[9px] font-mono uppercase bg-amber-50 text-amber-800 px-2 py-0.5 rounded font-bold border border-amber-200/60">
                                    {aiAnalysis.content_category || "General"}
                                  </span>
                                  <span className="text-[9px] font-mono uppercase bg-cyan-50 text-cyan-800 px-2 py-0.5 rounded border border-cyan-200/60">
                                    {aiAnalysis.knowledge_domain || "Tech"}
                                  </span>
                                </div>
                                <h4 className="font-semibold text-slate-900 truncate text-sm">
                                  {meta.official_title || browserEv.content_title}
                                </h4>
                                <p className="text-[10px] font-mono text-slate-400 mt-0.5">
                                  {meta.channel_name || "YouTube Stream"} • {formatDuration(browserEv.duration_seconds)}
                                </p>
                              </div>

                              <div className="p-1 rounded-lg bg-slate-100 text-slate-500">
                                {isExpanded ? <ChevronUp className="w-4 h-4 text-slate-800" /> : <ChevronDown className="w-4 h-4" />}
                              </div>
                            </div>

                            {/* Expanded Details Panel */}
                            {isExpanded && (
                              <div className="border-t border-slate-100 bg-slate-50/60 p-5 space-y-4 text-xs">
                                <div className="p-3 bg-white rounded-xl border border-slate-200 space-y-1">
                                  <span className="text-[10px] font-mono uppercase text-amber-600 font-bold flex items-center gap-1.5">
                                    <Brain className="w-3.5 h-3.5" />
                                    Gemini AI Narrative Summary
                                  </span>
                                  <p className="text-slate-800 text-xs leading-relaxed">
                                    "{aiAnalysis.video_summary || "Gemini evaluated video content characteristics."}"
                                  </p>
                                </div>

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                  <div className="p-3 bg-white rounded-xl border border-slate-200 space-y-1.5">
                                    <span className="text-[10px] font-mono uppercase text-slate-400 font-bold flex items-center gap-1">
                                      <Tag className="w-3 h-3 text-slate-500" /> Focal Topics
                                    </span>
                                    <p className="font-medium text-slate-900 text-xs">{aiAnalysis.primary_topic || "N/A"}</p>
                                    <div className="flex flex-wrap gap-1 pt-1">
                                      {aiAnalysis.topic_tags?.map((t: string, i: number) => (
                                        <span key={i} className="text-[9px] font-mono bg-slate-100 text-slate-600 px-2 py-0.5 rounded border border-slate-200">
                                          #{t}
                                        </span>
                                      ))}
                                    </div>
                                  </div>

                                  <div className="p-3 bg-white rounded-xl border border-slate-200 space-y-1.5">
                                    <span className="text-[10px] font-mono uppercase text-slate-400 font-bold flex items-center gap-1">
                                      <Compass className="w-3 h-3 text-slate-500" /> Behavioral Tone
                                    </span>
                                    <div className="flex justify-between text-xs">
                                      <span className="text-slate-500">Emotion:</span>
                                      <span className="font-semibold text-slate-900">{aiAnalysis.emotion_tone || "Neutral"}</span>
                                    </div>
                                    <div className="space-y-1 pt-1">
                                      <div className="flex justify-between text-[10px] font-mono text-slate-400">
                                        <span>AI Confidence</span>
                                        <span className="font-bold text-slate-800">{Math.round((aiAnalysis.confidence_score || 0.9) * 100)}%</span>
                                      </div>
                                      <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
                                        <div
                                          className="bg-amber-500 h-full rounded-full"
                                          style={{ width: `${(aiAnalysis.confidence_score || 0.9) * 100}%` }}
                                        />
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <div className="border border-slate-200 rounded-xl overflow-hidden bg-white">
                  <div className="max-h-96 overflow-y-auto divide-y divide-slate-100">
                    {recentEvents.map((e: any, i: number) => (
                      <div key={i} className="p-4 flex items-center justify-between text-xs hover:bg-slate-50 transition-colors">
                        <div className="space-y-0.5 min-w-0 pr-4">
                          <p className="font-semibold text-slate-900 truncate">{e.content_title}</p>
                          <p className="text-[10px] font-mono text-slate-400 truncate">
                            {e.platform} • <a href={e.url} target="_blank" rel="noreferrer" className="text-amber-600 underline hover:text-amber-700">{e.url}</a>
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <span className="font-mono text-xs font-bold text-slate-800 block">{formatDuration(e.duration_seconds)}</span>
                          <span className="text-[9px] font-mono text-slate-400 block">{new Date(e.created_at || e.timestamp_start).toLocaleTimeString()}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Sidebar Column: OCEAN Traits & Pipeline Tools */}
        <div className="space-y-6">
          {/* OCEAN Matrix Card */}
          <div className="bg-slate-950 text-white rounded-2xl p-6 border border-slate-800 space-y-6 shadow-xl relative overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div className="flex items-center gap-2">
                <Brain className="w-5 h-5 text-amber-400" />
                <h3 className="text-lg font-semibold text-white">OCEAN Trait Profile</h3>
              </div>
              <span className="text-[9px] font-mono bg-amber-400/10 text-amber-400 px-2.5 py-1 rounded-full font-bold uppercase border border-amber-400/20">
                Active Model
              </span>
            </div>

            {/* Behavioral Signals Status */}
            <div className="space-y-3 font-mono text-xs">
              <div className="flex justify-between items-center bg-slate-900 p-2.5 rounded-xl border border-slate-800">
                <span className="text-slate-400">Curiosity Signal</span>
                <span className={`px-2 py-0.5 rounded font-bold text-[10px] ${signals.curiosity_signal === "High" ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "bg-slate-800 text-slate-300"}`}>
                  {signals.curiosity_signal || "CALCULATING"}
                </span>
              </div>
              <div className="flex justify-between items-center bg-slate-900 p-2.5 rounded-xl border border-slate-800">
                <span className="text-slate-400">Discipline Signal</span>
                <span className={`px-2 py-0.5 rounded font-bold text-[10px] ${signals.discipline_signal === "High" ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "bg-slate-800 text-slate-300"}`}>
                  {signals.discipline_signal || "CALCULATING"}
                </span>
              </div>
              <div className="flex justify-between items-center bg-slate-900 p-2.5 rounded-xl border border-slate-800">
                <span className="text-slate-400">Engagement Depth</span>
                <span className={`px-2 py-0.5 rounded font-bold text-[10px] ${signals.engagement_signal === "High" ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "bg-slate-800 text-slate-300"}`}>
                  {signals.engagement_signal || "CALCULATING"}
                </span>
              </div>
              <div className="flex justify-between items-center bg-slate-900 p-2.5 rounded-xl border border-slate-800">
                <span className="text-slate-400">Emotional Stability</span>
                <span className={`px-2 py-0.5 rounded font-bold text-[10px] ${signals.emotional_stability_signal === "High" ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "bg-slate-800 text-slate-300"}`}>
                  {signals.emotional_stability_signal || "CALCULATING"}
                </span>
              </div>
            </div>

            {/* BFI-44 MongoDB Survey Score Card */}
            <div className="pt-4 border-t border-slate-800 space-y-3">
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="text-slate-400 font-semibold">BFI-44 Psychometrics</span>
                {data?.questionnaire_response ? (
                  <span className="text-[9px] text-emerald-400 font-bold bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                    Saved in DB
                  </span>
                ) : (
                  <a href="/questionnaire" className="text-[10px] text-amber-400 underline font-bold">
                    Take Survey →
                  </a>
                )}
              </div>

              {data?.questionnaire_response?.scores ? (
                <div className="grid grid-cols-5 gap-1.5 font-mono text-[10px] text-center">
                  {[
                    { label: "O", val: data.questionnaire_response.scores.openness },
                    { label: "C", val: data.questionnaire_response.scores.conscientiousness },
                    { label: "E", val: data.questionnaire_response.scores.extraversion },
                    { label: "A", val: data.questionnaire_response.scores.agreeableness },
                    { label: "N", val: data.questionnaire_response.scores.neuroticism },
                  ].map((s) => (
                    <div key={s.label} className="bg-slate-900 p-2 rounded-lg border border-slate-800">
                      <span className="text-slate-500 block text-[9px]">{s.label}</span>
                      <span className="font-bold text-amber-300">{s.val}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] font-mono text-slate-500 italic">
                  Complete the 44-question inventory to correlate telemetry with ground truth scale scores.
                </p>
              )}
            </div>

            {/* Pipeline Actions */}
            <div className="pt-4 border-t border-slate-800 space-y-2">
              <a
                href="/export-training-dataset"
                download="training_dataset.csv"
                className="w-full py-2.5 px-3 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-emerald-400 text-xs font-mono font-bold uppercase tracking-wider flex items-center justify-center gap-2 transition-all"
              >
                <Download className="w-3.5 h-3.5" />
                Export Training Dataset (CSV)
              </a>

              <button
                onClick={async () => {
                  try {
                    triggerToast("⚡ Initiating Keras ML Model Pipeline...");
                    const res = await apiFetch("/api/ml/train", { method: "POST" });
                    const json = await res.json();
                    if (json.status === "success") {
                      triggerToast("✓ Model Trained Successfully! Saved to /ml");
                    } else {
                      triggerToast(`Training Notice: ${json.error || "Completed"}`);
                    }
                  } catch (e: any) {
                    triggerToast(`Training error: ${e.message}`);
                  }
                }}
                className="w-full py-2.5 px-3 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-300 text-xs font-mono font-bold uppercase tracking-wider flex items-center justify-center gap-2 transition-all cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                Train Keras ML Model
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, badge, color }: { icon: React.ReactNode; label: string; value: string; badge: string; color: string }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 p-6 space-y-3 shadow-xs hover:shadow-md transition-all duration-200">
      <div className="flex items-center justify-between">
        <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-100">
          {icon}
        </div>
        <span className="text-[10px] font-mono bg-slate-100 text-slate-600 px-2.5 py-0.5 rounded-full font-semibold">
          {badge}
        </span>
      </div>
      <div>
        <span className="text-[10px] uppercase font-mono tracking-wider text-slate-400 block font-bold">{label}</span>
        <span className="text-2xl font-bold text-slate-900 mt-0.5 block">{value}</span>
      </div>
    </div>
  );
}

