import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { LoginPage } from "./pages/LoginPage";
import { SignupPage } from "./pages/SignupPage";
import { ConsentPage } from "./pages/ConsentPage";
import { ExtensionConnectPage } from "./pages/ExtensionConnectPage";
import { QuestionnairePage } from "./pages/QuestionnairePage";
import { Dashboard } from "./pages/Dashboard";
import { Layout } from "./components/Layout";

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
        const authRes = await fetch("/api/auth/me");
        const contentType = authRes.headers.get("content-type");
        
        if (authRes.ok && contentType && contentType.includes("application/json")) {
          const userData = await authRes.json();
          setUser(userData);
          
          const consentRes = await fetch(`/api/consent-status?user_id=${userData.user_id}`);
          const consentContentType = consentRes.headers.get("content-type");
          if (consentRes.ok && consentContentType && consentContentType.includes("application/json")) {
            const consentData = await consentRes.json();
            setConsentGiven(consentData.consent_given);
          }
        } else {
          console.warn("Initial auth failed or returned non-JSON:", authRes.status);
          setUser(null);
        }
      } catch (err) {
        console.error("Auth check error:", err);
        setUser(null);
      } finally {
        setLoading(false);
      }
    };
    checkAuthAndConsent();
  }, []);

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
        <Route element={<Layout user={user} />}>
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
