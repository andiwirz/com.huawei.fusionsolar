'use strict';

// The one read-only box on the battery's settings page. Run: node --test
//
// "Charging by price or forecast", at the end of the "Change battery mode" group, answers
// whether the device that does price- and forecast-driven charging is installed; its (i)
// says to use that device rather than the modes. Homey draws a setting of type "label" as a
// disabled box showing its value — 1.2.237 left the value empty and showed empty boxes, so
// since 1.2.242 the value is the answer.
//
// Until 1.2.272 two more boxes showed the working mode and the remote mode. Since 1.2.266 the
// dropdowns right above them showed the same words, so they went, and their explanations
// moved into the dropdowns' (i). The tests at the end keep them from being written again.
//
// Both battery drivers are covered.

const Module = require('module');
const _origLoad = Module._load;

const modbus = {
  ctrl: {},
  async readModbusRegisters(host, port, unit, regs) {
    return Object.fromEntries(
      Object.keys(regs).filter((k) => k in modbus.ctrl).map((k) => [k, modbus.ctrl[k]]));
  },
  async writeModbusRegister() {},
  async writeModbusU32() {},
  parseIntSafe: (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; },
  unavailableMessage: () => 'unavailable',
};

Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {}, Driver: class {} };
  if (/lib\/modbus-client$/.test(request)) return modbus;
  if (/lib\/poll-log$/.test(request)) return { logPollOk() {}, logPollError() {} };
  if (/lib\/pairing-helper$/.test(request)) {
    return { pauseDevicesOnHost: async () => [], resumePairedDevices: async () => {},
      parseIntSafe: modbus.parseIntSafe };
  }
  return _origLoad.call(this, request, parent, isMain);
};

const test     = require('node:test');
const assert   = require('node:assert');
const manifest = require('../app.json');

const LunaModbus = require('../drivers/luna2000_modbus/device.js');
const LunaEmma   = require('../drivers/luna2000_emma_modbus/device.js');

const card = () => { const c = { registerRunListener: () => c, trigger: async () => {} }; return c; };

function makeDevice(Cls, lang = 'de') {
  const d = Object.create(Cls.prototype);
  d.caps = {};
  for (const c of ['storage_working_mode_settings', 'storage_force_charge_discharge',
    'storage_excess_pv_energy_use_in_tou', 'remote_charge_discharge_control_mode',
    'luna2000_unit1_installed', 'luna2000_unit2_installed', 'measure_battery_modules']) d.caps[c] = null;
  d.settings = { info_ems_battery: '—', charge_from_grid: false, max_grid_charge_power: 2000 };
  d.logs = [];
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = d.log;
  d.getName = () => 'Battery';
  d.hasCapability = (c) => c in d.caps;
  d.getCapabilityValue = (c) => (c in d.caps ? d.caps[c] : null);
  d.setCapabilityValue = async (c, v) => { d.caps[c] = v; };
  d.getSetting = (k) => d.settings[k];
  d.setSettingsCalls = [];
  d.setSettings = async (o) => { d.setSettingsCalls.push({ ...o }); Object.assign(d.settings, o); };
  d.emsDevices = [];
  d.homey = {
    __: (k) => k,
    manifest,
    i18n: { getLanguage: () => lang },
    drivers: { getDriver: (id) => {
      if (id !== 'energy_management') throw new Error('no such driver');
      return { getDevices: () => d.emsDevices };
    } },
    flow: { getDeviceTriggerCard: card, getConditionCard: card, getActionCard: card },
  };
  d._updatingFromModbus = false;
  d._updatingSettingFromModbus = false;
  d._prevWorkingMode = null; d._prevExcessPv = null; d._prevRemoteMode = null;
  d._batteryModulesInitialized = true;
  d._writeInProgress = false;
  d._noteWrite = () => {};
  return d;
}

// ── the LUNA2000 Modbus driver ──────────────────────────────────────────────

test('the EMS box says whether the device that does this is installed', async () => {
  const d = makeDevice(LunaModbus);
  await d._applyControl({ storageWorkingMode: 2 });
  assert.strictEqual(d.settings.info_ems_battery, 'modbus.battery.ems.absent');

  d.emsDevices = [{}];
  await d._applyControl({ storageWorkingMode: 2 });
  assert.strictEqual(d.settings.info_ems_battery, 'modbus.battery.ems.present');
});

