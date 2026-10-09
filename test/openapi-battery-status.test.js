'use strict';

// The FusionSolar cloud battery and the Modbus battery share one status (1.2.281).
//
// The cloud battery had a status of its own, openapi_battery_status, that no flow card could
// react to — the "Battery unit status changed" trigger and the "… status is" condition were
// filtered to the Modbus driver — and it used other words for two of the same Huawei codes:
// "Faulty" and "Hibernating" where Modbus says "Fault" and "Sleep mode". The developer note
// listed it as C1; "Full"/"Empty" in its state text, never translated, as C2.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const app  = require(path.join(ROOT, 'app.json'));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  return origLoad.call(this, request, parent, isMain);
};
const CloudBattery  = require(path.join(ROOT, 'drivers', 'luna2000_openapi_fusionsolar', 'device.js'));
const ModbusBattery = require(path.join(ROOT, 'drivers', 'luna2000_modbus', 'device.js'));
Module._load = origLoad;

const TYPE_BATTERY = 39;
const STRINGS = { de: { 'modbus.battery.state.full': 'Voll', 'modbus.battery.state.empty': 'Leer' } };

function cloudBattery({ lang = 'de' } = {}) {
  const d = Object.create(CloudBattery.prototype);
  d.values = {};
  d.notes  = [];
  d.fired  = [];
  d.cards  = {};
  d.caps   = new Set(['measure_power', 'measure_battery', 'luna2000_battery_status', 'battery_state_string']);
  d._prevSoc = null; d._prevChargingState = null; d._prevBatteryMode = null; d._prevBatteryStatus = null;
  d.log = () => {};
  d.getName = () => 'Cloud battery';
  d.getSetting = () => null;
  d.hasCapability = (c) => d.caps.has(c);
  d.addCapability = async (c) => { d.caps.add(c); };
  d.removeCapability = async (c) => { d.caps.delete(c); };
  d.getCapabilityValue = (c) => (c in d.values ? d.values[c] : null);
  d._set = async (c, v) => { if (v !== null && v !== undefined && d.caps.has(c)) d.values[c] = v; };
  const card = (id) => ({
    trigger: async (device, tokens, state) => { d.fired.push({ id, tokens, state }); },
    registerRunListener(fn) { d.cards[id] = fn; return this; },
  });
  d.homey = {
    __: (k) => (STRINGS[lang] || {})[k] || k,
    notifications: { createNotification: async ({ excerpt }) => { d.notes.push(excerpt); } },
    flow: { getDeviceTriggerCard: card, getConditionCard: card },
  };
  return d;
}
const poll = (d, kpi) => d.onPollData({ kpiByType: { [TYPE_BATTERY]: [{ ch_discharge_power: 0, battery_soc: 60, battery_status: 2, ...kpi }] } });

// ── one capability ──────────────────────────────────────────────────────────────

