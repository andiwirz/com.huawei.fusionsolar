'use strict';

// Two battery settings that until 1.2.274 existed only as flow cards (LUNA2000 Modbus):
//
//   - the upper limit for charging from the grid, register 47244. The grid charge power
//     (47242) cannot exceed it, and the setting for 47242 sat right there without it;
//   - peak shaving, registers 47954 (mode) and 47955 (charge kept in reserve for it).
//
// Neither register was read before, and a setting that is not read shows its default rather
// than the battery's value — so all three now come round with the rare control read. The
// peak shaving mode is a dropdown without a tile, written through lib/mode-settings.js like
// the other modes. Huawei names its values 0 Disabled, 1 Active power limit, 2 Apparent power
// limit (not in single-device systems); the flow card had called 1 "SoC peak shaving" and
// left 2 out.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const app  = require(path.join(ROOT, 'app.json'));
const en   = require(path.join(ROOT, 'locales', 'en.json'));
const modes = require(path.join(ROOT, 'lib', 'mode-settings'));
const { CONTROL_REGISTERS } = require(path.join(ROOT, 'lib', 'modbus-registers'));

const writes = [];
const refuse = new Set();
const record = async (host, port, unit, reg, value) => {
  writes.push({ reg, value });
  if (refuse.has(reg)) { await new Promise((r) => setImmediate(r)); throw new Error('Timed out'); }
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

const LANGS = ['en', 'de', 'nl'];
const flat = (l) => (l || []).flatMap((x) => (x.type === 'group' ? flat(x.children) : [x]));
const groups = () => app.drivers.find((d) => d.id === 'luna2000_modbus').settings;
const setting = (id) => flat(groups()).find((s) => s.id === id);
const card = (id) => app.flow.actions.find((c) => c.id === id);
const t = (key) => key.split('.').reduce((o, k) => o[k], en);
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

function makeDevice(settings = {}) {
  const d = Object.create(LunaDevice.prototype);
  d.settings = { address: '192.0.2.10', port: 502, modbus_id: 1, enable_timeline_notifications: true, ...settings };
  d.settingWrites = [];
  d.caps = {};
  d.logs = [];
  d.notes = [];
  const c = () => ({ registerRunListener() { return this; }, registerArgumentAutocompleteListener() { return this; }, trigger: async () => {} });
  d.homey = {
    __: (k) => t(k),
    manifest: app,
    i18n: { getLanguage: () => 'en' },
    notifications: { createNotification: async (n) => { d.notes.push(n.excerpt); } },
    drivers: { getDriver: () => ({ getDevices: () => [] }) },
    flow: { getActionCard: c, getConditionCard: c, getDeviceTriggerCard: c, getTriggerCard: c },
    setTimeout: () => null, clearTimeout: () => {}, setInterval: () => null, clearInterval: () => {},
  };
  d.getName = () => 'Battery';
  d.getSetting = (k) => d.settings[k];
  d.setSettings = async (o) => { d.settingWrites.push({ ...o }); Object.assign(d.settings, o); };
  d.getCapabilityValue = (k) => d.caps[k] ?? null;
  d.hasCapability = () => true;
  d.setCapabilityValue = async (k, v) => { d.caps[k] = v; };
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = (...a) => d.logs.push(a.join(' '));
  d._updatingFromModbus = false;
  d._updatingSettingFromModbus = false;
  d._prevWorkingMode = null; d._prevExcessPv = null; d._prevRemoteMode = null; d._prevBackupSoc = null;
  d._writeInProgress = false;
  return d;
}
const save = (d, changes) => {
  const oldSettings = { ...d.settings };
  const newSettings = { ...d.settings, ...changes };
  return d.onSettings({ oldSettings, newSettings, changedKeys: Object.keys(changes) })
    .then(() => Object.assign(d.settings, changes));
};
const reset = () => { writes.length = 0; refuse.clear(); };

// ── the manifest ────────────────────────────────────────────────────────────────

test('the ceiling sits under "Charging from the grid", right below the power it caps', () => {
  const grid = groups().find((g) => g.label.en === 'Charging from the grid').children.map((c) => c.id);
  assert.strictEqual(grid[grid.indexOf('max_grid_charge_power') + 1], 'max_grid_charge_ceiling');
  const s = setting('max_grid_charge_ceiling');
  assert.strictEqual(s.type, 'number');
  assert.strictEqual(s.min, 0);
  for (const lang of LANGS) {
    assert.match(s.hint[lang], /47244/, lang);
    assert.match(s.hint[lang], /Synced|synchronisiert|gesynchroniseerd/, `${lang}: does not say it is read back`);
  }
  // The set point's hint points down at it now, not only at the card.
  assert.match(setting('max_grid_charge_power').hint.en, /set below or with the flow card/);
});

test('the peak shaving dropdown offers Huawei\'s three values, named like the flow card', () => {
  const dd = setting('mode_capacity_control');
  const arg = card('luna2000_set_capacity_control_mode').args.find((a) => a.name === 'mode');
  assert.strictEqual(dd.type, 'dropdown');
  assert.strictEqual(dd.value, '0', 'peak shaving must start off');
  assert.deepStrictEqual(dd.values.map((v) => v.id), ['0', '1', '2']);
  assert.deepStrictEqual(dd.values, arg.values, 'the dropdown and the card name the modes differently');
  assert.strictEqual(dd.values[1].label.en, 'Active power limit', 'value 1 is an active power limit in SPC177');
  assert.match(dd.values[2].label.en, /several inverters only/);
});

test('the peak shaving texts say the limits come from FusionSolar, in every language', () => {
  for (const lang of LANGS) {
    assert.match(setting('mode_capacity_control').hint[lang], /FusionSolar/, lang);
    assert.match(card('luna2000_set_capacity_control_mode').hint[lang], /FusionSolar/, lang);
    assert.doesNotMatch(card('luna2000_set_capacity_control_soc').hint[lang], /SoC peak shaving|SoC-Lastspitzenkappung|SoC-piekafvlakking/,
      `${lang}: the SoC card still names a mode that does not exist`);
  }
  const soc = setting('capacity_control_soc');
  assert.deepStrictEqual([soc.min, soc.max], [0, 100]);
  for (const lang of LANGS) assert.match(soc.hint[lang], /47955/);
});

test('the peak shaving group comes after the limits, before the notifications', () => {
  const names = groups().map((g) => g.label.en);
  assert.strictEqual(names.indexOf('Peak shaving'), names.indexOf('Notifications') - 1);
  assert.deepStrictEqual(groups().find((g) => g.label.en === 'Peak shaving').label,
    { en: 'Peak shaving', de: 'Lastspitzenkappung', nl: 'Piekafvlakking' });
});

test('the two registers are defined as the spec has them', () => {
  assert.deepStrictEqual(CONTROL_REGISTERS.storageCapacityControlMode.slice(0, 3), [47954, 1, 'UINT16']);
  assert.strictEqual(CONTROL_REGISTERS.storageCapacityControlMode[4], 0);
  assert.deepStrictEqual(CONTROL_REGISTERS.storageCapacityControlSoc.slice(0, 3), [47955, 1, 'UINT16']);
  assert.strictEqual(CONTROL_REGISTERS.storageCapacityControlSoc[4], -1, 'gain 10');
});

// ── reading ─────────────────────────────────────────────────────────────────────

test('the rare read fills all three settings, and the dropdown can be saved from then on', async () => {
  const d = makeDevice();
  await d._applyControl({ storageMaxGridChargePower: 3000, storageCapacityControlMode: 1, storageCapacityControlSoc: 30 });
  assert.strictEqual(d.settings.max_grid_charge_ceiling, 3000);
  assert.strictEqual(d.settings.capacity_control_soc, 30);
  assert.strictEqual(d.settings.mode_capacity_control, '1');
  assert.ok(d._modeSeen && d._modeSeen.mode_capacity_control);
  assert.ok(d.logs.includes('Mode dropdown filled [mode_capacity_control]: 1 = Active power limit'), d.logs.join('\n'));
});

test('the ceiling is read whether grid charging is on or not — unlike the set point', async () => {
  const d = makeDevice({ charge_from_grid: false });
  await d._applyControl({ storageMaxGridChargePower: 2500, storageGridChargePower: 1800 });
  assert.strictEqual(d.settings.max_grid_charge_ceiling, 2500);
  assert.strictEqual(d.settings.max_grid_charge_power, undefined, 'the set point is skipped while grid charging is off');
});

test('a battery without peak shaving leaves the settings alone', async () => {
  const d = makeDevice({ capacity_control_soc: 20 });
  await d._applyControl({ storageMaxGridChargePower: 2000 }); // 47954/47955 refused: no values
  assert.strictEqual(d.settings.capacity_control_soc, 20);
  assert.ok(!(d._modeSeen && d._modeSeen.mode_capacity_control), 'an unread mode counts as read');
});

// ── writing ─────────────────────────────────────────────────────────────────────

test('a saved ceiling goes to 47244 in watts', async () => {
  reset();
  const d = makeDevice({ max_grid_charge_ceiling: 2000 });
  d._settingsInitialized = true;
  await save(d, { max_grid_charge_ceiling: 3500 });
  await settle();
  assert.deepStrictEqual(writes, [{ reg: 47244, value: 3500 }]);
});

test('a saved reserve goes to 47955 in tenths of a percent', async () => {
  reset();
  const d = makeDevice({ capacity_control_soc: 20 });
  d._settingsInitialized = true;
  await save(d, { capacity_control_soc: 35 });
  await settle();
  assert.deepStrictEqual(writes, [{ reg: 47955, value: 350 }]);
});

test('a saved peak shaving mode goes to 47954, once the battery has been read', async () => {
  reset();
  const d = makeDevice({ mode_capacity_control: '0' });
  await assert.rejects(save(d, { mode_capacity_control: '1' }), { message: t('modbus.modes.notReadYet') });
  assert.deepStrictEqual(writes, []);

  await d._applyControl({ storageCapacityControlMode: 0 });
  await save(d, { mode_capacity_control: '1' });
  await settle();
  assert.deepStrictEqual(writes, [{ reg: 47954, value: 1 }]);
});

test('a value the register does not take is refused', async () => {
  reset();
  const d = makeDevice({ mode_capacity_control: '0' });
  await d._applyControl({ storageCapacityControlMode: 0 });
  await assert.rejects(save(d, { mode_capacity_control: '3' }), { message: t('modbus.modes.invalid') });
  assert.deepStrictEqual(writes, []);
});

test('a refused ceiling is put back', async () => {
  reset();
  refuse.add(47244);
  const d = makeDevice({ max_grid_charge_ceiling: 2000, enable_timeline_notifications: false });
  d._settingsInitialized = true;
  await save(d, { max_grid_charge_ceiling: 9000 });
  await settle();
  assert.strictEqual(d.settings.max_grid_charge_ceiling, 2000);
});

test('a refused peak shaving mode is put back, and the timeline names it', async () => {
  reset();
  refuse.add(47954);
  const d = makeDevice({ mode_capacity_control: '0' });
  await d._applyControl({ storageCapacityControlMode: 0 });
  await save(d, { mode_capacity_control: '2' });
  await settle();
  assert.strictEqual(d.settings.mode_capacity_control, '0');
  assert.ok(d.notes.some((n) => /Peak shaving could not be written \(Timed out\) — put back to Disabled\./.test(n)), d.notes.join('\n'));
});

// ── lib/mode-settings: a mode with no tile ──────────────────────────────────────

test('a mode with no tile writes without touching a capability, and names itself in the log', async () => {
  // Recorded, not thrown: applyModeWrites swallows a failing _set, so a throw would pass unseen.
  const d = { logs: [], sets: [], log(...a) { this.logs.push(a.join(' ')); }, error() {}, async _set(c, v) { this.sets.push([c, v]); } };
  await modes.applyModeWrites(d, [{ key: 'p', cap: undefined, reg: 1, value: '1' }], async () => {}, async () => {});
  assert.ok(d.logs.some((l) => /Write OK/.test(l)));
  assert.deepStrictEqual(d.sets, [], 'a capability was set for a mode that has none');

  const s = { settings: {}, logs: [], getSetting(k) { return this.settings[k]; }, async setSettings(o) { Object.assign(this.settings, o); }, log(...a) { this.logs.push(a.join(' ')); } };
  await modes.syncModeSettings(s, { p: { reg: 1, ids: ['0', '1'], labels: { 0: 'Off', 1: 'On' } } }, { p: 1 });
  assert.deepStrictEqual(s.logs, ['Mode dropdown filled [p]: 1 = On']);
});
