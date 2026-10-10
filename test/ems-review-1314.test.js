'use strict';

// Five energy-management faults from the review of 2026-10-10 (1.2.314). All run through the
// real EMS device class — device.js with its mixins — with the Homey Web API and the flow
// triggers stubbed.
//
//   1. One failed read of a charger's plug state counted as "unplugged".
//   2. The error status after two failing ticks never reached the tile: the code awaited
//      `_setMode(…).catch(…)`, and _setMode returns nothing.
//   3. A battery taken out of price control while force-charging or held stayed there.
//   4. Off-peak charging asked a charger for offpeak_amps, whatever its own maximum.
//   5. With several chargers or several grid meters it counted wrong: a grid tier returned as
//      soon as one of its chargers charged and left the others unregulated, and an unreadable
//      meter dropped out of the sum instead of making the reading fail.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { App: class {}, Device: class {}, Driver: class {} };
  return origLoad.call(this, request, parent, isMain);
};
const EmsDevice = require(path.join(ROOT, 'drivers', 'energy_management', 'device.js'));
Module._load = origLoad;
const { CHARGER_STATE_HOLD_MS, GRID_SENSOR_HOLD_MS } = require('../lib/ems/constants');

function ems(api = {}) {
  const d = Object.create(EmsDevice.prototype);
  d.logs = []; d.fired = []; d.events = []; d.caps = {};
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = d.log;
  d._debugLog = () => {};
  d._devCache = new Map();
  d._api = { getDevice: async (id) => { const v = api[id]; if (v instanceof Error) throw v; return v || null; } };
  d._chargerStates = new Map();
  d._batteryStates = new Map();
  d._warmupDone = true;
  d._carStates = [];
  d._chargeSessions = [];
  d._lastValidGridW = null; d._gridSensorFail = 0; d._gridSensorFailSince = null;
  d._addHistoryEvent = (type, event, label, id) => d.events.push({ event, label, id });
  d.getCapabilityValue = (k) => d.caps[k];
  d.setCapabilityValue = async (k, v) => { d.caps[k] = v; };
  d.hasCapability = () => true;
  d.homey = {
    flow: {
      getTriggerCard: (id) => ({ trigger: (tokens) => { d.fired.push({ id, ...tokens }); return Promise.resolve(); } }),
      getDeviceTriggerCard: (id) => ({ trigger: () => { d.fired.push({ id }); return Promise.resolve(); } }),
    },
    setTimeout, clearTimeout,
    settings: { get: () => null, set: () => {} },
    clock: { getTimezone: () => 'Europe/Zurich' },
  };
  return d;
}
const chargerApi = (state, watts) => ({ id: 'c', name: 'Wallbox', available: true,
  capabilitiesObj: { evcharger_charging_state: { value: state }, measure_power: { value: watts } } });
const amps = (d, id) => d.fired.filter((f) => f.id === 'ems_set_charger_current' && f.charger_device_id === id).map((f) => f.amps);

// ── 1. a plug state that could not be read ────────────────────────────────────────

test('a charger whose state cannot be read stays plugged in for the hold, then counts as unplugged', async () => {
  const api = { c: chargerApi('charging', 7000) };
  const d = ems(api);
  const cfg = { chargers: [{ id: 'c', max_amps: 16 }] };
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    let [c] = await d._getChargers(cfg);
    assert.strictEqual(c.connected, true);

    api.c = new Error('Request timed out');                  // the Web API hiccups
    d._devCache = new Map(); clock += 15_000;
    [c] = await d._getChargers(cfg);
    assert.strictEqual(c.connected, true, 'one failed read ended the session — instant charging switched off for good');
    assert.ok(d.logs.some((l) => /plug state could not be read — keeping "plugged in"/.test(l)));

    d._devCache = new Map(); clock += CHARGER_STATE_HOLD_MS;
    [c] = await d._getChargers(cfg);
    assert.strictEqual(c.connected, false, 'a charger silent for longer than the hold is still "plugged in"');

    api.c = chargerApi('plugged_out', 0);                    // a real "unplugged" is believed at once
    d._devCache = new Map(); clock += 1000;
    [c] = await d._getChargers(cfg);
    assert.strictEqual(c.connected, false);
  } finally {
    Date.now = realNow;
  }
});

