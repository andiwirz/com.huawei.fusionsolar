'use strict';

// A register that was not read is not a register the inverter lacks (1.2.316, review of
// 2026-10-10).
//
// readRegisters returned a poll that was cut short — for a flow card's write waiting on the
// bus, a settings probe, a batch that timed out — as ordinary data with nulls in it, and the
// SUN2000 driver read every null as "this hardware is not there":
//   · the grid meter's capabilities were removed (measure_power.grid_active_power is the grid
//     figure the energy management reads by default) and added back on the next poll;
//   · the optimizer capabilities likewise;
//   · the PV input power went out as 0 W, as a successful poll — "power changed" fired with
//     0, and the 0 went into the history behind "power above … for N minutes".
// Removing a capability takes its flows' tokens with it, and very likely its Insights.
//
// readRegisters now says which nulls were not read (result.unread, not enumerable, and
// notRead() to ask it); only Modbus exception 2 — "no such register" — leaves a null that
// means absent.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const realClient = require('../lib/modbus-client.js');
const { readRegisters, notRead } = realClient;

// ── the client: which nulls were not read ────────────────────────────────────────

const REGS = {
  inputPower:            [32064, 2, 'INT32', 'Input Power (W)', 0],
  powerMeterActivePower: [37113, 2, 'INT32', 'Power Meter Active Power (W)', 0],
};
const reply = (words) => ({ response: { body: { valuesAsBuffer: Buffer.alloc(words * 2, 0) } } });
const exception = (code) => Object.assign(new Error('A Modbus Exception Occurred - See Response Body'), { response: { body: { code } } });

test('a read cut short marks what it never asked for — and nothing it did read', async () => {
  let calls = 0;
  const client = { readHoldingRegisters: async (start, words) => { calls++; return reply(words); } };
  const result = await readRegisters(REGS, client, () => calls >= 1);   // a write is waiting after the first span
  assert.strictEqual(result.powerMeterActivePower, null);
  assert.strictEqual(notRead(result, 'powerMeterActivePower'), true);
  assert.strictEqual(notRead(result, 'inputPower'), false);
  // Invisible to everything that walks the result as it always did.
  assert.deepStrictEqual(Object.keys(result), ['inputPower', 'powerMeterActivePower']);
  assert.ok(!JSON.stringify(result).includes('unread'));
});

test('"no such register" (exception 2) is absent; a timeout is merely not read', async () => {
  const absent = await readRegisters(REGS, { readHoldingRegisters: async (start, words) => {
    if (start === 37113) throw exception(2);
    return reply(words);
  } });
  assert.strictEqual(absent.powerMeterActivePower, null);
  assert.strictEqual(notRead(absent, 'powerMeterActivePower'), false, 'a register the device does not have counted as unread');

  const silent = await readRegisters(REGS, { readHoldingRegisters: async (start, words) => {
    if (start === 37113) throw new Error('Req timed out');
    return reply(words);
  } });
  assert.strictEqual(notRead(silent, 'powerMeterActivePower'), true);
});

test('a batch written off for an unreliable reply is not read, every register of it', async () => {
  // a on its own span first; b and c share the second, which times out as a whole — the path
  // that writes a batch off without splitting it (lib/modbus-client.js _isDesync).
  const PAIR = {
    a: [32064, 2, 'INT32', 'a', 0],
    b: [37113, 2, 'INT32', 'b', 0],
    c: [37115, 1, 'UINT16', 'c', 0],
  };
  const spans = [];
  const result = await readRegisters(PAIR, { readHoldingRegisters: async (start, words) => {
    spans.push([start, words]);
    if (start === 37113) throw new Error('Req timed out');
    return reply(words);
  } });
  assert.ok(spans.some(([s, w]) => s === 37113 && w === 3), 'b and c were not read as one batch — the test lost its point');
  assert.strictEqual(notRead(result, 'b', 'c'), true);
  assert.strictEqual(notRead(result, 'b'), true);
  assert.strictEqual(notRead(result, 'c'), true);
  assert.strictEqual(notRead(result, 'a'), false);
});

// ── the SUN2000 driver ───────────────────────────────────────────────────────────

