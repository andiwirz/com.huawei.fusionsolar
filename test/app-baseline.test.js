'use strict';

// Unit tests for the daily grid-counter baseline. Run: node --test
//
// The energy-balance widget shows today's import and export as the difference between the
// cumulative counters now and their value at midnight. That midnight value is this baseline,
// so a day without one is a day the widget cannot report correctly.
//
// Field log 9c7e4414 (2026-08-21) showed "No baseline for today yet – writing initial
// baseline" after every one of four app starts on the same day. That installation has no
// SUN2000 device, so nothing could be read and nothing was written — the line announced an
// action before knowing whether it was possible. Behind it sat a quieter fault: the attempt
// was a single shot 10 s after start, so an inverter that had not finished its first poll by
// then cost the whole day its baseline, silently.

const Module = require('module');
const _origLoad = Module._load;

// app.js needs `homey` for its base class only; nothing under test touches it.
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { App: class {} };
  return _origLoad.call(this, request, parent, isMain);
};

const test   = require('node:test');
const assert = require('node:assert');
const FusionSolarApp = require('../app.js');

// A stand-in app: real methods, fake clock, fake settings, fake device tree.
function makeApp({ devices = {}, caps = {}, settings = {} } = {}) {
  const app = Object.create(FusionSolarApp.prototype);
  app.logs = [];
  app.errors = [];
  app.timers = [];          // [{ fn, ms }] — nothing fires until the test says so
  app.settingsStore = { ...settings };

  app.log   = (...a) => app.logs.push(a.join(' '));
  app.error = (...a) => app.errors.push(a.join(' '));
  app.homey = {
    setTimeout: (fn, ms) => { app.timers.push({ fn, ms }); return app.timers.length; },
    clearTimeout: () => {},
    clock: { getTimezone: () => 'UTC' },
    settings: {
      get: (k) => (k in app.settingsStore ? app.settingsStore[k] : null),
      set: (k, v) => { app.settingsStore[k] = v; },
    },
    drivers: {
      getDriver: (id) => {
        if (!(id in devices)) throw new Error(`no such driver ${id}`);
        return { getDevices: () => (devices[id] ? [devices[id]] : []) };
      },
    },
  };
  // The device objects the helpers read through
  for (const d of Object.values(devices)) {
    if (d) d.getCapabilityValue = (id) => (id in caps ? caps[id] : null);
  }
  return app;
}

// Runs the single pending timer, as if its delay had elapsed.
function fire(app) {
  const t = app.timers.shift();
  assert.ok(t, 'no timer was scheduled');
  t.fn();
  return t.ms;
}

const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

const COUNTERS = { 'meter_power.grid_export': 1234.5, 'meter_power.grid_import': 678.9 };

// ── _saveMidnightBaseline: what it did, not just that it ran ─────────────────
test('_saveMidnightBaseline — both counters stored, and it says so', () => {
  const app = makeApp({ devices: { sun2000_modbus: {}, sun2000_emma_modbus: null }, caps: COUNTERS });
  const res = app._saveMidnightBaseline();

  assert.deepStrictEqual(res, { written: ['export', 'import'], reason: null });
  assert.deepStrictEqual(app.settingsStore.eb_grid_export_baseline, { date: TODAY, baseline: 1234.5 });
  assert.deepStrictEqual(app.settingsStore.eb_grid_import_baseline, { date: TODAY, baseline: 678.9 });
});

test('_saveMidnightBaseline — no source device is reported as such, not as a failed read', () => {
  const app = makeApp({ devices: { sun2000_modbus: null, sun2000_emma_modbus: null } });
  const res = app._saveMidnightBaseline();

  assert.deepStrictEqual(res, { written: [], reason: 'no-source' });
  assert.strictEqual(app.settingsStore.eb_grid_export_baseline, undefined, 'nothing may be written');
});

test('_saveMidnightBaseline — a device that has not polled yet is a read that can still succeed', () => {
  const app = makeApp({ devices: { sun2000_modbus: {}, sun2000_emma_modbus: null }, caps: {} });
  const res = app._saveMidnightBaseline();
  assert.deepStrictEqual(res, { written: [], reason: 'no-reading' });
});

test('_saveMidnightBaseline — one counter present, one not, is still unfinished', () => {
  const app = makeApp({
    devices: { sun2000_modbus: {}, sun2000_emma_modbus: null },
    caps: { 'meter_power.grid_export': 100 },
  });
  const res = app._saveMidnightBaseline();
  assert.deepStrictEqual(res, { written: ['export'], reason: 'no-reading' });
});

