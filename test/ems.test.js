'use strict';

// Unit tests for the pure / near-pure EMS mixin logic. Run: node --test
// The mixins are plain method objects, so we attach them to a minimal fake device
// (`this`) with just the state/helpers each method touches — no Homey runtime needed.

const test   = require('node:test');
const assert = require('node:assert');

const priceMixin   = require('../lib/ems/price');
const carsMixin    = require('../lib/ems/cars');
const chargerMixin = require('../lib/ems/chargerControl');
const batteryMixin = require('../lib/ems/battery');
const pvForecastMixin = require('../lib/ems/pvForecast');
const priceForecastMixin = require('../lib/ems/priceForecast');
const simpleDevicesMixin = require('../lib/ems/simpleDevices');
const exportLimitMixin = require('../lib/ems/exportLimit');
const chargeSessionsMixin = require('../lib/ems/chargeSessions');
const widgetMixin         = require('../lib/ems/widget');
const historyMixin        = require('../lib/ems/history');
const timingMixin         = require('../lib/ems/timing');
const {
  MIN_3PH_W, PHASE_UP_MARGIN_W, STEP_HOLD_MS, EXPORT_GUARD_W, MIN_CHARGE_W, EXPORT_LIMIT_HOLD_MS,
  SIMPLE_STATE_SAVE_MS, TRIGGER_BUDGET_MS, OVERFLOW_KEEP_W, OVERFLOW_START_W,
} = require('../lib/ems/constants');

function makeDevice(extra = {}) {
  const dev = {
    homey: { clock: { getTimezone: () => 'Europe/Zurich' } },
    log() {}, error() {},
    _postNotification() {},
    _debugLog() {},
    _variablePrice: null,
    _carStates: [],
    _carSocTrack: {},
  };
  Object.assign(dev, priceMixin, carsMixin, chargerMixin, batteryMixin, pvForecastMixin, priceForecastMixin, extra);
  return dev;
}

// Fake device for exercising the real _stepCharger / _chargerSetAmps / _chargerStop
// against an in-memory charger-state map. Flow triggers + history are stubbed so the
// state mutations (currentAmps / currentPhases) run exactly as in production.
function makeChargerDevice(extra = {}) {
  const dev = {
    log() {}, error() {},
    _warmupDone: true,
    _chargerStates: new Map(),
    _addHistoryEvent() {},
    _carStates: [],
    // setTimeout/clearTimeout mirror the real Homey: _settleWithin puts a time budget on
    // every flow trigger the loop fires, and it schedules that budget through the runtime.
    homey: {
      flow: { getTriggerCard: () => ({ trigger: () => Promise.resolve() }) },
      clock: { getTimezone: () => 'Europe/Zurich' },
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (t) => clearTimeout(t),
    },
    // _evaluateEvChargers reads capabilities like 'charge_now' / 'offpeak_enabled' — stub
    // as "unset" (falsy) unless a test overrides it via extra.getCapabilityValue.
    getCapabilityValue() { return undefined; },
    // _setMode lives directly on the device class (buffered mode setter), not a mixin —
    // record the last call so tests can assert on it.
    _setMode(mode, text) { this._lastMode = { mode, text }; },
    _debugLog() {},
    setStoreValue() { return Promise.resolve(); },
    _chargeSessions: [],
    // getEmsChargeSessions reads the currency for a still-running session from the config.
    _getConfig: () => ({}),
  };
  // batteryMixin (_batteryZones), carsMixin (_carForCharger), priceMixin (_offpeakWindow),
  // pvForecastMixin + priceForecastMixin (_priceShouldChargeNow) — all things _evaluateEvChargers
  // calls via `this` for the P1/P3/P3b tiers.
  Object.assign(dev, batteryMixin, carsMixin, priceMixin, pvForecastMixin, priceForecastMixin, chargerMixin, chargeSessionsMixin, timingMixin, extra);
  return dev;
}

// A plain single-phase charger (6–32 A, no phase switching).
const CHARGER_1PH = { id: 'c1', connected: true, minAmps: 6, maxAmps: 32, phases: 1, phaseSwitch: false };
function seedState(dev, id, patch) {
  const st = dev._getChargerState(id);
  Object.assign(st, patch);
  return st;
}

// Fake device for _evaluateSimpleDevices. `_simpleDeviceSetOn` is stubbed to record the
// on/off DECISION (not fire flows), so tests assert what the state machine decided.
function makeSimpleDevice(extra = {}) {
  const dev = {
    log() {}, _warmupDone: true, _addHistoryEvent() {},
    homey: { flow: { getTriggerCard: () => ({ trigger: () => Promise.resolve() }) } },
  };
  Object.assign(dev, simpleDevicesMixin, batteryMixin, pvForecastMixin, chargerMixin, extra);
  dev._setOnCalls = [];
  dev._simpleDeviceSetOn = async function (id, name, on) { this._setOnCalls.push({ id, on }); };
  return dev;
}
// A simple device with `actualOn: null` (EMS-state mode) so drift-sync is skipped and the
// decision is purely surplus/battery/timer driven.
function simpleDev(over = {}) {
  return Object.assign({
    id: 'd1', name: 'HP', actualOn: null, powerW: null,
    minSurplusW: 1000, minPowerW: 0,
    startSustainMs: 60_000, stopGraceMs: 120_000, maxRunMs: 0,
    restartCooldownMs: 0, startupGraceMs: 120_000, stateSource: 'ems',
  }, over);
}

// Fake device for _evaluateExportLimit. Trigger firing + persistence are stubbed; `_fired`
// records which on/off card was fired.
function makeExportDevice(extra = {}) {
  const dev = {
    log() {}, _exportLimitActive: false, _exportLimitActivatedAt: null,
    _loggedExportSocMisconfig: false, _addHistoryEvent() {},
  };
  Object.assign(dev, exportLimitMixin, extra);
  // Override AFTER assign — these names also exist on the mixin (would otherwise call the
  // real store/flow methods that the fake device doesn't have).
  dev._fired = [];
  dev._persistExportLimit = async function () {};
  dev._fireExportLimitTrigger = async function (cfg, cardId) { this._fired.push(cardId); };
  return dev;
}
const EXPORT_CFG = { export_limit_enabled: true, export_limit_trigger_soc: 95, export_limit_deactivate_soc: 90, inverter_devices: [{ id: 'inv1' }] };

// ── price: _parseTime ────────────────────────────────────────────────────────
test('_parseTime parses HH:MM to minutes', () => {
  const d = makeDevice();
  assert.strictEqual(d._parseTime('22:00'), 1320);
  assert.strictEqual(d._parseTime('06:30'), 390);
  assert.strictEqual(d._parseTime('00:00'), 0);
  assert.strictEqual(d._parseTime('23:59'), 1439);
});
test('_parseTime rejects invalid input', () => {
  const d = makeDevice();
  assert.strictEqual(d._parseTime('24:00'), null);
  assert.strictEqual(d._parseTime('9:99'), null);
  assert.strictEqual(d._parseTime('nope'), null);
  assert.strictEqual(d._parseTime(''), null);
  assert.strictEqual(d._parseTime(null), null);
});

// ── price: _getCurrentPrice ──────────────────────────────────────────────────
test('_getCurrentPrice — fixed', () => {
  const d = makeDevice();
  assert.strictEqual(d._getCurrentPrice({ price_config: { mode: 'fixed', price_fixed: 0.30 } }), 0.30);
  assert.strictEqual(d._getCurrentPrice({ price_config: { mode: 'fixed' } }), 0); // missing → 0
});
test('_getCurrentPrice — variable', () => {
  const d = makeDevice({ _variablePrice: 0.257 });
  assert.strictEqual(d._getCurrentPrice({ price_config: { mode: 'variable' } }), 0.257);
  const d2 = makeDevice({ _variablePrice: null });
  assert.strictEqual(d2._getCurrentPrice({ price_config: { mode: 'variable' } }), null); // unknown
});
test('_getCurrentPrice — forecast uses the current slot of the price forecast', () => {
  const now = Date.now();
  const d = makeDevice({ _variablePrice: null });
  d._priceForecast = [{ start: now - 1000, end: now + 3600_000, price: 0.199 }];
  d._priceForecastUpdatedAt = now;
  assert.strictEqual(d._getCurrentPrice({ price_config: { mode: 'forecast' } }), 0.199);
});
test('_getCurrentPrice — forecast ignores a stale forecast', () => {
  const now = Date.now();
  const d = makeDevice({ _variablePrice: null });
  d._priceForecast = [{ start: now - 1000, end: now + 3600_000, price: 0.199 }];
  d._priceForecastUpdatedAt = now - 31 * 3600_000; // older than PRICE_FORECAST_STALE_MS (30h)
  assert.strictEqual(d._getCurrentPrice({ price_config: { mode: 'forecast' } }), null);
});
test('_getCurrentPrice — variable does not fall back to the forecast (separate modes now)', () => {
  const now = Date.now();
  const d = makeDevice({ _variablePrice: null });
  d._priceForecast = [{ start: now - 1000, end: now + 3600_000, price: 0.199 }];
  d._priceForecastUpdatedAt = now;
  assert.strictEqual(d._getCurrentPrice({ price_config: { mode: 'variable' } }), null);
});
test('_getCurrentPrice — default mode is fixed', () => {
  const d = makeDevice();
  assert.strictEqual(d._getCurrentPrice({ price_config: { price_fixed: 0.2 } }), 0.2);
});

// ── price: _offpeakWindow ────────────────────────────────────────────────────
test('_offpeakWindow returns amps + boolean active', () => {
  const d = makeDevice();
  const w = d._offpeakWindow({ offpeak_amps: 16, offpeak_start: '22:00', offpeak_end: '06:00' });
  assert.strictEqual(w.amps, 16);
  assert.strictEqual(typeof w.active, 'boolean');
});
test('_offpeakWindow invalid times → inactive', () => {
  const d = makeDevice();
  const w = d._offpeakWindow({ offpeak_start: 'bad', offpeak_end: 'bad' });
  assert.strictEqual(w.active, false);
});

// ── price: _dualTariffWindow (used by the "Solar & low tariff" charger mode) ──
test('_dualTariffWindow — not configured when mode is not dual', () => {
  const d = makeDevice();
  const w = d._dualTariffWindow({ price_config: { mode: 'fixed', high_windows: { 1: { start: '08:00', end: '20:00' } } } });
  assert.strictEqual(w.configured, false);
});
test('_dualTariffWindow — not configured when dual but no window has both start+end', () => {
  const d = makeDevice();
  const w = d._dualTariffWindow({ price_config: { mode: 'dual', high_windows: { 1: { start: '08:00' } } } });
  assert.strictEqual(w.configured, false);
});
test('_dualTariffWindow — configured when dual with at least one full weekday window', () => {
  const d = makeDevice();
  const w = d._dualTariffWindow({ price_config: { mode: 'dual', high_windows: { 1: { start: '08:00', end: '20:00' } } } });
  assert.strictEqual(w.configured, true);
  assert.strictEqual(typeof w.isHigh, 'boolean');
});
test('_dualTariffWindow — missing/invalid window for today → isHigh false', () => {
  const d = makeDevice();
  const w = d._dualTariffWindow({ price_config: { mode: 'dual', high_windows: {} } });
  assert.strictEqual(w.isHigh, false);
});

// ── price: _dualTariffPriceAt (dual tariff at an arbitrary point in time, not just
// "now" — used to build the EMS Forecast widget's 24h timeline) ─────────────────
test('_dualTariffPriceAt — high price inside the window, low outside', () => {
  const d = makeDevice({ homey: { clock: { getTimezone: () => 'UTC' } } });
  const cfg = { price_config: { mode: 'dual', price_low: 0.10, price_high: 0.30, high_windows: { 3: { start: '08:00', end: '20:00' } } } };
  const inWindow  = Date.UTC(2024, 0, 3, 10, 30); // Wed 2024-01-03, dayOfWeek 3
  const outWindow = Date.UTC(2024, 0, 3, 22, 0);
  assert.strictEqual(d._dualTariffPriceAt(cfg, inWindow), 0.30);
  assert.strictEqual(d._dualTariffPriceAt(cfg, outWindow), 0.10);
});

// ── price: getEmsPriceStatus (EMS Forecast widget — follows whatever tariff model
// is actually configured, not just "Price forecast") ────────────────────────────
test('getEmsPriceStatus — fixed mode returns the configured fixed price', () => {
  const d = makeDevice({ _getConfig: () => ({ price_config: { mode: 'fixed', price_fixed: 0.219, currency: 'CHF' } }) });
  const s = d.getEmsPriceStatus();
  assert.strictEqual(s.mode, 'fixed');
  assert.strictEqual(s.currency, 'CHF');
  assert.strictEqual(s.price, 0.219);
});
test('getEmsPriceStatus — variable mode reflects the last flow-pushed value, null when never set', () => {
  const d1 = makeDevice({ _variablePrice: 0.257, _getConfig: () => ({ price_config: { mode: 'variable', currency: 'EUR' } }) });
  assert.strictEqual(d1.getEmsPriceStatus().price, 0.257);
  const d2 = makeDevice({ _variablePrice: null, _getConfig: () => ({ price_config: { mode: 'variable' } }) });
  assert.strictEqual(d2.getEmsPriceStatus().price, null);
});
test('getEmsPriceStatus — dual mode returns a 24-slot hourly timeline built from the high/low windows', () => {
  const d = makeDevice({
    homey: { clock: { getTimezone: () => 'UTC' } },
    _getConfig: () => ({ price_config: { mode: 'dual', price_low: 0.10, price_high: 0.30, high_windows: { 1: { start: '08:00', end: '20:00' } } } }),
  });
  const s = d.getEmsPriceStatus();
  assert.strictEqual(s.mode, 'dual');
  assert.strictEqual(s.slots.length, 24);
  assert.ok(s.slots.every((slot) => slot.price === 0.10 || slot.price === 0.30));
  assert.strictEqual(s.slots[0].end - s.slots[0].start, 3600_000);
});
test('getEmsPriceStatus — dual mode reports not configured when no window has both start+end', () => {
  const d = makeDevice({ _getConfig: () => ({ price_config: { mode: 'dual', high_windows: {} } }) });
  assert.strictEqual(d.getEmsPriceStatus().configured, false);
});
test('getEmsPriceStatus — forecast mode delegates to getPriceForecast()', () => {
  const d = makeDevice({ _getConfig: () => ({ price_config: { mode: 'forecast', currency: 'CHF' } }) });
  d._priceForecast = [{ start: Date.now() - 1000, end: Date.now() + 3600_000, price: 0.199 }];
  d._priceForecastUpdatedAt = Date.now();
  const s = d.getEmsPriceStatus();
  assert.strictEqual(s.mode, 'forecast');
  assert.strictEqual(s.nowPrice, 0.199);
  assert.strictEqual(s.slots.length, 1);
});
test('getEmsPriceStatus — defaults to fixed mode with price 0 when price_config is missing', () => {
  const d = makeDevice({ _getConfig: () => ({}) });
  const s = d.getEmsPriceStatus();
  assert.strictEqual(s.mode, 'fixed');
  assert.strictEqual(s.price, 0);
  assert.strictEqual(s.currency, 'CHF');
  // …and says so, so the widget shows "not configured" instead of 0.000 (1.2.299).
  assert.strictEqual(s.configured, false);
});

// ── chargerControl: _bestPhases ──────────────────────────────────────────────
// MIN_3PH_W is not only the price of admission to three phases, it is the floor afterwards:
// three phases cannot draw less. Switching over at exactly that figure therefore left the
// charger standing on the budget that justified the move, and the next dip stopped it
// outright — the amp ladder has nowhere lower to go. Field log 2026-08-26, 15:33–17:45:
// eight start/stop cycles, and every one of the five that reached three phases ended in a
// stop within two minutes; the two that stayed single-phase ran on.
test('_bestPhases — committing to three phases wants a rung of headroom', () => {
  const d = makeDevice();
  assert.strictEqual(d._bestPhases(MIN_3PH_W, 1), 1, 'the bare floor is not enough to commit');
  assert.strictEqual(d._bestPhases(MIN_3PH_W + PHASE_UP_MARGIN_W - 1, 1), 1);
  assert.strictEqual(d._bestPhases(MIN_3PH_W + PHASE_UP_MARGIN_W, 1), 3);
  assert.strictEqual(d._bestPhases(0, 1), 1);
});

test('_bestPhases — staying at three phases only wants the floor', () => {
  const d = makeDevice();
  assert.strictEqual(d._bestPhases(MIN_3PH_W, 3), 3, 'it would drop a phase it could still carry');
  assert.strictEqual(d._bestPhases(MIN_3PH_W - 1, 3), 1, 'below the floor three phases are impossible');
  // The gap between the two is the hysteresis: inside it, whichever phase count is running
  // stays running.
  const inBetween = MIN_3PH_W + 100;
  assert.strictEqual(d._bestPhases(inBetween, 1), 1);
  assert.strictEqual(d._bestPhases(inBetween, 3), 3);
});

test('_bestPhases — called without a current phase count, it assumes the cautious one', () => {
  const d = makeDevice();
  assert.strictEqual(d._bestPhases(MIN_3PH_W), 1, 'an unknown state must not be read as "already at three"');
});

// ── cars: _pickChargingCar ───────────────────────────────────────────────────
test('_pickChargingCar — none / single', () => {
  assert.strictEqual(makeDevice({ _carStates: [] })._pickChargingCar(), null);
  const one = { id: 'a', name: 'Audi', soc: 50, target: 90 };
  assert.strictEqual(makeDevice({ _carStates: [one] })._pickChargingCar(), one);
});
test('_pickChargingCar — picks the most-recently-risen car', () => {
  const a = { id: 'a', name: 'A', soc: 50, target: 90 };
  const b = { id: 'b', name: 'B', soc: 40, target: 80 };
  const now = Date.now();
  const d = makeDevice({
    _carStates: [a, b],
    _carSocTrack: { a: { lastRiseAt: now - 5 * 60000 }, b: { lastRiseAt: now - 30000 } },
  });
  assert.strictEqual(d._pickChargingCar(), b); // b rose more recently
});
test('_pickChargingCar — no recent rise → null', () => {
  const a = { id: 'a', name: 'A', soc: 50, target: 90 };
  const b = { id: 'b', name: 'B', soc: 40, target: 80 };
  const old = Date.now() - 60 * 60000; // 60 min ago (> 30 min window)
  const d = makeDevice({
    _carStates: [a, b],
    _carSocTrack: { a: { lastRiseAt: old }, b: { lastRiseAt: old } },
  });
  assert.strictEqual(d._pickChargingCar(), null);
});

// ── cars: _carForCharger (CR1) ───────────────────────────────────────────────
test('_carForCharger — explicit mapping wins', () => {
  const a = { id: 'a', name: 'A' }; const b = { id: 'b', name: 'B' };
  const d = makeDevice({ _carStates: [a, b] });
  assert.strictEqual(d._carForCharger({ carId: 'b' }), b);
  assert.strictEqual(d._carForCharger({ carId: 'nope' }), null);
});
test('_carForCharger — single car without mapping', () => {
  const a = { id: 'a', name: 'A' };
  const d = makeDevice({ _carStates: [a] });
  assert.strictEqual(d._carForCharger({ carId: null }), a);
});
test('_carForCharger — multi car without mapping falls back to heuristic', () => {
  const a = { id: 'a', name: 'A' }; const b = { id: 'b', name: 'B' };
  const now = Date.now();
  const d = makeDevice({
    _carStates: [a, b],
    _carSocTrack: { a: { lastRiseAt: now - 60000 }, b: { lastRiseAt: now - 10000 } },
  });
  assert.strictEqual(d._carForCharger({ carId: null }), b);
});

// ── cars: _setCapTitle guards setCapabilityOptions against redundant calls ───
test('_setCapTitle — skips setCapabilityOptions when the title is unchanged', async () => {
  let calls = 0;
  const d = makeDevice({ setCapabilityOptions: async () => { calls++; } });
  await d._setCapTitle('measure_car_soc.a', 'My Car');
  await d._setCapTitle('measure_car_soc.a', 'My Car'); // same title again — e.g. a second settings save
  assert.strictEqual(calls, 1);
});
test('_setCapTitle — calls setCapabilityOptions again when the title actually changes', async () => {
  let calls = 0;
  const d = makeDevice({ setCapabilityOptions: async () => { calls++; } });
  await d._setCapTitle('measure_car_soc.a', 'My Car');
  await d._setCapTitle('measure_car_soc.a', 'Renamed Car');
  assert.strictEqual(calls, 2);
});

// ── battery: _batteryZones ───────────────────────────────────────────────────
test('_batteryZones — one threshold: the old reserve zone is gone', () => {
  const d = makeDevice();
  // Was: 50 = reserve floor, 80 = normal. The hard stop was the reserve floor, and the
  // band between them was the orange zone. That band is now covered by the surplus ramp,
  // so the reserve floor is simply the one threshold and nothing reports "reserve".
  const cfg = { min_battery_soc: 80, min_battery_soc_low: 50 };
  assert.deepStrictEqual(
    d._batteryZones(cfg, { soc: 60 }),                    // once orange, now ordinary
    { minSoc: 50, minSocLow: 50, hasLowZone: false, batLow: false, batReserve: false, batHardStop: false });
  const low = d._batteryZones(cfg, { soc: 40 });
  assert.strictEqual(low.batHardStop, true);
  assert.strictEqual(low.batLow, true);                   // chargerControl's restricted mode
  assert.strictEqual(low.batReserve, false);              // never again
});
test('_batteryZones — without a reserve floor the normal minimum becomes the hard stop', () => {
  const d = makeDevice();
  const cfg = { min_battery_soc: 80 };                    // no min_battery_soc_low
  assert.strictEqual(d._batteryZones(cfg, { soc: 70 }).batHardStop, true);
  assert.strictEqual(d._batteryZones(cfg, { soc: 90 }).batHardStop, false);
});
test('_batteryZones — with a ramp configured, its lower SoC point is the hard stop', () => {
  const d = makeDevice();
  const cfg = { share_soc_low: 85, share_soc_high: 100, min_battery_soc: 80, min_battery_soc_low: 50 };
  assert.strictEqual(d._batteryZones(cfg, { soc: 90 }).batHardStop, false);
  assert.strictEqual(d._batteryZones(cfg, { soc: 84 }).batHardStop, true);   // the old 50 no longer applies
  assert.strictEqual(d._batteryZones(cfg, { soc: 84 }).batLow, true);
});
test('_batteryZones — an incomplete ramp falls back to the old settings', () => {
  const d = makeDevice();
  // upper not above lower → not a ramp, so the old derivation still defines the stop
  const cfg = { share_soc_low: 85, share_soc_high: 0, min_battery_soc: 80, min_battery_soc_low: 50 };
  assert.strictEqual(d._batteryZones(cfg, { soc: 60 }).batHardStop, false);  // 60 >= 50
  assert.strictEqual(d._batteryZones(cfg, { soc: 40 }).batHardStop, true);
});
// An unreadable state of charge holds the stop; it does not release it. Until 1.2.188 the
// test was `battery.soc !== null && …`, so a missing reading freed every device. Field log
// 2026-08-26, 09:31, battery at 22 %: three devices entered start-sustain and the mode fell
// to idle — both meaning the EMS saw no low battery — and forty seconds later, with the
// reading back, the stop re-engaged.
//
// The two cases below look identical from inside _batteryZones and must not be treated
// alike: "configured but unreadable" is a failure to protect against, "no battery at all"
// is a fact, and confusing them would stop every device forever on a PV-only installation.
test('_batteryZones — a battery that cannot be read keeps the hard stop on', () => {
  const d = makeDevice();
  const cfg = { min_battery_soc: 80, min_battery_soc_low: 50, battery_devices: [{ id: 'b1' }] };
  for (const soc of [null, undefined]) {
    const z = d._batteryZones(cfg, { soc });
    assert.strictEqual(z.batHardStop, true, `soc ${soc} released the protection`);
    assert.strictEqual(z.batLow, true);
  }
});

test('_batteryZones — with no battery configured, an absent soc is a fact and stops nothing', () => {
  const d = makeDevice();
  const z = d._batteryZones({ min_battery_soc: 80, min_battery_soc_low: 50 }, { soc: null });
  assert.strictEqual(z.batLow, false, 'a PV-only installation would never run a device again');
  assert.strictEqual(z.batReserve, false);
  assert.strictEqual(z.batHardStop, false);
});

test('_batteryZones — an unreadable battery with no threshold configured still stops nothing', () => {
  const d = makeDevice();
  const z = d._batteryZones({ min_battery_soc: 0, battery_devices: [{ id: 'b1' }] }, { soc: null });
  assert.strictEqual(z.batHardStop, false, 'a stop was invented where no level was set');
});

test('_batteryZones — a readable battery is judged exactly as before', () => {
  const d = makeDevice();
  const cfg = { min_battery_soc: 80, min_battery_soc_low: 50, battery_devices: [{ id: 'b1' }] };
  assert.strictEqual(d._batteryZones(cfg, { soc: 49 }).batHardStop, true);
  assert.strictEqual(d._batteryZones(cfg, { soc: 50 }).batHardStop, false);
  assert.strictEqual(d._batteryZones(cfg, { soc: 0 }).batHardStop, true, 'a genuine zero is a reading, not an absence');
});
test('_batteryZones — misconfigured low ≥ min disables the reserve zone', () => {
  const d = makeDevice();
  const cfg = { min_battery_soc: 80, min_battery_soc_low: 90 };
  assert.strictEqual(d._batteryZones(cfg, { soc: 75 }).hasLowZone, false);
  assert.strictEqual(d._batteryZones(cfg, { soc: 75 }).batHardStop, true); // treated as hard stop, not reserve
});

// ── chargerControl: _stepCharger ─────────────────────────────────────────────
const T = 1_000_000_000; // fixed "now" base for deterministic timing

test('_stepCharger — warmup tick observes only, never commands', async () => {
  const d = makeChargerDevice({ _warmupDone: false });
  seedState(d, 'c1', { currentAmps: 10, currentPhases: 1 });
  const res = await d._stepCharger(CHARGER_1PH, 5000, 1, T, -1000, false);
  assert.strictEqual(res.amps, 10); // returns current, no change
  assert.strictEqual(d._getChargerState('c1').currentAmps, 10);
});

test('_stepCharger — budget below minimum, charger off → stays off, no command', async () => {
  const d = makeChargerDevice();
  const r = await d._stepCharger(CHARGER_1PH, 1000, 1, T, 0, false); // 1000 W < 6A(1380 W)
  assert.strictEqual(r.amps, 0);
  assert.strictEqual(r.allocatedW, 0);
  assert.strictEqual(d._getChargerState('c1').currentAmps, null); // never started
});

test('_stepCharger — start requires STEP_HOLD before committing', async () => {
  const d = makeChargerDevice();
  // First tick with enough surplus for 6 A: arms a pending step, does not command yet.
  let r = await d._stepCharger(CHARGER_1PH, 1500, 1, T, -1500, false);
  assert.strictEqual(r.amps, 0);
  assert.strictEqual(d._getChargerState('c1').currentAmps, null);
  assert.strictEqual(d._getChargerState('c1').pendingStepAmps, 6);
  // Still within the hold window → keeps waiting.
  r = await d._stepCharger(CHARGER_1PH, 1500, 1, T + STEP_HOLD_MS - 1, -1500, false);
  assert.strictEqual(r.amps, 0);
  // Past the hold window → commits the start at 6 A.
  r = await d._stepCharger(CHARGER_1PH, 1500, 1, T + STEP_HOLD_MS + 1, -1500, false);
  assert.strictEqual(r.amps, 6);
  assert.strictEqual(d._getChargerState('c1').currentAmps, 6);
});

// ── the surplus ramp as a ceiling, not only an addition ──────────────────────
// The ramp folded into effectiveGridW CREATES budget — that is what lets a device claim
// while the grid sits at zero and the battery is taking everything. It cannot RECLAIM:
// a running charger's budget is its own draw minus the meter, and once it consumes
// everything the meter reads zero, so it justifies itself.
//
// Configuration export of 2026-08-29, 62 % SoC, ramp 50→100 % / 10→100 %:
//   pv 7448 W · share 31.6 % · allowance 2354 W
//   grid +13 W · battery +346 W (all it could still absorb) · car 6152 W
// The ramp promised the devices 32 % and the car held 83 %, with 5 % left for the battery.
const CEILING_CFG = {
  share_soc_low: 50, share_soc_high: 100, share_pct_low: 10, share_pct_high: 100,
  min_battery_soc: 20, battery_devices: [{ id: 'b1' }],
};

test('_evaluateEvChargers — the ramp allowance pulls a running charger back down', async () => {
  const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 16, phases: 3, phaseSwitch: true, powerW: 6152, chargeMode: 'solar' };
  const d = makeChargerDevice();
  seedState(d, 'c1', { currentAmps: 9, currentPhases: 3, lastPhaseSwitchAt: null, lastDownStepAt: null });

  // effectiveGridW as device.js computes it: 13 − 346.
  await d._evaluateEvChargers({ soc: 62, powerW: 346 }, -333, [charger], CEILING_CFG, 7448, 950, 2354);

  const st = d._getChargerState('c1');
  assert.ok(st.currentAmps * st.currentPhases * 230 <= 2354,
    `charger left at ${st.currentAmps}A/${st.currentPhases}ph — above the 2354 W share`);
  assert.strictEqual(st.currentPhases, 1, 'three phases cannot fit inside the share at all');
});

test('_evaluateEvChargers — without a ramp the charger keeps what it had', async () => {
  const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 16, phases: 3, phaseSwitch: true, powerW: 6152, chargeMode: 'solar' };
  const d = makeChargerDevice();
  seedState(d, 'c1', { currentAmps: 9, currentPhases: 3, lastPhaseSwitchAt: null, lastDownStepAt: null });

  // Same tick, no allowance passed — every installation without a ramp must be untouched.
  // min_battery_soc explicitly below the SoC: an empty cfg would fall back to the old 80 %
  // default and stop the charger on battery priority, which is not what this test is about.
  await d._evaluateEvChargers({ soc: 62, powerW: 346 }, -333, [charger], { min_battery_soc: 20 }, 7448, 950, null);
  assert.strictEqual(d._getChargerState('c1').currentAmps, 9);
  assert.strictEqual(d._getChargerState('c1').currentPhases, 3);
});

test('_evaluateEvChargers — a generous allowance does not raise a small budget', async () => {
  const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 16, phases: 1, phaseSwitch: false, powerW: 0, chargeMode: 'solar' };
  const d = makeChargerDevice();
  // Nothing running, meter importing: there is no surplus, and a big share must not invent
  // one. Two calls, because a start arms a pending step on the first tick and only commits
  // on a later one — a single call would pass whatever the budget said.
  const battery = { soc: 90, powerW: 0 };
  await d._evaluateEvChargers(battery, 500, [charger], CEILING_CFG, 7448, 7000, 6000);
  await d._evaluateEvChargers(battery, 500, [charger], CEILING_CFG, 7448, 7000, 6000);
  assert.strictEqual(d._getChargerState('c1').currentAmps, null, 'the ceiling created budget instead of bounding it');
  assert.strictEqual(d._getChargerState('c1').pendingStepAmps, null, 'a start was even armed');
});

// The same property for the on/off devices: the share has to be able to say no to one that
// is already running, or it only ever gates starts.
test('_evaluateSimpleDevices — a running device is stopped when the share no longer covers it', async () => {
  const d = makeSimpleDevice();
  const now = Date.now();
  const state = new Map([['d1', { isOn: true, startedAt: now - 600_000, surplusOkSince: null, surplusBadSince: null, powerDropStoppedAt: null }]]);
  const dev = simpleDev({ minSurplusW: 2000, stopGraceMs: 0, powerW: 2000 });

  // Export alone would keep it running (2000 + 500 ≥ 2000); the remaining share is 400 W.
  await d._evaluateSimpleDevices({ soc: 80, powerW: 0 }, -500, [dev], state, 'start', 'stop', 'tok',
    { min_battery_soc: 50 }, 400);
  assert.deepStrictEqual(d._setOnCalls, [{ id: 'd1', on: false }], 'the share could not reclaim a running device');
});

// A run the EMS commanded can end two ways, and they used to be reported identically.
// The start card is a flow the OWNER writes, and a flow may decline — a field report of an
// air conditioner "switched off outside the EMS" four times turned out to be a temperature
// condition in that flow, so the device was never on to be switched off.
function adoptionEvents(seenOn) {
  const d = makeSimpleDevice();
  d.events = [];
  d._addHistoryEvent = (type, event, label) => d.events.push({ event, label });
  const now = Date.now();
  const st = { isOn: true, startedAt: now - 300_000, surplusOkSince: null, surplusBadSince: null,
               powerDropStoppedAt: null };
  if (seenOn !== 'absent') st.seenOn = seenOn;
  return { d, st, now };
}

test('_evaluateSimpleDevices — a start that never took hold is not reported as an external off', async () => {
  const { d, st } = adoptionEvents(false); // commanded on, never once observed running
  const dev = simpleDev({ actualOn: false, stateSource: 'onoff', minSurplusW: 1200 });
  await d._evaluateSimpleDevices({ soc: 80, powerW: 0 }, -5000, [dev], new Map([['d1', st]]),
    'start', 'stop', 'tok', { min_battery_soc: 50 }, 5000);
  assert.deepStrictEqual(d.events.map((e) => e.event), ['start_no_effect'],
    'the flow declined — nobody switched anything off');
  assert.strictEqual(st.isOn, false, 'the state is still adopted either way');
});

test('_evaluateSimpleDevices — a device that really ran keeps the external-off reading', async () => {
  const { d, st } = adoptionEvents(true); // seen running, then went off
  const dev = simpleDev({ actualOn: false, stateSource: 'onoff', minSurplusW: 1200 });
  await d._evaluateSimpleDevices({ soc: 80, powerW: 0 }, -5000, [dev], new Map([['d1', st]]),
    'start', 'stop', 'tok', { min_battery_soc: 50 }, 5000);
  assert.deepStrictEqual(d.events.map((e) => e.event), ['manual_off']);
});

test('_evaluateSimpleDevices — a restored run with no record falls back to the cautious reading', async () => {
  const { d, st } = adoptionEvents('absent'); // state restored across a restart
  const dev = simpleDev({ actualOn: false, stateSource: 'onoff', minSurplusW: 1200 });
  await d._evaluateSimpleDevices({ soc: 80, powerW: 0 }, -5000, [dev], new Map([['d1', st]]),
    'start', 'stop', 'tok', { min_battery_soc: 50 }, 5000);
  assert.deepStrictEqual(d.events.map((e) => e.event), ['manual_off'],
    'undefined must not be read as "never took hold" — the app could not observe the run');
});

test('_evaluateSimpleDevices — being seen on inside the startup grace still counts', async () => {
  const { d, st, now } = adoptionEvents(false);
  st.startedAt = now - 10_000; // still inside the 120 s grace
  const dev = simpleDev({ actualOn: true, stateSource: 'onoff', minSurplusW: 1200 });
  await d._evaluateSimpleDevices({ soc: 80, powerW: 0 }, -5000, [dev], new Map([['d1', st]]),
    'start', 'stop', 'tok', { min_battery_soc: 50 }, 5000);
  assert.strictEqual(st.seenOn, true, 'a sighting during the grace window must be recorded');
  assert.deepStrictEqual(d.events.map((e) => e.event), [], 'nothing has ended yet');
});

