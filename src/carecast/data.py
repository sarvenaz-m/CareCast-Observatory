"""Validate source snapshots and construct a causally aligned daily panel."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import numpy as np
import pandas as pd

INDICATORS = {
    "Daily hospital occupancy": "hospital",
    "Daily ICU occupancy": "icu",
    "Daily hospital occupancy per million": "hospital_per_million",
    "Daily ICU occupancy per million": "icu_per_million",
}

def verify_snapshot(root: Path) -> dict:
    manifest = json.loads((root / "data/manifest.json").read_text())
    for name, expected in manifest["local_files"].items():
        actual = hashlib.sha256((root / "data/raw" / name).read_bytes()).hexdigest()
        if actual != expected:
            raise ValueError(f"Snapshot integrity mismatch: {name}")
    return manifest

def prepare_panel(root: Path) -> tuple[pd.DataFrame, dict]:
    manifest = verify_snapshot(root)
    hosp = pd.read_csv(root / "data/raw/hospital_occupancy.csv", parse_dates=["date"])
    vacc = pd.read_csv(root / "data/raw/vaccinations.csv", parse_dates=["date"])
    if hosp.duplicated(["entity", "date", "indicator"]).any():
        raise ValueError("Duplicate occupancy observations")
    if vacc.duplicated(["location", "date"]).any():
        raise ValueError("Duplicate vaccination observations")
    if (hosp.value < 0).any() or not np.isfinite(hosp.value).all():
        raise ValueError("Invalid occupancy values")
    if not set(hosp.indicator).issubset(INDICATORS):
        raise ValueError("Unrecognized occupancy indicator")
    frames, audit = [], []
    period = manifest["snapshot_period"]
    dates = pd.date_range(period["start"], period["end"], freq="D")
    for country in manifest["countries"]:
        daily = hosp[hosp.entity == country].pivot(index="date", columns="indicator", values="value")
        daily = daily.rename(columns=INDICATORS).reindex(dates)
        daily.index.name = "date"
        for target in ("hospital", "icu"):
            daily[target + "_observed"] = daily[target].notna()
        v = vacc[vacc.location == country].set_index("date")
        # Only carry an earlier report forward; never interpolate using future reports.
        reports = v[["people_fully_vaccinated", "total_vaccinations"]].copy()
        # The displayed contextual count is fully vaccinated people, so its
        # timestamp must update only when that specific value was reported.
        # A report with another metric but no fully-vaccinated count cannot
        # make a carried-forward count appear newer. Raw report dates remain
        # intact in the included source snapshot.
        reports["vaccination_report_date"] = pd.Series(reports.index, index=reports.index).where(
            reports.people_fully_vaccinated.notna())
        reports = reports.reindex(v.index.union(dates)).sort_index().ffill().reindex(dates)
        daily = daily.join(reports)
        daily["vaccination_age_days"] = (daily.index.to_series() - daily.vaccination_report_date).dt.days
        daily["country"] = country
        audit.append({"country": country, "days": len(daily),
                      "missing_hospital": int(daily.hospital.isna().sum()),
                      "missing_icu": int(daily.icu.isna().sum()),
                      "vaccination_reports": int(len(v)),
                      "stale_vaccination_days_over_14": int((daily.vaccination_age_days > 14).sum())})
        frames.append(daily.reset_index())
    panel = pd.concat(frames, ignore_index=True)
    if panel.duplicated(["country", "date"]).any():
        raise ValueError("Non-unique country/date panel")
    return panel, {"countries": audit, "rows": len(panel), "start": period["start"], "end": period["end"]}

def training_prefix(series: pd.Series, origin: pd.Timestamp, window: int = 140) -> np.ndarray:
    """Causal short-gap carry-forward, scoped to the available prefix."""
    prefix = series.loc[:origin].tail(window).ffill(limit=3)
    if prefix.isna().any():
        last_gap = np.where(prefix.isna())[0][-1]
        prefix = prefix.iloc[last_gap + 1:]
    if len(prefix) < 84:
        raise ValueError("Insufficient contiguous history")
    return prefix.to_numpy(dtype=float)