// ── _ensureTodayBaseline: the announcement and the retry ─────────────────────
test('_ensureTodayBaseline — nothing is announced before the attempt', () => {
  const app = makeApp({ devices: { sun2000_modbus: {}, sun2000_emma_modbus: null }, caps: COUNTERS });
  app._ensureTodayBaseline();
  assert.deepStrictEqual(app.logs, [], 'a line was written before anything was attempted');

  fire(app);
  assert.ok(app.logs.some((l) => l.includes('export: 1234.5')), 'the successful write is not reported');
  assert.ok(!app.logs.some((l) => /No baseline/.test(l)), 'it still claims there is no baseline');
  assert.strictEqual(app.timers.length, 0, 'a completed baseline must not schedule a retry');
});

// All four sources absent, not just the two Modbus ones: the chain grew to include the
// FusionSolar OpenAPI meter and inverter, and a test that leaves those out would be
// checking a plant that still has somewhere to read from.
test('_ensureTodayBaseline — with no source device it says so once and does not retry', () => {
  const app = makeApp({
    devices: {
      sun2000_modbus: null,
      sun2000_emma_modbus: null,
      powermeter_openapi_fusionsolar: null,
      sun2000_openapi_fusionsolar: null,
    },
  });
  app._ensureTodayBaseline();
  fire(app);

  assert.strictEqual(app.timers.length, 0, 'retrying cannot make a missing device appear');
  const line = app.logs.find((l) => l.includes('No baseline for today'));
  assert.ok(line, 'the outcome is not reported at all');
  assert.match(line, /no inverter or grid meter is paired/,
    'the reason given is not the real one');
  assert.ok(!/writing initial baseline/.test(line), 'it still claims to be writing something');
});

// The quiet fault: ten seconds is a guess at a driver's first poll, and losing that race
// used to cost the whole day.
test('_ensureTodayBaseline — an unread counter is retried on a widening schedule', () => {
  const app = makeApp({ devices: { sun2000_modbus: {}, sun2000_emma_modbus: null }, caps: {} });
  app._ensureTodayBaseline();

  const delays = [];
  for (let i = 0; i < 4; i++) delays.push(fire(app));
  assert.deepStrictEqual(delays, [10_000, 60_000, 5 * 60_000, 15 * 60_000]);
  assert.strictEqual(app.timers.length, 0, 'it retries forever');

  const line = app.logs.find((l) => l.includes('No baseline for today'));
  assert.match(line, /still unread after 21 min/, 'the give-up line does not say how long it waited');
});

test('_ensureTodayBaseline — a retry that finds the counters writes and stops', () => {
  const app = makeApp({ devices: { sun2000_modbus: {}, sun2000_emma_modbus: null }, caps: {} });
  app._ensureTodayBaseline();
  fire(app);                       // first attempt: nothing to read
  assert.strictEqual(app.timers.length, 1, 'it gave up on the first miss');

  Object.assign(app.caps ?? {}, {});
  // The device starts answering between attempts, exactly as a first poll completing would.
  app.homey.drivers.getDriver('sun2000_modbus').getDevices()[0].getCapabilityValue =
    (id) => (id in COUNTERS ? COUNTERS[id] : null);

  fire(app);
  assert.deepStrictEqual(app.settingsStore.eb_grid_import_baseline, { date: TODAY, baseline: 678.9 });
  assert.strictEqual(app.timers.length, 0, 'it kept retrying after succeeding');
  assert.ok(!app.logs.some((l) => l.includes('No baseline for today')), 'it reported a failure it did not have');
});

test('_ensureTodayBaseline — a baseline already stored for today is left alone', () => {
  const app = makeApp({
    devices: { sun2000_modbus: {}, sun2000_emma_modbus: null },
    caps: COUNTERS,
    settings: {
      eb_grid_export_baseline: { date: TODAY, baseline: 11 },
      eb_grid_import_baseline: { date: TODAY, baseline: 22 },
    },
  });
  app._ensureTodayBaseline();
  fire(app);

  assert.strictEqual(app.settingsStore.eb_grid_export_baseline.baseline, 11, 'it overwrote today\'s baseline');
  assert.deepStrictEqual(app.logs, [], 'it announced work it correctly did not do');
});

test('_ensureTodayBaseline — yesterday\'s baseline does not count as today\'s', () => {
  const app = makeApp({
    devices: { sun2000_modbus: {}, sun2000_emma_modbus: null },
    caps: COUNTERS,
    settings: {
      eb_grid_export_baseline: { date: '2000-01-01', baseline: 11 },
      eb_grid_import_baseline: { date: '2000-01-01', baseline: 22 },
    },
  });
  app._ensureTodayBaseline();
  fire(app);
  assert.strictEqual(app.settingsStore.eb_grid_export_baseline.baseline, 1234.5, 'the stale baseline was kept');
});

// The retry timer outlives a stop unless it is cleared with the others.
test('onUninit clears the baseline retry timer', () => {
  const fs  = require('fs');
  const src = fs.readFileSync('app.js', 'utf8');
  assert.match(src, /if \(this\._baselineTimer\)\s+this\.homey\.clearTimeout\(this\._baselineTimer\);/,
    'the retry timer is left running when the app stops');
});
