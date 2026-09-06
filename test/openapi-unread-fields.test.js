'use strict';

// Fields the FusionSolar cloud sends that nothing used to read. Run: node --test
//
// From a full API capture of station NE=141986968 on 2026-09-06, taken on a house that runs
// the Modbus drivers alongside the cloud ones. Three readings were arriving in every single
// response and being dropped on the floor, each with a Modbus counterpart that had shown
// the same thing for as long as that driver has existed.
//
// The fixtures below are that capture verbatim. If Huawei ever changes a field name, these
// fail with the owner's own data rather than quietly going blank again.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  return origLoad.call(this, request, parent, isMain);
};
const MeterDevice   = require(path.join('..', 'drivers', 'powermeter_openapi_fusionsolar', 'device.js'));
const BatteryDevice = require(path.join('..', 'drivers', 'luna2000_openapi_fusionsolar', 'device.js'));
Module._load = origLoad;

const TYPE_POWER_SENSOR = 47;
const TYPE_METER        = 17;
const TYPE_BATTERY      = 39;

// ── The battery: health that battery_soh does not carry ──────────────────────
//
// The captured dataItemMap, cut to the fields at issue. battery_soh reads 0 on this plant
// while the three modules underneath each report 95.0 %. The flat field is the one the
// driver used to read, which is why 1.2.212 stopped showing it — the figure was never
// missing, only in another place.
const BATT_KPI = {
  ch_discharge_power: 0,
  battery_soc: 100,
  battery_status: 2,
  battery_soh: 0,
  rated_capacity: 15,
  battery_unit_info: {
    unit1: [
      { sn: 'LS21C7410010', soh: '95.0%' },
      { sn: 'UB2210010034', soh: '95.0%' },
      { sn: 'UB2210010566', soh: '95.0%' },
    ],
    unit2: [], unit3: [], unit4: [],
  },
};

function fakeBattery({ caps = [] } = {}) {
  const d = Object.create(BatteryDevice.prototype);
  d.values = {};
  d.caps = new Set(['measure_power', 'measure_battery', ...caps]);
  d._prevSoc = null;
  d._prevChargingState = null;
  d._prevBatteryMode = null;
  d._prevBatteryStatus = null;
  d.log = () => {};
  d.getName = () => 'Battery';
  d.getSetting = () => true;
  d.hasCapability = (c) => d.caps.has(c);
  d.addCapability = async (c) => { d.caps.add(c); };
  d.removeCapability = async (c) => { d.caps.delete(c); delete d.values[c]; };
  d.getCapabilityValue = (c) => (c in d.values ? d.values[c] : null);
  d._set = async (c, v) => { if (v !== null && v !== undefined && d.caps.has(c)) d.values[c] = v; };
  d._setOptional = BatteryDevice.prototype._setOptional.bind(d);
  d.homey = {
    notifications: { createNotification: async () => {} },
    flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
  };
  return d;
}

const pollBatt = async (d, kpi) => {
  await d.onPollData({ kpiByType: { [TYPE_BATTERY]: [{ ...BATT_KPI, ...kpi }] } });
  return d;
};

test('the health figure comes from the modules, not from the field named after it', async () => {
  const d = await pollBatt(fakeBattery());
  assert.strictEqual(d.values['measure_battery.soh'], 95,
    'battery_soh reads 0 here while every module reports 95 % — the 0 must not win');
});

test('modules with differing health average rather than one of them standing for all', async () => {
  const d = await pollBatt(fakeBattery(), {
    battery_unit_info: { unit1: [{ soh: '90.0%' }, { soh: '95.0%' }, { soh: '100.0%' }], unit2: [], unit3: [], unit4: [] },
  });
  assert.strictEqual(d.values['measure_battery.soh'], 95);
});

// The flat battery_soh is 0 when nothing is reported, and a module entry behaves the same
// way. Averaging those zeros in would drag a healthy pack down by exactly the fraction of
// its modules that stayed quiet — a wrong number produced from a missing one.
test('a module that reports no health is left out of the average, not counted as zero', async () => {
  const d = await pollBatt(fakeBattery(), {
    battery_unit_info: {
      unit1: [{ soh: '95.0%' }, { soh: '0.0%' }, { soh: '95.0%' }],
      unit2: [], unit3: [], unit4: [],
    },
  });
  assert.strictEqual(d.values['measure_battery.soh'], 95,
    'the silent module was averaged in and turned a 95 % pack into a 63 % one');
  assert.strictEqual(d.values['measure_battery_modules'], 3,
    'it is still a module — only its health reading is missing');
});

