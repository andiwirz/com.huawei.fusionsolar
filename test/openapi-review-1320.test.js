'use strict';

// Two cloud findings from the review of 2026-10-10 (1.2.320).
//
//   1. Saving any setting of a cloud device threw the plant's device list away. That also
//      removed the guard "an empty answer never replaces a list that had devices in it", and
//      getDevList handed a refusal back as an empty list without its code. One refused answer
//      right after a save emptied the plant: no readings for a quarter of an hour, and after a
//      second refusal every device offline as "FusionSolar lists no device of type …".
//   2. The lifetime totals Homey Energy reads from the cloud battery and the cloud meter are
//      sums over every unit of the plant. A poll that left one unit out lowered the sum, the
//      next restored it, and Homey booked the restored amount — one unit's whole lifetime —
//      as new energy.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

// ── stubs: https for the client, homey for the drivers ─────────────────────────

let queue = [];
function fakeRequest(options, onResponse) {
  const req = new EventEmitter();
  req.write = () => {};
  req.end = () => {
    const body = queue.shift() ?? { success: false, failCode: 999, message: 'test ran out of responses' };
    const res = new EventEmitter();
    res.headers = {};
    setImmediate(() => { res.emit('data', JSON.stringify(body)); res.emit('end'); });
    onResponse(res);
  };
  req.destroy = () => {};
  return req;
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'https') return { request: fakeRequest };
  if (request === 'homey') return { Device: class {} };
  return origLoad.call(this, request, parent, isMain);
};
const { getDevList }     = require(path.join('..', 'lib', 'openapi-client.js'));
const { StationSession } = require(path.join('..', 'lib', 'openapi-coordinator.js'));
const BatteryDevice      = require(path.join('..', 'drivers', 'luna2000_openapi_fusionsolar', 'device.js'));
const MeterDevice        = require(path.join('..', 'drivers', 'powermeter_openapi_fusionsolar', 'device.js'));
const RackDevice         = require(path.join('..', 'drivers', 'isitepower_battery_openapi_fusionsolar', 'device.js'));
Module._load = origLoad;

// ── 1. the device list ─────────────────────────────────────────────────────────

test('getDevList hands a refusal back with its code, not as a plant without devices', async () => {
  queue = [{ success: false, failCode: 407, message: 'ACCESS_FREQUENCY_IS_TOO_HIGH' }];
  const refused = await getDevList('https://eu5.fusionsolar.huawei.com', 'tok', 'ST1');
  assert.deepStrictEqual(refused.devices, []);
  assert.strictEqual(refused.failCode, 407);
  assert.ok(refused.failMessage, 'a refusal says why');

  queue = [{ success: true, data: [] }];
  const empty = await getDevList('https://eu5.fusionsolar.huawei.com', 'tok', 'ST1');
  assert.deepStrictEqual(empty.devices, []);
  assert.ok(!empty.failMessage, 'an answer that succeeded carries no failure');
});

const BATTERY = 39;
const EMMA    = 23070;

function fakeDevice(name, types) {
  const d = {
    available: true, polls: [], reasons: [],
    getName: () => name,
    getSetting: (k) => ({ username: 'u', system_code: 'c' }[k] ?? null),
    getDevTypes: () => types,
    onPollData: async (p) => { d.polls.push(p); },
    getAvailable: () => d.available,
    setAvailable: async () => { d.available = true; },
    setUnavailable: async (r) => { d.available = false; d.reasons.push(r); },
  };
  return d;
}

// The real _ensureDevIds and _loadDevList; the answers come in the order the poll asks for
// them — the station, the device list when it is due, then one per listed type.
function fakePlant() {
  const logs = [];
  const homey = {
    log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push('ERROR ' + a.join(' ')),
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  };
  const s = new StationSession(homey, 'ST1');
  const battery = fakeDevice('LUNA2000', [BATTERY]);
  const meter   = fakeDevice('Power Sensor', [EMMA]);
  s.addDevice(battery);
  s.addDevice(meter);
  s._interRequestDelayMs = 0;
  s._queue = [];
  s.asked = [];
  s._withAutoRelogin = async (creds, fn) => {
    s.asked.push(fn.toString().includes('getDevList') ? 'list' : 'other');
    if (!s._queue.length) throw new Error('the test ran out of canned answers');
    return s._queue.shift();
  };
  s.poll = async (answers) => {
    s._queue = [{ expired: false, kpi: { day_power: 1 } }, ...answers];
    s.asked = [];
    s._lastPollAt = 0;
    await s._poll();
    assert.strictEqual(s._queue.length, 0, `answers left over: ${JSON.stringify(s._queue)}`);
  };
  return { s, battery, meter, logs };
}

const LIST_BOTH = { expired: false, devices: [{ id: 'b1', devTypeId: BATTERY }, { id: 'e1', devTypeId: EMMA }] };
const LIST_EMMA = { expired: false, devices: [{ id: 'e1', devTypeId: EMMA }] };
const LIST_NONE = { expired: false, devices: [] };
const REFUSED   = { expired: false, devices: [], failCode: 407, failMessage: 'Rate limit (407)' };
const BAT_DATA  = { devices: [{ dataItemMap: { battery_soc: 47 } }] };
const EMMA_DAT  = { devices: [{ dataItemMap: { active_power: 0.074 } }] };

