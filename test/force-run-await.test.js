'use strict';

// The forced charge/discharge cards wait for their writes, as the Home Assistant integration
// does (1.2.309, Andi's choice after the review of 2026-10-10).
//
// HA's services await every register, and an HA script starts its next action only when the
// service returned — a stop is complete before the start behind it begins. These cards
// handed Homey "done" at once and wrote in the background, so the next card of the same flow
// started while the previous one was still writing, and the two sequences took turns on the
// Modbus queue register by register. With the real code, "stop" then "discharge until 20 %"
// ended on 47246 = 0 and 47083 = 0 — a run of zero minutes — and "charge until 90 %" then
// "stop" ended on 47100 = 1, charging after the stop.
//
// The write sequences of each card are pinned in test/fixtures/flow-action-golden.json and in
// test/force-run-ha.test.js; this file is about time: when a card is done, what it does when
// a write fails, and that two sequences never take turns.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const en = require(path.join(ROOT, 'locales', 'en.json'));
const t = (key) => key.split('.').reduce((o, k) => o[k], en);

let writes = [];
let failAt = null;          // register whose write throws
// Every write takes a turn of the event loop, as a real one takes a round trip. Without
// that the sequences could not interleave even when nothing keeps them apart.
const record = async (host, port, unit, reg, value) => {
  await new Promise((r) => setImmediate(r));
  if (reg === failAt) throw new Error('timeout');
  writes.push([reg, value]);
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  if (request === '../../lib/modbus-client') {
    const real = origLoad.call(this, request, parent, isMain);
    return { ...real, writeModbusRegister: record, writeModbusU32: record };
  }
  return origLoad.call(this, request, parent, isMain);
};
const LunaDevice = require(path.join(ROOT, 'drivers', 'luna2000_modbus', 'device.js'));
Module._load = origLoad;

function makeDevice() {
  const d = Object.create(LunaDevice.prototype);
  d.settings = { address: '192.0.2.10', port: 502, modbus_id: 1, enable_timeline_notifications: true,
    max_charge_power: 5000, max_discharge_power: 5000 };
  d.cards = {};
  d.notes = [];
  d.caps = {};
  const card = (id) => ({ registerRunListener(fn) { d.cards[id] = fn; return this; }, registerArgumentAutocompleteListener() { return this; }, trigger: async () => {} });
  d.homey = {
    __: (k) => t(k),
    flow: { getActionCard: card, getConditionCard: card, getDeviceTriggerCard: card },
    notifications: { createNotification: async (n) => { d.notes.push(n.excerpt); } },
    setTimeout: () => null, clearTimeout() {},
  };
  d.getName = () => 'Battery';
  d.getSetting = (k) => d.settings[k];
  d.setSettings = async (o) => { Object.assign(d.settings, o); };
  d.getCapabilityValue = () => null;
  d.hasCapability = () => true;
  d._set = async (c, v) => { d.caps[c] = v; };
  d.log = () => {};
  d.error = () => {};
  d._registerFlowActions();
  return d;
}
const fresh = () => { writes = []; failAt = null; return makeDevice(); };
const run = (d, id, args = {}) => d.cards[id]({ device: d, ...args });
const regs = () => writes.map((w) => w[0]);

const STOP = 'luna2000_stop_force_charge_discharge';
const STOP_WRITES = [[47100, 0], [47249, 0], [47083, 0], [47246, 0]];

test('a card is done only once its last register is written', async () => {
  for (const [id, args, last] of [
    ['luna2000_start_force_charge', { power: 3000, target_soc: 90 }, [47100, 1]],
    ['luna2000_start_force_discharge', { power: 3000, target_soc: 20 }, [47100, 2]],
    ['luna2000_start_force_charge_duration', { power: 3000, duration: 30 }, [47100, 1]],
    ['luna2000_start_force_discharge_duration', { power: 3000, duration: 30 }, [47100, 2]],
    [STOP, {}, [47246, 0]],
    ['luna2000_set_force_charge_discharge', { mode: '2' }, [47100, 2]],
    ['luna2000_set_force_discharge_power', { power: 3000 }, [47249, 3000]],
  ]) {
    const d = fresh();
    const done = run(d, id, args);
    assert.ok(done && typeof done.then === 'function', `${id} does not hand Homey anything to wait for`);
    await done;
    assert.deepStrictEqual(writes[writes.length - 1], last, `${id} reported done before its last write`);
  }
});

