import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_model_artifacts import build_and_save_artifacts

if __name__ == "__main__":
    print("Generating baseline model artifacts in ./ml/...")
    scaler_p, model_p = build_and_save_artifacts()
    print("Verification complete.")