// getDriver throws on an app that has never had an Energy Management device. That is an
// answer, not a failure.
test('no Energy Management driver at all reads as "not added"', async () => {
  const d = makeDevice(LunaModbus);
  d.homey.drivers.getDriver = () => { throw new Error('no such driver'); };
  await d._applyControl({ storageWorkingMode: 2 });
  assert.strictEqual(d.settings.info_ems_battery, 'modbus.battery.ems.absent');
});

test('an answer that did not change writes nothing to the store', async () => {
  const d = makeDevice(LunaModbus);
  await d._applyControl({ storageWorkingMode: 2 });
  const after = d.setSettingsCalls.length;
  await d._applyControl({ storageWorkingMode: 2 });
  assert.deepStrictEqual(d.setSettingsCalls.slice(after).filter((c) => 'info_ems_battery' in c), [],
    'the same string was written to the store again');
});

// The box is decoration; the settings sync is not. One must not take the other down.
test('a store that refuses the box still gets the real settings sync', async () => {
  const d = makeDevice(LunaModbus);
  const real = d.setSettings;
  d.setSettings = async (o) => {
    if ('info_ems_battery' in o) throw new Error('store is busy');
    return real(o);
  };
  d.settings.max_discharge_power = 5000;

  await d._applyControl({ storageWorkingMode: 2, storageMaxDischargePower: 0,
    storageDischargeCutoffCapacity: 15, storageBackupPowerSoc: 0 });

  assert.strictEqual(d.settings.max_discharge_power, 0,
    'a refused decoration row took the real settings sync with it');
  assert.ok(d.logs.some((l) => /info rows failed/.test(l)), 'the refusal went unlogged');
});

test('the box is written under the guard, like every other sync', async () => {
  const d = makeDevice(LunaModbus);
  let guarded = null;
  const real = d.setSettings;
  d.setSettings = async (o) => {
    if ('info_ems_battery' in o) guarded = d._updatingSettingFromModbus;
    return real(o);
  };
  await d._applyControl({ storageWorkingMode: 2 });
  assert.strictEqual(guarded, true,
    'setSettings ran without _updatingSettingFromModbus, so onSettings would act on it');
  assert.strictEqual(d._updatingSettingFromModbus, false, 'the guard was left set');
});

// ── the EMMA battery driver ─────────────────────────────────────────────────

test('the EMMA driver fills the EMS box', async () => {
  const d = makeDevice(LunaEmma);
  modbus.ctrl = { essControlMode: 2 };
  await d._fetchControl('192.168.1.10', 502, 0);
  assert.strictEqual(d.settings.info_ems_battery, 'modbus.battery.ems.absent');
});

test('the EMMA driver reports an installed Energy Management device too', async () => {
  const d = makeDevice(LunaEmma);
  d.emsDevices = [{}];
  modbus.ctrl = { essControlMode: 2 };
  await d._fetchControl('192.168.1.10', 502, 0);
  assert.strictEqual(d.settings.info_ems_battery, 'modbus.battery.ems.present');
});

// ── the two boxes that went in 1.2.272 ──────────────────────────────────────

test('neither driver writes the mode boxes any more', async () => {
  const luna = makeDevice(LunaModbus);
  await luna._applyControl({ storageWorkingMode: 2, remoteChargeDischargeControlMode: 0 });
  const emma = makeDevice(LunaEmma);
  modbus.ctrl = { essControlMode: 2 };
  await emma._fetchControl('192.168.1.10', 502, 0);

  for (const d of [luna, emma]) {
    const written = d.setSettingsCalls.flatMap((c) => Object.keys(c));
    assert.ok(!written.includes('info_working_mode') && !written.includes('info_remote_mode'),
      `a removed box was written: ${written.join(', ')}`);
  }
});

test('the manifest no longer has them', () => {
  const flat = (list) => (list || []).flatMap((x) => (x.type === 'group' ? flat(x.children) : [x]));
  for (const id of ['luna2000_modbus', 'luna2000_emma_modbus']) {
    const ids = flat(manifest.drivers.find((d) => d.id === id).settings).map((s) => s.id);
    assert.ok(!ids.includes('info_working_mode') && !ids.includes('info_remote_mode'), id);
    assert.ok(!flat(manifest.drivers.find((d) => d.id === id).settings)
      .some((s) => s.type === 'group' && s.label.en === 'What the battery modes do'), id);
  }
});
