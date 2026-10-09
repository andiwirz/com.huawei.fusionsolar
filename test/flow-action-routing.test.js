'use strict';

// Every Modbus action card acts on the device the flow names (1.2.291).
//
// Homey keeps one run listener per action card for the whole app, and the last device to
// register it wins. The SUN2000, LUNA2000 and EMMA battery listeners closed over `this` — the
// registering device — for the address they wrote to, the limits they checked and the state
// they updated afterwards. With two devices of one driver (two inverters on one dongle, unit
// IDs 1 and 2) a card set on the second acted on the first, and reported success.
//
// Two halves, run against the same recording harness:
//
//   1. Nothing changes for one device. test/fixtures/flow-action-golden.json was recorded from
//      the code before the change — every Modbus write, setting, capability, stored value,
//      timer, trigger and notification each card produces with a single device. The rebuilt
//      listeners must produce exactly that again.
//   2. With two devices, a card registered by A and run for B does all of it on B and none of
//      it on A.
//
// FLOW_GOLDEN_UPDATE=1 node --test test/flow-action-routing.test.js rewrites the fixture —
// only ever from code whose single-device behaviour is known to be right.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const Module = require('module');

const ROOT    = path.join(__dirname, '..');
const app     = require(path.join(ROOT, 'app.json'));
const GOLDEN  = path.join(__dirname, 'fixtures', 'flow-action-golden.json');
const DRIVERS = ['sun2000_modbus', 'luna2000_modbus', 'luna2000_emma_modbus'];

// ── the recording ─────────────────────────────────────────────────────────────────

let events = [];
const TS = (v) => (typeof v === 'number' && v > 1e12 ? 'TIMESTAMP' : v);
const clean = (v) => JSON.parse(JSON.stringify(v ?? null, (k, x) => TS(x)));

const writer = (fn) => async (host, port, unit, reg, value) => { events.push(['write', fn, host, port, unit, reg, value]); };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  if (request === '../../lib/modbus-client') {
    const real = origLoad.call(this, request, parent, isMain);
    return { ...real, writeModbusRegister: writer('reg'), writeModbusU32: writer('u32') };
  }
  return origLoad.call(this, request, parent, isMain);
};
const CLASSES = Object.fromEntries(DRIVERS.map((d) => [d, require(path.join(ROOT, 'drivers', d, 'device.js'))]));
Module._load = origLoad;

const en = require(path.join(ROOT, 'locales', 'en.json'));
const t  = (key) => key.split('.').reduce((o, k) => (o ? o[k] : undefined), en) ?? key;

const BASE_SETTINGS = {
  port: 502, enable_timeline_notifications: true,
  max_charge_power: 5000, max_discharge_power: 5000, max_feed_in_power: 5000, max_feed_in_power_pct: 70,
  charge_from_grid: false, max_grid_charge_power: 2000, max_grid_charge_ceiling: 2000,
};
const BASE_CAPS = {
  activepower_controlmode: '6', storage_working_mode_settings: '2', storage_excess_pv_energy_use_in_tou: '0',
  remote_charge_discharge_control_mode: '0', storage_force_charge_discharge: '0', measure_battery: 55,
};

