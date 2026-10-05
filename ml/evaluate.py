#!/usr/bin/env python3
"""
Evaluation and Metrics Module for BFI-44 OCEAN Personality Model.

Reports standard regression metrics:
- Mean Absolute Error (MAE)
- Root Mean Squared Error (RMSE)
- Mean Squared Error (MSE)
- Coefficient of Determination (R² Score)
- Psychometric Tolerance Accuracy (within ±0.5 points)
"""

import os
import sys
import json
import numpy as np
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from typing import Dict, List, Any, Optional


def print_evaluation_table(results: Dict[str, Any], title: str = "REAL-DATA MODEL EVALUATION & CROSS-VALIDATION METRICS"):
    """
    Prints a formatted evaluation table from an evaluation metrics dictionary.
    """
    print("\n" + "=" * 108)
    print(f"       {title}")
    print("=" * 108)
    print(f"{'Trait':<18} | {'MAE':<8} | {'RMSE':<8} | {'MSE':<8} | {'R² Score':<9} | {'Tolerance (±0.5)':<18} | {'Scale Accuracy':<14}")
    print("-" * 108)

    for name, metrics in results.items():
        if name == "overall_average":
            continue
        mae = metrics.get("mae", 0.0)
        rmse = metrics.get("rmse", np.sqrt(metrics.get("mse", 0.0)))
        mse = metrics.get("mse", 0.0)
        r2 = metrics.get("r2", 0.0)
        tol_acc = metrics.get("tolerance_accuracy_pct", 0.0)
        scale_acc = metrics.get("normalized_scale_accuracy_pct", (1.0 - (mae / 4.0)) * 100.0)
        print(f"{name.capitalize():<18} | {mae:<8.4f} | {rmse:<8.4f} | {mse:<8.4f} | {r2:<9.4f} | {tol_acc:>16.2f}% | {scale_acc:>12.2f}%")

    if "overall_average" in results:
        avg = results["overall_average"]
        avg_mae = avg.get("mae", 0.0)
        avg_rmse = avg.get("rmse", np.sqrt(avg.get("mse", 0.0)))
        avg_mse = avg.get("mse", 0.0)
        avg_r2 = avg.get("r2", 0.0)
        avg_tol = avg.get("tolerance_accuracy_pct", 0.0)
        avg_scale = avg.get("normalized_scale_accuracy_pct", (1.0 - (avg_mae / 4.0)) * 100.0)
        print("-" * 108)
        print(f"{'OVERALL AVERAGE':<18} | {avg_mae:<8.4f} | {avg_rmse:<8.4f} | {avg_mse:<8.4f} | {avg_r2:<9.4f} | {avg_tol:>16.2f}% | {avg_scale:>12.2f}%")
    print("=" * 108 + "\n")


def evaluate_ocean_predictions(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    trait_names: List[str],
    tolerance: float = 0.5,
    verbose: bool = True
) -> Dict[str, Any]:
    """
    Evaluates multi-output regression predictions across each OCEAN personality trait.
    Calculates MAE, RMSE, MSE, R² score, and tolerance accuracy within ±0.5 points on [1.0, 5.0] scale.
    """
    results = {}
    total_mae = 0.0
    total_rmse = 0.0
    total_mse = 0.0
    total_r2 = 0.0
    total_tol_acc = 0.0
    total_norm_acc = 0.0

    num_samples = len(y_true)

    for i, name in enumerate(trait_names):
        true_col = y_true[:, i]
        pred_col = y_pred[:, i]

        mae = float(mean_absolute_error(true_col, pred_col))
        mse = float(mean_squared_error(true_col, pred_col))
        rmse = float(np.sqrt(mse))

        # Safe R2 calculation for small samples or constant values
        if np.var(true_col) > 1e-9 and num_samples >= 2:
            r2 = float(r2_score(true_col, pred_col))
        else:
            r2 = 0.0

        # Tolerance accuracy: percentage of predictions within ± tolerance points of ground truth
        abs_diff = np.abs(true_col - pred_col)
        tol_acc = float(np.mean(abs_diff <= tolerance) * 100.0)

        # Normalized scale accuracy: (1 - MAE / 4.0) * 100% (since BFI scale range = 5 - 1 = 4)
        norm_acc = float(max(0.0, (1.0 - (mae / 4.0))) * 100.0)

        results[name] = {
            "mae": round(mae, 4),
            "rmse": round(rmse, 4),
            "mse": round(mse, 4),
            "r2": round(r2, 4),
            "tolerance_accuracy_pct": round(tol_acc, 2),
            "normalized_scale_accuracy_pct": round(norm_acc, 2)
        }

        total_mae += mae
        total_rmse += rmse
        total_mse += mse
        total_r2 += r2
        total_tol_acc += tol_acc
        total_norm_acc += norm_acc

    num_traits = len(trait_names)
    results["overall_average"] = {
        "mae": round(total_mae / num_traits, 4),
        "rmse": round(total_rmse / num_traits, 4),
        "mse": round(total_mse / num_traits, 4),
        "r2": round(total_r2 / num_traits, 4),
        "tolerance_accuracy_pct": round(total_tol_acc / num_traits, 2),
        "normalized_scale_accuracy_pct": round(total_norm_acc / num_traits, 2),
        "evaluation_samples": num_samples
    }

    if verbose:
        print_evaluation_table(results)

    return results


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    candidate_paths = [
        os.path.join(script_dir, "candidate_evaluation_metrics.json"),
        os.path.join(script_dir, "training_history.json"),
        os.path.join(os.getcwd(), "ml", "training_history.json"),
    ]
    history_file = None
    for path in candidate_paths:
        if os.path.exists(path):
            history_file = path
            break

    if history_file:
        try:
            with open(history_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            metrics = data.get("evaluation_metrics") or data.get("cv_metrics") or data
            if metrics and isinstance(metrics, dict) and "overall_average" in metrics:
                print(f"[Loaded Metrics from {os.path.basename(history_file)}]")
                print_evaluation_table(metrics)
                return
        except Exception:
            pass

    print("[Evaluation] No cached metrics found. Run 'python ml/train_personality_model.py' to train candidate and evaluate.")


if __name__ == "__main__":
    main()
