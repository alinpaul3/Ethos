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
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [consentGiven, setConsentGiven] = useState<boolean | null>(null);

  useEffect(() => {
    const checkAuthAndConsent = async () => {
      try {
        const authRes = await apiFetch("/api/auth/me");
        const contentType = authRes.headers.get("content-type");
        
        if (authRes.ok && contentType && contentType.includes("application/json")) {
          const userData = await authRes.json();
          setUser(userData);
          
          try{
          const consentRes = await apiFetch(`/api/consent-status?user_id=${userData.user_id}`);
          const consentContentType = consentRes.headers.get("content-type");
          if (consentRes.ok && consentContentType && consentContentType.includes("application/json")) {
            const consentData = await consentRes.json();
            setConsentGiven(consentData.consent_given);
            }
          } catch (consentErr) {
            console.warn("Consent check error:", consentErr);
          }
        } else {
          setUser(null);
        }
      } catch (err) {
        setUser(null);
      } finally {
        setLoading(false);
      }
    };
    checkAuthAndConsent();
  }, []);

  
  useEffect(() => {
    if (user?.user_id) {
      const backendBaseUrl = API_BASE_URL || (window.location.hostname.includes("ethos-analysis.onrender.com") ? "https://ethos-i8i4.onrender.com" : window.location.origin);
      const serverUrl = `${backendBaseUrl.replace(/\/$/, "")}/events`;
      (window as any).ETHOS_API_BASE_URL = backendBaseUrl;

      // Broadcast linkage request to Chrome Extension content script
      window.postMessage({
        type: "ETHOS_CONNECT_REQUEST",
        user_id: user.user_id,
        server_url: serverUrl
      }, "*");
    }
  }, [user]);
  
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#FDFCFB]">
        <div className="font-serif italic text-lg animate-pulse">Syncing with platform cluster...</div>
      </div>
    );
  }

  const handleLogout = () => {
    setUser(null);
    setConsentGiven(null);
  };

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout user={user} onLogout={handleLogout} />}>
          <Route path="/" element={user ? <Navigate to="/dashboard" /> : <Navigate to="/login" />} />
          <Route path="/login" element={!user ? <LoginPage onAuth={setUser} /> : <Navigate to="/dashboard" />} />
          <Route path="/signup" element={!user ? <SignupPage onAuth={setUser} /> : <Navigate to="/dashboard" />} />
          
          {/* Protected Routes */}
          <Route path="/dashboard" element={user ? (consentGiven ? <Dashboard user={user} /> : <Navigate to="/consent" />) : <Navigate to="/login" />} />
          <Route path="/questionnaire" element={user ? <QuestionnairePage user={user} /> : <Navigate to="/login" />} />
          <Route path="/consent" element={user ? <ConsentPage user={user} onConsentChange={setConsentGiven} /> : <Navigate to="/login" />} />
          <Route path="/connect-extension" element={user ? (consentGiven ? <ExtensionConnectPage user={user} /> : <Navigate to="/consent" />) : <Navigate to="/login" />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
