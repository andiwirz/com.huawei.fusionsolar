'use strict';

// Every change in the log, and in a change log that survives a restart (1.2.275).
//
// Three doors, each logged in one place — see lib/change-log.js: the settings page
// (withSettingsLog), flow cards (wrapFlowCards) and the device itself (applySettingSync,
// and lib/mode-settings.js for modes). Each also lands in the device's change log.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const app  = require(path.join(ROOT, 'app.json'));
const cl   = require(path.join(ROOT, 'lib', 'change-log'));
const modes = require(path.join(ROOT, 'lib', 'mode-settings'));

// A device with a store, a log and timers that can be fired by hand.
function fakeDevice(settings = {}, { driverId = 'luna2000_modbus', store = {} } = {}) {
  const d = {
    settings: { ...settings }, store: { ...store }, logs: [], timers: [],
    driver: { id: driverId },
    homey: {
      manifest: app,
      setTimeout(fn, ms) { const t = { fn, ms }; d.timers.push(t); return t; },
      clearTimeout(t) { d.timers = d.timers.filter((x) => x !== t); },
    },
    getName: () => 'Battery',
    getSetting(k) { return this.settings[k]; },
    async setSettings(o) { this.guarded = this._updatingSettingFromModbus; Object.assign(this.settings, o); },
    getStoreValue(k) { return this.store[k]; },
    async setStoreValue(k, v) { this.store[k] = JSON.parse(JSON.stringify(v)); },
    log(...a) { this.logs.push(a.join(' ')); },
    error(...a) { this.logs.push(a.join(' ')); },
  };
  return d;
}
const runTimers = async (d) => { const t = d.timers.splice(0); for (const x of t) x.fn(); await new Promise((r) => setImmediate(r)); };

// ── door 1: the settings page ───────────────────────────────────────────────────

test('a saved page says what changed from what to what', () => {
  const d = fakeDevice();
  const line = cl.settingsChange(d, {
    oldSettings: { max_charge_power: 3500, charge_from_grid: false, address: '192.0.2.1', poll_interval: undefined },
    newSettings: { max_charge_power: 2500, charge_from_grid: true, address: '192.0.2.9', poll_interval: 30 },
    changedKeys: ['max_charge_power', 'charge_from_grid', 'address', 'poll_interval'],
  });
  assert.strictEqual(line, 'max_charge_power 3500 → 2500, charge_from_grid off → on, address "192.0.2.1" → "192.0.2.9", poll_interval — → 30');
});

test('a dropdown carries the name of its new value', () => {
  const d = fakeDevice();
  assert.strictEqual(cl.settingsChange(d, { oldSettings: { mode_storage_working: '2' }, newSettings: { mode_storage_working: '5' }, changedKeys: ['mode_storage_working'] }),
    'mode_storage_working 2 → 5 = Time of Use (LUNA2000)');
});

test('passwords, keys, codes and user names never reach the log', () => {
  const d = fakeDevice({}, { driverId: 'smartcharger_ocpp' });
  const line = cl.settingsChange(d, {
    oldSettings: { ocpp_password: 'old-secret', ocpp_username: 'andi', homey_api_key: 'k1', system_code: 'c1' },
    newSettings: { ocpp_password: 'new-secret', ocpp_username: 'bob', homey_api_key: 'k2', system_code: 'c2' },
    changedKeys: ['ocpp_password', 'ocpp_username', 'homey_api_key', 'system_code'],
  });
  for (const secret of ['old-secret', 'new-secret', 'andi', 'bob', 'k1', 'k2', 'c1', 'c2']) assert.ok(!line.includes(secret), `${secret} leaked: ${line}`);
  assert.strictEqual(line, 'ocpp_password (changed), ocpp_username (changed), homey_api_key (changed), system_code (changed)');
});

