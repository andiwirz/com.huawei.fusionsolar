'use strict';

// Widget review of 2026-10-09, part A: figures the widgets showed wrong (1.2.299).
// Each test names the case the review found; the review notes are in the commit.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const vm     = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// A Homey stand-in for the widget api.js files: drivers maps driverId -> capability values
// (or { caps, available }), settings is the app settings store.
function fakeHomey(drivers, { settings = {}, lang = 'de', tz = 'Europe/Zurich' } = {}) {
  return {
    i18n:     { getLanguage: () => lang },
    clock:    { getTimezone: () => tz },
    settings: { get: (k) => settings[k] ?? null, set: (k, v) => { settings[k] = v; } },
    drivers: {
      getDriver(id) {
        if (!(id in drivers)) throw new Error('no such driver: ' + id);
        const d = drivers[id];
        const caps = d && d.caps ? d.caps : d;
        const available = d && d.caps ? d.available !== false : true;
        return {
          getDevices: () => [{
            getCapabilityValue: (c) => (c in caps ? caps[c] : null),
            getAvailable: () => available,
            getSetting: () => null,
            getName: () => id,
          }],
        };
      },
    },
  };
}

function today(tz = 'Europe/Zurich') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// ── 2: energy balance — the house total and the self-sufficiency beside it ─────────────

const energyBalance = require('../widgets/energy-balance/api.js');

test('self-sufficiency is taken against the house total it is shown beside', async () => {
  // EMMA plant with its meter's own house total: PV 20, export 5, import 2, battery +8/−1,
  // used 10. Of the 10 kWh used, 2 came from the grid: 80 %. The old sum counted the 7 kWh
  // that went into the battery as consumed and said 88 %.
  const homey = fakeHomey({
    sun2000_emma_modbus:    { 'meter_power.pv_daily': 20 },
    powermeter_emma_modbus: { 'meter_power.exported_today': 5, 'meter_power.imported_today': 2,
                              'meter_power.consumption_today': 10 },
    luna2000_emma_modbus:   { 'meter_power.today_batt_input': 8, 'meter_power.today_batt_output': 1 },
  });
  const d = await energyBalance.getData({ homey });
  assert.strictEqual(d.houseConsumptionKwh, 10);
  assert.strictEqual(d.selfSufficiencyPct, 80);
});

test('from a PV production figure the battery net comes off the derived house total', async () => {
  // Cloud plant without a house total: pv_daily is production at the panels, so the 7 kWh
  // net into the battery was not consumed. 20 − 5 − 7 + 2 = 10, not 17.
  const homey = fakeHomey({
    sun2000_openapi_fusionsolar:  { 'meter_power.pv_daily': 20 },
    powermeter_openapi_fusionsolar: { 'meter_power.exported': 105, meter_power: 52 },
    luna2000_openapi_fusionsolar: { 'meter_power.today_batt_input': 8, 'meter_power.today_batt_output': 1 },
  }, { settings: {
    eb_grid_export_baseline: { date: today(), baseline: 100 },
    eb_grid_import_baseline: { date: today(), baseline: 50 },
  } });
  const d = await energyBalance.getData({ homey });
  assert.strictEqual(d.gridExportKwh, 5);
  assert.strictEqual(d.gridImportKwh, 2);
  assert.strictEqual(d.houseConsumptionKwh, 10);
  assert.strictEqual(d.selfSufficiencyPct, 80);
});

test('an inverter AC figure already has the battery netted out', async () => {
  // Modbus 32114 is what the inverter delivered: discharge is in it, charge from PV is not.
  const homey = fakeHomey({
    sun2000_modbus:  { 'meter_power.daily': 13, 'meter_power.grid_export': 105, 'meter_power.grid_import': 52 },
    luna2000_modbus: { 'meter_power.today_batt_input': 8, 'meter_power.today_batt_output': 1 },
  }, { settings: {
    eb_grid_export_baseline: { date: today(), baseline: 100 },
    eb_grid_import_baseline: { date: today(), baseline: 50 },
  } });
  const d = await energyBalance.getData({ homey });
  assert.strictEqual(d.houseConsumptionKwh, 10, '13 − 5 + 2, no battery correction');
});

