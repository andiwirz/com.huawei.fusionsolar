'use strict';

// Which counter is today's solar production. Run: node --test
//
// Issue #28. FusionSolar showed 2.03 kWh generated; the app showed 1.43 kWh. At that moment
// 1.94 kW of 2.45 kW of PV was charging the battery — and 2.03 − 1.43 = 0.60 kWh is what
// the battery had absorbed since midnight.
//
// The inverter's day_cap measures its AC output. On a hybrid the LUNA2000 hangs on the DC
// bus in front of that, so energy charged into the battery never crosses the point day_cap
// measures. The station summary's day_power is the generation itself.
//
// The capture below is from a plant that runs Modbus and the cloud at once, which is what
// lets the two be told apart rather than guessed at:
//
//   day_cap 24.79 + charge_cap 13.12 − discharge_cap 4.53 = 33.38   against day_power 33.37
//   33.37 − 8.59 (battery, net) − 4.53 (on-grid) = 20.25            against day_use 20.30
//
// Both identities close to within 0.05 kWh on figures spanning a whole day, which no
// coincidence of two unrelated quantities does.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  return origLoad.call(this, request, parent, isMain);
};
const InverterDevice = require(path.join('..', 'drivers', 'sun2000_openapi_fusionsolar', 'device.js'));
Module._load = origLoad;

const TYPE_INVERTER = 38;

// The capture, verbatim.
const STATION = {
  dailyEnergy: 33.37, monthEnergy: 258.99, totalEnergy: 46019.45,
  dayOnGridEnergy: 4.53, dayUseEnergy: 20.3, healthState: 3,
};
const INVERTER = { active_power: 6.738, mppt_power: 6.738, day_cap: 24.79, total_cap: 47413.21 };

function fakeInverter() {
  const d = Object.create(InverterDevice.prototype);
  d.values = {};
  d.caps = new Set([
    'measure_power', 'measure_power.mppt', 'measure_power.active_power',
    'meter_power.inv_total', 'meter_power.inv_daily',
  ]);
  d._prevDeviceStatus = null;
  d.log = () => {};
  d.getName = () => 'Inverter';
  d.getSetting = () => true;
  d.hasCapability = (c) => d.caps.has(c);
  d.addCapability = async (c) => { d.caps.add(c); };
  d._set = async (c, v) => { if (v !== null && v !== undefined && d.caps.has(c)) d.values[c] = v; };
  d._setOptional = InverterDevice.prototype._setOptional.bind(d);
  d._trackPower = () => {};
  d.homey = {
    notifications: { createNotification: async () => {} },
    flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
  };
  return d;
}

const poll = async (d, { station = STATION, inverter = INVERTER, types } = {}) => {
  await d.onPollData({
    stationKpi: station,
    kpiByType: types ?? { [TYPE_INVERTER]: [inverter] },
  });
  return d;
};

test("today's PV production is the station figure, not the inverter's AC output", async () => {
  const d = await poll(fakeInverter());
  assert.strictEqual(d.values['meter_power.pv_daily'], 33.37,
    'the station summary was fetched and discarded, as it had been every poll');
  assert.strictEqual(d.values['meter_power.inv_daily'], 24.79,
    'the AC figure disappeared instead of moving aside');
});

// The whole reason the two must not be confused: the gap is the battery, and on a day of
// heavy charging it is a third of the production.
test('the gap between the two counters is exactly the net battery charge', () => {
  const netCharge = 13.12 - 4.53;
  assert.ok(Math.abs((INVERTER.day_cap + netCharge) - STATION.dailyEnergy) <= 0.02,
    `${INVERTER.day_cap} + ${netCharge} is not ${STATION.dailyEnergy} — the fixture no longer `
    + 'shows the relationship this change rests on');
});

test('a station that reports no daily figure gets no row and keeps the AC counter', async () => {
  const d = await poll(fakeInverter(), { station: { dailyEnergy: null } });
  assert.strictEqual(d.caps.has('meter_power.pv_daily'), false,
    'a permanently empty row on a plant whose summary carries no daily figure');
  assert.strictEqual(d.values['meter_power.inv_daily'], 24.79);
});

test('a missing station summary does not throw', async () => {
  const d = await poll(fakeInverter(), { station: undefined });
  assert.strictEqual(d.values['meter_power.inv_daily'], 24.79);
});

// At midnight the counter legitimately reads 0. Treating that as "not reported" would blank
// the row every night and hand the widget the AC figure until the sun came up.
test('a zero production figure is a reading and is published', async () => {
  const d = await poll(fakeInverter(), { station: { ...STATION, dailyEnergy: 0 } });
  assert.strictEqual(d.values['meter_power.pv_daily'], 0);
});