let answers = { main: {}, meter: {} };
const withUnread = (values, unread = []) => {
  const out = { ...values };
  Object.defineProperty(out, 'unread', { value: new Set(unread), enumerable: false });
  return out;
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  if (request === '../../lib/modbus-client') {
    return {
      ...realClient,
      readModbusRegisters: async (host, port, unit, registers) => {
        const which = 'powerMeterActivePower' in registers ? answers.meter : answers.main;
        const out = {};
        for (const k of Object.keys(registers)) out[k] = which.values[k] ?? null;
        return withUnread(out, which.unread === 'all' ? Object.keys(registers) : (which.unread || []));
      },
    };
  }
  return origLoad.call(this, request, parent, isMain);
};
const SunDevice = require('../drivers/sun2000_modbus/device.js');
Module._load = origLoad;

const METER_CAPS = ['measure_power.grid_active_power', 'meter_power.grid_export', 'meter_power.grid_import'];
const OPT_CAPS   = ['optimizer_total_count', 'optimizer_online_count'];

function inverter() {
  const d = Object.create(SunDevice.prototype);
  d.caps = { measure_power: 4200 };
  for (const c of [...METER_CAPS, ...OPT_CAPS]) d.caps[c] = 1;
  d.removed = []; d.fired = [];
  d._fetchInProgress = false; d._writeInProgress = false; d._failureCount = 0;
  d._prevDeviceStatus = null; d._controlPollCounter = 1; d._pvStringCount = 2;
  d._powerHistory = [];
  d.log = () => {}; d.error = () => {};
  d.getName = () => 'Inverter';
  d.getSetting = (k) => ({ address: '10.0.0.5', port: 502, modbus_id: 1, enable_timeline_notifications: false }[k]);
  d.getAvailable = () => true;
  d.setAvailable = async () => {};
  d.setUnavailable = async () => {};
  d.hasCapability = (c) => c in d.caps;
  d.getCapabilityValue = (c) => (c in d.caps ? d.caps[c] : null);
  d.addCapability = async (c) => { d.caps[c] = null; };
  d.removeCapability = async (c) => { d.removed.push(c); delete d.caps[c]; };
  d._set = async (c, v) => { if (v !== null && v !== undefined) d.caps[c] = v; };
  d._fetchControl = async () => {};
  d.homey = {
    __: (k) => k,
    flow: { getDeviceTriggerCard: (id) => ({ trigger: async (dev, tokens) => { d.fired.push({ id, ...tokens }); } }) },
    notifications: { createNotification: async () => {} },
  };
  return d;
}

test('a poll cut short by a write keeps the grid meter, the optimizers and the PV power', async () => {
  answers = { main: { values: {}, unread: 'all' }, meter: { values: {}, unread: 'all' } };
  const d = inverter();
  await d._fetchAndUpdate();
  assert.deepStrictEqual(d.removed, [], 'capabilities removed because a write cut the poll short');
  assert.strictEqual(d.caps.measure_power, 4200, 'PV published as 0 W from a value never read');
  assert.ok(!d.fired.some((f) => f.id === 'modbus_power_changed'), '"power changed" fired for a reading that never happened');
  assert.deepStrictEqual(d._powerHistory, [], 'a 0 went into the history behind "power above … for N minutes"');
});

test('…while an inverter that answers "no such register" still loses them, as before', async () => {
  // No grid meter connected, no optimizers: absent, not unread.
  answers = { main: { values: { inputPower: 3000, totalOptimizers: 0 } }, meter: { values: {} } };
  const d = inverter();
  await d._fetchAndUpdate();
  for (const c of [...METER_CAPS, ...OPT_CAPS]) assert.ok(d.removed.includes(c), `${c} was kept on hardware without it`);
  assert.strictEqual(d.caps.measure_power, 3000);
  assert.ok(d.fired.some((f) => f.id === 'modbus_power_changed' && f.power === 3000));
});

test('a real reading of 0 W is still 0 W', async () => {
  answers = { main: { values: { inputPower: 0, totalOptimizers: 4, onlineOptimizers: 4 } }, meter: { values: { powerMeterActivePower: 500 } } };
  const d = inverter();
  await d._fetchAndUpdate();
  assert.strictEqual(d.caps.measure_power, 0);
  assert.deepStrictEqual(d.removed, []);
});
