'use strict';

// "Set grid-tied power limit" — register 47079 (1.2.290).
//
// The card wrote a register no Huawei list in the repository contained, and its tooltip
// described an effect nobody could source. The register is row 91 of Huawei's Solar Inverter
// Modbus Interface Definitions V3.0: "[Energy storage unit] Power limit of the grid-tied
// point", I32, W, gain 1, [0, Pmax], default Pmax, supported only by certain models. Two flows
// use the card (Flow Card Usage, 2026-10-09), so it stays: the tooltip now says what the
// table says and no more, and the card writes to the battery the flow names.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const app  = require(path.join(ROOT, 'app.json'));

const writes = [];
const record = async (host, port, unit, reg, value) => { writes.push({ host, port, unit, reg, value }); };
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

function battery(settings) {
  const d = Object.create(LunaDevice.prototype);
  d.settings = { port: 502, modbus_id: 1, ...settings };
  d.cards = {};
  const card = (id) => ({ registerRunListener(fn) { d.cards[id] = fn; return this; }, registerArgumentAutocompleteListener() { return this; }, trigger: async () => {} });
  d.homey = { __: (k) => k, flow: { getActionCard: card, getConditionCard: card, getDeviceTriggerCard: card }, notifications: { createNotification: async () => {} } };
  d.getName = () => 'Battery';
  d.getSetting = (k) => d.settings[k];
  d.log = () => {};
  d.error = () => {};
  d._registerFlowActions();
  return d;
}
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

test('the card writes 47079 on the battery the flow names', async () => {
  const registering = battery({ address: '192.0.2.1' });
  const named = battery({ address: '192.0.2.77', modbus_id: 3 });
  writes.length = 0;
  registering.cards.luna2000_set_power_limit_grid({ device: named, power: 7499.6 });
  await settle();
  assert.deepStrictEqual(writes, [{ host: '192.0.2.77', port: 502, unit: 3, reg: 47079, value: 7500 }]);
  assert.strictEqual(named._writeInProgress, false);
});

test('a negative power is written as 0 — the range starts there', async () => {
  const d = battery({ address: '192.0.2.5' });
  writes.length = 0;
  d.cards.luna2000_set_power_limit_grid({ device: d, power: -100 });
  await settle();
  assert.strictEqual(writes[0].value, 0);
});

test('the tooltip names the source and the range, and claims no effect the table does not', () => {
  const c = app.flow.actions.find((x) => x.id === 'luna2000_set_power_limit_grid');
  for (const l of ['en', 'de', 'nl']) {
    assert.match(c.hint[l], /Power limit of the grid-tied point/, l);
    assert.match(c.hint[l], /Interface Definitions V3\.0/, l);
    assert.match(c.hint[l], /Pmax/, l);
  }
  assert.doesNotMatch(c.hint.en, /total system power flow/, 'the unsourced claim is back');
});