test('the line follows Homey\'s answer: saved after onSettings returned, refused with the reason', async () => {
  const order = [];
  class Dev { async onSettings() { order.push('onSettings'); } }
  cl.withSettingsLog(Dev);
  const d = Object.assign(Object.create(Dev.prototype), fakeDevice());
  const realLog = d.log.bind(d);
  d.log = (...a) => { order.push('log'); realLog(...a); };
  await d.onSettings({ oldSettings: { poll_interval: 60 }, newSettings: { poll_interval: 30 }, changedKeys: ['poll_interval'] });
  assert.deepStrictEqual(order, ['onSettings', 'log']);
  assert.deepStrictEqual(d.logs, ['Settings saved: poll_interval 60 → 30']);
  assert.strictEqual(cl.entries(d)[0].source, 'settings');

  class Refusing { async onSettings() { throw new Error('This mode can be changed once …'); } }
  cl.withSettingsLog(Refusing);
  const r = Object.assign(Object.create(Refusing.prototype), fakeDevice());
  await assert.rejects(r.onSettings({ oldSettings: { mode_storage_working: '2' }, newSettings: { mode_storage_working: '5' }, changedKeys: ['mode_storage_working'] }));
  assert.match(r.logs[0], /^Settings not saved: mode_storage_working 2 → 5 = Time of Use \(LUNA2000\) — This mode can be changed once/);
  assert.strictEqual(cl.entries(r)[0].source, 'failed');
});

test('wrapping twice wraps once, and a class without its own onSettings is left alone', async () => {
  class Dev { async onSettings() {} }
  cl.withSettingsLog(Dev);
  const once = Dev.prototype.onSettings;
  cl.withSettingsLog(Dev);
  assert.strictEqual(Dev.prototype.onSettings, once);
  class Child extends Dev {}
  cl.withSettingsLog(Child);
  assert.ok(!Object.prototype.hasOwnProperty.call(Child.prototype, 'onSettings'));
});

