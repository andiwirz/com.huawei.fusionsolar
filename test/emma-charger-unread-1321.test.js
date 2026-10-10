'use strict';

// The EMMA charger and the voltages it was not given (review 2026-10-10, 1.2.321).
//
// This charger has no register that says "a cable is plugged in"; the state is derived from
// the phase voltages. A voltage that was not read — a poll cut short by a flow card writing to
// another device on the same EMMA, a batch that timed out — came back null, and `?? 0` made
// it 0 V. In the middle of a charge that read as the car being unplugged: "charging stopped"
// fired, the session ended, and the next poll started both again.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

const realClient = require(path.join('..', 'lib', 'modbus-client.js'));

// Each poll hands out the next canned read.
let reads = [];
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  if (request === '../../lib/modbus-client') {
    return { ...realClient, readModbusRegisters: async () => reads.shift() };
  }
  return origLoad.call(this, request, parent, isMain);
};
const ChargerDevice = require(path.join('..', 'drivers', 'smartcharger_emma_modbus', 'device.js'));
Module._load = origLoad;

// A read result shaped as the real client returns it: values, plus the non-enumerable set of
// registers that were not read.
function read({ volts = [230, 231, 229], kwh = 100, unread = [] } = {}) {
  const r = {
    offeringName: 'SCharger-7KS-S0', ratedPower: 7.4,
    phaseAVoltage: volts[0], phaseBVoltage: volts[1], phaseCVoltage: volts[2],
    totalEnergyCharged: kwh, chargerTemperature: 31,
  };
  for (const k of unread) r[k] = null;
  Object.defineProperty(r, 'unread', { value: new Set(unread), enumerable: false });
  return r;
}
const CUT = ['phaseAVoltage', 'phaseBVoltage', 'phaseCVoltage', 'totalEnergyCharged', 'chargerTemperature'];

function fakeCharger() {
  const d = Object.create(ChargerDevice.prototype);
  d.values = {};
  d.fired = [];
  d.logs = [];
  d.store = {};
  d._failureCount = 0;
  d._prevChargingState = null;
  d._lastPollStart = 0;
  d._sessionStartedAt = null;
  d._sessionMeterStartKwh = null;
  d._lastMeterKwh = null;
  d._lastMeterAt = null;
  d._powerEstW = 0;
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = () => {};
  d.getName = () => 'EMMA charger';
  d.getSetting = (k) => ({ address: '192.168.1.10', port: 502, modbus_id: 0 }[k]);
  d.getAvailable = () => true;
  d.setAvailable = async () => {};
  d.setUnavailable = async () => {};
  d.hasCapability = () => true;
  d.getCapabilityValue = (c) => d.values[c] ?? null;
  d._set = async (c, v) => { if (v !== null && v !== undefined) d.values[c] = v; };
  d.getStoreValue = (k) => d.store[k];
  d.setStoreValue = async (k, v) => { d.store[k] = v; };
  d.homey = {
    __: (k) => k,
    flow: { getDeviceTriggerCard: (id) => ({ trigger: async () => { d.fired.push(id); } }) },
  };
  d.poll = async (...results) => {
    for (const r of results) { reads.push(r); await d._fetchAndUpdate(); }
  };
  return d;
}

const sessionsStarted = (d) => d.logs.filter((l) => /Session started/.test(l)).length;

test('a poll that did not read the voltages does not end a charge', async () => {
  const d = fakeCharger();
  await d.poll(read(), read({ kwh: 100.1 }));
  const startedAt = d._sessionStartedAt;
  assert.ok(startedAt);
  await d.poll(read({ unread: CUT }));                  // cut short by a write elsewhere
  assert.deepStrictEqual(d.fired, [], 'a trigger fired on a poll that read nothing about the car');
  assert.strictEqual(d.values.evcharger_charging_state, 'plugged_in_charging');
  assert.strictEqual(d.values.evcharger_charging, true);
  assert.strictEqual(d._sessionStartedAt, startedAt, 'the session was ended');
  await d.poll(read({ kwh: 100.3 }));
  assert.deepStrictEqual(d.fired, [], 'no "stopped", no "started" — one charge');
  assert.strictEqual(sessionsStarted(d), 1, 'one charge, two sessions');
});

test('only the voltages decide — a cut that spared one live phase is still a charge', async () => {
  const d = fakeCharger();
  await d.poll(read());
  await d.poll(read({ volts: [230, null, null], unread: ['phaseBVoltage', 'phaseCVoltage'] }));
  assert.strictEqual(d.values.evcharger_charging_state, 'plugged_in_charging');
  assert.deepStrictEqual(d.fired, []);
});

