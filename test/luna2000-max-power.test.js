'use strict';

// Max charge / discharge power: the setting, the capability, and the cards. Run: node --test
//
// Issue #31 (2026-09-19). The reporter set the battery's max discharge power to 0 and built
// a flow on the capability "Max Discharge Power is less than…" — there was no condition
// card for discharge, only for charge. The capability stayed at 5000 W.
//
// Two numbers, one name. Huawei's spec has "[Energy storage] Maximum discharge power"
// (37048, read-only, what the battery reports it can do) and "[Energy storage] Maximum
// discharging power" (47077, the setting). The driver read both into differently named
// objects but under the SAME key, and the capability was filled from the reported maximum
// — which does not move when the user changes the limit. The device setting was filled
// from the right register all along; a flow just had no way to reach it.
//
// So: the capability follows the setting register, both views are brought in line after a
// successful write, the discharge condition cards exist, and the pairing page calls the
// reported maximum what it is.

const Module = require('module');
const _origLoad = Module._load;

// What the inverter answers and what was written to it. One stub serves the device, the
// driver and the pairing handler; `ctrl` is returned for every read.
const pollErrors = [];

const modbus = {
  ctrl: {}, writes: [], fail: null, lastRegs: null, reads: [],
  // Answers only the registers it was asked for. A stub that returns the whole of `ctrl`
  // for every map hides which read produced which value — and it did: it let the data
  // poll drop its own _applyControl call without a single test noticing, because the
  // five-poll read handed the same values over anyway.
  async readModbusRegisters(host, port, unit, regs) {
    modbus.lastRegs = regs;
    modbus.reads.push(regs);
    if (modbus.fail) throw new Error(modbus.fail);
    if (modbus.onRead) modbus.onRead(regs);
    return Object.fromEntries(
      Object.keys(regs).filter((k) => k in modbus.ctrl).map((k) => [k, modbus.ctrl[k]]));
  },
  async writeModbusRegister(host, port, unit, reg, value) {
    if (modbus.fail) throw new Error(modbus.fail);
    modbus.writes.push({ reg, value });
  },
  async writeModbusU32(host, port, unit, reg, value) {
    if (modbus.fail) throw new Error(modbus.fail);
    modbus.writes.push({ reg, value });
  },
  parseIntSafe: (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; },
  unavailableMessage: () => 'unavailable',
};

Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {}, Driver: class {} };
  if (/lib\/modbus-client$/.test(request)) return modbus;
  if (/lib\/poll-log$/.test(request)) return { logPollOk() {}, logPollError(dev, msg) { pollErrors.push(msg); } };
  if (/lib\/pairing-helper$/.test(request)) {
    return {
      pauseDevicesOnHost: async () => [],
      resumePairedDevices: async () => {},
      parseIntSafe: modbus.parseIntSafe,
    };
  }
  return _origLoad.call(this, request, parent, isMain);
};

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const LUNA2000ModbusDevice = require('../drivers/luna2000_modbus/device.js');
const LUNA2000ModbusDriver = require('../drivers/luna2000_modbus/driver.js');
const manifest             = require('../app.json');

const settle = () => new Promise((r) => setTimeout(r, 25));

function card(id, into) {
  const c = {
    registerRunListener(fn) { into.set(id, fn); return c; },
    registerArgumentAutocompleteListener() { return c; },
    trigger: async () => {},
  };
  return c;
}

