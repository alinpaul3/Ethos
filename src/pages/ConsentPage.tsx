import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Check, X } from "lucide-react";
import { motion } from "motion/react";
import { apiFetch } from "../lib/api";

interface ConsentPageProps {
  user: { user_id: string; email: string };
  onConsentChange?: (given: boolean) => void;
}

export function ConsentPage({ user, onConsentChange }: ConsentPageProps) {
  const [loading, setLoading] = useState(true);
  const [consentGiven, setConsentGiven] = useState<boolean | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const checkConsent = async () => {
      try {
        const res = await apiFetch(`/api/consent-status?user_id=${user.user_id}`);
        if (res.ok) {
          const contentType = res.headers.get("content-type");
          if (contentType && contentType.includes("application/json")) {
            const data = await res.json();
            setConsentGiven(data.consent_given);
          }
        }
      } catch (err) {
        console.error("Failed to fetch consent status", err);
      } finally {
        setLoading(false);
      }
    };
    checkConsent();
  }, [user.user_id]);

  const handleConsent = async (given: boolean) => {
    try {
      const res = await apiFetch("/api/consent", {
        method: "POST",
        body: JSON.stringify({ user_id: user.user_id, consent_given: given }),
      });
      
      if (res.ok) {
        setConsentGiven(given);
        localStorage.setItem("ethos_consent_given", JSON.stringify(given));
        onConsentChange?.(given);
        if (given) {
          navigate("/connect-extension");
        }
      }
    } catch (err) {
      console.error(err);
    }
  };

  if (loading) return null;

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex flex-col md:flex-row gap-12">
        {/* Consent Form Section */}
        <section className="flex-1">
          <h2 className="text-4xl font-serif italic mb-8">Behavioral Data Consent</h2>
          
          <div className="space-y-10 mb-12">
            <div>
              <span className="editorial-label text-orange-600">Data To Be Collected</span>
              <ul className="space-y-3 border-l border-orange-200 pl-4 font-serif italic text-sm">
                <li>Page titles & URLs from selected platforms</li>
                <li>Precise timestamps of navigation events</li>
                <li>Dwell time and session durations</li>
                <li>Selected platform metadata (YouTube, Reddit)</li>
              </ul>
            </div>

            <div>
              <span className="editorial-label">Explicitly Excluded</span>
              <ul className="space-y-3 border-l border-[#1a1a1a]/10 pl-4 text-sm text-[#1a1a1a]/60">
                <li>Passwords & Account Credentials</li>
                <li>Private Direct Messages</li>
                <li>Local Files & Private Assets</li>
              </ul>
            </div>

            <div className="bg-[#F5F2EF] p-6 border border-[#1a1a1a]/5">
              <span className="editorial-label">Research Purpose</span>
              <p className="text-[12px] font-serif italic leading-relaxed text-stone-600">
                Data is processed to estimate behavioral patterns and OCEAN personality tendencies. 
                Interpretations are non-diagnostic and for research-oriented behavioral analysis only.
              </p>
            </div>
          </div>

          <div className="flex gap-4">
            <button 
              onClick={() => handleConsent(true)}
              disabled={consentGiven === true}
              className="editorial-btn-primary"
            >
              Accept & Proceed
            </button>
            <button 
              onClick={() => handleConsent(false)}
              disabled={consentGiven === false}
              className="editorial-btn-secondary"
            >
              Decline
            </button>
          </div>
        </section>

        {/* Sidebar Status */}
        <aside className="w-full md:w-1/3 flex flex-col pt-12">
          <div className="bg-[#F5F2EF] p-8 border border-[#1a1a1a]/5 space-y-6">
            <div>
              <span className="editorial-label">Subject ID</span>
              <code className="text-[10px] font-mono block break-all opacity-60">
                {user.user_id}
              </code>
            </div>
            <div>
              <span className="editorial-label">Directive Status</span>
              <div className={`font-serif italic text-sm ${consentGiven ? "text-green-600" : "text-orange-600"}`}>
                {consentGiven === true ? "Consent Verified" : consentGiven === false ? "Consent Withdrawn" : "Awaiting Authorization"}
              </div>
            </div>
            
            <div className="pt-6 border-t border-[#1a1a1a]/10">
              <span className="text-[9px] uppercase tracking-tighter block text-[#1a1a1a]/40 mb-1">Authorization Log</span>
              <code className="text-[9px] font-mono block opacity-60 leading-tight">
                {consentGiven !== null ? `POST /consent ... 200 OK` : `GET /consent-status ... 404`}
              </code>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