test('saving a setting keeps the device list — a refused answer right after it changes nothing', async () => {
  const { s, battery, meter, logs } = fakePlant();
  await s.poll([LIST_BOTH, BAT_DATA, EMMA_DAT]);
  s.invalidateDeviceList();                              // what settingsChanged does
  assert.ok(s._devIdsByType, 'the list is still there');
  await s.poll([REFUSED, BAT_DATA, EMMA_DAT]);           // asked again, refused; readings go on
  assert.deepStrictEqual(Object.keys(s._devIdsByType).map(Number).sort((a, b) => a - b), [BATTERY, EMMA]);
  assert.strictEqual(battery.polls.at(-1).kpiByType[BATTERY].length, 1, 'the battery was still read');
  assert.ok(battery.available && meter.available);
  assert.ok(logs.some((l) => /Device list for ST1 refused — failCode 407.*keeping the one from before/.test(l)));
});

test('after a save the list is asked for again at once, and an empty answer still does not replace it', async () => {
  const { s, battery, logs } = fakePlant();
  await s.poll([LIST_BOTH, BAT_DATA, EMMA_DAT]);
  s.invalidateDeviceList();
  await s.poll([LIST_NONE, BAT_DATA, EMMA_DAT]);
  assert.ok(logs.some((l) => /came back empty — keeping the one from before/.test(l)));
  assert.ok(battery.available);
});

test('after a save a list that did change replaces the old one', async () => {
  const { s, battery } = fakePlant();
  await s.poll([LIST_BOTH, BAT_DATA, EMMA_DAT]);
  s.invalidateDeviceList();
  await s.poll([LIST_EMMA, EMMA_DAT]);
  assert.deepStrictEqual(Object.keys(s._devIdsByType).map(Number), [EMMA]);
  assert.ok(battery.available, 'one list is not yet a confirmed absence');
});

test('a refused list at a start is asked for again at the next poll, and no device is called absent on it', async () => {
  const { s, battery, meter, logs } = fakePlant();
  await s.poll([REFUSED]);
  assert.strictEqual(s._devIdsByType, null, 'nothing to keep, nothing invented');
  assert.ok(logs.some((l) => /refused — failCode 407.*asking again at the next poll/.test(l)));
  await s.poll([REFUSED]);
  assert.ok(battery.available && meter.available);
  assert.ok(!battery.reasons.some((r) => /lists no device/.test(r)));
  await s.poll([LIST_BOTH, BAT_DATA, EMMA_DAT]);
  assert.strictEqual(battery.polls.at(-1).kpiByType[BATTERY].length, 1);
});

test('the first list after refusals does not confirm an absence on its own', async () => {
  const { s, battery } = fakePlant();
  await s.poll([REFUSED]);
  await s.poll([LIST_EMMA, EMMA_DAT]);                   // the battery is missing from it
  assert.ok(battery.available, 'one list, and the battery is already "not in the plant"');
  s._devIdsAt -= 16 * 60_000;                            // past DEV_LIST_RETRY_MS
  await s.poll([LIST_EMMA, EMMA_DAT]);                   // a second list says the same
  assert.strictEqual(battery.available, false);
  assert.match(battery.reasons.at(-1), /lists no device of type 39/);
});

test('a refusal is never counted as the second list that confirms an absence', async () => {
  const { s, battery } = fakePlant();
  await s.poll([LIST_EMMA, EMMA_DAT]);
  s._devIdsAt -= 16 * 60_000;
  await s.poll([REFUSED, EMMA_DAT]);
  assert.ok(battery.available);
  assert.ok(!battery.reasons.some((r) => /lists no device/.test(r)));
});

test('a refusal is logged once, not every poll — and again once a list has come through between', async () => {
  const { s, logs } = fakePlant();
  await s.poll([REFUSED]);
  await s.poll([REFUSED]);
  await s.poll([REFUSED]);
  assert.strictEqual(logs.filter((l) => /Device list for ST1 refused/.test(l)).length, 1);
  await s.poll([LIST_BOTH, BAT_DATA, EMMA_DAT]);
  s.invalidateDeviceList();
  await s.poll([REFUSED, BAT_DATA, EMMA_DAT]);
  assert.strictEqual(logs.filter((l) => /Device list for ST1 refused/.test(l)).length, 2);
});

test('with a list in hand, a refusal is not asked again at every poll', async () => {
  const { s } = fakePlant();
  await s.poll([LIST_BOTH, BAT_DATA, EMMA_DAT]);
  s.invalidateDeviceList();
  await s.poll([REFUSED, BAT_DATA, EMMA_DAT]);
  assert.deepStrictEqual(s.asked, ['other', 'list', 'other', 'other']);
  await s.poll([BAT_DATA, EMMA_DAT]);                    // the list is not due again yet
  assert.ok(!s.asked.includes('list'), 'the refused list was asked for again straight away');
});