// The tests above stub _simpleDeviceSetOn, so they cannot see it arm the record. This one
// runs the real method: without the reset, a second run inherits the first run's sighting
// and a start that never took hold would be misreported as an external off again.
test('_simpleDeviceSetOn — a fresh start arms the sighting record, a stop clears it', async () => {
  const d = Object.assign({
    log() {}, _warmupDone: true, _addHistoryEvent() {}, _postNotification() {},
    _settleWithin: async (p) => p,
    homey: { flow: { getTriggerCard: () => ({ trigger: () => Promise.resolve() }) } },
  }, simpleDevicesMixin);
  const st = { isOn: false, startedAt: null, seenOn: true }; // leftover from an earlier run
  const map = new Map([['d1', st]]);

  await d._simpleDeviceSetOn('d1', 'Klima', true, map, 'start', 'stop', 'tok');
  assert.strictEqual(st.seenOn, false, 'a new run must start with no sighting on record');

  st.seenOn = true;
  await d._simpleDeviceSetOn('d1', 'Klima', false, map, 'start', 'stop', 'tok');
  assert.strictEqual(st.seenOn, undefined, 'a stop leaves no stale sighting behind');
});

test('_evaluateSimpleDevices — the same device keeps running when the share does cover it', async () => {
  const d = makeSimpleDevice();
  const now = Date.now();
  const state = new Map([['d1', { isOn: true, startedAt: now - 600_000, surplusOkSince: null, surplusBadSince: null, powerDropStoppedAt: null }]]);
  const dev = simpleDev({ minSurplusW: 2000, stopGraceMs: 0, powerW: 2000 });
  await d._evaluateSimpleDevices({ soc: 80, powerW: 0 }, -500, [dev], state, 'start', 'stop', 'tok',
    { min_battery_soc: 50 }, 2500);
  assert.deepStrictEqual(d._setOnCalls, [{ id: 'd1', on: true }]);
});

test('_evaluateSimpleDevices — no ramp configured leaves the decision exactly as it was', async () => {
  const d = makeSimpleDevice();
  const now = Date.now();
  const state = new Map([['d1', { isOn: true, startedAt: now - 600_000, surplusOkSince: null, surplusBadSince: null, powerDropStoppedAt: null }]]);
  const dev = simpleDev({ minSurplusW: 2000, stopGraceMs: 0, powerW: 2000 });
  await d._evaluateSimpleDevices({ soc: 80, powerW: 0 }, -500, [dev], state, 'start', 'stop', 'tok',
    { min_battery_soc: 50 }, null);
  assert.deepStrictEqual(d._setOnCalls, [{ id: 'd1', on: true }]);
});

// ── dropping a phase instead of stopping ─────────────────────────────────────
// The phase-switch cooldown exists to stop a charger flipping between one and three phases.
// Dropping to one phase when three no longer fit is not that kind of flip: three phases
// cannot go below MIN_3PH_W, so the alternative to switching is not "stay put", it is a full
// stop. Holding the cooldown there bought stability by trading a phase change for an outage
// — five times in two hours in the 2026-08-26 log.
const CHARGER_SWITCH = { id: 'c1', connected: true, minAmps: 6, maxAmps: 32, phases: 3, phaseSwitch: true };

test('_stepCharger — trapped at three phases inside the cooldown, it drops a phase rather than stop', async () => {
  const d = makeChargerDevice();
  seedState(d, 'c1', { currentAmps: 6, currentPhases: 3, lastPhaseSwitchAt: T, lastDownStepAt: null });

  // 3000 W: below MIN_3PH_W (4140) so no three-phase rung fits, but plenty for one phase.
  const r = await d._stepCharger(CHARGER_SWITCH, 3000, 3, T + 1000, 0, false);

  assert.strictEqual(r.phases, 1, 'it stayed on three phases and had to stop');
  assert.ok(r.amps >= 6, 'the charger was stopped instead of stepped down');
  assert.strictEqual(d._getChargerState('c1').currentPhases, 1);
});

// The hysteresis is only worth having if the caller hands _bestPhases the phase count the
// charger is actually on. Passing a fixed 1 there would make a running three-phase charger
// drop to one the moment the budget fell into the band — which is the flapping again, one
// step further down.
test('_stepCharger — inside the hysteresis band a three-phase charger stays on three', async () => {
  const d = makeChargerDevice();
  seedState(d, 'c1', { currentAmps: 6, currentPhases: 3, lastPhaseSwitchAt: null, lastDownStepAt: null });

  // 4400 W: above MIN_3PH_W (4140), below the commit threshold (4830). A charger already on
  // three phases carries this; one on a single phase would not commit for it.
  const r = await d._stepCharger(CHARGER_SWITCH, 4400, 3, T, -4400, false);
  assert.strictEqual(r.phases, 3, 'it dropped a phase it could still carry');
  assert.strictEqual(d._getChargerState('c1').currentPhases, 3);
});

// The counter-check that keeps the escape from becoming a new oscillation: upwards the
// cooldown still applies in full.
test('_stepCharger — the cooldown still blocks switching UP to three phases', async () => {
  const d = makeChargerDevice();
  seedState(d, 'c1', { currentAmps: 16, currentPhases: 1, lastPhaseSwitchAt: T, lastDownStepAt: null });

  // Well past the margin, so the only thing that can hold it back is the cooldown.
  const r = await d._stepCharger(CHARGER_SWITCH, 8000, 3, T + 1000, -8000, false);
  assert.strictEqual(r.phases, 1, 'it switched up inside the cooldown');
});

test('_stepCharger — once the cooldown is over, switching up happens normally', async () => {
  const d = makeChargerDevice();
  seedState(d, 'c1', { currentAmps: 16, currentPhases: 1, lastPhaseSwitchAt: T, lastDownStepAt: null });
  const r = await d._stepCharger(CHARGER_SWITCH, 8000, 3, T + 11 * 60_000, -8000, false);
  assert.strictEqual(r.phases, 3, 'the switch up never happens any more');
});

// ── the confirmation time before REDUCING ────────────────────────────────────
// Stepping up has always had to be earned; stepping down was immediate. That asymmetry is
// right for a house without storage, where every second over budget is bought from the
// grid — but with a battery it is needlessly twitchy: the battery bridges a passing cloud
// while the charger drops a rung it has to climb back a minute later, and each drop costs
// another FLIP_COOLDOWN_MS before it may rise at all.
//
// Off by default, so an install that never touches the field behaves exactly as before.
const CHARGER_1PH_DOWN = { ...CHARGER_1PH, stepDownHoldMs: 120_000 };

test('_stepCharger — with no down-hold configured, a reduction still lands at once', async () => {
  const d = makeChargerDevice();
  seedState(d, 'c1', { currentAmps: 16, currentPhases: 1 });
  const r = await d._stepCharger(CHARGER_1PH, 1500, 1, T, 0, false); // budget now fits 6 A only
  assert.strictEqual(r.amps, 6, 'the old behaviour must survive untouched');
});

test('_stepCharger — a configured down-hold makes the charger wait before reducing', async () => {
  const d = makeChargerDevice();
  seedState(d, 'c1', { currentAmps: 16, currentPhases: 1 });

  let r = await d._stepCharger(CHARGER_1PH_DOWN, 1500, 1, T, 0, false);
  assert.strictEqual(r.amps, 16, 'it reduced immediately despite the hold');
  assert.strictEqual(d._getChargerState('c1').pendingDownSince, T, 'the clock never started');

  r = await d._stepCharger(CHARGER_1PH_DOWN, 1500, 1, T + 119_000, 0, false);
  assert.strictEqual(r.amps, 16, 'it gave up before the hold was over');

  r = await d._stepCharger(CHARGER_1PH_DOWN, 1500, 1, T + 121_000, 0, false);
  assert.strictEqual(r.amps, 6, 'the hold expired and nothing happened');
  assert.strictEqual(d._getChargerState('c1').pendingDownSince, null, 'the clock was not cleared');
});

// The clock must track "a reduction is wanted", not the destination rung. Keyed on the
// target it would restart whenever the surplus wobbled between two rungs, and the step
// would never arrive.
test('_stepCharger — a target that wobbles between rungs does not restart the down-hold', async () => {
  const d = makeChargerDevice();
  seedState(d, 'c1', { currentAmps: 16, currentPhases: 1 });

  await d._stepCharger(CHARGER_1PH_DOWN, 1500, 1, T, 0, false);           // wants 6 A
  await d._stepCharger(CHARGER_1PH_DOWN, 2100, 1, T + 60_000, 0, false);  // now wants 9 A
  assert.strictEqual(d._getChargerState('c1').pendingDownSince, T, 'the clock restarted on a new target');

  // Past the hold, it steps to whatever the target is NOW, not the one that started it.
  const r = await d._stepCharger(CHARGER_1PH_DOWN, 2100, 1, T + 121_000, 0, false);
  assert.strictEqual(r.amps, 9);
});

test('_stepCharger — surplus returning cancels a pending reduction', async () => {
  const d = makeChargerDevice();
  seedState(d, 'c1', { currentAmps: 16, currentPhases: 1 });

  await d._stepCharger(CHARGER_1PH_DOWN, 1500, 1, T, 0, false);
  assert.strictEqual(d._getChargerState('c1').pendingDownSince, T);

  // Budget back at the current rung → steady, and the pending reduction is off.
  await d._stepCharger(CHARGER_1PH_DOWN, 16 * 230, 1, T + 30_000, 0, false);
  assert.strictEqual(d._getChargerState('c1').pendingDownSince, null,
    'an answered dip could still fire a reduction later');
});

// A rise answers the dip that armed the clock. Leaving it running would let that stale dip
// fire a reduction later, straight through a climb.
test('_stepCharger — a step up clears a pending reduction', async () => {
  const d = makeChargerDevice();
  seedState(d, 'c1', { currentAmps: 10, currentPhases: 1, lastDownStepAt: null });

  await d._stepCharger(CHARGER_1PH_DOWN, 1500, 1, T, 0, false); // wants down to 6 A → arms
  assert.strictEqual(d._getChargerState('c1').pendingDownSince, T);

  // Surplus now well above the current rung → the up branch runs.
  await d._stepCharger(CHARGER_1PH_DOWN, 6000, 1, T + 30_000, -6000, false);
  assert.strictEqual(d._getChargerState('c1').pendingDownSince, null,
    'the stale dip can still fire a reduction after the charger has climbed');
});

// The one case the delay must never touch: sustained grid import is not a passing cloud,
// it is the house already paying for the overdraw.
test('_stepCharger — sustained import reduces at once, whatever the down-hold says', async () => {
  const d = makeChargerDevice();
  seedState(d, 'c1', { currentAmps: 16, currentPhases: 1 });
  const r = await d._stepCharger(CHARGER_1PH_DOWN, 1500, 1, T, 3000, true); // forcedDown
  assert.strictEqual(r.amps, 6, 'the down-hold delayed a forced reduction');
  assert.strictEqual(d._getChargerState('c1').pendingDownSince, null);
});

test('_stepCharger — running, no rung fits, still exporting → hold at minimum', async () => {
  const d = makeChargerDevice();
  seedState(d, 'c1', { currentAmps: 10, currentPhases: 1 });
  // budget below the 6 A rung, but grid is exporting past the guard → hold at 6 A, don't stop.
  const r = await d._stepCharger(CHARGER_1PH, 800, 1, T, -(EXPORT_GUARD_W + 100), false);
  assert.strictEqual(r.amps, 6);
  assert.strictEqual(d._getChargerState('c1').currentAmps, 6);
});

test('_stepCharger — running, no rung fits, not exporting → stop', async () => {
  const d = makeChargerDevice();
  seedState(d, 'c1', { currentAmps: 10, currentPhases: 1 });
  const r = await d._stepCharger(CHARGER_1PH, 800, 1, T, 0, false); // not exporting
  assert.strictEqual(r.amps, 0);
  assert.strictEqual(r.allocatedW, 0);
  assert.strictEqual(d._getChargerState('c1').currentAmps, null); // stopped
});

test('_stepCharger — down-step held while still exporting, bypassed when forced', async () => {
  // Running at 16 A, budget now only supports 6 A, but grid still exporting past guard.
  const d = makeChargerDevice();
  seedState(d, 'c1', { currentAmps: 16, currentPhases: 1 });
  const held = await d._stepCharger(CHARGER_1PH, 1380, 1, T, -(EXPORT_GUARD_W + 100), false);
  assert.strictEqual(held.amps, 16); // export guard holds the higher rung
  assert.strictEqual(d._getChargerState('c1').currentAmps, 16);
  // Forced down (sustained import) bypasses the guard and steps immediately.
  const forced = await d._stepCharger(CHARGER_1PH, 1380, 1, T + 1, 300, true);
  assert.strictEqual(forced.amps, 6);
  assert.strictEqual(d._getChargerState('c1').currentAmps, 6);
});

// Regression: a running single-phase charger must ramp UP with growing surplus.
// (Previously stuck forever at its start amps because UP_MARGIN_W 250 W > the 230 W
//  single-phase rung gap made the step-up guard mathematically unsatisfiable.)
test('_stepCharger — 1-phase charger ramps up with surplus (leaving margin)', async () => {
  const d = makeChargerDevice();
  seedState(d, 'c1', { currentAmps: 6, currentPhases: 1 });
  // 6000 W budget: highest rung leaving 250 W headroom is 25 A (5750 W); 26 A (5980) + 250 > 6000.
  let r = await d._stepCharger(CHARGER_1PH, 6000, 1, T, -6000, false);
  assert.strictEqual(r.amps, 6); // first tick arms the pending step
  assert.strictEqual(d._getChargerState('c1').pendingStepAmps, 25);
  r = await d._stepCharger(CHARGER_1PH, 6000, 1, T + STEP_HOLD_MS + 1, -6000, false);
  assert.strictEqual(r.amps, 25); // committed after the hold
  assert.strictEqual(d._getChargerState('c1').currentAmps, 25);
});

test('_stepCharger — 1-phase step-up still honours the import margin', async () => {
  const d = makeChargerDevice();
  seedState(d, 'c1', { currentAmps: 6, currentPhases: 1 });
  // Budget exactly covers 7 A (1610 W) but leaves no 250 W margin → must NOT step up.
  const r = await d._stepCharger(CHARGER_1PH, 1610, 1, T, -1610, false);
  assert.strictEqual(r.amps, 6);
  assert.strictEqual(d._getChargerState('c1').pendingStepAmps, null); // no step armed
  // With margin present (1610 + 250) it steps to 7 A after the hold.
  await d._stepCharger(CHARGER_1PH, 1860, 1, T + 1, -1860, false); // arm
  const up = await d._stepCharger(CHARGER_1PH, 1860, 1, T + 1 + STEP_HOLD_MS + 1, -1860, false);
  assert.strictEqual(up.amps, 7);
});

// ── pvForecast: Solcast parsing + aggregation ────────────────────────────────
test('_pvPeriodHours parses ISO-8601 durations', () => {
  const d = makeDevice();
  assert.strictEqual(d._pvPeriodHours('PT30M'), 0.5);
  assert.strictEqual(d._pvPeriodHours('PT1H'), 1);
  assert.strictEqual(d._pvPeriodHours('PT15M'), 0.25);
  assert.strictEqual(d._pvPeriodHours('PT1H30M'), 1.5);
  assert.strictEqual(d._pvPeriodHours('garbage'), 0.5); // default
  assert.strictEqual(d._pvPeriodHours(undefined), 0.5);
});

test('_parseSolcastForecasts — maps, sorts, drops invalid rows', () => {
  const d = makeDevice();
  const slots = d._parseSolcastForecasts({ forecasts: [
    { period_end: '2026-07-27T10:30:00.0000000Z', pv_estimate: 3.5, pv_estimate10: 2.0, pv_estimate90: 4.5, period: 'PT30M' },
    { period_end: '2026-07-27T10:00:00.0000000Z', pv_estimate: 3.0, period: 'PT30M' }, // earlier → sorts first
    { period_end: 'not-a-date',                   pv_estimate: 9,   period: 'PT30M' }, // bad timestamp → dropped
    { period_end: '2026-07-27T11:00:00.0000000Z', pv_estimate: 'x', period: 'PT30M' }, // bad power → dropped
  ] });
  assert.strictEqual(slots.length, 2);
  assert.ok(slots[0].end < slots[1].end);          // ascending
  assert.strictEqual(slots[0].kw, 3.0);
  assert.strictEqual(slots[1].kw, 3.5);
  assert.strictEqual(slots[1].kw10, 2.0);
  assert.strictEqual(slots[0].kw10, null);          // missing percentile → null
  assert.strictEqual(slots[0].h, 0.5);
});
test('_parseSolcastForecasts — empty / missing forecasts → []', () => {
  const d = makeDevice();
  assert.deepStrictEqual(d._parseSolcastForecasts({}), []);
  assert.deepStrictEqual(d._parseSolcastForecasts(null), []);
});

test('_pvSumKwh sums kW×h for slots whose end is in (from, to]', () => {
  const d = makeDevice();
  const slots = [
    { end: 1000, kw: 4, h: 0.5 },
    { end: 2000, kw: 2, h: 0.5 },
    { end: 3000, kw: 6, h: 0.5 },
  ];
  assert.strictEqual(d._pvSumKwh(slots, 1000, 3000), 4); // 2·0.5 + 6·0.5 (end 1000 excluded, 3000 included)
  assert.strictEqual(d._pvSumKwh(slots, 0, 1000), 2);    // only end 1000
  assert.strictEqual(d._pvSumKwh(slots, 3000, 9000), 0); // nothing after
  assert.strictEqual(d._pvSumKwh(null, 0, 9000), 0);
});

test('_pvMsUntilLocalMidnight — deterministic in UTC', () => {
  const d = makeDevice();
  const now = Date.UTC(2026, 0, 1, 22, 0, 0); // 22:00 UTC → 2 h to midnight
  assert.strictEqual(d._pvMsUntilLocalMidnight(now, 'UTC'), 2 * 3600 * 1000);
});

test('_pvForecastNextKwh — energy over the next N hours', () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const d = makeDevice({ _pvForecastFetchedAt: now, _pvForecast: [
    { end: now + 30 * 60000, kw: 4, h: 0.5 },
    { end: now + 60 * 60000, kw: 2, h: 0.5 },
    { end: now + 180 * 60000, kw: 8, h: 0.5 }, // +3 h → outside a 2 h window
  ] });
  assert.strictEqual(d._pvForecastNextKwh(2, now), 3); // 4·0.5 + 2·0.5
  assert.strictEqual(d._pvForecastNextKwh(0, now), 0);
});

test('_pvForecastStale — fresh / old / never-fetched / no-data', () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const slots = [{ end: now + 30 * 60000, kw: 4, h: 0.5 }];
  assert.strictEqual(makeDevice({ _pvForecast: slots, _pvForecastFetchedAt: now })._pvForecastStale(now), false);
  assert.strictEqual(makeDevice({ _pvForecast: slots, _pvForecastFetchedAt: now - 25 * 3600 * 1000 })._pvForecastStale(now), true);
  assert.strictEqual(makeDevice({ _pvForecast: slots, _pvForecastFetchedAt: null })._pvForecastStale(now), true);
  assert.strictEqual(makeDevice({ _pvForecast: null, _pvForecastFetchedAt: now })._pvForecastStale(now), true);
});

test('_pvForecast aggregation helpers return 0 when stale', () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const d = makeDevice({
    homey: { clock: { getTimezone: () => 'UTC' } },
    _pvForecastFetchedAt: now - 25 * 3600 * 1000, // > 24 h → stale
    _pvForecast: [{ end: now + 30 * 60000, kw: 4, h: 0.5 }, { end: now + 60 * 60000, kw: 2, h: 0.5 }],
  });
  assert.strictEqual(d._pvForecastNextKwh(6, now), 0);
  assert.strictEqual(d._pvForecastNowKw(now), 0);
  assert.strictEqual(d._pvForecastRemainingTodayKwh(now), 0);
  assert.strictEqual(d._pvForecastTomorrowKwh(now), 0);
  assert.strictEqual(d._pvForecastUntilKwh('16:00', now), 0);
});

test('_solcastResourceIds — single / multi / separators', () => {
  const d = makeDevice();
  assert.deepStrictEqual(d._solcastResourceIds({ solcast_resource_id: 'abcd-1234' }), ['abcd-1234']);
  assert.deepStrictEqual(d._solcastResourceIds({ solcast_resource_id: 'a-1\nb-2' }), ['a-1', 'b-2']);
  assert.deepStrictEqual(d._solcastResourceIds({ solcast_resource_id: 'a-1, b-2 ; c-3' }), ['a-1', 'b-2', 'c-3']);
  assert.deepStrictEqual(d._solcastResourceIds({ solcast_resource_id: '   ' }), []);
  assert.deepStrictEqual(d._solcastResourceIds({}), []);
});

test('_mergeForecastSlots — sums two sites per slot end-time', () => {
  const d = makeDevice();
  const north = [{ end: 1000, kw: 3, kw10: 2, kw90: 4, h: 0.5 }, { end: 2000, kw: 1, kw10: null, kw90: 2, h: 0.5 }];
  const south = [{ end: 1000, kw: 5, kw10: 3, kw90: 6, h: 0.5 }, { end: 2000, kw: 2, kw10: 1, kw90: 3, h: 0.5 }];
  const merged = d._mergeForecastSlots([north, south]);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[0].kw, 8);        // 3 + 5
  assert.strictEqual(merged[0].kw10, 5);       // 2 + 3
  assert.strictEqual(merged[1].kw, 3);        // 1 + 2
  assert.strictEqual(merged[1].kw10, null);    // one site missing P10 → null
  assert.strictEqual(merged[0].h, 0.5);
});
test('_mergeForecastSlots — single array passes through', () => {
  const d = makeDevice();
  const one = [{ end: 1000, kw: 3, kw10: null, kw90: null, h: 0.5 }];
  assert.strictEqual(d._mergeForecastSlots([one]), one);
});

test('_pvForecastNowKw — current in-progress slot', () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const d = makeDevice({ _pvForecastFetchedAt: now, _pvForecast: [
    { end: now - 10 * 60000, kw: 9, h: 0.5 }, // already ended → not "now"
    { end: now + 20 * 60000, kw: 4, h: 0.5 }, // in progress → this one
    { end: now + 50 * 60000, kw: 6, h: 0.5 },
  ] });
  assert.strictEqual(d._pvForecastNowKw(now), 4);
  assert.strictEqual(makeDevice({ _pvForecastFetchedAt: now, _pvForecast: [] })._pvForecastNowKw(now), 0);
});

test('_pvForecastTomorrowKwh — sums the next local calendar day', () => {
  const now = Date.UTC(2026, 0, 1, 22, 0, 0); // 22:00 UTC → midnight in 2 h
  const mid = now + 2 * 3600 * 1000;           // next local midnight (UTC)
  const d = makeDevice({
    homey: { clock: { getTimezone: () => 'UTC' } },
    _pvForecastFetchedAt: now,
    _pvForecast: [
      { end: now + 60 * 60000,        kw: 5, h: 0.5 }, // still today → excluded
      { end: mid + 6 * 3600 * 1000,   kw: 4, h: 0.5 }, // tomorrow 06:00
      { end: mid + 12 * 3600 * 1000,  kw: 8, h: 0.5 }, // tomorrow 12:00
      { end: mid + 30 * 3600 * 1000,  kw: 9, h: 0.5 }, // day after → excluded
    ],
  });
  assert.strictEqual(d._pvForecastTomorrowKwh(now), 6); // 4·0.5 + 8·0.5
});

test('_pvForecastConfigured — needs enabled + key + at least one site', () => {
  const d = makeDevice();
  assert.strictEqual(d._pvForecastConfigured({ pv_forecast_enabled: true, solcast_api_key: 'k', solcast_resource_id: 'a-1' }), true);
  assert.strictEqual(d._pvForecastConfigured({ pv_forecast_enabled: false, solcast_api_key: 'k', solcast_resource_id: 'a-1' }), false);
  assert.strictEqual(d._pvForecastConfigured({ pv_forecast_enabled: true, solcast_api_key: '', solcast_resource_id: 'a-1' }), false);
  assert.strictEqual(d._pvForecastConfigured({ pv_forecast_enabled: true, solcast_api_key: 'k', solcast_resource_id: '' }), false);
});

test('_pvMsUntilLocalTime — future / past / invalid', () => {
  const d = makeDevice();
  const now = Date.UTC(2026, 0, 1, 14, 0, 0); // 14:00 UTC
  assert.strictEqual(d._pvMsUntilLocalTime(now, 'UTC', '16:00'), 2 * 3600 * 1000); // 2 h ahead
  assert.strictEqual(d._pvMsUntilLocalTime(now, 'UTC', '13:00'), 0);               // already passed → 0
  assert.strictEqual(d._pvMsUntilLocalTime(now, 'UTC', 'nope'), 0);                // invalid → 0
});

test('_pvForecastUntilKwh — sums up to a wall-clock cutoff today', () => {
  const now = Date.UTC(2026, 0, 1, 14, 0, 0); // 14:00 UTC
  const d = makeDevice({
    homey: { clock: { getTimezone: () => 'UTC' } },
    _pvForecastFetchedAt: now,
    _pvForecast: [
      { end: now + 30 * 60000,  kw: 4, h: 0.5 }, // 14:30 → before 16:00
      { end: now + 90 * 60000,  kw: 2, h: 0.5 }, // 15:30 → before 16:00
      { end: now + 150 * 60000, kw: 8, h: 0.5 }, // 16:30 → after 16:00 (excluded)
    ],
  });
  assert.strictEqual(d._pvForecastUntilKwh('16:00', now), 3); // 4·0.5 + 2·0.5
  assert.strictEqual(d._pvForecastUntilKwh('13:00', now), 0); // cutoff already passed
});

// ── simpleDevices: _evaluateSimpleDevices state machine ──────────────────────
test('_evaluateSimpleDevices — a leftover class-wide control flag is ignored', async () => {
  // Bis 1.2.79 gab es neben dem Geraete-Flag ein klassenweites, das VOR ihm geprueft wurde
  // und es still ueberstimmte — die Ursache widerspruechlicher Anzeigen zwischen
  // Einstellungsseite und Widget. Es ist entfernt; eine alte Konfiguration kann den Wert
  // aber noch enthalten, und dann darf er nichts mehr bewirken.
  const d = makeSimpleDevice();
  const now = Date.now();
  const state = new Map([['d1', { isOn: false, startedAt: null, surplusOkSince: now - 61_000, surplusBadSince: null, powerDropStoppedAt: null }]]);
  await d._evaluateSimpleDevices({ soc: 90, powerW: 0 }, -2000, [simpleDev()], state, 'start', 'stop', 'tok', { ctrl: false, min_battery_soc: 80 });
  assert.ok(d._setOnCalls.length > 0, 'das alte Klassen-Flag darf das Geraet nicht mehr blockieren');
});

test('_evaluateSimpleDevices — a per-device enabled:false is left alone even with ample surplus (type-wide control stays on)', async () => {
  const d = makeSimpleDevice();
  const now = Date.now();
  const state = new Map([['d1', { isOn: false, startedAt: null, surplusOkSince: now - 61_000, surplusBadSince: null, powerDropStoppedAt: null }]]);
  await d._evaluateSimpleDevices({ soc: 90, powerW: 0 }, -2000, [simpleDev({ enabled: false })], state, 'start', 'stop', 'tok', { min_battery_soc: 80 });
  assert.strictEqual(d._setOnCalls.length, 0); // never touched
  assert.strictEqual(state.get('d1').isOn, false); // stateMap untouched too
});

// ── battery: "already announced" flags across a restart ──────────────────────
// Field, 2026-08-16: "66% < 80% — Batterie tief" at 23:04 AND at 23:05, once per app start,
// either side of a deploy. Two of the day's four announcements were restart artefacts, and
// every flow hanging off ems_battery_low ran for nothing.
function makeBatteryStateDevice(stored = undefined) {
  const store = { batteryStates: stored };
  const dev = {
    log() {},
    _batteryStates: new Map(),
    getStoreValue: (k) => Promise.resolve(store[k]),
    setStoreValue: (k, v) => { store[k] = v; return Promise.resolve(); },
    _store: store,
  };
  Object.assign(dev, batteryMixin);
  return dev;
}

test('_saveBatteryStates / _restoreBatteryStates — an announcement is not repeated after a restart', async () => {
  const a = makeBatteryStateDevice();
  a._batteryStates.set('bat1', { fullFired: false, lowFired: true });
  a._saveBatteryStates();

  const b = makeBatteryStateDevice(a._store.batteryStates);
  await b._restoreBatteryStates();
  assert.strictEqual(b._batteryStates.get('bat1').lowFired, true);
  assert.strictEqual(b._batteryStates.get('bat1').fullFired, false);
});

test('_restoreBatteryStates — priceMode is deliberately NOT carried over', async () => {
  // It sits on the same entry and also re-fires after a restart, but it is a COMMAND to the
  // battery that the EMS cannot read back — believing an unverified hardware state is the
  // mistake that cost a house battery in July. Re-commanding is the safe direction.
  const a = makeBatteryStateDevice();
  a._batteryStates.set('bat1', { fullFired: false, lowFired: true, priceMode: 'charge' });
  a._saveBatteryStates();
  assert.ok(!('priceMode' in a._store.batteryStates.bat1), 'not even written');

  const b = makeBatteryStateDevice({ bat1: { lowFired: true, priceMode: 'charge' } });
  await b._restoreBatteryStates();
  assert.strictEqual(b._batteryStates.get('bat1').priceMode, undefined);
});

test('_saveBatteryStates — writes only when a flag actually moved', async () => {
  const d = makeBatteryStateDevice();
  d._batteryStates.set('bat1', { fullFired: false, lowFired: true });
  assert.strictEqual(d._saveBatteryStates(), true);
  assert.strictEqual(d._saveBatteryStates(), false, 'unchanged — the tick runs every 20 s');
  d._batteryStates.get('bat1').lowFired = false;
  assert.strictEqual(d._saveBatteryStates(), true);
});

test('_restoreBatteryStates — a missing or malformed blob is not an error', async () => {
  for (const blob of [undefined, null, 'nonsense', { bat1: null }]) {
    const d = makeBatteryStateDevice(blob);
    await d._restoreBatteryStates();
    assert.strictEqual(d._batteryStates.size, 0);
  }
});

// ── simpleDevices: state persistence across restarts ─────────────────────────
// Ein Geraet mit Fake-Settings und den fuenf leeren Zustandstabellen.
function makeStateDevice(stored = undefined) {
  const store = { value: stored };
  const dev = {
    log() {},
    homey: { settings: { get: () => store.value, set: (_k, v) => { store.value = v; } } },
    _heatPumpStates: new Map(), _boilerStates: new Map(), _poolStates: new Map(),
    _dehumidifierStates: new Map(), _airconStates: new Map(),
  };
  Object.assign(dev, simpleDevicesMixin);
  dev._store = store;
  return dev;
}

test('_saveSimpleStates / _restoreSimpleStates — timers survive a restart', async () => {
  // Der Kern: startedAt und surplusBadSince sind absolute Zeitstempel. Gehen sie beim
  // Neustart verloren, beginnt jede Stopp-Karenz von vorn — ein Geraet mit 30 Minuten
  // Karenz schaltet dann ueber einen Tag mit vielen Deployments nie ab.
  const t0 = Date.now() - 400_000;
  const a = makeStateDevice();
  a._poolStates.set('p1', { isOn: true, startedAt: t0, surplusOkSince: null, surplusBadSince: t0 + 60_000, powerDropStoppedAt: null, lastDiagKey: 'grace' });
  a._saveSimpleStates();

  const b = makeStateDevice(a._store.value);
  b._restoreSimpleStates();
  const st = b._poolStates.get('p1');
  assert.strictEqual(st.isOn, true);
  assert.strictEqual(st.startedAt, t0);
  assert.strictEqual(st.surplusBadSince, t0 + 60_000);
  assert.ok(!('lastDiagKey' in st), 'reines Log-Feld gehoert nicht in den gespeicherten Zustand');
});

// Nothing pruned these maps, so a device removed from the settings kept its entry for good:
// restored on every boot, listed in every diagnostics export. Field export 2026-08-30 still
// carried a pool paired and removed long before — no name, no measurements, and no way for
// the owner to get rid of it.
test('_restoreSimpleStates — an entry for a device no longer configured is dropped', async () => {
  const snap = { savedAt: Date.now() - 1000, maps: { pool: {
    keep:  { isOn: true, startedAt: 1 },
    ghost: { isOn: false, startedAt: 1 },
  } } };
  const d = makeStateDevice(snap);
  d._getConfig = () => ({ pool_devices: [{ id: 'keep' }] });
  const lines = [];
  d.log = (l) => lines.push(String(l));

  d._restoreSimpleStates();
  assert.ok(d._poolStates.has('keep'), 'a configured device lost its timers');
  assert.ok(!d._poolStates.has('ghost'), 'the leftover entry came back');
  assert.ok(lines.some((l) => /dropped 1 entry/.test(l)), 'it vanished without saying so');
});

// The guard that matters more than the feature: an empty or failed settings read looks
// exactly like "nothing is configured", and pruning against that would throw away the timers
// of every device that IS configured.
test('_restoreSimpleStates — an empty configuration prunes nothing', async () => {
  const snap = { savedAt: Date.now() - 1000, maps: { pool: { p1: { isOn: true, startedAt: 1 } } } };
  for (const cfg of [{}, { pool_devices: [] }, null]) {
    const d = makeStateDevice(snap);
    d._getConfig = () => cfg;
    d._restoreSimpleStates();
    assert.strictEqual(d._poolStates.size, 1, `pruned everything on cfg ${JSON.stringify(cfg)}`);
  }
});

test('_restoreSimpleStates — a device with no _getConfig at all still restores', async () => {
  const snap = { savedAt: Date.now() - 1000, maps: { pool: { p1: { isOn: true, startedAt: 1 } } } };
  const d = makeStateDevice(snap);   // no _getConfig on the fixture
  d._restoreSimpleStates();
  assert.strictEqual(d._poolStates.size, 1);
});

// Pruning is per kind: a boiler and a pool may share an id space only by accident, and an
// entry must be judged against its OWN kind's configuration.
test('_restoreSimpleStates — an id configured under another kind does not save the entry', async () => {
  const snap = { savedAt: Date.now() - 1000, maps: { pool: { x1: { isOn: true, startedAt: 1 } } } };
  const d = makeStateDevice(snap);
  d._getConfig = () => ({ boiler_devices: [{ id: 'x1' }] });
  d._restoreSimpleStates();
  assert.strictEqual(d._poolStates.size, 0, 'a boiler id kept a pool entry alive');
});

test('_restoreSimpleStates — a stale snapshot is discarded, not applied', async () => {
  // Nach Stunden beschreiben die Timer eine Welt, die es nicht mehr gibt. Dann lieber
  // gar nichts wiederherstellen: die Uebernahme aus dem echten Geraetezustand greift.
  const old = { savedAt: Date.now() - 60 * 60_000, maps: { pool: { p1: { isOn: true, startedAt: 1 } } } };
  const d = makeStateDevice(old);
  d._restoreSimpleStates();
  assert.strictEqual(d._poolStates.size, 0);
});

test('_restoreSimpleStates — a timestamp from the future is dropped', async () => {
  // Uhrensprung: ein in der Zukunft liegender Zeitstempel laesst einen Timer nie ablaufen.
  const snap = { savedAt: Date.now() - 1000, maps: { pool: { p1: { isOn: true, startedAt: Date.now() + 3600_000 } } } };
  const d = makeStateDevice(snap);
  d._restoreSimpleStates();
  assert.strictEqual(d._poolStates.get('p1').startedAt, null);
  assert.strictEqual(d._poolStates.get('p1').isOn, true);
});

