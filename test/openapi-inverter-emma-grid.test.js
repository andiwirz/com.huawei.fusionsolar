'use strict';

// The OpenAPI inverter's grid figures on an EMMA plant. Run: node --test
//
// Issue #28. A Developer Tools capture showed the meter device full of readings while the
// same plant's inverter had three empty rows:
//
//   Power Sensor (OpenAPI)   +11 W, import 5346.24 kWh, export 914.73 kWh, phases A/B/C
//   Inverter SUN2000         measure_power.grid_active_power  null
//                            meter_power (grid import)        null
//                            meter_power.exported             null
//
// Two things identify that plant's grid device as an EMMA-A02 rather than a power sensor:
// its meter has no frequency row, which is the one capability the EMMA branch deliberately
// refuses to add, and its lifetime counters continue the ones captured for issue #25
// (5298.26 / 912.84 kWh, a few days earlier).
//
// getDevTypes() listed types 1, 38, 17 and 47 — not 23070 — so the coordinator never
// fetched the EMMA for this device, and nothing filled in behind it either: an EMMA plant
// carries no type 17 or 47 to fall back on. The rows were not stale or wrong. They had
// never been written once.

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
const MeterDevice    = require(path.join('..', 'drivers', 'powermeter_openapi_fusionsolar', 'device.js'));
Module._load = origLoad;

const TYPE_INVERTER     = 38;
const TYPE_METER        = 17;
const TYPE_POWER_SENSOR = 47;
const TYPE_EMMA         = 23070;

// The reporter's capture. active_power is kW here, and active_cap is the IMPORT total —
// both the other way round from the power sensor.
const EMMA_KPI = {
  active_power: 0.011,
  active_cap: 5346.24,
  reverse_active_cap: 914.73,
  active_power_a: -0.067, active_power_b: 0.219, active_power_c: -0.139,
  a_u: 231.2, b_u: 230.9, c_u: 234.3,
  a_i: 0.6,   b_i: 2.0,   c_i: 2.1,
};

const INVERTER_KPI = { active_power: 0.503, mppt_power: 1.843, day_cap: 1.25, total_cap: 35123.36 };

