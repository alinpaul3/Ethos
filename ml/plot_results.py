import os
import matplotlib
matplotlib.use("Agg") # Non-interactive backend
import matplotlib.pyplot as plt

def plot_training_history(history_dict, output_dir="/ml"):
    """
    Plots Training vs Validation Loss and MAE curves, saving figures to disk.
    """
    os.makedirs(output_dir, exist_ok=True)

    loss = history_dict.get("loss", [])
    val_loss = history_dict.get("val_loss", [])
    mae = history_dict.get("mae", [])
    val_mae = history_dict.get("val_mae", [])

    epochs = range(1, len(loss) + 1)

    # 1. Loss Plot
    plt.figure(figsize=(8, 5))
    plt.plot(epochs, loss, "b-", label="Training Loss (MSE)")
    plt.plot(epochs, val_loss, "r--", label="Validation Loss (MSE)")
    plt.title("BFI-44 Model: Training vs Validation Loss (MSE)", fontsize=12, fontweight="bold")
    plt.xlabel("Epochs")
    plt.ylabel("Mean Squared Error")
    plt.legend()
    plt.grid(True, linestyle=":", alpha=0.6)
    loss_path = os.path.join(output_dir, "training_loss.png")
    plt.savefig(loss_path, dpi=200, bbox_inches="tight")
    plt.close()
    print(f"[Plotting] Saved loss curve plot to: {loss_path}")

    # 2. MAE Plot
    plt.figure(figsize=(8, 5))
    plt.plot(epochs, mae, "g-", label="Training MAE")
    plt.plot(epochs, val_mae, "m--", label="Validation MAE")
    plt.title("BFI-44 Model: Training vs Validation MAE Curve", fontsize=12, fontweight="bold")
    plt.xlabel("Epochs")
    plt.ylabel("Mean Absolute Error")
    plt.legend()
    plt.grid(True, linestyle=":", alpha=0.6)
    mae_path = os.path.join(output_dir, "training_mae.png")
    plt.savefig(mae_path, dpi=200, bbox_inches="tight")
    plt.close()
    print(f"[Plotting] Saved MAE curve plot to: {mae_path}")

    # 3. Combined Plot
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 5))
    ax1.plot(epochs, loss, "b-", label="Train Loss")
    ax1.plot(epochs, val_loss, "r--", label="Val Loss")
    ax1.set_title("Model Loss (MSE)")
    ax1.set_xlabel("Epochs")
    ax1.set_ylabel("MSE")
    ax1.legend()
    ax1.grid(True, linestyle=":", alpha=0.6)

    ax2.plot(epochs, mae, "g-", label="Train MAE")
    ax2.plot(epochs, val_mae, "m--", label="Val MAE")
    ax2.set_title("Model Accuracy (MAE)")
    ax2.set_xlabel("Epochs")
    ax2.set_ylabel("MAE")
    ax2.legend()
    ax2.grid(True, linestyle=":", alpha=0.6)

    plt.suptitle("BFI-44 OCEAN Model Training Curves", fontsize=14, fontweight="bold")
    combined_path = os.path.join(output_dir, "training_summary_plot.png")
    plt.savefig(combined_path, dpi=200, bbox_inches="tight")
    plt.close()
    print(f"[Plotting] Saved combined metrics plot to: {combined_path}")

    return loss_path, mae_path