function makeDevice() {
  const d = Object.create(LUNA2000ModbusDevice.prototype);
  // Every capability the poll and _applyControl write. _set skips a capability the device
  // does not have, so a short list here would quietly turn assertions into no-ops.
  d.caps = {
    'measure_power.chargesetting': 5000, 'measure_power.dischargesetting': 5000,
    storage_working_mode_settings: null, storage_force_charge_discharge: null,
    storage_excess_pv_energy_use_in_tou: null, remote_charge_discharge_control_mode: null,
    luna2000_unit1_installed: null, luna2000_unit2_installed: null,
    measure_battery_modules: null, luna2000_battery_status: null,
    measure_power: null, measure_battery: null, battery_state_string: null,
    'meter_power.charged': null, 'meter_power.discharged': null,
    'measure_power.batt_charge': null, 'measure_power.batt_discharge': null,
    'meter_power.today_batt_input': null, 'meter_power.today_batt_output': null,
  };
  d.settings = { address: '192.168.1.10', port: 502, modbus_id: 1,
    max_charge_power: 5000, max_discharge_power: 5000,
    charge_from_grid: false, max_grid_charge_power: 2000,
    info_ems_battery: '—' };
  d.logs = [];
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = d.log;
  d.hasCapability = (c) => c in d.caps;
  d.getCapabilityValue = (c) => (c in d.caps ? d.caps[c] : null);
  d.setCapabilityValue = async (c, v) => { d.caps[c] = v; };
  d.getSetting = (k) => d.settings[k];
  d.setSettingsCalls = [];
  d.setSettings = async (o) => {
    d.setSettingsCalls.push({ ...o, _guarded: d._updatingSettingFromModbus === true });
    Object.assign(d.settings, o);
  };
  d.conditions = new Map();
  d.actions = new Map();
  d.notifications = [];
  d.getName = () => 'LUNA2000';
  d.emsDevices = [];
  d.homey = {
    __: (k) => k,
    manifest: require('../app.json'),
    i18n: { getLanguage: () => 'de' },
    drivers: { getDriver: (id) => {
      if (id !== 'energy_management') throw new Error('no such driver');
      return { getDevices: () => d.emsDevices };
    } },
    setTimeout, clearTimeout,
    notifications: {
      createNotification: async ({ excerpt }) => { d.notifications.push(excerpt); },
    },
    flow: {
      getDeviceTriggerCard: (id) => card(id, new Map()),
      getConditionCard:     (id) => card(id, d.conditions),
      getActionCard:        (id) => card(id, d.actions),
    },
  };
  d._updatingFromModbus = false;
  d._updatingSettingFromModbus = false;
  d._settingsInitialized = true;
  d._writeInProgress = false;
  d._prevWorkingMode = null; d._prevExcessPv = null; d._prevRemoteMode = null;
  d._batteryModulesInitialized = true; // skip the one-off module read in _fetchControl
  d._controlPollCounter = 4;           // as onInit sets it: the first poll reads control
  d._failureCount = 0;
  d._fetchInProgress = false;
  d._lastPollStart = 0;
  d.available = true;
  d.getAvailable = () => d.available;
  d.setAvailable = async () => { d.available = true; };
  d.setUnavailable = async () => { d.available = false; };
  d.addCapability = async (c) => { d.caps[c] = null; };
  d.removeCapability = async (c) => { delete d.caps[c]; };
  d.setEnergy = async () => {};
  return d;
}

function reset() {
  modbus.ctrl = {}; modbus.writes = []; modbus.fail = null; modbus.lastRegs = null;
  modbus.reads = []; modbus.onRead = null;
}

// Which addresses a read asked for, so a test can say WHICH registers rode on WHICH
// connection instead of trusting a stub that answers every map alike.
const addressesOf = (regs) => Object.values(regs).map((d) => d[0]).sort((a, b) => a - b);
const asked = (i) => addressesOf(modbus.reads[i]);

// ── the field case: the control poll ────────────────────────────────────────

test('the capabilities follow the setting registers, so a limit of 0 reads as 0', async () => {
  reset();
  const d = makeDevice();

  await d._applyControl({ storageMaxChargePower: 3500, storageMaxDischargePower: 0 });

  assert.strictEqual(d.caps['measure_power.dischargesetting'], 0, 'the token still shows a number the user never set');
  assert.strictEqual(d.caps['measure_power.chargesetting'], 3500);
  assert.strictEqual(d.settings.max_discharge_power, 0, 'the setting stopped following the inverter');
});

test('a read that did not return the limit leaves the capability alone', async () => {
  reset();
  const d = makeDevice();
  await d._applyControl({});   // nothing came back for these two
  assert.strictEqual(d.caps['measure_power.dischargesetting'], 5000, 'an unread register was reported as a value');
});

// ── which registers ride on which connection ────────────────────────────────
//
// A Modbus read is a TCP connection, and a Huawei device wants a full second to settle
// before the first register may be asked for. That second, not the registers, is what a
// separate control read costs — so the eleven settings registers at 47075..47108 travel
// with the battery data, and only the three scattered ones pay for a connection of their
// own, every fifth poll.

test('the settings registers travel with the battery data, on one connection', async () => {
  reset();
  modbus.ctrl = { storageSOC: 55, storageChargeDischarge: -300,
    storageMaxChargePower: 3500, storageMaxDischargePower: 0, storageWorkingMode: 2 };
  const d = makeDevice();

  await d._fetchAndUpdate();

  const first = asked(0);
  assert.ok(first.includes(37760), 'the battery SoC is not in the first read');
  assert.ok(first.includes(47075) && first.includes(47077),
    'the two power limits still need a connection of their own');
  assert.ok(first.includes(47086), 'the working mode still needs a connection of its own');
  assert.ok(!first.includes(47589),
    'the register the field log shows going silent was put on the every-poll connection');
  assert.ok(!first.includes(47299) && !first.includes(47242),
    'a register nothing reads often was put on the every-poll connection');
});