function device(driver, name, own) {
  const d = Object.create(CLASSES[driver].prototype);
  d.settings = { ...BASE_SETTINGS, ...own };
  d.caps = { ...BASE_CAPS };
  d.store = {};
  d.listeners = {};
  const tag = () => name;
  const card = (id) => ({
    registerRunListener(fn) { d.listeners[id] = fn; return this; },
    registerArgumentAutocompleteListener() { return this; },
    trigger: async (dev, tokens) => { events.push(['trigger', id, dev && dev.__name, clean(tokens)]); },
  });
  d.__name = name;
  d.homey = {
    __: t,
    flow: { getActionCard: card, getConditionCard: card, getDeviceTriggerCard: card, getTriggerCard: card },
    notifications: { createNotification: async ({ excerpt }) => { events.push(['notify', excerpt]); } },
    setTimeout: (fn, ms) => { events.push(['timer', tag(), ms]); return 0; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  };
  d.getName = () => name;
  d.getSetting = (k) => d.settings[k];
  d.getSettings = () => ({ ...d.settings });
  d.setSettings = async (o) => { events.push(['settings', tag(), clean(o)]); Object.assign(d.settings, o); };
  d.getCapabilityValue = (c) => (c in d.caps ? d.caps[c] : null);
  d.hasCapability = () => true;
  d._set = async (c, v) => { events.push(['set', tag(), c, clean(v)]); d.caps[c] = v; };
  d.getStoreValue = (k) => d.store[k];
  d.setStoreValue = async (k, v) => { events.push(['store', tag(), k, clean(v)]); d.store[k] = v; };
  if (typeof d._noteWrite === 'function') d._noteWrite = (...a) => { events.push(['note', tag(), clean(a)]); };
  d.log = () => {};
  d.error = (...a) => { events.push(['error', tag(), a.map((x) => String(x && x.message ? x.message : x)).join(' ')]); };
  d._ratedPowerW = 10000;
  return d;
}

const DEV_A = { address: '192.0.2.1', modbus_id: 1 };
const DEV_B = { address: '192.0.2.2', modbus_id: 2 };

// In the two-device runs the registering device A holds different state from B, so a listener
// that reads anything off the wrong device — a limit, the feed-in mode, the rated power, a
// remembered value — produces a different result, not merely a different address.
function poison(d) {
  Object.assign(d.settings, {
    max_charge_power: 0, max_discharge_power: 0, max_feed_in_power: 777, max_feed_in_power_pct: 13,
    charge_from_grid: true, max_grid_charge_power: 99, max_grid_charge_ceiling: 99, enable_timeline_notifications: false,
  });
  Object.assign(d.caps, { activepower_controlmode: '0', storage_working_mode_settings: '5', measure_battery: 11 });
  d._ratedPowerW = 3333;
  d.getStoreValue = () => ({ mode: '7', maxFeedInW: 4321, savedAt: 1 });
  return d;
}

// Every action card a driver's device filter admits, with every value of its dropdowns.
function cardsFor(driver) {
  return app.flow.actions.filter((c) => (c.args || []).some((a) => a.type === 'device'
    && String(a.filter).split('||').includes(`driver_id=${driver}`)));
}
function argSets(c) {
  let sets = [{}];
  for (const a of (c.args || []).filter((x) => x.type !== 'device')) {
    let values;
    if (a.type === 'dropdown') values = a.values.map((v) => v.id);
    else if (a.type === 'checkbox') values = [true];
    else if (a.type === 'number' || a.type === 'range') {
      const min = a.min ?? 0, max = a.max ?? 100, step = a.step ?? 1;
      values = [Math.round((min + (max - min) * 0.37) / step) * step];
    } else values = ['x'];
    sets = sets.flatMap((s) => values.map((v) => ({ ...s, [a.name]: v })));
  }
  return sets;
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

// Runs one card with one argument set: registered by `registrar`, aimed at `target`.
async function run(driver, cardId, args, { twoDevices }) {
  events = [];
  const target = device(driver, twoDevices ? 'B' : 'A', twoDevices ? DEV_B : DEV_A);
  const registrar = twoDevices ? poison(device(driver, 'A', DEV_A)) : target;
  registrar._registerFlowActions();
  const listener = registrar.listeners[cardId];
  assert.ok(listener, `${driver}: ${cardId} has no listener`);
  try {
    await listener({ ...args, device: target }, {});
  } catch (err) {
    events.push(['refused', err.message]);
  }
  await settle();
  return events;
}

// The zero-export pair keeps state between runs: enable remembers, disable restores.
async function runZeroExportPair({ twoDevices }) {
  events = [];
  const target = device('sun2000_modbus', twoDevices ? 'B' : 'A', twoDevices ? DEV_B : DEV_A);
  const registrar = twoDevices ? poison(device('sun2000_modbus', 'A', DEV_A)) : target;
  registrar._registerFlowActions();
  await registrar.listeners.sun2000_enable_zero_export({ device: target }, {});
  await settle();
  await registrar.listeners.sun2000_disable_zero_export({ device: target }, {});
  await settle();
  return events;
}

async function recordAll({ twoDevices }) {
  const out = {};
  for (const driver of DRIVERS) {
    for (const c of cardsFor(driver)) {
      for (const args of argSets(c)) {
        out[`${driver} ${c.id} ${JSON.stringify(args)}`] = await run(driver, c.id, args, { twoDevices });
      }
    }
  }
  out['sun2000_modbus zero export enable → disable'] = await runZeroExportPair({ twoDevices });
  return out;
}

// What device A would have done, rewritten as if it were device B.
const asB = (evts) => JSON.parse(JSON.stringify(evts)
  .replace(/"192\.0\.2\.1"/g, '"192.0.2.2"')
  .replace(/\["write","(reg|u32)","192\.0\.2\.2",502,1,/g, '["write","$1","192.0.2.2",502,2,')
  .replace(/,"A",/g, ',"B",')
  .replace(/^\[\["refused"/, '[["refused"')
  .replace(/"A: /g, '"B: '));

// ── 1. nothing changes for one device ──────────────────────────────────────────────

test('with one device every card does exactly what it did before', async () => {
  const now = await recordAll({ twoDevices: false });
  if (process.env.FLOW_GOLDEN_UPDATE === '1') {
    fs.writeFileSync(GOLDEN, JSON.stringify(now, null, 1) + '\n');
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  assert.deepStrictEqual(Object.keys(now).sort(), Object.keys(golden).sort(), 'a card or an argument value was added or dropped');
  for (const k of Object.keys(golden)) assert.deepStrictEqual(now[k], golden[k], k);
});

test('the recording is not empty — every card wrote something or said why not', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  const silent = Object.entries(golden).filter(([, ev]) => !ev.some((e) => e[0] === 'write' || e[0] === 'refused')).map(([k]) => k);
  assert.deepStrictEqual(silent, []);
  assert.ok(Object.keys(golden).length > 60, `only ${Object.keys(golden).length} runs recorded`);
});

// ── 2. with two devices, B gets it all ─────────────────────────────────────────────

test('a card registered by device A and run for device B acts on B, and only on B', async () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  const now = await recordAll({ twoDevices: true });
  const wrong = [];
  for (const [k, ev] of Object.entries(now)) {
    if (JSON.stringify(ev) !== JSON.stringify(asB(golden[k]))) wrong.push(k);
  }
  assert.deepStrictEqual(wrong, [], 'these cards still act on the device that registered them');
});

test('every Modbus action card of the three drivers was exercised', () => {
  const n = DRIVERS.reduce((sum, d) => sum + cardsFor(d).length, 0);
  assert.strictEqual(n, 13 + 27 + 3); // LUNA2000 +1: the stop card (1.2.303)
});
