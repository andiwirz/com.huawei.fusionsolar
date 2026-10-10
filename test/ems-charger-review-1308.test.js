'use strict';

// Three charger faults from the review of 2026-10-10 (1.2.308). All three run through the
// real EMS device class — device.js with its mixins — because two of them only exist where
// device.js _getChargers meets lib/ems/chargerControl.js: _getChargers raises a charger's
// powerW to the current the EMS commanded, as a floor for the budget, and the control code
// read that floor as if it had been measured.
//
//   1. A charger switched out of EMS control while running was still counted in the
//      priority loop. Its draw was booked as freed, and the devices behind it were offered
//      surplus that did not exist — 11 kW for a car at 16 A on three phases. Its commanded
//      current was never forgotten, so the floor reported that draw for ever.
//   2. A charger that ignored its start was never noticed: the floor made it "draw" what it
//      was commanded, so the retry and the give-up of 1.2.2xx never ran, and the charger
//      kept its share of the surplus while drawing nothing (field log 2026-09-25).
//   3. Below the battery's hard stop a charger was stopped once, and only if the EMS had
//      started it. A stop that did not land, or a car started outside the EMS, charged on
//      from the house battery below its floor.
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

const {
  CHARGER_START_GRACE_MS, CHARGER_START_GIVEUP_MS, CHARGER_STOP_WARN_TICKS, CHARGER_LIVE_W,
} = require('../lib/ems/constants');

// What the Homey Web API reports for the charger: its state and its own meter.
function chargerDevice(state, watts) {
  return { id: 'c', name: 'Wallbox', available: true,
    capabilitiesObj: { evcharger_charging_state: { value: state }, measure_power: { value: watts } } };
}

function ems(api = {}) {
  const d = Object.create(EmsDevice.prototype);
  d.logs = []; d.fired = []; d.events = [];
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = d.log;
  d._devCache = new Map();
  d._api = { getDevice: async (id) => api[id] || null };
  d._chargerStates = new Map();
  d._warmupDone = true;
  d._carStates = [];
  d._chargeSessions = [];
  d._addHistoryEvent = (type, event, label, id) => d.events.push({ event, label, id });
  d._setMode = (mode, text) => { d.lastMode = { mode, text }; };
  d.getCapabilityValue = () => undefined;
  d.setCapabilityValue = async () => {};
  d.homey = {
    flow: { getTriggerCard: (id) => ({ trigger: (tokens) => { d.fired.push({ id, ...tokens }); return Promise.resolve(); } }) },
    setTimeout, clearTimeout,
    settings: { get: () => null, set: () => {} },
    clock: { getTimezone: () => 'Europe/Zurich' },
  };
  return d;
}
const starts = (d) => d.fired.filter((f) => f.id === 'ems_start_charger').length;
const stops  = (d) => d.fired.filter((f) => f.id === 'ems_set_charger_current' && f.amps === 0).length;

// ── 1. a charger the EMS no longer controls ─────────────────────────────────────

test('a charger switched out of EMS control is not booked as freed surplus', async () => {
  // The simulated case from the review: the charger was switched off the EMS while running
  // at 16 A on three phases, the car has gone (0 W measured), the house imports 300 W.
  const d = ems();
  const st = d._getChargerState('c');
  st.currentAmps = 16; st.currentPhases = 3;
  const charger = { id: 'c', enabled: false, connected: false, minAmps: 6, maxAmps: 16,
    phases: 3, powerW: 16 * 3 * 230, rawPowerW: 0, chargeMode: 'solar' };

  let poolSaw = null;
  d._evaluateSimpleDevices = async (battery, gridW) => { poolSaw = gridW; return 0; };
  const simpleEval = { pool: { list: [{ id: 'pool' }], states: new Map(), start: 'a', stop: 'b', arg: null } };

  await d._runPriorityLoop({ soc: 90, powerW: 0 }, 300, [charger], {}, 0, 300, ['c', 'pool'], simpleEval, null);

  assert.strictEqual(poolSaw, 300, `the pool was offered ${-poolSaw} W of export that does not exist`);
});

