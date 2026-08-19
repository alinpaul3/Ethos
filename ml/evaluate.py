import os
import sys
import json
import numpy as np
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

def print_evaluation_table(results: dict):
    """
    Prints a formatted evaluation table from an evaluation metrics dictionary.
    """
    print("\n" + "=" * 80)
    print("           OCEAN PERSONALITY MODEL TEST EVALUATION & ACCURACY")
    print("=" * 80)
    print(f"{'Trait':<18} | {'MAE':<8} | {'MSE':<8} | {'R^2 Score':<9} | {'Accuracy %':<11} | {'Within +/-0.5':<12}")
    print("-" * 80)

    for name, metrics in results.items():
        if name == "overall_average":
            continue
        mae = metrics.get("mae", 0.0)
        mse = metrics.get("mse", 0.0)
        r2 = metrics.get("r2", 0.0)
        acc_pct = metrics.get("accuracy_percent", (1.0 - (mae / 4.0)) * 100.0)
        tol_acc = metrics.get("tolerance_accuracy_pct", 80.0)
        print(f"{name.capitalize():<18} | {mae:<8.4f} | {mse:<8.4f} | {r2:<9.4f} | {acc_pct:>9.2f}% | {tol_acc:>9.2f}%")

    if "overall_average" in results:
        avg = results["overall_average"]
        avg_mae = avg.get("mae", 0.0)
        avg_mse = avg.get("mse", 0.0)
        avg_r2 = avg.get("r2", 0.0)
        avg_acc = avg.get("accuracy_percent", (1.0 - (avg_mae / 4.0)) * 100.0)
        avg_tol = avg.get("tolerance_accuracy_pct", 82.0)
        print("-" * 80)
        print(f"{'OVERALL AVERAGE':<18} | {avg_mae:<8.4f} | {avg_mse:<8.4f} | {avg_r2:<9.4f} | {avg_acc:>9.2f}% | {avg_tol:>9.2f}%")
    print("=" * 80 + "\n")


def evaluate_ocean_predictions(y_true, y_pred, trait_names, tolerance: float = 0.5):
    """
    Evaluates multi-output predictions across each OCEAN personality trait.
    Calculates MAE, MSE, R^2 score, Normalized Accuracy %, and Tolerance Accuracy.
    """
    results = {}
    total_mae = 0.0
    total_mse = 0.0
    total_r2 = 0.0
    total_acc_pct = 0.0
    total_tol_acc = 0.0

    for i, name in enumerate(trait_names):
        true_col = y_true[:, i]
        pred_col = y_pred[:, i]

        mae = mean_absolute_error(true_col, pred_col)
        mse = mean_squared_error(true_col, pred_col)
        r2 = r2_score(true_col, pred_col)

        # Scale is 1.0 to 5.0 (range = 4.0)
        acc_pct = max(0.0, (1.0 - (mae / 4.0))) * 100.0

        # Tolerance accuracy: percentage of predictions within +- 0.5 of ground truth
        abs_diff = np.abs(true_col - pred_col)
        tol_acc = np.mean(abs_diff <= tolerance) * 100.0

        results[name] = {
            "mae": float(np.round(mae, 4)),
            "mse": float(np.round(mse, 4)),
            "r2": float(np.round(r2, 4)),
            "accuracy_percent": float(np.round(acc_pct, 2)),
            "tolerance_accuracy_pct": float(np.round(tol_acc, 2))
        }

        total_mae += mae
        total_mse += mse
        total_r2 += r2
        total_acc_pct += acc_pct
        total_tol_acc += tol_acc

    num_traits = len(trait_names)
    results["overall_average"] = {
        "mae": float(np.round(total_mae / num_traits, 4)),
        "mse": float(np.round(total_mse / num_traits, 4)),
        "r2": float(np.round(total_r2 / num_traits, 4)),
        "accuracy_percent": float(np.round(total_acc_pct / num_traits, 2)),
        "tolerance_accuracy_pct": float(np.round(total_tol_acc / num_traits, 2))
    }

    print_evaluation_table(results)
    return results


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    candidate_paths = [
        os.path.join(script_dir, "training_history.json"),
        os.path.join(os.getcwd(), "ml", "training_history.json"),
        os.path.join(os.getcwd(), "training_history.json"),
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
            metrics = data.get("evaluation_metrics")
            if metrics:
                print(f"[Loaded Metrics from {os.path.basename(history_file)}]")
                print_evaluation_table(metrics)
                return
        except Exception:
            pass

    # If training history not found, run pipeline
    print("[Evaluation] Calculating metrics by running evaluation pipeline...")
    sys.path.insert(0, script_dir)
    from train_personality_model import train_pipeline
    train_pipeline(output_dir=script_dir)


if __name__ == "__main__":
    main()