test('every device class in the app is wrapped', () => {
  for (const dir of fs.readdirSync(path.join(ROOT, 'drivers'))) {
    const file = path.join(ROOT, 'drivers', dir, 'device.js');
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    if (!/async onSettings\s*\(/.test(src)) continue;
    const exported = src.match(/^module\.exports = (\w+);/m)[1];
    assert.ok(src.includes(`withSettingsLog(${exported});`), `${dir}: saved settings pages go unlogged`);
  }
});

// ── door 2: flow cards ──────────────────────────────────────────────────────────

function fakeFlow() {
  const cards = {};
  return {
    cards,
    getActionCard(id) {
      if (!cards[id]) cards[id] = { id, listener: null, registerRunListener(fn) { this.listener = fn; return this; } };
      return cards[id];
    },
  };
}

test('every action card logs what it was asked to do, and runs it', async () => {
  const homey = { flow: fakeFlow() };
  const appLogs = [];
  cl.wrapFlowCards(homey, (...a) => appLogs.push(a.join(' ')));
  const d = fakeDevice();
  homey.flow.getActionCard('luna2000_set_max_charge_power').registerRunListener(async ({ power }) => `set ${power}`);
  const result = await homey.flow.cards.luna2000_set_max_charge_power.listener({ device: d, power: 2500 });
  assert.strictEqual(result, 'set 2500', 'the card\'s own result is lost');
  assert.deepStrictEqual(d.logs, ['[flow] luna2000_set_max_charge_power (power=2500)']);
  assert.strictEqual(cl.entries(d)[0].source, 'flow');
});

test('a refused card says why, and Homey still sees the refusal', async () => {
  const homey = { flow: fakeFlow() };
  cl.wrapFlowCards(homey, () => {});
  const d = fakeDevice();
  homey.flow.getActionCard('ocpp_pause_charging').registerRunListener(async () => { throw new Error('No active charging session to pause.'); });
  await assert.rejects(homey.flow.cards.ocpp_pause_charging.listener({ device: d }), /No active charging session/);
  assert.deepStrictEqual(d.logs, ['[flow] ocpp_pause_charging', '[flow] ocpp_pause_charging refused: No active charging session to pause.']);
  assert.deepStrictEqual(cl.entries(d).map((e) => e.source), ['flow', 'failed']);
});

test('arguments read as people know them: a picked device by name, long text cut short', () => {
  assert.strictEqual(cl.flowArgs({ device: {}, target: { id: 'x1', name: 'Boiler' }, enabled: 'true' }), 'target="Boiler", enabled="true"');
  const long = cl.flowArgs({ prices: '[0.31,0.29,0.27,0.25,0.24,0.26,0.30,0.35,0.41,0.39,0.33,0.30,0.28]' });
  assert.ok(long.length < 80 && long.includes('…'), long);
});

test('data feeds are logged but kept out of the change log', async () => {
  const homey = { flow: fakeFlow() };
  cl.wrapFlowCards(homey, () => {});
  const d = fakeDevice();
  homey.flow.getActionCard('ems_set_electricity_price').registerRunListener(async () => {});
  await homey.flow.cards.ems_set_electricity_price.listener({ device: d, price: 0.31 });
  assert.strictEqual(d.logs.length, 1);
  assert.deepStrictEqual(cl.entries(d), []);
});

test('the flow door is opened once, and before any card is registered', () => {
  const homey = { flow: fakeFlow() };
  cl.wrapFlowCards(homey, () => {});
  const first = homey.flow.getActionCard;
  cl.wrapFlowCards(homey, () => {});
  assert.strictEqual(homey.flow.getActionCard, first);
  const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const at = src.indexOf('changeLog.wrapFlowCards(this.homey');
  assert.ok(at > 0, 'app.js does not wrap the flow cards');
  // Drivers register their cards after the app's onInit; app.js itself must not do so earlier.
  const own = src.indexOf('getActionCard(');
  assert.ok(own === -1 || at < own, 'app.js registers a card before wrapping');
  assert.ok(at < src.indexOf('async onInit') + 600, 'the wrap is not among the first things onInit does');
});

// ── door 3: the device itself ───────────────────────────────────────────────────

test('a value that moved on the device is logged; a first fill and a repeat are not', async () => {
  const d = fakeDevice({ max_charge_power: 5000, backup_power_soc: 10, grid_charge_cutoff_soc: undefined, charge_from_grid: '1' });
  await cl.applySettingSync(d, { max_charge_power: 3000, backup_power_soc: 10, grid_charge_cutoff_soc: 50, charge_from_grid: 1 });
  assert.deepStrictEqual(d.logs, ['Setting follows the device [max_charge_power]: 5000 → 3000']);
  assert.strictEqual(d.guarded, true, 'stored without the guard — onSettings would write it back');
  assert.strictEqual(d._updatingSettingFromModbus, false);
  assert.deepStrictEqual(cl.entries(d).map((e) => [e.source, e.key]), [['device', 'max_charge_power']]);
});

test('a value the store refused is not claimed as followed', async () => {
  const d = fakeDevice({ max_charge_power: 5000 });
  d.setSettings = async () => { throw new Error('busy'); };
  await cl.applySettingSync(d, { max_charge_power: 3000 });
  assert.deepStrictEqual(d.logs, ['setSettings sync failed: busy']);
  assert.strictEqual(d._updatingSettingFromModbus, false);
});

test('the battery, inverter and EMMA store what they read through applySettingSync', () => {
  for (const dir of ['luna2000_modbus', 'sun2000_modbus', 'luna2000_emma_modbus']) {
    const src = fs.readFileSync(path.join(ROOT, 'drivers', dir, 'device.js'), 'utf8');
    assert.match(src, /await applySettingSync\(this, /, dir);
    assert.doesNotMatch(src, /setSettings\(settingUpdates\)/, `${dir}: a sync bypasses the log`);
  }
});

test('modes moved on the device, and refused mode writes, are kept as well', async () => {
  const d = fakeDevice({ mode_x: '1' });
  const spec = { mode_x: { reg: 1, ids: ['0', '1'], labels: { 0: 'Off', 1: 'On' } } };
  await modes.syncModeSettings(d, spec, { mode_x: 1 });  // filled, unchanged: not kept
  await modes.syncModeSettings(d, spec, { mode_x: 0 });  // moved: kept
  await modes.revertModeSetting(d, 'mode_x', '1', new Error('Timed out'));
  assert.deepStrictEqual(cl.entries(d).map((e) => [e.source, e.text]), [
    ['device', 'Mode dropdown follows the device [mode_x]: 1 → 0 = Off'],
    ['failed', 'Write failed [mode_x]: Timed out — setting taken back'],
  ]);
});

// ── the change log itself ───────────────────────────────────────────────────────

test('a repeat within 15 minutes counts up instead of pushing everything else out', () => {
  const d = fakeDevice();
  const t0 = 1_000_000;
  cl.record(d, 'flow', 'ocpp_set_max_current', '[flow] ocpp_set_max_current (amperes=10)', t0);
  cl.record(d, 'flow', 'ocpp_set_max_current', '[flow] ocpp_set_max_current (amperes=12)', t0 + 60_000);
  cl.record(d, 'flow', 'ocpp_set_max_current', '[flow] ocpp_set_max_current (amperes=14)', t0 + 120_000);
  assert.deepStrictEqual(cl.entries(d).map((e) => [e.text, e.n]), [['[flow] ocpp_set_max_current (amperes=14)', 3]]);
  cl.record(d, 'flow', 'ocpp_set_max_current', 'later', t0 + 120_000 + cl.COALESCE_MS);
  assert.strictEqual(cl.entries(d).length, 2, 'a repeat after the window counts as new');
  cl.record(d, 'settings', null, 'Settings saved: a', t0 + 1);
  cl.record(d, 'settings', null, 'Settings saved: b', t0 + 2);
  assert.strictEqual(cl.entries(d).length, 4, 'a saved settings page never merges with another');
});

test('each device keeps its last 50 entries', () => {
  const d = fakeDevice();
  for (let i = 0; i < 60; i++) cl.record(d, 'settings', null, `entry ${i}`, i);
  const e = cl.entries(d);
  assert.strictEqual(e.length, cl.RING_MAX);
  assert.strictEqual(e[0].text, 'entry 10');
  assert.strictEqual(e[49].text, 'entry 59');
});

test('the store is written within a minute for news, every 15 minutes for repeats — and survives', async () => {
  const d = fakeDevice({}, { store: { change_log: [{ t: 1, source: 'settings', key: null, text: 'from before the restart' }] } });
  cl.record(d, 'flow', 'card', 'new entry', Date.now());
  assert.deepStrictEqual(d.timers.map((t) => t.ms), [cl.NEW_FLUSH_MS]);
  await runTimers(d);
  assert.deepStrictEqual(d.store.change_log.map((e) => e.text), ['from before the restart', 'new entry']);

  cl.record(d, 'flow', 'card', 'repeat', Date.now());
  assert.deepStrictEqual(d.timers.map((t) => t.ms), [cl.COALESCE_MS], 'a repeat alone schedules the slow write');
  cl.record(d, 'device', 'k', 'something new', Date.now());
  assert.deepStrictEqual(d.timers.map((t) => t.ms), [cl.NEW_FLUSH_MS], 'news brings the write forward');
});

test('a device without a store, as in a test harness, is simply skipped', () => {
  assert.doesNotThrow(() => cl.record({ log() {} }, 'flow', 'k', 'text'));
  assert.doesNotThrow(() => cl.record(undefined, 'flow', 'k', 'text'));
});

// ── reading it back ─────────────────────────────────────────────────────────────

test('GET /changes returns every device\'s entries, newest first, in Homey\'s local time', () => {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'homey') return { App: class {} };
    return origLoad.call(this, request, parent, isMain);
  };
  let FusionSolarApp;
  try { FusionSolarApp = require(path.join(ROOT, 'app.js')); } finally { Module._load = origLoad; }

  const a = fakeDevice(); a.getName = () => 'Battery';
  const b = fakeDevice(); b.getName = () => 'Inverter';
  cl.record(a, 'settings', null, 'older', 1000);
  cl.record(b, 'device', 'k', 'newer', 2000);
  const self = {
    homey: { drivers: { getDrivers: () => ({ x: { getDevices: () => [a] }, y: { getDevices: () => [b] } }) } },
    _logStamp: (d) => `stamp ${d.getTime()}`,
  };
  const out = FusionSolarApp.prototype.getChangeLog.call(self);
  assert.deepStrictEqual(out.map((e) => [e.device, e.text, e.at, e.source]), [
    ['Inverter', 'newer', 'stamp 2000', 'device'],
    ['Battery', 'older', 'stamp 1000', 'settings'],
  ]);
  assert.deepStrictEqual(app.api.getChangeLog, { method: 'GET', path: '/changes' });
  assert.match(fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8'), /async getChangeLog\(\{ homey \}\) \{\s*return homey\.app\.getChangeLog\(\);/);
});

test('Settings → Logs shows the change log, in every language', () => {
  const html = fs.readFileSync(path.join(ROOT, 'settings', 'index.html'), 'utf8');
  assert.match(html, /id="changes-output"/);
  assert.match(html, /_H\.api\('GET', '\/changes'/);
  for (const lang of ['en', 'de', 'nl']) {
    const l = require(path.join(ROOT, 'locales', `${lang}.json`)).settings.logs;
    for (const k of ['changesTitle', 'changesIntro', 'changesEmpty']) assert.ok(l[k], `${lang}: ${k}`);
    for (const s of ['settings', 'flow', 'device', 'failed']) assert.ok(l.source[s], `${lang}: source.${s}`);
  }
});

// ── success lines for the numeric writes ────────────────────────────────────────

test('every write from a settings page says when it succeeded', () => {
  const luna = fs.readFileSync(path.join(ROOT, 'drivers', 'luna2000_modbus', 'device.js'), 'utf8');
  for (const m of ['[charge_from_grid → reg 47087]', '[${key} → reg ${reg}]', '[max_grid_charge_ceiling → reg 47244]', '[max_grid_charge_power → reg 47242]']) {
    assert.ok(luna.includes(`Write OK     ${m}`), `LUNA: no success line for ${m}`);
  }
  assert.ok(fs.readFileSync(path.join(ROOT, 'drivers', 'sun2000_modbus', 'device.js'), 'utf8').includes('Write OK     [${key} → reg ${reg}]'));
  assert.ok(fs.readFileSync(path.join(ROOT, 'drivers', 'luna2000_emma_modbus', 'device.js'), 'utf8').includes('Write OK     [max_grid_charge_power → reg 40002]'));
});

// ── the doors, walked through the real drivers ──────────────────────────────────

const writes = [];
const refuse = new Set();
const record = async (host, port, unit, reg, value) => {
  writes.push({ reg, value });
  if (refuse.has(reg)) { await new Promise((r) => setImmediate(r)); throw new Error('Timed out'); }
};
const loadDriver = (dir) => {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'homey') return { Device: class {} };
    if (request === '../../lib/modbus-client') {
      const real = origLoad.call(this, request, parent, isMain);
      return { ...real, writeModbusRegister: record, writeModbusU32: record };
    }
    return origLoad.call(this, request, parent, isMain);
  };
  try { return require(path.join(ROOT, 'drivers', dir, 'device.js')); } finally { Module._load = origLoad; }
};
const LunaDevice = loadDriver('luna2000_modbus');
const InverterDevice = loadDriver('sun2000_modbus');
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

