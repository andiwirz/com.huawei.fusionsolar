'use strict';

// First tests for api.js. The file has 59 routes and had no coverage at all, which is
// where several of this project's regressions came from — it loads fine outside Homey
// (nothing at module scope needs the `homey` module), so the only thing that was missing
// was a fake Homey to hand it.
//
// What is pinned here is deliberately narrow but load-bearing: what every route that
// talks to the Homey local API returns when there is no API key. Twenty-four routes
// inline the same lookup and have drifted into nine different shapes and two different
// messages. Those shapes are a contract with the settings page — it branches on
// `error`, on `matched`, on `flows` — so they must survive any attempt to share that
// lookup. This file is the net for exactly that refactor.

const test   = require('node:test');
const assert = require('node:assert');

const api = require('../api.js');

// ── Fake Homey ───────────────────────────────────────────────────────────────
// Only the slice the API-key lookup touches: drivers → energy_management → devices,
// each with getSetting('homey_api_key') and getData().id.
function fakeDevice(apiKey, id = 'ems-1') {
  return {
    getSetting: (k) => (k === 'homey_api_key' ? apiKey : undefined),
    getData:    () => ({ id }),
  };
}

function fakeHomey(devices = []) {
  return {
    drivers: {
      getDriver(id) {
        assert.strictEqual(id, 'energy_management');
        return { getDevices: () => devices };
      },
    },
  };
}

// The EMS driver is not paired at all — getDriver throws, as Homey does before pairing.
function unpairedHomey() {
  return { drivers: { getDriver() { throw new Error('Invalid Driver'); } } };
}

// The three ways there can be no usable API key. Every route must handle all three
// identically: an unpaired driver must not leak an exception to the settings page.
const NO_KEY = [
  ['no EMS device paired', () => fakeHomey([])],
  ['EMS device without an API key', () => fakeHomey([fakeDevice('')])],
  ['EMS driver not paired yet', unpairedHomey],
];

// Enough arguments to get past each route's own validation, so that the API-key guard is
// the one that fires. Deliberately one fat object rather than per-route sets: the point of
// these tests is the key guard, not the argument names.
const ARGS = {
  emsDeviceId: 'ems-1', deviceId: 'dev-1',
  cap: 'onoff', value: true,
  actionCardId: 'a', actionCardUri: 'homey:app:x',
  startCardId: 's', startCardUri: 'homey:app:x',
  stopCardId: 'e',  stopCardUri: 'homey:app:x',
  triggerCardId: 't', triggerCardUri: 'homey:app:x',
  // postEmsCarSetupFlows filters `flows` down to entries with a numeric pct and an action
  // card, so its entries need those fields too — hence the union rather than two shapes.
  carId: 'car-1', deviceName: 'Car',
  flows: [{ start_card: 'a', stop_card: 'b', pct: 80, actionCard: 'a', actionUri: 'homey:app:x' }],
};

// route → the exact shape it answers with when no API key is available.
// Kept verbatim from the implementation: these differences are the thing at risk.
const SHAPES = [
  ['getEmsDebug',                    { error: 'No API key' }],
  ['getEmsTriggerCards',             { error: 'No API key' }],
  ['getEmsDebugFlow',                { error: 'No API key' }],
  ['getEmsPriceForecastTriggerCards', { error: 'No API key' }],
  ['getEmsChargerActionCards',       { error: 'No API key' }],
  ['getEmsChargerConditionCards',    { error: 'No API key' }],
  ['postEmsChargerSetupFlows',       { error: 'No API key' }],
  ['postEmsHeatPumpSetupFlows',      { error: 'No API key' }],

  ['postEmsCapabilityValue',         { value: null, error: 'No API key' }],
  ['getEmsSchedulerFlows',           { flows: [], error: 'No API key' }],
  ['getEmsFlows',                    { matched: [], all: [], emsDeviceId: '', error: 'No API key' }],
  ['getEmsPriceForecastFlows',       { matched: [], error: 'No API key' }],
  ['getEmsHeatPumpFlows',            { matched: [], error: 'No API key' }],
  ['getEmsCarFlows',                 { matched: [], error: 'No API key' }],

  // The second message. Same condition, different words — a real inconsistency, pinned
  // so that sharing the lookup cannot silently unify them without someone deciding to.
  ['postEmsPriceForecastSetupFlows', { error: 'No API key — configure EMS device first' }],
  ['getEmsBatteryFlows',             { matched: [], error: 'No API key — configure EMS device first' }],
  ['postEmsBatterySetupFlows',       { error: 'No API key — configure EMS device first' }],
  ['postEmsCarSetupFlows',           { error: 'No API key — configure EMS device first' }],
  ['getInverterFlows',               { matched: [], error: 'No API key — configure EMS device first' }],
  ['postInverterSetupFlow',          { error: 'No API key — configure EMS device first' }],
];

