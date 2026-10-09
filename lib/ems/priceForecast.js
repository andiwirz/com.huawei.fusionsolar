'use strict';

const localTime = require('../local-time');

// Electricity price forecast + deadline-based "should I charge now" decision (D10).
// Mixed into EmsDevice.prototype; `this` is the device instance.
//
// Unlike the Solcast PV forecast, this is PUSH-based: the user wires a flow from
// their price app (e.g. "Power by the Hour", Tibber, any day-ahead price source)
// to the `ems_set_price_forecast` action, which calls _ingestPriceForecast(). No
// active fetch, so no rate limit — staleness here just detects a broken/removed
// source flow, not a quota problem.
//
// The core idea (inspired by evcc's charge planner): for a car with a configured
// "ready by" deadline and target SoC, first net off what the Solcast PV forecast
// will deliver by then; only the REMAINING energy is planned against the cheapest
// price slots before the deadline (with a short "precondition" block guaranteed
// right before the deadline, and a fail-safe: if price data is stale/missing, charge
// continuously so the car is never stranded just because the price flow broke).

const { PRICE_FORECAST_STALE_MS, PRICE_SLOT_HOURS, PRICE_BATTERY_LOOKAHEAD_MS, PRICE_FORECAST_STALE_NOTIFY_MS } = require('./constants');
const tariffZones = require('./tariff-zones');