test('a charger that was never read is not assumed plugged in', async () => {
  const d = ems({ c: new Error('Request timed out') });
  const [c] = await d._getChargers({ chargers: [{ id: 'c', max_amps: 16 }] });
  assert.strictEqual(c.connected, false);
});

// ── 2. the error status ───────────────────────────────────────────────────────────

test('two failing ticks put "error" on the tile, and the tick itself does not reject', async () => {
  const d = ems();
  d._diag = { tickErrors: 0, maxTickMs: 0, tickCount: 0 };
  d._tickCount = 0;
  d._lastHistorySaveAt = Date.now();
  d._saveHistory = () => {};
  d._triggerModeFlow = async () => {};
  d.caps.ems_mode = 'solar_ev';
  d._tickBody = async () => { throw new ReferenceError('MODES is not defined'); };

  await d._tick();
  assert.strictEqual(d.caps.ems_mode, 'solar_ev', 'one transient error is meant to stay quiet');
  await d._tick();                                            // used to reject with a TypeError
  assert.strictEqual(d.caps.ems_mode, 'error', 'a dead EMS still looks alive');
  assert.match(d.caps.ems_status_text, /Tick-Fehler: MODES is not defined/);
});

// ── 3. price control switched off ─────────────────────────────────────────────────

test('a battery taken out of price control while force-charging is handed back, once', async () => {
  const d = ems();
  d._batteryStates.set('b1', { priceMode: 'charge' });
  d._batteryStates.set('b2', { priceMode: 'hold' });
  d._batteryStates.set('b3', { priceMode: 'normal' });
  const cfg = { battery_devices: [{ id: 'b1', price_charge_enabled: false }, { id: 'b3', price_charge_enabled: false }] };   // b2 removed

  await d._checkBatteryPriceControl(cfg, { socPerDevice: {} });
  const normal = d.fired.filter((f) => f.id === 'ems_battery_normal_mode').map((f) => f.battery_device_id).sort();
  assert.deepStrictEqual(normal, ['b1', 'b2'], 'a battery left force-charging or held');
  assert.strictEqual(d._batteryStates.get('b1').priceMode, 'normal');

  d.fired = [];
  await d._checkBatteryPriceControl(cfg, { socPerDevice: {} });
  assert.deepStrictEqual(d.fired, [], 'handed back on every tick');
});

test('a battery still under price control is left to its own decision', async () => {
  const d = ems();
  d._batteryStates.set('b1', { priceMode: 'charge' });
  d._batteryPriceMode = () => ({ mode: 'charge', reason: 'cheap slot' });
  await d._checkBatteryPriceControl({ battery_devices: [{ id: 'b1', price_charge_enabled: true }] }, { socPerDevice: {} });
  assert.deepStrictEqual(d.fired, []);
});

// ── 4 and 5a. the grid tiers ──────────────────────────────────────────────────────

const charger = (id, over = {}) => ({ id, enabled: true, connected: true, minAmps: 6, maxAmps: 16, phases: 1,
  phaseSwitch: false, chargeMode: 'solar', powerW: 0, rawPowerW: 0, ...over });
const NIGHT = { soc: 70, powerW: 0 };          // above the floor below, battery idle
const FLOOR = { min_battery_soc: 20 };       // without it the floor falls back to 80 % and the hard stop decides
const offpeakEms = () => {
  const d = ems();
  d._offpeakWindow = () => ({ active: true, amps: 16 });
  return d;
};

test('off-peak asks each charger for at most its own maximum', async () => {
  const d = offpeakEms();
  await d._evaluateEvChargers(NIGHT, 500, [charger('a', { chargeMode: 'solar_offpeak', maxAmps: 10 })], FLOOR, 0, 500, null);
  assert.deepStrictEqual(amps(d, 'a'), [10], 'a charger limited to 10 A was told 16 A');
});