test('_saveSimpleStates — an unchanged state writes nothing', async () => {
  // Der Tick laeuft alle 15 s; ohne diesen Vergleich waere das ein Settings-Schreibvorgang
  // pro Tick, dauerhaft, fuer unveraenderte Daten.
  const d = makeStateDevice();
  d._poolStates.set('p1', { isOn: true, startedAt: 1, surplusBadSince: null });
  d._saveSimpleStates();
  const first = d._store.value;
  d._saveSimpleStates();
  assert.strictEqual(d._store.value, first, 'zweiter Aufruf ohne Aenderung darf nicht schreiben');
  d._poolStates.get('p1').isOn = false;
  d._saveSimpleStates();
  assert.notStrictEqual(d._store.value, first);
});

test('_saveSimpleStates — savedAt is refreshed even when nothing changed', async () => {
  // savedAt has to answer "how long was this state unattended", not "when did a timer last
  // move". Writing only on change made it answer the second question.
  const d = makeStateDevice();
  const T = 1_770_000_000_000;
  d._poolStates.set('p1', { isOn: true, startedAt: 1, surplusBadSince: null });
  d._saveSimpleStates(false, T);
  assert.strictEqual(d._store.value.savedAt, T);
  assert.strictEqual(d._saveSimpleStates(false, T + 60_000), false, 'not yet due');
  assert.strictEqual(d._saveSimpleStates(false, T + SIMPLE_STATE_SAVE_MS), true);
  assert.strictEqual(d._store.value.savedAt, T + SIMPLE_STATE_SAVE_MS);
});

test('_saveSimpleStates — shutdown forces the write regardless of cadence', async () => {
  const d = makeStateDevice();
  const T = 1_770_000_000_000;
  d._poolStates.set('p1', { isOn: true, startedAt: 1, surplusBadSince: null });
  d._saveSimpleStates(false, T);
  assert.strictEqual(d._saveSimpleStates(true, T + 5_000), true);
  assert.strictEqual(d._store.value.savedAt, T + 5_000);
});

test('a quiet house does not lose its timers to an 18-second deploy', async () => {
  // The 2026-08-15 13:08 restart, verbatim: two lines in the same second read
  // "charger state restored — 18s gap" and "simple-device state discarded — 16 min old".
  // The app had been away eighteen seconds. The simple devices were thrown out because
  // nothing had happened for a quarter of an hour — the steadier the house, the more
  // reliably a deploy erased the timers.
  // _restoreSimpleStates reads the real clock, so the timeline is anchored on it.
  const T = Date.now();
  const a = makeStateDevice();
  a._poolStates.set('p1', { isOn: true, startedAt: T - 900_000, surplusBadSince: null });
  a._saveSimpleStates(false, T - 16 * 60_000);   // last change, sixteen minutes ago
  for (let i = 15; i >= 1; i--) a._saveSimpleStates(false, T - i * 60_000); // quiet ticks
  a._saveSimpleStates(true, T - 18_000);          // onUninit, eighteen seconds ago

  const b = makeStateDevice(a._store.value);
  b._restoreSimpleStates();
  assert.strictEqual(b._poolStates.get('p1').isOn, true);
  assert.strictEqual(b._poolStates.get('p1').startedAt, T - 900_000);
});

test('_evaluateSimpleDevices — a discharging battery is not counted as solar surplus', async () => {
  // Gemessener Fall: PV 291 W, Pool + Entfeuchter + Klima laufen, Batterie liefert 1557 W,
  // Zaehler steht bei -46 W. Beisst nur bei Geraeten MIT Leistungs-Capability: deren
  // eigener Verbrauch wird dem Ueberschuss zugerechnet (sonst wuerde sich ein gerade
  // gestartetes Geraet sofort selbst abschalten), und zusammen mit dem von der Batterie
  // flachgehaltenen Zaehler ergibt das dauerhaft "genug Ueberschuss" — bezahlt aus der
  // Batterie. Ohne den Abzug: 46 + 1500 = 1546 >= 1000 → laeuft weiter.
  const d = makeSimpleDevice();
  const now = Date.now();
  const state = new Map([['d1', { isOn: true, startedAt: now - 600_000, surplusOkSince: null, surplusBadSince: null, powerDropStoppedAt: null }]]);
  const dev = simpleDev({ minSurplusW: 1000, stopGraceMs: 0, powerW: 1500 });
  await d._evaluateSimpleDevices({ soc: 86, powerW: -1557 }, -46, [dev], state, 'start', 'stop', 'tok', { min_battery_soc: 50 });
  assert.deepStrictEqual(d._setOnCalls, [{ id: 'd1', on: false }],
    'die 46 W Einspeisung stammen aus der Batterie, nicht aus der Sonne');
});

// ── what the log says is holding a device ────────────────────────────────────
// The diagnostic chain reports which constraint is keeping a device off, and its order has
// to mirror the wantOn hierarchy — a branch above the one that actually decides names a
// constraint that is not the binding one.
//
// The hard stop had no branch at all. Field log 2026-08-22, 00:36, battery at 2 %: three
// devices reported "start-sustain pending (120s)" while `batHardStop && !batOverflow` had
// already forced wantOn = false. Worse, the line had read "solar-forecast gate — holding
// start" all evening; at midnight the gate opened for the new day, the phase changed, and
// the log announced movement towards a start that the empty battery still forbade.
function diagLines(dev) {
  const lines = [];
  dev.log = (l) => lines.push(String(l));
  return lines;
}

test('_evaluateSimpleDevices — below the hard stop the log names the battery, not a pending start', async () => {
  const d = makeSimpleDevice();
  const lines = diagLines(d);
  const state = new Map();
  const dev = simpleDev({ minSurplusW: 1000, startSustainMs: 120_000 });
  // The surplus has to be genuinely OK, or this proves nothing: the old chain reached its
  // 'sustain' branch only when surplusOk was true, so a fixture with no surplus would leave
  // the branch unentered and pass against the unfixed code. Battery at 2 % and NOT charging,
  // so the overflow exception cannot apply and the hard stop is the only thing deciding.
  await d._evaluateSimpleDevices({ soc: 2, powerW: 0 }, -2000, [dev], state, 'start', 'stop', 'tok',
    { min_battery_soc: 50 });

  assert.ok(!lines.some((l) => /start-sustain pending/.test(l)),
    'it still reports a start that the hard stop forbids');
  const line = lines.find((l) => /hard stop/.test(l));
  assert.ok(line, 'nothing in the log says why the device is off');
  assert.match(line, /SoC 2% below 50%/, 'the line does not name the two figures that decide it');
  // The device is written off, as it always was — what must never happen is a start.
  assert.ok(!d._setOnCalls.some((c) => c.on === true), 'a device was started below the hard stop');
});

// The counter-check that keeps the new branch from swallowing the others: with the battery
// above the stop, the surplus timers are the binding constraint again and must say so.
test('_evaluateSimpleDevices — above the hard stop the start-sustain phase is still reported', async () => {
  const d = makeSimpleDevice();
  const lines = diagLines(d);
  const state = new Map();
  const dev = simpleDev({ minSurplusW: 1000, startSustainMs: 120_000 });
  await d._evaluateSimpleDevices({ soc: 80, powerW: 0 }, -2000, [dev], state, 'start', 'stop', 'tok',
    { min_battery_soc: 50 });

  assert.ok(lines.some((l) => /start-sustain pending/.test(l)),
    'the sustain phase is no longer reported at all');
  assert.ok(!lines.some((l) => /hard stop/.test(l)), 'the hard stop is claimed where it does not apply');
});

// The overflow exception is the one case where the hard stop does NOT hold a device, so the
// branch must not claim it does — otherwise the log contradicts the device that is running.
test('_evaluateSimpleDevices — under the overflow exception the hard stop is not blamed', async () => {
  const d = makeSimpleDevice();
  const lines = diagLines(d);
  const state = new Map();
  const dev = simpleDev({ minSurplusW: 1000, startSustainMs: 0 });
  // Below the stop, but the battery is charging and export clears the START threshold.
  await d._evaluateSimpleDevices({ soc: 20, powerW: 3000 }, -5000, [dev], state, 'start', 'stop', 'tok',
    { min_battery_soc: 50 });

  assert.ok(!lines.some((l) => /hard stop/.test(l)),
    'the overflow exception is running the device while the log blames the hard stop');
});

test('_evaluateSimpleDevices — a charging battery is not mistaken for a discharging one', async () => {
  // Gegenprobe: gleiche Betraege, aber die Batterie LAEDT. Ein Abzug, der das Vorzeichen
  // verliert (etwa ueber Math.abs), wuerde hier ein Geraet abschalten, das voll in der
  // Sonne laeuft — und ohne diesen Test unbemerkt durchgehen.
  const d = makeSimpleDevice();
  const now = Date.now();
  const state = new Map([['d1', { isOn: true, startedAt: now - 600_000, surplusOkSince: null, surplusBadSince: null, powerDropStoppedAt: null }]]);
  const dev = simpleDev({ minSurplusW: 1000, stopGraceMs: 0, powerW: 1500 });
  await d._evaluateSimpleDevices({ soc: 86, powerW: 1557 }, -46, [dev], state, 'start', 'stop', 'tok', { min_battery_soc: 50 });
  assert.deepStrictEqual(d._setOnCalls, [{ id: 'd1', on: true }]);
});

test('_evaluateSimpleDevices — a device adopted at startup does not get a fresh min-run window', async () => {
  // Der Zustands-Map ist nach einem App-Neustart leer. Ein bereits laufendes Geraet wurde
  // dabei mit startedAt = jetzt uebernommen — also so behandelt, als haette es gerade erst
  // gestartet, was ihm 5 Minuten bedingungsloses Weiterlaufen schenkte, unabhaengig vom
  // Ueberschuss. Sichtbar als drei Geraete mit "hold-time active" eine halbe Sekunde nach
  // "[EMS] initialized". Uebernommen heisst nicht gestartet: die Min-Laufzeit schuetzt vor
  // Takten durch einen EIGENEN Startbefehl, den es hier nie gab.
  const d = makeSimpleDevice();
  const state = new Map();   // leer, wie direkt nach dem Neustart
  // actualOn: true → wird als laufend uebernommen. gridW = +500 (Bezug) → kein Ueberschuss.
  const dev = simpleDev({ actualOn: true, stateSource: 'onoff', stopGraceMs: 0 });
  await d._evaluateSimpleDevices({ soc: 90, powerW: 0 }, 500, [dev], state, 'start', 'stop', 'tok', { min_battery_soc: 80 });
  assert.deepStrictEqual(d._setOnCalls, [{ id: 'd1', on: false }],
    'ohne Ueberschuss und ohne Stopp-Karenz muss ein uebernommenes Geraet sofort aus');
});

test('_evaluateSimpleDevices — battery hard-stop forces a running device off', async () => {
  const d = makeSimpleDevice();
  const now = Date.now();
  const state = new Map([['d1', { isOn: true, startedAt: now - 600_000, surplusOkSince: null, surplusBadSince: null, powerDropStoppedAt: null }]]);
  // SoC 10 < min 80 → hard stop; battery idle (no overflow) → off despite ample surplus
  await d._evaluateSimpleDevices({ soc: 10, powerW: 0 }, -2000, [simpleDev()], state, 'start', 'stop', 'tok', { min_battery_soc: 80 });
  assert.deepStrictEqual(d._setOnCalls, [{ id: 'd1', on: false }]);
});

test('_evaluateSimpleDevices — battery-overflow exception keeps it on (guards MIN_CHARGE_W path)', async () => {
  const d = makeSimpleDevice();
  const now = Date.now();
  const state = new Map([['d1', { isOn: true, startedAt: now - 600_000, surplusOkSince: null, surplusBadSince: null, powerDropStoppedAt: null }]]);
  // Hard-stop SoC, but battery charging AND exporting ≥ MIN_CHARGE_W → overflow exception → stays on
  await d._evaluateSimpleDevices({ soc: 10, powerW: 500 }, -(MIN_CHARGE_W + 200), [simpleDev()], state, 'start', 'stop', 'tok', { min_battery_soc: 80 });
  assert.deepStrictEqual(d._setOnCalls, [{ id: 'd1', on: true }]);
});

test('_evaluateSimpleDevices — overflow hysteresis: a running device stays on below the START threshold but above the CONTINUE one', async () => {
  const d = makeSimpleDevice();
  const now = Date.now();
  const state = new Map([['d1', { isOn: true, startedAt: now - 600_000, surplusOkSince: null, surplusBadSince: null, powerDropStoppedAt: null }]]);
  // Export is below MIN_CHARGE_W (the old fixed threshold — would have wrongly hard-stopped
  // a device that only just started, since its own draw reduces the apparent export on the
  // very next tick) but above MIN_CHARGE_W/2 (the CONTINUE threshold) — regression for the
  // reported "Pool/Entfeuchter stop within a minute of starting" bug.
  await d._evaluateSimpleDevices({ soc: 10, powerW: 500 }, -(MIN_CHARGE_W / 2 + 50), [simpleDev()], state, 'start', 'stop', 'tok', { min_battery_soc: 80 });
  assert.deepStrictEqual(d._setOnCalls, [{ id: 'd1', on: true }]);
});
test('_evaluateSimpleDevices — overflow hysteresis: a device NOT yet running needs the higher START threshold', async () => {
  const d = makeSimpleDevice();
  const now = Date.now();
  const state = new Map([['d1', { isOn: false, startedAt: null, surplusOkSince: now - 61_000, surplusBadSince: null, powerDropStoppedAt: null }]]);
  // Export clears the CONTINUE threshold but not OVERFLOW_START_W, which is MIN_CHARGE_W
  // (the smallest thing worth starting) plus the remainder that has to survive the start.
  await d._evaluateSimpleDevices({ soc: 10, powerW: 500 }, -(MIN_CHARGE_W + 200), [simpleDev()], state, 'start', 'stop', 'tok', { min_battery_soc: 80 });
  assert.deepStrictEqual(d._setOnCalls, [{ id: 'd1', on: false }]);
});

test('_evaluateSimpleDevices — a start under the overflow exception must leave the continue threshold behind', async () => {
  // The measured flaw, in the simple-device half: the loop books minSurplusW against the
  // export the moment a device starts, so a device whose demand eats all but a sliver
  // revokes its own permission and gets hard-stopped on the very next tick.
  //
  // 2760 W export, a device wanting 2300 W: the old rule let it start and left 460 W —
  // under the 690 W needed to keep going.
  const d = makeSimpleDevice();
  const now = Date.now();
  const state = new Map([['d1', { isOn: false, startedAt: null, surplusOkSince: now - 61_000, surplusBadSince: null, powerDropStoppedAt: null }]]);
  await d._evaluateSimpleDevices({ soc: 10, powerW: 500 }, -2760, [simpleDev({ minSurplusW: 2300 })],
    state, 'start', 'stop', 'tok', { min_battery_soc: 80 });
  assert.deepStrictEqual(d._setOnCalls, [{ id: 'd1', on: false }]);
});

test('_evaluateSimpleDevices — with the remainder covered, the same device does start', async () => {
  // 3100 W − 2300 W = 800 W left, clear of the 690 W continue threshold.
  const d = makeSimpleDevice();
  const now = Date.now();
  const state = new Map([['d1', { isOn: false, startedAt: null, surplusOkSince: now - 61_000, surplusBadSince: null, powerDropStoppedAt: null }]]);
  await d._evaluateSimpleDevices({ soc: 10, powerW: 500 }, -3100, [simpleDev({ minSurplusW: 2300 })],
    state, 'start', 'stop', 'tok', { min_battery_soc: 80 });
  assert.deepStrictEqual(d._setOnCalls, [{ id: 'd1', on: true }]);
});

test('_evaluateSimpleDevices — the reserve applies only inside the overflow exception', async () => {
  // Above the hard stop this is ordinary solar operation and minSurplusW alone decides;
  // adding the reserve there would quietly raise every device's start threshold.
  const d = makeSimpleDevice();
  const now = Date.now();
  const state = new Map([['d1', { isOn: false, startedAt: null, surplusOkSince: now - 61_000, surplusBadSince: null, powerDropStoppedAt: null }]]);
  await d._evaluateSimpleDevices({ soc: 90, powerW: 0 }, -2400, [simpleDev({ minSurplusW: 2300 })],
    state, 'start', 'stop', 'tok', { min_battery_soc: 80 });
  assert.deepStrictEqual(d._setOnCalls, [{ id: 'd1', on: true }]);
});

test('_evaluateSimpleDevices — start needs sustained surplus', async () => {
  const now = Date.now();
  const cfg = { min_battery_soc: 80 };
  const bat = { soc: 90, powerW: 0 }; // not hard-stop
  // surplus present but only just now → no start yet
  const d1 = makeSimpleDevice();
  await d1._evaluateSimpleDevices(bat, -2000, [simpleDev()],
    new Map([['d1', { isOn: false, startedAt: null, surplusOkSince: null, surplusBadSince: null, powerDropStoppedAt: null }]]),
    'start', 'stop', 'tok', cfg);
  assert.deepStrictEqual(d1._setOnCalls, [{ id: 'd1', on: false }]);
  // surplus held past startSustainMs → start
  const d2 = makeSimpleDevice();
  await d2._evaluateSimpleDevices(bat, -2000, [simpleDev()],
    new Map([['d1', { isOn: false, startedAt: null, surplusOkSince: now - 61_000, surplusBadSince: null, powerDropStoppedAt: null }]]),
    'start', 'stop', 'tok', cfg);
  assert.deepStrictEqual(d2._setOnCalls, [{ id: 'd1', on: true }]);
});

test('_evaluateSimpleDevices — min-run holds a fresh device on through a dip', async () => {
  const now = Date.now();
  const d = makeSimpleDevice();
  // started 1 min ago (< min-run 5 min), surplus now gone → hold-time keeps it on
  await d._evaluateSimpleDevices({ soc: 90, powerW: 0 }, 0, [simpleDev()],
    new Map([['d1', { isOn: true, startedAt: now - 60_000, surplusOkSince: null, surplusBadSince: null, powerDropStoppedAt: null }]]),
    'start', 'stop', 'tok', { min_battery_soc: 80 });
  assert.deepStrictEqual(d._setOnCalls, [{ id: 'd1', on: true }]);
});

test('_evaluateSimpleDevices — stop-grace holds, then releases when expired', async () => {
  const now = Date.now();
  const cfg = { min_battery_soc: 80 };
  const bat = { soc: 90, powerW: 0 };
  // past min-run, surplus gone 30 s ago → within 120 s grace → stays on
  const d1 = makeSimpleDevice();
  await d1._evaluateSimpleDevices(bat, 0, [simpleDev({ stopGraceMs: 120_000 })],
    new Map([['d1', { isOn: true, startedAt: now - 600_000, surplusOkSince: null, surplusBadSince: now - 30_000, powerDropStoppedAt: null }]]),
    'start', 'stop', 'tok', cfg);
  assert.deepStrictEqual(d1._setOnCalls, [{ id: 'd1', on: true }]);
  // grace expired (130 s > 120 s) → off
  const d2 = makeSimpleDevice();
  await d2._evaluateSimpleDevices(bat, 0, [simpleDev({ stopGraceMs: 120_000 })],
    new Map([['d1', { isOn: true, startedAt: now - 600_000, surplusOkSince: null, surplusBadSince: now - 130_000, powerDropStoppedAt: null }]]),
    'start', 'stop', 'tok', cfg);
  assert.deepStrictEqual(d2._setOnCalls, [{ id: 'd1', on: false }]);
});

// ── exportLimit: _evaluateExportLimit hysteresis + hold timer ─────────────────
test('_evaluateExportLimit — activates when battery full and exporting', async () => {
  const d = makeExportDevice();
  await d._evaluateExportLimit(EXPORT_CFG, { soc: 96 }, -500);
  assert.strictEqual(d._exportLimitActive, true);
  assert.deepStrictEqual(d._fired, ['ems_inverter_export_limit_on']);
});
test('_evaluateExportLimit — no activation when not exporting', async () => {
  const d = makeExportDevice();
  await d._evaluateExportLimit(EXPORT_CFG, { soc: 96 }, -50); // above the -100 W export floor
  assert.strictEqual(d._exportLimitActive, false);
  assert.deepStrictEqual(d._fired, []);
});
test('_evaluateExportLimit — no activation when battery not full', async () => {
  const d = makeExportDevice();
  await d._evaluateExportLimit(EXPORT_CFG, { soc: 90 }, -500); // below trigger SoC 95
  assert.strictEqual(d._exportLimitActive, false);
});
test('_evaluateExportLimit — hold timer blocks immediate deactivate', async () => {
  const d = makeExportDevice({ _exportLimitActive: true, _exportLimitActivatedAt: Date.now() });
  await d._evaluateExportLimit(EXPORT_CFG, { soc: 80 }, -500); // SoC below deactivate, but just activated
  assert.strictEqual(d._exportLimitActive, true); // held
  assert.deepStrictEqual(d._fired, []);
});
test('_evaluateExportLimit — deactivates after hold when SoC drops', async () => {
  const d = makeExportDevice({ _exportLimitActive: true, _exportLimitActivatedAt: Date.now() - EXPORT_LIMIT_HOLD_MS - 1 });
  await d._evaluateExportLimit(EXPORT_CFG, { soc: 80 }, -500);
  assert.strictEqual(d._exportLimitActive, false);
  assert.deepStrictEqual(d._fired, ['ems_inverter_export_limit_off']);
});
test('_evaluateExportLimit — disabling while active fires OFF', async () => {
  const d = makeExportDevice({ _exportLimitActive: true, _exportLimitActivatedAt: Date.now() });
  await d._evaluateExportLimit({ ...EXPORT_CFG, export_limit_enabled: false }, { soc: 96 }, -500);
  assert.strictEqual(d._exportLimitActive, false);
  assert.deepStrictEqual(d._fired, ['ems_inverter_export_limit_off']);
});

// ── exportLimit: zero export (permanent) ─────────────────────────────────────
const ZERO_CFG = { ...EXPORT_CFG, export_limit_zero_export: true };
test('_evaluateExportLimit — zero export activates even without meter readings', async () => {
  const d = makeExportDevice();
  await d._evaluateExportLimit(ZERO_CFG, { soc: null }, null);
  assert.strictEqual(d._exportLimitActive, true);
  assert.deepStrictEqual(d._fired, ['ems_inverter_export_limit_on']);
});
test('_evaluateExportLimit — zero export never deactivates on its own', async () => {
  const d = makeExportDevice({ _exportLimitActive: true, _exportLimitActivatedAt: Date.now() - EXPORT_LIMIT_HOLD_MS - 1000 });
  await d._evaluateExportLimit(ZERO_CFG, { soc: 10 }, 2000); // empty battery, importing
  assert.strictEqual(d._exportLimitActive, true);
  assert.deepStrictEqual(d._fired, []);
});
test('_evaluateExportLimit — zero export fires ON only once', async () => {
  const d = makeExportDevice();
  await d._evaluateExportLimit(ZERO_CFG, { soc: 50 }, -500);
  await d._evaluateExportLimit(ZERO_CFG, { soc: 50 }, -500);
  assert.deepStrictEqual(d._fired, ['ems_inverter_export_limit_on']);
});
test('_evaluateExportLimit — turning zero export off releases the limit', async () => {
  const d = makeExportDevice({ _exportLimitActive: true, _exportLimitActivatedAt: Date.now() - EXPORT_LIMIT_HOLD_MS - 1000 });
  await d._evaluateExportLimit(EXPORT_CFG, { soc: 50 }, -500); // back to SoC rules, 50% < 90%
  assert.strictEqual(d._exportLimitActive, false);
  assert.deepStrictEqual(d._fired, ['ems_inverter_export_limit_off']);
});

// ── exportLimit: negative electricity price ──────────────────────────────────
function makePriceExportDevice(price, extra = {}) {
  return makeExportDevice({ _getCurrentPrice: () => price, ...extra });
}
const PRICE_CFG = { ...EXPORT_CFG, export_limit_on_negative_price: true };
test('_evaluateExportLimit — negative price activates below the trigger SoC', async () => {
  const d = makePriceExportDevice(-0.02);
  await d._evaluateExportLimit(PRICE_CFG, { soc: 40 }, -500);
  assert.strictEqual(d._exportLimitActive, true);
  assert.deepStrictEqual(d._fired, ['ems_inverter_export_limit_on']);
});
test('_evaluateExportLimit — a positive price does not activate on its own', async () => {
  const d = makePriceExportDevice(0.18);
  await d._evaluateExportLimit(PRICE_CFG, { soc: 40 }, -500);
  assert.strictEqual(d._exportLimitActive, false);
});
test('_evaluateExportLimit — negative price is ignored while the option is off', async () => {
  const d = makePriceExportDevice(-0.02);
  await d._evaluateExportLimit(EXPORT_CFG, { soc: 40 }, -500);
  assert.strictEqual(d._exportLimitActive, false);
});
test('_evaluateExportLimit — an unknown price does not activate', async () => {
  const d = makePriceExportDevice(null);
  await d._evaluateExportLimit(PRICE_CFG, { soc: 40 }, -500);
  assert.strictEqual(d._exportLimitActive, false);
});
test('_evaluateExportLimit — a custom price threshold applies', async () => {
  const d = makePriceExportDevice(0.01);
  await d._evaluateExportLimit({ ...PRICE_CFG, export_limit_price_threshold: 0.05 }, { soc: 40 }, -500);
  assert.strictEqual(d._exportLimitActive, true);
});
test('_evaluateExportLimit — a low price holds the limit while the SoC drops', async () => {
  const d = makePriceExportDevice(-0.02, { _exportLimitActive: true, _exportLimitActivatedAt: Date.now() - EXPORT_LIMIT_HOLD_MS - 1000 });
  await d._evaluateExportLimit(PRICE_CFG, { soc: 40 }, -500);
  assert.strictEqual(d._exportLimitActive, true);
  assert.deepStrictEqual(d._fired, []);
});
test('_evaluateExportLimit — negative price works without a battery', async () => {
  const d = makePriceExportDevice(-0.02);
  await d._evaluateExportLimit(PRICE_CFG, { soc: null }, -500);
  assert.strictEqual(d._exportLimitActive, true);
  assert.deepStrictEqual(d._fired, ['ems_inverter_export_limit_on']);
});
test('_evaluateExportLimit — without a battery the limit is released when the price recovers', async () => {
  const d = makePriceExportDevice(0.18, { _exportLimitActive: true, _exportLimitActivatedAt: Date.now() - EXPORT_LIMIT_HOLD_MS - 1000 });
  await d._evaluateExportLimit(PRICE_CFG, { soc: null }, -500);
  assert.strictEqual(d._exportLimitActive, false);
  assert.deepStrictEqual(d._fired, ['ems_inverter_export_limit_off']);
});
test('_evaluateExportLimit — without a battery nothing happens on the SoC rule alone', async () => {
  const d = makeExportDevice();
  await d._evaluateExportLimit(EXPORT_CFG, { soc: null }, -500);
  assert.strictEqual(d._exportLimitActive, false);
  assert.deepStrictEqual(d._fired, []);
});
test('_evaluateExportLimit — the battery-full rule can be switched off on its own', async () => {
  const d = makeExportDevice();
  await d._evaluateExportLimit({ ...EXPORT_CFG, export_limit_on_battery_full: false }, { soc: 99 }, -500);
  assert.strictEqual(d._exportLimitActive, false);
});
test('_evaluateExportLimit — an existing config without the battery-full flag keeps working', async () => {
  const d = makeExportDevice();
  await d._evaluateExportLimit(EXPORT_CFG, { soc: 96 }, -500); // flag undefined → opt-out, so active
  assert.strictEqual(d._exportLimitActive, true);
});
test('_evaluateExportLimit — the limit is released once the price recovers', async () => {
  const d = makePriceExportDevice(0.18, { _exportLimitActive: true, _exportLimitActivatedAt: Date.now() - EXPORT_LIMIT_HOLD_MS - 1000 });
  await d._evaluateExportLimit(PRICE_CFG, { soc: 40 }, -500);
  assert.strictEqual(d._exportLimitActive, false);
  assert.deepStrictEqual(d._fired, ['ems_inverter_export_limit_off']);
});

// ── pvForecast: _forecastGateBlocksStarts (solar-forecast start gate) ─────────
test('_forecastGateBlocksStarts — off / manual / adaptive / guards', () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  function dev() {
    return makeDevice({
      homey: { clock: { getTimezone: () => 'UTC' } },
      _pvForecastFetchedAt: now,
      _pvForecast: [
        { end: now + 30 * 60000, kw: 4, h: 0.5 },
        { end: now + 60 * 60000, kw: 4, h: 0.5 },
      ], // remaining today = 4 kWh
    });
  }
  const withBat = { battery_devices: [{ id: 'b1' }] };
  // off → never
  assert.strictEqual(dev()._forecastGateBlocksStarts({ ...withBat, forecast_gate_mode: 'off' }, { soc: 60 }, now), false);
  // no battery configured → never
  assert.strictEqual(dev()._forecastGateBlocksStarts({ forecast_gate_mode: 'manual', forecast_gate_kwh: 5 }, { soc: 60 }, now), false);
  // manual: 4 < 5 → block; 4 < 3 → no
  assert.strictEqual(dev()._forecastGateBlocksStarts({ ...withBat, forecast_gate_mode: 'manual', forecast_gate_kwh: 5 }, { soc: 60 }, now), true);
  assert.strictEqual(dev()._forecastGateBlocksStarts({ ...withBat, forecast_gate_mode: 'manual', forecast_gate_kwh: 3 }, { soc: 60 }, now), false);
  // adaptive: cap 10 (on the single configured battery), soc 50 → deficit 5, 4 < 5 → block; soc 70 → deficit 3, 4 < 3 → no
  const oneBat10 = { battery_devices: [{ id: 'b1', capacity_kwh: 10 }] };
  assert.strictEqual(dev()._forecastGateBlocksStarts({ ...oneBat10, forecast_gate_mode: 'adaptive' }, { soc: 50 }, now), true);
  assert.strictEqual(dev()._forecastGateBlocksStarts({ ...oneBat10, forecast_gate_mode: 'adaptive' }, { soc: 70 }, now), false);
  // adaptive without capacity → never
  assert.strictEqual(dev()._forecastGateBlocksStarts({ ...withBat, forecast_gate_mode: 'adaptive' }, { soc: 50 }, now), false);
  // adaptive: multiple batteries → capacities are summed (4+6=10, same as the single-10 case)
  const twoBat = { battery_devices: [{ id: 'b1', capacity_kwh: 4 }, { id: 'b2', capacity_kwh: 6 }] };
  assert.strictEqual(dev()._forecastGateBlocksStarts({ ...twoBat, forecast_gate_mode: 'adaptive' }, { soc: 50 }, now), true);
  // stale forecast → never (falls back to normal)
  const stale = makeDevice({ homey: { clock: { getTimezone: () => 'UTC' } }, _pvForecastFetchedAt: now - 25 * 3600 * 1000, _pvForecast: [{ end: now + 30 * 60000, kw: 4, h: 0.5 }] });
  assert.strictEqual(stale._forecastGateBlocksStarts({ ...withBat, forecast_gate_mode: 'manual', forecast_gate_kwh: 5 }, { soc: 60 }, now), false);
});

// ── pvForecast: announcing the gate in the EMS history ───────────────────────
// "Starts are being held back" is only half an answer; the half that lets someone check
// the setting is "4 kWh left today against the 5 kWh needed to fill the battery".
function gateDevice(history = []) {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const d = makeDevice({
    homey: { clock: { getTimezone: () => 'UTC' } },
    _pvForecastFetchedAt: now,
    _pvForecast: [{ end: now + 30 * 60000, kw: 4, h: 0.5 }, { end: now + 60 * 60000, kw: 4, h: 0.5 }],
    _emsHistory: history,
    events: [],
    logs: [],
  });
  d.log = (m) => d.logs.push(m);
  d._addHistoryEvent = (type, event, label) => { d.events.push({ type, event, label }); d._emsHistory.push({ type, event, label }); };
  return d;
}
const GATE_ON_CFG  = { battery_devices: [{ id: 'b1', capacity_kwh: 10 }], forecast_gate_mode: 'adaptive' };

// Each way the gate can be inactive, and the label the settings box shows for it. "No
// Solcast forecast yet" and "the forecast is ample" both mean "not holding" and want
// opposite reactions from the reader, so the box must be able to tell them apart.
const GATE_REASONS = {
  mode_off:       'whyModeOff',
  no_battery:     'whyNoBattery',
  forecast_stale: 'whyStale',
  no_capacity:    'whyNoCapacity',
  no_soc:         'whyNoSoc',
  no_threshold:   'whyNoThreshold',
};

test('_forecastGateState — every way of being inactive is told apart', () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const bat = { battery_devices: [{ id: 'b1', capacity_kwh: 10 }] };
  const noCap = { battery_devices: [{ id: 'b1' }] };
  const r = (cfg, battery, dev) => (dev || gateDevice())._forecastGateState(cfg, battery, now).reason;

  assert.strictEqual(r({ ...bat, forecast_gate_mode: 'off' }, { soc: 50 }), 'mode_off');
  assert.strictEqual(r({ forecast_gate_mode: 'adaptive' }, { soc: 50 }), 'no_battery');
  assert.strictEqual(r({ ...noCap, forecast_gate_mode: 'adaptive' }, { soc: 50 }), 'no_capacity');
  assert.strictEqual(r({ ...bat, forecast_gate_mode: 'adaptive' }, { soc: null }), 'no_soc');
  assert.strictEqual(r({ ...bat, forecast_gate_mode: 'manual', forecast_gate_kwh: 0 }, { soc: 50 }), 'no_threshold');
  assert.strictEqual(r({ ...bat, forecast_gate_mode: 'adaptive' }, { soc: 50 }), 'below', '4 kWh < 5 kWh');
  assert.strictEqual(r({ ...bat, forecast_gate_mode: 'adaptive' }, { soc: 70 }), 'above', '4 kWh ≥ 3 kWh');

  const staleDev = makeDevice({
    homey: { clock: { getTimezone: () => 'UTC' } },
    _pvForecastFetchedAt: now - 25 * 3600 * 1000,
    _pvForecast: [{ end: now + 30 * 60000, kw: 4, h: 0.5 }],
  });
  assert.strictEqual(r({ ...bat, forecast_gate_mode: 'adaptive' }, { soc: 50 }, staleDev), 'forecast_stale');
});

test('every inactive reason has a label in all three locales', () => {
  // The box switches on these strings. A reason the code can produce but the page cannot
  // name would render as a bare identifier like "no_capacity" in front of the user.
  const fs = require('fs');
  for (const lang of ['en', 'de', 'nl']) {
    const gate = JSON.parse(fs.readFileSync(`locales/${lang}.json`, 'utf8'))
      .settings.homeBatteries.forecastGate;
    for (const [reason, key] of Object.entries(GATE_REASONS)) {
      assert.ok(gate[key] && gate[key].trim(), `${lang}: no label for reason "${reason}" (key ${key})`);
    }
    for (const k of ['stateActive', 'stateInactive', 'compareBlocked', 'compareOpen', 'compareHysteresis', 'calcAdaptive']) {
      assert.ok(gate[k] && gate[k].trim(), `${lang}: missing ${k}`);
    }
    assert.match(gate.calcAdaptive, /\{soc\}.*\{cap\}.*\{need\}/, `${lang}: calcAdaptive lost a placeholder`);
    for (const k of ['compareBlocked', 'compareOpen']) {
      assert.match(gate[k], /\{have\}[\s\S]*\{need\}/, `${lang}: ${k} lost a placeholder`);
    }
    assert.match(gate.compareHysteresis, /\{have\}[\s\S]*\{reopen\}/, `${lang}: compareHysteresis lost a placeholder`);
  }
});

test('_forecastGateDiag — carries what the settings box cannot work out for itself', () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const cfg = { battery_devices: [{ id: 'b1', capacity_kwh: 10 }], forecast_gate_mode: 'adaptive' };
  const d = gateDevice()._forecastGateDiag(cfg, 50, now);
  assert.strictEqual(d.blocked, true);
  assert.strictEqual(d.configuredMode, 'adaptive', 'the mode survives even when the state reads "off"');
  assert.strictEqual(d.socPct, 50);
  assert.strictEqual(d.capacityKwh, 10);
  assert.strictEqual(d.thresholdKwh, 5);
});

