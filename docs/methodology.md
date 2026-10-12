# CareCast forecasting methods

The forecasting target is national daily COVID-19 occupancy, measured in patients occupying beds. Hospital and ICU targets are fitted independently. Per-million occupancy is used for descriptive comparison and is taken directly from the published source.

## Daily alignment

Country, date and indicator keys must be unique. Occupancy values must be finite and nonnegative. The included 424-day common window has complete occupancy observations for both targets in all five countries. Missing values remain missing in the raw observations and scoring targets. The training-prefix helper can carry the last earlier observation forward through a gap of at most three days; longer gaps truncate the training window. A minimum of 84 available training observations is required by the evaluation pipeline.

Vaccination reporting is often weekly. Only the most recent earlier report is carried forward. Its original report date and age are retained. No future-report interpolation is used. Vaccination observations are contextual and do not enter the occupancy forecasting models.

## Models

The four base models receive the same training history and produce the same fourteen target dates. The adaptive ensemble combines their point forecasts using earlier completed forecast errors.

**Last observation.** The most recent occupancy is repeated across the horizon.

**Weekly repeat.** The last seven observations are repeated across the horizon.

**Dynamic local trend.** A Kalman filter tracks log occupancy level and slope with a damped linear transition. The damping coefficient and process-noise scales are chosen by two internal fourteen-day forecast exercises wholly within the training history. The observation-noise scale is estimated from the median squared first difference. A Joseph covariance update preserves numerical stability. Fitted states change at every observation, and each rolling origin triggers a new parameter selection and fit.

**Direct ridge.** A separate regularized regression predicts the change in log occupancy for each horizon. Features include the last level, seven- and fourteen-day changes, and seven- and twenty-eight-day means. Feature centering and scaling use only each model's eligible training examples. Recency weights have a 56-day half-life. Ridge penalty is fixed at 10; the intercept is unpenalized apart from a numerical stabilizer. Predicted log changes are bounded to [-1, 1] as a fixed robustness constraint. No test-period tuning is performed.

Model outputs are nonnegative. Exponentiation is limited to a fixed numerical domain, and the model code is inspectable without specialized forecasting packages.

**Adaptive ensemble.** Separate country, target and horizon-band weights combine the four base methods. Only fully completed earlier fourteen-day forecast rounds with observed targets can influence the weights. Recency-weighted inverse log errors, a fixed error floor and equal-weight shrinkage provide regularization. Ensemble intervals are calibrated from its own earlier errors. Exact formulas, initial weights and horizon diagnostics are described in [Evaluation details](evaluation.md).

## Rolling evaluation

Sixteen origins run from 19 July 2021 through 14 February 2022, spaced fourteen days apart. The final ten origins are scored. Each base forecast uses at most 140 observations ending at its own origin. The ensemble additionally uses eligible completed earlier forecast rounds. Every holdout consists of the following fourteen days. Holdout windows are disjoint; the same dates are used by all five methods.

The dynamic model uses internal temporal evaluation for its parameter choices. The ridge penalty, recency half-life and feature set are fixed design choices rather than claims of globally optimal hyperparameters.

MAE is mean absolute error in patients. RMSE is the square root of the mean squared error. WAPE is 100 times total absolute error divided by total observed occupancy. MAE skill compares each method's MAE with that of last observation on the same country and target. Positive skill means less error; negative skill means more error.

## Sequential intervals

For each country, target and model, previously completed forecasts supply absolute errors on the log1p scale. A calibration error is eligible only when its target date is no later than the current origin. Horizon bands 1–7 and 8–14 are calibrated separately. At least twenty eligible errors are required.

The radius uses the upper order statistic at rank ceil((n + 1) × 0.9), capped at the available sample size. Applying this radius around the log point prediction yields a nonnegative interval after inverse transformation. This is a sequential empirical calibration rule. Serial dependence, regime shifts and revisions mean the usual exchangeability assumptions are not assured; finite-sample 90% coverage is not promised. Reported coverage and width are measured from the actual holdouts.

Coverage includes numerical interval endpoints within an absolute tolerance of 0.0000001 patients. This prevents floating-point exponentiation and eight-decimal CSV serialization from changing whether an exact boundary observation is counted as covered; the stored bounds and point forecasts are unchanged.

## Capacity scenarios

The interface initializes an explicitly user-defined threshold at approximately 125% of the observed occupancy at the selected origin. It is not an estimate of national bed capacity. An additional reserve changes available beds while occupancy predictions remain fixed. The interface displays headroom at the forecast peak, forecast days exceeding the assumed threshold and the peak upper interval bound.

## Reproducibility and interpretation

The exact upstream repository revision and SHA-256 values are recorded in `data/manifest.json`. The Python pipeline regenerates the five-method results and browser payload. Base R independently implements the two baselines and the dynamic model. The reproducibility build compares base predictions against the included archived R outputs; its audit explicitly records that this comparison is not a fresh R execution. The R script can regenerate these outputs in an environment with R installed.

This is a retrospective study of a fixed archived dataset. A revised historical observation may differ from what was published at the time. Temporal fitting does not remove this publication-vintage limitation. Source definitions, hospital reporting and pandemic periods also constrain cross-country interpretation. The models estimate occupancy dynamics and do not establish causal vaccine or policy effects.
