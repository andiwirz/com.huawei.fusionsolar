'use strict';

// Electricity price, scheduled-flow tasks and the off-peak window. Mixed into
// EmsDevice.prototype; `this` is the device instance. See device.js.
const tariffZones = require('./tariff-zones');
const localTime   = require('../local-time');
const { SCHEDULER_CATCHUP_MS } = require('./constants');

// What the settings page stores: an <input type="time"> value, 'HH:MM'.
const TASK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const pad2 = (n) => String(n).padStart(2, '0');

// A local minute, as the scheduler compares it.
function minuteOf(tz, ms) {
  const p = localTime.localParts(tz, ms);
  const date = `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
  return {
    date, key: `${date} ${pad2(p.hh)}:${pad2(p.mi)}`, y: p.y, m: p.m, d: p.d,
    dayOfWeek: new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay(),
  };
}

module.exports = {

  /**
   * Runs the user's scheduled flows (Scheduler tab).
   *
   * A task used to run only when a tick happened to land in its exact minute. A 60 s tick
   * that drifts by a fraction of a second steps over a minute every so often, a tick that
   * runs long or is skipped steps over several, and a tick that throws before this phase
   * never gets here at all — the task was then gone for the day, with nothing in the log
   * (review 2026-10-10). Each check now covers every minute since the previous check, back
   * at most SCHEDULER_CATCHUP_MS, and runs what fell due in between. A task runs once per
   * date and time: `_schedulerFired` keeps the occurrence it last ran.
   *
   * Minutes are compared as local 'YYYY-MM-DD HH:MM' strings, which sort as time does. That
   * also settles both clock changes: in spring the clocks jump from 02:00 to 03:00, and a
   * task set inside that hour runs at 03:00 instead of not at all; in autumn the hour from
   * 02:00 repeats, and a task in it still runs once, the first time round.
   */
  async _checkScheduler(cfg, now = Date.now()) {
    const since = this._schedulerCheckedAt;
    this._schedulerCheckedAt = now;
    const tasks = Array.isArray(cfg.scheduled_tasks) ? cfg.scheduled_tasks : [];
    if (!tasks.length) return;
    // Wall-clock time in the Homey timezone — Node runs UTC on Homey Pro, so
    // getHours()/getDay() would fire tasks 1–2 h off (same pattern as _offpeakWindow).
    const tz = localTime.safeTz(this.homey.clock?.getTimezone?.());
    // The first check, or one after the clock moved back, looks at the current minute only —
    // which is all the old check ever did.
    const from = (typeof since === 'number' && since <= now) ? Math.max(since, now - SCHEDULER_CATCHUP_MS) : now;
    const first = minuteOf(tz, from);
    const last  = minuteOf(tz, now);
    // Five minutes span at most two dates.
    const days  = first.date === last.date ? [last] : [first, last];
    for (const task of tasks) {
      if (!task || !task.enabled || !task.flow_id || !TASK_TIME.test(String(task.time))) continue;
      for (const day of days) {
        // The window includes the minute of the previous check: a task saved for the current
        // minute just after a check still runs, as it did before. The occurrence key keeps
        // that from running anything twice.
        const key = `${day.date} ${task.time}`;
        if (key < first.key || key > last.key) continue;
        if (this._schedulerFired.get(task.id) === key) continue;
        const shouldFire = task.type === 'daily' ||
          (task.type === 'weekday' && Array.isArray(task.weekdays) && task.weekdays.includes(day.dayOfWeek));
        if (!shouldFire) continue;
        this._schedulerFired.set(task.id, key);
        const [hh, mi] = task.time.split(':').map(Number);
        const lateS = Math.round((now - localTime.localToEpoch(tz, day.y, day.m, day.d, hh, mi)) / 1000);
        this.log(`[EMS] Scheduler: "${task.name}" → flow ${task.flow_id}`
          + (lateS >= 60 ? ` (caught up, ${lateS} s after ${task.time})` : ''));
        this._api.triggerFlow(task.flow_id).catch((err) =>
          this.error(`[EMS] Scheduler: "${task.name}" trigger failed: ${err.message}`));
      }
    }
  },

  // Local wall-clock parts in the Homey timezone (Node runs UTC on Homey Pro).
  // dateMs defaults to now, but accepts an arbitrary timestamp so callers can ask
  // "what would the wall-clock be at this future point" (used to build a dual-tariff
  // timeline for the EMS Forecast widget — see _dualTariffPriceAt).
  _priceWallClock(dateMs = Date.now()) {
    const tz = this.homey.clock?.getTimezone?.() || 'UTC';
    if (!this._priceFmt || this._priceFmtTz !== tz) {
      this._priceFmt   = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' });
      this._priceFmtTz = tz;
    }
    const d         = new Date(dateMs);
    const parts     = Object.fromEntries(this._priceFmt.formatToParts(d).map((p) => [p.type, p.value]));
    const dayOfWeek = ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })[parts.weekday] ?? d.getDay();
    const minutes   = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
    return { dayOfWeek, minutes };
  },

  /**
   * What one exported kWh earns, or null when the user has not said.
   *
   * Applies to every price mode: the compensation for feeding in is a separate contract
   * from the tariff for drawing, so it is not one of the mode's own fields.
   *
   * The null/zero distinction is load-bearing and not pedantry. Unset means we do not know
   * what a self-consumed solar kWh was worth — which is exactly the state every install was
   * in before this existed, so they must keep behaving as they did. Zero is a real answer:
   * some contracts pay nothing, and then a solar kWh genuinely costs nothing, which is worth
   * saying out loud rather than leaving as an absence.
   *
   * Negative is refused rather than honoured. Paying to export happens on spot-priced
   * contracts, but this is the field for a flat rate, and a stray minus sign would quietly
   * turn every sunny charge session into a profit.
   */
  _feedInTariff(cfg) {
    const raw = (cfg && cfg.price_config) ? cfg.price_config.price_feed_in : undefined;
    if (raw === undefined || raw === null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  },

  // Returns the current price per kWh (number) or null when unknown.
  //   fixed    → price_fixed
  //   dual     → high_windows[today] decides high vs low (cross-midnight supported)
  //   zones    → the zone covering this minute, else zones_default_price
  //   variable → last value set via the ems_set_electricity_price flow
  //   forecast → current slot of the price forecast (D10), fed via ems_set_price_forecast
  _getCurrentPrice(cfg) {
    const pc   = cfg.price_config || {};
    const mode = pc.mode || 'fixed';
    if (mode === 'zones') {
      // To the minute, not to the hour. The slots the decisions run on are hourly, but what
      // is DISPLAYED as the price right now should be what the schedule says right now — a
      // tile that still reads "low" at 17:30 because the slot began at 17:00 would be wrong
      // in the one place a user checks it against their own bill.
      const { dayOfWeek, minutes } = this._priceWallClock();
      return tariffZones.priceAt(pc, dayOfWeek, minutes);
    }
    if (mode === 'variable') return typeof this._variablePrice === 'number' ? this._variablePrice : null;
    if (mode === 'forecast') {
      const fc = this._priceForecastSummary ? this._priceForecastSummary() : null;
      return (fc && !fc.stale && typeof fc.nowPrice === 'number') ? fc.nowPrice : null;
    }
    if (mode === 'fixed')    return Number(pc.price_fixed) || 0;
    // dual tariff
    const { isHigh } = this._dualTariffWindow(cfg);
    return isHigh ? (Number(pc.price_high) || 0) : (Number(pc.price_low) || 0);
  },

  // Whether the dual ("Low / high tariff") price window is currently in its HIGH
  // period, and whether a dual schedule is actually configured at all (mode==='dual'
  // with at least one weekday window set) — used both for the displayed price above
  // and by chargers in "Solar & low tariff" mode (chargerControl.js) to know when to
  // charge, independent of the separate fixed Off-Peak Charging schedule.
  _dualTariffWindow(cfg, dateMs = Date.now()) {
    const pc = cfg.price_config || {};
    const windows = pc.high_windows || {};
    const configured = pc.mode === 'dual' && Object.values(windows).some((w) => w && w.start && w.end);
    const { dayOfWeek, minutes } = this._priceWallClock(dateMs);
    const win = windows[dayOfWeek] || windows[String(dayOfWeek)];
    let isHigh = false;
    if (win && win.start && win.end) {
      const s = this._parseTime(win.start);
      const e = this._parseTime(win.end);
      if (s !== null && e !== null) isHigh = s > e ? (minutes >= s || minutes < e) : (minutes >= s && minutes < e);
    }
    return { configured, isHigh };
  },

  // Dual-tariff price at an arbitrary point in time (not just "now") — used to build
  // a 24h timeline for the EMS Forecast widget's price chart.
  _dualTariffPriceAt(cfg, dateMs) {
    const pc = cfg.price_config || {};
    const { isHigh } = this._dualTariffWindow(cfg, dateMs);
    return isHigh ? (Number(pc.price_high) || 0) : (Number(pc.price_low) || 0);
  },

  // Widget-facing price status: shape depends on the configured tariff model, so the
  // EMS Forecast widget can show whatever is actually configured instead of assuming
  // "Price forecast" mode. fixed/variable → a single current value (no future is known
  // — a variable price only changes when a flow pushes a new one). dual → a 24h hourly
  // timeline built from today's/tomorrow's high/low windows, same {start,end,price}
  // slot shape as the real forecast so the widget can reuse one chart renderer.
  // forecast → the existing D10 price-forecast payload, unchanged.
  getEmsPriceStatus() {
    const cfg = this._getConfig();
    const pc = cfg.price_config || {};
    const mode = pc.mode || 'fixed';
    const currency = pc.currency || 'CHF';
    const base = { mode, currency };

    if (mode === 'fixed') {
      // configured, so the widget can tell "no price entered" from a price of 0 — it showed
      // "0.000 CHF/kWh · Fixed price" for an installation that never set one (1.2.299).
      return { ...base, price: Number(pc.price_fixed) || 0, configured: Number(pc.price_fixed) > 0 };
    }
    if (mode === 'variable') {
      return { ...base, price: typeof this._variablePrice === 'number' ? this._variablePrice : null };
    }
    if (mode === 'zones') {
      const now   = Date.now();
      const slots = tariffZones.slotsBetween(pc, now, now + 24 * 3600_000, (ms) => this._priceWallClock(ms));
      const { dayOfWeek, minutes } = this._priceWallClock(now);
      const zone = tariffZones.resolveZone(pc, dayOfWeek, minutes);
      return {
        ...base,
        price: tariffZones.priceAt(pc, dayOfWeek, minutes),
        zoneName: zone?.name || null,
        configured: tariffZones.zonesConfigured(pc),
        slots,
      };
    }
    if (mode === 'dual') {
      const now = Date.now();
      const slots = [];
      for (let i = 0; i < 24; i++) {
        const start = now + i * 3600_000;
        slots.push({ start, end: start + 3600_000, price: this._dualTariffPriceAt(cfg, start) });
      }
      return {
        ...base,
        priceLow:  Number(pc.price_low)  || 0,
        priceHigh: Number(pc.price_high) || 0,
        configured: this._dualTariffWindow(cfg, now).configured,
        slots,
      };
    }
    // forecast
    return { ...base, ...this.getPriceForecast() };
  },

  // Sets the capability's unit label to "<currency>/kWh" (best-effort).
  async _applyPriceCurrencyUnit(cfg) {
    const currency = (cfg.price_config && cfg.price_config.currency) || 'CHF';
    if (this._priceUnitApplied === currency) return;
    this._priceUnitApplied = currency;
    try { await this.setCapabilityOptions('measure_electricity_price', { units: `${currency}/kWh` }); }
    catch (e) { /* older Homey without runtime options — value still shows */ }
  },

  async _updatePriceCapability(cfg) {
    const price = this._getCurrentPrice(cfg);
    if (price === null) return;
    const rounded = Math.round(price * 1000) / 1000;
    if (rounded !== this._lastPriceFired) {
      this._lastPriceFired = rounded;
      await this._set('measure_electricity_price', rounded);
    }
  },

  // Returns { active: bool, amps: number } for the current off-peak window.
  // Supports separate weekday vs weekend windows; timezone-aware via Homey clock.
  _offpeakWindow(cfg) {
    const tz  = this.homey.clock?.getTimezone?.() || 'UTC';
    if (!this._offpeakFmt || this._offpeakFmtTz !== tz) {
      this._offpeakFmt   = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' });
      this._offpeakFmtTz = tz;
    }
    const fmt = this._offpeakFmt;
    const parts  = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
    const t      = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
    const isWeekend = parts.weekday === 'Sat' || parts.weekday === 'Sun';
    const useWeekend = cfg.offpeak_weekend_differs === true && isWeekend;

    const startKey = useWeekend ? 'offpeak_weekend_start' : 'offpeak_start';
    const endKey   = useWeekend ? 'offpeak_weekend_end'   : 'offpeak_end';
    const s = this._parseTime(cfg[startKey] || '22:00');
    const e = this._parseTime(cfg[endKey]   || '06:00');
    if (s === null || e === null) return { active: false, amps: 16 };

    const active = s > e ? (t >= s || t < e) : (t >= s && t < e);
    return { active, amps: parseInt(cfg.offpeak_amps ?? 16, 10) };
  },

  _parseTime(str) {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(str ?? '').trim());
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
  },

};
