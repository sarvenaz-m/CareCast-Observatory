"""Rolling evaluation with matured-error weighting and past-only calibration."""
from __future__ import annotations
from dataclasses import dataclass
import math
import numpy as np
import pandas as pd
from .data import training_prefix
from .models import BASE_MODELS, MODEL_NAMES, predict

# This is negligible relative to one patient, but larger than the maximum
# 5e-9-patient rounding error in the eight-decimal stored forecast bounds.
# It makes inclusive endpoint coverage stable across a CSV save/load cycle.
INTERVAL_ENDPOINT_TOLERANCE = 1e-7

@dataclass(frozen=True)
class ForecastRound:
    """A complete base-model forecast round retained for later scoring.

    Truth is stored for retrospective replay, but a round cannot affect
    weights until its entire horizon has ended and every target is observed.
    """
    origin: pd.Timestamp
    actual: np.ndarray
    predictions: dict[str, np.ndarray]

    @property
    def end(self) -> pd.Timestamp:
        return self.origin + pd.Timedelta(days=len(self.actual))


def adaptive_ensemble_weights(rounds: list[ForecastRound], origin: pd.Timestamp,
                              horizon: int = 14, half_life_days: float = 56.,
                              shrinkage: float = .10, error_floor: float = .01
                              ) -> tuple[np.ndarray, list[dict]]:
    """Inverse past log-error weights, separately estimated per seven-day band.

    Only wholly observed rounds ending by the current origin are eligible.
    Calendar recency has a fixed 56-day half-life; 10% equal-weight shrinkage
    and a 0.01 log-error floor keep the rule stable. These are fixed design
    choices and are never selected from the evaluation holdouts.
    """
    if not isinstance(horizon, int) or not 1 <= horizon <= 28:
        raise ValueError("Horizon must be an integer from 1 to 28")
    if half_life_days <= 0 or not 0 <= shrinkage <= 1 or error_floor <= 0:
        raise ValueError("Invalid adaptive weight settings")
    origin = pd.Timestamp(origin)
    eligible = [round_ for round_ in rounds
                if round_.origin < origin and round_.end <= origin
                and len(round_.actual) == horizon
                and np.isfinite(round_.actual).all() and (round_.actual >= 0).all()
                and set(round_.predictions) == set(BASE_MODELS)
                and all(np.asarray(round_.predictions[name]).shape == (horizon,)
                        and np.isfinite(round_.predictions[name]).all()
                        and (np.asarray(round_.predictions[name]) >= 0).all()
                        for name in BASE_MODELS)]
    weights = np.empty((horizon, len(BASE_MODELS)))
    records = []
    for start in range(0, horizon, 7):
        stop = min(start + 7, horizon)
        if eligible:
            recency = np.array([np.exp2(-(origin - round_.end).days / half_life_days)
                                for round_ in eligible])
            losses = np.array([[np.abs(np.log1p(round_.actual[start:stop]) -
                                      np.log1p(round_.predictions[name][start:stop])).mean()
                                for name in BASE_MODELS] for round_ in eligible])
            mean_error = np.average(losses, axis=0, weights=recency)
            inverse = 1. / np.maximum(mean_error, error_floor)
            vector = (1 - shrinkage) * inverse / inverse.sum() + shrinkage / len(BASE_MODELS)
        else:
            mean_error = np.full(len(BASE_MODELS), np.nan)
            vector = np.full(len(BASE_MODELS), 1. / len(BASE_MODELS))
        weights[start:stop] = vector
        for index, name in enumerate(BASE_MODELS):
            records.append({"origin": origin, "horizon_band": f"{start + 1}-{stop}",
                            "base_model": name, "weight": float(vector[index]),
                            "matured_origins": len(eligible),
                            "matured_observations": len(eligible) * (stop - start),
                            "mean_absolute_log_error": float(mean_error[index]),
                            "latest_matured_date": max((r.end for r in eligible), default=pd.NaT)})
    return weights, records


def interval_radius(errors: list[float], coverage: float = .9) -> float | None:
    if not 0 < coverage < 1:
        raise ValueError("Coverage must lie strictly between zero and one")
    if len(errors) < 20:
        return None
    errors = np.asarray(errors, dtype=float)
    if not np.isfinite(errors).all() or (errors < 0).any():
        raise ValueError("Calibration errors must be finite and nonnegative")
    # Finite-sample upper order statistic on prior absolute log errors.
    rank = min(len(errors), math.ceil((len(errors) + 1) * coverage))
    return float(np.sort(errors)[rank - 1])