function realDevice(Cls, driverId, settings) {
  const d = Object.assign(Object.create(Cls.prototype), fakeDevice({ address: '192.0.2.10', port: 502, modbus_id: 1, enable_timeline_notifications: false, ...settings }, { driverId }));
  d.caps = {};
  d.hasCapability = () => true;
  d.getCapabilityValue = (k) => d.caps[k] ?? null;
  d.setCapabilityValue = async (k, v) => { d.caps[k] = v; };
  d.homey.__ = (k) => k;
  d.homey.i18n = { getLanguage: () => 'en' };
  d.homey.drivers = { getDriver: () => ({ getDevices: () => [] }) };
  d.homey.notifications = { createNotification: async () => {} };
  const c = () => ({ registerRunListener() { return this; }, trigger: async () => {} });
  d.homey.flow = { getActionCard: c, getConditionCard: c, getDeviceTriggerCard: c };
  d._updatingFromModbus = false;
  d._updatingSettingFromModbus = false;
  d._prevWorkingMode = null; d._prevExcessPv = null; d._prevRemoteMode = null; d._prevBackupSoc = null;
  d._writeInProgress = false;
  return d;
}

test('battery: a limit changed in FusionSolar shows up as "follows the device"', async () => {
  const d = realDevice(LunaDevice, 'luna2000_modbus', { max_charge_power: 5000 });
  await d._applyControl({ storageMaxChargePower: 3000 });
  assert.ok(d.logs.includes('Setting follows the device [max_charge_power]: 5000 → 3000'), d.logs.join('\n'));
  assert.ok(cl.entries(d).some((e) => e.source === 'device' && e.key === 'max_charge_power'));
});

