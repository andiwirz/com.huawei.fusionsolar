'use strict';

// The sign of the grid reading on the two FusionSolar cloud drivers. Run: node --test
//
// Measured 2026-09-06 on a house carrying the cloud devices and the Modbus ones at once,
// with both sets polled inside the same minute:
//
//   DTSU666      (Modbus)  measure_power  -4631 W   "4631 W Export"
//   Power sensor (cloud)   measure_power  +4650 W   "4650 W Import"
//   SDongle      (Modbus)  PV 7031 W, house 2402 W, grid -4631 W
//
// 7031 W of PV against 2402 W of house load is a house exporting, and the SDongle is a
// third, independent reading of the same instant. The cloud said it was importing.
//
// The lifetime counters agreed to the decimal at that moment — 23167.8 kWh of import on
// both devices — which is what places the fault in the sign of active_power alone, and not
// in the import/export assignment. Huawei counts feed-in as positive on the power sensor
// and the grid meter; Homey counts consumption as positive. dtsu666_modbus has negated
// since it was written (see its "PDF sign convention" note); these two never did.
//
// What it cost while it stood. energy.cumulative is true on the meter, so Homey Energy
// reads its measure_power as the whole home's draw; the widgets derive house load as
// pv + grid; and the EMS releases surplus as max(0, -grid). An exporting house therefore
// showed no surplus at all, and nothing was ever switched on.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  return origLoad.call(this, request, parent, isMain);
};
const MeterDevice    = require(path.join('..', 'drivers', 'powermeter_openapi_fusionsolar', 'device.js'));
const InverterDevice = require(path.join('..', 'drivers', 'sun2000_openapi_fusionsolar', 'device.js'));
Module._load = origLoad;

const TYPE_METER        = 17;
const TYPE_POWER_SENSOR = 47;
const TYPE_EMMA         = 23070;
const TYPE_INVERTER     = 38;

// What the Modbus meter read at the same moment, and what the cloud must now agree with.
const MODBUS_GRID_W = -4631;

// The raw FusionSolar fields for that minute, reconstructed from the capability values the
// cloud device published — it passed active_power straight through, so those values ARE the
// raw ones. Import 23167.8 kWh matched the DTSU666 exactly; export was 17062.67 against
// 17063.1, the cloud lagging by a poll.
const PS_KPI = {
  active_power:   4650,
  active_power_a: 1735,
  active_power_b:  602,
  active_power_c: 2312,
  reverse_active_cap: 23167.8,   // import total
  active_cap:         17062.67,  // export total
  meter_u: 239, b_u: 237.6, c_u: 239.1,
  meter_i: 7.44, b_i: 2.86, c_i: 9.69,
  grid_frequency: 50,
};

function fakeMeter() {
  const d = Object.create(MeterDevice.prototype);
  d.values = {};
  d.caps = new Set(['measure_power', 'meter_power', 'meter_power.exported']);
  d._prevExporting = null;
  d.log = () => {};
  d.hasCapability = (c) => d.caps.has(c);
  d.addCapability = async (c) => { d.caps.add(c); };
  d._set = async (c, v) => { d.values[c] = v; };
  d._fireExportImportTriggers = MeterDevice.prototype._fireExportImportTriggers.bind(d);
  d.homey = {
    flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
  };
  return d;
}

function fakeInverter() {
  const d = Object.create(InverterDevice.prototype);
  d.values = {};
  d.caps = new Set([
    'measure_power', 'measure_power.mppt', 'measure_power.active_power',
    'measure_power.grid_active_power', 'meter_power.grid_import', 'meter_power.grid_export',
    'meter_power.inv_total', 'meter_power.inv_daily', 'huawei_status',
  ]);
  d._prevDeviceStatus = null;
  d.log = () => {};
  d.getName = () => 'Inverter';
  d.getSetting = () => true;
  d.hasCapability = (c) => d.caps.has(c);
  d.addCapability = async (c) => { d.caps.add(c); };
  d._set = async (c, v) => { if (v !== null && v !== undefined) d.values[c] = v; };
  d._trackPower = () => {};
  d.homey = {
    notifications: { createNotification: async () => {} },
    flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
  };
  return d;
}

const pollMeter = async (kpiByType) => {
  const d = fakeMeter();
  await d.onPollData({ kpiByType });
  return d;
};

// ── The power meter ──────────────────────────────────────────────────────────

test('an exporting house reads negative, the way the Modbus meter reads it', async () => {
  const d = await pollMeter({ [TYPE_POWER_SENSOR]: [PS_KPI] });
  assert.strictEqual(d.values['measure_power'], -4650,
    'the cloud still reports export as a positive number');
  assert.ok(d.values['measure_power'] < 0,
    `the same instant read ${MODBUS_GRID_W} W over Modbus; the two must not disagree in sign`);
  assert.ok(Math.abs(d.values['measure_power'] - MODBUS_GRID_W) < 50,
    `cloud ${d.values['measure_power']} W against Modbus ${MODBUS_GRID_W} W — more than a poll apart`);
});

test('the state string says Export, which is what the house was doing', async () => {
  const d = await pollMeter({ [TYPE_POWER_SENSOR]: [PS_KPI] });
  assert.strictEqual(d.values['powermeter_state_string'], '4650 W Export');
});