test('a paired battery without its day counters leaves the derived total unknown', async () => {
  const homey = fakeHomey({
    sun2000_openapi_fusionsolar:  { 'meter_power.pv_daily': 20, 'meter_power.grid_export': 105, 'meter_power.grid_import': 52 },
    luna2000_openapi_fusionsolar: {},
  }, { settings: {
    eb_grid_export_baseline: { date: today(), baseline: 100 },
    eb_grid_import_baseline: { date: today(), baseline: 50 },
  } });
  const d = await energyBalance.getData({ homey });
  assert.strictEqual(d.houseConsumptionKwh, null);
  assert.strictEqual(d.selfSufficiencyPct, null);
});

test('before the first PV of the day the house total is what came from the grid', async () => {
  const homey = fakeHomey({
    sun2000_modbus: { 'meter_power.daily': 0, 'meter_power.grid_export': 100, 'meter_power.grid_import': 51.5 },
  }, { settings: {
    eb_grid_export_baseline: { date: today(), baseline: 100 },
    eb_grid_import_baseline: { date: today(), baseline: 50 },
  } });
  const d = await energyBalance.getData({ homey });
  assert.strictEqual(d.houseConsumptionKwh, 1.5);
  assert.strictEqual(d.selfSufficiencyPct, 0);
});

// ── helpers for the widget pages ─────────────────────────────────────────────────────────

// The source of `function name(...) { ... }` in a page, braces matched (strings respected).
function fnSource(html, name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `function ${name} is not in the page`);
  let depth = 0, inStr = null;
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    const c = html[i];
    if (inStr) { if (c === '\\') i++; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}

// `var DICTS = (function () { ... })();` from a page.
function dictsSource(html) {
  const m = html.match(/var DICTS = \(function ?\(\) \{[\s\S]*?\n\s*\}\)\(\);/);
  assert.ok(m, 'no DICTS in the page');
  return m[0];
}

// ── 1 and 14: solar-power-flow ───────────────────────────────────────────────────────────

const FLOW = read('widgets', 'solar-power-flow', 'public', 'index.html');

test('the flow widget can relabel itself: applyStaticLabels sits where applyLang reaches it', () => {
  // It used to live inside onHomeyReady; the first payload threw a ReferenceError there,
  // the widget stayed on its loading state, and the labels stayed in the phone's language.
  const els = {};
  const document = { getElementById: (id) => (els[id] = els[id] || { textContent: '' }) };
  const ctx = { document, navigator: { language: 'en-US' } };
  vm.createContext(ctx);
  const head = FLOW.slice(FLOW.indexOf('<script>') + 8, FLOW.indexOf('function onHomeyReady('));
  vm.runInContext(head, ctx);
  assert.strictEqual(vm.runInContext("applyLang('de')", ctx), true);
  assert.strictEqual(els['label-grid'].textContent, 'Netz');
  assert.strictEqual(els['label-pv'].textContent, 'Solar');
  assert.ok(!/node-label">Solar PV</.test(FLOW), 'an English label is still hard-coded');
});

test('the flow widget says Export/Import with the same threshold as the line beside it', () => {
  assert.match(FLOW, /grid < -thr\) \? T\.export :/);
  assert.match(FLOW, /grid >  thr\) \? T\.import : ''/);
  assert.ok(!/grid < -50\) \? T\.export/.test(FLOW));
});

// ── 3: netzampel ─────────────────────────────────────────────────────────────────────────

const AMPEL = read('widgets', 'netzampel', 'public', 'index.html');

test('the grid light names who covers the house while the grid is quiet', () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fnSource(AMPEL, 'selfSubKey'), ctx);
  const key = (pv, batt) => vm.runInContext(`selfSubKey(${pv}, ${batt}, 50)`, ctx);
  assert.strictEqual(key(0, -850), 'selfSubBatt', 'at night with the battery carrying the load');
  assert.strictEqual(key(3000, 0), 'selfSub');
  assert.strictEqual(key(3000, -850), 'selfSubBoth');
  assert.strictEqual(key(0, 0), 'selfSubIdle');
  assert.strictEqual(key(null, null), 'selfSubIdle');
  // …and shows the load being covered, not the PV figure
  assert.match(AMPEL, /label\.textContent = T\.self;\s+value\.textContent = fmt\(house\);/);
  for (const k of ['selfSubBatt', 'selfSubBoth', 'selfSubIdle']) {
    assert.strictEqual((AMPEL.match(new RegExp(`${k}:`, 'g')) || []).length, 3, `${k} in all three languages`);
  }
});

// ── 4–7: sensor chart ───────────────────────────────────────────────────────────────────

const Module = require('module');
function loadApp() {
  const orig = Module._load;
  Module._load = function (r, p, m) { if (r === 'homey') return { App: class {} }; return orig.call(this, r, p, m); };
  try { return require('../app.js'); } finally { Module._load = orig; }
}
const App = loadApp();