test('one poll is enough for a limit changed in Huawei’s own app', async () => {
  reset();
  modbus.ctrl = { storageSOC: 55, storageChargeDischarge: 0, storageMaxDischargePower: 0,
    storageWorkingMode: 2 };
  const d = makeDevice();

  await d._fetchAndUpdate();   // ONE poll, not five

  assert.strictEqual(d.caps['measure_power.dischargesetting'], 0);
  assert.strictEqual(d.settings.max_discharge_power, 0);
});

test('the scattered three are read on their own, and only those', async () => {
  reset();
  modbus.ctrl = { storageExcessPvEnergyUseInTou: 1, remoteChargeDischargeControlMode: 0 };
  const d = makeDevice();

  await d._fetchControl('192.168.1.10', 502, 1);

  const regs = asked(0);
  assert.deepStrictEqual(regs, [47242, 47299, 47589]);
  assert.strictEqual(d.caps['storage_excess_pv_energy_use_in_tou'], '1');
});

// The counter is what keeps 47589 off the every-poll connection; five polls, one visit.
test('the scattered three come round once every five polls', async () => {
  reset();
  modbus.ctrl = { storageSOC: 55, storageChargeDischarge: 0, storageWorkingMode: 2 };
  const d = makeDevice();
  d._batteryModulesInitialized = true;

  const rare = () => modbus.reads.filter((r) => addressesOf(r).includes(47589)).length;

  await d._fetchAndUpdate();                       // counter starts at 4 → reads at once
  assert.strictEqual(rare(), 1,
    `the first poll did not pick up the scattered three — poll errors: ${JSON.stringify(pollErrors)}`);

  for (let i = 0; i < 4; i++) await d._fetchAndUpdate();
  assert.strictEqual(rare(), 1, 'the scattered three were read more often than every fifth poll');

  await d._fetchAndUpdate();
  assert.strictEqual(rare(), 2, 'the scattered three never came round again');
});

// A write that arrives WHILE the poll is running is the case the guard inside the poll is
// for; one that was already waiting never gets past the early return at the top. Opening a
// connection to abort at the first register lays a full second of settle time on exactly
// the write it is trying to keep out of the way of, and reads nothing for it.
test('a write that lands mid-poll stops the rare read from starting', async () => {
  reset();
  modbus.ctrl = { storageSOC: 55, storageChargeDischarge: 0, storageWorkingMode: 2,
    storageExcessPvEnergyUseInTou: 1 };
  const d = makeDevice();
  d._batteryModulesInitialized = true;

  // The flow action sets this the moment it starts writing — here, during the battery read.
  modbus.onRead = () => { d._writeInProgress = true; };

  await d._fetchAndUpdate();

  assert.strictEqual(modbus.reads.length, 1,
    'a second connection was opened while a write was waiting, and would abort at register one');
  assert.strictEqual(d._controlPollCounter, 4,
    'the counter moved on, so the skipped read comes back in five polls instead of on the next');
});

// Opening a connection to abort at the first register lays a full second of settle time on
// exactly the write it is trying to keep out of the way of, and reads nothing for it.
test('a waiting write is not made to wait for a connection that reads nothing', async () => {
  reset();
  modbus.ctrl = { storageSOC: 55, storageChargeDischarge: 0, storageWorkingMode: 2 };
  const d = makeDevice();
  d._batteryModulesInitialized = true;

  await d._fetchAndUpdate();                       // counter 4 → 0, rare read happens
  modbus.reads = [];
  d._writeInProgress = true;
  await d._fetchAndUpdate();                       // _fetchAndUpdate returns early here
  d._writeInProgress = false;

  assert.deepStrictEqual(modbus.reads, [], 'a poll ran while a write was waiting');
});

// ── the flag that lets onSettings write at all ──────────────────────────────

test('settings writes are unlocked by the first poll, not by the fifth', async () => {
  reset();
  modbus.ctrl = { storageSOC: 55, storageChargeDischarge: 0, storageWorkingMode: 2 };
  const d = makeDevice();
  d._settingsInitialized = false;
  d._batteryModulesInitialized = true;

  await d._fetchAndUpdate();

  assert.strictEqual(d._settingsInitialized, true,
    'a settings edit would be dropped silently until the fifth poll');
});

