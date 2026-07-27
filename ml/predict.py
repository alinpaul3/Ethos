#!/usr/bin/env python3
"""
Inference script for BFI-44 OCEAN Personality Model.
Loads saved model and scaler.pkl to predict OCEAN traits from behavioral features.
"""

import os
import sys
import json
import joblib
import numpy as np

TARGET_NAMES = ["openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism"]

def predict_personality(features_dict, model_dir="/ml"):
    """
    Predicts OCEAN personality traits given behavioral feature input dict.
    Example input:
    {
        "avg_session_duration": 25.5,
        "late_night_ratio": 0.15,
        "topic_diversity": 0.65,
        "learning_ratio": 0.40,
        "activity_consistency": 0.80
    }
    """
    scaler_path = os.path.join(model_dir, "scaler.pkl")
    keras_model_path = os.path.join(model_dir, "personality_model.keras")
    pkl_model_path = os.path.join(model_dir, "personality_model.pkl")

    if not os.path.exists(scaler_path):
        raise FileNotFoundError(f"Scaler file not found at {scaler_path}. Please train the model first.")

    scaler = joblib.load(scaler_path)

    # Format input array in strict feature order
    feature_vector = np.array([[
        float(features_dict.get("avg_session_duration", 0)),
        float(features_dict.get("late_night_ratio", 0)),
        float(features_dict.get("topic_diversity", 0)),
        float(features_dict.get("learning_ratio", 0)),
        float(features_dict.get("activity_consistency", 0))
    ]])

    X_scaled = scaler.transform(feature_vector)

    # Load model (TensorFlow Keras or Joblib PKL)
    if os.path.exists(keras_model_path):
        import tensorflow as tf
        model = tf.keras.models.load_model(keras_model_path)
        predictions = model.predict(X_scaled)[0]
    elif os.path.exists(pkl_model_path):
        model = joblib.load(pkl_model_path)
        predictions = model.predict(X_scaled)[0]
    else:
        raise FileNotFoundError(f"No trained model found at {keras_model_path} or {pkl_model_path}.")

    # Clip predictions to standard BFI-44 range [1.0, 5.0]
    result = {}
    for name, raw_val in zip(TARGET_NAMES, predictions):
        score = float(np.round(np.clip(raw_val, 1.0, 5.0), 2))
        result[name] = score

    return result

if __name__ == "__main__":
    if len(sys.argv) > 1:
        try:
            input_data = json.loads(sys.argv[1])
            res = predict_personality(input_data)
            print(json.dumps(res))
        except Exception as e:
            print(json.dumps({"error": str(e)}))
    else:
        sample_features = {
            "avg_session_duration": 35.0,
            "late_night_ratio": 0.20,
            "topic_diversity": 0.75,
            "learning_ratio": 0.50,
            "activity_consistency": 0.85
        }
        res = predict_personality(sample_features)
        print("[Sample Prediction Result]:")
        print(json.dumps(res, indent=2))