function chartApp() {
  const app = Object.create(App.prototype);
  app._capHistory = new Map();
  app._capHistoryCoarse = new Map();
  app._capHistoryInited = true;
  return app;
}

test('the long chart views get a week, from the quarter-hour tier', () => {
  const app = chartApp();
  const now = Date.now();
  const fine = [], coarse = [];
  for (let t = now - 7 * 86400e3; t <= now; t += 60e3) {
    App._addCoarse(coarse, t, 1000);
    if (t > now - 25 * 3600e3) fine.push({ t, v: 1000 });
  }
  app._capHistory.set('a::measure_power', fine);
  app._capHistoryCoarse.set('a::measure_power', coarse);
  const spanH = (h) => {
    const pts = app.getSensorChartData({ hours: h, s1: 'a::measure_power' }).series[0].points;
    return (pts[pts.length - 1].t - pts[0].t) / 3600e3;
  };
  assert.ok(spanH(24) <= 24.1);
  assert.ok(spanH(48) > 47, `48 h drew ${spanH(48).toFixed(1)} h`);
  assert.ok(spanH(168) > 166, `7 days drew ${spanH(168).toFixed(1)} h`);
  assert.ok(coarse.length <= App.CAP_HISTORY_COARSE_MAX);
  assert.strictEqual(coarse[coarse.length - 1].t % App.CAP_HISTORY_COARSE_MS, 0);
});

test('a quarter-hour bucket keeps the average, the low and the high', () => {
  const b = [];
  const q = App.CAP_HISTORY_COARSE_MS;
  const t0 = Math.floor(Date.now() / q) * q;
  App._addCoarse(b, t0, 100);
  App._addCoarse(b, t0 + 60e3, 300);
  App._addCoarse(b, t0 + 120e3, 200);
  App._addCoarse(b, t0 + q, 50);
  assert.deepStrictEqual(b[0], { t: t0, v: 200, lo: 100, hi: 300, n: 3 });
  assert.strictEqual(b.length, 2);
});

test('an unreachable device records nothing, and the chart shows the hole', () => {
  const app = chartApp();
  let available = true;
  const device = {
    getId: () => 'dev', getName: () => 'Dev', getCapabilities: () => ['measure_power'],
    getCapabilityValue: () => 2300, getAvailable: () => available,
  };
  app.homey = { drivers: { getDrivers: () => ({ d: { getDevices: () => [device] } }) } };
  app._snapshotAllCaps();
  available = false;
  app._snapshotAllCaps();
  app._snapshotAllCaps();
  assert.strictEqual(app._capHistory.get('dev::measure_power').length, 1, 'the stale reading was recorded again');

  // A two-hour hole in the minute points comes back as a { v: null } break.
  const now = Date.now();
  const pts = [];
  for (let t = now - 6 * 3600e3; t <= now; t += 60e3) if (!(t > now - 4 * 3600e3 && t < now - 2 * 3600e3)) pts.push({ t, v: 500 });
  app._capHistory.set('g::measure_power', pts);
  const out = app.getSensorChartData({ hours: 6, s1: 'g::measure_power' }).series[0];
  assert.strictEqual(out.points.filter((p) => p.v === null).length, 1);
  assert.ok(out.points.length <= 240);
});

test('the legend gets the reading now — none for a device that went away', () => {
  const app = chartApp();
  const now = Date.now();
  app._capHistory.set('on::measure_power',  [{ t: now - 30e3, v: 812.34 }]);
  app._capHistory.set('off::measure_power', [{ t: now - 20 * 60e3, v: 2300 }]);
  const { series } = app.getSensorChartData({ hours: 24, s1: 'on::measure_power', s2: 'off::measure_power' });
  assert.strictEqual(series[0].current, 812.3);
  assert.strictEqual(series[1].current, null);
});

test('right after a start the chart is told to wait, not that every series is unknown', () => {
  const app = chartApp();
  app._capHistoryInited = false;
  assert.deepStrictEqual(app.getSensorChartData({ hours: 24, s1: 'a::measure_power' }), { series: [], ready: false });
});

test('thinning keeps a short peak a by-index pick would drop', () => {
  const { downsample } = require('../lib/chart-downsample');
  const now = Date.now();
  const pts = [];
  for (let i = 0; i < 1440; i++) pts.push({ t: now - (1440 - i) * 60e3, v: i === 777 ? 11000 : 400 });
  const out = downsample(pts, 240, 3 * 60e3);
  assert.ok(out.length <= 240);
  assert.ok(out.some((p) => p.v === 11000), 'the 11 kW minute is gone');
});

