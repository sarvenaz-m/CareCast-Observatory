"""Small, inspectable forecasting models on the log occupancy scale."""
from __future__ import annotations
from dataclasses import dataclass
import numpy as np

BASE_MODELS = ("persistence", "seasonal", "dynamic", "ridge")
MODEL_NAMES = {
    "persistence": "Last observation",
    "seasonal": "Weekly repeat",
    "dynamic": "Dynamic local trend",
    "ridge": "Direct ridge",
    "ensemble": "Adaptive ensemble",
}

def checked_history(values: np.ndarray, horizon: int) -> np.ndarray:
    values = np.asarray(values, dtype=float)
    if values.ndim != 1 or len(values) < 35:
        raise ValueError("At least 35 univariate observations required")
    if not np.isfinite(values).all() or (values < 0).any():
        raise ValueError("History must contain finite, nonnegative values")
    if not isinstance(horizon, int) or not 1 <= horizon <= 28:
        raise ValueError("Horizon must be an integer from 1 to 28")
    return values

@dataclass(frozen=True)
class TrendParameters:
    level_noise: float = 0.10
    slope_noise: float = 0.002
    damping: float = 0.98

def filtered_state(log_values: np.ndarray, params: TrendParameters) -> tuple[np.ndarray, np.ndarray]:
    """Damped local-linear Kalman filter with a Joseph covariance update."""
    variance = max(float(np.median(np.diff(log_values) ** 2)) / 2, 1e-4)
    transition = np.array([[1., params.damping], [0., params.damping]])
    process = variance * np.diag([params.level_noise, params.slope_noise])
    state = np.array([log_values[0], 0.])
    covariance = np.diag([variance * 5, variance])
    identity = np.eye(2)
    observation = np.array([1., 0.])
    for value in log_values[1:]:
        state = transition @ state
        covariance = transition @ covariance @ transition.T + process
        gain = covariance @ observation / (covariance[0, 0] + variance)
        state = state + gain * (value - state[0])
        update = identity - np.outer(gain, observation)
        covariance = update @ covariance @ update.T + variance * np.outer(gain, gain)
    return state, transition

def trend_prediction(log_values: np.ndarray, horizon: int, params: TrendParameters) -> np.ndarray:
    state, transition = filtered_state(log_values, params)
    predictions = []
    for _ in range(horizon):
        state = transition @ state
        predictions.append(state[0])
    return np.array(predictions)

def select_trend_parameters(log_values: np.ndarray) -> TrendParameters:
    """Nested 14-day temporal validation, entirely inside the training history."""
    candidates = [TrendParameters(q, s, p) for q in (.03, .10, .30)
                  for s in (.0005, .002) for p in (.90, .98)]
    if len(log_values) < 84:
        return TrendParameters()
    def score(params: TrendParameters) -> float:
        losses = []
        for stop in (len(log_values) - 28, len(log_values) - 14):
            pred = trend_prediction(log_values[:stop], 14, params)
            losses.append(np.mean(np.abs(pred - log_values[stop:stop + 14])))
        return float(np.mean(losses))
    return min(candidates, key=score)

def features(z: np.ndarray, t: int) -> np.ndarray:
    return np.array([z[t], z[t] - z[t - 7], z[t] - z[t - 14],
                     z[t - 6:t + 1].mean(), z[t - 27:t + 1].mean()])

def direct_ridge(values: np.ndarray, horizon: int) -> np.ndarray:
    if len(values) < 35 + horizon:
        raise ValueError("Direct ridge requires at least 35 + horizon observations")
    z = np.log1p(values)
    query = features(z, len(z) - 1)
    predictions = []
    for h in range(1, horizon + 1):
        positions = np.arange(28, len(z) - h)
        x = np.array([features(z, int(t)) for t in positions])
        target = z[positions + h] - z[positions]
        weight = np.exp2(-(positions[-1] - positions) / 56.)
        center = np.average(x, axis=0, weights=weight)
        scale = np.sqrt(np.average((x - center) ** 2, axis=0, weights=weight)) + 1e-6
        design = np.column_stack([np.ones(len(x)), (x - center) / scale])
        penalty = np.diag([1e-8] + [10.] * x.shape[1])
        beta = np.linalg.solve(design.T @ (weight[:, None] * design) + penalty,
                               design.T @ (weight * target))
        delta = np.r_[1., (query - center) / scale] @ beta
        predictions.append(np.expm1(np.clip(z[-1] + np.clip(delta, -1., 1.), 0., 20.)))
    return np.array(predictions)

def blend_forecasts(forecasts: np.ndarray, weights: np.ndarray | None = None) -> np.ndarray:
    """Blend base forecasts, accepting one weight vector or one per horizon.

    The first array is ordered by ``BASE_MODELS`` with shape (horizon, 4).
    Weights are normalized on each horizon; fitted weights belong to the
    evaluation layer because their history must respect each forecast origin.
    """
    forecasts = np.asarray(forecasts, dtype=float)
    if forecasts.ndim != 2 or forecasts.shape[1] != len(BASE_MODELS):
        raise ValueError("Forecasts must have shape (horizon, number of base models)")
    if not np.isfinite(forecasts).all() or (forecasts < 0).any():
        raise ValueError("Base forecasts must be finite and nonnegative")
    if weights is None:
        weights = np.ones(len(BASE_MODELS))
    weights = np.asarray(weights, dtype=float)
    if weights.shape == (len(BASE_MODELS),):
        weights = np.broadcast_to(weights, forecasts.shape)
    if weights.shape != forecasts.shape:
        raise ValueError("Weights must be one base-model vector or one vector per horizon")
    if not np.isfinite(weights).all() or (weights < 0).any() or (weights.sum(axis=1) <= 0).any():
        raise ValueError("Weights must be finite, nonnegative and have positive row sums")
    return np.sum(forecasts * (weights / weights.sum(axis=1, keepdims=True)), axis=1)

def predict(model: str, values: np.ndarray, horizon: int = 14, *,
            ensemble_weights: np.ndarray | None = None,
            base_forecasts: dict[str, np.ndarray] | None = None) -> np.ndarray:
    values = checked_history(values, horizon)
    if model == "persistence":
        result = np.repeat(values[-1], horizon)
    elif model == "seasonal":
        result = np.resize(values[-7:], horizon)
    elif model == "dynamic":
        z = np.log1p(values)
        params = select_trend_parameters(z)
        result = np.expm1(np.clip(trend_prediction(z, horizon, params), 0., 20.))
    elif model == "ridge":
        result = direct_ridge(values, horizon)
    elif model == "ensemble":
        components = base_forecasts or {name: predict(name, values, horizon) for name in BASE_MODELS}
        if set(components) != set(BASE_MODELS):
            raise ValueError("Ensemble requires every base model exactly once")
        matrix = np.column_stack([components[name] for name in BASE_MODELS])
        if matrix.shape != (horizon, len(BASE_MODELS)):
            raise ValueError("Base forecast lengths must match the requested horizon")
        result = blend_forecasts(matrix, ensemble_weights)
    else:
        raise ValueError(f"Unknown model: {model}")
    return np.maximum(result, 0.)
