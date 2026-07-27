"""
Multi-Output Neural Network Model Architecture for BFI-44 OCEAN Personality Prediction.
"""
try:
    import tensorflow as tf
    from tensorflow.keras import layers, models, optimizers
    TF_AVAILABLE = True
except ImportError:
    TF_AVAILABLE = False


def build_personality_model(input_dim: int = 5, output_dim: int = 5):
    """
    Constructs a multi-output regression neural network for Big Five personality estimation.

    Architecture:
    - Input Layer (shape: input_dim)
    - Dense(128, ReLU)
    - Dropout(0.3)
    - Dense(64, ReLU)
    - Dense(32, ReLU)
    - Output Layer (5 neurons, Linear activation for OCEAN traits)
    """
    if not TF_AVAILABLE:
        raise ImportError("TensorFlow / Keras is not available in current environment.")

    model = models.Sequential([
        layers.Input(shape=(input_dim,)),
        layers.Dense(128, activation="relu", name="dense_128"),
        layers.Dropout(0.3, name="dropout_0.3"),
        layers.Dense(64, activation="relu", name="dense_64"),
        layers.Dense(32, activation="relu", name="dense_32"),
        layers.Dense(output_dim, activation="linear", name="ocean_output")
    ], name="OCEAN_Personality_Predictor")

    model.compile(
        optimizer=optimizers.Adam(learning_rate=0.001),
        loss="mse",
        metrics=["mae"]
    )

    return model
