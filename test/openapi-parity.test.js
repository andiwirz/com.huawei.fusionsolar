'use strict';

// Where the FusionSolar cloud drivers differ from their Modbus twins. Run: node --test
//
// Both families describe the same hardware, so a difference between them is either a fact
// about the transport or an oversight. These cover the two that were oversights, plus the
// invariant that catches the next one of its kind.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  return origLoad.call(this, request, parent, isMain);
};
const BatteryDevice  = require(path.join('..', 'drivers', 'luna2000_openapi_fusionsolar', 'device.js'));
const InverterDevice = require(path.join('..', 'drivers', 'sun2000_openapi_fusionsolar', 'device.js'));
Module._load = origLoad;

const TYPE_BATTERY  = 39;
const TYPE_INVERTER = 38;

function fakeBattery({ timeline = true, caps = [] } = {}) {
  const d = Object.create(BatteryDevice.prototype);
  d.values = {};
  d.notes  = [];
  d.caps   = new Set(['measure_power', 'measure_battery', ...caps]);
  d._prevSoc = null;
  d._prevChargingState = null;
  d._prevBatteryMode = null;
  d._prevBatteryStatus = null;
  d.log = () => {};
  d.getName = () => 'Battery';
  d.getSetting = (k) => (k === 'enable_timeline_notifications' ? timeline : null);
  d.hasCapability = (c) => d.caps.has(c);
  d.addCapability = async (c) => { d.caps.add(c); };
  d.removeCapability = async (c) => { d.caps.delete(c); delete d.values[c]; };
  d.getCapabilityValue = (c) => (c in d.values ? d.values[c] : null);
  d._set = async (c, v) => { if (v !== null && v !== undefined && d.caps.has(c)) d.values[c] = v; };
  d.homey = {
    notifications: { createNotification: async ({ excerpt }) => { d.notes.push(excerpt); } },
    flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
  };
  return d;
}

const BATT = { ch_discharge_power: 0, battery_soc: 100, battery_status: 2 };

const pollBatt = async (d, kpi) => {
  await d.onPollData({ kpiByType: { [TYPE_BATTERY]: [{ ...BATT, ...kpi }] } });
  return d;
};

// ── State of health ──────────────────────────────────────────────────────────
//
// Huawei sends battery_soh as 0 on plants that publish no state of health. A healthy
// LUNA2000 at 100 % charge and status Running showed "Gesundheitszustand 0 %", which reads
// as a battery at the end of its life rather than as a figure nobody sent.

test('a battery whose plant reports no state of health shows no health row', async () => {
  const d = await pollBatt(fakeBattery(), { battery_soh: 0 });
  assert.strictEqual(d.caps.has('measure_battery.soh'), false,
    '0 % is published as a measurement — that is a scrap battery, not a missing field');
});

test('an absent state of health is treated the same as a zero one', async () => {
  const d = await pollBatt(fakeBattery(), {});
  assert.strictEqual(d.caps.has('measure_battery.soh'), false);
});

// The case that actually matters on release day. Every battery paired before 1.2.212 was
// given this capability unconditionally, so a plant that never reported a health figure is
// sitting on a row showing 0 % right now. Not adding it to new devices leaves those alone;
// the row has to be taken away from the ones that already have it.
test('a device already showing 0 % loses the row on the next poll', async () => {
  const d = fakeBattery({ caps: ['measure_battery.soh'] });
  d.values['measure_battery.soh'] = 0;
  await pollBatt(d, { battery_soh: 0 });
  assert.strictEqual(d.caps.has('measure_battery.soh'), false,
    'an existing device keeps displaying 0 % health for ever — the fix only helps new pairings');
});

test('a device already showing 0 % gets a real reading rather than losing the row', async () => {
  const d = fakeBattery({ caps: ['measure_battery.soh'] });
  d.values['measure_battery.soh'] = 0;
  await pollBatt(d, { battery_soh: 96 });
  assert.strictEqual(d.caps.has('measure_battery.soh'), true);
  assert.strictEqual(d.values['measure_battery.soh'], 96);
});

test('a plant that does report health gets the row and the value', async () => {
  const d = await pollBatt(fakeBattery(), { battery_soh: 97.5 });
  assert.strictEqual(d.caps.has('measure_battery.soh'), true,
    'a real reading is being thrown away with the fake ones');
  assert.strictEqual(d.values['measure_battery.soh'], 97.5);
});

// _set leaves the last good reading standing when a field goes quiet for one poll; the
// health row follows that rule rather than deleting itself on a single blank.
test('a reading that goes quiet does not delete a health row that once worked', async () => {
  const d = fakeBattery();
  await pollBatt(d, { battery_soh: 97.5 });
  await pollBatt(d, { battery_soh: 0 });
  assert.strictEqual(d.caps.has('measure_battery.soh'), true,
    'one blank poll removed a capability that had been reporting properly');
  assert.strictEqual(d.values['measure_battery.soh'], 97.5, 'the last good reading was lost');
});

test('the health row is not in the unconditional add list any more', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'drivers', 'luna2000_openapi_fusionsolar', 'device.js'), 'utf8');
  const extras = src.slice(src.indexOf('const EXTRA_CAPABILITIES'),
                           src.indexOf('const DEPRECATED_CAPABILITIES'));
  assert.doesNotMatch(extras, /measure_battery\.soh/,
    'the add-loop puts the row back on every poll, so the guard below it never wins');
});