test('an empty settings span does not unlock writes', async () => {
  reset();
  const d = makeDevice();
  d._settingsInitialized = false;

  await d._applyControl({ storageSOC: 55 });   // battery answered, the 47xxx span did not

  assert.strictEqual(d._settingsInitialized, false,
    'onSettings would overwrite values the app has never read');
});

// The two halves arrive separately and neither may erase what the other set.
test('the half that did not arrive leaves the other half standing', async () => {
  reset();
  const d = makeDevice();

  await d._applyControl({ storageMaxDischargePower: 0, storageWorkingMode: 2 });
  await d._applyControl({ storageExcessPvEnergyUseInTou: 1 });

  assert.strictEqual(d.caps['measure_power.dischargesetting'], 0, 'the second half cleared the first');
  assert.strictEqual(d.caps['storage_working_mode_settings'], '2');
  assert.strictEqual(d.caps['storage_excess_pv_energy_use_in_tou'], '1');
});

// A setting that cannot be read is not a battery that cannot be reached.
test('a fault on the control side does not count against the device', async () => {
  reset();
  const d = makeDevice();
  d._failureCount = 0;
  d.setSettings = async () => { throw new Error('store is busy'); };

  await d._applyControl({ storageMaxDischargePower: 1234, storageWorkingMode: 2 });

  assert.strictEqual(d._failureCount, 0, 'a control-side fault was counted as a failed poll');
});

// ── the write paths: both views move together, and only on success ──────────

test('a limit set from the flow card shows in the capability and the setting at once', async () => {
  reset();
  const d = makeDevice();
  d._registerFlowActions();

  d.actions.get('luna2000_set_max_discharge_power')({ device: d, power: 0 });
  await settle();

  assert.deepStrictEqual(modbus.writes, [{ reg: 47077, value: 0 }]);
  assert.strictEqual(d.caps['measure_power.dischargesetting'], 0, 'the token lags behind the write');
  assert.strictEqual(d.settings.max_discharge_power, 0);
});

test('the charge card does the same for its own pair', async () => {
  reset();
  const d = makeDevice();
  d._registerFlowActions();

  d.actions.get('luna2000_set_max_charge_power')({ device: d, power: 2000 });
  await settle();

  assert.deepStrictEqual(modbus.writes, [{ reg: 47075, value: 2000 }]);
  assert.strictEqual(d.caps['measure_power.chargesetting'], 2000);
  assert.strictEqual(d.settings.max_charge_power, 2000);
});

test('a write the inverter refused changes neither view', async () => {
  reset();
  modbus.fail = 'timeout waiting for response';
  const d = makeDevice();
  d._registerFlowActions();

  d.actions.get('luna2000_set_max_discharge_power')({ device: d, power: 0 });
  await settle();

  assert.strictEqual(d.caps['measure_power.dischargesetting'], 5000, 'the token claims a limit the inverter never took');
  assert.strictEqual(d.settings.max_discharge_power, 5000);
  assert.ok(d.logs.some((l) => /failed/.test(l)), 'the refusal went unlogged');
});

test('a limit edited in the device settings reaches the capability after the write', async () => {
  reset();
  const d = makeDevice();
  d.settings.max_discharge_power = 0; // Homey has already applied the edit when onSettings runs

  await d.onSettings({
    oldSettings: { max_discharge_power: 5000 },
    newSettings: { max_discharge_power: 0 },
    changedKeys: ['max_discharge_power'],
  });
  await settle();

  assert.deepStrictEqual(modbus.writes, [{ reg: 47077, value: 0 }]);
  assert.strictEqual(d.caps['measure_power.dischargesetting'], 0);
  assert.strictEqual(d.settings.max_discharge_power, 0, 'the field lost the value that was accepted');
});

// The test this file shipped with checked only the capability, and that is exactly how the
// sentence "a write the inverter refuses changes neither" reached the 1.2.238 changelog: the
// FIELD kept the refused number. It is the field the condition cards read.
test('a settings edit the inverter refused is taken back, field included', async () => {
  reset();
  modbus.fail = 'ECONNRESET';
  const d = makeDevice();
  d.settings.max_discharge_power = 0;   // Homey applied it before onSettings ran

  await d.onSettings({
    oldSettings: { max_discharge_power: 5000 },
    newSettings: { max_discharge_power: 0 },
    changedKeys: ['max_discharge_power'],
  });
  await settle();

  assert.strictEqual(d.caps['measure_power.dischargesetting'], 5000, 'the capability moved on a refused write');
  assert.strictEqual(d.settings.max_discharge_power, 5000,
    'the field still shows a limit the inverter never took \u2014 and the condition cards read the field');
});

