'use strict';

// Correction factor for the Solcast forecast (1.3.12, issue #37).
//
// RickD-CH compared a month of Solcast with his plant: 514 kWh forecast, 379 kWh yielded.
// Solcast told good days from bad ones best, but 36 % too high — and the EMS works in kWh:
// the EV deadline planning subtracts the forecast from the car's need, the solar gate and
// the start gate compare it with thresholds. One factor now scales the forecast every
// reader sees. The slots are kept as Solcast sent them, so a new factor applies when the
// settings are saved (not at the next fetch, 3 h per site away) and never on top of itself.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');

const pvForecastMixin    = require('../lib/ems/pvForecast');
const priceForecastMixin = require('../lib/ems/priceForecast');
const { PV_FORECAST_FACTOR_MIN, PV_FORECAST_FACTOR_MAX } = require('../lib/ems/constants');

const HOUR = 3600e3;

function makeDevice(cfg, stored) {
  const d = {
    cfg,
    store: { pvForecast: stored },
    logs: [],
    triggered: [],
    homey: {
      clock: { getTimezone: () => 'Europe/Zurich' },
      flow: { getDeviceTriggerCard: () => ({ trigger: async (dev, tokens) => { d.triggered.push(tokens); } }) },
    },
    log(msg) { d.logs.push(msg); },
    error() {},
    _getConfig() { return d.cfg; },
    async getStoreValue(k) { return d.store[k]; },
    async setStoreValue(k, v) { d.store[k] = v; },
  };
  return Object.assign(d, pvForecastMixin, priceForecastMixin);
}

// Two hours of 4 kW in half-hour slots, band 2..5 kW, the last slot without a band.
function rawSlots(now) {
  return [1, 2, 3, 4].map((i) => ({
    end: now + i * 0.5 * HOUR, kw: 4, kw10: i < 4 ? 2 : null, kw90: i < 4 ? 5 : null, h: 0.5,
  }));
}

test('the factor: unset, empty, zero or nonsense is 1; the rest is held in 0.3..1.5', () => {
  const d = makeDevice({});
  assert.strictEqual(PV_FORECAST_FACTOR_MIN, 0.3);
  assert.strictEqual(PV_FORECAST_FACTOR_MAX, 1.5);
  for (const v of [undefined, null, '', 0, -0.5, 'abc', NaN]) {
    assert.strictEqual(d._pvForecastFactor({ pv_forecast_factor: v }), 1, `${v} must mean no correction`);
  }
  assert.strictEqual(d._pvForecastFactor(null), 1);
  assert.strictEqual(d._pvForecastFactor({ pv_forecast_factor: 0.74 }), 0.74);
  assert.strictEqual(d._pvForecastFactor({ pv_forecast_factor: '0.8' }), 0.8);
  assert.strictEqual(d._pvForecastFactor({ pv_forecast_factor: 0.1 }), 0.3);
  assert.strictEqual(d._pvForecastFactor({ pv_forecast_factor: 2 }), 1.5);
});

test('scaling: power and band times the factor, a missing band stays missing', () => {
  const d = makeDevice({});
  const now = 1_800_000_000_000;
  const out = d._scalePvSlots(rawSlots(now), 0.5);
  assert.deepStrictEqual(out[0], { end: now + 0.5 * HOUR, kw: 2, kw10: 1, kw90: 2.5, h: 0.5 });
  assert.deepStrictEqual(out[3], { end: now + 2 * HOUR, kw: 2, kw10: null, kw90: null, h: 0.5 });
  const raw = rawSlots(now);
  assert.strictEqual(d._scalePvSlots(raw, 1), raw, 'factor 1 leaves the slots alone');
  assert.strictEqual(d._scalePvSlots(null, 0.5), null);
  assert.strictEqual(d._scalePvSlots(undefined, 1), null);
});