test('the chart is drawn with the hours it asked for, and only the newest answer counts', () => {
  const CHART = read('widgets', 'sensor-chart', 'public', 'index.html');
  assert.match(CHART, /var seq = \+\+reqSeq;/);
  assert.match(CHART, /if \(seq !== reqSeq\) return;/);
  assert.match(CHART, /renderChart\(bySlot\.filter\(function\(x\) \{ return x; \}\)\.length \? bySlot : \[\], h\)/);
  // the stepper waits for the steps to settle before it asks
  assert.match(CHART, /stepTimer = setTimeout\(function\(\) \{ load\(\); resetPoll\(\); \}, 250\);/);
  // any one series starts the chart, and the payload's ready flag is honoured
  assert.match(CHART, /if \(!s\.some\(function\(x\) \{ return x\.id; \}\)\)/);
  assert.match(CHART, /if \(data\.ready === false\)/);
});

test('the chart writes dates as the dashboard language does, on the axis and the marker alike', () => {
  const CHART = read('widgets', 'sensor-chart', 'public', 'index.html');
  const ctx = { activeLang: 'de' };
  vm.createContext(ctx);
  vm.runInContext(fnSource(CHART, 'fmtDay') + fnSource(CHART, 'fmtTime'), ctx);
  const oct9 = new Date(2026, 9, 9, 14, 0).getTime();
  assert.match(vm.runInContext(`fmtTime(${oct9}, 72)`, ctx), /^9\.10\.? 14:00$/);
  assert.match(CHART, /var mdLbl = fmtDay\(md\.getTime\(\)\);/);
  assert.ok(!/\(d\.getMonth\(\) \+ 1\) \+ '\.' \+ d\.getDate\(\)/.test(CHART), 'month.day is back');
});

test('the series picker shows a power reading with one unit', async () => {
  const app = Object.create(App.prototype);
  let handler = null;
  app.log = () => {}; app.error = () => {};
  app.homey = {
    i18n: { getLanguage: () => 'de' },
    dashboards: { getWidget: () => ({ registerSettingAutocompleteListener: (k, fn) => { handler = fn; } }) },
    drivers: { getDrivers: () => ({ d: { getDevices: () => [{
      getId: () => 'x', getName: () => 'WR', getCapabilities: () => ['measure_power'],
      getCapabilityValue: () => 2300, getCapabilityOptions: () => ({ title: { en: 'Power', de: 'Leistung' } }),
    }] } }) },
  };
  app._registerSensorChartAutocomplete();
  const [entry] = await handler('');
  assert.strictEqual(entry.description, '2.3 kW');
  assert.strictEqual(entry.name, 'WR · Leistung', 'the capability title is not in the dashboard language');
});

// ── 8: battery status ──────────────────────────────────────────────────────────────────

test('the battery widget gets Huawei\'s state words as keys it translates', () => {
  const { statusKey } = require('../widgets/battery-status/api.js');
  assert.strictEqual(statusKey('Running', 1200), 'charging', '"Running" says nothing of the direction');
  assert.strictEqual(statusKey('Running', -900), 'discharging');
  assert.strictEqual(statusKey('Running', 10), 'standby');
  assert.strictEqual(statusKey('Sleep mode', 0), 'sleep');
  assert.strictEqual(statusKey('Fault', 0), 'fault');
  assert.strictEqual(statusKey('Float charging', 300), 'charging');
  assert.strictEqual(statusKey(null, -900), 'discharging');
  assert.strictEqual(statusKey(null, null), null);
  assert.strictEqual(statusKey('Status 7', 0), 'Status 7', 'an unknown word goes out as it came');

  const html = read('widgets', 'battery-status', 'public', 'index.html');
  for (const k of ['running', 'offline', 'fault', 'sleep', 'starting', 'off', 'testing']) {
    assert.strictEqual((html.match(new RegExp(`\\b${k}: '`, 'g')) || []).length >= 3, true, `${k} is not translated in all three languages`);
  }
});

// ── 9: EMS battery widget ───────────────────────────────────────────────────────────────

