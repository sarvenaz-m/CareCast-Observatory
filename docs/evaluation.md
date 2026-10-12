# Adaptive forecasting and evaluation

CareCast compares four base forecasting methods and an adaptive ensemble on a fixed public-data panel. Its evaluation includes horizon-specific error diagnostics and a central interval score. All targets are published national occupancy observations.

## Adaptive ensemble

The four component methods are last observation, weekly repeat, dynamic local trend and direct ridge. Their nonnegative patient-count predictions are combined by an arithmetic weighted mean. Separate weight vectors are estimated for each country, target and seven-day horizon band: days 1–7 and days 8–14 in the included evaluation.

At forecast origin t, an earlier forecast round is eligible only when its entire fourteen-day horizon has ended by t and all fourteen actual target observations are present. The round must originate before t. Partial horizons and rounds with a missing target are excluded from weight estimation. Thus an accurate first week cannot update the ensemble before that round's second week has also matured.

For each eligible round and component method, the loss is the mean absolute error on the log1p occupancy scale within the relevant horizon band. The round receives calendar recency weight 2^(-(t - round_end)/56), where the date difference is in days. Each method's score is the weighted mean of these band losses. Its preliminary weight is the inverse of the larger of this score and 0.01, normalized across the four methods. The final weight is 90% of this preliminary weight plus 10% of the equal-weight vector. Every final weight is at least 0.025, and each band sums to one. Before any complete round is available, every component receives weight 0.25.

The 56-day half-life, 0.01 error floor and 10% shrinkage are fixed design choices. They are not tuned on the final ten scored origins. The ensemble is allowed to learn from earlier completed evaluation rounds as time advances; this is sequential forecast evaluation, rather than a single frozen fit.

The generic `predict("ensemble", history)` interface defaults to equal weights. The rolling evaluation explicitly supplies weights estimated from its eligible archive. Base predictions are computed once per origin and reused by the ensemble.

## Separate ensemble calibration

Interval calibration uses a sequential empirical rule: absolute log1p errors are eligible only when their individual target dates are no later than the new origin. Errors are stored separately for every country, target, model and horizon band. The ensemble uses errors from its own previously issued weighted predictions; base-model interval widths are never averaged or reused as ensemble calibration observations.

At least twenty eligible errors are required. The radius is the order statistic at rank ceil((n + 1) × 0.9), capped at n. Applying this radius around the log1p point prediction and transforming back gives a nonnegative interval. Temporal dependence and regime changes mean the intervals do not carry a finite-sample 90% coverage guarantee. Observed coverage and width are reported from held-out data.

## Interval score and horizon diagnostics

For lower bound L, upper bound U and observed occupancy y, the central 90% interval score is

IS = (U - L) + 20 × max(L - y, 0) + 20 × max(y - U, 0).

Lower is better. The score is in patient units and balances narrow intervals with penalties for missing the observation. MAE, RMSE, WAPE, empirical coverage, mean width and mean interval score are computed only for observed holdouts. Interval statistics additionally require both interval bounds. Inclusive empirical coverage uses an absolute endpoint tolerance of 0.0000001 patients, solely to make endpoint comparisons stable under floating-point transforms and eight-decimal CSV storage; the stored bounds and interval-score distances are unchanged. WAPE has a missing result when total actual occupancy is zero. MAE skill compares each method with last observation on the same country and target; horizon-specific skill additionally matches the exact horizon.

`results/horizon_metrics.csv` contains one row per country, target, model and forecast day, scored over the final ten origins. `results/metrics.csv` contains country/target/model summaries, including `mean_interval_score90`. `results/adaptive_weights.csv` records each origin's exact component weights, band, count of eligible rounds and observations, weighted mean absolute log error, and latest eligible round end date. Initial equal-weight rows have no fitted error score or mature date.

The offline payload describes its series and forecast-array schemas. Its country-level `horizon_metrics` and `ensemble_weights` fields expose these records. All five methods are named in the shared `models` object, and fixed ensemble settings are included in `ensemble_method`.

## Context timestamp provenance

Vaccination context does not enter the forecasting models. Its report date identifies the specific fully-vaccinated count displayed by the interface. A source report lacking that value cannot advance the date of a carried-forward count. The raw snapshot preserves all original report dates and other metrics. No count is carried backward from a future report.

## Cross-language validation

`R/validate.R` independently implements the last-observation, weekly-repeat and dynamic-trend methods. When an R runtime is available, it can regenerate the three methods' point forecasts and compare them with Python.

The reproducibility build compares Python forecasts with the included archived R outputs, using country, target, model, origin and horizon as unique keys. It fails if any archived forecast is absent or the maximum absolute point-prediction difference exceeds 0.00001 patients. `results/cross_language_audit.json` records the result, source checksums and `fresh_execution: false`, so an archived-output comparison is distinguished from a new R run. The ridge and adaptive ensemble methods are not independently validated in R.

This is a retrospective evaluation of revised archived observations, rather than a reconstruction of historical publication vintages. Forecasting and interval behavior are research results on this fixed dataset, not evidence of current national capacity or a clinical operating system.
