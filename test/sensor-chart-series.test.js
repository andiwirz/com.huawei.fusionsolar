'use strict';

// Which device a Sensor Chart series belongs to. Run: node --test
//
// Issue #29: three Sensor Chart widgets, three different OpenAPI devices selected, one
// identical curve in all of them. The history was keyed by `device.getData().id`, which is
// the app's own identifier and unique only within a driver — and all seven OpenAPI drivers
// mint the same one for a plant, `openapi:<server>:<stationCode>`. The inverter, the battery
// and the power sensor therefore shared a single bucket, each overwriting the others'
// measure_power once a minute.
//
// The key is now the Homey device id, which is unique across the installation by
// construction. The first test is the collision itself.

const Module = require('module');
const _origLoad = Module._load;

// app.js needs `homey` for its base class only; nothing under test touches it.
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { App: class {} };
  return _origLoad.call(this, request, parent, isMain);
};

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const FusionSolarApp = require('../app.js');

const ROOT = path.join(__dirname, '..');

// A Homey device stand-in. `dataId` is the app's own identifier — deliberately the same for
// all three OpenAPI devices below, exactly as the pairing pages mint it.
function fakeDevice({ homeyId, dataId, name, caps = {}, options = {} }) {
  return {
    getId: () => homeyId,
    getData: () => ({ id: dataId }),
    getName: () => name,
    getCapabilities: () => Object.keys(caps),
    getCapabilityValue: (c) => caps[c],
    getCapabilityOptions: (c) => {
      if (!(c in options)) throw new Error(`no options for ${c}`);
      return options[c];
    },
  };
}

const PLANT = 'openapi:https://eu5.fusionsolar.huawei.com:NE=141986968';

const INVERTER = fakeDevice({
  homeyId: 'f3f4bf23-8ae5-4f14-b4e2-ef603881d090', dataId: PLANT,
  name: 'Inverter SUN2000 (OpenAPI)',
  caps: { measure_power: 204 },
  options: { measure_power: { title: { en: 'Solar Power', de: 'Solarleistung' } } },
});

const BATTERY = fakeDevice({
  homeyId: 'aaaa1111-2222-3333-4444-555566667777', dataId: PLANT,
  name: 'LUNA2000 Battery (OpenAPI)',
  caps: { measure_power: 0 },
  options: { measure_power: { title: { en: 'Battery Power' } } },
});

const METER = fakeDevice({
  homeyId: 'bbbb1111-2222-3333-4444-555566667777', dataId: PLANT,
  name: 'Power Sensor (OpenAPI)',
  caps: { measure_power: 285 },
});

// ── the collision ───────────────────────────────────────────────────────────

test('three devices of one plant no longer share a series', () => {
  const keys = [INVERTER, BATTERY, METER]
    .map((d) => FusionSolarApp._seriesKey(d, 'measure_power'));
  assert.strictEqual(new Set(keys).size, 3, 'two devices still write into the same series');
});

// The identifier that caused it, named so a future edit cannot quietly go back to it.
test('the series key is the Homey device id, not the app-minted one', () => {
  const key = FusionSolarApp._seriesKey(INVERTER, 'measure_power');
  assert.strictEqual(key, `${INVERTER.getId()}::measure_power`);
  assert.ok(!key.includes(PLANT), 'the key is built from the ambiguous data id again');
});

test('one device still keeps its capabilities apart', () => {
  assert.notStrictEqual(
    FusionSolarApp._seriesKey(INVERTER, 'measure_power'),
    FusionSolarApp._seriesKey(INVERTER, 'measure_power.load'));
});

// ── what the picker and the legend read ─────────────────────────────────────

// A device offers one entry per capability, so rows labelled with the device name alone are
// indistinguishable — which is the other half of why #29 looked the way it did.
test('a series is named after its device AND its capability', () => {
  assert.strictEqual(
    FusionSolarApp._seriesLabel(INVERTER, 'measure_power'),
    'Inverter SUN2000 (OpenAPI) · Solar Power');
});

test('a capability with no title of its own still says which one it is', () => {
  const label = FusionSolarApp._seriesLabel(METER, 'measure_power');
  assert.strictEqual(label, 'Power Sensor (OpenAPI) · measure_power');
});

test('a capability whose options cannot be read does not break the picker', () => {
  const broken = fakeDevice({
    homeyId: 'x', dataId: 'y', name: 'Odd device', caps: { measure_power: 1 },
  });
  assert.doesNotThrow(() => FusionSolarApp._seriesLabel(broken, 'measure_power'));
});

test('two devices of one plant get labels that tell them apart', () => {
  assert.notStrictEqual(
    FusionSolarApp._seriesLabel(INVERTER, 'measure_power'),
    FusionSolarApp._seriesLabel(BATTERY, 'measure_power'));
});

// ── what the picker actually hands back ───────────────────────────────────

// The id the autocomplete returns is the one that gets saved in the widget settings, so it
// has to be the same string the snapshot writes under. If the two ever drift apart, every
// series a user picks is permanently empty — the same fault as #29, wearing a different hat.
function captureAutocomplete(devices) {
  const app = Object.create(FusionSolarApp.prototype);
  let handler = null;
  app.log = () => {};
  app.error = () => {};
  app.homey = {
    dashboards: {
      getWidget: () => ({ registerSettingAutocompleteListener: (name, fn) => { handler = fn; } }),
    },
    drivers: { getDrivers: () => ({ d1: { getDevices: () => devices } }) },
  };
  app._registerSensorChartAutocomplete();
  return handler;
}

