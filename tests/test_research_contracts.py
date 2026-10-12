"""Check leakage boundaries, data integrity and forecast behavior."""
import json
import tempfile
import unittest
from pathlib import Path
import numpy as np
import pandas as pd
from carecast.data import prepare_panel, training_prefix, verify_snapshot
from carecast.evaluation import (ForecastRound, adaptive_ensemble_weights,
                                interval_radius, interval_score, backtest, summarize)
from carecast.models import BASE_MODELS, MODEL_NAMES, blend_forecasts, predict

ROOT = Path(__file__).resolve().parents[1]

class ResearchContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.panel, cls.audit = prepare_panel(ROOT)

    def test_snapshot_matches_manifest(self):
        self.assertEqual(verify_snapshot(ROOT)["rows"]["hospital_occupancy"], 8480)
        self.assertEqual(len(self.panel), 2120)

    def test_modified_snapshot_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "data/raw").mkdir(parents=True)
            (root / "data/manifest.json").write_text(json.dumps({"local_files": {"x.csv": "bad"}}))
            (root / "data/raw/x.csv").write_text("changed")
            with self.assertRaises(ValueError): verify_snapshot(root)

    def test_future_data_cannot_change_forecasts(self):
        country = self.panel[self.panel.country == "Portugal"].set_index("date")
        origin = pd.Timestamp("2022-01-17")
        original = country.hospital.copy()
        changed = original.copy()
        changed.loc[changed.index > origin] = 1e9
        a, b = training_prefix(original, origin), training_prefix(changed, origin)
        for model in MODEL_NAMES:
            np.testing.assert_allclose(predict(model, a), predict(model, b), atol=0, rtol=0)

    def test_future_vaccination_reports_are_not_used(self):
        panel = self.panel
        available = panel.vaccination_report_date.notna()
        self.assertTrue((panel.loc[available, "vaccination_report_date"] <= panel.loc[available, "date"]).all())
        self.assertTrue((panel.loc[available, "vaccination_age_days"] >= 0).all())

    def test_vaccination_timestamp_identifies_the_displayed_value(self):
        raw = pd.read_csv(ROOT / "data/raw/vaccinations.csv", parse_dates=["date"])
        available = self.panel[self.panel.people_fully_vaccinated.notna()]
        joined = available.merge(raw[["location", "date", "people_fully_vaccinated"]],
                                 left_on=["country", "vaccination_report_date"],
                                 right_on=["location", "date"], suffixes=("_panel", "_raw"),
                                 how="left", validate="many_to_one")
        np.testing.assert_array_equal(joined.people_fully_vaccinated_panel,
                                      joined.people_fully_vaccinated_raw)
        self.assertTrue(self.panel.people_fully_vaccinated.isna().equals(
            self.panel.vaccination_report_date.isna()))

    def test_missing_target_remains_unobserved(self):
        panel = self.panel[self.panel.country == "Portugal"].copy()
        panel.loc[panel.date == pd.Timestamp("2022-02-28"), "hospital"] = np.nan
        forecasts = backtest(panel)
        missing = forecasts[(forecasts.date == pd.Timestamp("2022-02-28")) & (forecasts.target == "hospital")]
        self.assertTrue(missing.actual.isna().all())
        metrics = summarize(forecasts)
        self.assertTrue((metrics[metrics.target == "hospital"].observations == 139).all())
        self.assertTrue((metrics[metrics.target == "icu"].observations == 140).all())

    def test_constant_history_and_invalid_values(self):
        for model in MODEL_NAMES:
            np.testing.assert_allclose(predict(model, np.full(140, 100.)), 100., atol=1e-6)
        with self.assertRaises(ValueError): predict("dynamic", np.full(100, -1.))
        with self.assertRaises(ValueError): predict("ridge", np.arange(100.), 0)

    def test_intervals_need_calibration_and_use_upper_order_statistic(self):
        self.assertIsNone(interval_radius([.1] * 19))
        self.assertGreaterEqual(interval_radius(list(np.arange(30) / 100)), .27)

    def test_forecasts_and_intervals_do_not_use_current_holdout(self):
        panel = self.panel[self.panel.country == "Portugal"].copy()
        altered = panel.copy()
        origin = pd.Timestamp("2022-02-14")
        altered.loc[altered.date > origin, ["hospital", "icu"]] = 1e7
        a, b = backtest(panel), backtest(altered)
        a, b = a[a.origin == origin], b[b.origin == origin]
        for col in ["prediction", "lower90", "upper90", "calibration_n"]:
            np.testing.assert_allclose(a[col], b[col], equal_nan=True, atol=0, rtol=0)
        self.assertFalse(np.allclose(a.actual, b.actual))

    def test_ensemble_waits_for_entire_round_and_starts_equal(self):
        round_ = ForecastRound(pd.Timestamp("2022-01-01"), np.full(14, 100.),
                               {name: np.full(14, 100. + 20 * i) for i, name in enumerate(BASE_MODELS)})
        before, diagnostics = adaptive_ensemble_weights([round_], pd.Timestamp("2022-01-14"))
        np.testing.assert_allclose(before, .25)
        self.assertTrue(all(row["matured_origins"] == 0 for row in diagnostics))
        after, diagnostics = adaptive_ensemble_weights([round_], pd.Timestamp("2022-01-15"))
        self.assertTrue(all(row["matured_origins"] == 1 for row in diagnostics))
        self.assertTrue((after[:, 0] > after[:, 1]).all())
        np.testing.assert_allclose(after.sum(axis=1), 1.)
        self.assertTrue((after >= .025).all())

    def test_ensemble_excludes_unobserved_rounds_and_future_errors(self):
        origin = pd.Timestamp("2022-01-15")
        missing_truth = np.full(14, 100.)
        missing_truth[-1] = np.nan
        missing = ForecastRound(pd.Timestamp("2022-01-01"), missing_truth,
                                {name: np.full(14, 100.) for name in BASE_MODELS})
        future = ForecastRound(pd.Timestamp("2022-01-08"), np.full(14, 99999.),
                               {name: np.full(14, 1. + i) for i, name in enumerate(BASE_MODELS)})
        weights, diagnostics = adaptive_ensemble_weights([missing, future], origin)
        np.testing.assert_allclose(weights, .25)
        self.assertTrue(all(row["matured_origins"] == 0 for row in diagnostics))

    def test_ensemble_learns_bands_separately_and_blends_normalized_weights(self):
        truth = np.full(14, 100.)
        preds = {name: np.full(14, 130.) for name in BASE_MODELS}
        preds["persistence"][:7] = 100.
        preds["ridge"][7:] = 100.
        round_ = ForecastRound(pd.Timestamp("2022-01-01"), truth, preds)
        weights, _ = adaptive_ensemble_weights([round_], pd.Timestamp("2022-01-15"))
        self.assertGreater(weights[0, 0], weights[0, 3])
        self.assertGreater(weights[-1, 3], weights[-1, 0])
        matrix = np.column_stack([preds[name] for name in BASE_MODELS])
        np.testing.assert_allclose(blend_forecasts(matrix, weights * 5), blend_forecasts(matrix, weights))
        result = predict("ensemble", np.full(140, 100.), base_forecasts=preds, ensemble_weights=weights)
        self.assertTrue((result >= 100.).all() and (result <= 130.).all())
        with self.assertRaises(ValueError): blend_forecasts(matrix, np.zeros(4))
        with self.assertRaises(ValueError): blend_forecasts(matrix, np.array([1., -1., 1., 1.]))

    def test_interval_score_penalizes_misses_in_patient_units(self):
        score = interval_score(np.array([15., 5., 25.]), np.full(3, 10.), np.full(3, 20.))
        np.testing.assert_allclose(score, [10., 110., 110.])
        with self.assertRaises(ValueError): interval_score([1.], [3.], [2.])
        with self.assertRaises(ValueError): interval_score([1.], [0.], [2.], alpha=0)

    def test_ensemble_intervals_calibrate_its_previously_issued_predictions(self):
        forecasts = backtest(self.panel[self.panel.country == "Portugal"])
        origin = pd.Timestamp("2021-10-11")
        selected = forecasts[(forecasts.target == "hospital") & (forecasts.model == "ensemble")]
        issued = selected[(selected.origin == origin) & (selected.horizon == 1)].iloc[0]
        eligible = selected[(selected.date <= origin) & (selected.horizon <= 7)]
        errors = np.abs(np.log1p(eligible.actual) - np.log1p(eligible.prediction)).tolist()
        radius = interval_radius(errors)
        self.assertEqual(issued.calibration_n, len(errors))
        self.assertAlmostEqual(issued.lower90, max(0., np.expm1(np.log1p(issued.prediction) - radius)))
        self.assertAlmostEqual(issued.upper90, np.expm1(np.log1p(issued.prediction) + radius))
        weights = forecasts.attrs["adaptive_weights"]
        mature = weights[weights.latest_matured_date.notna()]
        self.assertTrue((mature.latest_matured_date <= mature.origin).all())

    def test_inclusive_interval_coverage_survives_endpoint_rounding(self):
        # exp(log(endpoint)) can land just below or above an integer endpoint;
        # serialization to eight decimals must not change whether it is covered.
        rows = []
        for horizon, (lower, upper) in enumerate([(80., 134. - 5e-10),
                                                 (134. + 5e-10, 160.),
                                                 (80., 134. - 1e-5)], start=1):
            rows.append({"country": "Portugal", "target": "icu", "model": "persistence",
                         "origin": pd.Timestamp("2021-11-22"), "horizon": horizon,
                         "actual": 134., "prediction": 100., "lower90": lower,
                         "upper90": upper, "evaluation": True})
        frame = pd.DataFrame(rows)
        before = summarize(frame).coverage90_pct.iloc[0]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "forecasts.csv"
            frame.to_csv(path, index=False, float_format="%.8f")
            restored = pd.read_csv(path, parse_dates=["origin"])
        after = summarize(restored).coverage90_pct.iloc[0]
        self.assertAlmostEqual(before, 200. / 3.)
        self.assertEqual(before, after)
        horizon_coverage = summarize(frame, by_horizon=True).coverage90_pct.tolist()
        self.assertEqual(horizon_coverage, [100., 100., 0.])

if __name__ == "__main__":
    unittest.main()
