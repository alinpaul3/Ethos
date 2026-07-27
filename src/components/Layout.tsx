import { ReactNode, useState, useEffect } from "react";
import { Outlet, Link, useNavigate, useLocation } from "react-router-dom";
import { LogOut, LayoutDashboard, ShieldCheck, Chrome, FileText, Cpu, Activity, Sparkles, Server, CheckCircle2 } from "lucide-react";

interface LayoutProps {
  user: { user_id: string; email: string } | null;
}

export function Layout({ user }: LayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [time, setTime] = useState(new Date().toLocaleTimeString());

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date().toLocaleTimeString()), 1000);
    return () => clearInterval(timer);
  }, []);

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      window.location.href = "/login";
    } catch (err) {
      console.error(err);
    }
  };

  const navItems = [
    { path: "/dashboard", label: "Telemetry Index", icon: <LayoutDashboard className="w-4 h-4" />, num: "01" },
    { path: "/questionnaire", label: "BFI-44 Survey", icon: <FileText className="w-4 h-4" />, num: "02" },
    { path: "/consent", label: "Data Directives", icon: <ShieldCheck className="w-4 h-4" />, num: "03" },
    { path: "/connect-extension", label: "Node Linkage", icon: <Chrome className="w-4 h-4" />, num: "04" },
  ];

  return (
    <div className="bg-slate-900 text-slate-100 min-h-screen flex font-sans overflow-x-hidden selection:bg-amber-500/30 selection:text-amber-200">
      {/* High-Tech Obsidian Sidebar */}
      <aside className="w-72 bg-slate-950 border-r border-slate-800/80 p-6 flex flex-col shrink-0 min-h-screen shadow-2xl relative z-20">
        {/* Brand Identity */}
        <div className="mb-10 pt-2">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-amber-500 via-orange-500 to-amber-300 flex items-center justify-center shadow-lg shadow-amber-500/20 text-slate-950">
              <Cpu className="w-5 h-5 font-bold" />
            </div>
            <div>
              <span className="text-[9px] uppercase tracking-[0.25em] font-mono text-amber-400 font-bold block">Telemetry Engine</span>
              <h1 className="text-xl font-bold text-white tracking-tight">Ethos Analytics</h1>
            </div>
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900/90 border border-slate-800 text-[10px] font-mono text-slate-400">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span className="text-slate-300 font-medium">OCEAN Pipeline Active</span>
          </div>
        </div>

        {/* Navigation */}
        {user && (
          <nav className="space-y-2 flex-grow">
            <div className="text-[10px] uppercase tracking-widest font-mono text-slate-500 px-3 mb-2 font-semibold">
              System Modules
            </div>
            {navItems.map((item) => {
              const isActive = location.pathname === item.path;
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`flex items-center gap-3.5 px-3.5 py-3 rounded-xl transition-all duration-200 group relative ${
                    isActive
                      ? "bg-slate-800/90 text-white border border-slate-700/80 shadow-md shadow-slate-950/50"
                      : "text-slate-400 hover:text-slate-200 hover:bg-slate-900/60"
                  }`}
                >
                  {isActive && (
                    <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-gradient-to-b from-amber-400 to-orange-500 rounded-r-full shadow-sm shadow-amber-500/50" />
                  )}
                  <div className={`p-2 rounded-lg ${isActive ? "bg-amber-500/10 text-amber-400 border border-amber-500/20" : "bg-slate-900 text-slate-500 group-hover:text-slate-300"}`}>
                    {item.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-semibold block tracking-wide truncate">{item.label}</span>
                    <span className="text-[9px] text-slate-500 font-mono block">MODULE {item.num}</span>
                  </div>
                  <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${isActive ? "text-amber-400 bg-amber-400/10" : "text-slate-600"}`}>
                    {item.num}
                  </span>
                </Link>
              );
            })}
          </nav>
        )}

        {/* Sidebar Footer */}
        <div className="pt-6 border-t border-slate-800/80 space-y-4">
          <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2">
            <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
              <span className="flex items-center gap-1.5 text-slate-300">
                <Server className="w-3 h-3 text-cyan-400" /> Storage Status
              </span>
              <span className="text-emerald-400 font-bold">ONLINE</span>
            </div>
            <p className="text-[10px] font-mono text-slate-500 truncate">
              {user ? `SUBJ: ${user.user_id.slice(0, 12)}...` : "AUTH_NULL"}
            </p>
          </div>

          {user && (
            <button
              onClick={handleLogout}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl bg-slate-900 hover:bg-rose-950/40 border border-slate-800 hover:border-rose-800/50 text-slate-400 hover:text-rose-400 text-xs font-mono uppercase tracking-wider transition-all cursor-pointer group"
            >
              <LogOut className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
              Terminate Session
            </button>
          )}
        </div>
      </aside>

      {/* Main Content Workspace */}
      <div className="flex-1 flex flex-col min-w-0 bg-slate-50 text-slate-900">
        {/* Header Bar */}
        <header className="h-16 border-b border-slate-200/80 bg-white/90 backdrop-blur-md flex items-center justify-between px-8 sticky top-0 z-30 shadow-xs">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-slate-100 border border-slate-200 text-xs text-slate-700 font-medium">
              <span className={`w-2 h-2 rounded-full ${user ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" : "bg-amber-500"}`}></span>
              <span>{user ? "Node Connected" : "Authentication Required"}</span>
            </div>
            <span className="text-slate-300">•</span>
            <span className="text-xs font-mono text-slate-500 hidden sm:inline-block">
              SYS TIME: <span className="text-slate-800 font-semibold">{time}</span>
            </span>
          </div>

          <div className="flex items-center gap-4">
            {user && (
              <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-amber-50 border border-amber-200/80 text-amber-900 text-xs font-mono">
                <Sparkles className="w-3.5 h-3.5 text-amber-600" />
                <span className="font-semibold">{user.email}</span>
              </div>
            )}
          </div>
        </header>

        {/* Dynamic Outlet Area */}
        <main className="flex-1 overflow-auto p-8 lg:p-10">
          <div className="max-w-7xl mx-auto">
            <Outlet />
          </div>
        </main>

        {/* Footer */}
        <footer className="h-12 border-t border-slate-200 bg-white px-8 flex items-center justify-between text-[11px] font-mono text-slate-400">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
            <span>Ethos Privacy Directive v1.2</span>
          </div>
          <div className="hidden md:flex items-center gap-6">
            <span>OCEAN ML Engine: Ready</span>
            <span>TLS 1.3 Encrypted</span>
          </div>
          <div>
            <span>ID: {user ? user.user_id.slice(-6).toUpperCase() : "ANONYMOUS"}</span>
          </div>
        </footer>
      </div>
    </div>
  );
}