test('battery: a saved limit is logged as saved, written, and confirmed', async () => {
  writes.length = 0; refuse.clear();
  const d = realDevice(LunaDevice, 'luna2000_modbus', { max_charge_power: 5000 });
  d._settingsInitialized = true;
  await d.onSettings({ oldSettings: { ...d.settings }, newSettings: { ...d.settings, max_charge_power: 2500 }, changedKeys: ['max_charge_power'] });
  await settle();
  assert.deepStrictEqual(writes, [{ reg: 47075, value: 2500 }]);
  assert.ok(d.logs.includes('Settings saved: max_charge_power 5000 → 2500'), d.logs.join('\n'));
  assert.ok(d.logs.includes('Write OK     [max_charge_power → reg 47075]'), d.logs.join('\n'));
});

test('battery: a refused write lands in the change log', async () => {
  writes.length = 0; refuse.clear(); refuse.add(47075);
  const d = realDevice(LunaDevice, 'luna2000_modbus', { max_charge_power: 5000 });
  d._settingsInitialized = true;
  await d.onSettings({ oldSettings: { ...d.settings }, newSettings: { ...d.settings, max_charge_power: 2500 }, changedKeys: ['max_charge_power'] });
  await settle();
  assert.ok(cl.entries(d).some((e) => e.source === 'failed' && /Write failed \[max_charge_power\]: Timed out/.test(e.text)), JSON.stringify(cl.entries(d)));
});

