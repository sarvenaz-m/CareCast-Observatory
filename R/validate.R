# Independent base-R evaluation of persistence, weekly repeat and dynamic trend.
# Run from the repository root with: Rscript R/validate.R
# All model fitting and tuning use the history available at each origin.

args <- commandArgs(trailingOnly = TRUE)
root <- if (length(args)) args[1] else "."
panel <- read.csv(file.path(root, "data", "processed", "panel.csv"), stringsAsFactors = FALSE)
panel$date <- as.Date(panel$date)
python <- read.csv(file.path(root, "results", "backtests.csv"), stringsAsFactors = FALSE)
python$origin <- as.Date(python$origin)
origins <- sort(unique(python$origin))

state_forecast <- function(z, horizon, qlevel, qslope, phi) {
  variance <- max(median(diff(z)^2) / 2, 1e-4)
  transition <- matrix(c(1, 0, phi, phi), nrow = 2)
  process <- variance * diag(c(qlevel, qslope))
  state <- c(z[1], 0)
  covariance <- diag(c(variance * 5, variance))
  obs <- c(1, 0)
  for (value in z[-1]) {
    state <- transition %*% state
    covariance <- transition %*% covariance %*% t(transition) + process
    gain <- as.vector(covariance %*% obs / (covariance[1, 1] + variance))
    state <- as.vector(state) + gain * (value - state[1])
    update <- diag(2) - outer(gain, obs)
    covariance <- update %*% covariance %*% t(update) + variance * outer(gain, gain)
  }
  result <- numeric(horizon)
  for (h in seq_len(horizon)) {
    state <- transition %*% state
    result[h] <- state[1]
  }
  result
}

dynamic <- function(history, horizon = 14) {
  z <- log1p(history)
  # Match Python's candidate ordering, including its deterministic tie handling.
  grid <- do.call(rbind, lapply(c(.03, .10, .30), function(q)
    do.call(rbind, lapply(c(.0005, .002), function(s)
      data.frame(qlevel = q, qslope = s, phi = c(.90, .98))))))
  scores <- apply(grid, 1, function(p) {
    losses <- sapply(c(length(z) - 28, length(z) - 14), function(stop) {
      f <- state_forecast(z[seq_len(stop)], 14, p[1], p[2], p[3])
      mean(abs(f - z[stop + seq_len(14)]))
    })
    mean(losses)
  })
  p <- as.numeric(grid[which.min(scores), ])
  pmax(0, expm1(pmin(20, pmax(0, state_forecast(z, horizon, p[1], p[2], p[3])))))
}

results <- list()
counter <- 1L
for (country in unique(panel$country)) {
  g <- panel[panel$country == country, ]
  g <- g[order(g$date), ]
  for (target in c("hospital", "icu")) {
    for (origin_value in origins) {
      origin <- as.Date(origin_value, origin = "1970-01-01")
      history <- tail(g[g$date <= origin, target], 140)
      if (anyNA(history)) stop("Missing training data: explicit gap handling required")
      methods <- list(persistence = rep(tail(history, 1), 14),
                      seasonal = rep(tail(history, 7), length.out = 14),
                      dynamic = dynamic(history))
      for (model in names(methods)) {
        truth <- g[match(origin + seq_len(14), g$date), target]
        results[[counter]] <- data.frame(country, target, model, origin = as.character(origin),
                                        date = as.character(origin + seq_len(14)), horizon = seq_len(14),
                                        actual = truth, prediction = methods[[model]],
                                        evaluation = origin >= as.Date("2021-10-04"))
        counter <- counter + 1L
      }
    }
  }
}
results <- do.call(rbind, results)
write.csv(results, file.path(root, "results", "r_backtests.csv"), row.names = FALSE)
scored <- results[results$evaluation & !is.na(results$actual), ]
groups <- split(scored, do.call(interaction, c(scored[c("country", "target", "model")], list(drop = TRUE))))
metrics <- do.call(rbind, lapply(groups, function(g) {
  data.frame(country = g$country[1], target = g$target[1], model = g$model[1],
             mae = mean(abs(g$actual - g$prediction)),
             rmse = sqrt(mean((g$actual - g$prediction)^2)),
             wape_pct = 100 * sum(abs(g$actual - g$prediction)) / sum(abs(g$actual)),
             observations = nrow(g))
}))
write.csv(metrics, file.path(root, "results", "r_metrics.csv"), row.names = FALSE)
keys <- c("country", "target", "model", "origin", "horizon")
python$origin <- as.character(python$origin)
joined <- merge(results, python[, c(keys, "prediction")], by = keys, suffixes = c("_r", "_python"))
error <- max(abs(joined$prediction_r - joined$prediction_python))
if (nrow(joined) != nrow(results) || error > 1e-5) stop("Cross-language prediction mismatch")
cat(sprintf("Validated %d R forecasts; maximum Python difference %.10g\n", nrow(results), error))
