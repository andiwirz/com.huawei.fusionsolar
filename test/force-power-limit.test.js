'use strict';

// Force charge and discharge cards clamp to the battery's configured limit — and 0 means 0
// (1.2.276).
//
// Issue #31: Gerhard runs his battery with max discharge power at 0 W, discharging blocked.
// The force cards read the limit as `getSetting(...) || 5000`, and 0 is falsy, so his block
// became a 5 kW ceiling: a forced discharge would have gone ahead at whatever the card asked,
// up to 5000 W. The answer to #31 promised this as its own fix.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const en = require(path.join(ROOT, 'locales', 'en.json'));
const t = (key) => key.split('.').reduce((o, k) => o[k], en);

const writes = [];
const record = async (host, port, unit, reg, value) => { writes.push({ reg, value }); };
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

function makeDevice(settings) {
  const d = Object.create(LunaDevice.prototype);
  d.settings = { address: '192.0.2.10', port: 502, modbus_id: 1, enable_timeline_notifications: false, ...settings };
  d.cards = {};
  const card = (id) => ({ registerRunListener(fn) { d.cards[id] = fn; return this; }, registerArgumentAutocompleteListener() { return this; }, trigger: async () => {} });
  d.homey = {
    __: (k) => t(k),
    flow: { getActionCard: card, getConditionCard: card, getDeviceTriggerCard: card },
    notifications: { createNotification: async () => {} },
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
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const powerWrites = (reg) => writes.filter((w) => w.reg === reg).map((w) => w.value);

test('a discharge limit of 0 refuses every forced discharge, and writes nothing', async () => {
  for (const [id, args] of [
    ['luna2000_start_force_discharge', { power: 3000, target_soc: 20 }],
    ['luna2000_start_force_discharge_duration', { power: 3000, duration: 30 }],
    ['luna2000_set_force_discharge_power', { power: 3000 }],
  ]) {
    writes.length = 0;
    const d = makeDevice({ max_discharge_power: 0 });
    assert.throws(() => d.cards[id](args), { message: t('modbus.battery.dischargeBlocked') }, id);
    await settle();
    assert.deepStrictEqual(writes, [], `${id} still wrote to the battery`);
  }
});

test('a charge limit of 0 refuses every forced charge', async () => {
  for (const [id, args] of [
    ['luna2000_start_force_charge', { power: 3000, target_soc: 80 }],
    ['luna2000_start_force_charge_duration', { power: 3000, duration: 30 }],
    ['luna2000_set_force_charge_power', { power: 3000 }],
  ]) {
    writes.length = 0;
    const d = makeDevice({ max_charge_power: 0 });
    assert.throws(() => d.cards[id](args), { message: t('modbus.battery.chargeBlocked') }, id);
    await settle();
    assert.deepStrictEqual(writes, [], `${id} still wrote to the battery`);
  }
});

test('a limit above 0 caps what the card asks for', async () => {
  writes.length = 0;
  const d = makeDevice({ max_discharge_power: 2500, max_charge_power: 4000 });
  d.cards.luna2000_start_force_discharge({ power: 6000, target_soc: 20 });
  d.cards.luna2000_start_force_charge({ power: 1500, target_soc: 90 });
  await settle();
  assert.deepStrictEqual(powerWrites(47249), [2500]);
  assert.deepStrictEqual(powerWrites(47247), [1500], 'a power below the limit was changed');
});

test('a limit not read yet leaves the ceiling to the battery, instead of inventing 5000', async () => {
  writes.length = 0;
  const d = makeDevice({});
  d.cards.luna2000_set_force_discharge_power({ power: 7000 });
  await settle();
  assert.deepStrictEqual(powerWrites(47249), [7000]);
});

test('no 5 kW fallback is left in the battery driver, and the refusals are translated', () => {
  // Code, not the comment that records what the code used to say.
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'drivers', 'luna2000_modbus', 'device.js'), 'utf8'), /getSetting\([^)]*\)\s*\|\|\s*5000/);
  for (const lang of ['en', 'de', 'nl']) {
    const b = require(path.join(ROOT, 'locales', `${lang}.json`)).modbus.battery;
    assert.ok(b.chargeBlocked && b.dischargeBlocked, lang);
  }
});