test('…and the current it was last commanded is forgotten, once, without a command', async () => {
  const d = ems({ c: chargerDevice('plugged_out', 0) });
  const st = d._getChargerState('c');
  st.currentAmps = 16; st.currentPhases = 3;
  const cfg = { chargers: [{ id: 'c', max_amps: 16, ev_phases: '3', enabled: false }] };

  const [before] = await d._getChargers(cfg);
  assert.strictEqual(before.powerW, 16 * 3 * 230, 'the harness no longer shows the floor this is about');

  await d._evaluateEvChargers({ soc: 90, powerW: 0 }, 300, [before], cfg, 0, 300, null);
  d._devCache = new Map();
  const [after] = await d._getChargers(cfg);
  await d._evaluateEvChargers({ soc: 90, powerW: 0 }, 300, [after], cfg, 0, 300, null);

  assert.strictEqual(st.currentAmps, null);
  assert.strictEqual(after.powerW, 0, 'the charger still reports the current the EMS once sent');
  assert.strictEqual(d.fired.length, 0, 'a charger off the EMS got a command');
  assert.strictEqual(d.logs.filter((l) => l.includes('no longer controlled by the EMS')).length, 1);
});

test('a charger the EMS does control still counts with its full draw', async () => {
  // The delta logic itself is unchanged: a running charger's draw is in gridW, and only the
  // change against it moves the grid the next run sees.
  const d = ems();
  const charger = { id: 'c', enabled: true, connected: true, powerW: 2760, rawPowerW: 2760 };
  d._evaluateEvChargers = async () => 1380;   // stepped down from 12 A to 6 A on one phase
  let poolSaw = null;
  d._evaluateSimpleDevices = async (battery, gridW) => { poolSaw = gridW; return 0; };
  const simpleEval = { pool: { list: [{ id: 'pool' }], states: new Map() } };

  await d._runPriorityLoop({ soc: 90, powerW: 0 }, -500, [charger], {}, 0, 0, ['c', 'pool'], simpleEval, null);

  assert.strictEqual(poolSaw, -500 + 1380 - 2760);
});

// ── 2. a start the charger ignored ──────────────────────────────────────────────

test('a charger that ignores its start is retried and then stopped — through the real _getChargers', async () => {
  const d = ems({ c: chargerDevice('plugged_in_paused', 0) });
  const cfg = { chargers: [{ id: 'c', max_amps: 16, ev_phases: '1' }] };
  await d._chargerSetAmps('c', 12, 1);                       // the start the charger ignores
  assert.strictEqual(starts(d), 1);

  const T0 = Date.now();
  const tick = async (t) => {
    d._devCache = new Map();
    const [c] = await d._getChargers(cfg);
    assert.ok(c.powerW >= 12 * 230 && c.rawPowerW === 0, 'the floor this test is about is gone');
    return d._stepCharger(c, 2760, 1, t, -2829, false);
  };

  await tick(T0);                                            // first silent tick: the clock starts
  await tick(T0 + CHARGER_START_GRACE_MS + 1);               // past the grace: the start once more
  assert.strictEqual(starts(d), 2, 'no second start — the floor still read as a draw');
  const r = await tick(T0 + CHARGER_START_GIVEUP_MS);        // given up: stopped, surplus released
  assert.strictEqual(stops(d), 1, 'never stopped — it kept its share while drawing nothing');
  assert.strictEqual(r.allocatedW, 0);
  assert.ok(d._getChargerState('c').startBlockedUntil > T0, 'no back-off after the give-up');
});