test('a pack where every module is silent shows no health row', async () => {
  const d = await pollBatt(fakeBattery(), {
    battery_unit_info: { unit1: [{ soh: '0.0%' }, { soh: '0.0%' }], unit2: [], unit3: [], unit4: [] },
  });
  assert.strictEqual(d.caps.has('measure_battery.soh'), false);
  assert.strictEqual(d.values['measure_battery_modules'], 2);
});

test('a plant with no module list still falls back to battery_soh when that is usable', async () => {
  const d = await pollBatt(fakeBattery(), { battery_unit_info: undefined, battery_soh: 87 });
  assert.strictEqual(d.values['measure_battery.soh'], 87);
});

test('a plant with neither still shows no health row', async () => {
  const d = await pollBatt(fakeBattery(), { battery_unit_info: undefined, battery_soh: 0 });
  assert.strictEqual(d.caps.has('measure_battery.soh'), false,
    'the 0 % row is back — that reads as a battery at the end of its life');
});

test('the module count and the fitted units match what the Modbus battery reports', async () => {
  const d = await pollBatt(fakeBattery());
  assert.strictEqual(d.values['measure_battery_modules'], 3);
  assert.strictEqual(d.values['luna2000_unit1_installed'], true);
  assert.strictEqual(d.values['luna2000_unit2_installed'], false,
    'unit2 is an empty array in the capture, which is not the same as being fitted');
});

test('a second unit is counted in the total, not just the first', async () => {
  const d = await pollBatt(fakeBattery(), {
    battery_unit_info: {
      unit1: [{ soh: '95.0%' }, { soh: '95.0%' }],
      unit2: [{ soh: '93.0%' }], unit3: [], unit4: [],
    },
  });
  assert.strictEqual(d.values['measure_battery_modules'], 3);
  assert.strictEqual(d.values['luna2000_unit2_installed'], true);
});

test('no module list means no module rows invented', async () => {
  const d = await pollBatt(fakeBattery(), { battery_unit_info: undefined });
  assert.strictEqual(d.caps.has('measure_battery_modules'), false);
  assert.strictEqual(d.caps.has('luna2000_unit1_installed'), false);
});

// ── The meter: a status that arrived in every response ───────────────────────
//
// meter_status sits in the type 47 dataItemMap of every capture. The Modbus meter has
// published Normal / Offline from its own register since it was written.
const PS_KPI = {
  active_power: 2591,
  active_power_a: 1677, active_power_b: -1261, active_power_c: 2175,
  reverse_active_cap: 23167.8, active_cap: 17065.25,
  meter_status: 1,
  grid_frequency: 50.02,
};

function fakeMeter({ timeline = true, caps = [] } = {}) {
  const d = Object.create(MeterDevice.prototype);
  d.values = {};
  d.notes  = [];
  d.triggered = [];
  d.caps = new Set(['measure_power', 'meter_power', 'meter_power.exported', ...caps]);
  d._prevExporting = null;
  d._prevMeterStatus = null;
  d.log = () => {};
  d.getName = () => 'Meter';
  d.getSetting = (k) => (k === 'enable_timeline_notifications' ? timeline : null);
  d.hasCapability = (c) => d.caps.has(c);
  d.addCapability = async (c) => { d.caps.add(c); };
  d._set = async (c, v) => { if (v !== null && v !== undefined && d.caps.has(c)) d.values[c] = v; };
  d._fireExportImportTriggers = () => {};
  d.homey = {
    notifications: { createNotification: async ({ excerpt }) => { d.notes.push(excerpt); } },
    flow: {
      getDeviceTriggerCard: (id) => ({
        trigger: async (_dev, tokens) => { d.triggered.push({ id, ...tokens }); },
      }),
    },
  };
  return d;
}

const pollMeter = async (d, { kpi = PS_KPI, type = TYPE_POWER_SENSOR, station } = {}) => {
  await d.onPollData({ stationKpi: station, kpiByType: { [type]: [kpi] } });
  return d;
};

test('the meter status is published under the same capability the Modbus meter uses', async () => {
  const d = await pollMeter(fakeMeter());
  assert.strictEqual(d.values['dtsu666_meter_status'], 'Normal',
    'meter_status: 1 arrived and was dropped, as it had been in every response');
});

