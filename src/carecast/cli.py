"""Rebuild the auditable results and the offline interface."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
import pandas as pd
from . import __version__
from .data import prepare_panel
from .evaluation import backtest, summarize
from .models import MODEL_NAMES

def safe(value):
    if isinstance(value, dict):
        return {str(k): safe(v) for k, v in value.items()}
    if isinstance(value, (tuple, list)):
        return [safe(v) for v in value]
    if isinstance(value, (pd.Timestamp, np.datetime64)):
        return pd.Timestamp(value).strftime("%Y-%m-%d")
    if value is pd.NaT or value is None:
        return None
    if isinstance(value, (float, np.floating)):
        return round(float(value), 5) if np.isfinite(value) else None
    if isinstance(value, (int, np.integer)):
        return int(value)
    return value

def build_payload(panel: pd.DataFrame, forecasts: pd.DataFrame, metrics: pd.DataFrame, audit: dict,
                  manifest: dict, horizon_metrics: pd.DataFrame | None = None,
                  weights: pd.DataFrame | None = None) -> dict:
    countries = {}
    for country, group in panel.groupby("country", sort=False):
        series = group[["date", "hospital", "icu", "hospital_per_million", "icu_per_million",
                        "people_fully_vaccinated", "vaccination_report_date"]].values.tolist()
        selected = forecasts[forecasts.country == country]
        origins = {}
        for origin, fold in selected.groupby("origin", sort=True):
            targets = {}
            for target, part in fold.groupby("target", sort=False):
                targets[target] = {model: block[["date", "prediction", "lower90", "upper90", "actual"]].values.tolist()
                                   for model, block in part.groupby("model", sort=False)}
            origins[origin.strftime("%Y-%m-%d")] = targets
        country_metrics = metrics[metrics.country == country].drop(columns="country").to_dict("records")
        countries[country] = {"series": series, "origins": origins, "metrics": country_metrics}
        if horizon_metrics is not None:
            countries[country]["horizon_metrics"] = horizon_metrics[horizon_metrics.country == country].drop(columns="country").to_dict("records")
        if weights is not None:
            countries[country]["ensemble_weights"] = weights[weights.country == country].drop(columns="country").to_dict("records")
    return safe({"version": __version__, "models": MODEL_NAMES, "audit": audit, "manifest": manifest,
                 "ensemble_method": {"base_models": ["persistence", "seasonal", "dynamic", "ridge"],
                                     "horizon_band_days": 7, "recency_half_life_days": 56,
                                     "equal_weight_shrinkage": .10, "log_error_floor": .01,
                                     "initial_weights": "equal", "maturity_rule": "complete 14-day holdout observed by origin"},
                 "series_columns": ["date", "hospital", "icu", "hospital_per_million", "icu_per_million",
                                    "fully_vaccinated", "vaccination_report_date"],
                 "forecast_columns": ["date", "prediction", "lower90", "upper90", "observed_holdout"],
                 "countries": countries})

def validate_archived_r(root: Path, forecasts: pd.DataFrame) -> dict:
    """Compare base methods with included independent R outputs.

    This checks archived outputs, and never implies a new R execution.
    ``R/validate.R`` remains available for a fresh independent run.
    """
    source = root / "results/r_backtests.csv"
    if not source.exists():
        return {"method": "archived R outputs comparison", "fresh_execution": False,
                "status": "not_available", "forecast_rows": 0}
    archived = pd.read_csv(source, parse_dates=["origin", "date"])
    keys = ["country", "target", "model", "origin", "horizon"]
    if archived.duplicated(keys).any() or forecasts.duplicated(keys).any():
        raise ValueError("Duplicate cross-language comparison keys")
    compared = archived.merge(forecasts[keys + ["prediction"]], on=keys,
                              suffixes=("_r", "_python"), validate="one_to_one")
    error = float(np.max(np.abs(compared.prediction_r - compared.prediction_python)))
    if len(compared) != len(archived) or error > 1e-5:
        raise ValueError("Archived independent R forecasts differ from current Python base methods")
    return {"method": "archived R outputs comparison", "fresh_execution": False,
            "status": "passed", "forecast_rows": len(compared),
            "models": sorted(archived.model.unique()), "tolerance": 1e-5,
            "maximum_absolute_prediction_difference": error,
            "r_results_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "r_script_sha256": hashlib.sha256((root / "R/validate.R").read_bytes()).hexdigest()}

def build(root: Path) -> dict:
    panel, audit = prepare_panel(root)
    forecasts = backtest(panel)
    weights = forecasts.attrs["adaptive_weights"]
    metrics = summarize(forecasts)
    horizon_metrics = summarize(forecasts, by_horizon=True)
    (root / "data/processed").mkdir(parents=True, exist_ok=True)
    (root / "results").mkdir(parents=True, exist_ok=True)
    (root / "web").mkdir(parents=True, exist_ok=True)
    panel.to_csv(root / "data/processed/panel.csv", index=False)
    forecasts.to_csv(root / "results/backtests.csv", index=False, float_format="%.8f")
    metrics.to_csv(root / "results/metrics.csv", index=False, float_format="%.8f")
    horizon_metrics.to_csv(root / "results/horizon_metrics.csv", index=False, float_format="%.8f")
    weights.to_csv(root / "results/adaptive_weights.csv", index=False, float_format="%.8f")
    latest = forecasts[forecasts.origin == forecasts.origin.max()]
    latest.to_csv(root / "results/latest_forecasts.csv", index=False, float_format="%.8f")
    audit["forecast_rows"] = len(forecasts)
    audit["models"] = len(MODEL_NAMES)
    audit["rolling_origins"] = forecasts.origin.nunique()
    audit["evaluation_origins"] = forecasts[forecasts.evaluation].origin.nunique()
    audit["evaluation_forecast_rows"] = int(forecasts.evaluation.sum())
    audit["horizon_metric_rows"] = len(horizon_metrics)
    audit["adaptive_weight_rows"] = len(weights)
    (root / "results/audit.json").write_text(json.dumps(safe(audit), indent=2) + "\n")
    manifest = json.loads((root / "data/manifest.json").read_text())
    cross_language = validate_archived_r(root, forecasts)
    (root / "results/cross_language_audit.json").write_text(json.dumps(cross_language, indent=2) + "\n")
    payload = build_payload(panel, forecasts, metrics, audit, manifest, horizon_metrics, weights)
    (root / "web/data.js").write_text("window.CARECAST_DATA=" + json.dumps(payload, separators=(",", ":"), allow_nan=False) + ";\n")
    report = {"version": __version__, "data": audit, "metrics": safe(metrics.to_dict("records")),
              "cross_language_validation": cross_language,
              "ensemble_settings": payload["ensemble_method"],
              "validation": "Retrospective rolling origins; archived revised data, not historical publication vintages",
              "results_sha256": hashlib.sha256((root / "results/backtests.csv").read_bytes()).hexdigest()}
    (root / "results/report.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    return report

def main() -> None:
    parser = argparse.ArgumentParser(description="Rebuild CareCast forecasts and interface data")
    parser.add_argument("--root", type=Path, default=Path.cwd())
    args = parser.parse_args()
    report = build(args.root.resolve())
    print(json.dumps(report["data"], indent=2))

if __name__ == "__main__":
    main()