// Putting it back without saying so would only replace one puzzle with another.
test('the revert is said out loud, once, under the existing toggle', async () => {
  reset();
  modbus.fail = 'ECONNRESET';
  const d = makeDevice();
  d.settings.max_discharge_power = 0;

  await d.onSettings({
    oldSettings: { max_discharge_power: 5000 },
    newSettings: { max_discharge_power: 0 },
    changedKeys: ['max_discharge_power'],
  });
  await settle();

  assert.strictEqual(d.notifications.length, 1, `expected one timeline note, got ${d.notifications.length}`);
  assert.match(d.notifications[0], /Max discharge power/, 'the note does not name the setting');
  assert.match(d.notifications[0], /ECONNRESET/, 'the note does not say why');
  assert.match(d.notifications[0], /5000/, 'the note does not say what it was put back to');
});

test('with timeline notifications off the revert still happens, silently', async () => {
  reset();
  modbus.fail = 'ECONNRESET';
  const d = makeDevice();
  d.settings.enable_timeline_notifications = false;
  d.settings.max_discharge_power = 0;

  await d.onSettings({
    oldSettings: { max_discharge_power: 5000 },
    newSettings: { max_discharge_power: 0 },
    changedKeys: ['max_discharge_power'],
  });
  await settle();

  assert.strictEqual(d.settings.max_discharge_power, 5000, 'the toggle silenced the revert itself');
  assert.deepStrictEqual(d.notifications, []);
});

// The revert writes the settings store, and onSettings writes the inverter. Without the
// guard the revert would be handed straight back to the inverter as a new user edit.
test('the revert does not travel back out to the inverter', async () => {
  reset();
  modbus.fail = 'ECONNRESET';
  const d = makeDevice();
  d.settings.max_discharge_power = 0;

  await d.onSettings({
    oldSettings: { max_discharge_power: 5000 },
    newSettings: { max_discharge_power: 0 },
    changedKeys: ['max_discharge_power'],
  });
  await settle();

  assert.deepStrictEqual(d.setSettingsCalls, [{ max_discharge_power: 5000, _guarded: true }],
    'setSettings ran without _updatingSettingFromModbus, so onSettings will write it back out');
  assert.strictEqual(d._updatingSettingFromModbus, false, 'the guard was left set');
});

// Every write path in onSettings shares the defect, so every one of them shares the cure.
test('the revert covers the other settings that write to the inverter', async () => {
  for (const [key, before, after] of [
    ['charge_from_grid',          false, true],
    ['grid_charge_cutoff_soc',    50,    90],
    ['charging_cutoff_capacity',  100,   95],
    ['discharge_cutoff_capacity', 15,    20],
    ['backup_power_soc',          0,     30],
    ['max_charge_power',          5000,  2000],
    ['max_grid_charge_power',     2000,  1000],
  ]) {
    reset();
    modbus.fail = 'timeout';
    const d = makeDevice();
    d.settings[key] = after;

    await d.onSettings({
      oldSettings: { [key]: before },
      newSettings: { [key]: after },
      changedKeys: [key],
    });
    await settle();

    assert.strictEqual(d.settings[key], before, `${key}: a refused write was left standing in the field`);
  }
});

// Nothing to put back, and nothing to announce.
test('a write that was never applied to the field is not reverted', async () => {
  reset();
  modbus.fail = 'ECONNRESET';
  const d = makeDevice();
  d.settings.max_discharge_power = 5000;   // unchanged \u2014 same as oldSettings

  await d.onSettings({
    oldSettings: { max_discharge_power: 5000 },
    newSettings: { max_discharge_power: 5000 },
    changedKeys: ['max_discharge_power'],
  });
  await settle();

  assert.deepStrictEqual(d.setSettingsCalls, [], 'the store was written for nothing');
  assert.deepStrictEqual(d.notifications, [], 'a note about a setting that never moved');
});

// An older Homey, or a caller that does not pass oldSettings: log and leave it, never guess.
test('without a previous value nothing is invented', async () => {
  reset();
  modbus.fail = 'ECONNRESET';
  const d = makeDevice();
  d.settings.max_discharge_power = 0;

  await d.onSettings({ newSettings: { max_discharge_power: 0 }, changedKeys: ['max_discharge_power'] });
  await settle();

  assert.strictEqual(d.settings.max_discharge_power, 0, 'a value was made up to revert to');
  assert.deepStrictEqual(d.notifications, []);
  assert.ok(d.logs.some((l) => /failed/.test(l)), 'the refusal went unlogged');
});

// ── the helper itself ───────────────────────────────────────────────────────