test('the picker offers exactly the key the history is written under', async () => {
  const handler = captureAutocomplete([INVERTER, BATTERY, METER]);
  assert.ok(handler, 'no autocomplete listener was registered');

  const results = await handler('');
  assert.strictEqual(results.length, 3);
  for (const device of [INVERTER, BATTERY, METER]) {
    const expected = FusionSolarApp._seriesKey(device, 'measure_power');
    assert.ok(results.some((r) => r.id === expected),
      `the picker never offers ${device.getName()} under the key its history uses`);
  }
});

test('the picker gives three devices of one plant three different entries', async () => {
  const results = await captureAutocomplete([INVERTER, BATTERY, METER])('');
  assert.strictEqual(new Set(results.map((r) => r.id)).size, 3);
  assert.strictEqual(new Set(results.map((r) => r.name)).size, 3);
});

test('the picker filters on the name it shows', async () => {
  const results = await captureAutocomplete([INVERTER, BATTERY, METER])('luna');
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].id, FusionSolarApp._seriesKey(BATTERY, 'measure_power'));
});

// ── the payload the widget receives ─────────────────────────────────────────

function appWithHistory(entries) {
  const app = Object.create(FusionSolarApp.prototype);
  app._capHistory = new Map(entries);
  app._capHistoryInited = true;
  return app;
}

test('each requested series gets its own points', () => {
  const now = Date.now();
  const app = appWithHistory([
    ['dev-a::measure_power', [{ t: now - 1000, v: 204 }]],
    ['dev-b::measure_power', [{ t: now - 1000, v: 285 }]],
  ]);

  const { series } = app.getSensorChartData({
    hours: 24, s1: 'dev-a::measure_power', s2: 'dev-b::measure_power',
  });

  assert.strictEqual(series.length, 2);
  assert.strictEqual(series[0].points[0].v, 204);
  assert.strictEqual(series[1].points[0].v, 285, 'the second series echoed the first');
});

test('points older than the window are left out', () => {
  const now = Date.now();
  const app = appWithHistory([
    ['a::measure_power', [{ t: now - 48 * 3600_000, v: 1 }, { t: now - 1000, v: 2 }]],
  ]);
  const { series } = app.getSensorChartData({ hours: 24, s1: 'a::measure_power' });
  assert.deepStrictEqual(series[0].points.map((p) => p.v), [2]);
});

// "No data yet — collecting" invites waiting, and waiting never helps a series saved under
// the old key: nothing will ever be written there. The two cases have to be distinguishable.
test('a series the history has never heard of is marked as such', () => {
  const app = appWithHistory([['a::measure_power', [{ t: Date.now(), v: 1 }]]]);
  const { series } = app.getSensorChartData({
    hours: 24, s1: 'a::measure_power', s2: `${PLANT}::measure_power`,
  });
  assert.strictEqual(series[0].known, true);
  assert.strictEqual(series[1].known, false, 'a stale key looks like one that is still filling');
});

test('a known series that is merely empty is not called stale', () => {
  const app = appWithHistory([['a::measure_power', []]]);
  const { series } = app.getSensorChartData({ hours: 24, s1: 'a::measure_power' });
  assert.strictEqual(series[0].known, true);
  assert.deepStrictEqual(series[0].points, []);
});

// ── why the old key could never work ────────────────────────────────────────

// Pinned as a fact about the app, not as a thing to fix: the pairing pages are right to
// mint one id per plant. It is the chart that had no business using it as a series key.
test('every OpenAPI driver really does mint the same data id', () => {
  const pages = fs.readdirSync(path.join(ROOT, 'drivers'))
    .filter((d) => d.endsWith('_openapi_fusionsolar'))
    .map((d) => fs.readFileSync(path.join(ROOT, 'drivers', d, 'pair', 'start.html'), 'utf8'));

  assert.strictEqual(pages.length, 7);
  for (const html of pages) {
    assert.ok(html.includes('data: { id: `openapi:${_baseUrl}:${stationCode}` }'),
      'a pairing page changed its data id — the comment in _seriesKey needs revisiting');
  }
});

// ── the widget ──────────────────────────────────────────────────────────────

const WIDGET = fs.readFileSync(
  path.join(ROOT, 'widgets', 'sensor-chart', 'public', 'index.html'), 'utf8');

test('the widget asks for a fresh selection instead of telling people to wait', () => {
  assert.match(WIDGET, /stale \? T\.reselect : T\.noData/);
  // every, not some: a chart with one stale series and one that is genuinely still filling
  // is still collecting, and telling that user to re-pick would send them after the wrong
  // thing. Only when nothing can ever arrive is re-picking the answer.
  // Empty slots (a series not set up at all) are left out of the verdict first (1.2.299).
  assert.match(WIDGET, /present\.every\(function\(s\) \{ return s\.known === false; \}\)/);
});

test('the new message exists in all three widget languages', () => {
  assert.strictEqual((WIDGET.match(/reselect:/g) || []).length, 3);
});