// The station figure does not come from an inverter device, so it must not be lost when a
// station reports none — the inverter block below it returns early in that case.
test('the production figure survives a station with no inverter device', async () => {
  const d = await poll(fakeInverter(), { types: {} });
  assert.strictEqual(d.values['meter_power.pv_daily'], 33.37,
    'the early return for a missing inverter took the station figure with it');
});

// ── The widgets, which are what the reporter actually sees ───────────────────

const fs = require('fs');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

// Bounded by the statement rather than a line count: the chain is what matters, and a fixed
// window has run past the end of one of these before.
function chain(src, marker) {
  const from = src.indexOf(marker);
  assert.notStrictEqual(from, -1, `no statement starting "${marker}"`);
  const to = src.indexOf(';', from);
  return src.slice(from, to);
}

// indexOf returns -1 for something that is not there, and -1 is less than every real
// index — so an ordering assertion alone passes when the entry it is ordering has been
// deleted. Both of these assert presence first, then order.
function before(chain, first, second, msg) {
  const a = chain.indexOf(first);
  const b = chain.indexOf(second);
  assert.notStrictEqual(a, -1, `${first} is not in the chain at all`);
  assert.notStrictEqual(b, -1, `${second} is not in the chain at all`);
  assert.ok(a < b, msg);
}

test('the energy-balance widget asks for the production figure before the AC one', () => {
  const c = chain(read('widgets', 'energy-balance', 'api.js'), 'const pvTodayKwh');
  before(c, "sunOa, 'meter_power.pv_daily'", "sunOa, 'meter_power.inv_daily'",
    'the AC counter is consulted first, so the production figure never gets a turn');
  // Local before cloud, everywhere. A Modbus reading is seconds old and the cloud minutes,
  // and this file's own comment says the order is load-bearing.
  before(c, "sun2000, 'meter_power.daily'", "sunOa, 'meter_power.pv_daily'",
    'the cloud is consulted ahead of a local Modbus inverter on the same house');
});

test('the daily-yield widget uses the same order', () => {
  const c = chain(read('widgets', 'daily-yield', 'api.js'), 'const dailyKwh');
  before(c, "sunOa,       'meter_power.pv_daily'", "sunOa,       'meter_power.inv_daily'",
    "the two widgets disagree about what today's yield is");
  before(c, "sun2000,     'meter_power.daily'", "sunOa,       'meter_power.pv_daily'",
    'the cloud is consulted ahead of a local Modbus inverter on the same house');
  assert.match(c, /cap\(kiosk,\s+'meter_power\.daily'/, 'the kiosk fallback was dropped');
});

// Lifetime is deliberately untouched: on the reporting plant the inverter's lifetime counter
// and the plant's differ by far more than the battery accounts for, and nothing here can say
// why. Changing it on a guess would replace a known gap with an unknown one.
test('the lifetime total is left on the inverter counter', () => {
  const c = chain(read('widgets', 'daily-yield', 'api.js'), 'const totalKwh');
  assert.match(c, /cap\(sunOa,\s+'meter_power\.inv_total'/);
  assert.doesNotMatch(c, /pv_total|totalEnergy/,
    'the lifetime figure was switched to a counter whose disagreement is unexplained');
});

test('the manifest titles the new capability the way the EMMA inverter titles it', () => {
  const app = require(path.join('..', 'app.json'));
  const oa   = app.drivers.find((d) => d.id === 'sun2000_openapi_fusionsolar');
  const emma = app.drivers.find((d) => d.id === 'sun2000_emma_modbus');
  assert.deepStrictEqual(oa.capabilitiesOptions['meter_power.pv_daily'].title,
    emma.capabilitiesOptions['meter_power.pv_daily'].title,
    'the same quantity is called two different things on two devices');
});

// The two unit rows drew as an empty dashed square next to the module count they belong to.
test('the battery unit rows carry the module-count icon', () => {
  const app = require(path.join('..', 'app.json'));
  const icon = app.capabilities['measure_battery_modules'].icon;
  assert.ok(icon, 'the module count itself lost its icon');
  for (const cap of ['luna2000_unit1_installed', 'luna2000_unit2_installed']) {
    assert.strictEqual(app.capabilities[cap].icon, icon,
      `${cap} renders as a dashed placeholder again`);
  }
  assert.ok(fs.existsSync(path.join(__dirname, '..', icon.replace(/^\//, ''))),
    `three capabilities point at ${icon} and the file is not there`);
});