test('the phases are negated too, and still sum to the total', async () => {
  const d = await pollMeter({ [TYPE_POWER_SENSOR]: [PS_KPI] });
  assert.strictEqual(d.values['measure_power.phase1'], -1735);
  assert.strictEqual(d.values['measure_power.phase2'], -602);
  assert.strictEqual(d.values['measure_power.phase3'], -2312);
  // Within 1 W, not exactly: Huawei sends the total and the three phases as separate
  // readings, and this capture has them 1 W apart (1735 + 602 + 2312 = 4649 against 4650).
  // The EMMA fixture in openapi-emma-meter.test.js allows the same slack for the same
  // reason. A phase left un-negated would miss by thousands, not by one.
  const sum = d.values['measure_power.phase1'] + d.values['measure_power.phase2']
            + d.values['measure_power.phase3'];
  assert.ok(Math.abs(sum - d.values['measure_power']) <= 1,
    `phases sum to ${sum} W but the total says ${d.values['measure_power']} W — one was negated `
    + 'and the other was not');
});

// The counters are the reason this could be diagnosed at all: they matched the Modbus meter
// exactly while the power did not. Negating them as well would destroy that evidence and
// send two lifetime totals backwards.
test('the sign fix leaves the energy counters alone', async () => {
  const d = await pollMeter({ [TYPE_POWER_SENSOR]: [PS_KPI] });
  assert.strictEqual(d.values['meter_power'], 23167.8,
    'the import total is no longer reverse_active_cap, or it got negated with the power');
  assert.strictEqual(d.values['meter_power.exported'], 17062.67);
  assert.ok(d.values['meter_power'] > 0 && d.values['meter_power.exported'] > 0,
    'a lifetime counter went negative');
});

test('an importing house still reads positive', async () => {
  const d = await pollMeter({ [TYPE_POWER_SENSOR]: [{ active_power: -1200 }] });
  assert.strictEqual(d.values['measure_power'], 1200);
  assert.strictEqual(d.values['powermeter_state_string'], '1200 W Import');
});

test('the grid meter type is negated on the same terms as the power sensor', async () => {
  const d = await pollMeter({ [TYPE_METER]: [{ active_power: 800 }] });
  assert.strictEqual(d.values['measure_power'], -800,
    'type 17 was left behind, so a plant with a grid meter and no power sensor still inverts');
  assert.strictEqual(d.values['powermeter_state_string'], '800 W Export');
});

// EMMA reports the grid connection point in Homey's own direction already, and it is the
// one branch nobody here can measure. Negating it too would break the installation that
// this app's EMMA support was built for.
test('EMMA is not negated — it already matches Homey', async () => {
  const d = await pollMeter({ [TYPE_EMMA]: [{ active_power: -1.319 }] });
  assert.strictEqual(d.values['measure_power'], -1319,
    'the negation leaked into the EMMA branch, inverting a reading that was already right');
});

// ── The inverter, which mirrors the meter ────────────────────────────────────

test('the inverter mirrors the grid figure with the same sign as the meter', async () => {
  const d = fakeInverter();
  await d.onPollData({
    stationKpi: {},
    kpiByType: {
      [TYPE_INVERTER]:     [{ active_power: 7.028, mppt_power: 7.028, total_cap: 47407.43, day_cap: 19.01 }],
      [TYPE_POWER_SENSOR]: [PS_KPI],
    },
  });
  assert.strictEqual(d.values['measure_power.grid_active_power'], -4650,
    'the inverter and the meter now report opposite signs for the same grid connection');
  assert.strictEqual(d.values['measure_power'], 7028, 'generation stays positive');
});

// Renamed in 1.2.212. Plain meter_power on a solarpanel is read by Homey as generated
// energy, and this one held the grid import total — 23 MWh of household consumption under
// the name reserved for yield.
test('the inverter grid counters carry the names the Modbus inverter uses', async () => {
  const d = fakeInverter();
  await d.onPollData({
    stationKpi: {},
    kpiByType: {
      [TYPE_INVERTER]:     [{ active_power: 7.028, mppt_power: 7.028 }],
      [TYPE_POWER_SENSOR]: [PS_KPI],
    },
  });
  assert.strictEqual(d.values['meter_power.grid_import'], 23167.8);
  assert.strictEqual(d.values['meter_power.grid_export'], 17062.67);
  assert.ok(!('meter_power' in d.values),
    'the grid import total is published as plain meter_power again — on a solarpanel that '
    + 'is the capability Homey reads as generation');
  assert.ok(!('meter_power.exported' in d.values));
});

// The manifest half of the same rename: a capability the driver writes but the driver.json
// does not declare is a write to nothing.
test('the manifest declares the renamed counters and no longer the old ones', () => {
  const app = require(path.join('..', 'app.json'));
  const drv = app.drivers.find((d) => d.id === 'sun2000_openapi_fusionsolar');
  assert.ok(drv.capabilities.includes('meter_power.grid_import'));
  assert.ok(drv.capabilities.includes('meter_power.grid_export'));
  assert.ok(!drv.capabilities.includes('meter_power'),
    'plain meter_power is still declared on a solarpanel-class device');
  assert.ok(!drv.capabilities.includes('meter_power.exported'));
  assert.ok(drv.capabilitiesOptions['meter_power.grid_import'],
    'the renamed capability lost its title and stays untranslated on the tile');
  assert.ok(drv.capabilitiesOptions['meter_power.grid_export']);
});

// Already-paired devices keep the old capabilities until something removes them, and a
// stale meter_power on a solarpanel is the exact hazard the rename was for.
test('the old names are stripped from devices that already have them', () => {
  const fs  = require('fs');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'drivers', 'sun2000_openapi_fusionsolar', 'device.js'), 'utf8');
  const dep = src.slice(src.indexOf('const DEPRECATED_CAPABILITIES'),
                        src.indexOf('const INVERTER_STATE_MAP'));
  assert.match(dep, /^\s*'meter_power',$/m,
    'existing installations keep a plain meter_power holding their grid import total');
  assert.match(dep, /^\s*'meter_power\.exported',$/m);
});
