'use strict';

// A SDongle power with no value keeps the last reading (1.3.16).
//
// Log 25482011 (forum, 2026-11-17): right after an app restart the SDongle, still busy, answered
// the grid power (37502, INT32) with 0x7FFFFFFF, Huawei's "no value". The app took it as a
// reading: "Poll OK: Solar=0W Grid=2147483647W", and 2.1 GW of grid import went to the tile and
// to everything that reads the grid power. Such a value now becomes null, which _set skips.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const { huawei32, SDONGLE_A_REGISTERS } = require(path.join(ROOT, 'lib', 'modbus-registers.js'));

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
const SdongleDevice = require(path.join(ROOT, 'drivers', 'sdongle_a_modbus', 'device.js'));
Module._load = origLoad;

const CAPS = ['measure_power', 'measure_power.solar', 'measure_power.grid_active_power', 'measure_power.battery', 'measure_power.active_power'];

function sdongle() {
  const d = Object.create(SdongleDevice.prototype);
  d.caps = {};
  d.logs = [];
  d.settings = { address: '192.0.2.5', port: 502, modbus_id: 100 };
  d.homey = { __: (k) => k };
  d.getSetting = (k) => d.settings[k];
  d.hasCapability = (c) => CAPS.includes(c);
  d.getCapabilityValue = (c) => (c in d.caps ? d.caps[c] : null);
  d.setCapabilityValue = async (c, v) => { d.caps[c] = v; };
  d.getCapabilities = () => CAPS;
  d.getAvailable = () => true;
  d.setAvailable = async () => {};
  d.setUnavailable = async () => {};
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = (...a) => d.logs.push(a.join(' '));
  d._updateEnergyWarning = async () => {};
  d._failureCount = 0;
  d._fetchInProgress = false;
  return d;
}

const GOOD = { totalInputPower: 3200, loadPower: 900, gridPower: -1800, batteryPower: 500, totalActivePower: 2700 };

test('huawei32: the all-ones values and 0x80000000 are no value, anything else is a reading', () => {
  assert.strictEqual(huawei32(0x7FFFFFFF, 'INT32'), null);
  assert.strictEqual(huawei32(-0x80000000, 'INT32'), null);
  assert.strictEqual(huawei32(0xFFFFFFFF, 'UINT32'), null);
  // the same numbers in the other type are not Huawei's marker — and a real plant's numbers pass
  assert.strictEqual(huawei32(0x7FFFFFFF, 'UINT32'), 0x7FFFFFFF);
  for (const [v, t] of [[0, 'INT32'], [-1800, 'INT32'], [2147483646, 'INT32'], [-2147483647, 'INT32'], [0, 'UINT32'], [4294967294, 'UINT32']]) {
    assert.strictEqual(huawei32(v, t), v, `${t} ${v}`);
  }
  assert.strictEqual(huawei32(null, 'INT32'), null);
  assert.strictEqual(huawei32(undefined, 'UINT32'), null);
});

test('the five SDongle powers are the 32-bit registers huawei32 knows', () => {
  for (const key of ['loadPower', 'totalInputPower', 'gridPower', 'batteryPower', 'totalActivePower']) {
    assert.ok(['INT32', 'UINT32'].includes(SDONGLE_A_REGISTERS[key][2]), key);
  }
});

test('the field log: a busy dongle\'s 0x7FFFFFFF grid power keeps the last reading', async () => {
  const d = sdongle();
  reply = { ...GOOD };
  await d._fetchAndUpdate();
  assert.strictEqual(d.caps['measure_power.grid_active_power'], -1800);

  d._pollLogAt = undefined; // let the heartbeat line through
  reply = { ...GOOD, totalInputPower: 0, gridPower: 0x7FFFFFFF };
  await d._fetchAndUpdate();
  assert.strictEqual(d.caps['measure_power.grid_active_power'], -1800, 'grid power taken from a no-value reply');
  assert.strictEqual(d.caps['measure_power.solar'], 0, 'a real 0 is a reading');
  assert.ok(d.logs.includes('No value from the dongle for gridPower — last reading kept'), d.logs.join('\n'));
  assert.ok(d.logs.includes('Poll OK: Solar=0W Grid=n/a'), d.logs.join('\n'));
  assert.strictEqual(d._failureCount, 0, 'a no-value reading is not a failed poll');
});

test('every power is guarded, signed and unsigned alike', async () => {
  const d = sdongle();
  reply = { ...GOOD };
  await d._fetchAndUpdate();
  const before = { ...d.caps };
  reply = { totalInputPower: 0xFFFFFFFF, loadPower: 0xFFFFFFFF, gridPower: 0x7FFFFFFF, batteryPower: 0x7FFFFFFF, totalActivePower: -0x80000000 };
  await d._fetchAndUpdate();
  assert.deepStrictEqual(d.caps, before);
  assert.ok(d.logs.includes('No value from the dongle for loadPower, totalInputPower, gridPower, batteryPower, totalActivePower — last reading kept'), d.logs.join('\n'));
});

test('the no-value line is written when it starts and when it ends, not every poll', async () => {
  const d = sdongle();
  const said = () => d.logs.filter((l) => l.startsWith('No value') || l.startsWith('The dongle has values')).length;
  reply = { ...GOOD, batteryPower: 0x7FFFFFFF };
  for (let i = 0; i < 5; i++) await d._fetchAndUpdate();
  assert.strictEqual(said(), 1);
  reply = { ...GOOD };
  await d._fetchAndUpdate();
  await d._fetchAndUpdate();
  assert.strictEqual(said(), 2);
  assert.ok(d.logs.includes('The dongle has values for every power again'));
  assert.strictEqual(d.caps['measure_power.battery'], 500);
});

test('the release: version 1.3.16 or later, with the fix in the changelog', () => {
  const app = require(path.join(ROOT, 'app.json'));
  const [ma, mi, pa] = app.version.split('.').map(Number);
  assert.ok(ma * 1e6 + mi * 1e3 + pa >= 1003016, app.version);
  const log = require(path.join(ROOT, '.homeychangelog.json'))['1.3.16'];
  assert.ok(log, 'no changelog entry for 1.3.16');
  for (const l of ['en', 'de', 'nl']) assert.match(log[l], /SDongle/, l);
});