test('inverter: a refused output limit lands in the change log, a good one is confirmed', async () => {
  writes.length = 0; refuse.clear(); refuse.add(40126);
  const d = realDevice(InverterDevice, 'sun2000_modbus', { output_limit_w: 5000, output_limit_pct: 100 });
  d._settingsInitialized = true;
  await d.onSettings({ oldSettings: { ...d.settings }, newSettings: { ...d.settings, output_limit_w: 3000, output_limit_pct: 80 }, changedKeys: ['output_limit_w', 'output_limit_pct'] });
  await settle();
  assert.ok(cl.entries(d).some((e) => e.source === 'failed' && e.text === 'Write failed [output_limit_w → reg 40126]: Timed out — setting taken back'), JSON.stringify(cl.entries(d)));
  // Since 1.2.276 the inverter puts the refused setting back, as the battery does.
  assert.strictEqual(d.settings.output_limit_w, 5000, 'the page still shows the value the inverter refused');
  assert.ok(d.logs.includes('Write OK     [output_limit_pct → reg 40125]'), d.logs.join('\n'));
});

test('a Homey that will not let the cards be wrapped still starts, unlogged', async () => {
  const frozen = Object.freeze({ getActionCard() { return Object.freeze({ registerRunListener(fn) { this.fn = fn; return this; } }); } });
  const logs = [];
  assert.doesNotThrow(() => cl.wrapFlowCards({ flow: frozen }, (...a) => logs.push(a.join(' '))));
  assert.match(logs.join('\n'), /flow cards not logged/);

  const homey = { flow: { getActionCard: () => Object.freeze({ registerRunListener() { return this; } }) } };
  cl.wrapFlowCards(homey, (...a) => logs.push(a.join(' ')));
  assert.doesNotThrow(() => homey.flow.getActionCard('x'));
  assert.match(logs.join('\n'), /\[flow\] x not logged/);
});