test('_forecastGateDiag — an inactive gate still reports the configured mode', () => {
  // state.mode collapses to 'off' for every inactive case, which would leave the box unable
  // to decide whether to show the adaptive derivation at all.
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const cfg = { battery_devices: [{ id: 'b1' }], forecast_gate_mode: 'adaptive' };
  const d = gateDevice()._forecastGateDiag(cfg, 50, now);
  assert.strictEqual(d.reason, 'no_capacity');
  assert.strictEqual(d.configuredMode, 'adaptive');
  assert.strictEqual(d.capacityKwh, 0);
});

test('_forecastGateState — reports the figures behind the verdict', () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const s = gateDevice()._forecastGateState(GATE_ON_CFG, { soc: 50 }, now);
  assert.strictEqual(s.blocked, true);
  assert.strictEqual(s.remainingKwh, 4);
  assert.strictEqual(s.thresholdKwh, 5, '50 % of a 10 kWh battery still to fill');
});

test('_announceForecastGate — one history entry per transition, not per tick', () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const d = gateDevice();
  assert.strictEqual(d._announceForecastGate(GATE_ON_CFG, { soc: 50 }, now), true);
  for (let i = 0; i < 5; i++) d._announceForecastGate(GATE_ON_CFG, { soc: 50 }, now);
  assert.strictEqual(d.events.length, 1);
  assert.strictEqual(d.events[0].event, 'forecast_gate_on');
  assert.strictEqual(d.events[0].label, '4 / 5 kWh');

  // Battery fuller → deficit 3 kWh, forecast 4 kWh covers it → gate opens.
  assert.strictEqual(d._announceForecastGate(GATE_ON_CFG, { soc: 70 }, now), true);
  assert.strictEqual(d.events.length, 2);
  assert.strictEqual(d.events[1].event, 'forecast_gate_off');
});

test('_announceForecastGate — a restart does not re-announce a gate already in the history', () => {
  // The state is derived from forecast + SOC + config, so it survives nothing; the last
  // announcement does, in the history itself. Reading it back beats keeping a second flag
  // that could disagree with what the user is looking at.
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const restored = [
    { type: 'system', event: 'forecast_gate_on', label: '4 / 5 kWh' },
    { type: 'mode', event: 'idle', label: '—' },
  ];
  const d = gateDevice(restored);
  assert.strictEqual(d._announceForecastGate(GATE_ON_CFG, { soc: 50 }, now), false);
  assert.strictEqual(d.events.length, 0);
});

test('_announceForecastGate — the LAST gate entry wins, not the first', () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const d = gateDevice([
    { type: 'system', event: 'forecast_gate_on', label: '1 / 9 kWh' },
    { type: 'system', event: 'forecast_gate_off', label: '9 / 1 kWh' },
  ]);
  assert.strictEqual(d._announceForecastGate(GATE_ON_CFG, { soc: 50 }, now), true, 'gate is on again');
  assert.strictEqual(d.events[0].event, 'forecast_gate_on');
});

// ── the gate's hysteresis ─────────────────────────────────────────────────────
// Field, 2026-08-18: active at 5.1/5.7 (16:30), open at 5.1/5.1 (16:52), active again at
// 5.1/5.3 (16:58). The opening undid itself — it started devices whose draw slowed the
// battery's charging and grew the deficit. Closing therefore uses the bare comparison,
// reopening demands FORECAST_GATE_HYSTERESIS_KWH on top.
// gateDevice's fixture forecast leaves 4 kWh today; capacity is 10 kWh, so the deficit at
// soc 65 is 3.5 kWh — the bare comparison says open, the reopen bar (4.5) says not yet.
test('_forecastGateState — a closed gate does not reopen at the bare crossing', () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const d = gateDevice();
  d._forecastGateOn = true; // closed earlier in the day
  const s = d._forecastGateState(GATE_ON_CFG, { soc: 65 }, now);
  assert.strictEqual(s.blocked, true, '4 kWh ≥ 3.5 kWh, but the margin holds');
  assert.strictEqual(s.reason, 'hysteresis');
  assert.strictEqual(s.reopenAtKwh, 4.5);
});

test('_forecastGateState — the margin cleared, the gate opens', () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const d = gateDevice();
  d._forecastGateOn = true;
  const s = d._forecastGateState(GATE_ON_CFG, { soc: 75 }, now);
  assert.strictEqual(s.blocked, false, '4 kWh ≥ 2.5 + 1 kWh');
  assert.strictEqual(s.reason, 'above');
});

test('_forecastGateState — an OPEN gate closes at the bare threshold, not the padded one', () => {
  // The asymmetry is the point: closing protects the battery and must not wait for the
  // margin. soc 62 → deficit 3.8; remaining 4 is above it, so an open gate stays open —
  // padding the closing side too would close it here.
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const d = gateDevice();
  d._forecastGateOn = false;
  assert.strictEqual(d._forecastGateState(GATE_ON_CFG, { soc: 62 }, now).blocked, false);
  d._forecastGateOn = true;
  assert.strictEqual(d._forecastGateState(GATE_ON_CFG, { soc: 62 }, now).blocked, true,
    'same figures, previously closed → the margin holds it closed');
});

test('_announceForecastGate — the field flap produces one closed and one open, not three', () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const d = gateDevice();
  assert.strictEqual(d._announceForecastGate(GATE_ON_CFG, { soc: 50 }, now), true);  // 4 < 5 → closed
  assert.strictEqual(d._announceForecastGate(GATE_ON_CFG, { soc: 65 }, now), false,
    'the crossing that flapped in the field: bare comparison says open, margin says hold');
  assert.strictEqual(d._announceForecastGate(GATE_ON_CFG, { soc: 75 }, now), true);  // margin cleared
  assert.deepStrictEqual(d.events.map((e) => e.event), ['forecast_gate_on', 'forecast_gate_off']);
});

test('_forecastGateState — a restart restores the closed state from the history', () => {
  // The hysteresis memory survives the same way the announcements do: read back from the
  // persisted history, so a deploy in the flap band does not reopen the gate.
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const d = gateDevice([{ type: 'system', event: 'forecast_gate_on', label: '5.1 / 5.7 kWh' }]);
  assert.strictEqual(d._forecastGateState(GATE_ON_CFG, { soc: 65 }, now).blocked, true);
});

// ── external-ON adoption waits for the device's own reaction lag ──────────────
// Field, 2026-08-18, four times in one day at exactly +1 minute:
//   14:45  Klima — EMS gestoppt
//   14:46  Klima — ausserhalb des EMS eingeschaltet — belassen
// The grace after an EMS stop was a hard-coded 60 s. A device whose app reports onoff more
// slowly than that (Gree, cloud round trip) was classified "switched on externally" after
// every single stop, and the EMS then left it running unmanaged into the evening.
test('_evaluateSimpleDevices — a slow device is not adopted as external-ON inside its own grace', async () => {
  const d = makeSimpleDevice();
  const now = Date.now();
  const state = new Map([['d1', {
    isOn: false, startedAt: null, surplusOkSince: null, surplusBadSince: null,
    powerDropStoppedAt: null, lastEmsStopAt: now - 90_000, externalOn: false,
  }]]);
  const dev = simpleDev({ actualOn: true, stateSource: 'onoff', startupGraceMs: 300_000 });
  await d._evaluateSimpleDevices({ soc: 90, powerW: 0 }, 0, [dev], state, 's', 'x', 'tok', { min_battery_soc: 20 });
  assert.strictEqual(state.get('d1').externalOn, false, '90 s after the stop, inside the 300 s grace');
});

test('_evaluateSimpleDevices — past its grace, still on IS an external switch-on', async () => {
  const d = makeSimpleDevice();
  const now = Date.now();
  const state = new Map([['d1', {
    isOn: false, startedAt: null, surplusOkSince: null, surplusBadSince: null,
    powerDropStoppedAt: null, lastEmsStopAt: now - 301_000, externalOn: false,
  }]]);
  const dev = simpleDev({ actualOn: true, stateSource: 'onoff', startupGraceMs: 300_000 });
  await d._evaluateSimpleDevices({ soc: 90, powerW: 0 }, 0, [dev], state, 's', 'x', 'tok', { min_battery_soc: 20 });
  assert.strictEqual(state.get('d1').externalOn, true);
});

test('_evaluateSimpleDevices — the old 60 s stays as the floor', async () => {
  // startup_grace_s can be set to 0; the classification lag must not drop below what it
  // always was, or a normal switch's half-second of reporting delay becomes "external".
  const d = makeSimpleDevice();
  const now = Date.now();
  const state = new Map([['d1', {
    isOn: false, startedAt: null, surplusOkSince: null, surplusBadSince: null,
    powerDropStoppedAt: null, lastEmsStopAt: now - 45_000, externalOn: false,
  }]]);
  const dev = simpleDev({ actualOn: true, stateSource: 'onoff', startupGraceMs: 0 });
  await d._evaluateSimpleDevices({ soc: 90, powerW: 0 }, 0, [dev], state, 's', 'x', 'tok', { min_battery_soc: 20 });
  assert.strictEqual(state.get('d1').externalOn, false, '45 s is inside the 60 s floor');
});

test('_evaluateSimpleDevices — forecast gate blocks a start, running device continues', async () => {
  const now = Date.now();
  const cfg = { min_battery_soc: 80, battery_devices: [{ id: 'b1' }], forecast_gate_mode: 'manual', forecast_gate_kwh: 100 };
  const bat = { soc: 90, powerW: 0 };
  const fc  = { _pvForecastFetchedAt: now, _pvForecast: [{ end: now + 30 * 60000, kw: 0, h: 0.5 }] }; // remaining ~0 < 100 → gate active

  // OFF + sustained surplus → would start, but gated → stays off
  const dStart = makeSimpleDevice(fc);
  await dStart._evaluateSimpleDevices(bat, -2000, [simpleDev()],
    new Map([['d1', { isOn: false, startedAt: null, surplusOkSince: now - 61000, surplusBadSince: null, powerDropStoppedAt: null }]]),
    'start', 'stop', 'tok', cfg);
  assert.deepStrictEqual(dStart._setOnCalls, [{ id: 'd1', on: false }]);

  // Already running → gate does NOT stop it
  const dRun = makeSimpleDevice(fc);
  await dRun._evaluateSimpleDevices(bat, -2000, [simpleDev()],
    new Map([['d1', { isOn: true, startedAt: now - 600000, surplusOkSince: null, surplusBadSince: null, powerDropStoppedAt: null }]]),
    'start', 'stop', 'tok', cfg);
  assert.deepStrictEqual(dRun._setOnCalls, [{ id: 'd1', on: true }]);
});

// ── priceForecast: time helpers ────────────────────────────────────────────────
test('_priceFloorToHour — floors to local hour boundary', () => {
  const d = makeDevice();
  const t = Date.UTC(2026, 0, 1, 12, 37, 22); // arbitrary
  const floored = d._priceFloorToHour(t, 'UTC');
  assert.strictEqual(floored, Date.UTC(2026, 0, 1, 12, 0, 0));
});

test('_priceForecastAnchor — this_day / tomorrow / next_hours', () => {
  const d = makeDevice();
  const now = Date.UTC(2026, 0, 1, 14, 37, 0); // 14:37 UTC
  assert.strictEqual(d._priceForecastAnchor(now, 'UTC', 'this_day'), Date.UTC(2026, 0, 1, 0, 0, 0));
  assert.strictEqual(d._priceForecastAnchor(now, 'UTC', 'tomorrow'), Date.UTC(2026, 0, 2, 0, 0, 0));
  assert.strictEqual(d._priceForecastAnchor(now, 'UTC', 'next_hours'), Date.UTC(2026, 0, 1, 14, 0, 0));
});
test('_priceForecastAnchor — stable regardless of the calling millisecond (regression: caused duplicate slots on every re-trigger)', () => {
  const d = makeDevice();
  const base = Date.UTC(2026, 0, 1, 14, 37, 12); // 14:37:12.000 UTC
  const a1 = d._priceForecastAnchor(base, 'UTC', 'this_day');
  const a2 = d._priceForecastAnchor(base + 1, 'UTC', 'this_day');      // +1ms
  const a3 = d._priceForecastAnchor(base + 999, 'UTC', 'this_day');    // +999ms, still same second... next
  const a4 = d._priceForecastAnchor(base + 61237, 'UTC', 'this_day');  // over a minute later, arbitrary ms
  assert.strictEqual(a1, Date.UTC(2026, 0, 1, 0, 0, 0));
  assert.strictEqual(a1, a2);
  assert.strictEqual(a1, a3);
  assert.strictEqual(a1, a4);
});
test('_priceFloorToHour — stable regardless of the calling millisecond', () => {
  const d = makeDevice();
  const base = Date.UTC(2026, 0, 1, 14, 37, 12); // 14:37:12.000 UTC
  const h1 = d._priceFloorToHour(base, 'UTC');
  const h2 = d._priceFloorToHour(base + 555, 'UTC');
  assert.strictEqual(h1, Date.UTC(2026, 0, 1, 14, 0, 0));
  assert.strictEqual(h1, h2);
});

test('_priceMsUntilDeadline — today if still ahead, else rolls to tomorrow', () => {
  const d = makeDevice();
  const now = Date.UTC(2026, 0, 1, 14, 37, 0); // 14:37 UTC
  assert.strictEqual(d._priceMsUntilDeadline(now, 'UTC', '20:00'), (5 * 60 + 23) * 60_000); // 5h23m
  assert.strictEqual(d._priceMsUntilDeadline(now, 'UTC', '07:00'), (16 * 60 + 23) * 60_000); // rolled to tomorrow, 16h23m
  assert.strictEqual(d._priceMsUntilDeadline(now, 'UTC', 'garbage'), null);
});

// ── priceForecast: ingestion ─────────────────────────────────────────────────
test('_ingestPriceForecast — parses, anchors and stores slots', async () => {
  const d = makeDevice({ homey: { clock: { getTimezone: () => 'UTC' } }, setStoreValue: async () => {} });
  const now = Date.UTC(2026, 0, 1, 0, 0, 0); // exactly midnight UTC
  await d._ingestPriceForecast(JSON.stringify([0.10, 0.20, 0.30]), 'this_day', now);
  assert.strictEqual(d._priceForecast.length, 3);
  assert.deepStrictEqual(d._priceForecast[0], { start: now, end: now + 3600_000, price: 0.10 });
  assert.strictEqual(d._priceForecast[2].price, 0.30);
  assert.strictEqual(d._priceForecastUpdatedAt, now);
});

test('_ingestPriceForecast — rejects invalid JSON / non-array', async () => {
  const d = makeDevice({ setStoreValue: async () => {} });
  await assert.rejects(() => d._ingestPriceForecast('not json', 'this_day', Date.now()));
  await assert.rejects(() => d._ingestPriceForecast('{}', 'this_day', Date.now()));
  await assert.rejects(() => d._ingestPriceForecast('[]', 'this_day', Date.now()));
});

test('_ingestPriceForecast — later push overwrites overlapping slots, keeps others', async () => {
  const d = makeDevice({ homey: { clock: { getTimezone: () => 'UTC' } }, setStoreValue: async () => {} });
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  await d._ingestPriceForecast(JSON.stringify([0.10, 0.20]), 'this_day', now); // hours 0,1
  await d._ingestPriceForecast(JSON.stringify([0.99]), 'next_hours', now); // overwrites hour 0
  assert.strictEqual(d._priceForecast.length, 2);
  assert.strictEqual(d._priceForecast[0].price, 0.99); // overwritten
  assert.strictEqual(d._priceForecast[1].price, 0.20); // untouched
});
test('_ingestPriceForecast — self-heals a pre-existing near-duplicate slot (leftover from the sub-ms anchor-drift bug)', async () => {
  const d = makeDevice({ homey: { clock: { getTimezone: () => 'UTC' } }, setStoreValue: async () => {} });
  const hour0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  const hour1 = hour0 + 3600_000;
  // Seed a stale slot 785 ms off from the clean hour1 boundary — exactly the kind of
  // near-duplicate the old (unfixed) anchor calculation would have produced.
  d._priceForecast = [{ start: hour1 + 785, end: hour1 + 785 + 3600_000, price: 0.77 }];
  await d._ingestPriceForecast(JSON.stringify([0.10, 0.20]), 'this_day', hour0);
  assert.strictEqual(d._priceForecast.length, 2); // stale 0.77 entry collapsed into the fresh hour1 slot, not appended
  assert.strictEqual(d._priceForecast[1].price, 0.20);
});

// ── priceForecast: staleness + slot lookup ────────────────────────────────────
test('_priceForecastStale — fresh / old / never-ingested', () => {
  const now = Date.now();
  assert.strictEqual(makeDevice({ _priceForecast: [{}], _priceForecastUpdatedAt: now })._priceForecastStale(now), false);
  assert.strictEqual(makeDevice({ _priceForecast: [{}], _priceForecastUpdatedAt: now - 31 * 3600_000 })._priceForecastStale(now), true);
  assert.strictEqual(makeDevice({ _priceForecast: null, _priceForecastUpdatedAt: now })._priceForecastStale(now), true);
});

// ── priceForecast: _checkPriceForecastStaleness (proactive notification) ─────
test('_checkPriceForecastStaleness — never configured → no notification', () => {
  let calls = 0;
  const d = makeDevice({ _priceForecastUpdatedAt: null, _postNotification: () => { calls++; } });
  d._checkPriceForecastStaleness(Date.now());
  assert.strictEqual(calls, 0);
});
test('_checkPriceForecastStaleness — fresh (under the notify threshold) → no notification', () => {
  const now = Date.now();
  let calls = 0;
  const d = makeDevice({ _priceForecastUpdatedAt: now - 3600_000, _postNotification: () => { calls++; } });
  d._checkPriceForecastStaleness(now);
  assert.strictEqual(calls, 0);
});
test('_checkPriceForecastStaleness — stale past the notify threshold → notifies exactly once', () => {
  const now = Date.now();
  let calls = 0;
  const d = makeDevice({ _priceForecastUpdatedAt: now - 49 * 3600_000, _postNotification: () => { calls++; } });
  d._checkPriceForecastStaleness(now);
  d._checkPriceForecastStaleness(now + 60_000); // still stale, called again — must not re-notify
  assert.strictEqual(calls, 1);
  assert.strictEqual(d._priceForecastStaleNotified, true);
});
test('_checkPriceForecastStaleness — re-arms once fresh again', () => {
  const now = Date.now();
  let calls = 0;
  const d = makeDevice({ _priceForecastUpdatedAt: now - 49 * 3600_000, _postNotification: () => { calls++; } });
  d._checkPriceForecastStaleness(now); // notifies once
  d._priceForecastUpdatedAt = now; // fresh data arrives
  d._checkPriceForecastStaleness(now);
  assert.strictEqual(d._priceForecastStaleNotified, false);
  d._priceForecastUpdatedAt = now - 49 * 3600_000; // goes stale again later
  d._checkPriceForecastStaleness(now);
  assert.strictEqual(calls, 2); // notified again on the second episode
});

test('_priceSlotsBetween — overlap filter, ascending', () => {
  const slots = [
    { start: 1000, end: 2000, price: 1 },
    { start: 2000, end: 3000, price: 2 },
    { start: 3000, end: 4000, price: 3 },
  ];
  const d = makeDevice({ _priceForecast: slots });
  assert.deepStrictEqual(d._priceSlotsBetween(1500, 3500).map((s) => s.price), [1, 2, 3]);
  assert.deepStrictEqual(d._priceSlotsBetween(2000, 3000).map((s) => s.price), [2]);
});

// ── priceForecast: _priceSelectCheapestSlots (the core planning algorithm) ────
test('_priceSelectCheapestSlots — picks cheapest slots first', () => {
  const d = makeDevice();
  const slots = [
    { start: 0, end: 3600_000, price: 0.30 },
    { start: 3600_000, end: 7200_000, price: 0.10 }, // cheapest
    { start: 7200_000, end: 10800_000, price: 0.20 },
  ];
  const sel = d._priceSelectCheapestSlots(slots, 1, 0);
  assert.deepStrictEqual([...sel], [3600_000]);
});

test('_priceSelectCheapestSlots — tie-break prefers the LATER slot', () => {
  const d = makeDevice();
  const slots = [
    { start: 0, end: 3600_000, price: 0.10 },
    { start: 3600_000, end: 7200_000, price: 0.10 }, // same price, later → preferred
  ];
  const sel = d._priceSelectCheapestSlots(slots, 1, 0);
  assert.deepStrictEqual([...sel], [3600_000]);
});

test('_priceSelectCheapestSlots — precondition block always included from the end', () => {
  const d = makeDevice();
  const slots = [
    { start: 0, end: 3600_000, price: 0.05 },        // cheapest, but not needed once precondition covers it
    { start: 3600_000, end: 7200_000, price: 0.50 }, // expensive, but last slot → forced by precondition
  ];
  const sel = d._priceSelectCheapestSlots(slots, 1, 1); // 1h needed, 1h precondition
  assert.deepStrictEqual([...sel], [3600_000]);
});

test('_priceSelectCheapestSlots — needing more than available selects everything', () => {
  const d = makeDevice();
  const slots = [{ start: 0, end: 3600_000, price: 0.10 }, { start: 3600_000, end: 7200_000, price: 0.20 }];
  const sel = d._priceSelectCheapestSlots(slots, 10, 0);
  assert.strictEqual(sel.size, 2);
});

test('_priceSlotSelectedNow — membership check', () => {
  const d = makeDevice();
  const slots = [{ start: 0, end: 3600_000, price: 0.1 }, { start: 3600_000, end: 7200_000, price: 0.2 }];
  const sel = new Set([3600_000]);
  assert.strictEqual(d._priceSlotSelectedNow(sel, slots, 5000), false);
  assert.strictEqual(d._priceSlotSelectedNow(sel, slots, 3600_001), true);
});

// ── priceForecast: _priceShouldChargeNow (the D10 decision) ──────────────────
test('_priceShouldChargeNow — no deadline/capacity configured → never', () => {
  const d = makeDevice();
  assert.strictEqual(d._priceShouldChargeNow(null, 7000, {}, Date.now()).shouldCharge, false);
  assert.strictEqual(d._priceShouldChargeNow({ soc: 40, target: 80 }, 7000, {}, Date.now()).shouldCharge, false);
});

test('_priceShouldChargeNow — target already reached → never', () => {
  const d = makeDevice();
  const car = { soc: 90, target: 80, capacityKwh: 20, readyBy: '07:00' };
  assert.strictEqual(d._priceShouldChargeNow(car, 7000, {}, Date.now()).shouldCharge, false);
});

test('_priceShouldChargeNow — solar forecast alone covers the need → never (yet)', () => {
  const now = Date.UTC(2026, 0, 1, 20, 0, 0); // 20:00 UTC, deadline 07:00 tomorrow → 11h window
  const d = makeDevice({
    homey: { clock: { getTimezone: () => 'UTC' } },
    _pvForecastFetchedAt: now,
    _pvForecast: [{ end: now + 3600_000, kw: 20, h: 1 }], // 20 kWh forecast, way more than needed
  });
  const car = { soc: 40, target: 80, capacityKwh: 20, readyBy: '07:00' }; // needs 8 kWh
  const d1 = d._priceShouldChargeNow(car, 7000, {}, now);
  assert.strictEqual(d1.shouldCharge, false);
  assert.strictEqual(d1.reason, 'solar forecast covers the remaining need');
});

test('_priceShouldChargeNow — no price data → fail-safe continuous charging', () => {
  const now = Date.UTC(2026, 0, 1, 20, 0, 0);
  const d = makeDevice({ homey: { clock: { getTimezone: () => 'UTC' } }, _pvForecast: null });
  const car = { soc: 40, target: 80, capacityKwh: 20, readyBy: '07:00' };
  const decision = d._priceShouldChargeNow(car, 7000, {}, now);
  assert.strictEqual(decision.shouldCharge, true);
  assert.match(decision.reason, /no price forecast/);
});

test('_priceShouldChargeNow — charges only in the selected cheap slot', () => {
  const now = Date.UTC(2026, 0, 1, 20, 0, 0); // 20:00 UTC, deadline 22:00 → 2h window
  const slots = [
    { start: now, end: now + 3600_000, price: 0.30 },              // 20-21h: expensive
    { start: now + 3600_000, end: now + 7200_000, price: 0.10 },   // 21-22h: cheap
  ];
  const car = { soc: 60, target: 80, capacityKwh: 20, readyBy: '22:00' }; // needs 4 kWh
  const base = { homey: { clock: { getTimezone: () => 'UTC' } }, _pvForecast: null, _priceForecast: slots, _priceForecastUpdatedAt: now };
  // 20:00 (expensive slot) → not yet
  const d1 = makeDevice({ ...base });
  const dec1 = d1._priceShouldChargeNow(car, 4000, {}, now); // 4kW charger → needs 1h
  assert.strictEqual(dec1.shouldCharge, false);
  // 21:00 (cheap slot) → charges
  const d2 = makeDevice({ ...base });
  const dec2 = d2._priceShouldChargeNow(car, 4000, {}, now + 3600_000);
  assert.strictEqual(dec2.shouldCharge, true);
  // chargeSlots exposes the full plan (for the settings-page "next charge window"
  // preview) regardless of which tick asked — both decisions should report the same
  // single selected slot (21-22h, the cheap one).
  assert.strictEqual(dec1.chargeSlots.length, 1);
  assert.strictEqual(dec1.chargeSlots[0].start, now + 3600_000);
  assert.strictEqual(dec2.chargeSlots.length, 1);
  assert.strictEqual(dec2.chargeSlots[0].start, now + 3600_000);
});
test('_priceShouldChargeNow — chargeSlots is always an array, even on early-exit paths', () => {
  const d = makeDevice();
  assert.deepStrictEqual(d._priceShouldChargeNow(null, 4000, {}).chargeSlots, []);
  assert.deepStrictEqual(d._priceShouldChargeNow({ soc: 80, target: 80, capacityKwh: 20, readyBy: '22:00' }, 4000, {}).chargeSlots, []);
});

// ── priceForecast: _priceSelectExpensiveSlots (home-battery discharge reserve) ─
test('_priceSelectExpensiveSlots — picks the most expensive slots first', () => {
  const d = makeDevice();
  const slots = [
    { start: 0,       end: 3600_000,   price: 0.10 },
    { start: 3600_000, end: 7200_000,  price: 0.30 },
    { start: 7200_000, end: 10800_000, price: 0.20 },
  ];
  const selected = d._priceSelectExpensiveSlots(slots, 1);
  assert.deepStrictEqual([...selected], [3600_000]);
});
test('_priceSelectExpensiveSlots — tie-break prefers the EARLIER slot', () => {
  const d = makeDevice();
  const slots = [
    { start: 0,       end: 3600_000,  price: 0.20 },
    { start: 3600_000, end: 7200_000, price: 0.20 },
  ];
  const selected = d._priceSelectExpensiveSlots(slots, 1);
  assert.deepStrictEqual([...selected], [0]);
});

// ── priceForecast: _batteryPriceMode (home-battery price control) ────────────
test('_batteryPriceMode — disabled battery → normal', () => {
  const d = makeDevice();
  const r = d._batteryPriceMode({ price_charge_enabled: false }, 50, {});
  assert.strictEqual(r.mode, 'normal');
});
test('_batteryPriceMode — unknown SoC → normal', () => {
  const d = makeDevice({ _priceForecast: [{}], _priceForecastUpdatedAt: Date.now() });
  const r = d._batteryPriceMode({ price_charge_enabled: true }, null, {});
  assert.strictEqual(r.mode, 'normal');
});
test('_batteryPriceMode — stale forecast → normal', () => {
  const d = makeDevice({ _priceForecast: null, _priceForecastUpdatedAt: null });
  const r = d._batteryPriceMode({ price_charge_enabled: true }, 50, {});
  assert.strictEqual(r.mode, 'normal');
});
test('_batteryPriceMode — charges in the cheapest slot within the 24h rolling lookahead (no deadline)', () => {
  const now = Date.UTC(2026, 0, 1, 4, 0, 0); // 04:00 UTC
  const slots = [
    { start: now, end: now + 3600_000, price: 0.30 },              // 04-05h: expensive
    { start: now + 3600_000, end: now + 7200_000, price: 0.05 },   // 05-06h: cheap
  ];
  const base = { homey: { clock: { getTimezone: () => 'UTC' } }, _priceForecast: slots, _priceForecastUpdatedAt: now };
  const bd = { price_charge_enabled: true, price_target_soc: 90, price_charge_power_kw: 5, capacity_kwh: 10 }; // needs 1h at 5kW for 50%
  const d1 = makeDevice({ ...base });
  assert.strictEqual(d1._batteryPriceMode(bd, 40, {}, now).mode !== 'charge', true); // expensive slot, not yet
  const d2 = makeDevice({ ...base });
  assert.strictEqual(d2._batteryPriceMode(bd, 40, {}, now + 3600_000).mode, 'charge'); // cheap slot
});
test('_batteryPriceMode — waits for a genuinely cheaper hour later within the lookahead instead of committing early', () => {
  const now = Date.UTC(2026, 0, 1, 4, 0, 0);
  const slots = [
    { start: now,                end: now + 3600_000,  price: 0.20 }, // 04-05h: moderate
    { start: now + 20 * 3600_000, end: now + 21 * 3600_000, price: 0.02 }, // 00:00 next day: much cheaper, still within 24h
  ];
  const base = { homey: { clock: { getTimezone: () => 'UTC' } }, _priceForecast: slots, _priceForecastUpdatedAt: now };
  const bd = { price_charge_enabled: true, price_target_soc: 90, price_charge_power_kw: 5, capacity_kwh: 10, price_discharge_reserve_hours: 0 }; // needs 1h; reserve isolated off
  const d = makeDevice({ ...base });
  const r = d._batteryPriceMode(bd, 40, {}, now);
  assert.notStrictEqual(r.mode, 'charge'); // not the cheapest — waits
  assert.strictEqual(r.chargeSlots.length, 1);
  assert.strictEqual(r.chargeSlots[0].start, now + 20 * 3600_000); // planned for the later, cheaper slot
});
test('_batteryPriceMode — returns the full reserveSlots list even when currently in a non-reserved hour', () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const slots = [
    { start: now,               end: now + 3600_000,  price: 0.10 },
    { start: now + 3600_000,    end: now + 7200_000,  price: 0.30 }, // the peak, reserved
  ];
  const bd = { price_charge_enabled: true, price_target_soc: 0, price_discharge_reserve_hours: 1 };
  const d = makeDevice({ homey: { clock: { getTimezone: () => 'UTC' } }, _priceForecast: slots, _priceForecastUpdatedAt: now });
  const r = d._batteryPriceMode(bd, 50, {}, now);
  assert.strictEqual(r.mode, 'hold');
  assert.strictEqual(r.reserveSlots.length, 1);
  assert.strictEqual(r.reserveSlots[0].start, now + 3600_000);
});
test('_batteryPriceMode — already at/above target → no charge', () => {
  const now = Date.now();
  const bd = { price_charge_enabled: true, price_target_soc: 90, price_charge_by: '06:00', price_charge_power_kw: 5, capacity_kwh: 10 };
  const d = makeDevice({ homey: { clock: { getTimezone: () => 'UTC' } }, _priceForecast: [{ start: now, end: now + 3600_000, price: 0.01 }], _priceForecastUpdatedAt: now });
  const r = d._batteryPriceMode(bd, 95, {}, now);
  assert.notStrictEqual(r.mode, 'charge');
});
test('_batteryPriceMode — holds discharge outside the reserved top-expensive hours', () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const slots = [
    { start: now,               end: now + 3600_000,  price: 0.10 }, // now: mid price
    { start: now + 3600_000,    end: now + 7200_000,  price: 0.30 }, // later: the peak
  ];
  const bd = { price_charge_enabled: true, price_target_soc: 0, price_discharge_reserve_hours: 1 }; // target 0 → never charges, isolates the reserve check
  const d = makeDevice({ homey: { clock: { getTimezone: () => 'UTC' } }, _priceForecast: slots, _priceForecastUpdatedAt: now });
  const r = d._batteryPriceMode(bd, 50, {}, now);
  assert.strictEqual(r.mode, 'hold');
});
test('_batteryPriceMode — allows discharge during the reserved top-expensive hour', () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const slots = [
    { start: now,               end: now + 3600_000,  price: 0.10 },
    { start: now + 3600_000,    end: now + 7200_000,  price: 0.30 }, // the peak
  ];
  const bd = { price_charge_enabled: true, price_target_soc: 0, price_discharge_reserve_hours: 1 };
  const d = makeDevice({ homey: { clock: { getTimezone: () => 'UTC' } }, _priceForecast: slots, _priceForecastUpdatedAt: now });
  const r = d._batteryPriceMode(bd, 50, {}, now + 3600_000); // now = the peak slot
  assert.strictEqual(r.mode, 'normal');
});
// A grid-charge can be refused after the fact by the main-fuse ceiling (device.js
// _checkBatteryPriceControl). What the battery does instead has to come from here — the
// caller used to infer it from reserveSlots, which this function emptied on the charge
// path, so the answer was always 'normal' and a battery saving capacity for the evening
// peak was released the moment its charge was denied.
test('_batteryPriceMode — a charge carries the mode that applies if it is denied', () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const slots = [
    { start: now,            end: now + 3600_000, price: 0.05 }, // now: cheapest → charge
    { start: now + 3600_000, end: now + 7200_000, price: 0.30 }, // later: the peak → reserved
  ];
  const bd = { price_charge_enabled: true, price_target_soc: 90, price_charge_power_kw: 5,
               capacity_kwh: 10, price_discharge_reserve_hours: 1 };
  const d = makeDevice({ homey: { clock: { getTimezone: () => 'UTC' } }, _priceForecast: slots, _priceForecastUpdatedAt: now });
  const r = d._batteryPriceMode(bd, 40, {}, now);
  assert.strictEqual(r.mode, 'charge');
  assert.strictEqual(r.deniedMode, 'hold', 'a denied charge must still reserve for the peak ahead');
  assert.match(r.deniedReason, /reserving capacity/);
  // The function's own contract: the lists are populated even when mode does not match them.
  assert.strictEqual(r.reserveSlots.length, 1);
  assert.strictEqual(r.reserveSlots[0].start, now + 3600_000);
});
test('_batteryPriceMode — with nothing worth reserving, a denied charge falls back to normal', () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const slots = [{ start: now, end: now + 3600_000, price: 0.05 }];
  const bd = { price_charge_enabled: true, price_target_soc: 90, price_charge_power_kw: 5,
               capacity_kwh: 10, price_discharge_reserve_hours: 0 }; // reserve switched off
  const d = makeDevice({ homey: { clock: { getTimezone: () => 'UTC' } }, _priceForecast: slots, _priceForecastUpdatedAt: now });
  const r = d._batteryPriceMode(bd, 40, {}, now);
  assert.strictEqual(r.mode, 'charge');
  assert.strictEqual(r.deniedMode, 'normal');
});
// device.js cannot be require()d here (it needs `homey`), so the half that consumes
// deniedMode is checked by reading it. Without this, the fix above could be reverted at
// the call site and every test in this file would stay green.
test('_checkBatteryPriceControl takes the denied mode from the decision, not from the slot lists', () => {
  const fs  = require('fs');
  const src = fs.readFileSync('drivers/energy_management/device.js', 'utf8');
  assert.match(src, /decision\.mode\s*=\s*decision\.deniedMode/,
    'the ceiling-denied branch must use the mode _batteryPriceMode derived');
  assert.doesNotMatch(src, /decision\.reserveSlots\?\.length\s*\?\s*'hold'/,
    'the fallback is inferred from reserveSlots again — that always yields normal');
});
test('_batteryPriceMode — reserve disabled (0 hours) and target met → normal (nothing to do)', () => {
  const now = Date.now();
  const bd = { price_charge_enabled: true, price_target_soc: 0, price_discharge_reserve_hours: 0 };
  const d = makeDevice({ homey: { clock: { getTimezone: () => 'UTC' } }, _priceForecast: [{ start: now, end: now + 3600_000, price: 0.10 }], _priceForecastUpdatedAt: now });
  const r = d._batteryPriceMode(bd, 50, {}, now);
  assert.strictEqual(r.mode, 'normal');
});