test('the cloud battery writes the shared status, and drops its own on the next start', () => {
  const src = read('drivers/luna2000_openapi_fusionsolar/device.js');
  const list = (name) => src.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`))[1].replace(/\/\/.*$/gm, '');
  assert.match(list('EXTRA_CAPABILITIES'), /'luna2000_battery_status'/);
  assert.doesNotMatch(list('EXTRA_CAPABILITIES'), /'openapi_battery_status'/);
  assert.match(list('DEPRECATED_CAPABILITIES'), /'openapi_battery_status'/, 'paired devices keep the old status tile for ever');
});

test('it says what the Modbus battery says, for the same Huawei codes', async () => {
  const words = [];
  for (const code of [0, 1, 2, 3, 4]) {
    const d = cloudBattery();
    await poll(d, { battery_status: code });
    words.push(d.values.luna2000_battery_status);
  }
  assert.deepStrictEqual(words, ['Offline', 'Standby', 'Running', 'Fault', 'Sleep mode']);
  const modbus = read('drivers/luna2000_modbus/device.js').match(/const UNIT1_STATUS_MAP = \{([\s\S]*?)\};/)[1];
  assert.deepStrictEqual([...modbus.matchAll(/'([^']+)'/g)].map((m) => m[1]), words, 'the two drivers name the codes differently again');
});

// ── the cards ───────────────────────────────────────────────────────────────────

test('both status cards are offered for both battery drivers, with exactly these words', () => {
  for (const id of ['luna2000_battery_status_changed', 'luna2000_battery_status_is']) {
    const c = [...app.flow.triggers, ...app.flow.conditions].find((x) => x.id === id);
    const filter = c.args.find((a) => a.type === 'device').filter;
    assert.ok(filter.includes('driver_id=luna2000_modbus') && filter.includes('driver_id=luna2000_openapi_fusionsolar'), `${id}: ${filter}`);
    assert.deepStrictEqual(c.args.find((a) => a.name === 'status').values.map((v) => v.id), ['Offline', 'Standby', 'Running', 'Fault', 'Sleep mode']);
  }
});

test('a status change fires the shared trigger — the first reading after a start does not', async () => {
  const d = cloudBattery();
  await poll(d, { battery_status: 2 });
  assert.deepStrictEqual(d.fired.filter((f) => f.id === 'luna2000_battery_status_changed'), []);
  await poll(d, { battery_status: 3 });
  const fired = d.fired.filter((f) => f.id === 'luna2000_battery_status_changed');
  assert.deepStrictEqual(fired.map((f) => [f.tokens.status, f.state.status]), [['Fault', 'Fault']]);
  // The trigger's own listener compares the dropdown with the state it was fired with.
  const modbus = Object.create(ModbusBattery.prototype);
  modbus.homey = d.homey;
  modbus._registerConditions();
  assert.strictEqual(d.cards.luna2000_battery_status_changed({ status: 'Fault' }, fired[0].state), true);
  assert.strictEqual(d.cards.luna2000_battery_status_changed({ status: 'Running' }, fired[0].state), false);
});

test('the condition reads the device the flow picked, whichever driver registered it last', () => {
  const cloud = cloudBattery();
  const other = { getCapabilityValue: (c) => (c === 'luna2000_battery_status' ? 'Standby' : null) };
  const mine  = { getCapabilityValue: (c) => (c === 'luna2000_battery_status' ? 'Running' : null) };

  cloud._registerConditionListeners();
  assert.strictEqual(cloud.cards.luna2000_battery_status_is({ device: mine, status: 'Running' }), true);
  assert.strictEqual(cloud.cards.luna2000_battery_status_is({ device: other, status: 'Running' }), false);

  const modbus = Object.create(ModbusBattery.prototype);
  modbus.homey = cloud.homey;
  modbus.getCapabilityValue = () => 'Fault'; // the registering device — must not be the one asked
  modbus._registerConditions();
  assert.strictEqual(cloud.cards.luna2000_battery_status_is({ device: mine, status: 'Running' }), true,
    'the Modbus listener answered for itself instead of for the device in the flow');
});

// ── the state text ──────────────────────────────────────────────────────────────

test('"Full" and "Empty" are said in the user\'s language', async () => {
  const full = cloudBattery();
  await poll(full, { battery_soc: 100, ch_discharge_power: 0 });
  assert.strictEqual(full.values.battery_state_string, 'Voll (100%)');
  const empty = cloudBattery();
  await poll(empty, { battery_soc: 3, ch_discharge_power: 0 });
  assert.strictEqual(empty.values.battery_state_string, 'Leer (3%)');
});

// ── the widget ──────────────────────────────────────────────────────────────────

test('the battery widget reads the shared status from the cloud battery', () => {
  const src = read('widgets/battery-status/api.js');
  assert.ok(src.indexOf("cap(lunaOa, 'luna2000_battery_status', null)") > 0, 'the widget still looks only for the old status');
  assert.ok(src.indexOf("cap(lunaOa, 'luna2000_battery_status', null)") < src.indexOf("cap(lunaOa, 'openapi_battery_status', null)"),
    'the old status is asked first and can shadow the new one');
});