def interval_score(actual: np.ndarray, lower: np.ndarray, upper: np.ndarray,
                   alpha: float = .1) -> np.ndarray:
    """Proper central interval score: width plus a penalty for missed truth."""
    if not 0 < alpha < 1:
        raise ValueError("Alpha must lie strictly between zero and one")
    actual, lower, upper = np.broadcast_arrays(np.asarray(actual, dtype=float),
                                             np.asarray(lower, dtype=float),
                                             np.asarray(upper, dtype=float))
    if (lower > upper).any():
        raise ValueError("Lower bounds cannot exceed upper bounds")
    return (upper - lower) + 2. / alpha * np.maximum(lower - actual, 0.) + \
        2. / alpha * np.maximum(actual - upper, 0.)


def backtest(panel: pd.DataFrame, horizon: int = 14) -> pd.DataFrame:
    origins = pd.date_range("2021-07-19", "2022-02-14", freq="14D")
    rows, weight_rows = [], []
    for country, group in panel.groupby("country", sort=False):
        group = group.set_index("date").sort_index()
        for target in ("hospital", "icu"):
            rounds: list[ForecastRound] = []
            errors: dict[str, list[tuple[pd.Timestamp, int, float]]] = {name: [] for name in MODEL_NAMES}
            for origin in origins:
                history = training_prefix(group[target], origin)
                forecasts = {name: predict(name, history, horizon) for name in BASE_MODELS}
                weights, diagnostics = adaptive_ensemble_weights(rounds, origin, horizon)
                weight_rows.extend({"country": country, "target": target, **r} for r in diagnostics)
                forecasts["ensemble"] = predict("ensemble", history, horizon,
                                                 ensemble_weights=weights,
                                                 base_forecasts=forecasts)
                dates = [origin + pd.Timedelta(days=h) for h in range(1, horizon + 1)]
                truth = np.array([group[target].get(date, np.nan) for date in dates], dtype=float)
                for model, forecast in forecasts.items():
                    for h, point in enumerate(forecast, start=1):
                        date = dates[h - 1]
                        band = (h - 1) // 7
                        available = [e for d, b, e in errors[model] if d <= origin and b == band]
                        radius = interval_radius(available)
                        low = max(0., float(np.expm1(np.log1p(point) - radius))) if radius is not None else np.nan
                        high = float(np.expm1(np.log1p(point) + radius)) if radius is not None else np.nan
                        rows.append({"country": country, "target": target, "model": model,
                                     "origin": origin, "date": date, "horizon": h,
                                     "actual": truth[h - 1], "prediction": float(point),
                                     "lower90": low, "upper90": high,
                                     "calibration_n": len(available),
                                     "evaluation": origin >= pd.Timestamp("2021-10-04")})
                        if np.isfinite(truth[h - 1]):
                            errors[model].append((date, band, abs(float(np.log1p(truth[h - 1]) - np.log1p(point)))))
                rounds.append(ForecastRound(origin, truth,
                                            {name: forecasts[name].copy() for name in BASE_MODELS}))
    frame = pd.DataFrame(rows)
    frame.attrs["adaptive_weights"] = pd.DataFrame(weight_rows)
    return frame


def summarize(backtests: pd.DataFrame, by_horizon: bool = False) -> pd.DataFrame:
    evaluation = backtests[backtests.evaluation & backtests.actual.notna()]
    keys = ["country", "target", "model"] + (["horizon"] if by_horizon else [])
    records = []
    for identity, group in evaluation.groupby(keys, sort=False):
        actual, pred = group.actual.to_numpy(), group.prediction.to_numpy()
        error = np.abs(actual - pred)
        denominator = float(np.sum(np.abs(actual)))
        intervals = group[group.lower90.notna() & group.upper90.notna()]
        coverage = ((intervals.actual >= intervals.lower90 - INTERVAL_ENDPOINT_TOLERANCE) &
                    (intervals.actual <= intervals.upper90 + INTERVAL_ENDPOINT_TOLERANCE))
        records.append({**dict(zip(keys, identity)),
                        "mae": float(error.mean()), "rmse": float(np.sqrt(np.mean((actual - pred) ** 2))),
                        "wape_pct": float(100 * error.sum() / denominator) if denominator else np.nan,
                        "coverage90_pct": float(100 * coverage.mean()),
                        "mean_interval_width": float((intervals.upper90 - intervals.lower90).mean()),
                        "mean_interval_score90": float(interval_score(intervals.actual.to_numpy(),
                                                                      intervals.lower90.to_numpy(),
                                                                      intervals.upper90.to_numpy()).mean()) if len(intervals) else np.nan,
                        "observations": len(group), "origins": group.origin.nunique(),
                        "interval_observations": len(intervals)})
    summary = pd.DataFrame(records)
    baseline_keys = ["country", "target"] + (["horizon"] if by_horizon else [])
    baseline = summary[summary.model == "persistence"].set_index(baseline_keys).mae
    summary["mae_skill_pct"] = [100 * (1 - row.mae / baseline.loc[tuple(getattr(row, k) for k in baseline_keys)])
                                if baseline.loc[tuple(getattr(row, k) for k in baseline_keys)] else np.nan
                                for row in summary.itertuples()]
    return summary