test('stop, then start, in one flow: the start runs after the stop, every register of it', async () => {
  const d = fresh();
  await run(d, STOP);
  await run(d, 'luna2000_start_force_discharge', { power: 3000, target_soc: 20 });
  assert.deepStrictEqual(writes, [...STOP_WRITES, [47101, 200], [47249, 3000], [47246, 1], [47100, 2]]);
});

test('two cards fired at once — two flows, or a Homey that stopped waiting — never take turns', async () => {
  // The three cases the review simulated, now fired without waiting for each other: the
  // battery hears all of the first, then all of the second.
  const SEQ = {
    [STOP]: STOP_WRITES,
    discharge20: [[47101, 200], [47249, 3000], [47246, 1], [47100, 2]],
    charge30min: [[47247, 3000], [47083, 30], [47246, 0], [47100, 1]],
    charge90: [[47101, 900], [47247, 3000], [47246, 1], [47100, 1]],
  };
  const CARD = {
    discharge20: ['luna2000_start_force_discharge', { power: 3000, target_soc: 20 }],
    charge30min: ['luna2000_start_force_charge_duration', { power: 3000, duration: 30 }],
    charge90: ['luna2000_start_force_charge', { power: 3000, target_soc: 90 }],
    [STOP]: [STOP, {}],
  };
  for (const [first, second] of [[STOP, 'discharge20'], [STOP, 'charge30min'], ['charge90', STOP]]) {
    const d = fresh();
    await Promise.all([run(d, ...CARD[first]), run(d, ...CARD[second])]);
    assert.deepStrictEqual(writes, [...SEQ[first], ...SEQ[second]], `${first} → ${second}: the two runs took turns`);
  }
});

test('a write that fails fails the card, with the register, and says so on the timeline', async () => {
  const d = fresh();
  failAt = 47249;
  await assert.rejects(run(d, 'luna2000_start_force_discharge', { power: 3000, target_soc: 20 }),
    /Force discharge not started: could not set the discharge power \(register 47249\): timeout/);
  assert.ok(!regs().includes(47100), 'started although a step failed');
  assert.strictEqual(d.notes.length, 1);
  assert.match(d.notes[0], /Force discharge NOT started/);
});

test('a failed run does not hold up the next one', async () => {
  const d = fresh();
  failAt = 47247;
  const first = run(d, 'luna2000_start_force_charge', { power: 3000, target_soc: 90 });
  const second = run(d, STOP);
  await assert.rejects(first);
  failAt = null;
  await second;
  assert.deepStrictEqual(writes.slice(-4), STOP_WRITES);
});

test('a stop that cannot be sent fails the card and warns that the run may still be going', async () => {
  const d = fresh();
  failAt = 47100;
  await assert.rejects(run(d, STOP), /Force stop not sent: could not write the stop command \(register 47100\)/);
  assert.deepStrictEqual(writes, [], 'cleared the values of a run that is still going');
  assert.strictEqual(d.notes.length, 1);
  assert.match(d.notes[0], /Force stop NOT sent .* may still be running/);
  assert.notStrictEqual(d.caps.storage_force_charge_discharge, '0', 'the tile says stopped although nothing was sent');
});

test('the busy flag is down once a run is through, failed or not', async () => {
  const d = fresh();
  await run(d, 'luna2000_start_force_charge_duration', { power: 3000, duration: 5 });
  assert.strictEqual(d._writeInProgress, false);
  failAt = 47083;
  await assert.rejects(run(d, 'luna2000_start_force_charge_duration', { power: 3000, duration: 5 }));
  assert.strictEqual(d._writeInProgress, false);
});