test('a restart applies the factor to the stored forecast, and the store stays raw', async () => {
  const now = Date.now();
  const raw = rawSlots(now);
  const d = makeDevice({ pv_forecast_factor: 0.75 }, { slots: raw, fetchedAt: now });
  await d._restorePvForecast();
  assert.strictEqual(d._pvForecastRaw, raw);
  assert.strictEqual(d._pvForecastNextKwh(3, now), 6, '8 kWh as Solcast sent it, 6 corrected');
  assert.strictEqual(d.store.pvForecast.slots[0].kw, 4, 'the stored slots are not touched');
});

test('saving a new factor applies at once, from the raw slots — never on top of itself', async () => {
  const now = Date.now();
  const d = makeDevice({ pv_forecast_factor: 0.5 }, { slots: rawSlots(now), fetchedAt: now });
  await d._restorePvForecast();
  assert.strictEqual(d._pvForecastNextKwh(3, now), 4);
  d._applyPvForecastFactor({ pv_forecast_factor: 0.5 });
  assert.strictEqual(d._pvForecastNextKwh(3, now), 4, 'applying it again changes nothing');
  d._applyPvForecastFactor({ pv_forecast_factor: 1.25 });
  assert.strictEqual(d._pvForecastNextKwh(3, now), 10);
  d._applyPvForecastFactor({});
  assert.strictEqual(d._pvForecastNextKwh(3, now), 8, 'cleared, it is Solcast\'s figure again');
  assert.deepStrictEqual(d.logs, [
    '[EMS] PV forecast correction factor 0.5 → 1.25',
    '[EMS] PV forecast correction factor 1.25 → 1',
  ], 'one log line per change, none at startup or for the same factor');
});

test('a fetch stores the raw slots and hands the corrected ones on, trigger tokens included', async () => {
  const now = Date.now();
  const d = makeDevice({ pv_forecast_enabled: true, solcast_api_key: 'k', solcast_resource_id: 'south', pv_forecast_factor: 0.5 });
  await d._restorePvForecast();
  d._solcastGet = async () => ({
    forecasts: [1, 2, 3, 4].map((i) => ({
      period_end: new Date(now + i * 0.5 * HOUR).toISOString(), period: 'PT30M',
      pv_estimate: 4, pv_estimate10: 2, pv_estimate90: 5,
    })),
  });
  await d._maybeFetchPvForecast(d.cfg);
  assert.strictEqual(d.store.pvForecast.slots[0].kw, 4, 'the store keeps what Solcast sent');
  assert.strictEqual(d._pvForecast[0].kw, 2);
  assert.strictEqual(d._pvForecast[0].kw90, 2.5);
  assert.strictEqual(d.triggered.length, 1);
  assert.strictEqual(d.triggered[0].next_6h_kwh, 4, 'the "forecast updated" tokens are corrected too');
  assert.strictEqual(d.triggered[0].peak_kw, 2);
});

test('the EMS decisions read the corrected forecast: EV deadline and solar gate', async () => {
  const now = Date.now();
  const d = makeDevice({ pv_forecast_factor: 0.5 }, { slots: rawSlots(now), fetchedAt: now });
  await d._restorePvForecast();
  // Both paths sum this._pvForecast — the corrected slots, not the raw ones.
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'lib', 'ems', 'priceForecast.js'), 'utf8');
  assert.strictEqual((src.match(/this\._pvSumKwh\(this\._pvForecast, /g) || []).length, 2);
  assert.ok(!/_pvForecastRaw/.test(src), 'the price planning must not read the raw forecast');
  assert.strictEqual(d._pvSumKwh(d._pvForecast, now, now + 3 * HOUR), 4);
});