test('a charger that does draw is left charging, and so is one with no meter at all', async () => {
  // Drawing: the start landed, nothing to retry.
  const d = ems({ c: chargerDevice('charging', 2700) });
  const cfg = { chargers: [{ id: 'c', max_amps: 16, ev_phases: '1' }] };
  await d._chargerSetAmps('c', 12, 1);
  const T0 = Date.now();
  for (const t of [T0, T0 + CHARGER_START_GRACE_MS + 1, T0 + CHARGER_START_GIVEUP_MS]) {
    d._devCache = new Map();
    const [c] = await d._getChargers(cfg);
    await d._stepCharger(c, 2760, 1, t, -100, false);
  }
  assert.strictEqual(starts(d), 1);
  assert.strictEqual(stops(d), 0);

  // No power capability: nothing can be noticed, so nothing is done (rawPowerW is null).
  const blind = ems({ c: { id: 'c', name: 'Wallbox', available: true,
    capabilitiesObj: { evcharger_charging_state: { value: 'charging' } } } });
  await blind._chargerSetAmps('c', 12, 1);
  for (const t of [T0, T0 + CHARGER_START_GRACE_MS + 1, T0 + CHARGER_START_GIVEUP_MS]) {
    blind._devCache = new Map();
    const [c] = await blind._getChargers(cfg);
    assert.strictEqual(c.rawPowerW, null);
    await blind._stepCharger(c, 2760, 1, t, -100, false);
  }
  assert.strictEqual(starts(blind), 1, 'a charger without a meter was re-started');
  assert.strictEqual(stops(blind), 0, 'a charger without a meter was given up on');
});

// ── 3. below the battery's hard stop ────────────────────────────────────────────

const LOW = { soc: 10, powerW: -3000 };       // below the floor, discharging into the car
const FLOOR_CFG = { min_battery_soc: 20 };

async function hardStopTick(d, measuredW, extra = {}) {
  const c = { id: 'c', enabled: true, connected: true, minAmps: 6, maxAmps: 16, phases: 1,
    phaseSwitch: false, chargeMode: 'solar', powerW: measuredW, rawPowerW: measuredW, ...extra };
  return d._evaluateEvChargers(LOW, 2500, [c], FLOOR_CFG, 0, 5500, null);
}

test('below the hard stop a charger that is still drawing gets the stop again, every tick', async () => {
  const d = ems();
  const st = d._getChargerState('c');
  st.currentAmps = 12; st.currentPhases = 1;

  await hardStopTick(d, 2760);                 // the stop the EMS owed it
  assert.strictEqual(stops(d), 1);
  await hardStopTick(d, 2760);                 // it did not land
  await hardStopTick(d, 2760);
  assert.strictEqual(stops(d), 3, 'a stop that did not land was never sent again');
  assert.strictEqual(d.lastMode.mode, 'battery_priority');
});

test('…and so does a car started outside the EMS', async () => {
  const d = ems();                             // nothing commanded at all
  await hardStopTick(d, 3000);
  assert.strictEqual(stops(d), 1, 'a charger the EMS never started drained the battery below its floor');
  assert.ok(d.logs.some((l) => /drawing 3000W below the battery's hard stop/.test(l)));
});

test('repeated stops below the hard stop are reported once; a quiet charger gets nothing', async () => {
  const d = ems();
  for (let i = 0; i < CHARGER_STOP_WARN_TICKS + 3; i++) await hardStopTick(d, 3000);
  const warned = d.events.filter((e) => e.event === 'stop_ineffective');
  assert.strictEqual(warned.length, 1, 'one "not reaching it" entry, however long it lasts');
  assert.strictEqual(warned[0].label, '3000W');

  const before = stops(d);
  await hardStopTick(d, CHARGER_LIVE_W - 1);   // it finally stopped
  await hardStopTick(d, 0);
  assert.strictEqual(stops(d), before, 'a charger that is not drawing got more stop commands');
  assert.strictEqual(d._getChargerState('c').uncommandedTicks, 0);
});

test('the first tick after a start only observes, and a charger off the EMS is never touched', async () => {
  const warm = ems();
  warm._warmupDone = false;
  await hardStopTick(warm, 3000);
  assert.strictEqual(stops(warm), 0, 'a stop went out on the observe-only first tick');

  const off = ems();
  await hardStopTick(off, 3000, { enabled: false });
  assert.strictEqual(off.fired.length, 0, 'a charger switched out of EMS control was stopped');
});
