'use strict';

const localTime = require('../local-time');

// Solcast PV forecast (Hobbyist rooftop tier). Mixed into EmsDevice.prototype;
// `this` is the device instance. Fetches the rooftop-site forecast, caches it and
// exposes aggregate helpers. NOTHING here drives control decisions yet — it is a
// pure data feed for the dashboard / diagnostics and for future price/deadline
// charging (D10) and solar-aware planning (D16).
//
// Rate limits: Solcast's free Hobbyist tier allows ~10 calls/day. We fetch at most
// every PV_FORECAST_MIN_INTERVAL_MS and persist the last fetch time to the device
// store, so frequent app restarts (e.g. during `homey app run`) cannot burn the
// daily budget. On error / HTTP 429 we back off for PV_FORECAST_BACKOFF_MS.

const https = require('https');
const {
  SOLCAST_BASE_URL, PV_FORECAST_MIN_INTERVAL_MS, PV_FORECAST_BACKOFF_MS, PV_FORECAST_TIMEOUT_MS,
  PV_FORECAST_STALE_MS, HIST, FORECAST_GATE_HYSTERESIS_KWH,
} = require('./constants');

module.exports = {

  // Restore the cached forecast + last-fetch time on startup so a restart neither
  // re-fetches immediately (rate-limit) nor loses the current forecast.
  async _restorePvForecast() {
    this._pvForecast          = null;   // [{ end:<ms>, kw, kw10, kw90, h }] ascending, or null
    this._pvForecastFetchedAt = null;   // ms of last successful fetch
    this._pvForecastBackoffUntil = 0;   // ms; skip fetching until then
    this._pvForecastError     = null;   // last error string, or null
    this._pvForecastLoggedErr = false;  // one-shot error log guard
    try {
      const stored = await this.getStoreValue('pvForecast');
      if (stored && Array.isArray(stored.slots)) {
        this._pvForecast          = stored.slots;
        this._pvForecastFetchedAt = stored.fetchedAt || null;
      }
    } catch (e) { /* ignore */ }
  },

  // Called on the slow tick. Decides whether a fetch is due and, if so, performs it.
  // Never throws — all failures are captured in `_pvForecastError`.
  async _maybeFetchPvForecast(cfg) {
    if (!cfg || cfg.pv_forecast_enabled !== true) return;
    const apiKey = (cfg.solcast_api_key || '').trim();
    const ids    = this._solcastResourceIds(cfg);
    if (!apiKey || !ids.length) return;

    const now = Date.now();
    if (now < this._pvForecastBackoffUntil) return;
    // Each site is a separate API call, so scale the minimum interval by the number of
    // sites — keeps the total within the free-tier budget (~8 calls/day) no matter how
    // many rooftops (e.g. north + south) are configured.
    const minInterval = PV_FORECAST_MIN_INTERVAL_MS * ids.length;
    if (this._pvForecastFetchedAt && (now - this._pvForecastFetchedAt) < minInterval) return;

    try {
      // Fetch every site; each catches its own error so one bad site can't sink the rest.
      const results = await Promise.all(ids.map((id) => this._solcastGet(id, apiKey)
        .then((json) => ({ ok: true, slots: this._parseSolcastForecasts(json) }))
        .catch((e) => ({ ok: false, err: e.message }))));

      const good = results.filter((r) => r.ok && r.slots.length);
      if (!good.length) throw new Error(results.find((r) => !r.ok)?.err || 'empty / unparseable forecast response');

      const slots  = this._mergeForecastSlots(good.map((r) => r.slots)); // per-slot sum across sites
      const failed = ids.length - good.length;
      this._pvForecast          = slots;
      this._pvForecastFetchedAt = now;
      this._pvForecastError     = failed ? `${failed} of ${ids.length} sites failed` : null;
      this._pvForecastLoggedErr = false;
      await this.setStoreValue('pvForecast', { slots, fetchedAt: now }).catch(() => {});
      this.log(`[EMS] PV forecast updated: ${good.length}/${ids.length} site(s), ${slots.length} slots, remaining today ≈ ${this._pvForecastRemainingTodayKwh().toFixed(1)} kWh`);
      const s = this._pvForecastSummary(now);
      this.homey.flow.getDeviceTriggerCard('ems_pv_forecast_updated')
        .trigger(this, { remaining_today_kwh: s.remainingTodayKwh, next_6h_kwh: s.next6hKwh, peak_kw: s.peakKw ?? 0 })
        .catch((e) => this.log(`[EMS] pv_forecast_updated trigger failed: ${e.message}`));
    } catch (e) {
      this._pvForecastError = e.message;
      this._pvForecastBackoffUntil = now + PV_FORECAST_BACKOFF_MS;
      if (!this._pvForecastLoggedErr) {
        this.log(`[EMS] PV forecast fetch failed (backing off ${Math.round(PV_FORECAST_BACKOFF_MS / 3600000)} h): ${e.message}`);
        this._pvForecastLoggedErr = true;
      }
    }
  },

  // Parse the config's resource-id field into a list. Accepts a single id or several
  // separated by comma / semicolon / whitespace / newline (north + south roof, etc.).
  _solcastResourceIds(cfg) {
    return String((cfg && cfg.solcast_resource_id) || '')
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  },

  // Pure: sum several parsed forecasts into one, aligned by slot end-time. Solcast uses
  // the same 30-min UTC grid for every site, so grouping by `end` lines them up. kw is
  // summed; the P10/P90 band is summed only where present on all sites, else null.
  _mergeForecastSlots(arrays) {
    if (arrays.length === 1) return arrays[0];
    const byEnd = new Map();
    for (const arr of arrays) {
      for (const s of arr) {
        const cur = byEnd.get(s.end);
        if (!cur) {
          byEnd.set(s.end, { end: s.end, kw: s.kw, kw10: s.kw10, kw90: s.kw90, h: s.h });
        } else {
          cur.kw  += s.kw;
          cur.kw10 = (cur.kw10 != null && s.kw10 != null) ? cur.kw10 + s.kw10 : null;
          cur.kw90 = (cur.kw90 != null && s.kw90 != null) ? cur.kw90 + s.kw90 : null;
        }
      }
    }
    return [...byEnd.values()].sort((a, b) => a.end - b.end);
  },

  // Raw HTTPS GET to the Solcast rooftop-site forecast endpoint (node https to match
  // lib/openapi-client.js style). Resolves the parsed JSON or rejects with a tagged error.
  _solcastGet(resourceId, apiKey) {
    return new Promise((resolve, reject) => {
      const url = new URL(`/rooftop_sites/${encodeURIComponent(resourceId)}/forecasts`, SOLCAST_BASE_URL);
      url.searchParams.set('format', 'json');
      url.searchParams.set('api_key', apiKey);
      const options = {
        hostname: url.hostname,
        port:     443,
        path:     url.pathname + url.search,
        method:   'GET',
        headers:  { Accept: 'application/json', 'User-Agent': 'Homey/FusionSolar-EMS' },
        timeout:  PV_FORECAST_TIMEOUT_MS,
      };
      const req = https.request(options, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          if (res.statusCode === 429) return reject(new Error('HTTP 429 rate limited (Solcast daily quota)'));
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 120).replace(/\s+/g, ' ').trim()}`));
          }
          try { resolve(JSON.parse(raw)); }
          catch (err) { reject(new Error(`invalid JSON: ${err.message}`)); }
        });
      });
      req.on('error',   (err) => reject(new Error(`network error: ${err.message}`)));
      req.on('timeout', ()    => { req.destroy(); reject(new Error('request timed out')); });
      req.end();
    });
  },

  // Pure: Solcast `{ forecasts: [...] }` → ascending [{ end:<ms>, kw, kw10, kw90, h }].
  // `pv_estimate*` are average AC power (kW) over the interval; `period` is an ISO-8601
  // duration (e.g. "PT30M"); `period_end` is the ISO timestamp at the end of the slot.
  _parseSolcastForecasts(json) {
    const list = json && Array.isArray(json.forecasts) ? json.forecasts : [];
    const out = [];
    for (const f of list) {
      const end = Date.parse(f.period_end);
      const kw  = Number(f.pv_estimate);
      if (!Number.isFinite(end) || !Number.isFinite(kw)) continue;
      out.push({
        end,
        kw,
        kw10: Number.isFinite(Number(f.pv_estimate10)) ? Number(f.pv_estimate10) : null,
        kw90: Number.isFinite(Number(f.pv_estimate90)) ? Number(f.pv_estimate90) : null,
        h:    this._pvPeriodHours(f.period),
      });
    }
    out.sort((a, b) => a.end - b.end);
    return out;
  },

  // Pure: ISO-8601 duration "PT30M" / "PT1H" → hours (default 0.5 h).
  _pvPeriodHours(period) {
    const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(period || '');
    if (!m) return 0.5;
    const h = (parseInt(m[1], 10) || 0) + (parseInt(m[2], 10) || 0) / 60;
    return h > 0 ? h : 0.5;
  },

  // Pure: expected energy (kWh) from forecast slots whose end falls in (fromMs, toMs].
  _pvSumKwh(slots, fromMs, toMs) {
    if (!Array.isArray(slots)) return 0;
    let kwh = 0;
    for (const s of slots) {
      if (s.end > fromMs && s.end <= toMs) kwh += s.kw * s.h;
    }
    return kwh;
  },

  // Pure: ms remaining until the next local midnight in the given timezone. From the real
  // next midnight (lib/local-time.js) — 86 400 s minus the time gone is wrong by an hour
  // on the two days a year that are not 24 hours long (1.2.299).
  _pvMsUntilLocalMidnight(nowMs, tz) {
    try {
      return localTime.nextLocalMidnight(localTime.safeTz(tz), nowMs) - nowMs;
    } catch (e) {
      return 0;
    }
  },

  // The forecast is "stale" when there is none, or the last successful fetch is older than
  // PV_FORECAST_STALE_MS (fetches have been failing for a long time). While stale the
  // aggregation helpers all return 0, so flow conditions stay conservative and the device
  // capabilities read as unknown rather than showing confident but outdated numbers.
  _pvForecastStale(nowMs = Date.now()) {
    return !this._pvForecast
      || !this._pvForecastFetchedAt
      || (nowMs - this._pvForecastFetchedAt) > PV_FORECAST_STALE_MS;
  },

  // Expected PV energy (kWh) from now until local midnight tonight.
  _pvForecastRemainingTodayKwh(nowMs = Date.now()) {
    if (this._pvForecastStale(nowMs)) return 0;
    const tz  = this.homey?.clock?.getTimezone?.() || 'UTC';
    const end = nowMs + this._pvMsUntilLocalMidnight(nowMs, tz);
    return this._pvSumKwh(this._pvForecast, nowMs, end);
  },

  // Expected PV energy (kWh) over the next `hours` hours.
  _pvForecastNextKwh(hours, nowMs = Date.now()) {
    if (this._pvForecastStale(nowMs)) return 0;
    return this._pvSumKwh(this._pvForecast, nowMs, nowMs + hours * 3600_000);
  },

  // Pure: ms from nowMs until the local wall-clock time HH:MM today, in the given
  // timezone. 0 if the time has already passed today (or the input is invalid).
  _pvMsUntilLocalTime(nowMs, tz, cutoff) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(cutoff || '').trim());
    if (!m) return 0;
    const targetSecs = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60;
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(new Date(nowMs));
      const get = (t) => parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
      let h = get('hour'); if (h === 24) h = 0;
      const nowSecs = h * 3600 + get('minute') * 60 + get('second');
      const diff = targetSecs - nowSecs;
      return diff > 0 ? diff * 1000 : 0;
    } catch (e) {
      return 0;
    }
  },

  // Expected PV energy (kWh) from now until the given local time HH:MM today.
  // Returns 0 once that cutoff has passed for the day.
  _pvForecastUntilKwh(cutoff, nowMs = Date.now()) {
    if (this._pvForecastStale(nowMs)) return 0;
    const tz = this.homey?.clock?.getTimezone?.() || 'UTC';
    const ms = this._pvMsUntilLocalTime(nowMs, tz, cutoff);
    if (ms <= 0) return 0;
    return this._pvSumKwh(this._pvForecast, nowMs, nowMs + ms);
  },

  // Expected PV energy (kWh) over the whole next local calendar day (tomorrow).
  _pvForecastTomorrowKwh(nowMs = Date.now()) {
    if (this._pvForecastStale(nowMs)) return 0;
    const tz   = this.homey?.clock?.getTimezone?.() || 'UTC';
    const from = nowMs + this._pvMsUntilLocalMidnight(nowMs, tz); // next local midnight
    return this._pvSumKwh(this._pvForecast, from, from + 24 * 3600_000);
  },

  // Forecast power (kW) for the slot currently in progress (first slot ending after now).
  _pvForecastNowKw(nowMs = Date.now()) {
    if (this._pvForecastStale(nowMs)) return 0;
    const s = this._pvForecast.find((x) => x.end > nowMs);
    return s ? s.kw : 0;
  },

  // Forward-looking conservation gate: on a poor-forecast day with a battery, hold off
  // STARTING simple devices (heat pump / boiler / pool / dehumidifier) so the battery keeps
  // enough charge for the evening/night. Returns true when new starts should be suppressed.
  // Never active without a configured battery, a threshold, AND a fresh forecast — so a
  // missing/stale forecast falls back to normal behaviour (never over-conserves blindly).
  //   mode 'manual'   → block when remaining-today forecast < forecast_gate_kwh
  //   mode 'adaptive' → block when it can't refill the battery to 100% (capacity + SoC)
  _forecastGateBlocksStarts(cfg, battery, nowMs = Date.now()) {
    return this._forecastGateState(cfg, battery, nowMs).blocked;
  },

  /**
   * The same decision with its arithmetic exposed, so the history can say WHY.
   *
   * "Starts are being held back" is only half an answer; the half that lets someone check
   * the setting is "3.1 kWh left today, 8.4 kWh needed to fill the battery". Returns
   * blocked:false with null figures whenever the gate cannot apply at all.
   */
  _forecastGateState(cfg, battery, nowMs = Date.now()) {
    // `reason` distinguishes the several ways the gate can be inactive, which the settings
    // page shows instead of a bare "off" — "no Solcast forecast yet" and "the forecast is
    // ample" look identical from the outside and want very different reactions.
    const inactive = (reason) => ({ blocked: false, mode: 'off', reason, remainingKwh: null, thresholdKwh: null });
    const mode = cfg.forecast_gate_mode || 'off';
    if (mode === 'off') return inactive('mode_off');
    if (!(cfg.battery_devices || []).length) return inactive('no_battery');
    if (this._pvForecastStale(nowMs)) return inactive('forecast_stale');

    const remaining = this._pvForecastRemainingTodayKwh(nowMs);
    let threshold;
    if (mode === 'adaptive') {
      // Sum capacity across all configured batteries — matches battery.soc, which is
      // already an aggregate (the minimum SOC across all batteries) treating the whole
      // bank as one logical battery (see device.js _getBattery).
      const cap = (cfg.battery_devices || []).reduce((s, d) => s + this._capacityKwhFor(d), 0);
      if (cap <= 0) return inactive('no_capacity');
      if (battery.soc === null || battery.soc === undefined) return inactive('no_soc');
      threshold = Math.max(0, ((100 - battery.soc) / 100) * cap); // kWh to refill battery to full
    } else { // 'manual'
      threshold = Number(cfg.forecast_gate_kwh) || 0;
      if (threshold <= 0) return inactive('no_threshold');
    }
    // Hysteresis: closing uses the bare deficit, reopening demands a margin on top. The
    // asymmetry is deliberate — closing protects the battery and may be prompt, reopening
    // starts loads whose own draw slows the charging and grows the deficit, so an opening
    // at the exact crossing revokes itself (measured; see FORECAST_GATE_HYSTERESIS_KWH).
    const wasBlocked = this._forecastGateWasOn();
    const reopenAt   = threshold + FORECAST_GATE_HYSTERESIS_KWH;
    const blocked    = remaining < (wasBlocked ? reopenAt : threshold);
    return {
      blocked,
      mode,
      // 'hysteresis' is the band where the bare comparison would open but the margin holds:
      // the settings box must say "reopens from X" there, or it shows remaining ≥ needed
      // next to the word "blocked" and looks broken.
      reason: blocked ? (remaining < threshold ? 'below' : 'hysteresis') : 'above',
      remainingKwh: Math.round(remaining * 10) / 10,
      thresholdKwh: Math.round(threshold * 10) / 10,
      reopenAtKwh:  Math.round(reopenAt * 10) / 10,
    };
  },

  // The last announced gate state, lazily read back from the persisted history on first
  // use — the history is the very thing the announcements are written into, so the two
  // cannot drift apart, and a restart cannot re-announce a gate that closed at noon.
  // Shared by _forecastGateState (hysteresis) and _announceForecastGate (transitions).
  _forecastGateWasOn() {
    if (this._forecastGateOn === undefined) {
      const last = [...(this._emsHistory || [])].reverse()
        .find((e) => e.event === 'forecast_gate_on' || e.event === 'forecast_gate_off');
      this._forecastGateOn = last ? last.event === 'forecast_gate_on' : false;
    }
    return this._forecastGateOn;
  },

  /**
   * The gate's state plus the figures it was derived from, for the settings page.
   *
   * Deliberately computed here rather than re-derived in the browser: the neighbouring
   * surplus-ramp preview does recompute, and that duplicated formula has already drifted
   * once. This one reports what the EMS actually decided, so the box cannot disagree with
   * the device. The cost is that it reflects the SAVED configuration — a dropdown changed
   * but not saved is not what is deciding anything.
   */
  _forecastGateDiag(cfg, socPct, nowMs = Date.now()) {
    const state = this._forecastGateState(cfg, { soc: socPct }, nowMs);
    // The same accessor as the gate itself: a diagnosis that computes the number a
    // different way is a diagnosis that can disagree with what is actually deciding.
    const cap = (cfg.battery_devices || []).reduce((s, d) => s + this._capacityKwhFor(d), 0);
    return {
      ...state,
      configuredMode: cfg.forecast_gate_mode || 'off',
      socPct: socPct === undefined ? null : socPct,
      capacityKwh: Math.round(cap * 10) / 10,
    };
  },

  /**
   * Writes the gate's on/off transitions to the EMS history.
   *
   * Called once per tick from the tick body — not from the consumers, which ask the
   * predicate several times each tick and would each want to be the one to announce it.
   *
   * The state is derived from forecast + SOC + config, so a restart recomputes it and
   * would re-announce a gate that has been closed since noon. Rather than persist a second
   * flag, the last announced state is read back from the history itself on first use — the
   * history is already persisted, and it is the very thing this is written into, so the two
   * cannot drift apart.
   */
  _announceForecastGate(cfg, battery, nowMs = Date.now()) {
    const { blocked, remainingKwh, thresholdKwh } = this._forecastGateState(cfg, battery, nowMs);
    if (blocked === this._forecastGateWasOn()) return false;

    this._forecastGateOn = blocked;
    const figures = remainingKwh !== null && thresholdKwh !== null
      ? `${remainingKwh} / ${thresholdKwh} kWh` : '';
    this.log(`[EMS] solar-forecast gate ${blocked ? 'closed' : 'open'}`
      + (figures ? ` — ${remainingKwh} kWh forecast left today vs ${thresholdKwh} kWh needed` : ''));
    this._addHistoryEvent(HIST.SYSTEM, blocked ? 'forecast_gate_on' : 'forecast_gate_off', figures);
    return true;
  },

  // Solcast is "configured" only when enabled with an API key and at least one site.
  _pvForecastConfigured(cfg) {
    return !!(cfg && cfg.pv_forecast_enabled === true
      && (cfg.solcast_api_key || '').trim()
      && this._solcastResourceIds(cfg).length);
  },

  // Add/remove the three forecast capabilities so they appear on the device only while
  // Solcast is configured. Called from onInit and onConfigChanged.
  async _syncPvForecastCapabilities(cfg) {
    const want = this._pvForecastConfigured(cfg);
    for (const c of ['pv_forecast_today', 'pv_forecast_tomorrow', 'pv_forecast_now']) {
      try {
        if (want && !this.hasCapability(c)) await this.addCapability(c);
        else if (!want && this.hasCapability(c)) await this.removeCapability(c);
      } catch (e) { this.log(`[EMS] pv cap ${c}: ${e.message}`); }
    }
  },

  // Recompute the forecast capability values from the cached slots (cheap, no API call).
  // No-op when the capabilities aren't present (Solcast not configured).
  async _updatePvForecastCapabilities(nowMs = Date.now()) {
    if (!this.hasCapability('pv_forecast_today')) return;
    // Stale forecast → show the capabilities as unknown (null) rather than a confident 0.
    const stale = this._pvForecastStale(nowMs);
    const today = stale ? null : Math.round(this._pvForecastRemainingTodayKwh(nowMs) * 10) / 10;
    const tomo  = stale ? null : Math.round(this._pvForecastTomorrowKwh(nowMs) * 10) / 10;
    const now   = stale ? null : Math.round(this._pvForecastNowKw(nowMs) * 100) / 100;
    await this.setCapabilityValue('pv_forecast_today', today).catch(() => {});
    await this.setCapabilityValue('pv_forecast_tomorrow', tomo).catch(() => {});
    await this.setCapabilityValue('pv_forecast_now', now).catch(() => {});
  },

  // Compact status used by getEmsDiag() (no per-slot array).
  _pvForecastSummary(nowMs = Date.now()) {
    const cfg        = this._getConfig();
    const enabled    = cfg.pv_forecast_enabled === true;
    const ids        = this._solcastResourceIds(cfg);
    const configured = !!(cfg.solcast_api_key && ids.length);
    const slots      = this._pvForecast || [];
    const future     = slots.filter((s) => s.end > nowMs);
    return {
      enabled,
      configured,
      stale:             this._pvForecastStale(nowMs),
      sites:             ids.length,
      fetchedAt:         this._pvForecastFetchedAt || null,
      ageMin:            this._pvForecastFetchedAt ? Math.round((nowMs - this._pvForecastFetchedAt) / 60000) : null,
      error:             this._pvForecastError || null,
      slotCount:         future.length,
      nowKw:             Math.round(this._pvForecastNowKw(nowMs) * 100) / 100,
      remainingTodayKwh: Math.round(this._pvForecastRemainingTodayKwh(nowMs) * 10) / 10,
      tomorrowKwh:       Math.round(this._pvForecastTomorrowKwh(nowMs) * 10) / 10,
      next6hKwh:         Math.round(this._pvForecastNextKwh(6, nowMs) * 10) / 10,
      peakKw:            future.length ? Math.round(Math.max(...future.map((s) => s.kw)) * 100) / 100 : null,
    };
  },

  // Full payload for the API route (summary + raw slots) — read by /ems/pv-forecast.
  //
  // While the forecast is stale the aggregation helpers return 0 by design (flow conditions
  // stay conservative), and the widget printed that as "now 0.00 kW" above a chart of the
  // old forecast. An old forecast has no figure for now: the payload says null (1.2.299).
  // The summary itself keeps its zeros — the forecast-updated trigger's tokens are numbers.
  getPvForecast() {
    const s = this._pvForecastSummary();
    if (s.stale) {
      for (const k of ['nowKw', 'remainingTodayKwh', 'tomorrowKwh', 'next6hKwh']) s[k] = null;
    }
    return { ...s, slots: this._pvForecast || [] };
  },

};
