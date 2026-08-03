import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { LoginPage } from "./pages/LoginPage";
import { SignupPage } from "./pages/SignupPage";
import { ConsentPage } from "./pages/ConsentPage";
import { ExtensionConnectPage } from "./pages/ExtensionConnectPage";
import { QuestionnairePage } from "./pages/QuestionnairePage";
import { Dashboard } from "./pages/Dashboard";
import { Layout } from "./components/Layout";
import { apiFetch, API_BASE_URL } from "./lib/api";

interface User {
  user_id: string;
  email: string;
}

export default function App() {
  const [user, setUser] = useState<User | null>(() => {
    try {
      const saved = localStorage.getItem("ethos_user");
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  const [consentGiven, setConsentGiven] = useState<boolean | null>(() => {
    try {
      const savedConsent = localStorage.getItem("ethos_consent_given");
      return savedConsent !== null ? JSON.parse(savedConsent) : null;
    } catch {
      return null;
    }
  });

  const [loading, setLoading] = useState<boolean>(() => {
    return !localStorage.getItem("ethos_user");
  });

  useEffect(() => {
    const checkAuthAndConsent = async () => {
      try {
        const authRes = await apiFetch("/api/auth/me");
        const contentType = authRes.headers.get("content-type");
        
        if (authRes.ok && contentType && contentType.includes("application/json")) {
          const userData = await authRes.json();
          const userObj = { user_id: userData.user_id, email: userData.email };
          setUser(userObj);
          localStorage.setItem("ethos_user", JSON.stringify(userObj));
          
          if (typeof userData.consent_given === "boolean") {
            setConsentGiven(userData.consent_given);
            localStorage.setItem("ethos_consent_given", JSON.stringify(userData.consent_given));
          } else {
            try {
              const consentRes = await apiFetch(`/api/consent-status?user_id=${userData.user_id}`);
              const consentContentType = consentRes.headers.get("content-type");
              if (consentRes.ok && consentContentType && consentContentType.includes("application/json")) {
                const consentData = await consentRes.json();
                setConsentGiven(consentData.consent_given);
                localStorage.setItem("ethos_consent_given", JSON.stringify(consentData.consent_given));
              }
            } catch (consentErr) {
              console.warn("Consent check error:", consentErr);
            }
          }
        } else {
          // Token invalid or unauthenticated
          if (localStorage.getItem("ethos_token") || localStorage.getItem("ethos_user")) {
            localStorage.removeItem("ethos_user");
            localStorage.removeItem("ethos_token");
            localStorage.removeItem("ethos_consent_given");
            setUser(null);
            setConsentGiven(null);
          }
        }
      } catch (err) {
        console.warn("Auth sync error:", err);
      } finally {
        setLoading(false);
      }
    };
    checkAuthAndConsent();
  }, []);

  const handleAuth = (userData: any, explicitConsent?: boolean) => {
    const userObj = { user_id: userData.user_id, email: userData.email };
    setUser(userObj);
    localStorage.setItem("ethos_user", JSON.stringify(userObj));
    if (userData.token) {
      localStorage.setItem("ethos_token", userData.token);
    }
    
    const isConsentGiven = typeof explicitConsent === "boolean" 
      ? explicitConsent 
      : (typeof userData.consent_given === "boolean" ? userData.consent_given : false);
      
    setConsentGiven(isConsentGiven);
    localStorage.setItem("ethos_consent_given", JSON.stringify(isConsentGiven));
  };

  const handleLogout = async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch (e) {
      console.warn("Logout request failed:", e);
    }
    localStorage.removeItem("ethos_user");
    localStorage.removeItem("ethos_token");
    localStorage.removeItem("ethos_consent_given");
    setUser(null);
    setConsentGiven(null);
  };

  useEffect(() => {
    if (user?.user_id) {
      const broadcastConnect = () => {
        const backendBaseUrl = API_BASE_URL || (window.location.hostname.includes("ethos-analysis.onrender.com") ? "https://ethos-i8i4.onrender.com" : window.location.origin);
        const serverUrl = `${backendBaseUrl.replace(/\/$/, "")}/events`;
        (window as any).ETHOS_API_BASE_URL = backendBaseUrl;

        // Broadcast linkage request to Chrome Extension content script
        window.postMessage({
          type: "ETHOS_CONNECT_REQUEST",
          user_id: user.user_id,
          server_url: serverUrl
        }, "*");
      };

      broadcastConnect();
      const interval = setInterval(broadcastConnect, 3000);
      return () => clearInterval(interval);
    }
  }, [user]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#FDFCFB]">
        <div className="font-serif italic text-lg animate-pulse">Syncing with platform cluster...</div>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout user={user} onLogout={handleLogout} />}>
          <Route path="/" element={user ? <Navigate to="/dashboard" /> : <Navigate to="/login" />} />
          <Route path="/login" element={!user ? <LoginPage onAuth={handleAuth} /> : <Navigate to="/dashboard" />} />
          <Route path="/signup" element={!user ? <SignupPage onAuth={handleAuth} /> : <Navigate to="/dashboard" />} />
          
          {/* Protected Routes */}
          <Route path="/dashboard" element={user ? (consentGiven ? <Dashboard user={user} /> : <Navigate to="/consent" />) : <Navigate to="/login" />} />
          <Route path="/questionnaire" element={user ? <QuestionnairePage user={user} /> : <Navigate to="/login" />} />
          <Route path="/consent" element={user ? <ConsentPage user={user} onConsentChange={(given) => { setConsentGiven(given); localStorage.setItem("ethos_consent_given", JSON.stringify(given)); }} /> : <Navigate to="/login" />} />
          <Route path="/connect-extension" element={user ? (consentGiven ? <ExtensionConnectPage user={user} /> : <Navigate to="/consent" />) : <Navigate to="/login" />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
