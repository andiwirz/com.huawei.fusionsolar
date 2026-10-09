'use strict';

// Three small cloud fixes from the developer note (1.2.294).
//
//   A4  The cloud meter's "Export/Import … W" line was written before the capability was
//       created, so the first poll dropped it — and a plant with only a type-17 meter, whose
//       branch never creates the extra capabilities, never showed it at all.
//   B7  The cloud inverter named 16 of the 27 states it knows differently from the Modbus
//       inverter for the same Huawei code ("Grid-connected" for "On-grid", "Start" for
//       "Starting", "cosψ" for "cosφ"). It now uses statusLabel, as Modbus does.
//   B8  openapi_inverter_efficiency is gone: Huawei reports a constant 100 %.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const { statusLabel } = require(path.join(ROOT, 'lib', 'modbus-registers.js'));
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  return origLoad.call(this, request, parent, isMain);
};
const Inverter = require(path.join(ROOT, 'drivers', 'sun2000_openapi_fusionsolar', 'device.js'));
const Meter    = require(path.join(ROOT, 'drivers', 'powermeter_openapi_fusionsolar', 'device.js'));
Module._load = origLoad;
const app = require(path.join(ROOT, 'app.json'));

// Writes land only on capabilities the device has, as on a Homey.
function fake(Cls, caps) {
  const d = Object.create(Cls.prototype);
  d.values = {};
  d.caps = new Set(caps);
  d._prevDeviceStatus = null;
  d._prevExporting = null;
  d._prevMeterStatus = null;
  d.log = () => {};
  d.getName = () => 'Device';
  d.getSetting = () => false;
  d.hasCapability = (c) => d.caps.has(c);
  d.addCapability = async (c) => { d.caps.add(c); };
  d._set = async (c, v) => { if (v !== null && v !== undefined && d.caps.has(c)) d.values[c] = v; };
  d._trackPower = () => {};
  d._fireExportImportTriggers = () => {};
  d.homey = { notifications: { createNotification: async () => {} }, flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) } };
  return d;
}

// ── B7 ──────────────────────────────────────────────────────────────────────────────

const inverterState = async (state) => {
  const d = fake(Inverter, ['measure_power', 'huawei_status']);
  await d.onPollData({ stationKpi: {}, kpiByType: { 1: [{ active_power: 1, mppt_power: 1, inverter_state: state }] } });
  return d.values.huawei_status;
};

test('every state the cloud reports is named as the Modbus inverter names it', async () => {
  for (const code of [0, 1, 2, 3, 256, 512, 513, 514, 768, 769, 770, 771, 772, 773, 774, 780, 781, 1025, 1026, 1280, 1281, 1536, 1792, 2048, 2304, 40960]) {
    assert.strictEqual(await inverterState(code), statusLabel(code), `code ${code}`);
  }
  assert.strictEqual(await inverterState(512), 'On-grid');
  assert.strictEqual(await inverterState('768'), 'Shutdown: fault', 'the API sends the state as a string, too');
});

test('the two cloud-only states keep their names; an unreadable state writes nothing', async () => {
  assert.strictEqual(await inverterState(45056), 'Communication interrupted');
  assert.strictEqual(await inverterState(49152), 'Loading');
  assert.strictEqual(await inverterState('n/a'), undefined, 'a state that is no number became a label');
});

// ── B8 ──────────────────────────────────────────────────────────────────────────────

test('the efficiency tile is removed from paired inverters and never written again', async () => {
  const src = require('fs').readFileSync(path.join(ROOT, 'drivers', 'sun2000_openapi_fusionsolar', 'device.js'), 'utf8');
  const list = (name) => src.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`))[1].replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(list('EXTRA_CAPABILITIES'), /'openapi_inverter_efficiency'/);
  assert.match(list('DEPRECATED_CAPABILITIES'), /'openapi_inverter_efficiency'/);
  const d = fake(Inverter, ['measure_power', 'openapi_inverter_efficiency']);
  await d.onPollData({ stationKpi: {}, kpiByType: { 1: [{ active_power: 1, efficiency: 100 }] } });
  assert.strictEqual(d.values.openapi_inverter_efficiency, undefined);
  // The definition stays: Homey has to know the capability to take it off a device.
  assert.ok(app.capabilities.openapi_inverter_efficiency);
  assert.ok(!('openapi_inverter_efficiency' in app.drivers.find((x) => x.id === 'sun2000_openapi_fusionsolar').capabilitiesOptions));
});

// ── A4 ──────────────────────────────────────────────────────────────────────────────

for (const [name, type, kpi, expected] of [
  ['EMMA', 23070, { active_power: -1.319 }, '1319 W Export'],
  ['power sensor', 47, { active_power: 2000 }, '2000 W Export'],
  ['grid meter (type 17)', 17, { active_power: -500 }, '500 W Import'],
]) {
  test(`the state line is there after the first poll — ${name}`, async () => {
    const d = fake(Meter, ['measure_power', 'meter_power', 'meter_power.exported']);
    await d.onPollData({ kpiByType: { [type]: [kpi] } });
    assert.ok(d.caps.has('powermeter_state_string'), 'the capability was not created');
    assert.strictEqual(d.values.powermeter_state_string, expected);
  });
}