test('the stop field says why a value was refused, and sends each value once', () => {
  const html = read('widgets', 'ems-battery', 'public', 'index.html');
  assert.strictEqual((html.match(/aboveRamp: '[^']*\{max\}/g) || []).length, 3, 'the limit in all three languages');
  assert.match(html, /if \(res && res\.error\) \{ rollback\(\); flashError\(errorText\(res\)\); return; \}/);
  assert.match(html, /if \(v === prev \|\| v === lastCommitted\) return;/, 'Enter and the blur after it both write');
  assert.ok(!/commitReserve/.test(html), 'the dead reserve handler is back');
  assert.ok(!/markerReserve/.test(html));
});

// ── 11: EMS forecast ─────────────────────────────────────────────────────────────────────

test('the forecast widget tells a Solcast error from a missing configuration', () => {
  const html = read('widgets', 'ems-forecast', 'public', 'index.html');
  assert.match(html, /if \(!pv \|\| !pv\.configured \|\| \(pv\.error && !future\.length\)\)/);
  assert.match(html, /\(pv && pv\.configured\) \? T\.solarError : T\.notConfiguredSolar/);
  assert.match(html, /if \(mode === 'zones'\)/, 'tariff zones fall into the forecast branch again');
  assert.match(html, /price\.configured === false/);
  assert.strictEqual((html.match(/solarError:/g) || []).length, 3);
  assert.strictEqual((html.match(/priceModeZones:/g) || []).length, 3);
});

test('a stale PV forecast has no figure for now in the widget payload', () => {
  const pv = require('../lib/ems/pvForecast.js');
  const d = Object.assign({
    _getConfig: () => ({ pv_forecast_enabled: true, solcast_api_key: 'k', solcast_resource_id: 'r' }),
    homey: { clock: { getTimezone: () => 'UTC' } },
  }, pv);
  d._pvForecast = [{ end: Date.now() + 3600e3, kw: 2, h: 0.5 }];
  d._pvForecastFetchedAt = Date.now() - 48 * 3600e3;
  const out = d.getPvForecast();
  assert.strictEqual(out.stale, true);
  assert.strictEqual(out.nowKw, null);
  assert.strictEqual(out.remainingTodayKwh, null);
  assert.strictEqual(d._pvForecastSummary().nowKw, 0, 'the summary keeps its numbers for the flow tokens');
});

// ── 12: EMS history ──────────────────────────────────────────────────────────────────────

const HIST = read('widgets', 'ems-history', 'public', 'index.html');

function histContext(lang) {
  const ctx = { navigator: { language: 'en-US' } };
  vm.createContext(ctx);
  const modeDots = HIST.match(/var MODE_DOTS = \{[\s\S]*?\};/)[0];
  const extract  = HIST.match(/var EXTRACT_MODES = \{[^}]*\};/)[0];
  vm.runInContext([dictsSource(HIST), fnSource(HIST, 'dictFor'), modeDots, extract,
    fnSource(HIST, 'fmtStatusDetail'), fnSource(HIST, 'eventInfo'), `var T = dictFor('${lang}');`].join('\n'), ctx);
  return ctx;
}

test('every EMS history event gets its own words', () => {
  const ctx = histContext('de');
  const info = (type, event, label) => vm.runInContext(`eventInfo(${JSON.stringify({ type, event, label })})`, ctx);
  assert.strictEqual(info('system', 'forecast_gate_on').label, 'Prognose-Sperre aktiv', 'was "App gestartet"');
  assert.strictEqual(info('system', 'forecast_gate_off').label, 'Prognose-Sperre aufgehoben');
  assert.strictEqual(info('system', 'app_start').label, 'App gestartet');
  assert.strictEqual(info('device', 'manual_on', 'Boiler').detail, 'ausserhalb des EMS eingeschaltet', 'was "EMS gestoppt"');
  assert.strictEqual(info('device', 'manual_off', 'Boiler').detail, 'ausserhalb des EMS ausgeschaltet');
  assert.strictEqual(info('device', 'start_no_effect', 'Pool').detail, 'gestartet, aber ohne Wirkung');
  assert.strictEqual(info('device', 'stop', 'Pool').detail, 'EMS gestoppt');
  assert.strictEqual(info('charger', 'target_reached', 'Q4').label, 'Ladeziel erreicht', 'was the raw key');
  assert.strictEqual(info('charger', 'target_released', 'Q4').label, 'Ladeziel aufgehoben');
});

test('the English and Dutch stop warnings are each in their own language again', () => {
  assert.match(histContext('en').T.stopIneffective, /no effect/);
  assert.match(histContext('nl').T.stopIneffective, /geen effect/);
});

