'use strict';
(function () {
  const DATA = window.CARECAST_DATA;
  const $ = id => document.getElementById(id);
  if (!DATA || !DATA.countries || !Object.keys(DATA.countries).length) {
    $('stats').textContent = 'The observatory data could not be loaded. Open index.html alongside the web folder.';
    return;
  }
  const countries = Object.keys(DATA.countries);
  const models = Object.keys(DATA.models);
  const count = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });
  const decimal = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
  const percent = value => Number.isFinite(value) ? decimal.format(value) + '%' : '—';
  const dateLabel = value => new Date(value + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const shortDate = value => new Date(value + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const isNumber = Number.isFinite;
  const format = value => isNumber(value) ? count.format(value) : '—';
  const state = { country: countries.includes('Portugal') ? 'Portugal' : countries[0], origin: '', model: models.includes('ensemble') ? 'ensemble' : models[0], target: 'hospital', window: 56, truth: false, weightBand: '8-14' };
  const descriptions = {
    persistence: 'A transparent reference. Every future day repeats the occupancy measured at the forecast origin.',
    seasonal: 'A weekly reference. The last seven observed days repeat across the forecast horizon, preserving the recent weekly pattern.',
    dynamic: 'A damped local-trend state-space model. Level and slope evolve over time; parameters are selected within the available history.',
    ridge: 'Fourteen regularized regressions use recent occupancy, changes and trends. Recent training observations receive greater weight.',
    ensemble: 'A convex blend of four methods. Near- and far-horizon weights favor methods with smaller earlier, fully observed errors. Issued forecasts never use their own future outcomes.'
  };
  const codes = { Portugal: 'PT', France: 'FR', Italy: 'IT', Netherlands: 'NL', Spain: 'ES' };
  const shortModels = { persistence: 'Last obs.', seasonal: 'Weekly repeat', dynamic: 'Local trend', ridge: 'Direct ridge' };
  const reducedMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  let origins = [];
  let playback = null;
  let toastTimer;
  let chartContext;
  let cursorIndex = null;
  let rendering = false;
  let savedScenario = null;
  let resized;

  function options(element, values, label) {
    element.replaceChildren(...values.map(value => { const option = document.createElement('option'); option.value = value; option.textContent = label ? label(value) : value; return option; }));
  }
  function countryData() { return DATA.countries[state.country]; }
  function seriesBefore(country = state.country) { return DATA.countries[country].series.filter(row => row[0] <= state.origin); }
  function forecast() { return countryData().origins[state.origin][state.target][state.model]; }
  function metric() { return countryData().metrics.find(row => row.target === state.target && row.model === state.model); }
  function originOptions() {
    const available = Object.keys(countryData().origins).sort();
    const evaluationCount = DATA.audit && DATA.audit.evaluation_origins;
    origins = isNumber(evaluationCount) && evaluationCount > 0 ? available.slice(-evaluationCount) : available;
    if (!origins.includes(state.origin)) state.origin = origins[origins.length - 1];
    options($('origin'), origins, dateLabel);
    $('origin-range').max = String(origins.length - 1);
  }
  function toast(message) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4300);
  }
  function colours() {
    const style = getComputedStyle(document.body);
    return Object.fromEntries(['ink', 'muted', 'jade', 'brass', 'brass-light', 'line', 'paper', 'card', 'lavender-pale', 'danger'].map(name => [name, style.getPropertyValue('--' + name).trim()]));
  }
  function scaleTop(value) {
    if (!(value > 0)) return 1;
    const power = Math.pow(10, Math.floor(Math.log10(value)));
    const unit = value / power;
    const step = unit <= 2 ? .2 : unit <= 5 ? .5 : 1;
    return Math.ceil(unit / step) * step * power;
  }
  function linePath(values, x, y) {
    let continuing = false;
    return values.map((value, index) => {
      if (!isNumber(value)) { continuing = false; return ''; }
      const command = continuing ? 'L' : 'M'; continuing = true;
      return command + x(index).toFixed(2) + ',' + y(value).toFixed(2);
    }).join(' ');
  }
  function defaultCapacity() {
    const col = state.target === 'hospital' ? 1 : 2;
    const history = seriesBefore();
    return Math.min(10000000, Math.max(10, Math.ceil(history[history.length - 1][col] * 1.25 / 10) * 10));
  }
  function reserveMaximum(capacity) { return Math.min(10000000, Math.max(1000, Math.ceil(capacity / 100) * 100)); }
  function setCapacity() {
    const base = defaultCapacity();
    $('capacity').value = String(base);
    $('reserve').max = String(reserveMaximum(base));
    $('reserve').value = '0';
  }
  function scenario() {
    const capacity = Number($('capacity').value);
    const reserve = Number($('reserve').value);
    const valid = $('capacity').value.trim() !== '' && Number.isInteger(capacity) && capacity >= 1 && capacity <= 10000000 && Number.isInteger(reserve) && reserve >= 0;
    return { capacity, reserve, effective: capacity + reserve, valid };
  }
  function stat(label, value, unit, foot, glyph, extraClass = '') {
    return '<div class="stat"><div class="stat-label">' + label + '<span aria-hidden="true">' + glyph + '</span></div><div class="stat-value"><span class="' + extraClass + '">' + value + '</span><small>' + unit + '</small></div><div class="stat-foot">' + foot + '</div></div>';
  }
  function drawStats() {
    const history = seriesBefore();
    const last = history[history.length - 1];
    const col = state.target === 'hospital' ? 1 : 2;
    const pred = forecast();
    const end = pred[pred.length - 1];
    const current = last[col];
    const previous = history[Math.max(0, history.length - 8)][col];
    const movement = previous > 0 ? 100 * (current / previous - 1) : null;
    const movementText = movement === null ? '—' : (movement > 0 ? '+' : '') + decimal.format(movement) + '%';
    const range = end[2] === null ? 'Calibration unavailable' : '90% interval ' + format(end[2]) + '–' + format(end[3]);
    const vaccinated = last[5] === null ? '—' : decimal.format(last[5] / 1000000);
    const vaxDate = last[6] === null ? 'No earlier vaccination report' : 'Last report ' + dateLabel(last[6]);
    $('stats').innerHTML = stat('OBSERVED OCCUPANCY', format(current), 'patients', dateLabel(last[0]), '◈') +
      stat('DAY 14 FORECAST', format(end[1]), 'patients', range, '↗') +
      stat('SEVEN-DAY MOVEMENT', movementText, '', 'Change in observed occupancy', '≈', movement > 0 ? 'movement-up' : 'movement-down') +
      stat('FULLY VACCINATED', vaccinated, 'million', vaxDate, '✦');
  }
  function drawChart() {
    const container = $('chart');
    const history = seriesBefore().slice(-state.window);
    const pred = forecast();
    const col = state.target === 'hospital' ? 1 : 2;
    const historyValues = history.map(row => row[col]);
    const width = Math.max(250, container.clientWidth || 620);
    const height = container.clientHeight || 278;
    const left = width < 430 ? 43 : 50;
    const right = 12, top = 29, bottom = 29;
    const n = history.length + pred.length;
    const start = history.length - 1;
    const fullPred = [[state.origin, historyValues[start], historyValues[start], historyValues[start]]].concat(pred);
    const visible = [...historyValues, ...pred.flatMap(row => [row[1], row[3]])].filter(isNumber);
    if (state.truth) visible.push(...pred.map(row => row[4]).filter(isNumber));
    const max = scaleTop(Math.max(1, ...visible) * 1.11);
    const x = index => left + index / Math.max(1, n - 1) * (width - left - right);
    const y = value => height - bottom - value / max * (height - top - bottom);
    const colour = colours();
    let svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + escape(state.country + ', ' + state.target + ' occupancy. ' + state.window + ' observed days and a 14-day forecast.') + '"><title>Occupancy history and 14-day forecast</title><desc>Observed history ends at ' + state.origin + '. The forecast is a projection with a 90 percent prediction interval. Holdout observations are ' + (state.truth ? 'revealed' : 'hidden') + '.</desc>';
    svg += '<rect x="' + x(start) + '" y="' + top + '" width="' + (width - right - x(start)) + '" height="' + (height - bottom - top) + '" fill="' + colour['lavender-pale'] + '" opacity=".50"/>';
    for (let tick = 0; tick <= 4; tick++) {
      const value = max * tick / 4;
      svg += '<path d="M' + left + ',' + y(value) + 'H' + (width - right) + '" stroke="' + colour.line + '" stroke-dasharray="2 4"/><text x="' + (left - 9) + '" y="' + (y(value) + 3) + '" text-anchor="end" fill="' + colour.muted + '" font-size="9">' + format(value) + '</text>';
    }
    if (pred.every(row => isNumber(row[2]) && isNumber(row[3]))) {
      const upper = fullPred.map((row, index) => x(start + index) + ',' + y(row[3]));
      const lower = fullPred.map((row, index) => x(start + index) + ',' + y(row[2])).reverse();
      svg += '<polygon points="' + upper.concat(lower).join(' ') + '" fill="' + colour['brass-light'] + '" opacity=".24"/>';
    }
    const area = linePath(historyValues, x, y) + 'L' + x(start) + ',' + y(0) + 'L' + x(0) + ',' + y(0) + 'Z';
    svg += '<path d="' + area + '" fill="' + colour.jade + '" opacity=".055"/><path d="' + linePath(historyValues, x, y) + '" fill="none" stroke="' + colour.jade + '" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>';
    svg += '<path d="' + linePath(fullPred.map(row => row[1]), index => x(start + index), y) + '" fill="none" stroke="' + colour.brass + '" stroke-width="2.4" stroke-dasharray="5 4" stroke-linecap="round"/>';
    if (state.truth) svg += '<path d="' + linePath([historyValues[start]].concat(pred.map(row => row[4])), index => x(start + index), y) + '" fill="none" stroke="' + colour.muted + '" stroke-width="1.7" stroke-dasharray="2 4"/>';
    const threshold = scenario();
    if (threshold.valid && threshold.effective < max) {
      svg += '<path d="M' + left + ',' + y(threshold.effective) + 'H' + (width - right) + '" stroke="' + colour.ink + '" opacity=".28" stroke-dasharray="5 5"/><text x="' + (left + 4) + '" y="' + Math.max(top + 9, y(threshold.effective) - 6) + '" fill="' + colour.muted + '" font-size="8">SCENARIO / ' + format(threshold.effective) + '</text>';
    }
    svg += '<path d="M' + x(start) + ',' + top + 'V' + (height - bottom) + '" stroke="' + colour.muted + '" stroke-dasharray="3 4" opacity=".60"/><circle cx="' + x(start) + '" cy="' + y(historyValues[start]) + '" r="4" fill="' + colour.jade + '" stroke="' + colour.card + '" stroke-width="2"/>';
    svg += '<text x="' + Math.min(width - 48, x(start) + 7) + '" y="16" fill="' + colour.muted + '" font-size="8" letter-spacing=".6">ORIGIN</text><text x="' + left + '" y="16" fill="' + colour.muted + '" font-size="8" letter-spacing=".6">PATIENTS</text>';
    const historicalTicks = width < 430 ? [0, Math.floor(start / 2)] : [0, Math.floor(start / 3), Math.floor(start * 2 / 3)];
    historicalTicks.forEach(index => { svg += '<text x="' + x(index) + '" y="' + (height - 7) + '" text-anchor="' + (index === 0 ? 'start' : 'middle') + '" fill="' + colour.muted + '" font-size="9">' + shortDate(history[index][0]) + '</text>'; });
    svg += '<text x="' + x(start) + '" y="' + (height - 7) + '" text-anchor="middle" fill="' + colour.muted + '" font-size="9">' + shortDate(state.origin) + '</text><text x="' + x(n - 1) + '" y="' + (height - 7) + '" text-anchor="end" fill="' + colour.brass + '" font-size="9">+14 days</text>';
    svg += '<g id="chart-focus" visibility="hidden" pointer-events="none"><path id="focus-line" stroke="' + colour.muted + '" stroke-dasharray="2 3" opacity=".6"/><circle id="focus-circle" r="4" fill="' + colour.ink + '" stroke="' + colour.card + '" stroke-width="2"/></g></svg>';
    container.innerHTML = svg;
    chartContext = { history, pred, col, width, height, left, right, top, bottom, n, x, y };
    cursorIndex = null;
    $('chart-tooltip').hidden = true;
    $('chart-detail').textContent = 'Move over the curve or use the arrow keys to inspect a day.';
    $('chart-title').textContent = state.country + ' · ' + (state.target === 'hospital' ? 'hospital occupancy' : 'intensive-care occupancy');
    $('origin-note').textContent = dateLabel(state.origin) + ' · ' + DATA.models[state.model];
  }
  function inspectChart(index, announce = false) {
    if (!chartContext) return;
    const c = chartContext;
    cursorIndex = Math.max(0, Math.min(c.n - 1, index));
    const observed = cursorIndex < c.history.length;
    const row = observed ? c.history[cursorIndex] : c.pred[cursorIndex - c.history.length];
    const value = observed ? row[c.col] : row[1];
    const date = dateLabel(row[0]);
    const pieces = [date, (observed ? 'Observed ' : 'Forecast ') + format(value) + ' patients'];
    if (!observed && isNumber(row[2])) pieces.push('90% interval ' + format(row[2]) + '–' + format(row[3]));
    if (!observed && state.truth && isNumber(row[4])) pieces.push('Holdout ' + format(row[4]));
    const text = pieces.join(' · ');
    $('chart-detail').textContent = text;
    $('chart-tooltip').innerHTML = '<small>' + escape(date) + '</small><br><strong>' + (observed ? 'Observed ' : 'Forecast ') + format(value) + '</strong>' + (!observed && isNumber(row[2]) ? '<br>90%: ' + format(row[2]) + '–' + format(row[3]) : '') + (!observed && state.truth && isNumber(row[4]) ? '<br>Holdout: ' + format(row[4]) : '');
    $('chart-tooltip').hidden = false;
    const tooltipWidth = $('chart-tooltip').offsetWidth || 160;
    const pointX = c.x(cursorIndex);
    $('chart-tooltip').style.left = Math.max(2, Math.min(c.width - tooltipWidth - 2, pointX + 13)) + 'px';
    $('chart-tooltip').style.top = '22px';
    const focus = $('chart-focus');
    if (focus && isNumber(value)) {
      focus.setAttribute('visibility', 'visible');
      $('focus-line').setAttribute('d', 'M' + pointX + ',' + c.top + 'V' + (c.height - c.bottom));
      $('focus-circle').setAttribute('cx', pointX);
      $('focus-circle').setAttribute('cy', c.y(value));
    }
    if (announce) $('chart-announcement').textContent = text;
  }
  function clearChartFocus() {
    $('chart-tooltip').hidden = true;
    const focus = $('chart-focus');
    if (focus) focus.setAttribute('visibility', 'hidden');
  }
  function drawCapacity() {
    let s = scenario();
    $('capacity').setAttribute('aria-invalid', String(!s.valid));
    $('export').disabled = !s.valid;
    $('share').disabled = !s.valid;
    $('reserve-label').textContent = format(s.reserve) + ' beds';
    if (!s.valid) {
      $('capacity-result').innerHTML = '<div class="capacity-error">Enter a whole-bed threshold between 1 and 10,000,000.</div>';
      $('capacity-chart').replaceChildren();
      return;
    }
    $('reserve').max = String(reserveMaximum(s.capacity));
    if (s.reserve > Number($('reserve').max)) { $('reserve').value = $('reserve').max; s = scenario(); }
    $('reserve-label').textContent = format(s.reserve) + ' beds';
    const pred = forecast();
    const peak = Math.max(...pred.map(row => row[1]).filter(isNumber));
    const intervalValues = pred.map(row => row[3]).filter(isNumber);
    const upperPeak = intervalValues.length ? Math.max(...intervalValues) : null;
    const surplus = s.effective - peak;
    const rounded = surplus >= 0 ? Math.floor(surplus) : Math.ceil(-surplus);
    const daysOver = pred.filter(row => row[1] > s.effective).length;
    const intervalText = upperPeak === null ? 'No calibrated interval for this origin.' : 'Upper interval peak: ' + format(upperPeak) + ' patients.';
    $('capacity-result').innerHTML = '<div class="capacity-number ' + (surplus < 0 ? 'negative' : 'positive') + '">' + (surplus >= 0 ? '+' : '−') + format(Math.abs(rounded)) + '<small>' + (surplus < 0 ? 'bed shortfall at forecast peak' : 'beds of headroom at forecast peak') + '</small></div><div class="capacity-message">' + daysOver + ' of ' + pred.length + ' forecast days above ' + format(s.effective) + ' beds.<br>' + intervalText + '</div>';
    const width = 260, height = 56;
    const max = Math.max(1, peak, upperPeak || 0, s.effective) * 1.1;
    const x = index => 3 + index / Math.max(1, pred.length - 1) * (width - 6);
    const y = value => height - 4 - value / max * (height - 9);
    $('capacity-chart').innerHTML = '<svg viewBox="0 0 260 56" role="img" aria-label="Forecast peak ' + format(peak) + ' patients compared with scenario threshold ' + format(s.effective) + ' beds"><path d="M3,' + y(s.effective) + 'H257" stroke="#DDD3EF" opacity=".6" stroke-dasharray="3 4"/>' + (upperPeak !== null ? '<path d="' + linePath(pred.map(row => row[3]), x, y) + '" stroke="#C5A663" opacity=".3" fill="none" stroke-width="1"/>' : '') + '<path d="' + linePath(pred.map(row => row[1]), x, y) + '" stroke="#C5A663" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';
  }
  function drawModelDetail() {
    const weights = (countryData().ensemble_weights || []).filter(row => row.target === state.target && row.origin === state.origin);
    if (state.model !== 'ensemble' || !weights.length) {
      $('model-detail').innerHTML = '<div class="model-flow" aria-hidden="true"><span>Observed<br>history</span><b>→</b><span>Temporal<br>estimate</span><b>→</b><span>14-day<br>outlook</span></div>';
      return;
    }
    const availableBands = [...new Set(weights.map(row => row.horizon_band))].sort();
    if (!availableBands.includes(state.weightBand)) state.weightBand = availableBands[availableBands.length - 1];
    const selected = weights.filter(row => row.horizon_band === state.weightBand).sort((a, b) => b.weight - a.weight);
    const latest = selected.find(row => row.latest_matured_date);
    $('model-detail').innerHTML = '<div class="model-detail-caption">ISSUED COMPONENT WEIGHTS</div><fieldset class="window-switch"><legend class="sr-only">Ensemble weight horizon band</legend>' + availableBands.map(band => '<button type="button" data-weight-band="' + escape(band) + '" aria-pressed="' + (band === state.weightBand) + '" class="' + (band === state.weightBand ? 'selected' : '') + '">Days ' + escape(band.replace('-', '–')) + '</button>').join('') + '</fieldset>' + selected.map(row => '<div class="weight-row"><div><span>' + escape(shortModels[row.base_model] || DATA.models[row.base_model]) + '</span><span class="weight-bar"><i style="width:' + (100 * row.weight).toFixed(2) + '%"></i></span></div><b>' + percent(row.weight * 100) + '</b></div>').join('') + '<div class="model-detail-note">' + (latest ? format(latest.matured_origins) + ' mature earlier origins · outcomes through ' + shortDate(latest.latest_matured_date) : 'Equal weights until earlier outcomes mature.') + '</div>';
    $('model-detail').querySelectorAll('[data-weight-band]').forEach(button => button.addEventListener('click', () => { state.weightBand = button.dataset.weightBand; drawModelDetail(); writeViewHash(); }));
  }
  function drawBenchmarks() {
    const metrics = countryData().metrics.filter(row => row.target === state.target).slice().sort((a, b) => a.wape_pct - b.wape_pct);
    const minimum = metrics.length ? metrics[0].wape_pct : null;
    $('benchmark').innerHTML = metrics.map((row, index) => '<tr class="model-row ' + (row.model === state.model ? 'chosen' : '') + '"><td><button type="button" data-model="' + escape(row.model) + '" aria-pressed="' + (row.model === state.model) + '"><span class="rank" aria-hidden="true">' + String(index + 1).padStart(2, '0') + '</span><span class="dot-radio" aria-hidden="true"></span><span class="method-name">' + escape(DATA.models[row.model]) + '</span>' + (row.wape_pct === minimum ? '<span class="best-badge">LOWEST ERROR</span>' : '') + '</button></td><td>' + percent(row.wape_pct) + '</td><td>' + decimal.format(row.mae) + '</td><td>' + percent(row.coverage90_pct) + '</td></tr>').join('');
    $('benchmark').querySelectorAll('[data-model]').forEach(button => button.addEventListener('click', () => { stopPlayback(); state.model = button.dataset.model; render(false); }));
    const m = metric();
    $('model-title').textContent = DATA.models[state.model];
    $('model-description').textContent = descriptions[state.model] || 'A forecast method evaluated on the same historical origins as the references.';
    drawModelDetail();
    if (!m) { $('validation-stats').replaceChildren(); return; }
    $('scored-origins').textContent = m.origins + ' scored origins';
    const skill = m.mae_skill_pct;
    const skillText = skill === 0 ? 'Same as reference' : decimal.format(Math.abs(skill)) + '% ' + (skill > 0 ? 'lower' : 'higher');
    $('validation-stats').innerHTML = '<div><dt>Scored daily predictions</dt><dd>' + format(m.observations) + '</dd></div><div><dt>MAE vs last observation</dt><dd>' + skillText + '</dd></div><div><dt>Mean interval width</dt><dd>' + format(m.mean_interval_width) + ' patients</dd></div>' + (isNumber(m.mean_interval_score90) ? '<div><dt>90% interval score ↓</dt><dd>' + format(m.mean_interval_score90) + '</dd></div>' : '');
  }
  function drawHorizon() {
    const all = countryData().horizon_metrics || [];
    const metrics = all.filter(row => row.target === state.target && row.model === state.model).sort((a, b) => a.horizon - b.horizon);
    $('diagnostics').hidden = !metrics.length;
    if (!metrics.length) return;
    const baseline = all.filter(row => row.target === state.target && row.model === 'persistence').sort((a, b) => a.horizon - b.horizon);
    const width = Math.max(260, $('horizon-chart').clientWidth || 600), height = 155;
    const left = 43, right = 10, top = 12, bottom = 24;
    const colour = colours();
    const max = scaleTop(Math.max(1, ...metrics.map(row => row.mae), ...baseline.map(row => row.mae)) * 1.08);
    const x = index => left + index / Math.max(1, metrics.length - 1) * (width - left - right);
    const y = value => height - bottom - value / max * (height - top - bottom);
    let svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Mean absolute error by forecast horizon for ' + escape(DATA.models[state.model]) + '. ' + metrics.map(row => 'Day ' + row.horizon + ': ' + format(row.mae) + ' patients').join('; ') + '"><title>Mean absolute error over the forecast horizon</title>';
    for (let tick = 0; tick <= 3; tick++) {
      const value = max * tick / 3;
      svg += '<path d="M' + left + ',' + y(value) + 'H' + (width - right) + '" stroke="' + colour.line + '" stroke-dasharray="2 4"/><text x="' + (left - 8) + '" y="' + (y(value) + 3) + '" font-size="8" fill="' + colour.muted + '" text-anchor="end">' + format(value) + '</text>';
    }
    if (baseline.length === metrics.length) svg += '<path d="' + linePath(baseline.map(row => row.mae), x, y) + '" stroke="' + colour.muted + '" opacity=".40" stroke-width="1.5" stroke-dasharray="3 4" fill="none"/>';
    svg += '<path d="' + linePath(metrics.map(row => row.mae), x, y) + '" stroke="' + colour.jade + '" stroke-width="2.2" fill="none" stroke-linecap="round"/>';
    metrics.forEach((row, index) => {
      svg += '<circle cx="' + x(index) + '" cy="' + y(row.mae) + '" r="2.5" fill="' + colour.jade + '"><title>Day ' + row.horizon + ': MAE ' + decimal.format(row.mae) + ', coverage ' + percent(row.coverage90_pct) + '</title></circle>';
      if ([1, 4, 7, 10, 14].includes(row.horizon)) svg += '<text x="' + x(index) + '" y="' + (height - 6) + '" fill="' + colour.muted + '" font-size="8" text-anchor="middle">' + String(row.horizon).padStart(2, '0') + '</text>';
    });
    $('horizon-chart').innerHTML = svg + '</svg>';
    const average = rows => rows.length ? rows.reduce((sum, row) => sum + row.mae, 0) / rows.length : null;
    const early = average(metrics.filter(row => row.horizon <= 7));
    const late = average(metrics.filter(row => row.horizon > 7));
    const final = metrics[metrics.length - 1];
    const item = (label, value, foot) => '<div class="horizon-stat"><span>' + label + '</span><strong>' + value + '</strong><small>' + foot + '</small></div>';
    $('horizon-summary').innerHTML = item('DAYS 01–07', format(early), 'mean error / patients') + item('DAYS 08–14', format(late), 'mean error / patients') + item('DAY 14 COVERAGE', percent(final.coverage90_pct), '90% interval target') + item('DAY 14 INTERVAL', format(final.mean_interval_width), 'mean width / patients') + '<div class="diagnostic-extra">Each day is evaluated over ' + final.origins + ' historical origins. ' + (isNumber(final.mean_interval_score90) ? 'Day 14 interval score: ' + format(final.mean_interval_score90) + ' patients; lower is better. This score penalizes interval width and missed outcomes.' : '') + '</div>';
  }
  function spark(values, colour) {
    const finite = values.filter(isNumber);
    if (!finite.length) return '';
    const low = Math.min(...finite), high = Math.max(...finite), span = high - low || 1;
    const x = index => 2 + index / Math.max(1, values.length - 1) * 146;
    const y = value => 33 - (value - low) / span * 27;
    return '<svg viewBox="0 0 150 39" aria-hidden="true"><path d="' + linePath(values, x, y) + '" stroke="' + colour + '" stroke-width="1.7" fill="none" stroke-linecap="round"/></svg>';
  }
  function drawPeers() {
    const col = state.target === 'hospital' ? 3 : 4;
    const colour = colours();
    $('peers').innerHTML = countries.map(country => {
      const rows = seriesBefore(country).slice(-56);
      const last = rows[rows.length - 1];
      return '<button type="button" class="peer ' + (country === state.country ? 'current' : '') + '" data-country="' + escape(country) + '" aria-pressed="' + (country === state.country) + '" aria-label="Inspect ' + escape(country) + ', ' + decimal.format(last[col]) + ' occupied beds per million"><div class="peer-label">' + escape(country) + '<span>' + escape(codes[country] || '') + '</span></div><div class="peer-value">' + decimal.format(last[col]) + '<small>/ million</small></div>' + spark(rows.map(row => row[col]), country === state.country ? colour.jade : colour.muted) + '<small class="asof">56-day observed trajectory</small></button>';
    }).join('');
    $('peers').querySelectorAll('button').forEach(button => button.addEventListener('click', () => { stopPlayback(); state.country = button.dataset.country; originOptions(); render(true); }));
  }
  function drawAudit() {
    const audit = DATA.audit || {};
    const local = (audit.countries || []).find(row => row.country === state.country) || {};
    const item = (label, value) => '<div><span>' + label + '</span><b>' + format(value) + '</b></div>';
    $('audit').innerHTML = '<div class="audit-list">' + item('Country / date rows', audit.rows) + item('Forecast records', audit.forecast_rows) + item('Missing occupancy days · ' + escape(codes[state.country] || state.country), (local.missing_hospital || 0) + (local.missing_icu || 0)) + item('Vaccination reports · ' + escape(codes[state.country] || state.country), local.vaccination_reports) + '</div><div class="audit-check">✓ Source and local-file SHA-256 checksums are recorded in the manifest.</div>';
    const manifest = DATA.manifest || {};
    const revision = manifest.source_revision || '';
    $('snapshot-revision').innerHTML = (manifest.retrieved_at ? 'Snapshot retrieved ' + dateLabel(manifest.retrieved_at) + '<br>' : '') + (revision ? 'Source revision <code title="' + escape(revision) + '">' + escape(revision.slice(0, 12)) + '</code>' : '');
    if (revision) {
      const sourceLinks = document.querySelectorAll('.source-links a');
      if (sourceLinks[0]) sourceLinks[0].href = 'https://github.com/owid/covid-19-data/tree/' + encodeURIComponent(revision) + '/public/data/hospitalizations';
      if (sourceLinks[1]) sourceLinks[1].href = 'https://github.com/owid/covid-19-data/tree/' + encodeURIComponent(revision) + '/public/data/vaccinations';
    }
  }
  function syncReplay() {
    const index = origins.indexOf(state.origin);
    $('origin-range').value = String(index);
    $('origin-range').setAttribute('aria-valuetext', dateLabel(state.origin));
    $('replay-position').textContent = (index + 1) + ' / ' + origins.length;
    $('previous-origin').disabled = index <= 0;
    $('next-origin').disabled = index >= origins.length - 1;
  }
  function render(resetScenario = false, updateHash = true) {
    rendering = true;
    $('country').value = state.country; $('origin').value = state.origin; $('model').value = state.model;
    document.querySelectorAll('[data-target]').forEach(button => { const selected = button.dataset.target === state.target; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); });
    document.querySelectorAll('[data-window]').forEach(button => { const selected = Number(button.dataset.window) === state.window; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); });
    $('show-truth').checked = state.truth;
    if (resetScenario) setCapacity();
    drawStats(); drawCapacity(); drawChart(); drawBenchmarks(); drawHorizon(); drawPeers(); drawAudit(); syncReplay();
    rendering = false;
    if (updateHash) writeViewHash();
  }
  function viewHash() {
    const s = scenario();
    const params = new URLSearchParams({ country: state.country, target: state.target, model: state.model, origin: state.origin, window: String(state.window), holdout: state.truth ? '1' : '0', band: state.weightBand });
    if (s.valid) { params.set('capacity', String(s.capacity)); params.set('reserve', String(s.reserve)); }
    return '#cc=' + params.toString();
  }
  function writeViewHash() {
    if (rendering) return;
    try { window.history.replaceState(null, '', window.location.pathname + window.location.search + viewHash()); } catch (_) { /* A restricted local-file context can still use the share dialog. */ }
  }
  function readViewHash() {
    if (!window.location.hash.startsWith('#cc=')) return false;
    const params = new URLSearchParams(window.location.hash.slice(4));
    if (countries.includes(params.get('country'))) state.country = params.get('country');
    if (models.includes(params.get('model'))) state.model = params.get('model');
    if (['hospital', 'icu'].includes(params.get('target'))) state.target = params.get('target');
    if ([28, 56, 112].includes(Number(params.get('window')))) state.window = Number(params.get('window'));
    state.truth = params.get('holdout') === '1';
    if (['1-7', '8-14'].includes(params.get('band'))) state.weightBand = params.get('band');
    state.origin = params.get('origin') || '';
    const capacity = Number(params.get('capacity'));
    const reserve = Number(params.get('reserve'));
    savedScenario = Number.isInteger(capacity) && capacity >= 1 && capacity <= 10000000 && Number.isInteger(reserve) && reserve >= 0 && reserve <= reserveMaximum(capacity) && reserve % 10 === 0 ? { capacity, reserve } : null;
    return true;
  }
  function applySavedScenario() {
    if (!savedScenario) return;
    $('capacity').value = String(savedScenario.capacity);
    $('reserve').max = String(reserveMaximum(savedScenario.capacity));
    $('reserve').value = String(savedScenario.reserve);
    savedScenario = null;
  }
  function stopPlayback() {
    if (playback !== null) clearInterval(playback);
    playback = null;
    $('play').setAttribute('aria-pressed', 'false');
    $('play').innerHTML = '<span aria-hidden="true">▶</span> Play origins';
  }
  function moveOrigin(direction) {
    const index = Math.max(0, Math.min(origins.length - 1, origins.indexOf(state.origin) + direction));
    state.origin = origins[index]; render(false);
  }
  function togglePlayback() {
    if (playback !== null) { stopPlayback(); return; }
    if (reducedMotion.matches) {
      if (origins.indexOf(state.origin) >= origins.length - 1) state.origin = origins[0]; else state.origin = origins[origins.indexOf(state.origin) + 1];
      render(false);
      toast('Reduced motion is enabled. Replay advances one origin at a time.');
      return;
    }
    if (origins.indexOf(state.origin) >= origins.length - 1) { state.origin = origins[0]; render(false); }
    $('play').setAttribute('aria-pressed', 'true');
    $('play').innerHTML = '<span aria-hidden="true">Ⅱ</span> Pause replay';
    playback = setInterval(() => {
      if (origins.indexOf(state.origin) >= origins.length - 1) { stopPlayback(); return; }
      moveOrigin(1);
      if (origins.indexOf(state.origin) >= origins.length - 1) stopPlayback();
    }, 1600);
  }
  function csvCell(value) {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }
  function exportForecast() {
    const s = scenario();
    if (!s.valid) { $('capacity').focus(); return; }
    const headers = ['country', 'target', 'model', 'origin', 'date', 'horizon', 'prediction', 'lower90', 'upper90', 'observed_holdout', 'scenario_capacity', 'scenario_reserve', 'scenario_total'];
    const rows = forecast().map((row, index) => [state.country, state.target, state.model, state.origin, row[0], index + 1, row[1], row[2], row[3], state.truth ? row[4] : null, s.capacity, s.reserve, s.effective].map(csvCell).join(','));
    const url = URL.createObjectURL(new Blob([headers.join(',') + '\n' + rows.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = 'carecast-' + state.country.toLowerCase() + '-' + state.target + '-' + state.model + '-' + state.origin + '.csv';
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('14 forecast days exported. ' + (state.truth ? 'Revealed holdout values are included.' : 'Holdout values remain hidden in this export.'));
  }
  async function shareView() {
    const url = new URL(window.location.href);
    url.hash = viewHash();
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(url.href);
      toast('View link copied. It includes your selected scenario.');
    } catch (_) {
      $('share-url').value = url.href;
      if (typeof $('share-dialog').showModal === 'function') { $('share-dialog').showModal(); $('share-url').focus(); $('share-url').select(); }
      else { toast('Copy the view address from your browser’s address bar.'); writeViewHash(); }
    }
  }
  function applyTheme(dark) {
    document.body.classList.toggle('dark', dark);
    $('theme').setAttribute('aria-label', dark ? 'Switch to light appearance' : 'Switch to dark appearance');
    try { window.localStorage.setItem('carecast-appearance', dark ? 'dark' : 'light'); } catch (_) { /* Local storage is optional. */ }
    if (chartContext) { drawChart(); drawHorizon(); drawPeers(); }
  }

  options($('country'), countries);
  options($('model'), models, value => DATA.models[value]);
  $('country-count').textContent = String(countries.length);
  $('model-count').textContent = String(models.length);
  const start = DATA.audit && DATA.audit.start, end = DATA.audit && DATA.audit.end;
  if (start && end) $('data-period').textContent = start.slice(5, 7) + '.' + start.slice(0, 4) + ' — ' + end.slice(5, 7) + '.' + end.slice(0, 4);
  readViewHash(); originOptions(); setCapacity(); applySavedScenario();
  try { applyTheme(window.localStorage.getItem('carecast-appearance') === 'dark'); } catch (_) { /* The default appearance needs no persistent storage. */ }
  render(false);

  $('country').addEventListener('change', event => { stopPlayback(); state.country = event.target.value; originOptions(); render(true); });
  $('origin').addEventListener('change', event => { stopPlayback(); state.origin = event.target.value; render(false); });
  $('model').addEventListener('change', event => { stopPlayback(); state.model = event.target.value; render(false); });
  document.querySelectorAll('[data-target]').forEach(button => button.addEventListener('click', () => { stopPlayback(); if (state.target === button.dataset.target) return; state.target = button.dataset.target; render(true); }));
  document.querySelectorAll('[data-window]').forEach(button => button.addEventListener('click', () => { state.window = Number(button.dataset.window); render(false); }));
  ['capacity', 'reserve'].forEach(id => $(id).addEventListener('input', () => { drawCapacity(); drawChart(); writeViewHash(); }));
  $('reset-capacity').addEventListener('click', () => { setCapacity(); drawCapacity(); drawChart(); writeViewHash(); toast('Scenario reset to 125% of occupancy at this origin, with no reserve.'); });
  $('show-truth').addEventListener('change', event => { state.truth = event.target.checked; drawChart(); writeViewHash(); });
  $('play').addEventListener('click', togglePlayback);
  $('previous-origin').addEventListener('click', () => { stopPlayback(); moveOrigin(-1); });
  $('next-origin').addEventListener('click', () => { stopPlayback(); moveOrigin(1); });
  $('origin-range').addEventListener('input', event => { stopPlayback(); state.origin = origins[Number(event.target.value)]; render(false); });
  $('export').addEventListener('click', exportForecast);
  $('share').addEventListener('click', shareView);
  $('share-url').addEventListener('focus', event => event.target.select());
  $('theme').addEventListener('click', () => applyTheme(!document.body.classList.contains('dark')));
  $('chart').addEventListener('pointermove', event => {
    if (!chartContext) return;
    const bounds = $('chart').getBoundingClientRect();
    const c = chartContext;
    const point = (event.clientX - bounds.left) * c.width / Math.max(1, bounds.width);
    inspectChart(Math.round((point - c.left) / (c.width - c.left - c.right) * (c.n - 1)));
  });
  $('chart').addEventListener('pointerleave', clearChartFocus);
  $('chart').addEventListener('blur', clearChartFocus);
  $('chart').addEventListener('keydown', event => {
    if (!chartContext) return;
    let next = cursorIndex === null ? chartContext.history.length - 1 : cursorIndex;
    if (event.key === 'ArrowLeft') next--; else if (event.key === 'ArrowRight') next++; else if (event.key === 'Home') next = 0; else if (event.key === 'End') next = chartContext.n - 1; else if (event.key === 'Escape') { clearChartFocus(); return; } else return;
    event.preventDefault(); inspectChart(next, true);
  });
  document.querySelectorAll('nav a,.brand').forEach(link => link.addEventListener('click', event => {
    const target = document.querySelector(link.getAttribute('href'));
    if (!target) return;
    event.preventDefault(); target.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'start' });
    document.querySelectorAll('nav a').forEach(item => { const active = item.getAttribute('href') === link.getAttribute('href'); item.classList.toggle('active', active); if (active) item.setAttribute('aria-current', 'location'); else item.removeAttribute('aria-current'); });
  }));
  if (typeof IntersectionObserver === 'function') {
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      document.querySelectorAll('nav a').forEach(link => { const active = link.getAttribute('href') === '#' + visible.target.id; link.classList.toggle('active', active); if (active) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current'); });
    }, { rootMargin: '-8% 0px -48% 0px', threshold: [0, .25, .5] });
    ['overview', 'forecast', 'validation', 'provenance'].forEach(id => observer.observe($(id)));
  }
  window.addEventListener('resize', () => { clearTimeout(resized); resized = setTimeout(() => { drawChart(); drawHorizon(); }, 120); });
  window.addEventListener('hashchange', () => { if (!window.location.hash.startsWith('#cc=')) return; stopPlayback(); readViewHash(); originOptions(); setCapacity(); applySavedScenario(); render(false, false); });
  window.addEventListener('pagehide', stopPlayback);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopPlayback(); });
  if (reducedMotion.addEventListener) reducedMotion.addEventListener('change', event => { if (event.matches) stopPlayback(); });
}());