// ── priceForecast: _batteryPriceMode solar gate (price_solar_forecast_max_kwh) ──
// Shared scenario: 04:00, and the current hour is the cheapest in the window — so
// WITHOUT the gate the battery grid-charges right now. Every test below varies only
// the forecast/limit, which makes "did the gate act?" the single moving part.
const SOLAR_GATE_NOW = Date.UTC(2026, 0, 1, 4, 0, 0);
const SOLAR_GATE_BD  = {
  price_charge_enabled: true, price_target_soc: 90, price_charge_power_kw: 5, capacity_kwh: 10,
  price_discharge_reserve_hours: 0, // isolates the charge decision from the reserve
};
function makeSolarGateDevice(pvKwh, pvFetchedAt = SOLAR_GATE_NOW) {
  const now = SOLAR_GATE_NOW;
  return makeDevice({
    homey: { clock: { getTimezone: () => 'UTC' } },
    _priceForecast: [
      { start: now,            end: now + 3600_000, price: 0.05 }, // cheapest → would charge
      { start: now + 3600_000, end: now + 7200_000, price: 0.30 },
    ],
    _priceForecastUpdatedAt: now,
    _pvForecast: pvKwh === null ? null : [{ end: now + 8 * 3600_000, kw: pvKwh, h: 1 }],
    _pvForecastFetchedAt: pvFetchedAt,
  });
}
test('_batteryPriceMode — solar gate off (0) leaves grid charging exactly as before', () => {
  const r = makeSolarGateDevice(30)._batteryPriceMode({ ...SOLAR_GATE_BD, price_solar_forecast_max_kwh: 0 }, 40, {}, SOLAR_GATE_NOW);
  assert.strictEqual(r.mode, 'charge');
  assert.strictEqual(r.solarKwh, undefined); // gate not configured → no numbers reported
});
test('_batteryPriceMode — forecast at/above the limit blocks grid charging entirely', () => {
  const r = makeSolarGateDevice(30)._batteryPriceMode({ ...SOLAR_GATE_BD, price_solar_forecast_max_kwh: 15 }, 40, {}, SOLAR_GATE_NOW);
  assert.notStrictEqual(r.mode, 'charge');
  assert.deepStrictEqual(r.chargeSlots, []); // and nothing is planned for later either
  assert.strictEqual(r.solarKwh, 30);
  assert.strictEqual(r.solarLimitKwh, 15);
});
test('_batteryPriceMode — forecast below the limit still charges', () => {
  const r = makeSolarGateDevice(8)._batteryPriceMode({ ...SOLAR_GATE_BD, price_solar_forecast_max_kwh: 15 }, 40, {}, SOLAR_GATE_NOW);
  assert.strictEqual(r.mode, 'charge');
  assert.strictEqual(r.solarKwh, 8);
});
test('_batteryPriceMode — stale PV forecast leaves the gate open (a dead Solcast must not stop cheap charging)', () => {
  const d = makeSolarGateDevice(30, SOLAR_GATE_NOW - 25 * 3600_000); // > PV_FORECAST_STALE_MS
  const r = d._batteryPriceMode({ ...SOLAR_GATE_BD, price_solar_forecast_max_kwh: 15 }, 40, {}, SOLAR_GATE_NOW);
  assert.strictEqual(r.mode, 'charge');
  assert.strictEqual(r.solarKwh, null); // "unknown", not "0 kWh of sun"
});
test('_batteryPriceMode — blocked reason names both numbers, so the history entry explains itself', () => {
  const r = makeSolarGateDevice(30)._batteryPriceMode({ ...SOLAR_GATE_BD, price_solar_forecast_max_kwh: 15 }, 40, {}, SOLAR_GATE_NOW);
  assert.match(r.reason, /30\.0 kWh/);
  assert.match(r.reason, /15 kWh/);
});
test('_batteryPriceMode — solar gate blocks charging without disabling the discharge reserve', () => {
  const bd = { ...SOLAR_GATE_BD, price_solar_forecast_max_kwh: 15, price_discharge_reserve_hours: 1 };
  const r  = makeSolarGateDevice(30)._batteryPriceMode(bd, 40, {}, SOLAR_GATE_NOW);
  assert.strictEqual(r.mode, 'hold');              // still reserving the 0.30 hour later
  assert.strictEqual(r.reserveSlots.length, 1);
  assert.match(r.reason, /grid charging paused/);  // and still says why it isn't charging
});

// ── chargerControl: global offpeak_enabled toggle must not hijack explicit price modes ──
test('_evaluateEvChargers — global offpeak_enabled toggle does not override solar_price chargeMode', async () => {
  const now = Date.UTC(2026, 0, 1, 20, 0, 0);
  const slots = [{ start: now, end: now + 3600_000, price: 0.10 }];
  const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 16, phases: 1, phaseSwitch: false, chargeMode: 'solar_price', carId: 'car1', powerW: 0 };
  const car = { id: 'car1', name: 'EV', soc: 40, target: 80, capacityKwh: 20, readyBy: '21:00' };
  const d = makeChargerDevice({
    homey: { flow: { getTriggerCard: () => ({ trigger: () => Promise.resolve() }) }, clock: { getTimezone: () => 'UTC' }, setTimeout: (f, m) => setTimeout(f, m), clearTimeout: (t) => clearTimeout(t) },
    _pvForecast: null,
    _priceForecast: slots,
    _priceForecastUpdatedAt: now,
    _carStates: [car],
    getCapabilityValue: (cap) => (cap === 'offpeak_enabled' ? true : undefined), // global toggle ON
    _offpeakWindow: () => ({ active: true, amps: 10 }), // off-peak window also active
  });
  const battery = { soc: 90, powerW: 0 };
  const cfg = { offpeak_solar_first: true };
  await d._evaluateEvChargers(battery, 0, [charger], cfg, null, null);
  // Must follow the price-mode decision (16A, price_ev), NOT the fixed off-peak amps (10A).
  assert.strictEqual(d._getChargerState('c1').currentAmps, 16);
  assert.strictEqual(d._lastMode.mode, 'price_ev');
});

// ── chargerControl: a start under the overflow exception must not undo itself ─
// Below the ramp's lower point the battery has priority, and only a clear overflow — the
// battery charging while the house still exports — overrides that. The charger then took
// the highest rung that fit the ENTIRE export and stopped itself one tick later. Measured
// at 30 % SoC with 7 kW of PV: 3500 W of export started it at 15 A, drew 3450 W, left
// 50 W, and the next tick hard-stopped it. Every export from 2760 W to about 4750 W
// oscillated on a five-minute cycle (the flip cooldown), which is exactly the band the
// old 2×MIN_CHARGE_W start threshold was meant to protect.
const OVF_CFG = {
  battery_devices: [{ id: 'b1', capacity_kwh: 15 }],
  share_soc_low: 50, share_soc_high: 100, share_pct_low: 20, share_pct_high: 100,
};
const OVF_BAT = { soc: 30, powerW: 5000 }; // hard-stop zone, battery charging

test('_evaluateEvChargers — an overflow start leaves the continue threshold exported', async () => {
  for (const exportW of [2500, 3000, 3500, 4000, 4500, 5000]) {
    const d = makeChargerDevice();
    await d._evaluateEvChargers(OVF_BAT, -exportW, [{ ...CHARGER_1PH, powerW: 0 }],
      OVF_CFG, 12000, 0);
    const planned = d._getChargerState('c1').pendingStepAmps;
    assert.ok(planned, `${exportW} W of export should start the charger`);
    const drawW = planned * 230;
    assert.ok(exportW - drawW >= OVERFLOW_KEEP_W,
      `at ${exportW} W it planned ${planned} A (${drawW} W), leaving ${exportW - drawW} W — `
      + `under the ${OVERFLOW_KEEP_W} W it needs to keep running`);
  }
});

test('_evaluateEvChargers — below the derived start threshold nothing runs', async () => {
  // OVERFLOW_START_W is MIN_CHARGE_W plus the remainder: any less cannot both feed the
  // smallest rung and survive the start.
  const d = makeChargerDevice();
  await d._evaluateEvChargers(OVF_BAT, -(OVERFLOW_START_W - 100), [{ ...CHARGER_1PH, powerW: 0 }],
    OVF_CFG, 12000, 0);
  assert.strictEqual(d._getChargerState('c1').pendingStepAmps, null);
  assert.strictEqual(d._getChargerState('c1').currentAmps, null);
});

test('_evaluateEvChargers — the reserve applies only in the overflow exception', async () => {
  // Above the ramp's lower point this is ordinary solar operation; holding back 690 W
  // there would waste it for no reason.
  const d = makeChargerDevice();
  await d._evaluateEvChargers({ soc: 90, powerW: 0 }, -3000, [{ ...CHARGER_1PH, powerW: 0 }],
    OVF_CFG, 12000, 0);
  const planned = d._getChargerState('c1').pendingStepAmps;
  assert.ok(planned * 230 > 3000 - OVERFLOW_KEEP_W, 'no reserve held back outside the exception');
});

// ── the ramp budget is capped by what the battery actually absorbs ───────────
// Field, 2026-08-18, 17:05–17:16: at 60 % SoC the ramp granted 20 % of ~7 kW while the
// battery was DISCHARGING. That kept one rung of permanent headroom in the charger budget,
// so it climbed 12A/1ph → 10A/3ph in eleven minutes, financed by the battery (↓3521 W).
// The import guard and the discharge correction were both blind, because the inverter
// holds the grid meter at ~0 while the battery covers the deficit.
const CAP_CFG = { battery_devices: [{ id: 'b1', capacity_kwh: 15 }],
  share_soc_low: 50, share_soc_high: 100, share_pct_low: 0, share_pct_high: 100 };

test('_batteryShareBudgetW — a discharging battery lends nothing', () => {
  const d = makeDevice();
  // soc 60 → share 20 % → claim would be 1400 W; the battery is giving, not taking.
  assert.strictEqual(d._batteryShareBudgetW(CAP_CFG, 60, 7000, 0, -3521), 0);
});

test('_batteryShareBudgetW — the cap is the absorption, not the share', () => {
  const d = makeDevice();
  assert.strictEqual(d._batteryShareBudgetW(CAP_CFG, 60, 7000, 0, 800), 800,
    'only 800 W is being absorbed, so only 800 W can be claimed instead');
});

test('_batteryShareBudgetW — full absorption leaves the share untouched', () => {
  const d = makeDevice();
  assert.strictEqual(d._batteryShareBudgetW(CAP_CFG, 60, 7000, 0, 5000), 1400);
});

test('_batteryShareBudgetW — without a battery power sensor the old behaviour stands', () => {
  // Capping on a guess would be worse than not capping; four-argument callers are the
  // sensorless installs.
  const d = makeDevice();
  assert.strictEqual(d._batteryShareBudgetW(CAP_CFG, 60, 7000, 0), 1400);
});

test('_evaluateEvChargers — a running charger cannot climb on the back of a discharging battery', async () => {
  // The 17:05 tick, replayed: charger at 12A/1ph, battery discharging, meter at zero.
  // With the cap the effective budget is exactly the charger's own draw — target equals
  // current, no pending step, no phase switch. Before the cap the granted 1400 W meant
  // permanent headroom: 12A/1ph plus 1400 W crosses MIN_3PH_W and switches to 3 phases.
  const d = makeChargerDevice();
  seedState(d, 'c1', { currentAmps: 12, currentPhases: 1 });
  const battery = { soc: 60, powerW: -3521 };
  const eff = 0 - (d._batteryShareBudgetW(CAP_CFG, 60, 7000, 0, battery.powerW) || 0);
  const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 16, phases: 3,
    phaseSwitch: true, powerW: 12 * 230, rawPowerW: 12 * 230 };
  await d._evaluateEvChargers(battery, eff, [charger], CAP_CFG, 7000, 500);
  const st = d._getChargerState('c1');
  assert.strictEqual(st.currentAmps, 12, 'holds, does not climb');
  assert.strictEqual(st.currentPhases, 1, 'no phase switch');
  assert.strictEqual(st.pendingStepAmps, null, 'no step planned either');
});

// ── chargerControl: the solar-forecast gate reaches the EV charger ───────────
// Owner's request, 2026-08-17: "Die Startsperre soll auch für das EV Laden bei Solar gelten.
// Nicht dass mir die Hausbatterie nicht lädt an nicht so sonnigen Tagen." The car is by far
// the largest load, so a gate that spared the heat pump and let the car take 11 kW was
// protecting the battery in name only.
// _evaluateEvChargers reads the real clock, and "remaining today" is bounded by local
// midnight — a fixture of half-hour slots would quietly shrink when the suite runs late in
// the evening, and these tests would pass or fail by the hour. The remaining-kWh figure is
// stubbed instead; everything the gate itself does — capacity, SOC, the comparison — is the
// real code, and _pvForecastRemainingTodayKwh has its own tests above.
function gateChargerDevice(extra = {}) {
  return makeChargerDevice({
    homey: {
      flow: { getTriggerCard: () => ({ trigger: () => Promise.resolve() }) },
      clock: { getTimezone: () => 'UTC' },
      setTimeout: (f, m) => setTimeout(f, m),
      clearTimeout: (t) => clearTimeout(t),
    },
    // _pvForecastStale wants both a fetch time AND a forecast array; the array's contents
    // are irrelevant here because the kWh figure is stubbed, but it has to exist.
    _pvForecastFetchedAt: Date.now(),
    _pvForecast: [{ end: Date.now() + 3600_000, kw: 4, h: 1 }],
    _pvForecastRemainingTodayKwh: () => 4,
    ...extra,
  });
}
// 4 kWh forecast left vs 5 kWh needed to fill a 10 kWh battery at 50 % → gate closed.
// min_battery_soc has to be stated: its default of 80 would put 50 % and 70 % below the
// hard stop, and the charger would then be held back for a reason that is not the gate.
const GATE_CFG = {
  battery_devices: [{ id: 'b1', capacity_kwh: 10 }],
  forecast_gate_mode: 'adaptive',
  min_battery_soc: 20,
};
const GATE_BAT = { soc: 50, powerW: 0 };

test('_evaluateEvChargers — a closed forecast gate holds a NEW solar charge', async () => {
  const d = gateChargerDevice();
  await d._evaluateEvChargers(GATE_BAT, -8000, [{ ...CHARGER_1PH, powerW: 0 }], GATE_CFG, 8000, 500);
  assert.strictEqual(d._getChargerState('c1').pendingStepAmps, null);
  assert.strictEqual(d._getChargerState('c1').currentAmps, null);
});

test('_evaluateEvChargers — the status text names the gate rather than blaming the sun', async () => {
  const d = gateChargerDevice();
  await d._evaluateEvChargers(GATE_BAT, -8000, [{ ...CHARGER_1PH, powerW: 0 }], GATE_CFG, 8000, 500);
  assert.match(d._lastMode.text, /Prognose-Sperre/,
    '8 kW of export and a stopped charger needs an explanation on the tile');
});

test('_evaluateEvChargers — a charge already running is NOT cut off by the gate', async () => {
  // Stopping mid-session to save the battery leaves the car with neither.
  //
  // Asserting "not null" is not enough: zeroing a running charger's budget does not stop it
  // outright, because the export guard then holds it at the lowest rung. It arrives at 6 A
  // instead of stopping — throttled, not spared. The running current is what has to be left
  // alone, so that is what this pins.
  const d = gateChargerDevice();
  seedState(d, 'c1', { currentAmps: 10, currentPhases: 1 });
  await d._evaluateEvChargers(GATE_BAT, -8000, [{ ...CHARGER_1PH, powerW: 2300 }], GATE_CFG, 8000, 500);
  assert.ok(d._getChargerState('c1').currentAmps >= 10,
    `still charging at full budget, got ${d._getChargerState('c1').currentAmps} A`);
});

test('_evaluateEvChargers — an explicitly requested charge ignores the gate', async () => {
  // "Charge now" is the user asking for it. Holding that back would ignore an instruction,
  // not conserve a battery — the gate sits below every deliberate tier by design.
  const d = gateChargerDevice({ getCapabilityValue: (cap) => (cap === 'charge_now' ? true : undefined) });
  await d._evaluateEvChargers(GATE_BAT, 0, [{ ...CHARGER_1PH, powerW: 0 }], GATE_CFG, 8000, 500);
  assert.strictEqual(d._getChargerState('c1').currentAmps, 32);
});

test('_evaluateEvChargers — an open gate leaves solar charging alone', async () => {
  // Same everything, battery at 70 %: deficit 3 kWh, forecast 4 kWh covers it.
  const d = gateChargerDevice();
  await d._evaluateEvChargers({ soc: 70, powerW: 0 }, -8000, [{ ...CHARGER_1PH, powerW: 0 }], GATE_CFG, 8000, 500);
  assert.notStrictEqual(d._getChargerState('c1').pendingStepAmps, null);
});

// ── chargerControl: the SOC ramp must not be undone downstream ───────────────
// Measured 2026-08-17. Ramp 50→100 % / 20→100 %, battery at 51-52 %, production 4241 W.
// The settings page said "devices get 22% of production · 916 W of 4241 W"; the charger was
// given 12 A on one phase — 2760 W. The difference is the battery's own charging power,
// which the green-zone boost added on top of a budget that already contained its share.
// The charger pulled the battery under the 50 % hard stop, was stopped, the battery
// recovered to 50 %, the charger restarted: four cycles between 15:48 and 16:56.
const RAMP_CFG = { share_soc_low: 50, share_soc_high: 100, share_pct_low: 20, share_pct_high: 100 };
const FIELD_PV_W = 4241;
const FIELD_HOUSE_W = 900;

// What device.js does before calling the charger evaluator: fold the ramp's allowance into
// effectiveGridW. Mirrored here so the test drives the same number the tick loop would.
function rampGridW(dev, cfg, soc, gridW, pvW) {
  const budget = dev._batteryShareBudgetW(cfg, soc, pvW, gridW);
  return budget !== null && budget > 0 ? gridW - budget : gridW;
}

test('_evaluateEvChargers — the battery boost does not hand back what the SOC ramp withheld', async () => {
  const d = makeChargerDevice();
  const battery = { soc: 52, powerW: 2347 };   // charging, as measured
  const gridW = rampGridW(d, RAMP_CFG, 52, -15, FIELD_PV_W);
  await d._evaluateEvChargers(battery, gridW, [{ ...CHARGER_1PH, powerW: 0 }],
    RAMP_CFG, FIELD_PV_W, FIELD_HOUSE_W);
  // ~984 W of allowance, below the 1380 W a charger needs for its lowest rung.
  assert.strictEqual(d._getChargerState('c1').pendingStepAmps, null, 'no start scheduled');
  assert.strictEqual(d._getChargerState('c1').currentAmps, null);
});

test('_evaluateEvChargers — without a ramp configured the boost still applies (the old behaviour)', async () => {
  // min_battery_soc must be set low enough that 52 % is NOT the hard stop — its default is
  // 80, which would keep the charger off for a reason that has nothing to do with the ramp
  // and would make this control prove nothing.
  const d = makeChargerDevice();
  const battery = { soc: 52, powerW: 2347 };
  await d._evaluateEvChargers(battery, -15, [{ ...CHARGER_1PH, powerW: 0 }],
    { min_battery_soc: 40 }, FIELD_PV_W, FIELD_HOUSE_W);
  assert.notStrictEqual(d._getChargerState('c1').pendingStepAmps, null,
    'unramped installs must be untouched by this change');
});

test('_evaluateEvChargers — a fuller battery does open the ramp up again', async () => {
  // The gate is the ramp, not a blanket refusal: at 90 % the same production yields ~3.5 kW.
  const d = makeChargerDevice();
  const battery = { soc: 90, powerW: 2347 };
  const gridW = rampGridW(d, RAMP_CFG, 90, -15, FIELD_PV_W);
  await d._evaluateEvChargers(battery, gridW, [{ ...CHARGER_1PH, powerW: 0 }],
    RAMP_CFG, FIELD_PV_W, FIELD_HOUSE_W);
  assert.ok(d._getChargerState('c1').pendingStepAmps >= 6);
});

test('_evaluateEvChargers — the PV cross-check is gated by the ramp as well', async () => {
  // The second way round the ramp, and the one that would have survived fixing only the
  // boost: pvW − houseW is computed with no share at all and wins whenever it reads higher.
  // Here it would be 3341 W against the ramp's ~984 W. Battery idle so the boost cannot be
  // what starts the charger — if it starts, the cross-check did it.
  const d = makeChargerDevice();
  const battery = { soc: 52, powerW: 0 };
  const gridW = rampGridW(d, RAMP_CFG, 52, -15, FIELD_PV_W);
  await d._evaluateEvChargers(battery, gridW, [{ ...CHARGER_1PH, powerW: 0 }],
    RAMP_CFG, FIELD_PV_W, FIELD_HOUSE_W);
  assert.strictEqual(d._getChargerState('c1').pendingStepAmps, null);
});

// ── chargerControl: the PV / battery-boost budget changeover line ────────────
// Two estimates of the same surplus. Which one wins is a state, so only the changeover is
// logged — but at night both sit on zero and the comparison flips on meter noise, which
// made the "changeover" the most frequent line in a 33-hour field log: ~120 of them in two
// hours. Below the smallest rung a charger can take, neither answer has a subject.
const BUDGET_RE = /budget .* — using/;
const NIGHT_PV_WINS  = { bat: { soc: 80, powerW: -600 }, gridW: 5,     pvW: 0,    houseW: 500 };
const NIGHT_BAT_WINS = { bat: { soc: 80, powerW: -600 }, gridW: -5,    pvW: 0,    houseW: 500 };
const DAY_PV_WINS    = { bat: { soc: 80, powerW: 0 },    gridW: -1000, pvW: 8000, houseW: 500 };
const DAY_BAT_WINS   = { bat: { soc: 80, powerW: 0 },    gridW: -6000, pvW: 2000, houseW: 1900 };

async function budgetTick(d, c) {
  const charger = { ...CHARGER_1PH, powerW: 0 };
  await d._evaluateEvChargers(c.bat, c.gridW, [charger], {}, c.pvW, c.houseW);
}

test('_evaluateEvChargers — the budget changeover is silent while neither budget can start anything', async () => {
  const lines = [];
  const d = makeChargerDevice({ log: (m) => lines.push(m) });
  for (let i = 0; i < 6; i++) await budgetTick(d, i % 2 ? NIGHT_PV_WINS : NIGHT_BAT_WINS);
  assert.strictEqual(lines.filter((l) => BUDGET_RE.test(l)).length, 0);
});

test('_evaluateEvChargers — it does speak once a budget could actually run a charger', async () => {
  const lines = [];
  const d = makeChargerDevice({ log: (m) => lines.push(m) });
  await budgetTick(d, DAY_PV_WINS);
  const hits = lines.filter((l) => BUDGET_RE.test(l));
  assert.strictEqual(hits.length, 1);
  assert.match(hits[0], /PV budget 7500W > battery-boost budget 1000W/);
});

test('_evaluateEvChargers — a silent night flip does not swallow the next real changeover', async () => {
  // Why the last LOGGED winner is tracked separately from the current one. Tracking only
  // the current one lets a flip nobody saw satisfy the "has it changed?" test, and the
  // changeover that mattered then goes unreported.
  const lines = [];
  const d = makeChargerDevice({ log: (m) => lines.push(m) });
  await budgetTick(d, DAY_PV_WINS);    // logged: PV wins
  await budgetTick(d, NIGHT_BAT_WINS); // flips to battery boost, below the floor → silent
  await budgetTick(d, DAY_BAT_WINS);   // battery boost wins for real → must be reported
  const hits = lines.filter((l) => BUDGET_RE.test(l));
  assert.strictEqual(hits.length, 2);
  assert.match(hits[1], /battery-boost budget 6000W ≥ PV budget 100W/);
});

// ── chargerControl: the "car is at its target" latch across a restart ────────
// The 2026-08-15 field case. The Audi sat at 100% on the charger; the app was updated;
// on the next tick the EMS knew nothing about the car (a sleeping car reports no SoC
// until charging wakes it) and had also lost the latch, so it started a full car, ramped
// it to 16 A and stopped again two minutes later. Persisting the latch (lib/ems/chargerState.js)
// is what closes that window — these two tests are the before and the after.
const SLEEPING_CAR = { id: 'car1', name: 'Audi - Q4', soc: null, target: 100 };

// The solar tier does not command amps in the tick that decides them — it schedules the
// step and holds it STEP_HOLD_MS against thrash. So the tell for "the allocator wants to
// start this charger" is pendingStepAmps, not currentAmps. (The mode is 'holding' either
// way here and discriminates nothing.)
test('_evaluateEvChargers — a restored target latch keeps a car the EMS cannot read from being started', async () => {
  const charger = { ...CHARGER_1PH, carId: 'car1', powerW: 0 };
  const d = makeChargerDevice({ _carStates: [SLEEPING_CAR] });
  seedState(d, 'c1', { targetReachedCar: 'car1' }); // as _restoreChargerStates leaves it
  await d._evaluateEvChargers({ soc: 90, powerW: 0 }, -8000, [charger], {}, null, null);
  assert.strictEqual(d._getChargerState('c1').pendingStepAmps, null, 'no start even scheduled');
  assert.strictEqual(d._getChargerState('c1').currentAmps, null);
});

test('_evaluateEvChargers — without the latch the same tick schedules a start (the bug)', async () => {
  const charger = { ...CHARGER_1PH, carId: 'car1', powerW: 0 };
  const d = makeChargerDevice({ _carStates: [SLEEPING_CAR] });
  await d._evaluateEvChargers({ soc: 90, powerW: 0 }, -8000, [charger], {}, null, null);
  assert.strictEqual(d._getChargerState('c1').pendingStepAmps, 32);
});

test('_evaluateEvChargers — a latch restored for a car that turns out to be empty clears itself', async () => {
  // The risk of restoring a decision: the car may have been swapped during the downtime.
  // One reading below target − 2 is enough to release it, so a wrong latch costs one tick.
  const charger = { ...CHARGER_1PH, carId: 'car1', powerW: 0 };
  const d = makeChargerDevice({ _carStates: [{ id: 'car1', name: 'Other', soc: 20, target: 80 }] });
  seedState(d, 'c1', { targetReachedCar: 'car1' });
  await d._evaluateEvChargers({ soc: 90, powerW: 0 }, -8000, [charger], {}, null, null);
  assert.strictEqual(d._getChargerState('c1').targetReachedCar, null);
  assert.strictEqual(d._getChargerState('c1').pendingStepAmps, 32, 'and it is scheduled to charge');
});

test('_evaluateEvChargers — an unreadable car is reported once, not on every tick', async () => {
  const charger = { ...CHARGER_1PH, carId: 'car1', powerW: 0 };
  const lines = [];
  const d = makeChargerDevice({ _carStates: [SLEEPING_CAR], log: (m) => lines.push(m) });
  for (let i = 0; i < 3; i++) {
    await d._evaluateEvChargers({ soc: 90, powerW: 0 }, -8000, [charger], {}, null, null);
  }
  const blind = lines.filter((l) => /charge target not checkable/.test(l));
  assert.strictEqual(blind.length, 1);
  assert.match(blind[0], /soc unknown, target 100%/);
});

test('_evaluateEvChargers — the report comes back if the car goes quiet a second time', async () => {
  const charger = { ...CHARGER_1PH, carId: 'car1', powerW: 0 };
  const lines = [];
  const car = { id: 'car1', name: 'Audi - Q4', soc: null, target: 100 };
  const d = makeChargerDevice({ _carStates: [car], log: (m) => lines.push(m) });
  await d._evaluateEvChargers({ soc: 90, powerW: 0 }, -8000, [charger], {}, null, null);
  car.soc = 40;  // the car wakes up and reports
  await d._evaluateEvChargers({ soc: 90, powerW: 0 }, -8000, [charger], {}, null, null);
  car.soc = null; // …and drops off again
  await d._evaluateEvChargers({ soc: 90, powerW: 0 }, -8000, [charger], {}, null, null);
  assert.strictEqual(lines.filter((l) => /charge target not checkable/.test(l)).length, 2);
});

// ── chargerControl: whole-house grid-import ceiling (grid_import_limit_kw) ───
// A hard main-fuse safety limit that
// applies to EVERY unconditional-draw tier (Instant/Always/Off-peak here; Price/Low-
// tariff too), gracefully reducing to the highest amp-ladder rung that fits rather than
// rejecting outright. this._gridImportCommittedW is normally seeded per-tick in
// device.js from measured gridW — tests set it directly to simulate that.
test('_evaluateEvChargers — Instant charging (P0) gracefully reduces amps to fit the grid-import ceiling', async () => {
  const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 32, phases: 1, phaseSwitch: false };
  const d = makeChargerDevice({
    getCapabilityValue: (cap) => (cap === 'charge_now' ? true : undefined),
    _gridImportCommittedW: 0,
  });
  const battery = { soc: 90, powerW: 0 };
  const cfg = { grid_import_limit_kw: 2 }; // 2000 W headroom → 8 A @ 1ph/230V (8×230=1840 ≤ 2000, 9×230=2070 > 2000)
  await d._evaluateEvChargers(battery, 0, [charger], cfg, null, null);
  assert.strictEqual(d._getChargerState('c1').currentAmps, 8);
  assert.strictEqual(d._lastMode.mode, 'instant_ev');
});
// ── instant charging with a car that is already full ─────────────────────────
// P0 returns before P2.5, so the charge-target hold never applies here — deliberately: the
// mode means "full power until I say otherwise". A car at its target still draws nothing,
// though, and the tile used to read "16A/3ph" for hours with no watt behind it.
test('_evaluateEvChargers — Instant charging (P0) says the car is full, and keeps granting anyway', async () => {
  const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 16, phases: 3, phaseSwitch: false };
  const d = makeChargerDevice({
    getCapabilityValue: (cap) => (cap === 'charge_now' ? true : undefined),
    _carStates: [{ id: 'car1', name: 'Tesla', soc: 82, target: 80 }],
  });
  await d._evaluateEvChargers({ soc: 90, powerW: 0 }, 0, [charger], {}, null, null);

  assert.strictEqual(d._lastMode.mode, 'instant_ev', 'the mode must not change — nothing was decided');
  assert.match(d._lastMode.text, /Tesla voll \(82% ≥ 80%\)/, 'the status does not say the car is full');
  assert.match(d._lastMode.text, /wartet auf Abstecken/, 'it does not say what ends this');
  assert.match(d._lastMode.text, /16A\/3ph/, 'the granted amps vanished from the text');
  // The decisive half: the owner said charge, so the charger keeps its grant.
  assert.strictEqual(d._getChargerState('c1').currentAmps, 16, 'instant charging was stopped by a full car');
});

test('_evaluateEvChargers — Instant charging (P0) below target reads exactly as before', async () => {
  const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 16, phases: 3, phaseSwitch: false };
  const d = makeChargerDevice({
    getCapabilityValue: (cap) => (cap === 'charge_now' ? true : undefined),
    _carStates: [{ id: 'car1', name: 'Tesla', soc: 42, target: 80 }],
  });
  await d._evaluateEvChargers({ soc: 90, powerW: 0 }, 0, [charger], {}, null, null);
  assert.strictEqual(d._lastMode.text, '16A/3ph', 'the plain case grew decoration it should not have');
});

// A car whose SoC or target is unknown must not be called full — the P2.5 comment makes the
// same point: an unreadable car may well need the energy.
test('_evaluateEvChargers — Instant charging (P0) never calls an unreadable car full', async () => {
  for (const car of [{ id: 'car1', name: 'Tesla', soc: null, target: 80 },
                     { id: 'car1', name: 'Tesla', soc: 82, target: null }]) {
    const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 16, phases: 3, phaseSwitch: false };
    const d = makeChargerDevice({
      getCapabilityValue: (cap) => (cap === 'charge_now' ? true : undefined),
      _carStates: [car],
    });
    await d._evaluateEvChargers({ soc: 90, powerW: 0 }, 0, [charger], {}, null, null);
    assert.strictEqual(d._lastMode.text, '16A/3ph', `an unreadable car was called full: ${JSON.stringify(car)}`);
  }
});

test('_evaluateEvChargers — Instant charging (P0) stops the charger entirely when even the minimum amp does not fit', async () => {
  const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 32, phases: 1, phaseSwitch: false };
  const d = makeChargerDevice({
    getCapabilityValue: (cap) => (cap === 'charge_now' ? true : undefined),
    _gridImportCommittedW: 900, // only 100 W headroom left of a 1 kW ceiling — below 6A's 1380 W minimum
  });
  const battery = { soc: 90, powerW: 0 };
  const cfg = { grid_import_limit_kw: 1 };
  seedState(d, 'c1', { currentAmps: 16, currentPhases: 1 }); // pretend it was already running
  await d._evaluateEvChargers(battery, 0, [charger], cfg, null, null);
  assert.strictEqual(d._getChargerState('c1').currentAmps, null); // stopped — no headroom at all
});
test('_evaluateEvChargers — "Always charge" (P0.5) gracefully reduces amps to fit the grid-import ceiling', async () => {
  const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 32, phases: 1, phaseSwitch: false, chargeMode: 'always' };
  const d = makeChargerDevice({ _gridImportCommittedW: 0 });
  const battery = { soc: 90, powerW: 0 };
  const cfg = { grid_import_limit_kw: 2 };
  await d._evaluateEvChargers(battery, 0, [charger], cfg, null, null);
  assert.strictEqual(d._getChargerState('c1').currentAmps, 8);
});
test('_evaluateEvChargers — Off-peak (P3) gracefully reduces amps to fit the grid-import ceiling', async () => {
  const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 32, phases: 1, phaseSwitch: false, chargeMode: 'solar_offpeak' };
  const d = makeChargerDevice({
    _offpeakWindow: () => ({ active: true, amps: 16 }),
    _gridImportCommittedW: 0,
  });
  const battery = { soc: 90, powerW: 0 };
  const cfg = { offpeak_solar_first: true, grid_import_limit_kw: 2 };
  await d._evaluateEvChargers(battery, 500, [charger], cfg, null, null); // importing → solar can't claim
  assert.strictEqual(d._getChargerState('c1').currentAmps, 8); // reduced from the 16A off-peak amps
  assert.strictEqual(d._lastMode.mode, 'offpeak_ev');
});
test('_evaluateEvChargers — Price-optimised charging (P3b) skips grid-charging when the import ceiling has no headroom, even though the price budget fits', async () => {
  const now = Date.UTC(2026, 0, 1, 20, 0, 0);
  const slots = [{ start: now, end: now + 3600_000, price: 0.10 }];
  const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 16, phases: 1, phaseSwitch: false, chargeMode: 'solar_price', carId: 'car1', powerW: 0 };
  const car = { id: 'car1', name: 'EV', soc: 40, target: 80, capacityKwh: 20, readyBy: '21:00' };
  const d = makeChargerDevice({
    homey: { flow: { getTriggerCard: () => ({ trigger: () => Promise.resolve() }) }, clock: { getTimezone: () => 'UTC' }, setTimeout: (f, m) => setTimeout(f, m), clearTimeout: (t) => clearTimeout(t) },
    _pvForecast: null,
    _priceForecast: slots,
    _priceForecastUpdatedAt: now,
    _carStates: [car],
    _gridImportCommittedW: 2000, // already at the ceiling — no headroom for the price budget's charger
  });
  const battery = { soc: 90, powerW: 0 };
  const cfg = { offpeak_solar_first: true, grid_import_limit_kw: 2 }; // price budget alone would allow this
  await d._evaluateEvChargers(battery, 0, [charger], cfg, null, null);
  assert.strictEqual(d._getChargerState('c1').currentAmps, null); // denied by the import ceiling, not the price budget
  assert.notStrictEqual(d._lastMode.mode, 'price_ev');
});
test('_evaluateEvChargers — grid_import_limit_kw unset (0) → unlimited, ceiling has no effect', async () => {
  const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 32, phases: 1, phaseSwitch: false };
  const d = makeChargerDevice({
    getCapabilityValue: (cap) => (cap === 'charge_now' ? true : undefined),
    _gridImportCommittedW: 999999, // would exceed any real cap, but the feature is off
  });
  const battery = { soc: 90, powerW: 0 };
  const cfg = {}; // grid_import_limit_kw unset
  await d._evaluateEvChargers(battery, 0, [charger], cfg, null, null);
  assert.strictEqual(d._getChargerState('c1').currentAmps, 32); // unaffected — no ceiling configured
});

