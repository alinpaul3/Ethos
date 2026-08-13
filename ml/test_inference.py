import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_model_artifacts import build_and_save_artifacts
from predict import predict_personality

# 1. Build artifacts directly
scaler_path, model_path = build_and_save_artifacts()
print(f"[Artifact Test] Verified artifact creation at: {scaler_path} and {model_path}")

# 2. Test predict_personality
sample_input = {
    "avg_session_duration": 25.0,
    "late_night_ratio": 0.15,
    "topic_diversity": 0.65,
    "learning_ratio": 0.40,
    "activity_consistency": 0.80
}

result = predict_personality(sample_input, model_dir=os.path.dirname(os.path.abspath(__file__)))
print("[Inference Output Verification]:", result)

assert result.get("prediction_method") == "ml", "prediction_method must be 'ml'"
assert "scores" in result, "Result must contain scores dict"
assert len(result["scores"]) == 5, "Must predict 5 OCEAN traits"
print("[Inference Test] INFERENCE VERIFICATION SUCCESSFUL!")
