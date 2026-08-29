#!/usr/bin/env python3
"""
Dataset loader for BFI-44 OCEAN Personality Model.

REAL USERS ARE THE ONLY PRODUCTION TRAINING DATA.
Silent synthetic-data fallback has been completely removed from the production path.
"""

import os
import numpy as np
import pandas as pd
from typing import Tuple, List

FEATURE_COLUMNS = [
    "avg_session_duration",
    "late_night_ratio",
    "topic_diversity",
    "learning_ratio",
    "activity_consistency"
]

TARGET_COLUMNS = [
    "openness",
    "conscientiousness",
    "extraversion",
    "agreeableness",
    "neuroticism"
]


def load_and_prepare_data(
    csv_path: str,
    min_samples_required: int = 2
) -> Tuple[pd.DataFrame, np.ndarray, np.ndarray, List[str], List[str]]:
    """
    Loads real training dataset from CSV snapshot, validates completeness,
    and returns feature matrix X and target matrix Y.

    PRODUCTION SAFETY RULE:
    Zero synthetic samples are added. If there are fewer than min_samples_required
    real eligible users, this function fails clearly with an informative ValueError.
    """
    if not os.path.exists(csv_path):
        # Try resolving relative to script directory
        script_dir = os.path.dirname(os.path.abspath(__file__))
        alt_path = os.path.join(script_dir, os.path.basename(csv_path))
        if os.path.exists(alt_path):
            csv_path = alt_path
        else:
            raise FileNotFoundError(
                f"[Dataset Error] Training dataset snapshot not found at: {csv_path}. "
                "Please run 'python ml/export_real_dataset.py' to generate it from MongoDB."
            )

    print(f"[Dataset] Loading real-user training dataset from: {csv_path}")
    df = pd.read_csv(csv_path)

    # Check for empty dataframe
    if df.empty:
        raise ValueError(
            f"[Dataset Error] Insufficient real labelled users for training. Found 0 eligible users in {csv_path}."
        )

    # Validate required columns
    required_cols = ["user_id"] + FEATURE_COLUMNS + TARGET_COLUMNS
    missing_cols = [c for c in required_cols if c not in df.columns]
    if missing_cols:
        raise ValueError(f"[Dataset Error] Missing required columns in dataset: {missing_cols}")

    # Convert numeric columns and validate
    for col in FEATURE_COLUMNS + TARGET_COLUMNS:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    # Drop any rows with NaN/null in features or targets (no silent median imputation of invalid users)
    clean_df = df.dropna(subset=FEATURE_COLUMNS + TARGET_COLUMNS, how="any").copy()

    # Deduplicate by user_id
    clean_df = clean_df.drop_duplicates(subset=["user_id"], keep="last").reset_index(drop=True)

    sample_count = len(clean_df)
    if sample_count < min_samples_required:
        raise ValueError(
            f"[Dataset Error] Insufficient real labelled users for training. "
            f"Found {sample_count} eligible users (minimum required: {min_samples_required})."
        )

    X = clean_df[FEATURE_COLUMNS].values.astype(np.float64)
    Y = clean_df[TARGET_COLUMNS].values.astype(np.float64)

    print(f"[Dataset] Data preparation complete. Real eligible users: {sample_count}. "
          f"Features shape: {X.shape}, Targets shape: {Y.shape} (Synthetic: FALSE)")

    return clean_df, X, Y, FEATURE_COLUMNS, TARGET_COLUMNS


def generate_synthetic_samples(num_samples: int = 250, seed: int = 42) -> pd.DataFrame:
    """
    [DEVELOPMENT / BENCHMARK ONLY]
    Generates synthetic user dataset for isolated testing and baseline performance comparisons.
    This function is NEVER called automatically by production training or inference.
    """
    np.random.seed(seed)
    
    avg_session = np.random.gamma(shape=2.0, scale=12.0, size=num_samples)
    late_night = np.random.beta(a=1.5, b=4.0, size=num_samples)
    diversity = np.random.beta(a=3.0, b=2.0, size=num_samples)
    learning = np.random.beta(a=2.0, b=3.0, size=num_samples)
    consistency = np.random.beta(a=4.0, b=2.0, size=num_samples)
    
    openness = 1.8 + 2.2 * diversity + 1.2 * learning + np.random.normal(0, 0.25, num_samples)
    conscientiousness = 1.5 + 2.5 * consistency + 0.8 * learning - 0.8 * late_night + np.random.normal(0, 0.25, num_samples)
    extraversion = 1.8 + 1.8 * (avg_session / 60.0) + 1.2 * diversity + np.random.normal(0, 0.3, num_samples)
    agreeableness = 2.0 + 1.8 * consistency + 1.0 * (1 - late_night) + np.random.normal(0, 0.25, num_samples)
    neuroticism = 1.5 + 2.2 * late_night - 1.2 * consistency + 0.8 * (avg_session / 60.0) + np.random.normal(0, 0.3, num_samples)
    
    df = pd.DataFrame({
        "user_id": [f"user_syn_{i+1:04d}" for i in range(num_samples)],
        "avg_session_duration": np.round(avg_session, 2),
        "late_night_ratio": np.round(late_night, 3),
        "topic_diversity": np.round(diversity, 3),
        "learning_ratio": np.round(learning, 3),
        "activity_consistency": np.round(consistency, 3),
        "openness": np.round(np.clip(openness, 1.0, 5.0), 2),
        "conscientiousness": np.round(np.clip(conscientiousness, 1.0, 5.0), 2),
        "extraversion": np.round(np.clip(extraversion, 1.0, 5.0), 2),
        "agreeableness": np.round(np.clip(agreeableness, 1.0, 5.0), 2),
        "neuroticism": np.round(np.clip(neuroticism, 1.0, 5.0), 2),
    })
    
    return df