test('_reflectMaxPower writes the setting under the guard that stops it echoing back', async () => {
  reset();
  const d = makeDevice();
  await d._reflectMaxPower('max_discharge_power', 0);

  assert.strictEqual(d.caps['measure_power.dischargesetting'], 0);
  assert.deepStrictEqual(d.setSettingsCalls, [{ max_discharge_power: 0, _guarded: true }],
    'setSettings ran without _updatingSettingFromModbus, so onSettings will write the value straight back');
  assert.strictEqual(d._updatingSettingFromModbus, false, 'the guard was left set');
});

test('_reflectMaxPower does not rewrite a setting that already matches', async () => {
  reset();
  const d = makeDevice();
  await d._reflectMaxPower('max_charge_power', 5000);
  assert.deepStrictEqual(d.setSettingsCalls, [], 'a no-op write to the settings store');
});

test('_reflectMaxPower ignores what it cannot use', async () => {
  reset();
  const d = makeDevice();
  await d._reflectMaxPower('max_discharge_power', NaN);
  await d._reflectMaxPower('not_a_limit', 1000);
  assert.strictEqual(d.caps['measure_power.dischargesetting'], 5000);
  assert.deepStrictEqual(d.setSettingsCalls, []);
});

// ── the missing condition cards ─────────────────────────────────────────────

test('the discharge conditions compare the discharge setting, not the charge one', () => {
  const d = makeDevice();
  d._registerConditions();
  const below = d.conditions.get('luna2000_max_discharge_power_below');
  const above = d.conditions.get('luna2000_max_discharge_power_above');
  assert.ok(below && above, 'the discharge pair is not registered');

  // charge still at 5000, discharge blocked at 0 — the reporter's exact situation
  const dev = { getSetting: (k) => ({ max_charge_power: 5000, max_discharge_power: 0 })[k] };
  assert.strictEqual(below({ device: dev, power: 1 }), true, '"below 1" is the documented way to ask "is it blocked"');
  assert.strictEqual(above({ device: dev, power: 1000 }), false);

  const open = { getSetting: (k) => ({ max_charge_power: 0, max_discharge_power: 5000 })[k] };
  assert.strictEqual(above({ device: open, power: 1000 }), true);
  assert.strictEqual(below({ device: open, power: 1000 }), false);
});

test('the discharge conditions are strict, like the charge ones', () => {
  const d = makeDevice();
  d._registerConditions();
  const dev = { getSetting: () => 1000 };
  assert.strictEqual(d.conditions.get('luna2000_max_discharge_power_above')({ device: dev, power: 1000 }), false);
  assert.strictEqual(d.conditions.get('luna2000_max_discharge_power_below')({ device: dev, power: 1000 }), false);
});

test('a setting never synced yet makes neither condition true', () => {
  const d = makeDevice();
  d._registerConditions();
  const dev = { getSetting: () => null };
  assert.strictEqual(d.conditions.get('luna2000_max_discharge_power_above')({ device: dev, power: 0 }), false);
  assert.strictEqual(d.conditions.get('luna2000_max_discharge_power_below')({ device: dev, power: 100000 }), false);
});

// 1.2.238 shipped "Use threshold 1" on two cards whose threshold field stepped in 100s, so
// the number the help text recommends could not be typed. The step is 1 now; this keeps the
// text and the field agreeing whichever of the two someone changes next.
test('the threshold the hint recommends can actually be entered', () => {
  for (const c of manifest.flow.conditions.filter((x) => /^luna2000_max_(dis)?charge_power_/.test(x.id))) {
    const arg = c.args.find((a) => a.name === 'power');
    assert.strictEqual(arg.min, 0, `${c.id}: a blocked limit of 0 is out of range`);
    for (const lang of ['en', 'de', 'nl']) {
      const m = c.hint[lang].match(/(?:threshold|Schwellwert|drempel) (\\d+)/i);
      if (!m) continue;                       // the above-cards name no threshold
      const recommended = Number(m[1]);
      assert.strictEqual(recommended % arg.step, 0,
        `${c.id} (${lang}): the hint says ${recommended}, but the field steps in ${arg.step}s`);
      assert.ok(recommended >= arg.min, `${c.id} (${lang}): ${recommended} is below the field minimum`);
    }
  }
});

// Both pairs are covered by _reflectMaxPower, so both may say so. The charge pair could not
// until 1.2.238 gave it the helper, and the sentence was not added at the time.
test('all four cards say how soon a change from Homey shows', () => {
  const CLAUSE = {
    en: 'at once after a change made from Homey',
    de: 'nach einer \u00c4nderung aus Homey sofort',
    nl: 'direct na een wijziging vanuit Homey',
  };
  for (const c of manifest.flow.conditions.filter((x) => /^luna2000_max_(dis)?charge_power_/.test(x.id))) {
    for (const lang of ['en', 'de', 'nl']) {
      assert.ok(c.hint[lang].includes(CLAUSE[lang]),
        `${c.id} (${lang}) does not say a change from Homey shows at once`);
    }
  }
});

