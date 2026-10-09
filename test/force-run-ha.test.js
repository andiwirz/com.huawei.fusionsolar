'use strict';

// Forced charging and discharging of the LUNA2000, the way the Home Assistant integration does
// it (1.2.302).
//
// wlcrs/huawei_solar writes a run's values, then the mode in 47246 (0 = for the minutes in
// 47083, 1 = to the target SoC in 47101), then the start command in 47100 — each step only
// after the one before succeeded. Its stop writes 47100 = 0 and clears the discharge power,
// the minutes and the mode. This app never wrote 47246, so each card ran in the mode the
// battery last had; Andi's LUNA2000 stands at 1, and there the minute cards ignored their
// minutes. A failed power or minutes write used to start the run anyway.
//
// The write sequences themselves are pinned in test/fixtures/flow-action-golden.json; this
// file covers what a recording of successful writes cannot: what happens when one fails.
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
let failAt = null;   // register whose write throws
const record = async (host, port, unit, reg, value) => {
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
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
async function run(cardId, args, failReg = null) {
  writes = []; failAt = failReg;
  const d = makeDevice();
  d.cards[cardId]({ device: d, ...args });
  await settle();
  failAt = null;
  return { d, regs: writes.map((w) => w[0]), writes };
}

test('every start card sets the mode its run needs, right before the start command', async () => {
  const cases = [
    ['luna2000_start_force_charge_duration', { power: 3000, duration: 30 }, 0, 1],
    ['luna2000_start_force_discharge_duration', { power: 3000, duration: 30 }, 0, 2],
    ['luna2000_start_force_charge', { power: 3000, target_soc: 80 }, 1, 1],
    ['luna2000_start_force_discharge', { power: 3000, target_soc: 20 }, 1, 2],
    ['luna2000_start_force_discharge_soc', { power: 3000, target_soc: 20 }, 1, 2],
  ];
  for (const [id, args, mode, cmd] of cases) {
    const { writes: w } = await run(id, args);
    assert.deepStrictEqual(w.slice(-2), [[47246, mode], [47100, cmd]], id);
  }
});

test('a failed step starts nothing — the minute cards included', async () => {
  for (const [id, args, failReg] of [
    ['luna2000_start_force_charge_duration', { power: 3000, duration: 30 }, 47083],
    ['luna2000_start_force_charge_duration', { power: 3000, duration: 30 }, 47247],
    ['luna2000_start_force_discharge_duration', { power: 3000, duration: 30 }, 47246],
    ['luna2000_start_force_charge', { power: 3000, target_soc: 80 }, 47247],
    ['luna2000_start_force_discharge', { power: 3000, target_soc: 20 }, 47101],
  ]) {
    const { regs, d } = await run(id, args, failReg);
    assert.ok(!regs.includes(47100), `${id}: started although ${failReg} failed`);
    assert.strictEqual(d.notes.length, 1, `${id}: the abort is not on the timeline`);
    assert.match(d.notes[0], /NOT started — could not set the /);
  }
});

test('"steuern" charges and discharges to the target SoC on every battery', async () => {
  for (const [mode, cmd] of [['1', 1], ['2', 2]]) {
    const { writes: w, d } = await run('luna2000_set_force_charge_discharge', { mode });
    assert.deepStrictEqual(w, [[47246, 1], [47100, cmd]]);
    assert.strictEqual(d.caps.storage_force_charge_discharge, mode);
  }
  const { regs } = await run('luna2000_set_force_charge_discharge', { mode: '1' }, 47246);
  assert.ok(!regs.includes(47100), 'started in a mode it could not set');
});

test('stop is HA\'s: stop first, then discharge power, minutes and mode cleared', async () => {
  const { writes: w, d } = await run('luna2000_set_force_charge_discharge', { mode: '0' });
  assert.deepStrictEqual(w, [[47100, 0], [47249, 0], [47083, 0], [47246, 0]]);
  assert.strictEqual(d.caps.storage_force_charge_discharge, '0');

  // A clean-up step that fails does not undo the stop, and the rest still goes out.
  const half = await run('luna2000_set_force_charge_discharge', { mode: '0' }, 47083);
  assert.deepStrictEqual(half.writes, [[47100, 0], [47249, 0], [47246, 0]]);

  // A stop that cannot be sent clears nothing: the run is still going on its values.
  const none = await run('luna2000_set_force_charge_discharge', { mode: '0' }, 47100);
  assert.deepStrictEqual(none.writes, []);
});

// HA's stop_forcible_charge as a card of its own (1.2.303) — before, a stop was an option in
// the dropdown of "Zwangsladen/Entladen steuern".
test('the stop card stops exactly as the "Stopp" option does', async () => {
  const card = await run('luna2000_stop_force_charge_discharge', {});
  const option = await run('luna2000_set_force_charge_discharge', { mode: '0' });
  assert.deepStrictEqual(card.writes, [[47100, 0], [47249, 0], [47083, 0], [47246, 0]]);
  assert.deepStrictEqual(card.writes, option.writes);
  assert.strictEqual(card.d.caps.storage_force_charge_discharge, '0');

  const app = require('../app.json');
  const c = app.flow.actions.find((x) => x.id === 'luna2000_stop_force_charge_discharge');
  assert.strictEqual(c.title.de, 'Zwangsladen/-entladen stoppen');
  assert.deepStrictEqual(c.args, [{ type: 'device', name: 'device', filter: 'driver_id=luna2000_modbus' }]);
  const steuern = app.flow.actions.find((x) => x.id === 'luna2000_set_force_charge_discharge');
  for (const l of ['en', 'de', 'nl']) {
    assert.match(c.hint[l], /47249/);
    assert.ok(c.hint[l].includes(steuern.title[l]), `the stop card's tooltip names the other card (${l})`);
  }
});

test('the cards\' tooltips say what they now write', () => {
  const app = require('../app.json');
  const hint = (id) => app.flow.actions.find((c) => c.id === id).hint;
  for (const id of ['luna2000_start_force_charge', 'luna2000_start_force_discharge',
    'luna2000_start_force_charge_duration', 'luna2000_start_force_discharge_duration', 'luna2000_set_force_charge_discharge']) {
    for (const l of ['en', 'de', 'nl']) assert.match(hint(id)[l], /47246/, `${id} ${l}`);
  }
  const title = (id) => app.flow.actions.find((c) => c.id === id).title;
  for (const l of ['en', 'de', 'nl']) {
    assert.match(hint('luna2000_set_force_charge_discharge')[l], /47249/, `the stop's clean-up is not named (${l})`);
    // the cards the tooltips point to, by the names they really carry
    assert.ok(hint('luna2000_set_force_charge_discharge')[l].includes(title('luna2000_set_force_charge_soc')[l]), `steuern → target SoC card (${l})`);
    assert.ok(hint('luna2000_set_force_discharge_power')[l].includes(title('luna2000_set_force_charge_discharge')[l]), `discharge power → steuern card (${l})`);
  }
});