test('a car plugged in during a cut poll is seen at once if one phase was read live', async () => {
  const d = fakeCharger();
  await d.poll(read({ volts: [0, 0, 0] }));
  await d.poll(read({ volts: [230, null, null], unread: ['phaseBVoltage', 'phaseCVoltage'] }));
  assert.strictEqual(d.values.evcharger_charging_state, 'plugged_in_charging',
    'a live phase was overruled by the two that were not read');
  assert.deepStrictEqual(d.fired, ['smartcharger_charging_started']);
});

test('an idle charger stays idle across a cut poll — it is not "started" either', async () => {
  const d = fakeCharger();
  await d.poll(read({ volts: [0, 0, 0] }), read({ unread: CUT }), read({ volts: [0, 0, 0] }));
  assert.strictEqual(d.values.evcharger_charging_state, 'plugged_out');
  assert.deepStrictEqual(d.fired, []);
  assert.strictEqual(d.values.measure_power, 0);
});

test('a real unplug is still seen, on the first poll that reads it', async () => {
  const d = fakeCharger();
  await d.poll(read(), read({ unread: CUT }), read({ volts: [0, 0, 0] }));
  assert.deepStrictEqual(d.fired, ['smartcharger_charging_stopped']);
  assert.strictEqual(d.values.evcharger_charging_state, 'plugged_out');
  assert.strictEqual(d._sessionStartedAt, null);
});

test('voltages that stay unread are given up on after three polls, and that is logged', async () => {
  const d = fakeCharger();
  await d.poll(read());
  await d.poll(read({ unread: CUT }), read({ unread: CUT }), read({ unread: CUT }));
  assert.deepStrictEqual(d.fired, [], 'three cut polls are still held');
  await d.poll(read({ unread: CUT }));
  assert.deepStrictEqual(d.fired, ['smartcharger_charging_stopped']);
  assert.ok(d.logs.some((l) => /Phase voltages not read for 4 polls — taking the charger as unplugged/.test(l)));
  // and a good read starts the count again
  await d.poll(read(), read({ unread: CUT }));
  assert.strictEqual(d.values.evcharger_charging_state, 'plugged_in_charging');
  assert.deepStrictEqual(d.fired, ['smartcharger_charging_stopped', 'smartcharger_charging_started']);
});

test('the first poll after a start that cannot read the voltages leaves the restored session alone', async () => {
  const d = fakeCharger();
  d._sessionStartedAt = Date.now() - 3600_000;           // restored from the store in onInit
  d._sessionMeterStartKwh = 90;
  d.store.mbSession = { startedAt: d._sessionStartedAt, meterStartKwh: 90 };
  await d.poll(read({ unread: CUT }));
  assert.ok(d._sessionStartedAt, 'nothing was known, and the session was ended anyway');
  assert.ok(d.store.mbSession);
  assert.strictEqual(d.values.evcharger_charging_state, undefined, 'a state was invented');
  await d.poll(read({ kwh: 100.2 }));
  assert.strictEqual(d.values.evcharger_charging_state, 'plugged_in_charging');
  assert.strictEqual(sessionsStarted(d), 0, 'the restored session goes on rather than a new one');
});

test('while the state is not known yet, the power the meter does show is not zeroed', async () => {
  // Only the voltages are missing: the lifetime counter moves, and that is a measurement.
  const d = fakeCharger();
  const volts = ['phaseAVoltage', 'phaseBVoltage', 'phaseCVoltage'];
  await d.poll(read({ kwh: 100, unread: volts }));
  d._lastMeterAt -= 30_000;                              // thirty seconds later …
  await d.poll(read({ kwh: 100.05, unread: volts }));   // … 50 Wh more
  assert.ok(d.values.measure_power > 5900 && d.values.measure_power <= 6000,
    `measure_power ${d.values.measure_power} W — 50 Wh in 30 s is 6 kW`);
});

test('a register the EMMA does not have still reads as 0 V, as before', async () => {
  // Exception 2 is "not there", not "not read": the client leaves it out of `unread`.
  const d = fakeCharger();
  await d.poll(read());
  await d.poll(read({ volts: [0, null, null] }));
  assert.strictEqual(d.values.evcharger_charging_state, 'plugged_out');
  assert.deepStrictEqual(d.fired, ['smartcharger_charging_stopped']);
});
