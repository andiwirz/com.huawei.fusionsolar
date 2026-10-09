'use strict';

// Five small things from the open list, checked against the code (1.2.279):
//
//   - the backup power SoC, a reading since 1.2.278, had no icon and showed Homey's dashed box;
//   - the battery wrote its discharge cutoff and backup SoC to the settings on every poll;
//   - the cloud inverter listed huawei_status as removed and as extra at once, so every start
//     took the status tile away and the first poll put it back, at the end of the view;
//   - a charger stop was stamped with the wall clock, every other cooldown stamp with the tick;
//   - api.js built flow-card requests by hand beside lib/homey-local-api.js, which has them.
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

// ── the backup SoC icon ─────────────────────────────────────────────────────────

test('the backup power SoC has an icon of its own, in both battery drivers', () => {
  for (const id of ['luna2000_modbus', 'luna2000_emma_modbus']) {
    const o = app.drivers.find((d) => d.id === id).capabilitiesOptions['measure_battery.backup'];
    assert.strictEqual(o.icon, '/assets/capabilities/battery_backup_soc.svg', id);
  }
  const svg = read('assets/capabilities/battery_backup_soc.svg');
  assert.match(svg, /viewBox="0 0 24 24"/);
  assert.match(svg, /fill="currentColor"/);
  assert.doesNotMatch(svg, /stroke=/, 'Homey fills icons; a line drawing comes out as a block');
  const nums = svg.match(/ d="([^"]+)"/)[1].match(/-?\d+(\.\d+)?/g).map(Number);
  assert.ok(nums.every((n) => n >= 0 && n <= 24), 'a point lies outside the box');
});

// ── settings written only when they change ──────────────────────────────────────

const loadLuna = () => {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'homey') return { Device: class {} };
    return origLoad.call(this, request, parent, isMain);
  };
  try { return require(path.join(ROOT, 'drivers', 'luna2000_modbus', 'device.js')); } finally { Module._load = origLoad; }
};
const LunaDevice = loadLuna();

function luna(settings) {
  const d = Object.create(LunaDevice.prototype);
  d.settings = { ...settings };
  d.calls = [];
  d.caps = {};
  d.getSetting = (k) => d.settings[k];
  d.setSettings = async (o) => { d.calls.push({ ...o }); Object.assign(d.settings, o); };
  d.hasCapability = () => true;
  d.getCapabilityValue = (k) => d.caps[k] ?? null;
  d.setCapabilityValue = async (k, v) => { d.caps[k] = v; };
  d.log = () => {};
  d.error = () => {};
  const card = () => ({ trigger: async () => {} });
  d.homey = { __: (k) => k, manifest: app, i18n: { getLanguage: () => 'en' }, drivers: { getDriver: () => ({ getDevices: () => [] }) },
    flow: { getDeviceTriggerCard: card }, notifications: { createNotification: async () => {} } };
  d._prevWorkingMode = null; d._prevExcessPv = null; d._prevRemoteMode = null; d._prevBackupSoc = null;
  return d;
}
const keysWritten = (d) => d.calls.flatMap((c) => Object.keys(c));

test('the battery stores its discharge cutoff and backup SoC only when they change', async () => {
  const d = luna({ discharge_cutoff_capacity: 15, backup_power_soc: 0 });
  for (let i = 0; i < 5; i++) await d._applyControl({ storageDischargeCutoffCapacity: 15, storageBackupPowerSoc: 0 });
  assert.deepStrictEqual(keysWritten(d).filter((k) => k === 'discharge_cutoff_capacity' || k === 'backup_power_soc'), [],
    'five polls with nothing new wrote the settings anyway');

  await d._applyControl({ storageDischargeCutoffCapacity: 10, storageBackupPowerSoc: 0 });
  assert.deepStrictEqual(keysWritten(d).filter((k) => k === 'discharge_cutoff_capacity'), ['discharge_cutoff_capacity']);
  assert.strictEqual(d.settings.discharge_cutoff_capacity, 10);
});

test('a setting that holds nothing yet is still filled from the device', async () => {
  const d = luna({});
  await d._applyControl({ storageBackupPowerSoc: 0 });
  assert.strictEqual(d.settings.backup_power_soc, 0);
});

test('no setting is written on every poll any more', () => {
  assert.doesNotMatch(read('drivers/luna2000_modbus/device.js'), /alwaysSync/);
});

// ── no capability removed on start and added again ──────────────────────────────

test('no driver removes on start a capability it adds again', () => {
  const list = (src, name) => {
    const m = src.match(new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
    return m ? [...m[1].replace(/\/\/.*$/gm, '').matchAll(/'([\w.]+)'/g)].map((x) => x[1]) : [];
  };
  let checked = 0;
  for (const d of app.drivers) {
    const file = path.join(ROOT, 'drivers', d.id, 'device.js');
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    const removed = [...list(src, 'DEPRECATED_CAPABILITIES'), ...list(src, 'REMOVE_CAPABILITIES')];
    if (!removed.length) continue;
    checked++;
    const live = new Set([...list(src, 'REQUIRED_CAPABILITIES'), ...list(src, 'EXTRA_CAPABILITIES'), ...(d.capabilities || [])]);
    assert.deepStrictEqual(removed.filter((c) => live.has(c)), [], `${d.id}: removed on every start, then added again`);
  }
  assert.ok(checked >= 7, `only ${checked} drivers with a removal list found`);
});

// ── the charger stop on the tick's clock ────────────────────────────────────────

test('a charger stop is stamped with the tick\'s time, which the cooldown compares against', async () => {
  const cc = require(path.join(ROOT, 'lib', 'ems', 'chargerControl'));
  const timing = require(path.join(ROOT, 'lib', 'ems', 'timing'));
  const self = Object.assign({}, cc, timing, {
    _chargerStates: new Map(),
    log() {},
    _addHistoryEvent() {},
    homey: { flow: { getTriggerCard: () => ({ trigger: async () => {} }) }, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t) },
  });
  self._getChargerState('c').currentAmps = 10;
  const tick = 1_700_000_000_000; // a simulated tick, nowhere near the wall clock
  await self._chargerStop('c', tick);
  assert.strictEqual(self._getChargerState('c').lastDownStepAt, tick);

  const src = read('lib/ems/chargerControl.js');
  assert.doesNotMatch(src, /this\._chargerStop\([\w.]+\)/, 'a stop is called without the tick\'s time');
  assert.deepStrictEqual(src.match(/Date\.now\(\)/g), ['Date.now()', 'Date.now()'],
    'besides the tick\'s own origin and the default for callers outside a tick, the wall clock is read again');
});

// ── api.js through lib/homey-local-api.js ───────────────────────────────────────

test('api.js asks lib/homey-local-api.js, and the helper asks the right paths', async () => {
  assert.doesNotMatch(read('api.js'), /api\._req\(/, 'api.js builds a Homey API request by hand again');
  const HomeyLocalApi = require(path.join(ROOT, 'lib', 'homey-local-api'));
  const api = Object.create(HomeyLocalApi.prototype);
  const asked = [];
  api._req = async (method, p) => { asked.push(`${method} ${p}`); return {}; };
  await api.getFlowActionCards();
  await api.getFlowTriggerCards();
  await api.getFlowConditionCards();
  await api.getFlow('abc-123');
  assert.deepStrictEqual(asked, [
    'GET /manager/flow/flowcardaction',
    'GET /manager/flow/flowcardtrigger',
    'GET /manager/flow/flowcardcondition',
    'GET /manager/flow/flow/abc-123',
  ]);
});