function fakeInverter() {
  const d = Object.create(InverterDevice.prototype);
  d.values = {};
  d.caps = new Set([
    'measure_power', 'measure_power.mppt', 'measure_power.active_power',
    'meter_power.inv_total', 'meter_power.inv_daily',
    'measure_power.grid_active_power', 'meter_power.grid_import', 'meter_power.grid_export',
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

const poll = async (kpiByType) => {
  const d = fakeInverter();
  await d.onPollData({ stationKpi: null, kpiByType });
  return d;
};

const EMMA_PLANT = { [TYPE_INVERTER]: [INVERTER_KPI], [TYPE_EMMA]: [EMMA_KPI] };

test('the coordinator is asked for the EMMA type at all', () => {
  const d = Object.create(InverterDevice.prototype);
  assert.ok(d.getDevTypes().includes(TYPE_EMMA),
    'the coordinator only fetches the types this returns, which is exactly why the three '
    + 'grid rows were never written on an EMMA plant');
});

test('the three grid rows are filled on an EMMA plant', async () => {
  const d = await poll(EMMA_PLANT);
  assert.strictEqual(d.values['measure_power.grid_active_power'], 11);
  assert.strictEqual(d.values['meter_power.grid_import'], 5346.24);
  assert.strictEqual(d.values['meter_power.grid_export'], 914.73);
});

// Read as watts, 0.011 kW would be 0 W and the row would sit at zero for ever.
test("EMMA's kilowatts are not read as watts", async () => {
  const d = await poll({ [TYPE_INVERTER]: [INVERTER_KPI], [TYPE_EMMA]: [{ ...EMMA_KPI, active_power: -1.319 }] });
  assert.strictEqual(d.values['measure_power.grid_active_power'], -1319);
});

// The sign correction applies to the power sensor and the grid meter, not to EMMA. Applying
// it here would invert a reading that was already right.
test('EMMA is not negated, the power sensor still is', async () => {
  const emma = await poll({ [TYPE_INVERTER]: [INVERTER_KPI], [TYPE_EMMA]: [{ ...EMMA_KPI, active_power: -1.319 }] });
  assert.strictEqual(emma.values['measure_power.grid_active_power'], -1319, 'EMMA was negated');

  const ps = await poll({
    [TYPE_INVERTER]: [INVERTER_KPI],
    [TYPE_POWER_SENSOR]: [{ active_power: 2591, reverse_active_cap: 23167.8, active_cap: 17065.25 }],
  });
  assert.strictEqual(ps.values['measure_power.grid_active_power'], -2591,
    'the power sensor lost its negation when the EMMA branch was added');
  assert.strictEqual(ps.values['meter_power.grid_import'], 23167.8);
  assert.strictEqual(ps.values['meter_power.grid_export'], 17065.25);
});

// active_cap means the opposite thing on the two device types. Getting it wrong swaps two
// lifetime totals, which nobody notices for months.
test('active_cap is the import total on EMMA and the export total on a power sensor', async () => {
  const emma = await poll(EMMA_PLANT);
  assert.strictEqual(emma.values['meter_power.grid_import'], EMMA_KPI.active_cap);
  assert.ok(emma.values['meter_power.grid_import'] > emma.values['meter_power.grid_export'],
    'this house has imported far more than it exported — swapped totals would invert that');

  const ps = await poll({
    [TYPE_INVERTER]: [INVERTER_KPI],
    [TYPE_POWER_SENSOR]: [{ active_power: 0, active_cap: 10, reverse_active_cap: 20 }],
  });
  assert.strictEqual(ps.values['meter_power.grid_import'], 20, 'still reverse_active_cap');
  assert.strictEqual(ps.values['meter_power.grid_export'], 10, 'still active_cap');
});

test('EMMA wins where both are somehow present — it is the connection point', async () => {
  const d = await poll({
    [TYPE_INVERTER]: [INVERTER_KPI],
    [TYPE_EMMA]: [EMMA_KPI],
    [TYPE_POWER_SENSOR]: [{ active_power: 9999, active_cap: 1, reverse_active_cap: 2 }],
  });
  assert.strictEqual(d.values['measure_power.grid_active_power'], 11);
});

test('a grid meter (type 17) still works when no EMMA and no power sensor are present', async () => {
  const d = await poll({
    [TYPE_INVERTER]: [INVERTER_KPI],
    [TYPE_METER]: [{ active_power: 800, reverse_active_cap: 5, active_cap: 3 }],
  });
  assert.strictEqual(d.values['measure_power.grid_active_power'], -800);
});

test('a plant with no grid device at all writes nothing rather than zeroes', async () => {
  const d = await poll({ [TYPE_INVERTER]: [INVERTER_KPI] });
  for (const cap of ['measure_power.grid_active_power', 'meter_power.grid_import', 'meter_power.grid_export']) {
    assert.ok(!(cap in d.values), `${cap} was invented for a plant that measures no grid`);
  }
  assert.strictEqual(d.values['measure_power'], 1843, 'the inverter itself still reports');
});

// The dangerous shape is not an absent device but a present one with a field missing: there
// the sum runs, and a sum over nothing is nought only if you decide it is. A lifetime import
// total of 0.0 kWh is a measurement, and a wrong one — the counter it replaced was 5346 kWh.
test('a grid device that omits a field leaves that row alone rather than zeroing it', async () => {
  const emma = await poll({
    [TYPE_INVERTER]: [INVERTER_KPI],
    [TYPE_EMMA]: [{ active_power: 0.011 }],   // power only, no lifetime counters
  });
  assert.strictEqual(emma.values['measure_power.grid_active_power'], 11);
  assert.ok(!('meter_power.grid_import' in emma.values),
    'a missing lifetime counter was published as 0.0 kWh');
  assert.ok(!('meter_power.grid_export' in emma.values));

  const ps = await poll({
    [TYPE_INVERTER]: [INVERTER_KPI],
    [TYPE_POWER_SENSOR]: [{ reverse_active_cap: 23167.8 }],  // counters only, no power
  });
  assert.strictEqual(ps.values['meter_power.grid_import'], 23167.8);
  assert.ok(!('measure_power.grid_active_power' in ps.values),
    'a missing power reading was published as 0 W, which reads as a balanced grid');
});

// The inverter mirrors the meter. Two drivers reading one device through two copies of the
// same three-way split is how the split drifts, so this holds them to the same answer.
test('the inverter and the meter driver agree on the same EMMA reading', async () => {
  const inv = await poll(EMMA_PLANT);

  const m = Object.create(MeterDevice.prototype);
  m.values = {};
  m.caps = new Set(['measure_power', 'meter_power', 'meter_power.exported']);
  m._prevExporting = null;
  m._prevMeterStatus = null;
  m.log = () => {};
  m.getName = () => 'Meter';
  m.getSetting = () => true;
  m.hasCapability = (c) => m.caps.has(c);
  m.addCapability = async (c) => { m.caps.add(c); };
  m._set = async (c, v) => { if (v !== null && v !== undefined) m.values[c] = v; };
  m._fireExportImportTriggers = () => {};
  m.homey = {
    notifications: { createNotification: async () => {} },
    flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
  };
  await m.onPollData({ stationKpi: null, kpiByType: { [TYPE_EMMA]: [EMMA_KPI] } });

  assert.strictEqual(inv.values['measure_power.grid_active_power'], m.values['measure_power'],
    'the two devices report different grid power for the same EMMA');
  assert.strictEqual(inv.values['meter_power.grid_import'], m.values['meter_power'],
    'the two devices disagree about which counter is the import total');
  assert.strictEqual(inv.values['meter_power.grid_export'], m.values['meter_power.exported']);
});

// The reporter's own capture, as an arithmetic check on what the numbers mean: the DC input
// is the AC output plus what went into the battery. It is the power-level form of the daily
// energy gap in #28, on his hardware rather than on a reference plant.
test("the capture's own power balance holds: DC in = AC out + battery charge", async () => {
  const d = await poll(EMMA_PLANT);
  const dc = d.values['measure_power.mppt'];
  const ac = d.values['measure_power.active_power'];
  const battery = 1342;
  assert.strictEqual(dc, 1843);
  assert.strictEqual(ac, 503);
  assert.ok(Math.abs(dc - (ac + battery)) <= 5,
    `${dc} W of DC against ${ac} + ${battery} W — the fixture no longer shows the balance`);
});