// ── 2. lifetime totals summed over several units ───────────────────────────────

function withStore(d) {
  d.store = {};
  d.getStoreValue = (k) => d.store[k];
  d.setStoreValue = async (k, v) => { d.store[k] = v; };
  d.values = {};
  d.writes = [];
  d.log = () => {};
  d.error = () => {};
  d.getName = () => 'Device';
  d.getSetting = () => false;
  d.hasCapability = () => true;
  d.addCapability = async () => {};
  d.removeCapability = async () => {};
  d.getCapabilityValue = (c) => (c in d.values ? d.values[c] : null);
  d._set = async (c, v) => {
    if (v === null || v === undefined || d.values[c] === v) return;
    d.values[c] = v; d.writes.push([c, v]);
  };
  d._setOptional = d._set;
  d.getAvailable = () => true;
  d.setAvailable = async () => {};
  d.homey = {
    __: (k) => k,
    flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
    notifications: { createNotification: async () => {} },
  };
  return d;
}

const written = (d, cap) => d.writes.filter(([c]) => c === cap).map(([, v]) => v);

test('two cloud batteries: one left out of a poll does not lower the lifetime totals', async () => {
  const d = withStore(Object.create(BatteryDevice.prototype));
  const unit = (charged, discharged) => ({ battery_soc: 50, total_charged_energy: charged, total_discharged_energy: discharged });
  await d.onPollData({ kpiByType: { 39: [unit(1000, 900), unit(2000, 1800)] } });
  await d.onPollData({ kpiByType: { 39: [unit(1000.5, 900.5)] } });                       // one battery missing
  await d.onPollData({ kpiByType: { 39: [unit(1001, 901), { battery_soc: 50 }] } });      // one battery without the fields
  await d.onPollData({ kpiByType: { 39: [unit(1001, 901), unit(2001, 1801)] } });
  assert.deepStrictEqual(written(d, 'meter_power.charged'), [3000, 3002], 'never 1000.5 or 1001');
  assert.deepStrictEqual(written(d, 'meter_power.discharged'), [2700, 2702]);
});

test('two power sensors: one left out of a poll does not lower import or export', async () => {
  const d = withStore(Object.create(MeterDevice.prototype));
  d._fireExportImportTriggers = () => {};
  const sensor = (imp, exp) => ({ active_power: 100, reverse_active_cap: imp, active_cap: exp });
  await d.onPollData({ kpiByType: { 47: [sensor(5000, 3000), sensor(7000, 4000)] } });
  await d.onPollData({ kpiByType: { 47: [sensor(5001, 3001)] } });
  await d.onPollData({ kpiByType: { 47: [sensor(5002, 3002), sensor(7002, 4002)] } });
  assert.deepStrictEqual(written(d, 'meter_power'), [12000, 12004]);
  assert.deepStrictEqual(written(d, 'meter_power.exported'), [7000, 7004]);
});

test('two EMMAs: the same for the EMMA branch of the meter', async () => {
  const d = withStore(Object.create(MeterDevice.prototype));
  d._fireExportImportTriggers = () => {};
  const emma = (imp, exp) => ({ active_power: 0.1, active_cap: imp, reverse_active_cap: exp });
  await d.onPollData({ kpiByType: { 23070: [emma(100, 50), emma(200, 80)] } });
  await d.onPollData({ kpiByType: { 23070: [emma(101, 51)] } });
  await d.onPollData({ kpiByType: { 23070: [emma(101, 51), emma(201, 81)] } });
  assert.deepStrictEqual(written(d, 'meter_power'), [300, 302]);
  assert.deepStrictEqual(written(d, 'meter_power.exported'), [130, 132]);
});

test('iSitePower: a rack left out of a poll does not lower the discharged total', async () => {
  const d = withStore(Object.create(RackDevice.prototype));
  d._lastEnergyTs = Date.now();
  d._chargedKwh = 0;
  const rack = (dis) => ({ soc: 60, total_discharge: dis });
  await d.onPollData({ kpiByType: { 60014: [rack(400), rack(600)] }, freshKpiByType: {} });
  await d.onPollData({ kpiByType: { 60014: [rack(401)] }, freshKpiByType: {} });
  await d.onPollData({ kpiByType: { 60014: [rack(401), rack(601)] }, freshKpiByType: {} });
  assert.deepStrictEqual(written(d, 'meter_power.discharged'), [1000, 1002]);
});

test('the mark survives a restart, so the first poll after one cannot take the dip either', async () => {
  const before = withStore(Object.create(BatteryDevice.prototype));
  const unit = (c) => ({ battery_soc: 50, total_charged_energy: c, total_discharged_energy: c });
  await before.onPollData({ kpiByType: { 39: [unit(1000), unit(2000)] } });
  const after = withStore(Object.create(BatteryDevice.prototype));
  after.store = before.store;                            // the device store outlives the process
  await after.onPollData({ kpiByType: { 39: [unit(1001)] } });
  assert.deepStrictEqual(written(after, 'meter_power.charged'), []);
});
