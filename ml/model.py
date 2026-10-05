"""
Centralized Model Factory and Architecture Registry for BFI-44 OCEAN Personality Prediction.

Supports plug-and-play model architectures across regression paradigms:
- 'elasticnet': Regularized Linear Regression (L1 + L2 penalty) [DEFAULT]
- 'random_forest': Shallow Ensemble of Decision Trees
- 'ridge': L2-regularized Linear Regression
- 'svr': Support Vector Regressor (RBF kernel)
- 'mlp': Multi-Layer Perceptron Neural Network (scikit-learn)
- 'extra_trees': Extremely Randomized Trees Regressor
- 'gradient_boosting': Gradient Boosted Decision Trees
"""

import os
from typing import Dict, Any, List, Callable, Optional

# Scikit-Learn Estimators
from sklearn.linear_model import ElasticNet, Ridge
from sklearn.ensemble import RandomForestRegressor, ExtraTreesRegressor, GradientBoostingRegressor
from sklearn.svm import SVR
from sklearn.neural_network import MLPRegressor
from sklearn.multioutput import MultiOutputRegressor

# Default Model Configuration
# To switch default model, either set MODEL_TYPE here or set ETHOS_MODEL_TYPE environment variable
MODEL_TYPE: str = os.getenv("ETHOS_MODEL_TYPE", "elasticnet").lower()


def _build_elasticnet(random_state: int = 42, alpha: float = 0.1, l1_ratio: float = 0.5, **kwargs):
    return MultiOutputRegressor(
        ElasticNet(alpha=alpha, l1_ratio=l1_ratio, random_state=random_state, **kwargs)
    )


def _build_random_forest(random_state: int = 42, n_estimators: int = 200, max_depth: int = 3, **kwargs):
    return RandomForestRegressor(
        n_estimators=n_estimators, max_depth=max_depth, random_state=random_state, **kwargs
    )


def _build_ridge(random_state: int = 42, alpha: float = 10.0, **kwargs):
    return MultiOutputRegressor(
        Ridge(alpha=alpha, random_state=random_state, **kwargs)
    )


def _build_svr(C: float = 1.0, epsilon: float = 0.1, kernel: str = "rbf", **kwargs):
    kwargs.pop("random_state", None)
    return MultiOutputRegressor(
        SVR(kernel=kernel, C=C, epsilon=epsilon, **kwargs)
    )


def _build_mlp(random_state: int = 42, hidden_layer_sizes: tuple = (64, 32, 16), max_iter: int = 500, **kwargs):
    return MLPRegressor(
        hidden_layer_sizes=hidden_layer_sizes,
        activation="relu",
        solver="adam",
        learning_rate_init=0.01,
        max_iter=max_iter,
        batch_size=16,
        random_state=random_state,
        early_stopping=False,
        **kwargs
    )


def _build_extra_trees(random_state: int = 42, n_estimators: int = 100, max_depth: int = 4, **kwargs):
    return ExtraTreesRegressor(
        n_estimators=n_estimators, max_depth=max_depth, random_state=random_state, **kwargs
    )


def _build_gradient_boosting(random_state: int = 42, n_estimators: int = 50, learning_rate: float = 0.05, max_depth: int = 3, **kwargs):
    return MultiOutputRegressor(
        GradientBoostingRegressor(
            n_estimators=n_estimators, learning_rate=learning_rate, max_depth=max_depth, random_state=random_state, **kwargs
        )
    )


# Centralized Model Registry
MODEL_REGISTRY: Dict[str, Dict[str, Any]] = {
    "elasticnet": {
        "builder": _build_elasticnet,
        "description": "MultiOutput ElasticNet Regressor (L1 + L2 Regularization)",
        "default_params": {"alpha": 0.1, "l1_ratio": 0.5}
    },
    "random_forest": {
        "builder": _build_random_forest,
        "description": "Random Forest Regressor (Ensemble of Trees)",
        "default_params": {"n_estimators": 200, "max_depth": 3}
    },
    "ridge": {
        "builder": _build_ridge,
        "description": "MultiOutput Ridge Regressor (L2 Regularization)",
        "default_params": {"alpha": 10.0}
    },
    "svr": {
        "builder": _build_svr,
        "description": "MultiOutput Support Vector Regressor (RBF Kernel)",
        "default_params": {"kernel": "rbf", "C": 1.0, "epsilon": 0.1}
    },
    "mlp": {
        "builder": _build_mlp,
        "description": "Multi-Layer Perceptron Neural Network",
        "default_params": {"hidden_layer_sizes": (64, 32, 16), "max_iter": 500}
    },
    "extra_trees": {
        "builder": _build_extra_trees,
        "description": "Extra Trees Regressor",
        "default_params": {"n_estimators": 100, "max_depth": 4}
    },
    "gradient_boosting": {
        "builder": _build_gradient_boosting,
        "description": "MultiOutput Gradient Boosting Regressor",
        "default_params": {"n_estimators": 50, "learning_rate": 0.05, "max_depth": 3}
    }
}


def list_supported_models() -> List[str]:
    """Returns a list of all registered model architecture names."""
    return list(MODEL_REGISTRY.keys())


def get_model(model_type: Optional[str] = None, random_state: int = 42, **kwargs):
    """
    Factory function returning an instantiated regressor model.

    Parameters:
    - model_type: Name of architecture ('elasticnet', 'random_forest', 'ridge', 'svr', 'mlp', etc.)
                  Defaults to MODEL_TYPE ('elasticnet').
    - random_state: Seed for reproducibility.
    - kwargs: Optional parameter overrides for the builder.
    """
    selected = (model_type or MODEL_TYPE).lower().strip()
    if selected not in MODEL_REGISTRY:
        supported = ", ".join(list_supported_models())
        raise ValueError(f"Unknown model_type '{selected}'. Supported models: {supported}")

    builder = MODEL_REGISTRY[selected]["builder"]
    return builder(random_state=random_state, **kwargs)


def get_model_metadata(model_type: Optional[str] = None) -> Dict[str, Any]:
    """Returns metadata dictionary for the specified model architecture."""
    selected = (model_type or MODEL_TYPE).lower().strip()
    if selected not in MODEL_REGISTRY:
        supported = ", ".join(list_supported_models())
        raise ValueError(f"Unknown model_type '{selected}'. Supported models: {supported}")

    info = MODEL_REGISTRY[selected]
    return {
        "model_type": selected,
        "description": info["description"],
        "default_params": info["default_params"]
    }


# Keras / TensorFlow compatibility fallback
try:
    import tensorflow as tf
    from tensorflow.keras import layers, models, optimizers
    TF_AVAILABLE = True
except ImportError:
    TF_AVAILABLE = False


def build_personality_model(input_dim: int = 5, output_dim: int = 5):
    """Legacy Keras builder preserved for backward compatibility."""
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
