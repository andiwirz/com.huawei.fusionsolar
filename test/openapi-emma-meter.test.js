'use strict';

// EMMA-A02 (devTypeId 23070) as the grid meter. Run: node --test
//
// Feature request #25, with a diagnostic capture and FusionSolar screenshots taken minutes
// apart. Those numbers are the whole evidence for two decisions that cannot be read off the
// field names, and both of which fail silently if guessed:
//
//   Unit       EMMA reports active_power in kW. The power-sensor branch treats the same
//              field as watts. Guess wrong and a 1.3 kW export displays as "1 W" forever.
//   Direction  EMMA's active_cap is IMPORT, reverse_active_cap is EXPORT — the opposite of
//              the power-sensor branch. Guess wrong and the two totals swap, which nobody
//              notices for months.
//
// The figures below are that capture verbatim, so if either decision is ever "tidied up"
// to match the power sensor, these tests fail with the owner's own data.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

// device.js needs `homey`; the driver class only uses Device as a base here.
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  return origLoad.call(this, request, parent, isMain);
};
const MeterDevice = require(path.join('..', 'drivers', 'powermeter_openapi_fusionsolar', 'device.js'));
Module._load = origLoad;

// The capture of 2026-09-02 17:55 Europe/Madrid, verbatim.
const EMMA_KPI = {
  active_cap: 5298.26,
  reverse_active_cap: 912.84,
  active_power: -1.319,
  active_power_a: -0.872,
  active_power_b: -0.581,
  active_power_c: 0.135,
  a_u: 233.9, b_u: 237.7, c_u: 237.3,
  a_i: 3.8,   b_i: 3,     c_i: 1.4,
  power_factor: -0.68,
  reactive_power: -0.648,
  run_state: 1,
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
  d._fireExportImportTriggers = () => {};
  return d;
}

const poll = async (kpiByType) => {
  const d = fakeMeter();
  await d.onPollData({ kpiByType });
  return d;
};

test('EMMA is asked for at all — without the type nothing is ever fetched', () => {
  const d = Object.create(MeterDevice.prototype);
  assert.ok(d.getDevTypes().includes(23070),
    'the coordinator only fetches the types this returns, so leaving 23070 out is exactly '
    + 'why the device showed no values at all');
});

test('EMMA active_power is read as kW, not watts', async () => {
  const d = await poll({ 23070: [EMMA_KPI] });
  // -1.319 kW at the moment FusionSolar showed 1.380 kW being exported.
  assert.strictEqual(d.values['measure_power'], -1319,
    'read as watts this would be -1 W, and the tile would sit at zero all day');
});

test('the phases are kW too, and they add up to the total', async () => {
  const d = await poll({ 23070: [EMMA_KPI] });
  assert.strictEqual(d.values['measure_power.phase1'], -872);
  assert.strictEqual(d.values['measure_power.phase2'], -581);
  assert.strictEqual(d.values['measure_power.phase3'], 135);
  const sum = d.values['measure_power.phase1'] + d.values['measure_power.phase2']
            + d.values['measure_power.phase3'];
  assert.ok(Math.abs(sum - d.values['measure_power']) <= 1,
    `phases sum to ${sum} W but the total says ${d.values['measure_power']} W`);
});

test('active_cap is import and reverse_active_cap is export, not the other way round', async () => {
  const d = await poll({ 23070: [EMMA_KPI] });
  // Portal at the same time: import 5.31 MWh, export 917.61 kWh.
  assert.strictEqual(d.values['meter_power'], 5298.26, 'imported energy');
  assert.strictEqual(d.values['meter_power.exported'], 912.84, 'exported energy');
  assert.ok(d.values['meter_power'] > d.values['meter_power.exported'],
    'this house has imported far more than it exported — swapped totals would invert that');
});

test('a negative reading is labelled Export', async () => {
  const d = await poll({ 23070: [EMMA_KPI] });
  assert.strictEqual(d.values['powermeter_state_string'], '1319 W Export');
});

test('phase A comes from a_u / a_i, which EMMA names differently', async () => {
  const d = await poll({ 23070: [EMMA_KPI] });
  assert.strictEqual(d.values['measure_voltage.meter_u'], 233.9);
  assert.strictEqual(d.values['measure_current.meter_i'], 3.8);
  assert.strictEqual(d.values['measure_voltage.c_u'], 237.3);
});

test('no frequency capability is added — EMMA does not report one', async () => {
  const d = await poll({ 23070: [EMMA_KPI] });
  assert.strictEqual(d.caps.has('measure_frequency'), false,
    'an always-empty row on the device tile');
  assert.ok(d.caps.has('measure_power.phase1'), 'the phases it does report were added');
});

// The power sensor keeps its own unit and its own counter direction. Only the SIGN of
// active_power has since been brought into line with EMMA's, and only because it was
// finally measured against a Modbus DTSU666 on one house — see openapi-grid-sign.test.js
// for that capture. The unit and the swapped counters remain genuinely different between
// the two device types, and harmonising those by hand is what this still guards.
test('the power-sensor branch keeps its own unit and its own counter direction', async () => {
  const d = await poll({ 47: [{ active_power: -1319, active_cap: 10, reverse_active_cap: 20 }] });
  assert.strictEqual(d.values['measure_power'], 1319,
    'read in kW like EMMA this would be 1319000 W — the magnitude is the unit, the sign is '
    + 'the 1.2.212 fix');
  assert.strictEqual(d.values['meter_power'], 20, 'still reverse_active_cap');
  assert.strictEqual(d.values['meter_power.exported'], 10, 'still active_cap');
});

test('EMMA wins when it is present — it is the grid connection point', async () => {
  const d = await poll({
    23070: [EMMA_KPI],
    47: [{ active_power: 999, active_cap: 1, reverse_active_cap: 2 }],
  });
  assert.strictEqual(d.values['measure_power'], -1319);
});
