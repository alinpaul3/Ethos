import { useState, FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { UserPlus, ArrowRight } from "lucide-react";
import { motion } from "motion/react";

interface SignupPageProps {
  onAuth: (user: any) => void;
}

export function SignupPage({ onAuth }: SignupPageProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const navigate = useNavigate();

  const handleSignup = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        const text = await res.text();
        console.error("Non-JSON response:", text);
        throw new Error("Server returned non-JSON response. This usually indicates a routing issue or database connection failure.");
      }

      const data = await res.json();
      if (!res.ok) {
        const errorMsg = data.details 
          ? `${data.message} | Connection Error Details: ${data.details}`
          : (data.message || "Signup failed");
        throw new Error(errorMsg);
      }

      onAuth(data);
      navigate("/consent"); // Proceed to mandatory consent
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="max-w-md mx-auto">
      <motion.div 
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="editorial-card"
      >
        <div className="mb-12">
          <span className="editorial-label">Subject Assignment</span>
          <h1 className="editorial-heading">Provision New Node</h1>
        </div>

        <form onSubmit={handleSignup} className="space-y-8">
          <div className="space-y-2">
            <label className="editorial-label opacity-60">Identity Descriptor (Email)</label>
            <input 
              type="email" 
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border-b border-[#1a1a1a]/20 py-3 focus:outline-none focus:border-[#1a1a1a] transition-colors bg-transparent font-serif italic text-sm"
              placeholder="user@ethos.io"
            />
          </div>

          <div className="space-y-2">
            <label className="editorial-label opacity-60">Security Key (Password)</label>
            <input 
              type="password" 
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border-b border-[#1a1a1a]/20 py-3 focus:outline-none focus:border-[#1a1a1a] transition-colors bg-transparent font-serif italic text-sm"
              placeholder="Min. 8 characters"
            />
          </div>

          <div className="space-y-2">
            <label className="editorial-label opacity-60">Key Confirmation</label>
            <input 
              type="password" 
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full border-b border-[#1a1a1a]/20 py-3 focus:outline-none focus:border-[#1a1a1a] transition-colors bg-transparent font-serif italic text-sm"
              placeholder="Re-enter password"
            />
          </div>

          {error && (
            <div className="text-[10px] uppercase tracking-widest text-orange-600 bg-orange-50 p-3 italic border border-orange-100">
              Allocation Error: {error}
            </div>
          )}

          <button 
            type="submit"
            className="w-full editorial-btn-primary flex items-center justify-center gap-3 py-4"
          >
            Provision Account <UserPlus className="w-4 h-4" />
          </button>
        </form>

        <div className="mt-12 pt-8 border-t border-[#1a1a1a]/5 text-center">
          <p className="text-[10px] uppercase tracking-widest text-[#1a1a1a]/40 font-bold">
            Already Assigned? <Link to="/login" className="text-[#1a1a1a] underline decoration-1 underline-offset-4 hover:opacity-70 transition-opacity">Return to Access</Link>
          </p>
        </div>
      </motion.div>
    </div>
  );
}