test('the EMS history mode words are the settings page\'s words', () => {
  for (const l of ['en', 'de', 'nl']) {
    const settings = require(`../locales/${l}.json`).settings.histMode;
    const modes = histContext(l).T.modes;
    for (const [snake, word] of Object.entries(modes)) {
      const camel = snake.replace(/_([a-z])/g, (m, c) => c.toUpperCase());
      const expected = settings[snake] ?? settings[camel];
      if (expected !== undefined) assert.strictEqual(word, expected, `${l} ${snake}`);
    }
  }
});

test('EMS history days are calendar days, also across a clock change', () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fnSource(HIST, 'dayStart') + fnSource(HIST, 'dayEnd'), ctx);
  const start1 = new Date(vm.runInContext('dayStart(1)', ctx));
  const start3 = new Date(vm.runInContext('dayStart(3)', ctx));
  assert.strictEqual(start1.getHours(), 0);
  assert.strictEqual(start3.getHours(), 0);
  assert.strictEqual(vm.runInContext('dayEnd(1)', ctx), vm.runInContext('dayStart(0)', ctx) - 1);
  assert.ok(!/- offset \* 86400000/.test(HIST));
});

test('the EMS history fetches only what is new, and the dead time-window setting is gone', async () => {
  const api = require('../widgets/ems-history/api.js');
  const ev = [{ ts: 100, type: 'mode', event: 'idle' }, { ts: 200, type: 'mode', event: 'holding' }];
  const homey = { i18n: { getLanguage: () => 'de' },
    drivers: { getDriver: () => ({ getDevices: () => [{ getEmsHistory: () => ev.map((e) => ({ ...e })) }] }) } };
  const all = await api.getHistory({ homey, query: {} });
  assert.strictEqual(all.events.length, 2);
  assert.strictEqual(all.full, true);
  const since = await api.getHistory({ homey, query: { since: '100' } });
  assert.deepStrictEqual(since.events.map((e) => e.ts), [200]);
  assert.strictEqual(since.full, false);
  assert.strictEqual(since.newestTs, 200);
  const none = await api.getHistory({ homey: { i18n: homey.i18n, drivers: { getDriver: () => ({ getDevices: () => [] }) } }, query: {} });
  assert.strictEqual(none.error, 'no_ems_device', 'an English sentence on a German dashboard');

  const app = require('../app.json');
  assert.deepStrictEqual(app.widgets['ems-history'].settings, []);
});

// ── 13: midnight on the two days a year that are not 24 hours long ──────────────────────

test('the next local midnight is the real one on both clock-change days', () => {
  const L = require('../lib/local-time');
  const tz = 'Europe/Zurich';
  const h = (from) => (L.nextLocalMidnight(tz, Date.parse(from)) - Date.parse(from)) / 3600e3;
  assert.strictEqual(h('2026-10-25T00:00:05+02:00'), 25 - 5 / 3600, 'the 25-hour day in October');
  assert.strictEqual(h('2026-03-29T00:00:05+01:00'), 23 - 5 / 3600, 'the 23-hour day in March');
  assert.strictEqual(h('2026-07-01T23:30:00+02:00'), 0.5);
  assert.strictEqual(L.startOfLocalDay(tz, Date.parse('2026-10-25T20:00:00+01:00')), Date.parse('2026-10-25T00:00:00+02:00'));
  // A wall time whose first guess lands on the other side of the change needs the second
  // look at the offset: 01:30 on the long day is still summer time.
  assert.strictEqual(L.localToEpoch(tz, 2026, 10, 25, 1, 30), Date.parse('2026-10-25T01:30:00+02:00'));

  const app = Object.create(App.prototype);
  app.homey = { clock: { getTimezone: () => tz } };
  const at = Date.parse('2026-10-25T00:00:05+02:00');
  assert.strictEqual(at + app._msUntilLocalMidnight(at), Date.parse('2026-10-26T00:00:05+01:00'),
    'the baseline timer fires at 23:00:05 on the 25-hour day again');

  const pv = require('../lib/ems/pvForecast.js');
  assert.strictEqual(pv._pvMsUntilLocalMidnight(Date.parse('2026-03-29T00:00:00+01:00'), tz), 23 * 3600e3);
  const price = require('../lib/ems/priceForecast.js');
  const d = Object.assign({}, pv, price);
  assert.strictEqual(d._priceForecastAnchor(Date.parse('2026-10-25T20:00:00+01:00'), tz, 'this_day'),
    Date.parse('2026-10-25T00:00:00+02:00'), 'today\'s price slots start an hour off on the long day');
});
