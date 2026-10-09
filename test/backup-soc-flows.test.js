'use strict';

// The backup power reserve, in flows. Run: node --test
//
// Issue #32 (gsommer): the app has been able to WRITE this value from a flow for a long
// time — "Set backup power reserve SoC" — but nothing could read it back. So a flow that set
// the reserve had no way to notice when it was changed in FusionSolar, on the inverter, or
// by hand in the app settings. He raises it to 80 % when snow is forecast and wants another
// setting to follow it at a fixed margin; today he has to remember to update both.
//
// The value was never missing. Register 47102 has been read on every poll for years and
// written into a device setting, where no flow can see it. What was missing was a way out.
//
// Both battery drivers are covered, because the EMMA one already carried the capability
// (from register 30373, a different address for the same quantity) and only the direct
// Modbus driver lacked it. Leaving that lopsided is how two devices come to disagree about
// what they call the same number — which is the mistake this app keeps having to undo.

const Module = require('module');
const _origLoad = Module._load;

const modbus = {
  data: {},
  async readModbusRegisters(host, port, unit, regs) {
    return Object.fromEntries(
      Object.keys(regs).filter((k) => k in modbus.data).map((k) => [k, modbus.data[k]]));
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
const fs       = require('fs');
const path     = require('path');
const manifest = require('../app.json');
const REG      = require('../lib/modbus-registers');

const LunaModbus = require('../drivers/luna2000_modbus/device.js');
const LunaEmma   = require('../drivers/luna2000_emma_modbus/device.js');

const CAP     = 'measure_battery.backup';
const CHANGED = 'luna2000_backup_soc_changed';
const ABOVE   = 'luna2000_backup_soc_above';
const BELOW   = 'luna2000_backup_soc_below';
const BATTERY_DRIVERS = ['luna2000_modbus', 'luna2000_emma_modbus'];

// ── the manifest ────────────────────────────────────────────────────────────

test('both battery drivers carry the capability, and call it the same thing', () => {
  // The EMMA had it as "Backup SOC" and the other driver's setting called it "Backup power
  // SoC". One number, two names, on two devices somebody may well own both of.
  const titles = [];
  for (const id of BATTERY_DRIVERS) {
    const driver = manifest.drivers.find((d) => d.id === id);
    assert.ok(driver.capabilities.includes(CAP), `${id} does not have ${CAP}`);
    const options = driver.capabilitiesOptions[CAP];
    assert.ok(options, `${id}: ${CAP} has no options`);
    for (const lang of ['en', 'de', 'nl']) {
      assert.ok(options.title[lang], `${id}: no ${lang} title`);
    }
    titles.push(JSON.stringify(options.title));
  }
  assert.strictEqual(titles[0], titles[1],
    'the two battery devices spell the same reading differently');
});

test('the trigger hands over the new value, for either battery', () => {
  const card = manifest.flow.triggers.find((c) => c.id === CHANGED);
  assert.ok(card, 'the trigger is missing');
  for (const id of BATTERY_DRIVERS) {
    assert.ok(card.args[0].filter.includes(id), `the trigger does not offer ${id}`);
  }
  const token = card.tokens.find((t) => t.name === 'soc');
  assert.ok(token, 'no soc token — the whole point of the card');
  assert.strictEqual(token.type, 'number');
  for (const lang of ['en', 'de', 'nl']) {
    assert.ok(card.title[lang] && card.hint[lang], `the trigger has no ${lang} text`);
  }
});

test('the two conditions take a percentage, for either battery', () => {
  for (const id of [ABOVE, BELOW]) {
    const card = manifest.flow.conditions.find((c) => c.id === id);
    assert.ok(card, `${id} is missing`);
    for (const driverId of BATTERY_DRIVERS) {
      assert.ok(card.args[0].filter.includes(driverId), `${id} does not offer ${driverId}`);
    }
    const arg = card.args.find((a) => a.name === 'soc');
    assert.ok(arg, `${id}: no soc argument`);
    assert.strictEqual(arg.type, 'number');
    assert.strictEqual(arg.min, 0);
    assert.strictEqual(arg.max, 100);
    for (const lang of ['en', 'de', 'nl']) {
      assert.ok(card.title[lang] && card.titleFormatted[lang] && card.hint[lang],
        `${id} has no ${lang} text`);
    }
  }
});

test('no hint on the battery still claims the old five-cycle cadence', () => {
  // These registers moved into the half that rides with the battery data in 1.2.240, and
  // four flow hints plus three setting hints went on saying otherwise. The inverter is
  // deliberately not included: sun2000_modbus really does still read its control registers
  // every fifth poll, so its hints are correct and must stay.
  const STALE = /every 5 poll cycles|alle 5 Abfragezyklen|elke 5 uitleescycli/;

  for (const kind of ['triggers', 'conditions', 'actions']) {
    for (const card of manifest.flow[kind] || []) {
      if (!card.hint) continue;
      const onBattery = BATTERY_DRIVERS.some((d) => (card.args || [])
        .some((a) => (a.filter || '').includes(d)));
      if (!onBattery) continue;
      assert.doesNotMatch(JSON.stringify(card.hint), STALE,
        `${kind}/${card.id} still promises a five-cycle sync`);
    }
  }

  const battery = manifest.drivers.find((d) => d.id === 'luna2000_modbus');
  for (const group of battery.settings || []) {
    for (const child of group.children || [group]) {
      if (!child.hint) continue;
      assert.doesNotMatch(JSON.stringify(child.hint), STALE,
        `setting ${child.id} still promises a five-cycle sync`);
    }
  }

  // …and the inverter's, which are still true, are left alone
  const inverter = manifest.drivers.find((d) => d.id === 'sun2000_modbus');
  const kept = (inverter.settings || []).flatMap((g) => g.children || [g])
    .filter((c) => c.hint && STALE.test(JSON.stringify(c.hint)));
  assert.ok(kept.length >= 4,
    'the inverter hints were corrected too, but its control read really is every fifth poll');
});

// ── a device that records what it was asked to do ───────────────────────────

function makeCards() {
  const cards = {};
  const card = (id) => {
    if (!cards[id]) {
      cards[id] = {
        fired: [],
        listener: null,
        registerRunListener(fn) { cards[id].listener = fn; return cards[id]; },
        async trigger(device, tokens) { cards[id].fired.push(tokens); },
      };
    }
    return cards[id];
  };
  return { cards, card };
}

function makeDevice(Cls, { cards, card }) {
  const d = Object.create(Cls.prototype);
  // _set skips a capability the device does not have, so the ones under test are declared
  // here — as null, which is also what a device that has not reported yet looks like.
  d.caps = { [CAP]: null };
  d.settings = {
    address: '10.0.0.5', port: '502', modbus_id: '1',
    charge_from_grid: false, max_grid_charge_power: 2000,
  };
  d.log = () => {};
  d.error = () => {};
  d.getName = () => 'Battery';
  d.hasCapability = (c) => c in d.caps;
  d.getCapabilityValue = (c) => (c in d.caps ? d.caps[c] : null);
  d.setCapabilityValue = async (c, v) => { d.caps[c] = v; };
  d.getSetting = (k) => d.settings[k];
  d.setSettings = async (o) => { Object.assign(d.settings, o); };
  d.getAvailable = () => true;
  d.setAvailable = async () => {};
  d.setUnavailable = async () => {};
  d.homey = {
    __: (k) => k,
    manifest,
    i18n: { getLanguage: () => 'en' },
    drivers: { getDriver: () => { throw new Error('no such driver'); } },
    flow: { getDeviceTriggerCard: card, getConditionCard: card, getActionCard: card },
  };
  d._updatingFromModbus = false;
  d._updatingSettingFromModbus = false;
  d._fetchInProgress = false;
  d._writeInProgress = false;
  d._failureCount = 0;
  d._controlPollCounter = 1;
  d._prevWorkingMode = null;
  d._prevExcessPv = null;
  d._prevRemoteMode = null;
  d._prevChargingState = null;
  d._prevBackupSoc = null;
  d._batteryModulesInitialized = true;
  d._noteWrite = () => {};
  d.cards = cards;
  return d;
}

// The capability has to arrive from the register the driver actually reads, and the two
// drivers read different ones for it.
const EMMA_POLL = {
  soc: 55, batteryPower: 0, essChargeableCapacity: 5, essDischargableCapacity: 5,
  totalChargedEnergy: 100, totalDischargedEnergy: 90, chargedToday: 1, dischargedToday: 1,
};

async function pollEmma(d, backupSoc) {
  modbus.data = { ...EMMA_POLL, backupSoc };
  d._fetchInProgress = false;
  await d._fetchAndUpdate();
}

// ── the value reaches the capability ────────────────────────────────────────

test('the Modbus battery reads the reserve from 47102 into the capability', async () => {
  assert.strictEqual(REG.CONTROL_REGISTERS.storageBackupPowerSoc[0], 47102,
    'the register this whole card is about has moved');

  const d = makeDevice(LunaModbus, makeCards());
  await d._applyControl({ storageBackupPowerSoc: 15 });
  assert.strictEqual(d.caps[CAP], 15);
});

test('the EMMA battery reads it from 30373 into the same capability', async () => {
  assert.strictEqual(REG.EMMA_REGISTERS.backupSoc[0], 30373,
    'the EMMA reads the reserve from somewhere else now');

  const d = makeDevice(LunaEmma, makeCards());
  await pollEmma(d, 22);
  assert.strictEqual(d.caps[CAP], 22);
});

// ── the trigger ─────────────────────────────────────────────────────────────

test('a change fires the trigger, carrying the new value', async () => {
  for (const [name, drive] of [
    ['Modbus', async (d, v) => d._applyControl({ storageBackupPowerSoc: v })],
    ['EMMA',   async (d, v) => pollEmma(d, v)],
  ]) {
    const made = makeCards();
    const d = makeDevice(name === 'EMMA' ? LunaEmma : LunaModbus, made);

    await drive(d, 15);
    await drive(d, 80);

    const fired = made.cards[CHANGED] ? made.cards[CHANGED].fired : [];
    assert.deepStrictEqual(fired, [{ soc: 80 }], `${name}: wrong firing`);
  }
});

test('the first poll after a restart fires nothing', async () => {
  // Every value looks new when there is nothing to compare it with. Firing there would
  // announce a change that never happened, every time the app restarts.
  for (const [name, Cls, drive] of [
    ['Modbus', LunaModbus, async (d, v) => d._applyControl({ storageBackupPowerSoc: v })],
    ['EMMA',   LunaEmma,   async (d, v) => pollEmma(d, v)],
  ]) {
    const made = makeCards();
    const d = makeDevice(Cls, made);
    await drive(d, 15);
    assert.deepStrictEqual(made.cards[CHANGED] ? made.cards[CHANGED].fired : [], [],
      `${name}: fired on the very first reading`);
    assert.strictEqual(d.caps[CAP], 15, `${name}: the value did not reach the tile either`);
  }
});

test('an unchanged value fires nothing, poll after poll', async () => {
  const made = makeCards();
  const d = makeDevice(LunaModbus, made);
  for (let i = 0; i < 4; i++) await d._applyControl({ storageBackupPowerSoc: 15 });
  assert.deepStrictEqual(made.cards[CHANGED] ? made.cards[CHANGED].fired : [], []);
});

test('a poll that carries no reserve leaves the last one standing', async () => {
  // The control registers arrive in halves, and a half without this one must not read as
  // "the reserve is gone" — nor fire a change back to the old value when it returns.
  const made = makeCards();
  const d = makeDevice(LunaModbus, made);
  await d._applyControl({ storageBackupPowerSoc: 15 });
  await d._applyControl({ storageWorkingMode: 2 });          // the other half
  assert.strictEqual(d.caps[CAP], 15, 'the reserve was cleared by an unrelated poll');
  await d._applyControl({ storageBackupPowerSoc: 15 });
  assert.deepStrictEqual(made.cards[CHANGED] ? made.cards[CHANGED].fired : [], [],
    'a gap in the readings was reported as a change');
});

test('zero is a reserve, not a missing reading', async () => {
  // Nought is the factory default for this register, so a falsy check here would make the
  // commonest setting of all invisible.
  const made = makeCards();
  const d = makeDevice(LunaModbus, made);
  await d._applyControl({ storageBackupPowerSoc: 20 });
  await d._applyControl({ storageBackupPowerSoc: 0 });
  assert.strictEqual(d.caps[CAP], 0);
  assert.deepStrictEqual(made.cards[CHANGED].fired, [{ soc: 0 }]);
});

// ── the conditions ──────────────────────────────────────────────────────────

function listeners(Cls) {
  const made = makeCards();
  const d = makeDevice(Cls, made);
  d._registerConditions();
  return { made, d };
}

test('the conditions compare the reserve the device is actually showing', () => {
  const { made, d } = listeners(LunaModbus);
  d.caps[CAP] = 15;

  assert.strictEqual(made.cards[ABOVE].listener({ device: d, soc: 10 }), true);
  assert.strictEqual(made.cards[ABOVE].listener({ device: d, soc: 20 }), false);
  assert.strictEqual(made.cards[BELOW].listener({ device: d, soc: 20 }), true);
  assert.strictEqual(made.cards[BELOW].listener({ device: d, soc: 10 }), false);
});

test('a reserve exactly on the threshold is neither above nor below it', () => {
  const { made, d } = listeners(LunaModbus);
  d.caps[CAP] = 15;
  assert.strictEqual(made.cards[ABOVE].listener({ device: d, soc: 15 }), false);
  assert.strictEqual(made.cards[BELOW].listener({ device: d, soc: 15 }), false);
});

test('a device that has not reported yet answers false, not zero', () => {
  // A null read as 0 would make "below 20" true on a battery that has said nothing at all,
  // and a flow would act on a reserve nobody has measured.
  const { made, d } = listeners(LunaModbus);
  assert.strictEqual(d.getCapabilityValue(CAP), null);
  assert.strictEqual(made.cards[ABOVE].listener({ device: d, soc: 10 }), false);
  assert.strictEqual(made.cards[BELOW].listener({ device: d, soc: 10 }), false,
    'an unmeasured reserve counted as below the threshold');
});

test('the EMMA driver answers the same cards the same way', () => {
  // Homey keeps one run listener per card and both drivers register these, so whichever
  // initialises last has to answer correctly for either device. It can, because it reads
  // everything off args.device — this is what proves that.
  const { made, d } = listeners(LunaEmma);
  d.caps[CAP] = 40;
  assert.strictEqual(made.cards[ABOVE].listener({ device: d, soc: 30 }), true);
  assert.strictEqual(made.cards[BELOW].listener({ device: d, soc: 30 }), false);

  const other = makeDevice(LunaModbus, made);
  other.caps[CAP] = 10;
  assert.strictEqual(made.cards[ABOVE].listener({ device: other, soc: 30 }), false,
    'the listener answered from the wrong device');
});

// ── how the reserve is drawn (1.2.278) ──────────────────────────────────────────

test('the backup reserve is a reading, not a second battery', () => {
  // A sub-capability of measure_battery inherits the battery component, so Homey drew the
  // reserve as a big battery in the battery view, beside the real state of charge — at 0 %
  // a red, empty battery. It is a setting (what is held back for a power cut), not a level.
  //
  // Since 1.2.283 the LUNA2000 Modbus battery hides the tile altogether: the reserve is a
  // device setting there, which follows the device, and the tile had no icon to offer (Homey
  // ignores an icon set in capabilitiesOptions). The EMMA battery has no such setting, so
  // its tile is the only place the reserve can be seen and stays.
  const SHOWN = { luna2000_modbus: null, luna2000_emma_modbus: 'sensor' };
  for (const [id, ui] of Object.entries(SHOWN)) {
    const d = manifest.drivers.find((x) => x.id === id);
    assert.ok(d.capabilities.includes('measure_battery.backup'), `${id}: the capability is gone — flows and Insights hang on it`);
    assert.strictEqual(d.capabilitiesOptions['measure_battery.backup'].uiComponent, ui, `${id}: drawn as ${ui === null ? 'a tile again' : 'a battery again'}`);
    const setting = (d.settings || []).flatMap((g) => g.children || [g]).find((s) => s.id === 'backup_power_soc');
    assert.strictEqual(Boolean(setting), ui === null, `${id}: ${ui === null ? 'hidden, but no setting shows the reserve' : 'a setting appeared — the tile could be hidden here too'}`);
  }
  // The hidden tile is only fine while the setting follows what the device reports.
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'drivers', 'luna2000_modbus', 'device.js'), 'utf8'),
    /\['storageBackupPowerSoc',\s*'backup_power_soc'\]/, 'the backup SoC setting no longer follows the device');
  // Any other battery sub-capability would have the same problem.
  for (const d of manifest.drivers) {
    for (const cap of (d.capabilities || []).filter((c) => /^measure_battery\./.test(c))) {
      const o = (d.capabilitiesOptions || {})[cap] || {};
      assert.ok(o.uiComponent === 'sensor' || o.uiComponent === null, `${d.id}/${cap} is drawn as a second battery`);
    }
  }
});