test('while one charger charges off-peak, the others are still regulated — and stopped when unplugged', async () => {
  const d = offpeakEms();
  d._getChargerState('b').currentAmps = 16; d._getChargerState('b').currentPhases = 1;   // a solar charger, running
  d._getChargerState('u').currentAmps = 8;  d._getChargerState('u').currentPhases = 1;   // unplugged meanwhile
  const run = [
    charger('a', { chargeMode: 'solar_offpeak' }),
    charger('b', { powerW: 3680, rawPowerW: 3680 }),
    charger('u', { connected: false, powerW: 1840, rawPowerW: 0 }),
  ];
  // Night: 4 kW from the grid, all of it the chargers and the house; no surplus anywhere.
  await d._evaluateEvChargers(NIGHT, 4000, run, FLOOR, 0, 400, null);

  assert.deepStrictEqual(amps(d, 'a'), [16], 'the off-peak charger did not get its window');
  assert.ok(amps(d, 'u').includes(0), 'an unplugged charger kept its command — it was never looked at');
  assert.ok(amps(d, 'b').some((x) => x < 16), 'the solar charger kept 16 A from the grid while another charged off-peak');
  assert.strictEqual(d.caps.ems_mode, undefined);            // _setMode only proposes …
  assert.strictEqual(d._tickMode.mode, 'offpeak_ev', '… and the tile names the grid tier');
});

test('a price charger gets its cheap slot even inside the off-peak window of another', async () => {
  const d = offpeakEms();
  d._priceShouldChargeNow = () => ({ shouldCharge: true, reason: 'cheapest slot' });
  const run = [charger('a', { chargeMode: 'solar_offpeak' }), charger('p', { chargeMode: 'solar_price' })];
  const granted = await d._evaluateEvChargers(NIGHT, 500, run, FLOOR, 0, 500, null);
  assert.deepStrictEqual(amps(d, 'a'), [16]);
  assert.deepStrictEqual(amps(d, 'p'), [16], 'the price charger never reached its slot');
  assert.strictEqual(granted, 2 * 16 * 230, 'the run does not claim what it granted');
  assert.match(d._tickMode.text, /Lader · günstiger Strompreis/);
});

// ── 5b. several grid meters ───────────────────────────────────────────────────────

test('one unreadable meter of several makes the reading fail, not the sum smaller', async () => {
  const meter = (w) => ({ id: 'x', name: 'Meter', available: true, capabilitiesObj: { measure_power: { value: w } } });
  const api = { m1: meter(-3000), m2: meter(2500) };
  const d = ems(api);
  const cfg = { meter_devices: [{ id: 'm1' }, { id: 'm2' }] };
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    assert.strictEqual(await d._getGridW(cfg), -500);
    api.m2 = new Error('Request timed out');
    d._devCache = new Map(); clock += 15_000;
    assert.strictEqual(await d._getGridW(cfg), -500, '3 kW of export that does not exist — the unread meter dropped out');
    d._devCache = new Map(); clock += GRID_SENSOR_HOLD_MS;
    assert.strictEqual(await d._getGridW(cfg), null, 'past the hold, a partial reading must not steer');
  } finally {
    Date.now = realNow;
  }
});

test('the chargers after a grid tier see its new draw in the grid reading, before the meter does', async () => {
  // The off-peak charger was just granted 16 A and draws nothing yet; the meter still shows a
  // little export. The solar charger behind it must be budgeted against the grid as it will
  // be — with those 3680 W in it — not against the export about to disappear.
  const d = offpeakEms();
  const budgets = [];
  const step = d._stepCharger.bind(d);
  d._stepCharger = (c, budgetW, ...rest) => { budgets.push({ id: c.id, budgetW }); return step(c, budgetW, ...rest); };
  d._getChargerState('b').currentAmps = 16; d._getChargerState('b').currentPhases = 1;
  const run = [charger('a', { chargeMode: 'solar_offpeak' }), charger('b', { maxAmps: 32, powerW: 3680, rawPowerW: 3680 })];
  await d._evaluateEvChargers(NIGHT, -500, run, { ...FLOOR, offpeak_solar_first: false }, 0, 400, null);
  const b = budgets.find((x) => x.id === 'b');
  assert.ok(b, 'the solar charger was never stepped');
  assert.strictEqual(b.budgetW, 3680 - (-500 + 16 * 230), `budget ${b.budgetW} W — the new off-peak draw was not counted`);
});