for (const [route, expected] of SHAPES) {
  test(`${route} — answers ${JSON.stringify(expected)} without an API key`, async () => {
    assert.strictEqual(typeof api[route], 'function', `${route} is not exported`);
    for (const [label, makeHomey] of NO_KEY) {
      const res = await api[route]({ homey: makeHomey(), body: { ...ARGS }, query: { ...ARGS } });
      assert.deepStrictEqual(res, expected, `${route} differs for: ${label}`);
    }
  });
}

// Twelve of those routes check their own arguments BEFORE the API key, so a caller that
// forgets a field is told which field rather than being sent to configure an API key it
// may already have. Worth pinning: it is the kind of ordering a shared lookup could
// quietly invert.
const ARG_GUARDS = [
  ['getEmsPriceForecastTriggerCards', { error: 'Missing deviceId' }],
  ['getEmsChargerActionCards',        { error: 'Missing deviceId' }],
  ['getEmsChargerConditionCards',     { error: 'Missing deviceId' }],
  ['getEmsBatteryFlows',              { matched: [], error: 'Missing deviceId' }],
  ['getInverterFlows',                { matched: [], error: 'Missing deviceId' }],
  ['postEmsCapabilityValue',          { value: null, error: 'Missing deviceId or cap' }],
  ['postEmsBatterySetupFlows',        { error: 'Missing deviceId or flows array' }],
  ['postInverterSetupFlow',           { error: 'Missing deviceId or flows array' }],
];

for (const [route, expected] of ARG_GUARDS) {
  test(`${route} — rejects missing arguments before it looks at the API key`, async () => {
    // A device WITH a key: if the argument guard did not come first, this would get
    // past it and fail somewhere else entirely.
    const res = await api[route]({ homey: fakeHomey([fakeDevice('deadbeef')]), body: {}, query: {} });
    assert.deepStrictEqual(res, expected);
  });
}

// Two routes answer in their own way rather than with a plain error, because their
// callers render a value rather than a message.
test('getEmsDevices — names the missing EMS device instead of just "No API key"', async () => {
  for (const [label, makeHomey] of NO_KEY) {
    const res = await api.getEmsDevices({ homey: makeHomey(), body: {}, query: {} });
    assert.ok(res.error, `expected an error for: ${label}`);
    assert.match(res.error, /^No EMS device or API key found\. Add an EMS device first\./, label);
  }
});

test('getEmsTriggerUsage — reports known:false rather than an error, so the caller fails open', async () => {
  const res = await api.getEmsTriggerUsage({
    homey: fakeHomey([]), query: { ids: 'ems_inverter_export_limit_on,ems_inverter_export_limit_off' },
  });
  // The settings page gates the export-limit rules on this: "cannot tell" must be
  // distinguishable from "no flows exist", or it would block rules it cannot check.
  assert.strictEqual(res.known, false);
  // names travels alongside counts so the settings page can show WHICH flows will run
  assert.deepStrictEqual(res.names, {
    ems_inverter_export_limit_on: [],
    ems_inverter_export_limit_off: [],
  });
  assert.deepStrictEqual(res.counts, {
    ems_inverter_export_limit_on: 0,
    ems_inverter_export_limit_off: 0,
  });
});

test('getEmsTriggerUsage — an empty id list needs no API key at all', async () => {
  const res = await api.getEmsTriggerUsage({ homey: fakeHomey([]), query: { ids: '' } });
  assert.deepStrictEqual(res, { counts: {}, names: {}, known: true });
});

// A configured key must get past the guard. The call then fails at the HTTP layer (there
// is no Homey to talk to), which is fine — the point is that it no longer short-circuits
// on "no API key", so the guard keys off the setting and nothing else.
test('a configured API key gets past the guard instead of short-circuiting', async () => {
  const res = await api.getEmsFlows({ homey: fakeHomey([fakeDevice('deadbeef')]) });
  assert.notStrictEqual(res.error, 'No API key');
});