test('the discharge cards mirror the charge cards in everything but the words', () => {
  const byId = Object.fromEntries(manifest.flow.conditions.map((c) => [c.id, c]));
  for (const kind of ['above', 'below']) {
    const charge = byId['luna2000_max_charge_power_' + kind];
    const disch  = byId['luna2000_max_discharge_power_' + kind];
    assert.ok(disch, `luna2000_max_discharge_power_${kind} is not declared`);
    assert.deepStrictEqual(disch.args, charge.args, `${kind}: the arguments differ from the charge card`);
    for (const lang of ['en', 'de', 'nl']) {
      assert.ok(disch.title[lang] && disch.titleFormatted[lang] && disch.hint[lang], `${kind}: ${lang} text missing`);
      assert.match(disch.titleFormatted[lang], /\[\[power\]\]/, `${kind}: ${lang} title does not show the threshold`);
    }
    assert.match(disch.title.en, /discharge/);
    assert.match(disch.title.de, /Entladeleistung/);
    assert.match(disch.title.nl, /ontlaadvermogen/);
    assert.match(disch.hint.en, /47077/, `${kind}: the hint does not name the register it compares`);
  }
  assert.match(byId.luna2000_max_discharge_power_below.hint.en, /threshold 1/,
    'the below-card should say how to ask "is it blocked", as the charge card does');
});

// ── the pairing page asks for what it labels ────────────────────────────────

test('pairing probes the reported maximum under its own name and hands it on as such', async () => {
  reset();
  modbus.ctrl = { storageSOC: 55, storageChargeDischarge: -300, essMaxChargePower: 5000,
    essMaxDischargePower: 5000, storageDayCharge: 1.2, storageDayDischarge: 0.4 };
  const drv = Object.create(LUNA2000ModbusDriver.prototype);
  drv.log = () => {};
  drv.homey = { __: (k) => k };
  const handlers = {};
  await drv.onPair({ setHandler: (name, fn) => { handlers[name] = fn; } });

  const r = await handlers.connect({ address: '192.168.1.10', port: 502, modbusId: 1, name: 'x' });

  assert.strictEqual(modbus.lastRegs.essMaxChargePower[0], 37046, 'the probe asks a different register than it labels');
  assert.strictEqual(modbus.lastRegs.essMaxDischargePower[0], 37048);
  assert.strictEqual('storageMaxChargePower' in modbus.lastRegs, false, 'the old shared key is still being probed');
  assert.strictEqual(r.kpi.essMaxChargePower, 5000);
  assert.strictEqual(r.kpi.essMaxDischargePower, 5000);
});

// The page cannot be run here; its two bindings to the KPI are read instead.
test('the pairing page shows the reported maximum, not the setting', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'drivers', 'luna2000_modbus', 'pair', 'start.html'), 'utf8');
  assert.match(html, /kpi\.essMaxChargePower/);
  assert.match(html, /kpi\.essMaxDischargePower/);
  assert.doesNotMatch(html, /kpi\.storageMax(Dis)?[Cc]hargePower/, 'the page still reads the old key');
});

// Anchored on the i18n keys, not on the file as a whole. The <div> carries the same words
// as a pre-script fallback, and matching anywhere let a mutation that reverted only the
// English i18n entry pass — while that entry is exactly what the user sees, because the
// script overwrites the div's text from it.
test('the pairing labels call the value the battery’s, in both languages', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'drivers', 'luna2000_modbus', 'pair', 'start.html'), 'utf8');

  for (const [key, expected] of [
    ['labelMaxCharge',    ['Battery max. charge',    'Batterie: max. Laden']],
    ['labelMaxDischarge', ['Battery max. discharge', 'Batterie: max. Entladen']],
  ]) {
    const found = [...html.matchAll(new RegExp(`${key}:\\s*'([^']*)'`, 'g'))].map((m) => m[1]);
    assert.deepStrictEqual(found, expected,
      `${key} does not read as the battery's own maximum in both languages`);
  }

  // The div is what shows for the instant before the script runs; it must not disagree.
  assert.match(html, /id="kpi-label-max-charge">Battery max\. charge</);
  assert.match(html, /id="kpi-label-max-discharge">Battery max\. discharge</);
});

