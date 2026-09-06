'use strict';

// Which drivers the widgets can actually read from. Run: node --test
//
// The three FusionSolar OpenAPI drivers were named in no widget at all. The four
// iSitePower OpenAPI drivers had been added to the lookup chains at some point and these
// were passed over, so a plant reached only through the FusionSolar cloud — no Modbus, no
// EMMA gateway — drew four widgets full of em dashes: solar flow, grid traffic light,
// energy balance and battery status. Nothing was broken in a way anyone could see; the
// widgets simply never asked those devices anything.
//
// The DTSU666 was missing for a narrower reason. The SUN2000 mirrors the meter's reading
// in a register of its own, so a plant with both was served either way, and only a plant
// with the meter alone went without a grid figure.
//
// A list of driver ids spread across five files is exactly the kind of thing that goes
// quietly out of date when a driver is added, so this checks the whole set rather than the
// two that happened to be wrong.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const APP  = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));

// Every file that looks a device up by driver id.
const SOURCES = [
  path.join(ROOT, 'lib', 'widget-data.js'),
  path.join(ROOT, 'app.js'),
  ...fs.readdirSync(path.join(ROOT, 'widgets'))
    .map((w) => path.join(ROOT, 'widgets', w, 'api.js'))
    .filter((p) => fs.existsSync(p)),
];

function referencedDrivers() {
  const ids = new Set();
  for (const file of SOURCES) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/_?getDevice\(\s*(?:homey|this)?\s*,?\s*'([a-z0-9_]+)'/g)) {
      ids.add(m[1]);
    }
  }
  return ids;
}

// Drivers that report live energy figures. The EV chargers are read through their own
// device methods rather than by capability, and the EMS device is a controller.
const NOT_A_SOURCE = new Set(['smartcharger_ocpp', 'smartcharger_emma_modbus', 'energy_management']);

test('every energy driver can be reached by a widget', () => {
  const referenced = referencedDrivers();
  const missing = APP.drivers
    .map((d) => d.id)
    .filter((id) => !NOT_A_SOURCE.has(id) && !referenced.has(id));
  assert.deepStrictEqual(missing, [],
    `these drivers are named in no widget lookup, so a plant built on them alone shows `
    + `nothing: ${missing.join(', ')}`);
});

// The specific three the report was about, asserted by name as well: a future refactor
// that drops them would fail the general test above with a less useful message.
test('the FusionSolar OpenAPI drivers are in the chains', () => {
  const referenced = referencedDrivers();
  for (const id of ['sun2000_openapi_fusionsolar', 'luna2000_openapi_fusionsolar',
    'powermeter_openapi_fusionsolar']) {
    assert.ok(referenced.has(id), `${id} is unreachable from the widgets again`);
  }
});

// The OpenAPI inverter's plain meter_power WAS the GRID IMPORT total, while the Modbus
// one's is production. Reading the OpenAPI device the way the Modbus one is read would
// draw a house's grid consumption as its solar yield — a wrong number, not a missing one.
//
// 1.2.212 removed the trap at its source: that counter is now meter_power.grid_import, the
// name its Modbus twin uses, and the driver has no plain meter_power left to confuse. The
// assertion stays because it costs nothing and the confusion cost a release to find.
test('the OpenAPI inverter yield is read from its own counters, not from meter_power', () => {
  const src = fs.readFileSync(path.join(ROOT, 'widgets', 'daily-yield', 'api.js'), 'utf8');
  assert.match(src, /cap\(sunOa,\s+'meter_power\.inv_daily'/,
    'the daily yield no longer comes from the inverter total');
  assert.match(src, /cap\(sunOa,\s+'meter_power\.inv_total'/,
    'the lifetime yield no longer comes from the inverter total');
  assert.doesNotMatch(src, /cap\(sunOa,\s+'meter_power'/,
    'the OpenAPI inverter is read by plain meter_power, which holds its GRID IMPORT total '
    + '— that would be drawn as solar yield');
});

// The midnight baseline and the widget must read the same meter, or the daily delta is a
// difference between two different devices. app.js says so in a comment; this makes it fail
// rather than rely on the next person reading it.
test('the baseline and the widget draw grid counters from the same chain', () => {
  const widget = fs.readFileSync(path.join(ROOT, 'widgets', 'energy-balance', 'api.js'), 'utf8');
  const app    = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

  // Bounded by the statement, not by a character count: a fixed window ran past the export
  // chain into the import one and compared four entries against five.
  const chain = (src, marker) => {
    const at = src.indexOf(marker);
    assert.ok(at > 0, `${marker} is gone`);
    const end = src.indexOf(';', at);
    assert.ok(end > at, `${marker} has no statement end`);
    return [...src.slice(at, end).matchAll(/cap\(\s*(\w+),\s*'([\w.]+)'/g)]
      .map((m) => m[2]);
  };

  for (const [wMarker, aMarker] of [
    ['const rawExport', 'const gridExport'],
    ['const rawImport', 'const gridImport'],
  ]) {
    assert.deepStrictEqual(chain(widget, wMarker), chain(app, aMarker),
      `${wMarker} and ${aMarker} read different capabilities in different order — the `
      + 'baseline would be taken from one meter and the live value from another');
  }
});

// ─── The endpoints, actually called ─────────────────────────────────────────
//
// Reading the source proves a device is named; it does not prove the widget runs. A
// mutation run made the point: deleting the getDevice line leaves every source assertion
// above satisfied and throws a ReferenceError the moment a dashboard asks for data. So the
// two endpoints that gained a driver are called here, against a plant that owns nothing
// else.

function fakeHomey(table) {
  return {
    i18n: { getLanguage: () => 'en' },
    clock: { getTimezone: () => 'UTC' },
    settings: { get: () => null },
    drivers: {
      getDriver(id) {
        if (!(id in table)) throw new Error('no such driver: ' + id);
        const values = table[id];
        return { getDevices: () => [{ getCapabilityValue: (c) => (c in values ? values[c] : null) }] };
      },
    },
  };
}

test('the daily-yield endpoint answers for a FusionSolar OpenAPI plant', async () => {
  const api = require(path.join(ROOT, 'widgets', 'daily-yield', 'api.js'));
  const data = await api.getData({
    homey: fakeHomey({
      sun2000_openapi_fusionsolar: {
        'meter_power.inv_daily': 26.91,
        'meter_power.inv_total': 7569.6,
        'meter_power': 5321.05,   // grid import — must NOT be read as yield
      },
    }),
  });
  assert.strictEqual(data.dailyKwh, 26.91, 'the daily yield is missing for this plant');
  assert.strictEqual(data.totalKwh, 7569.6,
    'the lifetime yield is missing, or was taken from the grid import counter');
});

test('the battery-status endpoint answers for a FusionSolar OpenAPI plant', async () => {
  const api = require(path.join(ROOT, 'widgets', 'battery-status', 'api.js'));
  const data = await api.getData({
    homey: fakeHomey({
      luna2000_openapi_fusionsolar: {
        measure_battery: 47,
        measure_power: -510,
        'meter_power.today_batt_input': 6.09,
        'meter_power.today_batt_output': 2.7,
      },
    }),
  });
  assert.strictEqual(data.soc, 47, 'the state of charge is missing for this plant');
  assert.strictEqual(data.powerW, -510);
  assert.strictEqual(data.todayChargedKwh, 6.09, "today's charged energy is missing");
  assert.strictEqual(data.todayDischargedKwh, 2.7, "today's discharged energy is missing");
  assert.strictEqual(data.status, 'discharging',
    'the status could not be derived from the power reading');
});