test('the summary and the diagnostics carry the factor', async () => {
  const now = Date.now();
  const d = makeDevice({ pv_forecast_enabled: true, solcast_api_key: 'k', solcast_resource_id: 'r', pv_forecast_factor: 0.74 },
    { slots: rawSlots(now), fetchedAt: now });
  await d._restorePvForecast();
  assert.strictEqual(d._pvForecastSummary(now).factor, 0.74);
  assert.strictEqual(d.getPvForecast().slots[0].kw, 4 * 0.74, 'the chart and widget draw the corrected slots');
  d.cfg = {};
  assert.strictEqual(d._pvForecastSummary(now).factor, 1);
});

// The device: saving the settings applies the factor, and a mistyped one is clamped.
function requireDeviceClass() {
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'homey') return { Device: class {} };
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    return require(path.join(__dirname, '..', 'drivers', 'energy_management', 'device.js'));
  } finally {
    Module._load = origLoad;
  }
}

test('saving the settings applies the new factor and refreshes the forecast values', async () => {
  const EmsDevice = requireDeviceClass();
  const d = Object.create(EmsDevice.prototype);
  const now = Date.now();
  const cfg = { pv_forecast_factor: 0.5 };
  const caps = {};
  d.log = () => {}; d.error = () => {};
  d._getConfig = () => cfg;
  d._validateConfig = () => false;
  d._dropCarTargetOverrides = () => {};
  d.homey = { settings: { set: () => {} }, clock: { getTimezone: () => 'Europe/Zurich' } };
  d._syncCarCapabilities = async () => {};
  d._syncPvForecastCapabilities = async () => {};
  d._stopTick = () => {};
  d._startTick = () => {};
  d.hasCapability = () => true;
  d.setCapabilityValue = async (c, v) => { caps[c] = v; };
  d._pvForecastRaw = rawSlots(now);
  d._pvForecastFetchedAt = now;

  d.onConfigChanged();
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(d._pvForecastNextKwh(3, now), 4);
  assert.strictEqual(caps.pv_forecast_now, 2, 'the "now" value follows without waiting for the next tick');
});

test('a factor outside 0.3..1.5 is clamped when the settings are saved', () => {
  const EmsDevice = requireDeviceClass();
  const d = Object.create(EmsDevice.prototype);
  d.log = () => {};
  const high = { pv_forecast_factor: 3 };
  assert.strictEqual(d._validateConfig(high), true);
  assert.strictEqual(high.pv_forecast_factor, 1.5);
  const low = { pv_forecast_factor: 0.1 };
  d._validateConfig(low);
  assert.strictEqual(low.pv_forecast_factor, 0.3);
  const fine = { pv_forecast_factor: 0.74 };
  assert.strictEqual(d._validateConfig(fine), false);
});

test('the settings page shows the field, loads it and saves an empty one as 1', () => {
  const fs = require('fs');
  const vm = require('node:vm');
  const page = fs.readFileSync(path.join(__dirname, '..', 'settings', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(page, /<input id="ems-pvforecast-factor" type="number" value="1" min="0\.3" max="1\.5" step="0\.01"/);
  assert.match(page, /if \(cfg\.pv_forecast_factor\s+!== undefined\) document\.getElementById\('ems-pvforecast-factor'\)\.value\s+= cfg\.pv_forecast_factor;/);
  const save = page.match(/pv_forecast_factor:\s+([^\n]+),\n/);
  assert.ok(save, 'the save object does not carry the factor');
  const saved = (value) => vm.runInNewContext(save[1], { document: { getElementById: () => ({ value }) }, parseFloat });
  assert.strictEqual(saved('0.74'), 0.74);
  assert.strictEqual(saved(''), 1, 'an empty field is no correction, not a forecast of nothing');
  assert.strictEqual(saved('0'), 1);
  for (const lang of ['en', 'de', 'nl']) {
    const t = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', `${lang}.json`), 'utf8')).settings.pvForecast;
    assert.ok(t.factorLabel && t.factorHint, `${lang}: label or hint missing`);
    assert.match(t.factorHint, /0[.,]3–1[.,]5/, `${lang}: the hint names the range`);
  }
});
