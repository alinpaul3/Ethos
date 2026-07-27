import numpy as np
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

def evaluate_ocean_predictions(y_true, y_pred, trait_names):
    """
    Evaluates multi-output predictions across each OCEAN personality trait.
    Calculates MAE, MSE, and R^2 score per trait and overall averages.
    """
    results = {}
    total_mae = 0.0
    total_mse = 0.0
    total_r2 = 0.0

    print("\n" + "=" * 65)
    print("      OCEAN PERSONALITY MODEL TEST EVALUATION METRICS")
    print("=" * 65)
    print(f"{'Trait':<20} | {'MAE':<10} | {'MSE':<10} | {'R² Score':<10}")
    print("-" * 65)

    for i, name in enumerate(trait_names):
        true_col = y_true[:, i]
        pred_col = y_pred[:, i]

        mae = mean_absolute_error(true_col, pred_col)
        mse = mean_squared_error(true_col, pred_col)
        r2 = r2_score(true_col, pred_col)

        results[name] = {
            "mae": float(np.round(mae, 4)),
            "mse": float(np.round(mse, 4)),
            "r2": float(np.round(r2, 4))
        }

        total_mae += mae
        total_mse += mse
        total_r2 += r2

        print(f"{name.capitalize():<20} | {mae:<10.4f} | {mse:<10.4f} | {r2:<10.4f}")

    num_traits = len(trait_names)
    avg_mae = total_mae / num_traits
    avg_mse = total_mse / num_traits
    avg_r2 = total_r2 / num_traits

    results["overall_average"] = {
        "mae": float(np.round(avg_mae, 4)),
        "mse": float(np.round(avg_mse, 4)),
        "r2": float(np.round(avg_r2, 4))
    }

    print("-" * 65)
    print(f"{'OVERALL AVERAGE':<20} | {avg_mae:<10.4f} | {avg_mse:<10.4f} | {avg_r2:<10.4f}")
    print("=" * 65 + "\n")

    return results