// ── chargerControl: grid-import ceiling must claim a DELTA, not the total ────
// Regression guard. this._gridImportCommittedW is seeded per-tick (device.js _tickBody)
// from the MEASURED grid import, which already contains whatever the charger is drawing
// right now. Claiming the new target on top of that counted the same charger twice: a
// charger comfortably inside the ceiling was stopped, its draw then left the meter
// reading, the next tick saw headroom and restarted it — a permanent 15 s cycle.
// NOTE: unlike the tests above, these seed _gridImportCommittedW from gridW exactly as
// production does, instead of hardcoding 0 — that mismatch is what hid the bug.
test('_evaluateEvChargers — a running charger already inside the ceiling is NOT stopped (no double-count)', async () => {
  const HOUSE_W = 1000, DRAW_W = 16 * 3 * 230; // 11040 W; total 12040 W under a 15 kW ceiling
  const gridW = HOUSE_W + DRAW_W;
  const charger = {
    id: 'c1', connected: true, minAmps: 6, maxAmps: 16, phases: 3, phaseSwitch: false,
    chargeMode: 'always', powerW: DRAW_W, rawPowerW: DRAW_W,
  };
  const d = makeChargerDevice({ _gridImportCommittedW: Math.max(0, gridW) }); // seeded as production does
  seedState(d, 'c1', { currentAmps: 16, currentPhases: 3 }); // already running
  await d._evaluateEvChargers({ soc: 90, powerW: 0 }, gridW, [charger], { grid_import_limit_kw: 15 }, null, null);
  assert.strictEqual(d._getChargerState('c1').currentAmps, 16); // held, not stopped
});
test('_evaluateEvChargers — a charger whose own draw pushes the house over the ceiling steps DOWN rather than stopping', async () => {
  const HOUSE_W = 4460, DRAW_W = 16 * 3 * 230; // total 15500 W — 500 W over a 15 kW ceiling
  const gridW = HOUSE_W + DRAW_W;
  const charger = {
    id: 'c1', connected: true, minAmps: 6, maxAmps: 16, phases: 3, phaseSwitch: false,
    chargeMode: 'always', powerW: DRAW_W, rawPowerW: DRAW_W,
  };
  const d = makeChargerDevice({ _gridImportCommittedW: Math.max(0, gridW) });
  seedState(d, 'c1', { currentAmps: 16, currentPhases: 3 });
  await d._evaluateEvChargers({ soc: 90, powerW: 0 }, gridW, [charger], { grid_import_limit_kw: 15 }, null, null);
  const amps = d._getChargerState('c1').currentAmps;
  assert.strictEqual(amps, 15); // 15 A × 3 ph = 10350 W → 14810 W total, back under the ceiling
  assert.ok(HOUSE_W + amps * 3 * 230 <= 15000);
});
test('_evaluateEvChargers — a second charger still gets only the real remaining headroom', async () => {
  // c1 already drawing 11040 W of a 15 kW ceiling, house 1000 W → 2960 W left, which is
  // below c1's own minimum rung, so c2 must get nothing. Guards against the delta fix
  // accidentally freeing up headroom that isn't there.
  const HOUSE_W = 1000, DRAW_W = 16 * 3 * 230;
  const gridW = HOUSE_W + DRAW_W;
  const mk = (id, powerW) => ({
    id, connected: true, minAmps: 6, maxAmps: 16, phases: 3, phaseSwitch: false,
    chargeMode: 'always', powerW, rawPowerW: powerW,
  });
  const d = makeChargerDevice({ _gridImportCommittedW: Math.max(0, gridW) });
  seedState(d, 'c1', { currentAmps: 16, currentPhases: 3 });
  await d._evaluateEvChargers({ soc: 90, powerW: 0 }, gridW, [mk('c1', DRAW_W), mk('c2', 0)],
    { grid_import_limit_kw: 15 }, null, null);
  assert.strictEqual(d._getChargerState('c1').currentAmps, 16); // keeps its own draw
  assert.strictEqual(d._getChargerState('c2').currentAmps, null); // no headroom for a second
});

// ── chargerControl: the ceiling claims the GRANTED power, never a stranded max ──
test('_evaluateEvChargers — the whole-house ceiling is claimed for the amps actually granted, not the theoretical max', async () => {
  // 5 kW house ceiling leaves room for 7 A × 3 ph (4830 W) of a 16 A charger. The price
  // ceiling must be charged 4830 W — not the 11040 W max the charger asked for.
  // Anchored on the real clock: _evaluateEvChargers reads Date.now() internally, so a
  // hardcoded past timestamp would silently route through the stale-forecast fail-safe
  // instead of the cheap-slot path this test is about.
  const now = Date.now();
  const slots = [{ start: now - 60_000, end: now + 3600_000, price: 0.10 }];
  const charger = {
    id: 'c1', connected: true, minAmps: 6, maxAmps: 16, phases: 3, phaseSwitch: false,
    chargeMode: 'solar_price', carId: 'car1', powerW: 0, rawPowerW: 0,
  };
  const d = makeChargerDevice({
    _gridImportCommittedW: 0,
    _priceForecast: slots, _priceForecastUpdatedAt: now,
    _carStates: [{ id: 'car1', name: 'Car', soc: 10, target: 80, capacityKwh: 60, readyBy: '07:00' }],
  });
  const cfg = { grid_import_limit_kw: 5, price_ev_precondition_h: 0 };
  const allocated = await d._evaluateEvChargers({ soc: 90, powerW: 0 }, 0, [charger], cfg, null, null);
  assert.strictEqual(d._getChargerState('c1').currentAmps, 7);
  assert.strictEqual(allocated, 7 * 3 * 230);            // 4830 W
  assert.strictEqual(d._gridImportCommittedW, 4830);
});

// ── chargerControl: per-device "EMS controls this device" toggle ─────────────
test('_evaluateEvChargers — a charger with enabled:false is left alone even with ample surplus', async () => {
  const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 32, phases: 1, phaseSwitch: false, enabled: false, powerW: 0 };
  const d = makeChargerDevice();
  const battery = { soc: 90, powerW: 0 };
  await d._evaluateEvChargers(battery, -5000, [charger], {}, null, null); // 5 kW export surplus
  assert.strictEqual(d._getChargerState('c1').currentAmps, null); // never started
});
test('_evaluateEvChargers — a disabled charger is skipped even while other enabled chargers are still managed', async () => {
  // Instant charging (P0) sets amps directly in one tick (unlike the solar-surplus
  // loop, which has a 30s anti-thrash step-hold) — the reliable way to assert an
  // immediate amp change within a single call, same as the other P0 tests above.
  const disabled = { id: 'c1', connected: true, minAmps: 6, maxAmps: 32, phases: 1, phaseSwitch: false, enabled: false };
  const enabled  = { id: 'c2', connected: true, minAmps: 6, maxAmps: 32, phases: 1, phaseSwitch: false };
  const d = makeChargerDevice({ getCapabilityValue: (cap) => (cap === 'charge_now' ? true : undefined) });
  const battery = { soc: 90, powerW: 0 };
  await d._evaluateEvChargers(battery, 0, [disabled, enabled], {}, null, null);
  assert.strictEqual(d._getChargerState('c1').currentAmps, null);
  assert.strictEqual(d._getChargerState('c2').currentAmps, 32);
});

// ── simpleDevices: whole-house grid-import ceiling (grid_import_limit_kw) ────
test('_evaluateSimpleDevices — a new start is denied when the grid-import ceiling has no headroom', async () => {
  const now = Date.now();
  const d = makeSimpleDevice({ _gridImportCommittedW: 1900 }); // already close to the 2 kW ceiling
  const cfg = { min_battery_soc: 80, grid_import_limit_kw: 2 }; // 100 W headroom left, device wants 1000 W
  await d._evaluateSimpleDevices({ soc: 90, powerW: 0 }, -2000, [simpleDev()],
    new Map([['d1', { isOn: false, startedAt: null, surplusOkSince: now - 61_000, surplusBadSince: null, powerDropStoppedAt: null }]]),
    'start', 'stop', 'tok', cfg);
  // Surplus/timer logic alone would start it (same fixture as "start needs sustained surplus")
  // — the ceiling denies it anyway.
  assert.deepStrictEqual(d._setOnCalls, [{ id: 'd1', on: false }]);
});
test('_evaluateSimpleDevices — an already-running device is left alone even with zero headroom (no short-cycling)', async () => {
  const now = Date.now();
  const d = makeSimpleDevice({ _gridImportCommittedW: 999999 }); // way past any ceiling
  const cfg = { min_battery_soc: 80, grid_import_limit_kw: 2 };
  await d._evaluateSimpleDevices({ soc: 90, powerW: 0 }, 0, [simpleDev()],
    new Map([['d1', { isOn: true, startedAt: now - 60_000, surplusOkSince: null, surplusBadSince: null, powerDropStoppedAt: null }]]),
    'start', 'stop', 'tok', cfg);
  assert.deepStrictEqual(d._setOnCalls, [{ id: 'd1', on: true }]); // held on by min-run — ceiling only gates NEW starts
});
test('_evaluateSimpleDevices — grid_import_limit_kw unset (0) → unlimited, ceiling has no effect', async () => {
  const now = Date.now();
  const d = makeSimpleDevice({ _gridImportCommittedW: 999999 }); // would exceed any real cap, but the feature is off
  const cfg = { min_battery_soc: 80 }; // grid_import_limit_kw unset
  await d._evaluateSimpleDevices({ soc: 90, powerW: 0 }, -2000, [simpleDev()],
    new Map([['d1', { isOn: false, startedAt: null, surplusOkSince: now - 61_000, surplusBadSince: null, powerDropStoppedAt: null }]]),
    'start', 'stop', 'tok', cfg);
  assert.deepStrictEqual(d._setOnCalls, [{ id: 'd1', on: true }]); // unaffected — no ceiling configured
});

// ── chargerControl integration: 'solar_price' charge mode (D10) ──────────────
test('_evaluateEvChargers — solar_price charger charges in the cheap slot, sets PRICE_EV mode', async () => {
  const now = Date.UTC(2026, 0, 1, 20, 0, 0);
  const slots = [{ start: now, end: now + 3600_000, price: 0.10 }];
  const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 16, phases: 1, phaseSwitch: false, chargeMode: 'solar_price', carId: 'car1', powerW: 0 };
  const car = { id: 'car1', name: 'EV', soc: 40, target: 80, capacityKwh: 20, readyBy: '21:00' };
  const d = makeChargerDevice({
    homey: { flow: { getTriggerCard: () => ({ trigger: () => Promise.resolve() }) }, clock: { getTimezone: () => 'UTC' }, setTimeout: (f, m) => setTimeout(f, m), clearTimeout: (t) => clearTimeout(t) },
    _pvForecast: null,
    _priceForecast: slots,
    _priceForecastUpdatedAt: now,
    _carStates: [car],
  });
  const battery = { soc: 90, powerW: 0 };
  const cfg = { offpeak_solar_first: true };
  const allocated = await d._evaluateEvChargers(battery, 0, [charger], cfg, null, null); // gridW=0 → not exporting → solarCanClaim=false
  assert.strictEqual(d._getChargerState('c1').currentAmps, 16); // charges at max
  assert.ok(allocated > 0);
  assert.strictEqual(d._lastMode.mode, 'price_ev');
});

test('_evaluateEvChargers — solar_price charger waits when solar is claiming the surplus', async () => {
  const now = Date.UTC(2026, 0, 1, 20, 0, 0);
  const slots = [{ start: now, end: now + 3600_000, price: 0.10 }];
  const charger = { id: 'c1', connected: true, minAmps: 6, maxAmps: 16, phases: 1, phaseSwitch: false, chargeMode: 'solar_price', carId: 'car1', powerW: 0 };
  const car = { id: 'car1', name: 'EV', soc: 40, target: 80, capacityKwh: 20, readyBy: '21:00' };
  const d = makeChargerDevice({
    homey: { flow: { getTriggerCard: () => ({ trigger: () => Promise.resolve() }) }, clock: { getTimezone: () => 'UTC' }, setTimeout: (f, m) => setTimeout(f, m), clearTimeout: (t) => clearTimeout(t) },
    _warmupDone: false, // avoid the solar-allocation loop actually issuing amp commands past P3b
    _pvForecast: null,
    _priceForecast: slots,
    _priceForecastUpdatedAt: now,
    _carStates: [car],
  });
  const battery = { soc: 90, powerW: 0 };
  const cfg = { offpeak_solar_first: true };
  // Strong export (-5000 W) ≥ minClaimW → solar claims it, P3b does not force-charge.
  await d._evaluateEvChargers(battery, -5000, [charger], cfg, null, null);
  assert.strictEqual(d._getChargerState('c1').currentAmps, null); // not forced on by price logic
});

// ── the feed-in tariff ───────────────────────────────────────────────────────
// Solar a charging car takes was never bought, but on a contract that pays for exports it
// was not free either — it is revenue given up. The session cost used to value it at zero,
// which is only true where feeding in earns nothing, and made every sunny session read
// "0.00".
//
// Unset and zero are deliberately different answers, and these tests exist mostly to keep
// them apart: unset means nobody has said what an exported kWh earns, and every install was
// in that state before the field existed, so it must behave exactly as it did.
test('_feedInTariff — tells "not configured" apart from "earns nothing"', () => {
  const d = makeChargerDevice();
  assert.strictEqual(d._feedInTariff({}), null, 'no price_config at all');
  assert.strictEqual(d._feedInTariff({ price_config: {} }), null, 'field absent');
  assert.strictEqual(d._feedInTariff({ price_config: { price_feed_in: null } }), null);
  assert.strictEqual(d._feedInTariff({ price_config: { price_feed_in: '' } }), null, 'an empty box is not a zero');
  assert.strictEqual(d._feedInTariff({ price_config: { price_feed_in: 0 } }), 0, 'zero is a real contract');
  assert.strictEqual(d._feedInTariff({ price_config: { price_feed_in: 0.09 } }), 0.09);
  assert.strictEqual(d._feedInTariff({ price_config: { price_feed_in: '0.12' } }), 0.12, 'the settings page sends strings');
  // A stray minus would turn every sunny session into a profit.
  assert.strictEqual(d._feedInTariff({ price_config: { price_feed_in: -0.05 } }), null);
  assert.strictEqual(d._feedInTariff({ price_config: { price_feed_in: 'gratis' } }), null);
});

// One hour at 2 kW with the meter importing 1 kW: half the energy is grid, half is solar.
function feedInSession(priceConfig) {
  const d = makeChargerDevice({ _chargeSessions: [] });
  const cfg = { price_config: priceConfig };
  const charger = { id: 'c1', connected: true, rawPowerW: 2000 };
  d._trackChargeSession(charger, cfg, 3600_000, 1000); // 1 h tick, grid +1000 W
  d._trackChargeSession({ id: 'c1', connected: false, rawPowerW: 0 }, cfg, 0, 0);
  return d._chargeSessions[0];
}

test('_trackChargeSession — without a feed-in tariff the figures are exactly what they were', () => {
  const row = feedInSession({ mode: 'fixed', price_fixed: 0.30, currency: 'CHF' });
  assert.strictEqual(row.energyKwh, 2);
  assert.strictEqual(row.gridKwh, 1);
  assert.strictEqual(row.pvKwh, 1);
  assert.strictEqual(row.cost, 0.3, 'only the grid half costs anything');
  assert.strictEqual(row.avgPrice, 0.3, 'the average still means "per kWh whose price was known"');
});

test('_trackChargeSession — with a feed-in tariff the solar half costs the revenue given up', () => {
  const row = feedInSession({ mode: 'fixed', price_fixed: 0.30, price_feed_in: 0.09, currency: 'CHF' });
  assert.strictEqual(row.energyKwh, 2);
  assert.strictEqual(row.cost, 0.39, '1 kWh grid at 0.30 plus 1 kWh solar at 0.09');
  assert.strictEqual(row.avgPrice, 0.195, 'now every kWh has a price, so the average covers all of it');
});

// `cost` alone cannot answer "what did I actually pay?" — it mixes money that left the
// account with export revenue that was never taken. The two halves travel with the row so
// the settings page can name them instead of leaving the reader to guess.
test('_trackChargeSession — the cost is reported as its two halves as well as its total', () => {
  const row = feedInSession({ mode: 'fixed', price_fixed: 0.30, price_feed_in: 0.09, currency: 'CHF' });
  assert.strictEqual(row.gridCost, 0.3, '1 kWh bought at 0.30');
  assert.strictEqual(row.solarCost, 0.09, '1 kWh of sun not fed in at 0.09');
  assert.strictEqual(row.cost, 0.39, 'and the total is still the total');
});

// The field question that prompted the split: a 6.28 kWh session that was 97 % solar
// showed 0.51 CHF, and nothing on screen said why that is nowhere near the 0.3415 tariff.
test('_trackChargeSession — the halves reproduce the field session that raised the question', () => {
  const d = makeChargerDevice({ _chargeSessions: [] });
  const cfg = { price_config: { mode: 'fixed', price_fixed: 0.3415, price_feed_in: 0.075, currency: 'CHF' } };
  // 6.28 kWh over one hour, of which 0.16 kWh came from the meter.
  d._trackChargeSession({ id: 'c1', connected: true, rawPowerW: 6280 }, cfg, 3600_000, 160);
  d._trackChargeSession({ id: 'c1', connected: false, rawPowerW: 0 }, cfg, 0, 0);
  const row = d._chargeSessions[0];
  assert.strictEqual(row.energyKwh, 6.28);
  assert.strictEqual(row.gridCost, 0.05, '0.16 kWh × 0.3415');
  assert.strictEqual(row.solarCost, 0.46, '6.12 kWh × 0.075');
  assert.strictEqual(row.cost, 0.51);
  assert.strictEqual(row.avgPrice, 0.082);
});

test('_trackChargeSession — a session with no price at all reports no halves either', () => {
  const d = makeChargerDevice({ _chargeSessions: [], _variablePrice: null });
  const cfg = { price_config: { mode: 'variable' } }; // nothing ever pushed → price is unknown, not zero
  d._trackChargeSession({ id: 'c1', connected: true, rawPowerW: 2000 }, cfg, 3600_000, 1000);
  d._trackChargeSession({ id: 'c1', connected: false, rawPowerW: 0 }, cfg, 0, 0);
  const row = d._chargeSessions[0];
  assert.strictEqual(row.cost, null);
  assert.strictEqual(row.gridCost, null, 'nothing was priced, so there is nothing to split');
  assert.strictEqual(row.solarCost, null);
});

// The case that makes the null/zero split worth having: a contract that pays nothing.
test('_trackChargeSession — a feed-in tariff of zero prices the solar, it does not un-price it', () => {
  const row = feedInSession({ mode: 'fixed', price_fixed: 0.30, price_feed_in: 0, currency: 'CHF' });
  assert.strictEqual(row.cost, 0.3, 'solar earns nothing, so it costs nothing');
  assert.strictEqual(row.avgPrice, 0.15, 'but it IS priced, so it counts in the average');
});

test('_trackChargeSession — a session drawn entirely from the grid is untouched by the tariff', () => {
  const d = makeChargerDevice({ _chargeSessions: [] });
  const cfg = { price_config: { mode: 'fixed', price_fixed: 0.30, price_feed_in: 0.09, currency: 'CHF' } };
  d._trackChargeSession({ id: 'c1', connected: true, rawPowerW: 2000 }, cfg, 3600_000, 5000); // import exceeds the draw
  d._trackChargeSession({ id: 'c1', connected: false, rawPowerW: 0 }, cfg, 0, 0);
  const row = d._chargeSessions[0];
  assert.strictEqual(row.gridKwh, 2);
  assert.strictEqual(row.pvKwh, 0);
  assert.strictEqual(row.cost, 0.6);
  assert.strictEqual(row.avgPrice, 0.3);
});

// ── chargeSessions: _trackChargeSession / _finalizeChargeSession ─────────────
test('_trackChargeSession — accumulates energy over ticks and finalizes on disconnect', () => {
  const d = makeChargerDevice({ _chargeSessions: [] });
  const cfg = { price_config: { mode: 'fixed', price_fixed: 0.30, currency: 'CHF' } };
  const charger = { id: 'c1', connected: true, powerW: 7360 }; // 7.36 kW (32A x 1ph x 230V)
  const dtMs = 15_000; // one 15 s tick

  // 4 ticks at 7.36 kW for 15 s each → 4 * 7.36 * (15/3600) kWh
  for (let i = 0; i < 4; i++) d._trackChargeSession(charger, cfg, dtMs, 99999);
  assert.strictEqual(d._chargeSessions.length, 0); // still connected — no session finalized yet

  const disconnected = { id: 'c1', connected: false, powerW: 0 };
  d._trackChargeSession(disconnected, cfg, dtMs, 99999);

  assert.strictEqual(d._chargeSessions.length, 1);
  const s = d._chargeSessions[0];
  const expectedKwh = Math.round(4 * 7.36 * (15 / 3600) * 100) / 100;
  assert.strictEqual(s.energyKwh, expectedKwh);
  assert.strictEqual(s.currency, 'CHF');
  assert.strictEqual(s.avgPrice, 0.30); // fixed price the whole session
  assert.strictEqual(Math.round(s.cost * 100) / 100, Math.round(expectedKwh * 0.30 * 100) / 100);
});
test('_trackChargeSession — bills the MEASURED draw, not the amps×phases estimate floor', () => {
  // Regression guard. device.js _getChargers sets powerW = max(rawPowerW, estimate) purely
  // to stop a false "no surplus" charger stop during startup lag. Billing that estimate
  // inflated logged kWh/cost by up to ~3× for any car drawing less than commanded
  // (tapering near full, or a 1-phase car on a 3-phase charger).
  const d = makeChargerDevice();
  const cfg = { price_config: { mode: 'fixed', price_fixed: 0.30, currency: 'CHF' } };
  seedState(d, 'c1', { currentAmps: 16, currentPhases: 3 }); // commanded 11040 W
  const charger = { id: 'c1', connected: true, rawPowerW: 4000, powerW: 16 * 3 * 230 };
  for (let i = 0; i < 240; i++) d._trackChargeSession(charger, cfg, 15_000, 99999); // 1 h
  d._trackChargeSession({ ...charger, connected: false, rawPowerW: 0, powerW: 0 }, cfg, 15_000, 99999);
  const s = d.getEmsChargeSessions()[0];
  assert.strictEqual(s.energyKwh, 4);      // 4000 W for 1 h — was 11.04 kWh before the fix
  assert.strictEqual(s.cost, 1.2);         // 4 kWh × 0.30 — was 3.31 CHF
  assert.strictEqual(s.avgPrice, 0.3);
});
test('_trackChargeSession — falls back to the estimate when the charger reports no power at all', () => {
  // rawPowerW null (no measure_power capability) → powerW (the estimate) is all we have.
  const d = makeChargerDevice();
  const cfg = { price_config: { mode: 'fixed', price_fixed: 0.30, currency: 'CHF' } };
  const charger = { id: 'c1', connected: true, rawPowerW: null, powerW: 2000 };
  for (let i = 0; i < 240; i++) d._trackChargeSession(charger, cfg, 15_000, 99999); // 1 h
  d._trackChargeSession({ ...charger, connected: false, powerW: 0 }, cfg, 15_000, 99999);
  assert.strictEqual(d.getEmsChargeSessions()[0].energyKwh, 2);
});
test('_trackChargeSession — negligible-energy sessions are not logged', () => {
  const d = makeChargerDevice({ _chargeSessions: [] });
  const cfg = { price_config: { mode: 'fixed', price_fixed: 0.30 } };
  // One tick at low power — well under the 0.05 kWh logging floor.
  d._trackChargeSession({ id: 'c1', connected: true, powerW: 100 }, cfg, 15_000, 99999);
  d._trackChargeSession({ id: 'c1', connected: false, powerW: 0 }, cfg, 15_000, 99999);
  assert.strictEqual(d._chargeSessions.length, 0);
});
test('_trackChargeSession — pauses within one plug-in period stay a single session', () => {
  const d = makeChargerDevice({ _chargeSessions: [] });
  const cfg = { price_config: { mode: 'fixed', price_fixed: 0.30 } };
  const on  = { id: 'c1', connected: true, powerW: 7360 };
  const off = { id: 'c1', connected: true, powerW: 0 }; // still plugged in, just not drawing (e.g. no surplus)
  for (let i = 0; i < 10; i++) d._trackChargeSession(on, cfg, 15_000, 99999);
  for (let i = 0; i < 10; i++) d._trackChargeSession(off, cfg, 15_000, 99999); // paused — still connected
  for (let i = 0; i < 10; i++) d._trackChargeSession(on, cfg, 15_000, 99999); // resumes
  d._trackChargeSession({ id: 'c1', connected: false, powerW: 0 }, cfg, 15_000, 99999); // unplugged
  assert.strictEqual(d._chargeSessions.length, 1); // one session, not three
  assert.ok(d._chargeSessions[0].energyKwh > 0);
});
test('_trackChargeSession — carName resolved via _carForCharger when known', () => {
  const car = { id: 'car1', name: 'Tesla', soc: 40, target: 80 };
  const d = makeChargerDevice({ _chargeSessions: [], _carStates: [car] });
  const cfg = { price_config: { mode: 'fixed', price_fixed: 0.30 } };
  const charger = { id: 'c1', connected: true, powerW: 7360, carId: 'car1' };
  for (let i = 0; i < 5; i++) d._trackChargeSession(charger, cfg, 15_000, 99999);
  d._trackChargeSession({ id: 'c1', connected: false, powerW: 0, carId: 'car1' }, cfg, 15_000, 99999);
  assert.strictEqual(d._chargeSessions[0].carName, 'Tesla');
});
test('_trackChargeSession — no price configured (mode variable, unset) → energy logged, cost null', () => {
  const d = makeChargerDevice({ _chargeSessions: [], _variablePrice: null });
  const cfg = { price_config: { mode: 'variable' } }; // no value ever pushed → _getCurrentPrice returns null
  const charger = { id: 'c1', connected: true, powerW: 7360 };
  for (let i = 0; i < 5; i++) d._trackChargeSession(charger, cfg, 15_000, 99999);
  d._trackChargeSession({ id: 'c1', connected: false, powerW: 0 }, cfg, 15_000, 99999);
  assert.strictEqual(d._chargeSessions.length, 1);
  assert.ok(d._chargeSessions[0].energyKwh > 0);
  assert.strictEqual(d._chargeSessions[0].cost, null);
  assert.strictEqual(d._chargeSessions[0].avgPrice, null);
});

// ── the session still running is listed too ──────────────────────────────────
// A session closes on UNPLUG. A car left on the cable over a weekend therefore produced
// nothing to look at: the owner charged on the Friday and the Saturday and found a list
// whose newest entry was nine days old. The energy was never lost — it was accumulating in
// an open session — but the device's memory is not a place anyone can look.
test('getEmsChargeSessions — a running session is listed first, marked, with no end time', () => {
  const d = makeChargerDevice({ _chargeSessions: [] });
  const cfg = { price_config: { mode: 'fixed', price_fixed: 0.30, currency: 'CHF' } };
  const charger = { id: 'c1', connected: true, rawPowerW: 7360, powerW: 7360 };
  for (let i = 0; i < 240; i++) d._trackChargeSession(charger, cfg, 15_000, 99999); // 1 h

  const out = d.getEmsChargeSessions(cfg);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].running, true);
  assert.strictEqual(out[0].endedAt, null, 'no end — the cable is still in');
  assert.strictEqual(out[0].energyKwh, 7.36);
  assert.strictEqual(out[0].currency, 'CHF');
  assert.strictEqual(d._chargeSessions.length, 0, 'not written to the persisted list yet');
});

test('getEmsChargeSessions — the running one sorts above finished ones', () => {
  const d = makeChargerDevice({
    _chargeSessions: [{ chargerId: 'c9', startedAt: 1, endedAt: 2, energyKwh: 1 }],
  });
  const cfg = { price_config: { currency: 'CHF' } };
  d._trackChargeSession({ id: 'c1', connected: true, rawPowerW: 7360, powerW: 7360 }, cfg, 15_000, 99999);
  const out = d.getEmsChargeSessions(cfg);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].running, true);
  assert.strictEqual(out[1].chargerId, 'c9');
});

test('getEmsChargeSessions — a just-started session is shown despite the 0.05 kWh floor', () => {
  // _finalizeChargeSession drops anything under 0.05 kWh, which is right for a connection
  // blip that is over. It is wrong for a session in progress: the one whose absence would
  // puzzle someone most is the one that started a minute ago.
  const d = makeChargerDevice({ _chargeSessions: [] });
  const cfg = { price_config: { currency: 'CHF' } };
  d._trackChargeSession({ id: 'c1', connected: true, rawPowerW: 0, powerW: 0 }, cfg, 15_000, 99999);
  const out = d.getEmsChargeSessions(cfg);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].energyKwh, 0);
  assert.strictEqual(out[0].running, true);
});

test('getEmsChargeSessions — the running row says whether it is drawing right now', () => {
  // Plugged in is not the same as charging: between two solar windows the EMS holds the
  // charger at zero and the session stays open. The session-history widget shows that as
  // "paused", and a growing duration labelled "in progress" while nothing flows would be
  // the wrong word.
  const d = makeChargerDevice({ _chargeSessions: [] });
  const cfg = { price_config: { currency: 'CHF' } };
  d._trackChargeSession({ id: 'c1', connected: true, rawPowerW: 7360, powerW: 7360 }, cfg, 15_000, 99999);

  seedState(d, 'c1', { currentAmps: null });
  assert.strictEqual(d.getEmsChargeSessions(cfg)[0].charging, false, 'held at zero');
  seedState(d, 'c1', { currentAmps: 0 });
  assert.strictEqual(d.getEmsChargeSessions(cfg)[0].charging, false, '0 A is not charging either');
  seedState(d, 'c1', { currentAmps: 10 });
  assert.strictEqual(d.getEmsChargeSessions(cfg)[0].charging, true);
});

test('getEmsChargeSessions — finished and running rows carry the same fields', () => {
  // Two builders would drift into two subtly different shapes, and the reader would meet a
  // list whose columns mean different things depending on the row.
  const d = makeChargerDevice({ _chargeSessions: [] });
  const cfg = { price_config: { mode: 'fixed', price_fixed: 0.30, currency: 'CHF' } };
  const charger = { id: 'c1', connected: true, rawPowerW: 7360, powerW: 7360 };
  for (let i = 0; i < 240; i++) d._trackChargeSession(charger, cfg, 15_000, 99999);
  const runningRow = d.getEmsChargeSessions(cfg)[0];
  d._trackChargeSession({ ...charger, connected: false, rawPowerW: 0, powerW: 0 }, cfg, 15_000, 99999);
  const finishedRow = d.getEmsChargeSessions(cfg)[0];

  // `running` and `charging` mark the live row; they are not columns of the table.
  const MARKERS = ['running', 'charging'];
  const keys = (o) => Object.keys(o).filter((k) => !MARKERS.includes(k)).sort();
  assert.deepStrictEqual(keys(runningRow), keys(finishedRow));
  assert.strictEqual(finishedRow.running, undefined);
  assert.strictEqual(finishedRow.charging, undefined);
  assert.strictEqual(runningRow.energyKwh, finishedRow.energyKwh, 'same energy, just now closed');
});

test('getEmsChargeSessions — returns newest first, capped, as shallow clones', () => {
  const d = makeChargerDevice({
    _chargeSessions: [
      { chargerId: 'c1', startedAt: 1, endedAt: 2, energyKwh: 1 },
      { chargerId: 'c1', startedAt: 3, endedAt: 4, energyKwh: 2 },
    ],
  });
  const out = d.getEmsChargeSessions();
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].energyKwh, 2); // newest first
  out[0].energyKwh = 999;
  assert.strictEqual(d._chargeSessions[1].energyKwh, 2); // clone, not a live reference
});

// ── widget: lib/ems/widget.js (ems-device / ems-battery widget backend) ─────
function makeWidgetDevice(extra = {}) {
  const dev = {
    log() {}, error() {},
    _chargerStates:      new Map(),
    _heatPumpStates:     new Map(),
    _boilerStates:       new Map(),
    _poolStates:         new Map(),
    _dehumidifierStates: new Map(),
    _airconStates: new Map(),
    _batteryStates:      new Map(),
    _carStates: [],
    homey: { clock: { getTimezone: () => 'Europe/Zurich' }, settings: { set() {} } },
    _cap: async () => null,
    _stopTick() {}, _startTick() {},
    _validateConfig() { return false; },
    _getConfig() { return {}; },
    getCapabilityValue() { return undefined; },
    setCapabilityValue: async () => {},
    _tick: async () => {},
    getStoreValue: async () => null,
    setStoreValue: async () => {},
  };
  Object.assign(dev, widgetMixin, chargerMixin, simpleDevicesMixin, batteryMixin, carsMixin, extra);
  return dev;
}

test('_trackSimpleDeviceDaily — accumulates kWh and runtime only while isOn', () => {
  const d = makeWidgetDevice();
  d._trackSimpleDeviceDaily([{ id: 'd1', powerW: 2000 }], new Map([['d1', { isOn: true }]]), 3600_000);
  assert.deepStrictEqual(d._simpleDeviceDaily('d1'), { kwh: 2, runtimeMs: 3600_000 });
});
test('_trackSimpleDeviceDaily — an off device accumulates nothing', () => {
  const d = makeWidgetDevice();
  d._trackSimpleDeviceDaily([{ id: 'd1', powerW: 2000 }], new Map([['d1', { isOn: false }]]), 3600_000);
  assert.deepStrictEqual(d._simpleDeviceDaily('d1'), { kwh: 0, runtimeMs: 0 });
});
test('_simpleDeviceDaily — resets once the stored date no longer matches today', () => {
  const d = makeWidgetDevice();
  d._simpleDailyStats = { d1: { date: '2000-01-01', kwh: 5, runtimeMs: 999 } };
  assert.deepStrictEqual(d._simpleDeviceDaily('d1'), { kwh: 0, runtimeMs: 0 });
});