module.exports = {

  async _restorePriceForecast() {
    this._priceForecast          = null; // [{ start:<ms>, end:<ms>, price:<num> }] ascending, or null
    this._priceForecastUpdatedAt = null; // ms of last ingest
    this._priceForecastStaleNotified = false; // one-shot guard for _checkPriceForecastStaleness
    try {
      const stored = await this.getStoreValue('priceForecast');
      if (stored && Array.isArray(stored.slots)) {
        this._priceForecast          = stored.slots;
        this._priceForecastUpdatedAt = stored.updatedAt || null;
      }
    } catch (e) { /* ignore */ }
  },

  // Parses a JSON array of hourly prices (as emitted by "Power by the Hour"'s
  // `new_prices` trigger, or any similar day-ahead price app) and merges it into the
  // stored forecast so 'this_day' / 'tomorrow' / 'next_hours' pushes all coexist and
  // overlapping slots are simply overwritten.
  //   period: 'this_day' | 'tomorrow' | 'next_hours' (anchors the array's first slot)
  async _ingestPriceForecast(pricesJson, period, nowMs = Date.now()) {
    let arr;
    try { arr = JSON.parse(pricesJson); } catch (e) { throw new Error(`invalid prices JSON: ${e.message}`); }
    if (!Array.isArray(arr) || !arr.length) throw new Error('prices must be a non-empty array');

    const tz     = this.homey?.clock?.getTimezone?.() || 'UTC';
    const anchor = this._priceForecastAnchor(nowMs, tz, period);
    const slotMs = PRICE_SLOT_HOURS * 3600_000;

    const fresh = [];
    for (let i = 0; i < arr.length; i++) {
      const price = Number(arr[i]);
      if (!Number.isFinite(price)) continue;
      const start = anchor + i * slotMs;
      fresh.push({ start, end: start + slotMs, price });
    }
    // Replace by proximity, not exact-key match: two ingests for the "same" hour can
    // land a few hundred ms apart (anchor computed from the exact Date.now() of each
    // flow run) — a ±2s tolerance self-heals any such near-duplicates (including ones
    // already sitting in the store from before this was fixed) without touching
    // genuinely different, adjacent hours (3.6M ms apart, far outside the tolerance).
    const DRIFT_TOLERANCE_MS = 2000;
    const kept = (this._priceForecast || [])
      .filter((s) => !fresh.some((f) => Math.abs(f.start - s.start) <= DRIFT_TOLERANCE_MS));
    const byStart = new Map([...kept, ...fresh].map((s) => [s.start, s]));
    // Drop slots that ended more than a day ago — keeps the store from growing forever.
    const cutoff = nowMs - 24 * 3600_000;
    const slots = [...byStart.values()].filter((s) => s.end > cutoff).sort((a, b) => a.start - b.start);

    this._priceForecast          = slots;
    this._priceForecastUpdatedAt = nowMs;
    await this.setStoreValue('priceForecast', { slots, updatedAt: nowMs }).catch(() => {});
    this.log(`[EMS] Price forecast ingested (${period}): ${arr.length} slot(s), ${slots.length} total cached`);
  },

  // Pure: anchor time (ms) for the first element of a pushed price array.
  // Reuses pvForecast.js's already-tested _pvMsUntilLocalMidnight instead of
  // reimplementing local-midnight arithmetic (DST-safe by construction).
  _priceForecastAnchor(nowMs, tz, period) {
    if (period === 'this_day' || period === 'tomorrow') {
      // _pvMsUntilLocalMidnight only accounts for whole hour/minute/second, so it
      // preserves nowMs's own sub-second remainder untouched. Two ingests moments
      // apart (different ms remainder) would then anchor to midnight timestamps a
      // few hundred ms apart — same calendar hour, different `start` key — so the
      // Map-based dedup in _ingestPriceForecast never collides and slots pile up
      // (observed as the slot count doubling on every re-trigger). Flooring to
      // whole seconds first makes the midnight anchor exactly reproducible all day.
      const nowSec = Math.floor(nowMs / 1000) * 1000;
      const nextMidnightMs = nowSec + this._pvMsUntilLocalMidnight(nowSec, tz); // start of tomorrow, local
      // Not "tomorrow minus 24 h": on a clock-change day that lands an hour off (1.2.299).
      const todayMidnightMs = localTime.startOfLocalDay(localTime.safeTz(tz), nowSec);
      return period === 'tomorrow' ? nextMidnightMs : todayMidnightMs;
    }
    // 'next_hours' (or unknown) → floor to the start of the current local hour.
    return this._priceFloorToHour(nowMs, tz);
  },

  // Pure: floor a ms timestamp to the start of its local hour in `tz`. Subtracting the
  // local minutes/seconds-into-hour from the absolute ms lands on the hour boundary
  // correctly regardless of the zone's UTC offset (including half/quarter-hour zones).
  _priceFloorToHour(ts, tz) {
    // Floor to whole seconds first — otherwise ts's own sub-second remainder survives
    // into the result, so two calls within the same hour but different milliseconds
    // (e.g. repeated manual flow test-runs) would return slightly different "same
    // hour" boundaries and defeat the start-keyed dedup in _ingestPriceForecast.
    const tsSec = Math.floor(ts / 1000) * 1000;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(tsSec));
    const get = (t) => parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
    return tsSec - (get('minute') * 60 + get('second')) * 1000;
  },

  // The forecast is "stale" when there is none, or nothing has been pushed for a
  // long time (the source flow likely broke or was removed).
  /**
   * Whether there is no usable price timeline to decide on.
   *
   * A tariff-zone schedule is never stale. It is a standing configuration, not a feed: it
   * cannot stop arriving, so the age check that guards against a removed or broken source
   * flow has nothing to guard here. Without this, every price decision would sit out on a
   * zone schedule — which is the same as not having built it.
   */
  _priceForecastStale(nowMs = Date.now()) {
    if (this._tariffZoneConfig()) return false;
    return !this._priceForecast
      || !this._priceForecastUpdatedAt
      || (nowMs - this._priceForecastUpdatedAt) > PRICE_FORECAST_STALE_MS;
  },

  /**
   * The price_config when the tariff-zone model is selected AND usable, else null.
   *
   * The single place that answers "are we on zones", so the seams below and the staleness
   * check above cannot come to different conclusions.
   */
  _tariffZoneConfig() {
    let pc;
    try { pc = this._getConfig()?.price_config; } catch { return null; }
    if (!pc || pc.mode !== 'zones') return null;
    const usable = tariffZones.zonesConfigured(pc)
      || Number.isFinite(Number(pc.zones_default_price));
    return usable ? pc : null;
  },

  // Proactive one-shot notification when a forecast that WAS being fed goes stale for
  // a long time (PRICE_FORECAST_STALE_NOTIFY_MS, deliberately more conservative than
  // PRICE_FORECAST_STALE_MS itself) — catches a broken/removed source flow without
  // the user having to notice degraded charging behaviour or open Diagnostics.
  // Never fires for a forecast that was simply never configured (nothing to break).
  // Re-arms once fresh data arrives, so a later staleness episode notifies again.
  _checkPriceForecastStaleness(nowMs = Date.now()) {
    if (!this._priceForecastUpdatedAt) return; // never configured — nothing to notify about
    const ageMs = nowMs - this._priceForecastUpdatedAt;
    if (ageMs > PRICE_FORECAST_STALE_NOTIFY_MS) {
      if (this._priceForecastStaleNotified) return;
      this._priceForecastStaleNotified = true;
      const ageH = Math.round(ageMs / 3600_000);
      this.log(`[EMS] price forecast stale for ${ageH}h — notifying`);
      this._postNotification(`EMS: Preisprognose seit ${ageH}h nicht aktualisiert — preisoptimiertes Laden läuft durchgehend, bis neue Daten kommen.`);
    } else {
      this._priceForecastStaleNotified = false; // fresh again (or not stale long enough yet) — re-arm
    }
  },

  // Pure: slots overlapping [fromMs, toMs), ascending by start.
  /**
   * The hourly price slots covering a window, from whichever source is configured.
   *
   * This and _priceForecastStale above are the only two places the price decisions read
   * from, so making both understand tariff zones is the whole of wiring them in: battery
   * grid-charging, the peak-hour reserve, price-based EV charging and the negative-price
   * export limit all keep their rules and simply see different slots.
   */
  _priceSlotsBetween(fromMs, toMs) {
    const zoneCfg = this._tariffZoneConfig();
    if (zoneCfg) {
      return tariffZones.slotsBetween(zoneCfg, fromMs, toMs, (ms) => this._priceWallClock(ms));
    }
    if (!Array.isArray(this._priceForecast)) return [];
    return this._priceForecast
      .filter((s) => s.end > fromMs && s.start < toMs)
      .sort((a, b) => a.start - b.start);
  },

  // Pure: ms from nowMs until the next local occurrence of wall-clock time HH:MM —
  // today if it hasn't passed yet, otherwise tomorrow. (Different from pvForecast's
  // _pvMsUntilLocalTime, which returns 0 once passed — a charging deadline instead
  // rolls over to the next day, so this is computed independently rather than composed
  // from that 0-when-passed value.)
  _priceMsUntilDeadline(nowMs, tz, hhmm) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || '').trim());
    if (!m) return null;
    const targetSecs = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(nowMs));
    const get = (t) => parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
    let h = get('hour'); if (h === 24) h = 0;
    const nowSecs = h * 3600 + get('minute') * 60 + get('second');
    let diffSecs = targetSecs - nowSecs;
    if (diffSecs <= 0) diffSecs += 86400; // already passed today → next occurrence is tomorrow
    return diffSecs * 1000;
  },

  // Pure: pick slots to cover `hoursNeeded` of charging before the slots' horizon ends.
  // `precondition` (hours) is always included from the END of the horizon regardless of
  // price — a robustness margin in case the forecast/estimate is optimistic. Among the
  // remaining candidates, cheaper slots win; ties prefer the LATER slot (keeps the
  // battery/car topped up for less time, and preserves flexibility for a cheaper slot
  // that might still appear) — same heuristic evcc's planner uses.
  // Returns a Set of selected slot start times (ms).
  /**
   * The cheapest `hoursNeeded` hours out of `slots`.
   *
   * `preferEarlierOnTie` decides what happens between two hours of the SAME price, and the
   * two callers want opposite things:
   *
   *   A car has a deadline. Among equal prices the later hour is the better one — the car
   *   finishes nearer departure, and a price update in the meantime can still reveal
   *   something cheaper. Deferring is a real option, so ties go to the later slot.
   *
   *   A house battery has no deadline, and on a repeating tariff schedule the same cheap
   *   window comes round again every 24 hours. The lookahead therefore ALWAYS contains
   *   another copy of it, so "later wins" defers for ever and the battery never charges at
   *   the night rate at all — found by the tariff-zone tests, invisible on a day-ahead feed
   *   because exact ties are rare there. With nothing to wait for, earlier is strictly
   *   better: the energy is banked sooner and the hours after it stay free to react with.
   */
  _priceSelectCheapestSlots(slots, hoursNeeded, precondition = 0, preferEarlierOnTie = false) {
    const selected = new Set();
    if (!Array.isArray(slots) || !slots.length || hoursNeeded <= 0) return selected;

    const sorted = [...slots].sort((a, b) => a.start - b.start);
    let remaining = hoursNeeded;

    if (precondition > 0) {
      let need = precondition;
      for (let i = sorted.length - 1; i >= 0 && need > 0; i--) {
        selected.add(sorted[i].start);
        need -= PRICE_SLOT_HOURS;
        remaining -= PRICE_SLOT_HOURS;
      }
    }
    remaining = Math.max(0, remaining);
    if (remaining <= 0) return selected;

    const candidates = sorted
      .filter((s) => !selected.has(s.start))
      .sort((a, b) => (a.price - b.price)
        || (preferEarlierOnTie ? (a.start - b.start) : (b.start - a.start)));

    for (const s of candidates) {
      if (remaining <= 0) break;
      selected.add(s.start);
      remaining -= PRICE_SLOT_HOURS;
    }
    return selected;
  },

  // Pure: is the slot covering nowMs part of the selected set?
  _priceSlotSelectedNow(selected, slots, nowMs) {
    const cur = slots.find((s) => s.start <= nowMs && nowMs < s.end);
    return !!(cur && selected.has(cur.start));
  },

  // Pure: mirror of _priceSelectCheapestSlots for the home-battery discharge reserve —
  // picks the `hoursNeeded` most EXPENSIVE slots (discharge is prioritised/allowed only
  // during these; held back otherwise so capacity survives for the actual price peak).
  // Ties prefer the EARLIER slot — the opposite of the charge tie-break — so the
  // reserve favours claiming the peak as soon as it's identified rather than waiting.
  _priceSelectExpensiveSlots(slots, hoursNeeded) {
    const selected = new Set();
    if (!Array.isArray(slots) || !slots.length || hoursNeeded <= 0) return selected;
    const candidates = [...slots].sort((a, b) => (b.price - a.price) || (a.start - b.start));
    let remaining = hoursNeeded;
    for (const s of candidates) {
      if (remaining <= 0) break;
      selected.add(s.start);
      remaining -= PRICE_SLOT_HOURS;
    }
    return selected;
  },

  // Home-battery price control (evcc-style "battery grid charge" + peak-hour reserve).
  // Two independent decisions per battery, each opt-in via its own config on the
  // battery entry (cfg.battery_devices[]):
  //   charge — grid-charge to `price_target_soc`, using the cheapest slots within a
  //            rolling PRICE_BATTERY_LOOKAHEAD_MS window from now (same cheapest-slot
  //            algorithm as EV D10 charging, just without netting off solar — the
  //            battery already gets solar directly from the inverter, this is only
  //            about topping up from the grid when cheap). No fixed deadline: unlike
  //            an EV, a battery has no real "must be ready by" moment, so it's free to
  //            hold out for a genuinely cheaper hour instead of being forced to commit.
  //   hold   — reserve discharge for the `price_discharge_reserve_hours` most expensive
  //            upcoming hours (same rolling window); outside those, block discharge so
  //            the battery doesn't drain during merely-average prices and miss the peak.
  // Returns { mode: 'charge'|'hold'|'normal', reason, chargeSlots, reserveSlots } —
  // chargeSlots/reserveSlots are the full selected-slot lists (ascending, with price),
  // even when mode doesn't currently match them, so the settings UI can show "next
  // charge window" etc. without a second lookup. 'normal' + empty lists is the safe
  // default whenever anything is unconfigured, stale, or unknown — nothing changes.
  _batteryPriceMode(bd, socNow, cfg, nowMs = Date.now()) {
    const empty = { chargeSlots: [], reserveSlots: [] };
    if (!bd || !bd.price_charge_enabled) return { mode: 'normal', reason: 'price control disabled for this battery', ...empty };
    if (socNow === null) return { mode: 'normal', reason: 'battery SoC unknown', ...empty };
    if (this._priceForecastStale(nowMs)) return { mode: 'normal', reason: 'no price forecast — default battery behaviour', ...empty };

    const targetSoc    = Number(bd.price_target_soc ?? 90);
    const chargePowerW = Number(bd.price_charge_power_kw ?? 3) * 1000;
    const capacityKwh  = this._capacityKwhFor(bd);
    const horizonMs     = nowMs + PRICE_BATTERY_LOOKAHEAD_MS;

    // Solar gate (opt-in via price_solar_forecast_max_kwh, 0 = off). On a day the sun
    // will fill the battery anyway, buying the same kWh from the grid at 03:00 costs
    // money for nothing AND occupies the room the PV wanted — so when the expected
    // yield over the same lookahead window reaches the limit, grid charging is skipped.
    //
    // Deliberately a threshold, not a kWh subtraction like the EV path above: Solcast
    // forecasts GENERATION, while the battery only ever gets what the house doesn't
    // take first. Netting one against the other would look precise and be wrong; a
    // threshold is an honest coarse "sunny enough / not sunny enough".
    //
    // A stale forecast leaves the gate open, i.e. charges as before — same principle as
    // _priceShouldChargeNow: a broken data source must not quietly stop the battery from
    // doing the cheap thing.
    const solarLimitKwh = Math.max(0, Number(bd.price_solar_forecast_max_kwh) || 0);
    const solarKwh      = solarLimitKwh > 0 && !this._pvForecastStale(nowMs)
      ? this._pvSumKwh(this._pvForecast, nowMs, horizonMs)
      : null;
    const solarBlocks   = solarKwh !== null && solarKwh >= solarLimitKwh;
    const solarInfo     = solarLimitKwh > 0 ? { solarKwh, solarLimitKwh } : {};
    // Carried into whichever mode we fall through to, so "why didn't it charge last
    // night" is answerable from the history alone — without it the entry would just
    // read "reserving capacity for the most expensive upcoming hours".
    const solarSuffix   = solarBlocks
      ? ` — grid charging paused, solar forecast ${solarKwh.toFixed(1)} kWh ≥ ${solarLimitKwh} kWh`
      : '';

    let chargeSlots = [];
    let isChargeNow = false;
    if (!solarBlocks && socNow < targetSoc && capacityKwh > 0 && chargePowerW > 0) {
      const neededKwh   = ((targetSoc - socNow) / 100) * capacityKwh;
      const hoursNeeded = (neededKwh * 1000) / chargePowerW;
      const candidates  = this._priceSlotsBetween(nowMs, horizonMs);
      if (candidates.length) {
        // Earlier wins ties here — see _priceSelectCheapestSlots. A battery has no
        // deadline to save the cheap hour for, and on a repeating schedule waiting for the
        // "later" one of two identically priced hours never ends.
        const selected = this._priceSelectCheapestSlots(candidates, hoursNeeded, 0, true);
        chargeSlots  = candidates.filter((s) => selected.has(s.start)).sort((a, b) => a.start - b.start);
        isChargeNow  = this._priceSlotSelectedNow(selected, candidates, nowMs);
      }
    }
    // What this battery does when it is NOT grid-charging — derived BEFORE the charge
    // return, because both paths need it. Below it simply is the decision. Above it is
    // what the caller falls back to when the main-fuse ceiling denies the grid-charge
    // (device.js _checkBatteryPriceControl), and that fallback used to be re-guessed
    // from reserveSlots — which this function set to [] on the charge path, against its
    // own contract above. The guess therefore always came out 'normal', so a battery
    // denied its charge released its reserve instead of holding it. Derive once, and
    // the two answers cannot drift apart again.
    const reserveHours = Number(bd.price_discharge_reserve_hours ?? 4); // matches the Settings UI's own default
    let otherwise = {
      mode: 'normal',
      reason: solarBlocks ? solarSuffix.replace(/^ — /, '') : 'nothing to do',
      reserveSlots: [],
    };
    if (reserveHours > 0) {
      const candidates = this._priceSlotsBetween(nowMs, horizonMs);
      if (candidates.length) {
        const selected     = this._priceSelectExpensiveSlots(candidates, reserveHours);
        const reserveSlots = candidates.filter((s) => selected.has(s.start)).sort((a, b) => a.start - b.start);
        otherwise = this._priceSlotSelectedNow(selected, candidates, nowMs)
          ? { mode: 'normal', reason: `in a top-expensive slot — discharge allowed${solarSuffix}`, reserveSlots }
          : { mode: 'hold',   reason: `reserving capacity for the most expensive upcoming hours${solarSuffix}`, reserveSlots };
      }
    }

    // deniedMode/deniedReason ride along with a 'charge' so the caller never has to
    // reconstruct the alternative from the slot lists.
    if (isChargeNow) {
      return {
        mode: 'charge', reason: 'in a selected cheap slot within the lookahead window',
        deniedMode: otherwise.mode, deniedReason: otherwise.reason,
        chargeSlots, reserveSlots: otherwise.reserveSlots, ...solarInfo,
      };
    }

    return { mode: otherwise.mode, reason: otherwise.reason, chargeSlots, reserveSlots: otherwise.reserveSlots, ...solarInfo };
  },

  // The D10 decision: should THIS charger (serving `car`) charge from the grid right
  // now to meet the car's deadline? Nets off the Solcast PV forecast first — grid
  // charging is only planned for what solar won't cover. Always includes `chargeSlots`
  // (the full selected-slot list, even when empty or not currently in one) so the
  // settings UI can show a "next charge window" preview without a second lookup —
  // same convention as _batteryPriceMode.
  _priceShouldChargeNow(car, chargerPowerW, cfg, nowMs = Date.now()) {
    const noSlots = { chargeSlots: [] };
    if (!car || !car.readyBy || !car.capacityKwh) {
      return { shouldCharge: false, reason: 'no deadline/capacity configured for this car', ...noSlots };
    }
    if (car.soc === null || car.target === null) {
      return { shouldCharge: false, reason: 'car SoC/target unknown', ...noSlots };
    }
    if (car.soc >= car.target) {
      return { shouldCharge: false, reason: 'target already reached', ...noSlots };
    }

    const tz = this.homey?.clock?.getTimezone?.() || 'UTC';
    const untilDeadlineMs = this._priceMsUntilDeadline(nowMs, tz, car.readyBy);
    if (untilDeadlineMs === null) {
      return { shouldCharge: false, reason: 'invalid deadline time', ...noSlots };
    }
    const deadlineMs = nowMs + untilDeadlineMs;

    const neededKwh = Math.max(0, ((car.target - car.soc) / 100) * car.capacityKwh);
    const solarKwh  = this._pvForecastStale(nowMs) ? 0 : this._pvSumKwh(this._pvForecast, nowMs, deadlineMs);
    const netNeededKwh = Math.max(0, neededKwh - solarKwh);

    if (netNeededKwh <= 0) {
      return { shouldCharge: false, reason: 'solar forecast covers the remaining need', neededKwh, solarKwh, netNeededKwh: 0, ...noSlots };
    }

    if (chargerPowerW <= 0) return { shouldCharge: false, reason: 'no charger power available', neededKwh, solarKwh, netNeededKwh, ...noSlots };
    const hoursNeeded = (netNeededKwh * 1000) / chargerPowerW;

    if (this._priceForecastStale(nowMs)) {
      // No usable price data — fail safe: charge continuously so the deadline is met.
      return { shouldCharge: true, reason: 'no price forecast — charging continuously to meet deadline', neededKwh, solarKwh, netNeededKwh, hoursNeeded, ...noSlots };
    }

    const slots = this._priceSlotsBetween(nowMs, deadlineMs);
    if (!slots.length) {
      return { shouldCharge: true, reason: 'no price slots before deadline — charging continuously', neededKwh, solarKwh, netNeededKwh, hoursNeeded, ...noSlots };
    }

    const precondition = Number(cfg.price_ev_precondition_h ?? 0.5);
    const selected = this._priceSelectCheapestSlots(slots, hoursNeeded, precondition);
    const shouldCharge = this._priceSlotSelectedNow(selected, slots, nowMs);
    const chargeSlots  = slots.filter((s) => selected.has(s.start)).sort((a, b) => a.start - b.start);

    return { shouldCharge, reason: shouldCharge ? 'in a selected cheap slot' : 'waiting for a cheaper slot', neededKwh, solarKwh, netNeededKwh, hoursNeeded, chargeSlots };
  },

  // Full payload for the API route (summary + raw slots) — read by /ems/price-forecast.
  getPriceForecast() {
    return { ...this._priceForecastSummary(), slots: this._priceForecast || [] };
  },

  // Compact status for diagnostics.
  _priceForecastSummary(nowMs = Date.now()) {
    // On a zone schedule the diagnostics describe the same slots the decisions see, rather
    // than the empty push-forecast store — otherwise /ems/diag would report "0 slots, not
    // stale", which reads like a fault and is not one.
    const zoneCfg = this._tariffZoneConfig();
    const slots = zoneCfg
      ? this._priceSlotsBetween(nowMs, nowMs + PRICE_BATTERY_LOOKAHEAD_MS)
      : (this._priceForecast || []);
    const future = slots.filter((s) => s.end > nowMs);
    return {
      configured: slots.length > 0,
      stale:      this._priceForecastStale(nowMs),
      updatedAt:  this._priceForecastUpdatedAt || null,
      ageMin:     this._priceForecastUpdatedAt ? Math.round((nowMs - this._priceForecastUpdatedAt) / 60000) : null,
      slotCount:  future.length,
      nowPrice:   (() => { const s = future.find((x) => x.start <= nowMs && nowMs < x.end); return s ? s.price : null; })(),
    };
  },

};
