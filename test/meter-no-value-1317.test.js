'use strict';

// An inverter whose meter register says "no value" has no meter (1.3.17).
//
// Wim_Hartman (forum, 2026-11-18): two SUN2000 over Modbus, the grid meter wired to one of
// them. The power flow showed 2.147.483,6 kW of export, frozen, the house at 0 W, and the
// energy balance no import or export for the day; restarting the app and the Homey did not
// help. 2147483647 W is 0x7FFFFFFF, Huawei's "no value". isPowerMeterDataValid knew only
// 0x80000000 as "no meter", so the inverter without one kept the grid capabilities with
// −2147483647 W, and meterInverter — the first SUN2000 carrying them — could be that one.
//
// Andi: "Ja, bauen".
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const { isPowerMeterDataValid } = require(path.join(ROOT, 'lib', 'modbus-registers.js'));
const W = require(path.join(ROOT, 'lib', 'widget-data.js'));

let reply = {};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  if (request === '../../lib/modbus-client') {
    const real = origLoad.call(this, request, parent, isMain);
    return { ...real, readModbusRegisters: async () => ({ ...reply }) };
  }
  return origLoad.call(this, request, parent, isMain);
};
const Sun2000Device = require(path.join(ROOT, 'drivers', 'sun2000_modbus', 'device.js'));
Module._load = origLoad;

const METER_CAPS = ['measure_power.grid_active_power', 'meter_power.grid_export', 'meter_power.grid_import'];

function inverter(unit, caps = {}) {
  const d = Object.create(Sun2000Device.prototype);
  d.caps = { measure_power: 0, ...caps };
  d.settings = { address: '192.168.1.20', port: 502, modbus_id: unit };
  d.logs = [];
  d.hasCapability = (c) => c in d.caps;
  d.getCapabilityValue = (c) => (c in d.caps ? d.caps[c] : null);
  d.setCapabilityValue = async (c, v) => { d.caps[c] = v; };
  d.addCapability = async (c) => { if (!(c in d.caps)) d.caps[c] = null; };
  d.removeCapability = async (c) => { delete d.caps[c]; };
  d.getSetting = (k) => d.settings[k];
  d.getAvailable = () => true;
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = (...a) => d.logs.push(a.join(' '));
  return d;
}
const homeyWith = (devices) => ({
  drivers: { getDriver: (id) => ({ getDevices: () => (id === 'sun2000_modbus' ? devices : []) }) },
});
const METER = { meterStatus: 1, powerMeterActivePower: 500, gridExportedEnergy: 120, gridAccumulatedEnergy: 340 };

test('isPowerMeterDataValid: both "no value" markers mean no meter, any real reading a meter', () => {
  assert.strictEqual(isPowerMeterDataValid({ powerMeterActivePower: 0x7FFFFFFF }), false);
  assert.strictEqual(isPowerMeterDataValid({ powerMeterActivePower: -0x80000000 }), false);
  assert.strictEqual(isPowerMeterDataValid({ powerMeterActivePower: null }), false);
  assert.strictEqual(isPowerMeterDataValid({}), false);
  for (const v of [0, 500, -1800, 2147483646, -2147483647]) {
    assert.strictEqual(isPowerMeterDataValid({ powerMeterActivePower: v }), true, String(v));
  }
});

test('an inverter reporting 0x7FFFFFFF loses the meter capabilities instead of showing −2147483647 W', async () => {
  const d = inverter(2, { 'measure_power.grid_active_power': -2147483647, 'meter_power.grid_export': 0, 'meter_power.grid_import': 0 });
  reply = { ...METER, meterStatus: 0, powerMeterActivePower: 0x7FFFFFFF, gridExportedEnergy: 0, gridAccumulatedEnergy: 0 };
  await d._fetchPowerMeter('192.168.1.20', 502, 2, () => false);
  for (const c of METER_CAPS) assert.ok(!d.hasCapability(c), `${c} kept`);
});

test('the inverter with the meter keeps reading it — import positive, as Homey has it', async () => {
  const d = inverter(1);
  reply = { ...METER };
  await d._fetchPowerMeter('192.168.1.20', 502, 1, () => false);
  assert.strictEqual(d.getCapabilityValue('measure_power.grid_active_power'), -500);
  assert.strictEqual(d.getCapabilityValue('meter_power.grid_export'), 120);
  assert.strictEqual(d.getCapabilityValue('meter_power.grid_import'), 340);
});

test('Wim\'s plant: the meterless inverter paired first no longer becomes the widgets\' meter', async () => {
  const noMeter = inverter(2);
  const withMeter = inverter(1);
  reply = { ...METER, meterStatus: 0, powerMeterActivePower: 0x7FFFFFFF, gridExportedEnergy: 0, gridAccumulatedEnergy: 0 };
  await noMeter._fetchPowerMeter('192.168.1.20', 502, 2, () => false);
  reply = { ...METER };
  await withMeter._fetchPowerMeter('192.168.1.20', 502, 1, () => false);

  const homey = homeyWith([noMeter, withMeter]);
  assert.strictEqual(W.meterInverter(homey), withMeter);
  const d = W.getPowerData(homey);
  assert.strictEqual(d.gridPower, -500);
});

test('the release: version 1.3.17 or later, with the fix in the changelog', () => {
  const app = require(path.join(ROOT, 'app.json'));
  const [ma, mi, pa] = app.version.split('.').map(Number);
  assert.ok(ma * 1e6 + mi * 1e3 + pa >= 1003017, app.version);
  const log = require(path.join(ROOT, '.homeychangelog.json'))['1.3.17'];
  assert.ok(log, 'no changelog entry for 1.3.17');
  for (const l of ['en', 'de', 'nl']) assert.match(log[l], /2147483647/, l);
});
