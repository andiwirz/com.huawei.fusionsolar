'use strict';

// The off-grid card, rebuilt as one confirmed action (1.2.289).
//
// "Set backup off-grid switch" offered Disabled (0) and Enabled (1) for register 47604. Huawei
// documents one value for it — 0, "Switch from grid-tied to off-grid" (SPC177, p. 77) — so the
// card sent the off-grid command for "Disabled", and an undocumented 1 for "Enabled". It was
// also fire-and-forget on whichever battery registered the listener last. Flow-card usage
// shows no flow using it. Now: "Switch to off-grid operation" sends only that documented
// command, only with a confirmation ticked, to the battery the flow names, and fails the flow
// if the write fails. The old card is deprecated and sends nothing.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const app  = require(path.join(ROOT, 'app.json'));
const en   = require(path.join(ROOT, 'locales', 'en.json'));
const t    = (key) => key.split('.').reduce((o, k) => o[k], en);
const SPEC = require(path.join(ROOT, 'lib', 'modbus-spec-registers.js'));

let writes = [];
let failWith = null;
const record = async (host, port, unit, reg, value) => {
  if (failWith) throw failWith;
  writes.push({ host, port, unit, reg, value });
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

function battery(settings = {}) {
  const d = Object.create(LunaDevice.prototype);
  d.settings = { address: '192.0.2.10', port: 502, modbus_id: 1, enable_timeline_notifications: true, ...settings };
  d.cards = {};
  d.notes = [];
  const card = (id) => ({ registerRunListener(fn) { d.cards[id] = fn; return this; }, registerArgumentAutocompleteListener() { return this; }, trigger: async () => {} });
  d.homey = {
    __: (k) => t(k),
    flow: { getActionCard: card, getConditionCard: card, getDeviceTriggerCard: card },
    notifications: { createNotification: async ({ excerpt }) => { d.notes.push(excerpt); } },
    setTimeout: () => null, clearTimeout() {},
  };
  d.getName = () => 'Battery';
  d.getSetting = (k) => d.settings[k];
  d.setSettings = async (o) => { Object.assign(d.settings, o); };
  d.getCapabilityValue = () => null;
  d.hasCapability = () => true;
  d._set = async () => {};
  d.log = () => {};
  d.error = () => {};
  d._registerFlowActions();
  return d;
}
const card = (id) => app.flow.actions.find((c) => c.id === id);

// ── the manifest ──────────────────────────────────────────────────────────────────

test('the new card asks for a confirmation and warns in every language', () => {
  const c = card('luna2000_switch_to_offgrid');
  assert.ok(c, 'the card is missing');
  assert.strictEqual(c.args.find((a) => a.type === 'device').filter, 'driver_id=luna2000_modbus');
  const confirm = c.args.find((a) => a.name === 'confirm');
  assert.strictEqual(confirm.type, 'checkbox');
  for (const l of ['en', 'de', 'nl']) {
    assert.match(c.hint[l], /^⚠️/, `${l}: no warning sign`);
    assert.match(c.hint[l], /47604 = 0/, l);
    assert.ok(c.titleFormatted[l].includes('[[confirm]]'), `${l}: the confirmation is not in the sentence`);
  }
});

test('the old card is deprecated and says it sends nothing', () => {
  const c = card('luna2000_set_backup_offgrid');
  assert.strictEqual(c.deprecated, true);
  for (const l of ['en', 'de', 'nl']) assert.match(c.hint[l], /47604 = 0/, l);
  assert.match(c.hint.en, /^Retired — sends nothing\./);
});

test('47604 is the register Huawei documents as the switch to off-grid', () => {
  const row = SPEC.BATTERY_SPEC_REGISTERS.find((r) => r.address === 47604);
  assert.ok(row, '47604 is gone from the specification list');
  assert.match(row.label, /Switch to off-grid/);
});

// ── what the cards do ─────────────────────────────────────────────────────────────

test('the old card writes nothing, whichever value its flow still carries', async () => {
  const d = battery();
  writes = [];
  for (const mode of ['0', '1']) {
    await assert.rejects(d.cards.luna2000_set_backup_offgrid({ device: d, mode }), new RegExp('This card is retired'));
  }
  assert.deepStrictEqual(writes, []);
});

test('without the confirmation nothing is sent', async () => {
  const d = battery();
  writes = [];
  for (const confirm of [false, undefined, 'true']) {
    await assert.rejects(d.cards.luna2000_switch_to_offgrid({ device: d, confirm }), /Not sent/);
  }
  assert.deepStrictEqual(writes, []);
});

test('confirmed, it writes 0 to 47604 — on the battery the flow names', async () => {
  const registering = battery({ address: '192.0.2.1' });
  const named = battery({ address: '192.0.2.99', port: 6607, modbus_id: 2 });
  writes = [];
  await registering.cards.luna2000_switch_to_offgrid({ device: named, confirm: true });
  assert.deepStrictEqual(writes, [{ host: '192.0.2.99', port: 6607, unit: 2, reg: 47604, value: 0 }]);
  assert.deepStrictEqual(named.notes, ['Battery: ' + t('modbus.battery.offgridSent')]);
  assert.deepStrictEqual(registering.notes, [], 'the registering battery claimed the command');
});

test('a failed write fails the flow, and posts no "sent"', async () => {
  const d = battery();
  failWith = new Error('Modbus exception 2');
  try {
    await assert.rejects(d.cards.luna2000_switch_to_offgrid({ device: d, confirm: true }), /Modbus exception 2/);
  } finally {
    failWith = null;
  }
  assert.deepStrictEqual(d.notes, []);
  assert.strictEqual(d._writeInProgress, false, 'polling stays paused after a failed write');
});

test('the timeline note follows the notification switch', async () => {
  const d = battery({ enable_timeline_notifications: false });
  await d.cards.luna2000_switch_to_offgrid({ device: d, confirm: true });
  assert.deepStrictEqual(d.notes, []);
});
