import os
import sys
import joblib
import numpy as np

# Ensure ml is in path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dataset import generate_synthetic_samples, FEATURE_COLUMNS, TARGET_COLUMNS
from sklearn.preprocessing import StandardScaler
from sklearn.neural_network import MLPRegressor

def build_and_save_artifacts():
    output_dir = os.path.dirname(os.path.abspath(__file__))
    scaler_path = os.path.join(output_dir, "scaler.pkl")
    model_path = os.path.join(output_dir, "personality_model.pkl")

    print("[ML Artifact Builder] Generating supervised dataset baseline...")
    df = generate_synthetic_samples(num_samples=250, seed=42)
    X = df[FEATURE_COLUMNS].values
    Y = df[TARGET_COLUMNS].values

    print(f"[ML Artifact Builder] Fitting StandardScaler on {X.shape[0]} samples...")
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    print("[ML Artifact Builder] Training MLPRegressor (128, 64, 32)...")
    mlp = MLPRegressor(
        hidden_layer_sizes=(128, 64, 32),
        activation="relu",
        solver="adam",
        max_iter=200,
        batch_size=16,
        random_state=42
    )
    mlp.fit(X_scaled, Y)

    joblib.dump(scaler, scaler_path)
    joblib.dump(mlp, model_path)

    print(f"[ML Artifact Builder] Saved scaler to: {scaler_path}")
    print(f"[ML Artifact Builder] Saved model artifact to: {model_path}")
    return scaler_path, model_path

if __name__ == "__main__":
    build_and_save_artifacts()