test('an offline meter says so, and an unknown code is shown rather than guessed at', async () => {
  assert.strictEqual((await pollMeter(fakeMeter(), { kpi: { ...PS_KPI, meter_status: 0 } }))
    .values['dtsu666_meter_status'], 'Offline');
  assert.strictEqual((await pollMeter(fakeMeter(), { kpi: { ...PS_KPI, meter_status: 7 } }))
    .values['dtsu666_meter_status'], 'Status 7');
});

test('a meter that sends no status keeps a tile without an empty row', async () => {
  const d = await pollMeter(fakeMeter(), { kpi: { ...PS_KPI, meter_status: undefined } });
  assert.strictEqual(d.caps.has('dtsu666_meter_status'), false);
});

test('a status change fires the flow card and the timeline, once', async () => {
  const d = fakeMeter();
  await pollMeter(d);
  assert.deepStrictEqual(d.notes, [], 'the first reading was announced as though it changed');
  assert.deepStrictEqual(d.triggered, [], 'and it fired the flow card too');

  await pollMeter(d, { kpi: { ...PS_KPI, meter_status: 0 } });
  assert.deepStrictEqual(d.notes, ['Meter: Offline']);
  assert.deepStrictEqual(d.triggered, [{ id: 'dtsu666_meter_status_changed', status: 'Offline' }]);

  await pollMeter(d, { kpi: { ...PS_KPI, meter_status: 0 } });
  assert.strictEqual(d.notes.length, 1, 'an unchanged status repeats every poll');
});

test('the meter switch turns the announcement off but leaves the flow card working', async () => {
  const d = fakeMeter({ timeline: false });
  await pollMeter(d);
  await pollMeter(d, { kpi: { ...PS_KPI, meter_status: 0 } });
  assert.deepStrictEqual(d.notes, []);
  assert.strictEqual(d.triggered.length, 1,
    'the switch is for the timeline, not for flows the user built themselves');
});

test('the status is read on the grid-meter type as well', async () => {
  const d = await pollMeter(fakeMeter(), { type: TYPE_METER });
  assert.strictEqual(d.values['dtsu666_meter_status'], 'Normal');
});

// The flow cards were written for the Modbus meter alone. A capability without the widened
// filter is a capability no flow can reach.
test('both meter-status cards accept the cloud meter', () => {
  const app = require(path.join('..', 'app.json'));
  const cards = [...app.flow.triggers, ...app.flow.conditions];
  for (const id of ['dtsu666_meter_status_changed', 'dtsu666_meter_status_is']) {
    const filter = cards.find((c) => c.id === id).args.find((a) => a.type === 'device').filter;
    assert.match(filter, /powermeter_openapi_fusionsolar/,
      `${id} still lists only the Modbus meter, so the new capability reaches no flow`);
  }
});

// ── The station: a house total that was fetched and discarded ────────────────

test("house consumption today comes from the station's own daily total", async () => {
  const d = await pollMeter(fakeMeter(), { station: { dayUseEnergy: 20.3 } });
  assert.strictEqual(d.values['meter_power.consumption_today'], 20.3,
    'the station KPI was fetched and thrown away, as the SUN2000 driver still notes');
});

// Just after midnight the counter legitimately reads 0. Treating that as "not reported",
// the way the battery's health field has to be treated, would blank the row every night.
test('a zero house total is a reading and is published', async () => {
  const d = await pollMeter(fakeMeter(), { station: { dayUseEnergy: 0 } });
  assert.strictEqual(d.values['meter_power.consumption_today'], 0);
});

test('a station that reports no house total gets no row', async () => {
  const d = await pollMeter(fakeMeter(), { station: { dayUseEnergy: null } });
  assert.strictEqual(d.caps.has('meter_power.consumption_today'), false);
  const d2 = await pollMeter(fakeMeter());
  assert.strictEqual(d2.caps.has('meter_power.consumption_today'), false,
    'a missing station KPI must not throw or invent a row');
});

// The widget is the reason this figure is worth publishing at all.
test('the energy-balance widget prefers a reported house total over its own arithmetic', () => {
  const fs  = require('fs');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'widgets', 'energy-balance', 'api.js'), 'utf8');
  const stmt = src.slice(src.indexOf('let houseConsumptionKwh'),
                         src.indexOf('return {'));
  assert.match(stmt, /cap\(pmOa,\s+'meter_power\.consumption_today'/,
    'the cloud meter now has the figure and the widget still derives its own');
  assert.ok(stmt.indexOf('pmEmma') < stmt.indexOf('pmOa'),
    'the local EMMA total must stay ahead of the cloud one');
});
