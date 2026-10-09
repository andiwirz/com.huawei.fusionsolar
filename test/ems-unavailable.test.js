'use strict';

// Energy management does not regulate on frozen values (1.2.276).
//
// A device Homey marks unavailable keeps the capability values it had when it went away.
// The EMS read them like any reading and kept regulating on them — with the export guards
// in chargerControl actively blocking the correction a real reading would have asked for.
// Measurements from such a device now read as missing, which the code downstream already
// handles with care. States do not: a charger that drops off the network for a minute must
// not read as unplugged and end the charging session.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
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

// The Homey Web API's view of the devices the EMS reads, by id.
function ems(devices) {
  const d = Object.create(EmsDevice.prototype);
  d.logs = [];
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = d.log;
  d._devCache = new Map();
  d._api = { getDevice: async (id) => devices[id] || null };
  d._chargerStates = new Map();
  d._lastValidGridW = null;
  d._gridSensorFail = 0;
  d._gridSensorFailSince = null;
  return d;
}
const meter = (available, w = 1200) => ({ id: 'm', name: 'Grid meter', available, capabilitiesObj: { measure_power: { value: w } } });
const nextTick = (d) => { d._devCache = new Map(); };

test('a measurement from an unavailable device reads as missing', async () => {
  const d = ems({ m: meter(false) });
  assert.strictEqual(await d._cap('m', 'measure_power', { measured: true }), null);
});

test('the same device read for a state still gives its last value', async () => {
  const d = ems({ m: meter(false) });
  assert.strictEqual(await d._cap('m', 'measure_power'), 1200);
});

test('an available device, or one the API does not say about, reads as before', async () => {
  assert.strictEqual(await ems({ m: meter(true) })._cap('m', 'measure_power', { measured: true }), 1200);
  assert.strictEqual(await ems({ m: meter(undefined) })._cap('m', 'measure_power', { measured: true }), 1200);
});

test('one line when a device goes away, one when it is back — not one per tick', async () => {
  const devices = { m: meter(false) };
  const d = ems(devices);
  for (let i = 0; i < 3; i++) { nextTick(d); await d._cap('m', 'measure_power', { measured: true }); }
  devices.m = meter(true);
  for (let i = 0; i < 3; i++) { nextTick(d); await d._cap('m', 'measure_power', { measured: true }); }
  assert.deepStrictEqual(d.logs, [
    '[EMS] "Grid meter" is unavailable — its measurements are ignored until it is back',
    '[EMS] "Grid meter" is available again',
  ]);
});

test('an unavailable grid meter holds control instead of steering on its last value', async () => {
  const d = ems({ m: meter(false, -3000) });
  const gridW = await d._getGridW({ meter_devices: [{ id: 'm' }] });
  assert.strictEqual(gridW, null, 'the frozen export reading still reached the controller');
});

test('an unavailable charger keeps its plugged-in state; only its measured power drops out', async () => {
  const d = ems({
    c: { id: 'c', name: 'Charger', available: false, capabilitiesObj: { evcharger_charging_state: { value: 'plugged_in_charging' }, measure_power: { value: 7000 } } },
  });
  const [charger] = await d._getChargers({ chargers: [{ id: 'c', max_amps: 16 }] });
  assert.strictEqual(charger.connected, true, 'an unreachable charger read as unplugged — its session would end');
  assert.strictEqual(charger.rawPowerW, null, 'a frozen charger power still counted');
});

test('every energy-balance reading asks for measurements; states and cars do not', () => {
  const src = fs.readFileSync(path.join(ROOT, 'drivers', 'energy_management', 'device.js'), 'utf8');
  for (const call of [
    "this._cap(d.id, d.cap_soc || 'measure_battery', { measured: true })",
    'this._cap(d.id, d.cap_power, { measured: true })',
    'this._cap(d.id, d.cap_capacity, { measured: true })',
    "this._cap(d.id, d.cap_power || 'measure_power', { measured: true })",
    'return this._cap(d.id, cap, { measured: true });',
    'this._cap(c.id, capPower, { measured: true })',
  ]) assert.ok(src.includes(call), `not a measurement read: ${call}`);
  assert.ok(src.includes('this._cap(c.id, capState)\n'), 'the charger state is filtered as a measurement');
  for (const lib of ['cars.js', 'simpleDevices.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'lib', 'ems', lib), 'utf8'), /measured: true/, lib);
  }
});
