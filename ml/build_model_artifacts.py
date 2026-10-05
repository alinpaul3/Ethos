#!/usr/bin/env python3
"""
[DEVELOPMENT / BENCHMARK ONLY]
Synthetic baseline artifact builder for isolated local testing.

PRODUCTION SAFETY:
Production pipelines NEVER invoke this module.
Production models are trained strictly on real eligible users via ml/train_personality_model.py.
"""

import os
import sys
import joblib
import numpy as np

# Ensure ml is in path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dataset import generate_synthetic_samples, FEATURE_COLUMNS, TARGET_COLUMNS
from sklearn.preprocessing import StandardScaler
from sklearn.neural_network import MLPRegressor


def build_synthetic_benchmark_artifacts(output_dir: str = None):
    """
    Generates synthetic benchmark artifacts for development testing.
    Saves to explicit benchmark files (*_benchmark_synthetic.pkl) to prevent
    accidental overwrite of production real-data models.
    """
    if output_dir is None:
        output_dir = os.path.dirname(os.path.abspath(__file__))
    scaler_path = os.path.join(output_dir, "scaler_benchmark_synthetic.pkl")
    model_path = os.path.join(output_dir, "personality_model_benchmark_synthetic.pkl")

    print("[Benchmark Artifact Builder] Generating synthetic dataset baseline (DEMO ONLY)...")
    df = generate_synthetic_samples(num_samples=250, seed=42)
    X = df[FEATURE_COLUMNS].values
    Y = df[TARGET_COLUMNS].values

    print(f"[Benchmark Artifact Builder] Fitting StandardScaler on {X.shape[0]} synthetic samples...")
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    print("[Benchmark Artifact Builder] Training baseline MLPRegressor...")
    mlp = MLPRegressor(
        hidden_layer_sizes=(64, 32, 16),
        activation="relu",
        solver="adam",
        max_iter=200,
        batch_size=16,
        random_state=42
    )
    mlp.fit(X_scaled, Y)

    joblib.dump(scaler, scaler_path)
    joblib.dump(mlp, model_path)

    print(f"[Benchmark Artifact Builder] Saved synthetic scaler to: {scaler_path}")
    print(f"[Benchmark Artifact Builder] Saved synthetic model artifact to: {model_path}")
    return scaler_path, model_path


# Backward compatibility alias
build_and_save_artifacts = build_synthetic_benchmark_artifacts

if __name__ == "__main__":
    build_synthetic_benchmark_artifacts()