// ── Timeline notifications ───────────────────────────────────────────────────
//
// Each Modbus driver announces its own status change on the timeline, gated by a per-device
// switch. The cloud drivers had neither the announcement nor the switch.

test('a battery status change is announced once', async () => {
  const d = fakeBattery({ caps: ['openapi_battery_status'] });
  await pollBatt(d, { battery_status: 2 });                       // Running — first reading
  assert.deepStrictEqual(d.notes, [],
    'the first reading after a restart was announced as though it were a change');
  await pollBatt(d, { battery_status: 3 });                       // Faulty
  assert.deepStrictEqual(d.notes, ['Battery: Faulty']);
  await pollBatt(d, { battery_status: 3 });
  assert.strictEqual(d.notes.length, 1, 'an unchanged status is announced again every poll');
});

test('the battery switch turns the announcement off', async () => {
  const d = fakeBattery({ timeline: false, caps: ['openapi_battery_status'] });
  await pollBatt(d, { battery_status: 2 });
  await pollBatt(d, { battery_status: 3 });
  assert.deepStrictEqual(d.notes, [], 'the setting is declared but nothing reads it');
});

function fakeInverter({ timeline = true } = {}) {
  const d = Object.create(InverterDevice.prototype);
  d.values = {};
  d.notes  = [];
  d.caps = new Set(['measure_power', 'measure_power.active_power', 'huawei_status']);
  d._prevDeviceStatus = null;
  d.log = () => {};
  d.getName = () => 'Inverter';
  d.getSetting = (k) => (k === 'enable_timeline_notifications' ? timeline : null);
  d.hasCapability = (c) => d.caps.has(c);
  d.addCapability = async (c) => { d.caps.add(c); };
  d._set = async (c, v) => { if (v !== null && v !== undefined && d.caps.has(c)) d.values[c] = v; };
  d._trackPower = () => {};
  d.homey = {
    notifications: { createNotification: async ({ excerpt }) => { d.notes.push(excerpt); } },
    flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
  };
  return d;
}

const pollInv = async (d, state) => {
  await d.onPollData({
    stationKpi: {},
    kpiByType: { [TYPE_INVERTER]: [{ active_power: 1, mppt_power: 1, inverter_state: state }] },
  });
  return d;
};

test('an inverter status change is announced once', async () => {
  const d = fakeInverter();
  await pollInv(d, 512);                                          // Grid-connected
  assert.deepStrictEqual(d.notes, [], 'the first reading was announced as a change');
  await pollInv(d, 768);
  assert.strictEqual(d.notes.length, 1, 'the status change was not announced');
  assert.match(d.notes[0], /^Inverter: /);
  await pollInv(d, 768);
  assert.strictEqual(d.notes.length, 1, 'an unchanged status repeats every poll');
});

test('the inverter switch turns the announcement off', async () => {
  const d = fakeInverter({ timeline: false });
  await pollInv(d, 512);
  await pollInv(d, 768);
  assert.deepStrictEqual(d.notes, []);
});

// ── The invariant that catches the next dead switch ──────────────────────────
//
// A driver that declares the setting without reading it offers the user a switch that does
// nothing; a driver that reads it without declaring it can never be turned off, because
// getSetting returns undefined and the code treats that as "on". Both fail silently, which
// is why this is checked mechanically rather than by eye. The OpenAPI power meter has
// neither: its status capability was deliberately removed, so it has nothing to announce.
test('every timeline switch is read, and every read switch is declared', () => {
  const app = require(path.join('..', 'app.json'));
  const KEY = 'enable_timeline_notifications';
  const settingIds = (list) => (list || []).flatMap((s) => (s.children ? s.children.map((c) => c.id) : [s.id]));

  // device.js plus the local modules it requires: energy_management reads the setting from
  // lib/ems/history.js, which is mixed into its prototype.
  const sourcesFor = (id) => {
    const entry = path.join(ROOT, 'drivers', id, 'device.js');
    if (!fs.existsSync(entry)) return '';
    let src = fs.readFileSync(entry, 'utf8');
    for (const m of src.matchAll(/require\('(\.\.[^']+)'\)/g)) {
      const p = path.join(ROOT, 'drivers', id, m[1]);
      for (const f of [p, `${p}.js`]) {
        if (fs.existsSync(f) && fs.statSync(f).isFile()) { src += fs.readFileSync(f, 'utf8'); break; }
      }
    }
    return src;
  };

  const problems = [];
  for (const d of app.drivers) {
    const declared = settingIds(d.settings).includes(KEY);
    const used     = sourcesFor(d.id).includes(KEY);
    if (declared && !used) problems.push(`${d.id}: switch offered but never read`);
    if (used && !declared) problems.push(`${d.id}: switch read but never offered, so it cannot be turned off`);
  }
  assert.deepStrictEqual(problems, []);
});

test('the two cloud drivers that now announce a status also offer the switch', () => {
  const app = require(path.join('..', 'app.json'));
  for (const id of ['sun2000_openapi_fusionsolar', 'luna2000_openapi_fusionsolar']) {
    const drv = app.drivers.find((x) => x.id === id);
    assert.ok((drv.settings || []).some((s) => s.id === 'enable_timeline_notifications'),
      `${id} announces status changes with no way to stop them`);
  }
});
