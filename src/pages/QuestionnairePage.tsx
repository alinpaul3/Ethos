import { useState, useEffect } from "react";
import { CheckCircle2, AlertCircle, ArrowRight } from "lucide-react";
import { BFI44_QUESTIONS } from "../data/bfi44";
import { apiFetch } from "../lib/api";

interface QuestionnairePageProps {
  user: { user_id: string; email: string };
}

export function QuestionnairePage({ user }: QuestionnairePageProps) {
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successResult, setSuccessResult] = useState<any | null>(null);

  // Fetch existing submission if available
  useEffect(() => {
    const fetchExisting = async () => {
      try {
        setLoading(true);
        const res = await apiFetch(`/api/questionnaire/response?user_id=${user.user_id}`);
        if (res.ok) {
          const json = await res.json();
          if (json.data && Array.isArray(json.data.responses)) {
            setSuccessResult(json.data);
            const initialMap: Record<number, number> = {};
            json.data.responses.forEach((r: any) => {
              initialMap[r.question_id] = r.score;
            });
            setAnswers(initialMap);
          }
        }
      } catch (err) {
        console.warn("No prior questionnaire found:", err);
      } finally {
        setLoading(false);
      }
    };
    fetchExisting();
  }, [user.user_id]);

  const handleSelectScore = (questionId: number, score: number) => {
    setAnswers((prev) => ({
      ...prev,
      [questionId]: score,
    }));
    setError(null);
  };

  const answeredCount = Object.keys(answers).length;
  const progressPercent = Math.round((answeredCount / 44) * 100);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validate all 44 questions answered
    const unanswered: number[] = [];
    BFI44_QUESTIONS.forEach((q) => {
      if (!answers[q.id] || answers[q.id] < 1 || answers[q.id] > 5) {
        unanswered.push(q.id);
      }
    });

    if (unanswered.length > 0) {
      setError(`Please complete all questions before submitting (${unanswered.length} questions remaining: ${unanswered.slice(0, 5).join(", ")}${unanswered.length > 5 ? "..." : ""})`);
      return;
    }

    try {
      setSubmitting(true);
      const payloadResponses = BFI44_QUESTIONS.map((q) => ({
        question_id: q.id,
        score: answers[q.id],
      }));

      const res = await apiFetch("/questionnaire/submit", {
        method: "POST",
        body: JSON.stringify({
          user_id: user.user_id,
          questionnaire_type: "BFI-44",
          responses: payloadResponses,
          consent_version: "v1.0",
        }),
      });

      const data = await res.json();

      if (!res.ok || data.status === "failed") {
        throw new Error(data.error || "Failed to submit questionnaire");
      }

      setSuccessResult(data);
    } catch (err: any) {
      setError(err.message || "Network error submitting questionnaire responses");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="py-12 flex items-center justify-center">
        <p className="text-sm font-medium animate-pulse text-slate-500">Loading BFI-44 Questionnaire...</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-10">
      {/* Header */}
      <div className="border-b border-[#1a1a1a]/10 pb-6 flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <span className="editorial-label">Standard Assessment • 44 Items</span>
          <h1 className="editorial-title text-3xl">BFI-44 Personality Inventory</h1>
          <p className="text-xs text-[#1a1a1a]/60 mt-1 max-w-xl">
            The Big Five Inventory (BFI-44) measures core psychological dimensions: Openness, Conscientiousness, Extraversion, Agreeableness, and Neuroticism.
          </p>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="bg-[#f0eee9] p-4 border border-[#1a1a1a]/10 space-y-2">
        <div className="flex justify-between text-xs font-mono">
          <span className="font-bold">Completion Progress</span>
          <span>
            {answeredCount} / 44 questions answered ({progressPercent}%)
          </span>
        </div>
        <div className="w-full bg-[#1a1a1a]/10 h-2 rounded-full overflow-hidden">
          <div
            className="bg-[#1a1a1a] h-full transition-all duration-300"
            style={{ width: `${progressPercent}%` }}
          ></div>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="p-4 bg-rose-50 border border-rose-200 text-rose-800 text-xs font-mono flex items-center gap-3">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Success Banner if already submitted */}
      {successResult && (
        <div className="bg-[#1a1a1a] text-white p-6 space-y-4 shadow-md">
          <div className="flex items-center justify-between border-b border-white/20 pb-3">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-emerald-400" />
              <span className="font-mono text-xs uppercase tracking-widest font-bold text-emerald-400">
                BFI-44 Assessment Saved in MongoDB
              </span>
            </div>
            <span className="text-[10px] font-mono text-white/50">
              Completed: {new Date(successResult.completed_at || successResult.data?.completed_at).toLocaleString()}
            </span>
          </div>

          <p className="text-xs text-white/80">
            Your answers have been saved and calculated into standard Big Five scale scores:
          </p>

          {/* Scores breakdown */}
          {(successResult.scores || successResult.data?.scores) && (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 pt-2">
              {[
                { label: "Openness", val: (successResult.scores || successResult.data?.scores).openness },
                { label: "Conscientiousness", val: (successResult.scores || successResult.data?.scores).conscientiousness },
                { label: "Extraversion", val: (successResult.scores || successResult.data?.scores).extraversion },
                { label: "Agreeableness", val: (successResult.scores || successResult.data?.scores).agreeableness },
                { label: "Neuroticism", val: (successResult.scores || successResult.data?.scores).neuroticism },
              ].map((item) => (
                <div key={item.label} className="bg-white/5 p-3 border border-white/10 rounded space-y-1">
                  <span className="text-[10px] uppercase font-mono text-white/50 block">{item.label}</span>
                  <span className="text-xl font-bold font-serif text-white">{item.val} / 5.0</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Questionnaire Form */}
      <form onSubmit={handleSubmit} className="space-y-8">
        <div className="space-y-6">
          <div className="text-xs font-mono uppercase tracking-wider text-[#1a1a1a]/50 mb-2">
            Statements: "I see myself as someone who..." (Scale: 1 = Strongly Disagree to 5 = Strongly Agree)
          </div>

          <div className="space-y-4">
            {BFI44_QUESTIONS.map((q) => {
              const currentVal = answers[q.id];
              return (
                <div
                  key={q.id}
                  className={`p-4 border transition-colors ${
                    currentVal ? "border-[#1a1a1a]/30 bg-white" : "border-[#1a1a1a]/10 bg-[#faf9f6]"
                  }`}
                >
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="flex items-start gap-3">
                      <span className="font-mono text-xs text-[#1a1a1a]/40 w-6 shrink-0">{q.id}.</span>
                      <span className="text-sm font-medium">{q.text}</span>
                    </div>

                    {/* 1..5 Rating buttons */}
                    <div className="flex items-center gap-1 shrink-0">
                      {[1, 2, 3, 4, 5].map((s) => {
                        const isSelected = currentVal === s;
                        const labels = ["Strongly Disagree", "Disagree", "Neutral", "Agree", "Strongly Agree"];
                        return (
                          <button
                            key={s}
                            type="button"
                            onClick={() => handleSelectScore(q.id, s)}
                            title={`${s}: ${labels[s - 1]}`}
                            className={`w-10 h-10 border font-mono text-xs font-bold transition-all flex flex-col items-center justify-center cursor-pointer ${
                              isSelected
                                ? "bg-[#1a1a1a] text-white border-[#1a1a1a] shadow-sm scale-105"
                                : "bg-white text-[#1a1a1a] border-[#1a1a1a]/20 hover:border-[#1a1a1a]"
                            }`}
                          >
                            <span>{s}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Submit Section */}
        <div className="pt-6 border-t border-[#1a1a1a]/10 flex items-center justify-between">
          <div className="text-xs text-[#1a1a1a]/60 font-mono">
            {answeredCount === 44 ? (
              <span className="text-emerald-700 font-bold flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4" /> Ready to submit (44/44 answered)
              </span>
            ) : (
              <span>{44 - answeredCount} items remaining</span>
            )}
          </div>

          <button
            type="submit"
            disabled={submitting || answeredCount < 44}
            className={`px-8 py-3 font-mono text-xs uppercase tracking-widest font-bold flex items-center gap-2 cursor-pointer transition-all ${
              answeredCount === 44
                ? "bg-[#1a1a1a] text-white hover:bg-black shadow-md"
                : "bg-stone-300 text-stone-500 cursor-not-allowed"
            }`}
          >
            {submitting ? "Storing in MongoDB..." : "Submit BFI-44 Responses"}
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </form>
    </div>
  );
}