test('_restoreSimpleDailyStats — loads today\'s stats back from the store', async () => {
  const stored = { d1: { date: '2099-01-01', kwh: 3.4, runtimeMs: 7200 } };
  const d = makeWidgetDevice({ getStoreValue: async () => stored });
  await d._restoreSimpleDailyStats();
  assert.deepStrictEqual(d._simpleDailyStats, stored);
});
test('_restoreSimpleDailyStats — starts empty when the store has nothing yet', async () => {
  const d = makeWidgetDevice({ getStoreValue: async () => null });
  await d._restoreSimpleDailyStats();
  assert.deepStrictEqual(d._simpleDailyStats, {});
});
test('_restoreSimpleDailyStats — a store read failure still leaves a usable empty object, no crash', async () => {
  const d = makeWidgetDevice({ getStoreValue: async () => { throw new Error('no store yet'); } });
  await d._restoreSimpleDailyStats();
  assert.deepStrictEqual(d._simpleDailyStats, {});
});
test('_saveSimpleDailyStats — persists the current in-memory stats to the store', () => {
  let saved = null;
  const d = makeWidgetDevice({ setStoreValue: async (key, val) => { saved = { key, val }; } });
  d._simpleDailyStats = { d1: { date: '2099-01-01', kwh: 1.2, runtimeMs: 60_000 } };
  d._saveSimpleDailyStats();
  assert.strictEqual(saved.key, 'simpleDailyStats');
  assert.deepStrictEqual(saved.val, d._simpleDailyStats);
});

test('getEmsControllableDevices — lists chargers and simple devices, resolving names via the API', async () => {
  const d = makeWidgetDevice({
    _getConfig: () => ({ chargers: [{ id: 'c1' }], heat_pump_devices: [{ id: 'h1' }] }),
    _api: { getDevices: async () => ({ c1: { id: 'c1', name: 'Carport' }, h1: { id: 'h1', name: 'Heat pump' } }) },
  });
  assert.deepStrictEqual(await d.getEmsControllableDevices(), [
    { id: 'c1', kind: 'charger', name: 'Carport' },
    { id: 'h1', kind: 'heat_pump', name: 'Heat pump' },
  ]);
});
test('getEmsControllableDevices — falls back to a truncated id when the local API is unavailable', async () => {
  const d = makeWidgetDevice({
    _getConfig: () => ({ chargers: [{ id: 'c1234567890' }] }),
    _api: { getDevices: async () => { throw new Error('no api key'); } },
  });
  const list = await d.getEmsControllableDevices();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, 'c1234567…');
});

test('_findControllable — finds charger and simple-device entries, null for an unknown id', () => {
  const d = makeWidgetDevice();
  const cfg = { chargers: [{ id: 'c1' }], boiler_devices: [{ id: 'b1' }] };
  assert.deepStrictEqual(d._findControllable(cfg, 'c1'), { kind: 'charger', entry: cfg.chargers[0] });
  assert.deepStrictEqual(d._findControllable(cfg, 'b1'), { kind: 'boiler', entry: cfg.boiler_devices[0] });
  assert.strictEqual(d._findControllable(cfg, 'nope'), null);
});

test('_isControllableEnabled — absent flag counts as enabled, false as disabled', () => {
  const d = makeWidgetDevice();
  const cfg = {
    chargers:       [{ id: 'c1' }, { id: 'c2', enabled: false }, { id: 'c3', enabled: true }],
    boiler_devices: [{ id: 'b1', enabled: false }],
  };
  assert.strictEqual(d._isControllableEnabled(cfg, 'c1'), true);  // opt-out
  assert.strictEqual(d._isControllableEnabled(cfg, 'c2'), false);
  assert.strictEqual(d._isControllableEnabled(cfg, 'c3'), true);
  assert.strictEqual(d._isControllableEnabled(cfg, 'b1'), false);
});
test('_isControllableEnabled — null for an unknown id, distinct from a disabled device', () => {
  const d = makeWidgetDevice();
  assert.strictEqual(d._isControllableEnabled({ chargers: [{ id: 'c1', enabled: false }] }, 'gone'), null);
});
test('_isControllableEnabled — agrees with how chargerControl filters', () => {
  const d = makeWidgetDevice();
  const chargers = [{ id: 'c1' }, { id: 'c2', enabled: false }, { id: 'c3', enabled: true }];
  const kept = chargers.filter((c) => c.enabled !== false).map((c) => c.id);
  const viaHelper = chargers.filter((c) => d._isControllableEnabled({ chargers }, c.id)).map((c) => c.id);
  assert.deepStrictEqual(viaHelper, kept);
});

test('_listControllables — lists chargers first, then the four simple classes', () => {
  const d = makeWidgetDevice();
  const cfg = {
    chargers:            [{ id: 'c1' }, { id: 'c2' }],
    heat_pump_devices:   [{ id: 'h1' }],
    boiler_devices:      [{ id: 'b1' }],
    pool_devices:        [{ id: 'p1' }],
    dehumidifier_devices:[{ id: 'd1' }],
    aircon_devices:      [{ id: 'a1' }],
  };
  assert.deepStrictEqual(d._listControllables(cfg), [
    { id: 'c1', kind: 'charger' }, { id: 'c2', kind: 'charger' },
    { id: 'h1', kind: 'heat_pump' }, { id: 'b1', kind: 'boiler' },
    { id: 'p1', kind: 'pool' }, { id: 'd1', kind: 'dehumidifier' },
    { id: 'a1', kind: 'aircon' },
  ]);
});
test('_listControllables — empty config yields an empty list', () => {
  const d = makeWidgetDevice();
  assert.deepStrictEqual(d._listControllables({}), []);
});
test('_listControllables — skips half-configured rows with no device picked', () => {
  const d = makeWidgetDevice();
  const cfg = { chargers: [{ id: '' }, { id: 'c2' }], pool_devices: [{}] };
  assert.deepStrictEqual(d._listControllables(cfg), [{ id: 'c2', kind: 'charger' }]);
});
test('_listControllables — every entry it offers can be resolved by _findControllable', () => {
  const d = makeWidgetDevice();
  const cfg = { chargers: [{ id: 'c1' }], heat_pump_devices: [{ id: 'h1' }], pool_devices: [{ id: 'p1' }] };
  for (const item of d._listControllables(cfg)) {
    const found = d._findControllable(cfg, item.id);
    assert.ok(found, `${item.id} offered but not resolvable`);
    assert.strictEqual(found.kind, item.kind);
  }
});

test('getEmsControllableStatus — charger kind reports live power, mode and an active session', async () => {
  const cfg = { chargers: [{ id: 'c1', charge_mode: 'solar_price', max_amps: 16, min_amps: 6, ev_phases: '1' }] };
  const d = makeWidgetDevice({
    _getConfig: () => cfg,
    // _getChargers lives directly on the EmsDevice class (device.js), not in a
    // mixin — stub it here the same way _getBattery is stubbed below.
    _getChargers: async ({ chargers }) => chargers.map((c) => ({
      id: c.id, connected: true, powerW: 3000, chargeMode: c.charge_mode,
    })),
    _api: { getDevice: async () => ({ name: 'Carport' }) },
    getCapabilityValue: (cap) => (cap === 'charge_now' ? true : undefined),
  });
  const st = d._getChargerState('c1');
  st.sessionActive = true; st.sessionStartedAt = Date.now() - 60_000; st.sessionEnergyKwh = 1.234;
  const status = await d.getEmsControllableStatus('c1');
  assert.strictEqual(status.kind, 'charger');
  assert.strictEqual(status.name, 'Carport');
  assert.strictEqual(status.connected, true);
  assert.strictEqual(status.chargeMode, 'solar_price');
  assert.strictEqual(status.chargeNow, true);
  assert.strictEqual(status.sessionEnergyKwh, 1.23);
  assert.strictEqual(status.carName, null);
  assert.strictEqual(status.enabled, true); // no enabled field in cfg → defaults to true
});
test('getEmsControllableStatus — charger kind passes through the assigned car\'s capacity and ready-by deadline', async () => {
  const cfg = { chargers: [{ id: 'c1', charge_mode: 'solar_price' }] };
  const d = makeWidgetDevice({
    _getConfig: () => cfg,
    _getChargers: async ({ chargers }) => chargers.map((c) => ({ id: c.id, connected: true, powerW: 7000, chargeMode: c.charge_mode })),
    _carStates: [{ id: 'car1', name: 'white Model 3', soc: 36, target: 100, capacityKwh: 75, readyBy: '07:00' }],
  });
  const status = await d.getEmsControllableStatus('c1');
  assert.strictEqual(status.carName, 'white Model 3');
  assert.strictEqual(status.carSoc, 36);
  assert.strictEqual(status.carTarget, 100);
  assert.strictEqual(status.carCapacityKwh, 75);
  assert.strictEqual(status.carReadyBy, '07:00');
});
test('getEmsControllableStatus — unknown id → not_found', async () => {
  const d = makeWidgetDevice({ _getConfig: () => ({ chargers: [] }) });
  assert.strictEqual((await d.getEmsControllableStatus('nope')).error, 'not_found');
});
test('getEmsControllableStatus — simple-device kind reports on/off, power and today\'s stats', async () => {
  const cfg = { boiler_devices: [{ id: 'b1', min_surplus_w: 1800, cap_power: 'measure_power' }] };
  const d = makeWidgetDevice({ _getConfig: () => cfg, _cap: async () => 1200 });
  d._boilerStates.set('b1', { isOn: true, startedAt: Date.now() - 120_000 });
  d._simpleDailyStats = { b1: { date: d._localDateStr(), kwh: 3.4, runtimeMs: 7_200_000 } };
  const status = await d.getEmsControllableStatus('b1');
  assert.strictEqual(status.kind, 'boiler');
  assert.strictEqual(status.isOn, true);
  assert.strictEqual(status.enabled, true);
  assert.strictEqual(status.powerW, 1200);
  assert.strictEqual(status.minSurplusW, 1800);
  assert.strictEqual(status.todayKwh, 3.4);
  assert.strictEqual(status.todayRuntimeMs, 7_200_000);
  assert.ok(status.runtimeMs >= 120_000);
});
test('getEmsControllableStatus — a disabled simple device reports isOn from the live capability, not the stale stateMap', async () => {
  // EMS never touches a disabled device's stateMap (simpleDevices.js skips it
  // entirely), so getEmsControllableStatus must fall back to device.actualOn —
  // here the real onoff capability (true) disagrees with the stale EMS
  // bookkeeping (isOn: false, from before the device was disabled).
  const cfg = { boiler_devices: [{ id: 'b1', enabled: false }] };
  const d = makeWidgetDevice({ _getConfig: () => cfg, _cap: async (id, cap) => (cap === 'onoff' ? true : null) });
  d._boilerStates.set('b1', { isOn: false, startedAt: null });
  const status = await d.getEmsControllableStatus('b1');
  assert.strictEqual(status.enabled, false);
  assert.strictEqual(status.isOn, true); // from device.actualOn, not the stale stateMap
});
test('getEmsControllableStatus — a disabled charger still reports enabled:false', async () => {
  const cfg = { chargers: [{ id: 'c1', enabled: false }] };
  const d = makeWidgetDevice({
    _getConfig: () => cfg,
    _getChargers: async ({ chargers }) => chargers.map((c) => ({ id: c.id, connected: false, powerW: 0, chargeMode: 'solar' })),
  });
  const status = await d.getEmsControllableStatus('c1');
  assert.strictEqual(status.enabled, false);
});

// Since 1.2.299 a widget change runs one tick instead of restarting the loop: a restart
// begins with a tick that only observes, so the change waited a whole interval and a mode
// that tick decided went without its trigger.
// powerW in the charger state is the control floor — amps × phases × 230 V while the EMS has
// set a current. The widget showed that as the car's draw: 6.9 kW, the bolt and a remaining
// time for a car taking nothing (1.2.299).
test('getEmsControllableStatus — a charger reports what it measures, not the control floor', async () => {
  const cfg = { chargers: [{ id: 'c1' }] };
  const d = makeWidgetDevice({
    _getConfig: () => cfg,
    _getChargers: async ({ chargers }) => chargers.map((c) => ({ id: c.id, connected: true, powerW: 6900, rawPowerW: 0, chargeMode: 'solar' })),
  });
  assert.strictEqual((await d.getEmsControllableStatus('c1')).powerW, 0);
});
test('setEmsDeviceEnabled — disables a charger, persists, and runs a tick (no restart)', async () => {
  const cfg = { chargers: [{ id: 'c1' }] };
  let saved = null, restarted = false, ticked = false;
  const d = makeWidgetDevice({
    _getConfig: () => cfg,
    homey: { settings: { set: (k, v) => { saved = v; } } },
    _startTick() { restarted = true; },
    _tick: async () => { ticked = true; },
  });
  const res = await d.setEmsDeviceEnabled('c1', false);
  assert.deepStrictEqual(res, { ok: true });
  assert.strictEqual(cfg.chargers[0].enabled, false);
  assert.strictEqual(saved, cfg);
  assert.strictEqual(ticked, true);
  assert.strictEqual(restarted, false, 'the loop restarted, and its first tick only observes');
});
test('setEmsDeviceEnabled — a missing or non-boolean flag is refused, nothing written', async () => {
  const cfg = { chargers: [{ id: 'c1' }] };
  let saved = null;
  const d = makeWidgetDevice({ _getConfig: () => cfg, homey: { settings: { set: (k, v) => { saved = v; } } } });
  for (const v of [undefined, null, 'false', 'true', 0, 1]) {
    assert.deepStrictEqual(await d.setEmsDeviceEnabled('c1', v), { error: 'invalid_value' }, String(v));
  }
  assert.strictEqual(cfg.chargers[0].enabled, undefined);
  assert.strictEqual(saved, null);
});
test('a widget change during a running tick waits for it instead of counting as a skip', async () => {
  const cfg = { chargers: [{ id: 'c1' }] };
  let ticked = false;
  const d = makeWidgetDevice({ _getConfig: () => cfg, _tick: async () => { ticked = true; } });
  d._tickInProgress = true;
  await d.setEmsDeviceEnabled('c1', true);
  assert.strictEqual(ticked, false);
});
test('setEmsDeviceEnabled — re-enables a simple device', async () => {
  const cfg = { boiler_devices: [{ id: 'b1', enabled: false }] };
  const d = makeWidgetDevice({ _getConfig: () => cfg, homey: { settings: { set() {} } } });
  const res = await d.setEmsDeviceEnabled('b1', true);
  assert.deepStrictEqual(res, { ok: true });
  assert.strictEqual(cfg.boiler_devices[0].enabled, true);
});
test('setEmsDeviceEnabled — leaves a leftover class-wide flag untouched', async () => {
  // Die Klassen-Flags sind seit 1.2.79 abgeschafft und werden beim Start migriert. Eine
  // noch nicht migrierte Konfiguration darf durch das Widget weder gelesen noch neu
  // geschrieben werden — sonst entstuende das alte Flag wieder.
  const cfg = { charger_control: false, chargers: [{ id: 'c1', enabled: false }] };
  const d = makeWidgetDevice({ _getConfig: () => cfg, homey: { settings: { set() {} } } });

  const res = await d.setEmsDeviceEnabled('c1', true);
  assert.deepStrictEqual(res, { ok: true });
  assert.strictEqual(cfg.chargers[0].enabled, true);
  assert.strictEqual(cfg.charger_control, false, 'das alte Flag darf nicht mehr veraendert werden');
});

test('setEmsDeviceEnabled — unknown device id → not_found', async () => {
  const d = makeWidgetDevice({ _getConfig: () => ({ chargers: [] }) });
  assert.strictEqual((await d.setEmsDeviceEnabled('nope', false)).error, 'not_found');
});

test('setEmsChargerMode — rejects an invalid mode without touching config', async () => {
  const cfg = { chargers: [{ id: 'c1', charge_mode: 'solar' }] };
  let saved = null;
  const d = makeWidgetDevice({ _getConfig: () => cfg, homey: { settings: { set: (k, v) => { saved = v; } } } });
  const res = await d.setEmsChargerMode('c1', 'bogus');
  assert.strictEqual(res.error, 'invalid_mode');
  assert.strictEqual(saved, null);
  assert.strictEqual(cfg.chargers[0].charge_mode, 'solar');
});
test('setEmsChargerMode — patches the mode, persists, and runs a tick (no restart)', async () => {
  const cfg = { chargers: [{ id: 'c1', charge_mode: 'solar' }] };
  let saved = null, restarted = false, ticked = false;
  const d = makeWidgetDevice({
    _getConfig: () => cfg,
    homey: { settings: { set: (k, v) => { saved = v; } } },
    _startTick() { restarted = true; },
    _tick: async () => { ticked = true; },
  });
  const res = await d.setEmsChargerMode('c1', 'always');
  assert.deepStrictEqual(res, { ok: true });
  assert.strictEqual(cfg.chargers[0].charge_mode, 'always');
  assert.strictEqual(saved, cfg);
  assert.strictEqual(ticked, true);
  assert.strictEqual(restarted, false);
});
test('setEmsChargerMode — unknown charger id → not_found', async () => {
  const d = makeWidgetDevice({ _getConfig: () => ({ chargers: [] }) });
  assert.strictEqual((await d.setEmsChargerMode('nope', 'solar')).error, 'not_found');
});

test('setEmsChargeNow — sets the device-wide charge_now capability and re-ticks', async () => {
  let capSet = null, ticked = false;
  const d = makeWidgetDevice({
    setCapabilityValue: async (cap, val) => { capSet = { cap, val }; },
    _tick: async () => { ticked = true; },
  });
  const res = await d.setEmsChargeNow(true);
  assert.deepStrictEqual(res, { ok: true });
  assert.deepStrictEqual(capSet, { cap: 'charge_now', val: true });
  assert.strictEqual(ticked, true);
});
test('setEmsChargeNow — coerces a truthy/falsy value to a real boolean', async () => {
  let capSet = null;
  const d = makeWidgetDevice({ setCapabilityValue: async (cap, val) => { capSet = val; } });
  await d.setEmsChargeNow(0);
  assert.strictEqual(capSet, false);
});
test('setEmsChargeNow — a capability write failure surfaces as an error, no crash', async () => {
  const d = makeWidgetDevice({ setCapabilityValue: async () => { throw new Error('not ready'); } });
  const res = await d.setEmsChargeNow(true);
  assert.strictEqual(res.error, 'not ready');
});

test('getEmsBatteryStatus — only red and green remain, plus the active price mode', async () => {
  const cfg = { min_battery_soc: 80, min_battery_soc_low: 40, battery_devices: [{ id: 'bat1', price_charge_enabled: true }] };
  const d = makeWidgetDevice({
    _getConfig: () => cfg,
    _getBattery: async () => ({ soc: 60, powerW: 500, socPerDevice: { bat1: 60 } }),
  });
  d._batteryStates.set('bat1', { priceMode: 'charge' });
  const status = await d.getEmsBatteryStatus();
  assert.strictEqual(status.hasBattery, true);
  assert.strictEqual(status.soc, 60);
  // 60 % sits above the 40 % hard stop, so it is simply green — the orange zone it used
  // to report no longer exists; the surplus ramp covers that range continuously.
  assert.strictEqual(status.zone, 'green');
  assert.strictEqual(status.priceEnabled, true);
  assert.strictEqual(status.priceMode, 'charge');
});
test('getEmsBatteryStatus — no battery configured', async () => {
  const d = makeWidgetDevice({
    _getConfig: () => ({}),
    _getBattery: async () => ({ soc: null, powerW: null, socPerDevice: {} }),
  });
  assert.strictEqual((await d.getEmsBatteryStatus()).hasBattery, false);
});

test('getEmsBatteryStatus — sums capacity_kwh across batteries and derives the current energy in kWh', async () => {
  const cfg = {
    min_battery_soc: 80,
    battery_devices: [{ id: 'bat1', capacity_kwh: 5 }, { id: 'bat2', capacity_kwh: 8.4 }],
  };
  const d = makeWidgetDevice({
    _getConfig: () => cfg,
    _getBattery: async () => ({ soc: 65, powerW: 0, socPerDevice: {} }),
  });
  const status = await d.getEmsBatteryStatus();
  assert.strictEqual(status.capacityKwh, 13.4);
  assert.strictEqual(status.energyKwh, 8.7); // 13.4 * 0.65 = 8.71 -> rounds to 8.7
});
test('getEmsBatteryStatus — no capacity configured → capacityKwh/energyKwh stay null', async () => {
  const cfg = { min_battery_soc: 80, battery_devices: [{ id: 'bat1' }] };
  const d = makeWidgetDevice({
    _getConfig: () => cfg,
    _getBattery: async () => ({ soc: 65, powerW: 0, socPerDevice: {} }),
  });
  const status = await d.getEmsBatteryStatus();
  assert.strictEqual(status.capacityKwh, null);
  assert.strictEqual(status.energyKwh, null);
});

// The stop field writes the setting _batteryZones actually reads (1.2.299). It used to
// write share_soc_low in every case: without a ramp that changed nothing, and with one a
// value at or above the upper point switched the ramp off and the stop fell to 80 %.
test('setEmsBatteryZones — with the ramp on, it moves the ramp\'s lower point', async () => {
  const cfg = { share_soc_low: 20, share_soc_high: 60 };
  let saved = null;
  const d = makeWidgetDevice({ _getConfig: () => cfg, homey: { settings: { set: (k, v) => { saved = v; } } } });
  const res = await d.setEmsBatteryZones({ stopSoc: 30 });
  assert.deepStrictEqual(res, { ok: true, stopSoc: 30 });
  assert.strictEqual(cfg.share_soc_low, 30);
  assert.strictEqual(saved, cfg);
});
test('setEmsBatteryZones — a value at or above the ramp\'s upper point is refused with the limit', async () => {
  const cfg = { share_soc_low: 20, share_soc_high: 60 };
  let saved = null;
  const d = makeWidgetDevice({ _getConfig: () => cfg, homey: { settings: { set: (k, v) => { saved = v; } } } });
  assert.deepStrictEqual(await d.setEmsBatteryZones({ stopSoc: 70 }), { error: 'above_ramp', max: 59 });
  assert.deepStrictEqual(await d.setEmsBatteryZones({ stopSoc: 60 }), { error: 'above_ramp', max: 59 });
  assert.strictEqual(cfg.share_soc_low, 20, 'the ramp was switched off');
  assert.strictEqual(saved, null);
});
test('setEmsBatteryZones — without a ramp it sets the one floor, and the stop follows', async () => {
  const cfg = { min_battery_soc: 80, min_battery_soc_low: 15 };
  const d = makeWidgetDevice({ _getConfig: () => cfg, homey: { settings: { set: () => {} } } });
  const res = await d.setEmsBatteryZones({ stopSoc: 30 });
  assert.deepStrictEqual(res, { ok: true, stopSoc: 30 });
  assert.strictEqual(cfg.min_battery_soc, 30);
  assert.strictEqual(cfg.min_battery_soc_low, 0, 'a reserve floor left behind would take over as the stop');
});
test('setEmsBatteryZones — anything but a number from 0 to 100 is refused', async () => {
  const cfg = { share_soc_low: 20, share_soc_high: 60 };
  const d = makeWidgetDevice({ _getConfig: () => cfg, homey: { settings: { set: () => {} } } });
  for (const v of [150, -1, 'abc', '', null, undefined]) {
    assert.deepStrictEqual(await d.setEmsBatteryZones({ stopSoc: v }), { error: 'invalid_value' }, String(v));
  }
  assert.strictEqual(cfg.share_soc_low, 20);
});
test('getEmsBatteryStatus — the old three-zone fields are gone from the payload', async () => {
  const d = makeWidgetDevice({
    _getConfig: () => ({ battery_devices: [{ id: 'b1' }], share_soc_low: 20, share_soc_high: 60 }),
    _getBattery: async () => ({ soc: 50, powerW: 0 }),
  });
  const s = await d.getEmsBatteryStatus();
  assert.ok(!('normalSoc' in s) && !('reserveSoc' in s));
  assert.strictEqual(s.stopSoc, 20);
});

// ── _buildPriorityRuns (Geräte-Priorität) ────────────────────────────────────
// Die Reihenfolge gilt seit 1.2.82 je Gerät statt je Geräteklasse. Entscheidend ist die
// Blockbildung: _evaluateEvChargers verteilt Überschuss zwischen ALLEN Ladern, die es in
// einem Aufruf bekommt — einzeln aufgerufen ginge das verloren.
// _buildPriorityRuns lebt im chargerControl-Mixin, weil die Blockbildung nur wegen der
// Ueberschussverteilung zwischen Ladern noetig ist.
function makePrioDevice() {
  return Object.assign({ log() {} }, chargerMixin);
}
const _prioSimple = (lists) => ({
  heat_pump:    { list: lists.heat_pump    || [] },
  boiler:       { list: lists.boiler       || [] },
  pool:         { list: lists.pool         || [] },
  dehumidifier: { list: lists.dehumidifier || [] },
  aircon: { list: lists.aircon || [] },
});

test('_buildPriorityRuns — adjacent chargers stay in ONE run so they keep sharing surplus', () => {
  const d = makePrioDevice();
  const runs = d._buildPriorityRuns(
    ['a', 'b', 'boil'],
    [{ id: 'a' }, { id: 'b' }],
    _prioSimple({ boiler: [{ id: 'boil' }] }),
  );
  assert.strictEqual(runs.length, 2);
  assert.strictEqual(runs[0].kind, 'charger');
  assert.deepStrictEqual(runs[0].list.map((x) => x.id), ['a', 'b'], 'beide Lader in einem Block');
  assert.strictEqual(runs[1].kind, 'boiler');
});

test('_buildPriorityRuns — chargers separated by another device are served one after the other', () => {
  const d = makePrioDevice();
  const runs = d._buildPriorityRuns(
    ['a', 'boil', 'b'],
    [{ id: 'a' }, { id: 'b' }],
    _prioSimple({ boiler: [{ id: 'boil' }] }),
  );
  assert.deepStrictEqual(runs.map((r) => r.kind), ['charger', 'boiler', 'charger']);
  assert.deepStrictEqual(runs[0].list.map((x) => x.id), ['a']);
  assert.deepStrictEqual(runs[2].list.map((x) => x.id), ['b']);
});

test('_buildPriorityRuns — a device missing from the order is appended, never dropped', () => {
  // Ein frisch hinzugefügtes Gerät steht noch in keiner gespeicherten Reihenfolge. Es darf
  // dadurch nicht ungesteuert bleiben — es rutscht ans Ende.
  const d = makePrioDevice();
  const runs = d._buildPriorityRuns(
    ['boil'],
    [{ id: 'neu' }],
    _prioSimple({ boiler: [{ id: 'boil' }] }),
  );
  assert.deepStrictEqual(runs.map((r) => r.kind), ['boiler', 'charger']);
  assert.deepStrictEqual(runs[1].list.map((x) => x.id), ['neu']);
});

test('_buildPriorityRuns — an id in the order that no longer exists is ignored', () => {
  const d = makePrioDevice();
  const runs = d._buildPriorityRuns(['weg', 'boil'], [], _prioSimple({ boiler: [{ id: 'boil' }] }));
  assert.deepStrictEqual(runs.map((r) => r.kind), ['boiler']);
});

test('_buildPriorityRuns — empty order falls back to configured order, nothing skipped', () => {
  const d = makePrioDevice();
  const runs = d._buildPriorityRuns([], [{ id: 'a' }], _prioSimple({ pool: [{ id: 'p' }] }));
  const ids = runs.flatMap((r) => r.list.map((x) => x.id));
  assert.deepStrictEqual(ids.sort(), ['a', 'p']);
});

// ── _runPriorityLoop (Budget-Weitergabe zwischen den Prioritätsblöcken) ──────────
// Die Reihenfolge allein entschiede nichts, wenn jeder Block denselben Überschuss sähe.
// Erst das Mitführen des schrumpfenden Budgets macht daraus eine Priorisierung.
// Vorzeichen wie überall im EMS: gridW negativ = Einspeisung, Verbrauch schiebt Richtung 0.
function makeLoopDevice(alloc = {}) {
  const d = Object.assign({ log() {} }, chargerMixin);
  d._seen = [];
  // The allowance sits in a different argument slot per kind: last for both, but the
  // charger evaluator takes seven parameters and the simple one nine.
  const record = (kind) => async (...args) => {
    const list = args[2];
    const key = list.map((x) => x.id).join(',');
    const allowanceW = kind === 'charger' ? args[6] : args[8];
    d._seen.push({ kind, key, gridW: args[1], allowanceW });
    return alloc[key] || 0;
  };
  d._evaluateEvChargers    = record('charger');
  d._evaluateSimpleDevices = record('simple');
  return d;
}
const _loopArgs = (d, order, chargers, simple, gridW) =>
  d._runPriorityLoop({ soc: 50 }, gridW, chargers, {}, null, null, order, simple);

test('_runPriorityLoop — each run sees the surplus the earlier runs left behind', async () => {
  const d = makeLoopDevice({ a: 2000 });
  const left = await _loopArgs(d, ['a', 'boil'], [{ id: 'a', powerW: 0 }],
    _prioSimple({ boiler: [{ id: 'boil' }] }), -5000);
  assert.strictEqual(d._seen[0].gridW, -5000);  // first in the order gets the full surplus
  assert.strictEqual(d._seen[1].gridW, -3000);  // second only what is left
  assert.strictEqual(left, -3000);
});

test('_runPriorityLoop — a charger claims only its DELTA, its running draw is already in gridW', async () => {
  const d = makeLoopDevice({ a: 5000 });
  await _loopArgs(d, ['a', 'boil'], [{ id: 'a', powerW: 3000 }],
    _prioSimple({ boiler: [{ id: 'boil' }] }), -5000);
  // 5000 granted − 3000 already drawn = 2000 newly claimed, not the full 5000
  assert.strictEqual(d._seen[1].gridW, -3000);
});

test('_runPriorityLoop — a charger stepping DOWN gives budget back to the next run', async () => {
  const d = makeLoopDevice({ a: 1000 });
  await _loopArgs(d, ['a', 'boil'], [{ id: 'a', powerW: 4000 }],
    _prioSimple({ boiler: [{ id: 'boil' }] }), -5000);
  assert.strictEqual(d._seen[1].gridW, -8000); // 3000 W released back into the budget
});

test('_runPriorityLoop — a run that allocates nothing leaves the budget untouched', async () => {
  const d = makeLoopDevice({});
  const left = await _loopArgs(d, ['a', 'boil'], [{ id: 'a', powerW: 0 }],
    _prioSimple({ boiler: [{ id: 'boil' }] }), -5000);
  assert.strictEqual(d._seen[1].gridW, -5000);
  assert.strictEqual(left, -5000);
});

test('_runPriorityLoop — a null budget stays null and is not turned into arithmetic', async () => {
  const d = makeLoopDevice({ a: 2000, boil: 1000 });
  const left = await _loopArgs(d, ['a', 'boil'], [{ id: 'a', powerW: 0 }],
    _prioSimple({ boiler: [{ id: 'boil' }] }), null);
  assert.strictEqual(d._seen[0].gridW, null);
  assert.strictEqual(d._seen[1].gridW, null); // NOT 2000 — no meter reading, no budget
  assert.strictEqual(left, null);
});

test('_runPriorityLoop — runs are served in the stored order, not the configured order', async () => {
  const d = makeLoopDevice({});
  await _loopArgs(d, ['boil', 'a'], [{ id: 'a', powerW: 0 }],
    _prioSimple({ boiler: [{ id: 'boil' }] }), -5000);
  assert.deepStrictEqual(d._seen.map((s) => s.key), ['boil', 'a']);
});

test('_runPriorityLoop — the budget shrinks across three runs in sequence', async () => {
  const d = makeLoopDevice({ a: 1000, boil: 1500, pl: 800 });
  const left = await _loopArgs(d, ['a', 'boil', 'pl'], [{ id: 'a', powerW: 0 }],
    _prioSimple({ boiler: [{ id: 'boil' }], pool: [{ id: 'pl' }] }), -5000);
  assert.deepStrictEqual(d._seen.map((s) => s.gridW), [-5000, -4000, -2500]);
  assert.strictEqual(left, -1700);
});

// The ramp's share is spent along the priority order, exactly as the surplus budget is.
// Without that, every run would see the full share and the ceiling would bound each device
// on its own instead of all of them together.
const _loopArgsA = (d, order, chargers, simple, gridW, allowanceW) =>
  d._runPriorityLoop({ soc: 50 }, gridW, chargers, {}, null, null, order, simple, allowanceW);

test('_runPriorityLoop — the ramp share is spent along the order, like the surplus', async () => {
  const d = makeLoopDevice({ a: 2000 });
  await _loopArgsA(d, ['a', 'boil'], [{ id: 'a', powerW: 0 }],
    _prioSimple({ boiler: [{ id: 'boil' }] }), -5000, 3000);
  assert.strictEqual(d._seen[0].allowanceW, 3000, 'the first run must see the whole share');
  assert.strictEqual(d._seen[1].allowanceW, 1000, 'the second run still saw the full share');
});

// A charger already running spent its part of the share before the tick began, so the share
// is reduced by what it was GRANTED, not by the delta it newly claimed.
test('_runPriorityLoop — a running charger spends its whole grant, not just its delta', async () => {
  const d = makeLoopDevice({ a: 2500 });
  await _loopArgsA(d, ['a', 'boil'], [{ id: 'a', powerW: 2000 }],
    _prioSimple({ boiler: [{ id: 'boil' }] }), -1000, 3000);
  assert.strictEqual(d._seen[1].allowanceW, 500, 'only the 500 W delta was charged to the share');
});

// Same for the on/off devices: a pool that started an hour ago has to cost the share its
// running draw, or the ceiling is blind to everything already on.
test('_runPriorityLoop — a simple device already running is charged to the share', async () => {
  const d = makeLoopDevice({});
  const states = new Map([['boil', { isOn: true }]]);
  const simple = { boiler: { list: [{ id: 'boil', powerW: 1800 }], states, start: 's', stop: 'x', arg: 'a' } };
  await _loopArgsA(d, ['boil', 'a'], [{ id: 'a', powerW: 0 }], simple, -5000, 3000);
  const chargerRun = d._seen.find((s) => s.kind === 'charger');
  assert.strictEqual(chargerRun.allowanceW, 1200, 'the running boiler cost the share nothing');
});

// A device with no power capability reports null; its configured minSurplusW stands in,
// because treating it as zero would let exactly the unmeasured devices slip past.
test('_runPriorityLoop — an unmeasured running device is charged at its configured need', async () => {
  const d = makeLoopDevice({});
  const states = new Map([['ac', { isOn: true }]]);
  const simple = { aircon: { list: [{ id: 'ac', powerW: null, minSurplusW: 1200 }], states, start: 's', stop: 'x', arg: 'a' } };
  await _loopArgsA(d, ['ac', 'a'], [{ id: 'a', powerW: 0 }], simple, -5000, 3000);
  assert.strictEqual(d._seen.find((s) => s.kind === 'charger').allowanceW, 1800);
});

test('_runPriorityLoop — with no ramp the allowance stays null all the way down', async () => {
  const d = makeLoopDevice({ a: 2000 });
  await _loopArgsA(d, ['a', 'boil'], [{ id: 'a', powerW: 0 }],
    _prioSimple({ boiler: [{ id: 'boil' }] }), -5000, null);
  assert.strictEqual(d._seen[0].allowanceW, null);
  assert.strictEqual(d._seen[1].allowanceW, null);
});

test('_runPriorityLoop — adjacent chargers share ONE budget deduction, not two', async () => {
  const d = makeLoopDevice({ 'a,b': 3000 });
  await _loopArgs(d, ['a', 'b', 'boil'], [{ id: 'a', powerW: 0 }, { id: 'b', powerW: 0 }],
    _prioSimple({ boiler: [{ id: 'boil' }] }), -5000);
  assert.strictEqual(d._seen.length, 2);       // one charger run, one boiler run
  assert.strictEqual(d._seen[1].gridW, -2000); // 3000 W total across both chargers
});