// ── the counter that decides when the scattered three are read ──────────────
//
// A source read, because onInit cannot be driven here — and this is exactly the defect the
// EMMA battery driver carried until 1.2.240: its counter started at 0, so the first control
// read came only on the fifth poll. Left unset entirely it is worse than late, because
// (undefined + 1) % 5 is NaN and the read then never happens at all, silently, for ever.
test('every driver with a control poll starts its counter so the first poll reads', () => {
  const drivers = fs.readdirSync(path.join(__dirname, '..', 'drivers'));
  let checked = 0;
  for (const id of drivers) {
    const file = path.join(__dirname, '..', 'drivers', id, 'device.js');
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    if (!/_controlPollCounter\s*=\s*\(this\._controlPollCounter/.test(src)) continue; // no control poll

    const init = src.match(/this\._controlPollCounter\s*=\s*(\d+)\s*;/);
    assert.ok(init, `${id}: uses a control-poll counter and never initialises it — the read never happens`);
    assert.strictEqual(init[1], '4',
      `${id}: the counter starts at ${init[1]}, so the first control read waits for poll ${(5 - Number(init[1])) % 5 || 5}`);
    checked++;
  }
  assert.ok(checked >= 3, `only ${checked} drivers checked — the counter moved or the scan is wrong`);
});

// ── the gate and the value live in different halves ─────────────────────────
//
// 47087 (charge from grid) rides with the battery data every poll; 47242 (the grid charge
// set point it gates) comes round every fifth. Reading the gate from the register alone
// means no call ever has both, and 1.2.240 stopped syncing max_grid_charge_power entirely —
// silently, because nothing asserted on it.

test('the grid charge set point still syncs, though its gate rides in the other half', async () => {
  reset();
  const d = makeDevice();
  d.settings.charge_from_grid = true;        // written by the live half, at most one poll ago
  d.settings.max_grid_charge_power = 2000;

  await d._applyControl({ storageGridChargePower: 1000 });   // the rare half: no gate register

  assert.strictEqual(d.settings.max_grid_charge_power, 1000,
    'neither half carries both the gate and the value, so nothing was synced');
});

test('a disabled grid charge still suppresses the sync', async () => {
  reset();
  const d = makeDevice();
  d.settings.charge_from_grid = false;
  d.settings.max_grid_charge_power = 2000;

  await d._applyControl({ storageGridChargePower: 1000 });

  assert.strictEqual(d.settings.max_grid_charge_power, 2000,
    'a set point that means nothing while grid charging is off was synced anyway');
});

// The fallback is for the half that lacks the register, never a replacement for it.
test('the gate register wins over the setting when this half carried it', async () => {
  reset();
  const d = makeDevice();
  d.settings.charge_from_grid = true;        // stale
  d.settings.max_grid_charge_power = 2000;

  await d._applyControl({ storageChargeFromGrid: 0, storageGridChargePower: 1000 });

  assert.strictEqual(d.settings.max_grid_charge_power, 2000,
    'a stale setting overrode the register that was actually read');
});

// Whatever _applyControl reads must be reachable from one of the two halves, or it is dead.
test('every register _applyControl reads is in one of the two halves', () => {
  const src  = fs.readFileSync(
    path.join(__dirname, '..', 'drivers', 'luna2000_modbus', 'device.js'), 'utf8');
  const half = (name) => new Set(
    [...src.slice(src.indexOf(`const ${name} = {`), src.indexOf('};', src.indexOf(`const ${name} = {`)))
      .matchAll(/(\w+):\s+CONTROL_REGISTERS/g)].map((m) => m[1]));
  const live = half('LIVE_CONTROL_REGISTERS');
  const rare = half('RARE_CONTROL_REGISTERS');
  assert.ok(live.size === 11 && rare.size === 3, `halves are ${live.size}/${rare.size}, expected 11/3`);

  // Bounded forwards from _applyControl: _notifyForceAbort is CALLED by the force cards
  // long before it is defined, so searching from the start of the file lands on a call and
  // the slice comes out empty — which read as "no registers used" rather than as a broken test.
  const start = src.indexOf('async _applyControl(ctrl)');
  const body  = src.slice(start, src.indexOf('_notifyForceAbort(kind', start));
  const used = new Set([...body.matchAll(/ctrl\.(\w+)/g)].map((m) => m[1]));
  assert.ok(used.size >= 8, `only ${used.size} registers used — the scan is looking in the wrong place`);

  for (const key of used) {
    assert.ok(live.has(key) || rare.has(key),
      `_applyControl reads ctrl.${key}, which neither half ever provides`);
  }
});