// ── putEmsConfig: the device-owned keys must survive a settings save ──────────
// The body replaces the stored config wholesale, so anything the settings page does not
// send is lost. offpeak_enabled belongs to the device tile's toggle, not to the page.
function settingsHomey(store = {}) {
  return {
    settings: {
      get: (k) => store[k],
      set: (k, v) => { store[k] = v; },
    },
    drivers: { getDriver() { throw new Error('Invalid Driver'); } },
    _store: store,
  };
}

test('putEmsConfig — a settings save does not switch the low-tariff toggle off', async () => {
  const homey = settingsHomey({ ems_config: { offpeak_enabled: true, min_battery_soc: 20 } });
  await api.putEmsConfig({ homey, body: { min_battery_soc: 30 } });
  assert.strictEqual(homey._store.ems_config.offpeak_enabled, true, 'the toggle was reset by a save');
  assert.strictEqual(homey._store.ems_config.min_battery_soc, 30, 'the saved value must still land');
});

test('putEmsConfig — an off toggle stays off, and a body that claims otherwise is ignored', async () => {
  const homey = settingsHomey({ ems_config: { offpeak_enabled: false } });
  // The page used to send `offpeak_enabled: false` itself; whatever it sends, the stored
  // value is what counts, because the tile is the only thing that may change it.
  await api.putEmsConfig({ homey, body: { offpeak_enabled: true } });
  assert.strictEqual(homey._store.ems_config.offpeak_enabled, false);
});

// The battery thresholds without a ramp have no field on the page any more, but the EMS reads
// them — min_battery_soc is the hard stop when no ramp is configured, and the ems-battery
// widget writes it there. Every save of the page used to drop them, and the stop fell back
// to 80 % (review 2026-10-10, 1.2.313).
test('putEmsConfig — a stop set in the widget survives a save of the settings page', async () => {
  const batteryMixin = require('../lib/ems/battery');
  const widgetMixin  = require('../lib/ems/widget');
  const homey = settingsHomey({ ems_config: { share_soc_low: 0, share_soc_high: 0, min_battery_soc: 60 } });
  const ems = {
    ...batteryMixin, ...widgetMixin,
    homey,
    _getConfig: () => ({ ...(homey._store.ems_config || {}) }),
    _validateConfig: () => false,
    _applyWidgetChange: () => {},
  };
  assert.deepStrictEqual(await ems.setEmsBatteryZones({ stopSoc: 30 }), { ok: true, stopSoc: 30 });

  // What emsSave sends: every field the page has, and none of these three.
  await api.putEmsConfig({ homey, body: { share_soc_low: 0, share_soc_high: 0, chargers: [] } });

  const cfg = homey._store.ems_config;
  assert.strictEqual(cfg.min_battery_soc, 30, 'the widget\'s stop was dropped by the page save');
  assert.strictEqual(cfg.min_battery_soc_low, 0);
  assert.strictEqual(ems._batteryZones(cfg, { soc: 50 }).minSoc, 30, 'the hard stop fell back to 80 %');
});

test('putEmsConfig — the full-battery threshold from before 1.2.108 is kept too, and a body that sends one wins', async () => {
  const homey = settingsHomey({ ems_config: { min_battery_soc: 25, battery_full_soc: 90 } });
  await api.putEmsConfig({ homey, body: { chargers: [] } });
  assert.strictEqual(homey._store.ems_config.battery_full_soc, 90);
  assert.strictEqual(homey._store.ems_config.min_battery_soc, 25);

  await api.putEmsConfig({ homey, body: { min_battery_soc: 40 } });
  assert.strictEqual(homey._store.ems_config.min_battery_soc, 40, 'a page that sends the key no longer owns it');

  const fresh = settingsHomey({});
  await api.putEmsConfig({ homey: fresh, body: { chargers: [] } });
  assert.ok(!('min_battery_soc' in fresh._store.ems_config), 'a key nobody ever set was invented');
});

test('putEmsConfig — a first save with nothing stored yet yields false, not undefined', async () => {
  const homey = settingsHomey({});
  await api.putEmsConfig({ homey, body: { min_battery_soc: 20 } });
  assert.strictEqual(homey._store.ems_config.offpeak_enabled, false);
});