// ── Batterie-SOC-Rampe: prozentualer Anteil am Solarüberschuss ───────────────
// Ersetzt das feste Orange-Budget: je voller die Batterie, desto mehr des Überschusses
// dürfen die Geräte beanspruchen, der Rest lädt weiter. Nicht konfiguriert → null, damit
// die Aufrufer beim alten Zonenverhalten bleiben.
const RAMP = { share_soc_low: 80, share_soc_high: 95, share_pct_low: 20, share_pct_high: 100 };
function makeRampDevice() { return Object.assign({ log() {} }, batteryMixin); }

test('_batterySurplusShare — ramps linearly between the two SoC points', () => {
  const d = makeRampDevice();
  assert.strictEqual(d._batterySurplusShare(RAMP, 80), 0.2);
  assert.strictEqual(d._batterySurplusShare(RAMP, 95), 1);
  assert.ok(Math.abs(d._batterySurplusShare(RAMP, 87.5) - 0.6) < 1e-9); // Mitte
});
test('_batterySurplusShare — nothing below the lower point, clamped above the upper one', () => {
  // Bis 1.2.145 wurde nach unten auf pctLo geklemmt: bei SoC 28 und Untergrenze 50 kam
  // 20 % heraus. Diese Untergrenze IST aber der Hart-Stopp — _batteryZones leitet ihn
  // daraus ab — also sind dort ohnehin alle Geraete aus. Die Einstellungsseite las den
  // Wert zurueck und behauptete "Geraete erhalten 20 % der Erzeugung", direkt unter einer
  // Grafik, die "alles aus" zeichnete. Die Grafik hatte recht.
  const d = makeRampDevice();
  assert.strictEqual(d._batterySurplusShare(RAMP, 10), 0);     // weit unter der Untergrenze
  assert.strictEqual(d._batterySurplusShare(RAMP, 79.9), 0);   // knapp darunter
  assert.strictEqual(d._batterySurplusShare(RAMP, 80), 0.2);   // exakt auf der Untergrenze
  assert.strictEqual(d._batterySurplusShare(RAMP, 100), 1);    // über der Obergrenze
});
test('_batteryShareBudgetW — below the lower point no budget is handed out at all', () => {
  // Sonst weitet ein Budget den effektiven Ueberschuss fuer alles, was der Hart-Stopp
  // nicht erfasst — waehrend die Batterie eigentlich Vorrang haben soll.
  const d = makeRampDevice();
  assert.strictEqual(d._batteryShareBudgetW(RAMP, 28, 1592, -100), 0);
});
test('_batterySurplusShare — null when unconfigured or the SoC is unknown', () => {
  const d = makeRampDevice();
  assert.strictEqual(d._batterySurplusShare({}, 90), null);
  assert.strictEqual(d._batterySurplusShare(RAMP, null), null);
  // Obergrenze nicht über der Untergrenze → unbrauchbar, kein Durchrutschen auf 0
  assert.strictEqual(d._batterySurplusShare({ ...RAMP, share_soc_high: 80 }, 90), null);
});

test('_batteryShareBudgetW — the share applies to the PV output, not to what is left of it', () => {
  const d = makeRampDevice();
  // 6000 W Erzeugung, bei 95 % duerfen die Geraete 100 % davon. Gemessen wird 1000 W
  // Einspeisung — die restlichen 5000 W stecken in Hauslast und Batterie und sind genau
  // das Budget, das sich ein Geraet stattdessen holen darf.
  assert.strictEqual(d._batteryShareBudgetW(RAMP, 95, 6000, -1000), 5000);
});
test('_batteryShareBudgetW — a low SoC leaves most of the production to the battery', () => {
  const d = makeRampDevice();
  // 20 % von 6000 = 1200 W, davon sind 1000 W bereits Einspeisung → 200 W zusaetzlich
  assert.strictEqual(d._batteryShareBudgetW(RAMP, 80, 6000, -1000), 200);
});
test('_batteryShareBudgetW — never negative, so it can only ever add budget', () => {
  const d = makeRampDevice();
  assert.strictEqual(d._batteryShareBudgetW(RAMP, 80, 6000, -4000), 0);
});
test('_batteryShareBudgetW — no production yields no budget', () => {
  const d = makeRampDevice();
  assert.strictEqual(d._batteryShareBudgetW(RAMP, 95, 0, 500), 0);
});
test('_batteryShareBudgetW — null when a reading is missing, so nothing is guessed', () => {
  const d = makeRampDevice();
  assert.strictEqual(d._batteryShareBudgetW(RAMP, 90, null, -1000), null);
  assert.strictEqual(d._batteryShareBudgetW(RAMP, 90, 6000, null), null);
  assert.strictEqual(d._batteryShareBudgetW({}, 90, 6000, -1000), null); // Rampe aus
});

// Der Preisgrund darf nicht an der Einspeisung haengen: sobald die Begrenzung greift,
// drosselt der Wechselrichter und es wird nicht mehr eingespeist. Frueher fiel die Regel
// deshalb nach der Haltezeit ab und taktete im Fuenf-Minuten-Rhythmus.
test('_evaluateExportLimit — a low price holds the limit even once export has stopped', async () => {
  const d = makePriceExportDevice(-0.02, {
    _exportLimitActive: true, _exportLimitActivatedAt: Date.now() - EXPORT_LIMIT_HOLD_MS - 1000,
  });
  await d._evaluateExportLimit(PRICE_CFG, { soc: 40 }, 0); // gedrosselt: keine Einspeisung mehr
  assert.strictEqual(d._exportLimitActive, true);
  assert.deepStrictEqual(d._fired, []);
});
test('_evaluateExportLimit — the SoC reason still releases when export stops', async () => {
  const d = makeExportDevice({
    _exportLimitActive: true, _exportLimitActivatedAt: Date.now() - EXPORT_LIMIT_HOLD_MS - 1000,
  });
  await d._evaluateExportLimit(EXPORT_CFG, { soc: 99 }, 0); // Batterie voll, aber keine Einspeisung
  assert.strictEqual(d._exportLimitActive, false);
  assert.deepStrictEqual(d._fired, ['ems_inverter_export_limit_off']);
});

// ── Ladesessions: Aufteilung PV / Netzbezug ─────────────────────────────────
// Der Lader gilt als Grenzlast: Was das Haus gerade importiert, wird zuerst ihm
// zugeschrieben, hoechstens bis zu seinem eigenen Bezug. Nur dieser Teil kostet.
test('_trackChargeSession — pure solar charging costs nothing and is 100 % PV', () => {
  const d = makeChargerDevice({ _chargeSessions: [] });
  const cfg = { price_config: { mode: 'fixed', price_fixed: 0.30, currency: 'CHF' } };
  const charger = { id: 'c1', connected: true, rawPowerW: 4000, powerW: 4000 };
  for (let i = 0; i < 240; i++) d._trackChargeSession(charger, cfg, 15_000, -2000); // exporting
  d._trackChargeSession({ id: 'c1', connected: false, rawPowerW: 0, powerW: 0 }, cfg, 15_000, -2000);
  const s = d._chargeSessions[0];
  assert.strictEqual(s.gridKwh, 0);
  assert.strictEqual(s.pvShare, 100);
  assert.strictEqual(s.cost, null);       // nothing was bought
});
test('_trackChargeSession — import beyond the charger draw is not charged to the car', () => {
  const d = makeChargerDevice({ _chargeSessions: [] });
  const cfg = { price_config: { mode: 'fixed', price_fixed: 0.30, currency: 'CHF' } };
  const charger = { id: 'c1', connected: true, rawPowerW: 2000, powerW: 2000 };
  // House imports 5 kW while the charger draws 2 kW: at most its own 2 kW are its doing.
  for (let i = 0; i < 240; i++) d._trackChargeSession(charger, cfg, 15_000, 5000);
  d._trackChargeSession({ id: 'c1', connected: false, rawPowerW: 0, powerW: 0 }, cfg, 15_000, 5000);
  const s = d._chargeSessions[0];
  assert.strictEqual(s.energyKwh, 2);
  assert.strictEqual(s.gridKwh, 2);       // capped at its own draw, not the 5 kW import
  assert.strictEqual(s.pvShare, 0);
  assert.strictEqual(s.cost, 0.6);        // 2 kWh x 0.30
});
test('_trackChargeSession — a half-covered session splits and bills only the grid part', () => {
  const d = makeChargerDevice({ _chargeSessions: [] });
  const cfg = { price_config: { mode: 'fixed', price_fixed: 0.30, currency: 'CHF' } };
  const charger = { id: 'c1', connected: true, rawPowerW: 4000, powerW: 4000 };
  for (let i = 0; i < 240; i++) d._trackChargeSession(charger, cfg, 15_000, 2000); // half imported
  d._trackChargeSession({ id: 'c1', connected: false, rawPowerW: 0, powerW: 0 }, cfg, 15_000, 2000);
  const s = d._chargeSessions[0];
  assert.strictEqual(s.energyKwh, 4);
  assert.strictEqual(s.gridKwh, 2);
  assert.strictEqual(s.pvKwh, 2);
  assert.strictEqual(s.pvShare, 50);
  assert.strictEqual(s.cost, 0.6);        // only the 2 kWh from the grid
});

// ── history: tick-overrun accounting ─────────────────────────────────────────
// Ein uebersprungener Tick verschwand spurlos: der Waechter kehrte zurueck und nichts
// zaehlte ihn. Genau das versteckt der gleitende Mittelwert — ein einzelner 12-Sekunden-
// Tick bewegt eine EMA mit 0.8/0.2 kaum, kostet die Regelschleife aber einen Durchlauf.
function makeSkipDevice() {
  const d = {
    log() {},
    _notified: [],
    _diag: { tickSkipped: 0, avgTickMs: 400, maxTickMs: 9000 },
    getSetting: () => true,          // Zeitleisten-Meldungen aktiviert
    homey: { notifications: { createNotification: () => Promise.resolve() } },
  };
  Object.assign(d, historyMixin);
  d._postNotification = function (msg) { this._notified.push(msg); };
  return d;
}

test('_noteTickSkip — counts every skip, warns only on the second in a row', () => {
  const d = makeSkipDevice();
  assert.strictEqual(d._noteTickSkip(15000), false);
  assert.strictEqual(d._diag.tickSkipped, 1);
  assert.deepStrictEqual(d._notified, [], 'ein einzelner Aussetzer ist ein langsamer Tick, kein Alarm');

  assert.strictEqual(d._noteTickSkip(15000), true);
  assert.strictEqual(d._diag.tickSkipped, 2);
  assert.strictEqual(d._notified.length, 1);
  assert.match(d._notified[0], /9000 ms/, 'die Meldung nennt den laengsten Tick, nicht den Mittelwert');
});

test('_noteTickSkip — the warning is throttled to once an hour', () => {
  const d = makeSkipDevice();
  const t0 = Date.now();
  d._noteTickSkip(15000, t0);
  d._noteTickSkip(15000, t0);                    // meldet
  d._consecSkips = 1;                            // naechster Aussetzer waere wieder der zweite
  assert.strictEqual(d._noteTickSkip(15000, t0 + 59 * 60_000), false, 'innerhalb der Stunde still');
  d._consecSkips = 1;
  assert.strictEqual(d._noteTickSkip(15000, t0 + 61 * 60_000), true, 'danach wieder');
  assert.strictEqual(d._diag.tickSkipped, 4, 'gezaehlt wird jeder Aussetzer, auch der stille');
});

// ── dtMs = 0 auf dem allerersten Tick ────────────────────────────────────────
// Seit die verstrichene Zeit gemessen statt angenommen wird, ist sie auf dem ersten Tick
// null — es wurde noch kein Intervall beobachtet. Beide Verbraucher muessen das
// aushalten, ohne etwas zu buchen; eine Division durch dt gaebe hier Unendlich.
test('_trackSimpleDeviceDaily — a zero dt books no runtime and no energy', () => {
  const d = {};
  Object.assign(d, widgetMixin);
  d._localDateStr = () => '20260810';   // nach dem Mixin: sonst gewinnt dessen Variante
  const states = new Map([['x1', { isOn: true }]]);
  d._trackSimpleDeviceDaily([{ id: 'x1', powerW: 2000 }], states, 0);
  const rec = d._simpleDeviceDaily('x1');
  assert.strictEqual(rec.runtimeMs, 0);
  assert.strictEqual(rec.kwh, 0);
});

test('_trackSimpleDeviceDaily — a measured gap books exactly that gap', () => {
  // Gegenprobe: ein uebersprungener Tick liefert 30 s statt 15 s, und genau die muessen
  // ankommen. Vorher wurde stur TICK_MS gebucht, also die Haelfte.
  const d = {};
  Object.assign(d, widgetMixin);
  d._localDateStr = () => '20260810';   // nach dem Mixin: sonst gewinnt dessen Variante
  const states = new Map([['x1', { isOn: true }]]);
  d._trackSimpleDeviceDaily([{ id: 'x1', powerW: 2000 }], states, 30_000);
  const rec = d._simpleDeviceDaily('x1');
  assert.strictEqual(rec.runtimeMs, 30_000);
  assert.strictEqual(rec.kwh, 0.02);   // 2000 W x 30 s = 16.67 Wh, gerundet auf 2 Stellen
});

// ── _stepCharger: steer by the meter, not by our own memory ──────────────────
// st.currentAmps records what the EMS last COMMANDED, and _chargerStop clears it the
// moment the command is sent — not when it lands. Two field failures came from trusting
// it: a session started outside the EMS was never regulated or stopped, and a stop the
// charger ignored looked stopped forever, because the stop path is guarded by `cur > 0`.
// Reported 2026-08-15: history said "Lader gestoppt" at 19:43, the house battery was
// still giving up 3002 W a minute later, and no further stop was ever attempted.

// A charger the EMS believes is idle, but which is drawing 3 kW.
const DRAWING_1PH = { ...CHARGER_1PH, powerW: 3000 };

function stepDevice(extra = {}) {
  const d = makeChargerDevice(extra);
  d.stops = [];
  d._chargerStop = async (id) => {
    d.stops.push(id);
    const st = d._getChargerState(id);
    st.currentAmps = null; st.currentPhases = null;   // as the real one does
  };
  d.sets = [];
  d._chargerSetAmps = async (id, amps, phases) => {
    d.sets.push({ id, amps, phases });
    const st = d._getChargerState(id);
    st.currentAmps = amps; st.currentPhases = phases;
  };
  return d;
}

test('_stepCharger — a charger drawing without an EMS command is stopped, not ignored', async () => {
  const d = stepDevice();
  // No state at all: the EMS never started this session.
  const r = await d._stepCharger(DRAWING_1PH, 0, 1, Date.now(), 0, false);
  assert.deepStrictEqual(d.stops, ['c1'], 'a stop must be issued for power we did not ask for');
  assert.strictEqual(r.allocatedW, 0);
});

test('_stepCharger — a stop that did not take is retried on the next tick', async () => {
  const d = stepDevice();
  const now = Date.now();
  // Tick 1: adopt and stop. The real _chargerStop clears currentAmps, so before the fix
  // `cur` was 0 from here on and no further stop was ever sent.
  await d._stepCharger(DRAWING_1PH, 0, 1, now, 0, false);
  // Tick 2 and 3: the car is still drawing, so the command plainly did not land.
  await d._stepCharger(DRAWING_1PH, 0, 1, now + 20000, 0, false);
  await d._stepCharger(DRAWING_1PH, 0, 1, now + 40000, 0, false);
  assert.strictEqual(d.stops.length, 3, 'the stop must be repeated while the draw continues');
});

test('_stepCharger — repeated failed stops are reported once, not on every tick', async () => {
  const { CHARGER_STOP_WARN_TICKS } = require('../lib/ems/constants');
  const events = [];
  const d = stepDevice({ _addHistoryEvent: (type, event, label, id) => events.push({ event, label, id }) });
  const now = Date.now();
  for (let i = 0; i < CHARGER_STOP_WARN_TICKS + 4; i++) {
    await d._stepCharger(DRAWING_1PH, 0, 1, now + i * 20000, 0, false);
  }
  const warned = events.filter((e) => e.event === 'stop_ineffective');
  assert.strictEqual(warned.length, 1, 'exactly one "not reaching it" entry, however long it lasts');
  assert.strictEqual(warned[0].id, 'c1');
  assert.match(warned[0].label, /^3000W$/);
});

test('_stepCharger — an adopted session is regulated down when there IS budget', async () => {
  // Adoption is not only about stopping: with surplus available the session should be
  // steered like any other, rather than left to run at whatever it chose.
  const d = stepDevice();
  const now = Date.now();
  // 3000 W drawn ≈ 13 A on one phase; a budget of 1400 W only affords 6 A.
  await d._stepCharger(DRAWING_1PH, 1400, 1, now, 0, false);
  assert.strictEqual(d.stops.length, 0, 'must not stop while a rung still fits');
  assert.deepStrictEqual(d.sets.map((s) => s.amps), [6], 'stepped down to the affordable rung');
});

test('_stepCharger — a charger that is genuinely idle stays untouched', async () => {
  const d = stepDevice();
  const idle = { ...CHARGER_1PH, powerW: 120 };   // powered on, not charging
  const r = await d._stepCharger(idle, 0, 1, Date.now(), 0, false);
  assert.deepStrictEqual(d.stops, [], 'no command for a charger that is not drawing');
  assert.deepStrictEqual(d.sets, []);
  assert.strictEqual(r.allocatedW, 0);
});

test('_stepCharger — the uncommanded counter resets once the draw actually stops', async () => {
  const { CHARGER_STOP_WARN_TICKS } = require('../lib/ems/constants');
  const events = [];
  const d = stepDevice({ _addHistoryEvent: (type, event, label, id) => events.push({ event }) });
  const now = Date.now();
  for (let i = 0; i < CHARGER_STOP_WARN_TICKS; i++) {
    await d._stepCharger(DRAWING_1PH, 0, 1, now + i * 20000, 0, false);
  }
  assert.strictEqual(events.filter((e) => e.event === 'stop_ineffective').length, 1);
  // It finally stops. A later, separate episode must be able to warn again.
  await d._stepCharger({ ...CHARGER_1PH, powerW: 0 }, 0, 1, now + 200000, 0, false);
  for (let i = 0; i < CHARGER_STOP_WARN_TICKS; i++) {
    await d._stepCharger(DRAWING_1PH, 0, 1, now + 300000 + i * 20000, 0, false);
  }
  assert.strictEqual(events.filter((e) => e.event === 'stop_ineffective').length, 2,
    'a second outage is a second story');
});

test('_stepCharger — after an app restart a running session is picked up at its real amps', async () => {
  // The reported case, 2026-08-15: the charger was started at 09:52 with 7A/3ph, the app
  // was restarted (four deploys that morning), and _chargerStates — which lives only in
  // memory — came back empty. The session kept running, invisible to the EMS, and the
  // house battery covered it. Re-deriving the rung from measured power is what makes a
  // restart survivable without persisting anything.
  const d = stepDevice();
  const charger3ph = { id: 'c1', connected: true, minAmps: 6, maxAmps: 32, phases: 3, phaseSwitch: false,
    powerW: 7 * 3 * 230 };                                  // 4830 W — exactly 7A on three phases
  assert.strictEqual(d._getChargerState('c1').currentAmps, null, 'fresh state, as after a restart');

  // Plenty of surplus: it should be recognised and left running, not stopped.
  const r = await d._stepCharger(charger3ph, 6000, 3, Date.now(), -3000, false);
  assert.strictEqual(d._getChargerState('c1').currentAmps, 7, 'adopted at the amps it is actually drawing');
  assert.strictEqual(d.stops.length, 0, 'a session with budget must not be killed by the restart');
  assert.strictEqual(r.allocatedW, 7 * 3 * 230, 'and its power is counted against the budget again');
});

// ── _settleWithin: the loop must not block on a user's flows ─────────────────
// Field evidence 2026-08-15: one tick ran 300 s against a 238 ms average and skipped 15
// intervals. For those five minutes the EMS controlled nothing — it neither turned the
// car down nor stopped it. Every other await in a tick is bounded (the local-API client
// aborts at 8 s); a flow trigger is not, because what runs behind it is the user's flows.
function timingDevice() {
  const d = { logs: [], log: (m) => d.logs.push(m) };
  d.homey = { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };
  Object.assign(d, timingMixin);
  return d;
}

// The same budget on the simple devices, which had none until 1.2.174. This owner's
// air-conditioning stop flow deliberately waits five minutes before cutting the unit, and
// the EMS stood next to it for all five: a 33-hour field log showed five aircon stops and
// five tick overruns, each exactly 40 s after its stop, five for five, and no other
// device's trigger ever produced one.
//
// Trigger promise never settles; homey.setTimeout fires at once but records the budget it
// was asked for, so the test is instant and still pins the number.
function stuckFlowDevice(extra = {}) {
  const d = {
    logs: [], budgets: [], log: (m) => d.logs.push(m),
    _warmupDone: true, _postNotification() {}, _addHistoryEvent() {},
    homey: {
      flow: { getTriggerCard: () => ({ trigger: () => new Promise(() => {}) }) },
      setTimeout: (fn, ms) => { d.budgets.push(ms); return setTimeout(fn, 0); },
      clearTimeout: (t) => clearTimeout(t),
    },
  };
  // Same companion mixins as makeSimpleDevice — _evaluateSimpleDevices reaches for
  // _batteryZones and _forecastGateBlocksStarts through `this`.
  Object.assign(d, simpleDevicesMixin, batteryMixin, pvForecastMixin, chargerMixin, timingMixin, extra);
  return d;
}

// The test does its own timekeeping rather than awaiting the call outright: an unbounded
// await on a promise that never settles HANGS, and a hung test only turns red if the runner
// was given --test-timeout. Racing it here means the guard's removal fails the suite in
// 200 ms under a plain `node --test`.
function mustNotBlock(promise, label) {
  return Promise.race([
    promise.then(() => 'returned'),
    new Promise((r) => setTimeout(() => r(`still waiting on ${label}`), 200)),
  ]);
}

test('_simpleDeviceSetOn — a flow that takes five minutes does not take the tick with it', async () => {
  const d = stuckFlowDevice();
  const map = new Map([['a1', { isOn: true, startedAt: Date.now() - 600_000 }]]);
  const outcome = await mustNotBlock(
    d._simpleDeviceSetOn('a1', 'Klima', false, map, 'ems_start_aircon', 'ems_stop_aircon', 'aircon_device_id'),
    'the aircon stop flow');
  assert.strictEqual(outcome, 'returned');
  assert.deepStrictEqual(d.budgets, [TRIGGER_BUDGET_MS]);
  assert.match(d.logs.join('\n'), /aircon_device_id a1 stop: no answer within 3000 ms/);
});

test('_simpleDeviceSetOn — giving up on the flow does not undo the decision', async () => {
  // st.isOn is set before the trigger and must stay set: the EMS decided, the flow is
  // merely how the decision travels. Re-deciding on a slow flow would restart the timers.
  const d = stuckFlowDevice();
  const map = new Map([['a1', { isOn: true, startedAt: 1 }]]);
  const outcome = await mustNotBlock(
    d._simpleDeviceSetOn('a1', 'Klima', false, map, 'ems_start_aircon', 'ems_stop_aircon', 'aircon_device_id'),
    'the aircon stop flow');
  assert.strictEqual(outcome, 'returned');
  assert.strictEqual(map.get('a1').isOn, false);
  assert.strictEqual(map.get('a1').startedAt, null);
  assert.ok(map.get('a1').lastEmsStopAt > 0);
});

test('_evaluateSimpleDevices — the power-mode adoption stop is bounded too', async () => {
  // The other unbounded trigger: when a power-based device is found off, the EMS commands
  // the switch off as well. Fires often — every heat-pump adoption in the field log.
  const d = stuckFlowDevice();
  const state = new Map([['d1', { isOn: true, startedAt: Date.now() - 600_000, externalOn: false }]]);
  const dev = simpleDev({ actualOn: false, powerW: 0, stateSource: 'power', startupGraceMs: 0 });
  const outcome = await mustNotBlock(
    d._evaluateSimpleDevices({ soc: 80, powerW: 0 }, -5000, [dev], state,
      'ems_start_heat_pump', 'ems_stop_heat_pump', 'heat_pump_device_id', {}),
    'the adoption stop flow');
  assert.strictEqual(outcome, 'returned');
  assert.match(d.logs.join('\n'), /adoption stop: no answer within 3000 ms/);
  assert.strictEqual(state.get('d1').isOn, false, 'the adoption stands');
});

test('_chargerSetAmps — the amps command is bounded too', async () => {
  // The most frequent trigger in the app, and the last of the charger's three to get a
  // budget: start and stop got theirs in July, this one was missed.
  // The fake fires the budget timer at once but records the value it was asked for. Both
  // halves are needed: the race below catches the guard being deleted, the recorded budget
  // catches it being widened to something useless.
  const logs = []; const budgets = [];
  const d = makeChargerDevice({
    log: (m) => logs.push(m),
    homey: {
      flow: { getTriggerCard: () => ({ trigger: () => new Promise(() => {}) }) },
      clock: { getTimezone: () => 'Europe/Zurich' },
      setTimeout: (fn, ms) => { budgets.push(ms); return setTimeout(fn, 0); },
      clearTimeout: (t) => clearTimeout(t),
    },
  });
  seedState(d, 'c1', { currentAmps: 10, currentPhases: 3 });
  const outcome = await mustNotBlock(d._chargerSetAmps('c1', 12, 3), 'the set-current flow');
  assert.strictEqual(outcome, 'returned');
  assert.deepStrictEqual(budgets, [TRIGGER_BUDGET_MS]);
  assert.strictEqual(d._getChargerState('c1').currentAmps, 12,
    'the EMS commanded 12 A and must reason from that next tick, answered or not');
  assert.match(logs.join('\n'), /charger c1 set 12A: no answer within/);
});

test('_fireExportLimitTrigger — bounded per inverter', async () => {
  // A loop on the tick path: without a budget a multi-inverter install waits out one slow
  // flow after another.
  const logs = []; const budgets = [];
  const d = {
    log: (m) => logs.push(m),
    homey: {
      flow: { getTriggerCard: () => ({ trigger: () => new Promise(() => {}) }) },
      setTimeout: (fn, ms) => { budgets.push(ms); return setTimeout(fn, 0); },
      clearTimeout: (t) => clearTimeout(t),
    },
  };
  Object.assign(d, exportLimitMixin, timingMixin);
  const cfg = { inverter_devices: [{ id: 'inv1' }, { id: 'inv2' }] };
  const outcome = await mustNotBlock(
    d._fireExportLimitTrigger(cfg, 'ems_inverter_export_limit_on', 'on'), 'the inverter flows');
  assert.strictEqual(outcome, 'returned');
  assert.deepStrictEqual(budgets, [TRIGGER_BUDGET_MS, TRIGGER_BUDGET_MS], 'one per inverter');
  assert.strictEqual(logs.filter((l) => /no answer within/.test(l)).length, 2, 'both inverters');
});

test('_settleWithin — a prompt promise is awaited normally and its value passed through', async () => {
  const d = timingDevice();
  const r = await d._settleWithin(Promise.resolve('done'), 1000, 'x');
  assert.strictEqual(r, 'done');
  assert.deepStrictEqual(d.logs, [], 'nothing to report when it answers in time');
});

test('_settleWithin — a promise that never settles gives up after the budget', async () => {
  const d = timingDevice();
  const t0 = Date.now();
  await d._settleWithin(new Promise(() => {}), 60, 'charger c1 stop');
  const waited = Date.now() - t0;
  assert.ok(waited < 1000, `must not block: waited ${waited} ms`);
  assert.match(d.logs.join('\n'), /charger c1 stop: no answer within 60 ms/);
});

test('_settleWithin — a rejection still propagates, it is not swallowed by the race', async () => {
  const d = timingDevice();
  await assert.rejects(() => d._settleWithin(Promise.reject(new Error('flow blew up')), 1000, 'x'),
    /flow blew up/);
});

test('_settleWithin — the timer is cleared when the promise wins, leaving nothing pending', async () => {
  const d = timingDevice();
  const cleared = [];
  d.homey.clearTimeout = (t) => { cleared.push(t); clearTimeout(t); };
  await d._settleWithin(Promise.resolve(1), 5000, 'x');
  assert.strictEqual(cleared.length, 1, 'a 5 s timer left armed would keep the process awake');
});

test('_chargerStop — a flow that never answers costs the budget, not the tick', async () => {
  // The whole point: _chargerStop awaits the trigger. Before the budget, a flow stuck on a
  // queued Modbus write held the control loop for as long as it took.
  const { TRIGGER_BUDGET_MS } = require('../lib/ems/constants');
  const d = makeChargerDevice({
    homey: {
      flow: { getTriggerCard: () => ({ trigger: () => new Promise(() => {}) }) },  // never settles
      clock: { getTimezone: () => 'UTC' },
      setTimeout: (f, ms) => setTimeout(f, Math.min(ms, 50)),   // compress the budget for the test
      clearTimeout: (t) => clearTimeout(t),
    },
  });
  const t0 = Date.now();
  await d._chargerStop('c1');
  const waited = Date.now() - t0;
  assert.ok(waited < 1000, `the loop must come back: waited ${waited} ms`);
  assert.strictEqual(d._getChargerState('c1').currentAmps, null, 'and the state is still updated');
  assert.ok(TRIGGER_BUDGET_MS > 0 && TRIGGER_BUDGET_MS <= 10000, 'budget is a sane fraction of a tick');
});

// ── the overrun message must describe the tick that is overrunning ───────────
test('_noteTickSkip — reports the running tick, not the statistics of finished ones', async () => {
  const d = {
    logs: [], log: (m) => d.logs.push(m),
    _diag: { tickSkipped: 0, avgTickMs: 238, maxTickMs: 1755 },
    _tickStartedAt: Date.now() - 300_000,     // the five-minute tick, still running
    _tickPhase: 'devices',
    getSetting: () => false,
  };
  Object.assign(d, historyMixin);
  d._noteTickSkip(20000);
  d._noteTickSkip(20000);                     // the warning fires on the second
  const line = d.logs.find((l) => l.includes('tick overrun'));
  assert.ok(line, d.logs.join(' | '));
  assert.match(line, /running 300s/, 'the guilty tick must name its own elapsed time');
  assert.match(line, /phase "devices"/, 'and where it is stuck');
  assert.doesNotMatch(line, /max 1755/, 'max describes finished ticks and misled us for hours');
});

// ── the battery announcement thresholds follow the ramp ──────────────────────
// They were min_battery_soc / battery_full_soc, whose input fields went away with the SOC
// zones in 1.2.108 — leaving the `?? 80` and `?? 95` defaults firing from nowhere. On a
// system whose hard stop is at 50 %, "53% < 80% — Batterie tief" reads like a limit that
// stops something, and the owner asked what it governed. Nothing.
test('_batteryAnnounceThresholds — a configured ramp supplies both points', () => {
  const d = makeDevice();
  const t = d._batteryAnnounceThresholds({ share_soc_low: 50, share_soc_high: 100 });
  assert.deepStrictEqual(t, { lowSoc: 50, fullSoc: 100, source: 'ramp' });
});

test('_batteryAnnounceThresholds — the ramp beats the old fields, not the other way round', () => {
  // A stale min_battery_soc left in ems_config must not win over the visible setting.
  const d = makeDevice();
  const t = d._batteryAnnounceThresholds({
    share_soc_low: 50, share_soc_high: 100, min_battery_soc: 80, battery_full_soc: 95,
  });
  assert.strictEqual(t.lowSoc, 50);
  assert.strictEqual(t.fullSoc, 100);
});

test('_batteryAnnounceThresholds — without a ramp nothing moves', () => {
  // Installations that never configured one keep the figures they have been firing at.
  const d = makeDevice();
  assert.deepStrictEqual(d._batteryAnnounceThresholds({}), { lowSoc: 80, fullSoc: 95, source: 'legacy' });
  assert.deepStrictEqual(d._batteryAnnounceThresholds({ min_battery_soc: 70, battery_full_soc: 90 }),
    { lowSoc: 70, fullSoc: 90, source: 'legacy' });
});

test('_batteryAnnounceThresholds — an incomplete ramp is not a ramp', () => {
  // Only the lower point set, or the two inverted: _batterySurplusShare returns null for
  // both, so the announcements must not follow half a setting either.
  const d = makeDevice();
  assert.strictEqual(d._batteryAnnounceThresholds({ share_soc_low: 50 }).source, 'legacy');
  assert.strictEqual(d._batteryAnnounceThresholds({ share_soc_low: 90, share_soc_high: 50 }).source, 'legacy');
});

test('_batteryAnnounceThresholds — agrees with the hard stop _batteryZones derives', () => {
  // "Battery low" now means "every device just stopped". If these two ever disagree, the
  // announcement is back to describing something that does not happen.
  const cfg = { share_soc_low: 50, share_soc_high: 100, share_pct_low: 0, share_pct_high: 100 };
  const d = makeDevice();
  assert.strictEqual(d._batteryAnnounceThresholds(cfg).lowSoc,
    d._batteryZones(cfg, { soc: 60 }).minSoc);
});

// ── Tageszähler für ein Gerät ausserhalb der EMS-Steuerung ───────────────────
// Aus dem Feld-Export vom 12.09.2026: ein Pool mit enabled:false, dessen Zustandseintrag
// seit dem letzten App-Start auf isOn:true stand. Die Zähler beschreiben das GERÄT, nicht
// die Entscheidung — sie zählen also weiter, aber aus dem Messwert statt aus dem Glauben,
// der für dieses Gerät nicht mehr nachgeführt wird.

test('_trackSimpleDeviceDaily — ein Gerät ohne EMS-Steuerung zählt nach Messwert, nicht nach Glauben', () => {
  const d = makeWidgetDevice();
  d._trackSimpleDeviceDaily(
    [{ id: 'p1', powerW: 1260, enabled: false, actualOn: false }],
    new Map([['p1', { isOn: true }]]),   // eingefroren, seit Stunden falsch
    3600_000,
  );
  assert.deepStrictEqual(d._simpleDeviceDaily('p1'), { kwh: 0, runtimeMs: 0 });
});

test('_trackSimpleDeviceDaily — und in die andere Richtung ebenso', () => {
  const d = makeWidgetDevice();
  d._trackSimpleDeviceDaily(
    [{ id: 'p1', powerW: 1260, enabled: false, actualOn: true }],
    new Map([['p1', { isOn: false }]]),  // eingefroren, als es aus war
    3600_000,
  );
  assert.deepStrictEqual(d._simpleDeviceDaily('p1'), { kwh: 1.26, runtimeMs: 3600_000 });
});

test('_trackSimpleDeviceDaily — ein nicht lesbarer Zustand zählt als aus', () => {
  // actualOn null heisst "unbekannt" — kein Leistungspfad konfiguriert, oder die Steckdose
  // schweigt. Ein Unbekanntes ist keine Messung und darf keine Laufzeit buchen.
  const d = makeWidgetDevice();
  d._trackSimpleDeviceDaily(
    [{ id: 'p1', powerW: 1260, enabled: false, actualOn: null }],
    new Map([['p1', { isOn: true }]]),
    3600_000,
  );
  assert.deepStrictEqual(d._simpleDeviceDaily('p1'), { kwh: 0, runtimeMs: 0 });
});

test('_trackSimpleDeviceDaily — ein gesteuertes Gerät zählt weiter nach dem EMS-Zustand', () => {
  // Gegenprobe: dort ist der Eintrag gepflegt, und er ist die Stelle, die den Anlauf und
  // die Haltezeiten kennt. Der Messwert allein würde bei jedem Taktsprung flattern.
  const d = makeWidgetDevice();
  d._trackSimpleDeviceDaily(
    [{ id: 'p1', powerW: 2000, enabled: true, actualOn: false }],
    new Map([['p1', { isOn: true }]]),
    3600_000,
  );
  assert.deepStrictEqual(d._simpleDeviceDaily('p1'), { kwh: 2, runtimeMs: 3600_000 });
});
