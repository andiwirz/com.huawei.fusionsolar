'use strict';

// Unit tests for the app-level sensor-chart capability history.
// Run: node --test
//
// _pruneOrphanCapHistory DELETES persisted user data, so its guard rails (never prune
// on an incomplete device walk, never prune on an empty device list) are covered here
// deliberately — a regression would silently destroy recorded history.
//
// app.js requires the `homey` runtime module, which only exists on-device; stub it (and
// the two native-ish deps pulled in by lib/) before loading the app class.
const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { App: class {}, Device: class {}, Driver: class {} };
  if (request === 'jsmodbus' || request === 'ws') return {};
  return _origLoad.call(this, request, parent, isMain);
};

const test   = require('node:test');
const assert = require('node:assert');
const App    = require('../app.js');

// Minimal fake device: one recorded capability (measure_power) and one that must be
// ignored (onoff is not numeric / not "meaningful").
//
// getData().id deliberately differs from getId(). Series are keyed by the Homey device id
// because the app-minted one is shared by every OpenAPI device of a plant (issue #29), and
// a regression to it would make the keys below wrong here too, not only in
// test/sensor-chart-series.test.js.
function fakeDevice(id) {
  return {
    getId: () => id,
    getData: () => ({ id: `app-minted:${id}` }),
    getName: () => id,
    getCapabilities: () => ['measure_power', 'onoff'],
    getCapabilityValue: () => 1234.567,
  };
}

function makeApp({ devices = [], throwOnDriver = false, stored = {} } = {}) {
  const settings = { ...stored };
  const app = Object.create(App.prototype);
  app._capHistory = new Map();
  app._capHistoryInited = true;
  app.log = () => {};
  app.error = () => {};
  app.homey = {
    settings: {
      get:     (k) => settings[k],
      set:     (k, v) => { settings[k] = v; },
      unset:   (k) => { delete settings[k]; },
      getKeys: () => Object.keys(settings),
    },
    drivers: {
      getDrivers: () => ({
        d1: { getDevices: () => { if (throwOnDriver) throw new Error('driver not ready'); return devices; } },
      }),
    },
  };
  return { app, settings };
}

// ── orphan cleanup ───────────────────────────────────────────────────────────
test('_loadCapHistory — removes persisted series whose device is no longer paired', () => {
  const { app, settings } = makeApp({
    devices: [fakeDevice('alive')],
    stored: {
      'sch_hist_alive::measure_power':   [[1000, 1], [2000, 2]],
      'sch_hist_removed::measure_power': [[1000, 9]],
      'sch_hist_gone::measure_power':    [[1000, 9]],
      ems_config: { keep: true },
    },
  });
  app._loadCapHistory();
  assert.ok(!('sch_hist_removed::measure_power' in settings));
  assert.ok(!('sch_hist_gone::measure_power' in settings));
  assert.ok('sch_hist_alive::measure_power' in settings);       // still paired → kept
  assert.deepStrictEqual(settings.ems_config, { keep: true });   // unrelated keys untouched
  assert.strictEqual(app._capHistory.get('alive::measure_power').length, 2);
});

test('_loadCapHistory — never prunes when a driver lookup threw (device list incomplete)', () => {
  // A driver that fails to enumerate would make every one of its devices look orphaned.
  const { app, settings } = makeApp({
    devices: [fakeDevice('alive')], throwOnDriver: true,
    stored: { 'sch_hist_alive::measure_power': [[1000, 1]] },
  });
  app._loadCapHistory();
  assert.ok('sch_hist_alive::measure_power' in settings);
});

test('_loadCapHistory — never prunes when no devices are paired at all', () => {
  // Far more likely a startup-timing artefact than the user removing every device.
  const { app, settings } = makeApp({
    devices: [],
    stored: { 'sch_hist_alive::measure_power': [[1000, 1]] },
  });
  app._loadCapHistory();
  assert.ok('sch_hist_alive::measure_power' in settings);
});

// ── numeric timestamps (memory: ~55% smaller than the old ISO strings) ───────
test('_snapshotAllCaps — stores epoch ms, not an ISO string, and skips non-numeric caps', () => {
  const { app } = makeApp({ devices: [fakeDevice('alive')] });
  app._snapshotAllCaps();
  assert.strictEqual(app._capHistory.size, 1); // 'onoff' ignored
  const pt = app._capHistory.get('alive::measure_power')[0];
  assert.strictEqual(typeof pt.t, 'number');
});

test('capability history survives a save/load round-trip with numeric timestamps', () => {
  const { app, settings } = makeApp({ devices: [fakeDevice('alive')] });
  app._snapshotAllCaps();
  const original = app._capHistory.get('alive::measure_power')[0];
  app._saveCapHistory();

  const persisted = settings['sch_hist_alive::measure_power'];
  assert.ok(Array.isArray(persisted[0]));            // compact [ms, value] pairs
  assert.strictEqual(typeof persisted[0][0], 'number');

  const { app: app2 } = makeApp({ devices: [fakeDevice('alive')], stored: settings });
  app2._loadCapHistory();
  const restored = app2._capHistory.get('alive::measure_power')[0];
  assert.strictEqual(typeof restored.t, 'number');
  assert.strictEqual(restored.t, original.t);
});

test('getSensorChartData — filters on the numeric timestamp and stays widget-compatible', () => {
  const { app } = makeApp({ devices: [fakeDevice('alive')] });
  const now = Date.now();
  app._capHistory.set('alive::measure_power', [
    { t: now - 48 * 3600_000, v: 1 }, // outside a 24 h window
    { t: now - 1 * 3600_000,  v: 2 },
  ]);
  const out = app.getSensorChartData({ s1: 'alive::measure_power', hours: 24 });
  assert.strictEqual(out.series[0].points.length, 1);
  assert.strictEqual(out.series[0].points[0].v, 2);
  // The chart renderer does `new Date(p.t).getTime()`, which must still round-trip.
  assert.strictEqual(new Date(out.series[0].points[0].t).getTime(), out.series[0].points[0].t);
});

test('_saveCapHistory — rounds values but leaves the timestamp untouched', () => {
  const { app, settings } = makeApp({ devices: [fakeDevice('alive')] });
  app._capHistory.set('alive::measure_power', [{ t: 1754400000000, v: 1234.5678 }]);
  app._saveCapHistory();
  assert.deepStrictEqual(settings['sch_hist_alive::measure_power'], [[1754400000000, 1234.57]]);
});

// ── Modbus register map: guards against a known cross-device copy-paste ──────
// EMMA and the SmartCharger both use address 30508 for completely different things:
//   SmartCharger address space → CHARGER_TEMPERATURE   (I32, gain 10, °C)
//   EMMA address space         → EXTERNAL_METER_LINE_VOLTAGE_A_B (U32, gain 100, V)
// The EMMA map once carried the charger's temperature definition verbatim, so the
// sun2000_emma_modbus driver reported a ~400 V line voltage as "4000 °C".
// Verified against wlcrs/huawei-solar-lib registers.py.
const REG = require('../lib/modbus-registers.js');

test('EMMA register map does not claim address 30508 (it is a line voltage there, not a temperature)', () => {
  for (const [name, def] of Object.entries(REG.EMMA_REGISTERS)) {
    assert.notStrictEqual(def[0], 30508,
      `EMMA_REGISTERS.${name} points at 30508, which is EXTERNAL_METER_LINE_VOLTAGE_A_B on EMMA`);
  }
});

test('EMMA exposes no inverter temperature at all', () => {
  const names = [...Object.keys(REG.EMMA_REGISTERS), ...Object.keys(REG.SUN2000_EMMA_DATA_REGISTERS)];
  assert.deepStrictEqual(names.filter((n) => /temperature/i.test(n)), []);
});

test('the SmartCharger map keeps 30508 as its temperature (that one is correct)', () => {
  assert.deepStrictEqual(REG.SMARTCHARGER_REGISTERS.chargerTemperature.slice(0, 3), [30508, 2, 'INT32']);
});

// ── ems_set_car_target matching ──────────────────────────────────────────────
// This card is shared by several flows at once (the generated "Set charge 80/90/100%"
// ones differ only in target_pct), so unlike every other EMS trigger it needs a matcher.
// It was registered twice — once here in the app, once in the EMS device — which Homey
// reported on every start as "Run listener was already registered". The two disagreed
// about a blank filter, so which one won decided whether a hand-built flow fired.
const CAR = 'car-uuid-1';

test('matchCarTarget — a per-value flow fires only for its own target', () => {
  const state = { car_device_id: CAR, target_pct: '80' };
  assert.strictEqual(App.matchCarTarget({ car_device_id: CAR, target_pct: '80' }, state), true);
  assert.strictEqual(App.matchCarTarget({ car_device_id: CAR, target_pct: '90' }, state), false);
  assert.strictEqual(App.matchCarTarget({ car_device_id: CAR, target_pct: '100' }, state), false);
});

test('matchCarTarget — a blank filter matches any target, as the argument label promises', () => {
  // app.json: "Target charge (%) filter — leave empty for any". The device's copy compared
  // '' against '80' and returned false, so this flow never ran.
  const state = { car_device_id: CAR, target_pct: '80' };
  for (const blank of ['', '   ', null, undefined]) {
    assert.strictEqual(App.matchCarTarget({ car_device_id: CAR, target_pct: blank }, state), true,
      `a filter of ${JSON.stringify(blank)} must match any target`);
  }
});

test('matchCarTarget — another car never matches, whatever the filter says', () => {
  const state = { car_device_id: CAR, target_pct: '80' };
  assert.strictEqual(App.matchCarTarget({ car_device_id: 'other-car', target_pct: '80' }, state), false);
  assert.strictEqual(App.matchCarTarget({ car_device_id: 'other-car', target_pct: '' }, state), false);
});

test('matchCarTarget — surrounding whitespace in a pasted filter is tolerated', () => {
  // The argument is a text field the user types into, and the ids get pasted from the
  // settings page, so a stray space must not silently stop a flow from firing.
  const state = { car_device_id: CAR, target_pct: '80' };
  assert.strictEqual(App.matchCarTarget({ car_device_id: CAR, target_pct: ' 80 ' }, state), true);
});

test('matchCarTarget — a number in either place still matches its string form', () => {
  // The state is built with String(), but nothing stops a caller passing a number.
  assert.strictEqual(App.matchCarTarget({ car_device_id: CAR, target_pct: 80 }, { car_device_id: CAR, target_pct: '80' }), true);
  assert.strictEqual(App.matchCarTarget({ car_device_id: CAR, target_pct: '80' }, { car_device_id: CAR, target_pct: 80 }), true);
});

test('the run listener is registered in exactly one place', () => {
  const fs = require('fs');
  const inApp = (fs.readFileSync('app.js', 'utf8').match(/getTriggerCard\('ems_set_car_target'\)\s*\.registerRunListener/g) || []).length;
  const inDev = (fs.readFileSync('drivers/energy_management/device.js', 'utf8')
    .match(/getTriggerCard\('ems_set_car_target'\)\s*[\s\S]{0,40}registerRunListener/g) || []).length;
  assert.strictEqual(inApp, 1, 'app.js must register it once');
  assert.strictEqual(inDev, 0, 'the EMS device must not register it again');
});

// ── log timestamps ───────────────────────────────────────────────────────────
// Homey stamps its own lines in UTC with milliseconds. Neither serves the person reading
// their own log, so every buffered line is restamped in the Homey's own zone, to the
// second. Done at capture rather than at render so the Copy button hands over exactly
// what was on screen.
function logApp(timezone = 'Europe/Zurich') {
  const app = Object.create(App.prototype);
  app._appLogBuffer = [];
  app.homey = { clock: { getTimezone: () => timezone } };
  return app;
}

test('_pushAppLog — replaces Homey\'s UTC stamp with local time, no milliseconds', () => {
  const app = logApp();
  app._pushAppLog('2026-08-15T08:06:34.144Z [modbus] batch 32064/11 failed', 'log');
  const line = app._appLogBuffer[0].line;
  // 08:06 UTC is 10:06 in Zurich in August (CEST, UTC+2).
  assert.match(line, /^2026-08-15 10:06:34 \[modbus\] batch 32064\/11 failed$/, line);
  assert.ok(!line.includes('.144'), 'milliseconds must be gone');
  assert.ok(!line.includes('Z'), 'the UTC marker must be gone');
});

test('_pushAppLog — a line Homey did not stamp gets one too', () => {
  const app = logApp();
  app._pushAppLog('[modbus] read plan from 30000', 'log');
  assert.match(app._appLogBuffer[0].line, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[modbus\] read plan from 30000$/);
});

test('_pushAppLog — the stamp follows the Homey\'s configured zone', () => {
  const utc = logApp('UTC');
  utc._pushAppLog('2026-08-15T08:06:34.144Z x', 'log');
  assert.match(utc._appLogBuffer[0].line, /^2026-08-15 08:06:34 x$/);

  const tokyo = logApp('Asia/Tokyo');
  tokyo._pushAppLog('2026-08-15T08:06:34.144Z x', 'log');
  assert.match(tokyo._appLogBuffer[0].line, /^2026-08-15 17:06:34 x$/);
});

test('_pushAppLog — never throws, whatever the clock does', () => {
  // Logging must not be able to crash the app: a line can arrive before the clock is up,
  // or with a zone Intl does not know.
  for (const clock of [undefined, { getTimezone: () => 'Not/AZone' }, { getTimezone() { throw new Error('nope'); } }]) {
    const app = Object.create(App.prototype);
    app._appLogBuffer = [];
    app.homey = clock ? { clock } : {};
    assert.doesNotThrow(() => app._pushAppLog('2026-08-15T08:06:34.144Z x', 'log'));
    const line = app._appLogBuffer[0].line;
    assert.match(line, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} x$/, 'still stamped, still no ms: ' + line);
  }
});

test('_pushAppLog — a message that merely contains an ISO date is not mangled', () => {
  const app = logApp('UTC');
  app._pushAppLog('2026-08-15T08:06:34.144Z [EMS] forecast slot 2026-08-16T04:00:00.000Z is next', 'log');
  assert.match(app._appLogBuffer[0].line,
    /^2026-08-15 08:06:34 \[EMS\] forecast slot 2026-08-16T04:00:00\.000Z is next$/,
    'only the LEADING stamp may be replaced');
});

// ── the `holding` mode must not name a reason it does not always have ────────
// Three situations end up in this mode: no surplus at all, the solar-forecast gate holding
// starts back, and a car sitting at its charge target waiting to be unplugged. The status
// text carries which one; the mode label used to claim "no surplus" for all three, which
// produced this line in the field on 2026-08-17:
//
//   Prognose-Sperre · Batterie wird geschont · Bat 55% ↑1162W — Wartet — kein Überschuss
//
// The battery was charging at 1162 W. There was surplus, and the label said otherwise.
test('the holding mode label states no reason — the status text carries it', () => {
  const fs = require('fs');
  const appJson = JSON.parse(fs.readFileSync('app.json', 'utf8'));
  const titles = [];
  const holdingTitle = appJson.capabilities.ems_mode.values.find((v) => v.id === 'holding').title;
  titles.push(holdingTitle);
  // The same id appears again as a flow-card argument label — both have to stay neutral.
  const found = JSON.stringify(appJson).split('"id":"holding"').length - 1;
  assert.ok(found >= 2, `expected the holding id in the capability AND a flow card, found ${found}`);

  for (const lang of ['en', 'de', 'nl']) {
    const loc = JSON.parse(fs.readFileSync(`locales/${lang}.json`, 'utf8'));
    titles.push({ [lang]: loc.settings.histMode.holding });
  }
  const words = /surplus|Überschuss|overschot|unplug|abstecken|forecast|Prognose/i;
  for (const t of titles) {
    for (const [lang, text] of Object.entries(t)) {
      assert.ok(!words.test(text),
        `${lang} holding label "${text}" names one of the three reasons — it fits all three or none`);
    }
  }
});

// ── the live EMS strip ───────────────────────────────────────────────────────
// A compact line at the top of the EMS tab: mode, PV, grid direction, battery, and
// (1.2.175) the remaining forecast for today. Its labels are the only part a unit test can
// reach — a missing one renders as the raw key, e.g. "settings.live.forecast 2.2 kWh".
test('the live strip can name every figure it shows, in all three locales', () => {
  const fs = require('fs');
  const html = fs.readFileSync('settings/index.html', 'utf8');
  const body = html.slice(html.indexOf('function emsLiveRefresh'));
  const used = [...new Set([...body.slice(0, 2500).matchAll(/settings\.live\.(\w+)/g)].map((m) => m[1]))];
  assert.ok(used.includes('forecast'), 'the strip should be reading the forecast label');

  for (const lang of ['en', 'de', 'nl']) {
    const live = JSON.parse(fs.readFileSync(`locales/${lang}.json`, 'utf8')).settings.live;
    for (const key of used) {
      assert.ok(live[key] && live[key].trim(), `${lang}: settings.live.${key} missing`);
    }
  }
});

// The strip must not print a forecast the EMS would refuse to act on: a stale forecast
// makes _pvForecastRemainingTodayKwh answer 0, and "0 kWh" on a sunny morning reads as a
// measurement rather than as the absence of one.
test('the live strip shows the forecast only when it is configured and fresh', () => {
  const fs = require('fs');
  const html = fs.readFileSync('settings/index.html', 'utf8');
  const body = html.slice(html.indexOf('function emsLiveRefresh'));
  const line = body.slice(0, 2500).split('\n').find((l) => /settings\.live\.forecast/.test(l));
  assert.ok(line, 'forecast line not found');
  const guard = body.slice(0, body.indexOf(line));
  assert.match(guard.slice(-400), /d\.pv\.configured/, 'no configured check');
  assert.match(guard.slice(-400), /!d\.pv\.stale/, 'no staleness check');
});

// ── the two announcement thresholds have no field, so they must have a sentence ──
// ems_battery_low / _full kept firing at their defaults (80 % / 95 %) after the SOC-zone
// inputs were removed in 1.2.108. With a surplus ramp configured they stop nothing — the
// ramp's lower point does — yet the history renders "53% < 80% — Batterie tief", which
// reads like a limit. Naming them in the settings is the only thing standing between the
// reader and that misreading, so it is worth a test.
test('the battery announcement thresholds are named in all three locales', () => {
  const fs = require('fs');
  const html = fs.readFileSync('settings/index.html', 'utf8');
  assert.match(html, /ems-battery-announce-note/, 'the note element is gone');
  assert.match(html, /shareRamp\.' \+ key/, 'nothing reads the note text');
  // Two sentences: with a ramp the cards follow its points, without one they are leftovers
  // from the SOC zones and the note has to say so rather than implying a relationship.
  assert.match(html, /a\.source === 'ramp' \? 'announceNote' : 'announceNoteLegacy'/,
    'the note no longer distinguishes a derived threshold from a leftover one');

  for (const lang of ['en', 'de', 'nl']) {
    const ramp = JSON.parse(fs.readFileSync(`locales/${lang}.json`, 'utf8'))
      .settings.homeBatteries.shareRamp;
    for (const k of ['announceNote', 'announceNoteLegacy']) {
      assert.ok(ramp[k] && ramp[k].trim(), `${lang}: ${k} missing`);
      assert.match(ramp[k], /\{low\}/, `${lang}: ${k} lost {low}`);
      assert.match(ramp[k], /\{full\}/, `${lang}: ${k} lost {full}`);
    }
  }
});

// ── the adjustment-interval hint quotes a constant ───────────────────────────
// The field only governs stepping UP; stepping down is immediate, and every step down
// locks stepping up for FLIP_COOLDOWN_MS. Asked about directly ("Geht es nur um das
// Erhöhen? Was passiert bzgl. reduzieren?"), so the hint now says all three things — and
// the third one names a number that lives in code. If the constant moves, the hint lies.
test('the charger adjustment hint agrees with FLIP_COOLDOWN_MS', () => {
  const fs = require('fs');
  const { FLIP_COOLDOWN_MS } = require('../lib/ems/constants');
  const minutes = FLIP_COOLDOWN_MS / 60000;
  assert.strictEqual(minutes, 5, 'FLIP_COOLDOWN_MS changed — update the hint in all three locales');

  for (const lang of ['en', 'de', 'nl']) {
    const hint = JSON.parse(fs.readFileSync(`locales/${lang}.json`, 'utf8'))
      .settings.chargers.adjustmentIntervalHint;
    // Plain string checks, no regex: a backslash class built through a template literal
    // silently collapsed to nothing here once already ("\s" became "s").
    const statesLockout = hint.includes(`${minutes} min`) || hint.includes(`${minutes} Min`);
    assert.ok(statesLockout, `${lang}: hint does not state the ${minutes}-minute lock-out`);
    // The half that prompted the question: nothing here should suggest the wait applies
    // in both directions.
    assert.match(hint, /(sofort|at once|direct)/i, `${lang}: hint does not say stepping down is immediate`);
  }
});

// ── the running session in the settings list ─────────────────────────────────
// It arrives with endedAt: null. new Date(null) is 1 Jan 1970 and would have printed it
// without complaining, and a CSV would have claimed the charge ended at export time.
test('the sessions list and its CSV handle a session with no end time', () => {
  const fs = require('fs');
  const html = fs.readFileSync('settings/index.html', 'utf8');

  const render = html.slice(html.indexOf('function emsSessionsRenderFiltered'),
                           html.indexOf('function emsSessionsExportCsv'));
  assert.match(render, /s\.endedAt \|\| Date\.now\(\)/, 'duration would be computed against null');
  assert.match(render, /s\.running/, 'nothing marks the running row');
  assert.match(render, /chargeSessions\.now/, 'no stand-in for the missing end time');

  const csv = html.slice(html.indexOf('function emsSessionsExportCsv'));
  assert.match(csv.slice(0, 2000), /s\.endedAt \? new Date\(s\.endedAt\)\.toISOString\(\) : ''/,
    'CSV would date an unfinished charge to the moment of export');

  // Open and drawing are two different things: the EMS holds the charger at zero between
  // two solar windows while the cable stays in. Reported from the field — the list said
  // "läuft" over a session that was paused at that moment.
  assert.match(render, /s\.charging !== false/, 'the row does not distinguish paused from charging');

  for (const lang of ['en', 'de', 'nl']) {
    const cs = JSON.parse(fs.readFileSync(`locales/${lang}.json`, 'utf8')).settings.chargeSessions;
    for (const k of ['running', 'paused', 'now']) {
      assert.ok(cs[k] && cs[k].trim(), `${lang}: settings.chargeSessions.${k} missing`);
    }
    assert.notStrictEqual(cs.running, cs.paused, `${lang}: the two states read the same`);
  }
});

// ── the build number in the footer and the export ────────────────────────────
// It was a literal typed into the HTML, and it stopped being true at 1.2.151 — three
// months and thirty releases before anyone looked. That would be cosmetic on its own, but
// the configuration export repeats it as its header, and the version is the one line in a
// bug report a reader trusts without checking.
test('the build number is read from the app, not typed into the page', () => {
  const fs = require('fs');
  const html = fs.readFileSync('settings/index.html', 'utf8');
  const version = JSON.parse(fs.readFileSync('app.json', 'utf8')).version;

  const span = /<span id="ems-build">([^<]*)<\/span>/.exec(html);
  assert.ok(span, 'the build span is gone');
  assert.ok(!/^\d+\.\d+\.\d+$/.test(span[1].trim()),
    `the footer carries the hard-coded version "${span[1]}" again — it will rot`);

  assert.match(html, /ems-build'\)\.textContent = _emsShareDiag\.appVersion/,
    'nothing fills the footer from the diagnostics');
  assert.match(html, /_emsShareDiag\.appVersion\) \|\| '\?'/,
    'the export header does not read the real version');

  // And the device actually reports it.
  const dev = fs.readFileSync('drivers/energy_management/device.js', 'utf8');
  assert.match(dev, /appVersion: this\.homey\.app\?\.manifest\?\.version/,
    'getEmsDiag does not report the app version');
  assert.ok(version, 'app.json has no version');
});

// ── what the configuration export lists under "devices" ──────────────────────
// It used to dump every paired device — 146 lines of other people's lamps on this
// installation — which buried the ten rows that matter and told a reader nothing they
// could act on. It now prints the EMS-steered devices with the measured value beside the
// believed one, which is where every fault found in the field this month actually lived.
test('the export lists steered devices with both columns, not the whole house', () => {
  const fs = require('fs');
  const html = fs.readFileSync('settings/index.html', 'utf8');
  const fn = html.slice(html.indexOf('function emsCopyConfig'), html.indexOf('function closeModal'));
  assert.ok(fn.length > 200, 'emsCopyConfig is gone');

  assert.match(fn, /diag && diag\.devices/, 'the export no longer reads the per-device diagnostics');
  assert.match(fn, /measured/, 'the measured column is missing');
  assert.match(fn, /r\.ems/, 'the believed column is missing');

  // _emsDevices may still be consulted — for names — but must not be enumerated into rows.
  assert.ok(!/_emsDevices\)\s*\|\|\s*\[\]\)\.map/.test(fn),
    'the full paired-device list is being dumped again');
});

// The device table is read as a table. Short kind names ("pool", "car") were padded with a
// fixed-length string and then sliced, which is a no-op when the string is already shorter
// — so those rows sat a column left of the others and the export looked broken.
test('the export pads the device columns instead of slicing a fixed string', () => {
  const fs = require('fs');
  const html = fs.readFileSync('settings/index.html', 'utf8');
  const fn = html.slice(html.indexOf('function emsCopyConfig'), html.indexOf('function closeModal'));
  assert.match(fn, /while \(s\.length < n\) s \+= ' ';/, 'no real padding helper');
  assert.ok(!/\(r\.kind \+ '\s+'\)\.slice/.test(fn), 'the fixed-string padding is back');
});

// ── can a tick be recomputed from the export alone? ──────────────────────────
// The point of the configuration export is that someone can replay a decision. Every
// figure the control loop branches on therefore has to leave the device as a value, not
// only inside a sentence: battery.powerW reached the diagnostics as an arrow in modeText
// ("↓859W"), which is prose. A reader could see what the EMS decided and not recompute it.
test('every reading the control loop branches on is reported as a value', () => {
  const fs = require('fs');
  const dev = fs.readFileSync('drivers/energy_management/device.js', 'utf8');
  for (const field of ['gridW', 'pvW', 'soc', 'houseW', 'batteryW']) {
    assert.match(dev, new RegExp(`_diag\.${field} = `), `_diag.${field} is never set`);
  }

  // batteryW specifically: the hard-stop overflow exception, the battery boost and the
  // discharge correction all read battery.powerW, so an export without it cannot decide
  // whether any of the three applied.
  const charger = fs.readFileSync('lib/ems/chargerControl.js', 'utf8');
  assert.ok(charger.split('battery.powerW').length - 1 >= 5,
    'battery.powerW stopped being load-bearing — this test may be over-specified now');
});

// The announcement thresholds are only worth deriving if the code that FIRES the
// announcements uses the derivation. device.js needs the homey module and never loads in
// the test process, so its wiring is checked by reading it.
test('_checkBatteryTriggers fires on the derived thresholds, not on the old fields', () => {
  const fs = require('fs');
  const dev = fs.readFileSync('drivers/energy_management/device.js', 'utf8');
  const start = dev.indexOf('async _checkBatteryTriggers');
  assert.ok(start > 0, '_checkBatteryTriggers is gone');
  const body = dev.slice(start, dev.indexOf('async _checkBatteryPriceControl'));

  assert.match(body, /_batteryAnnounceThresholds\(cfg\)/, 'it does not ask for the derived pair');
  assert.ok(!/cfg\.min_battery_soc|cfg\.battery_full_soc/.test(body),
    'it reads the old fields directly again, so a configured ramp would be ignored');
});

// ── a read-only button must not claim the form was edited ────────────────────
// Every button inside the EMS tab marks the form dirty, because adding or removing a
// device row fires no input event and a click is the only signal there is. Read-only
// actions get out of that rule by id, or by sitting inside a read-only section.
//
// "Copy configuration" sits in the save bar, outside every such section, and had no id at
// all — so opening it announced "Nicht gespeicherte Änderungen" over a page nobody had
// touched. A warning that cries wolf is worth less than no warning.
test('the copy-configuration button is exempt from the dirty rule', () => {
  const fs = require('fs');
  const html = fs.readFileSync('settings/index.html', 'utf8');

  assert.match(html, /id="ems-copy-config-btn"[^>]*onclick="emsCopyConfig\(\)"/,
    'the button has lost the id the exemption is keyed on');
  const list = /var EMS_NEUTRAL_BUTTONS = \[([^\]]*)\]/.exec(html);
  assert.ok(list, 'EMS_NEUTRAL_BUTTONS is gone');
  assert.match(list[1], /'ems-copy-config-btn'/, 'the button is not exempt');

  // The other read-only buttons are covered by their sections; if one of those is ever
  // renamed the same silent regression comes back through a different door.
  const sections = /var EMS_READONLY_SECTIONS = \[([^\]]*)\]/.exec(html);
  for (const id of ['ems-history-section', 'ems-sessions-section', 'ems-diag-section']) {
    assert.match(sections[1], new RegExp(`'${id}'`), `${id} is no longer treated as read-only`);
    assert.match(html, new RegExp(`id="${id}"`), `${id} no longer exists in the page`);
  }
});

// ── the ramp's share reaches the priority loop as a ceiling ──────────────────
// The behaviour is tested against _runPriorityLoop and the two evaluators in ems.test.js.
// What only device.js can get wrong is deriving the figure and handing it over, and device.js
// needs the `homey` module and never loads in the test process — mutation testing found the
// derivation silently removable otherwise.
test('the tick derives the ramp allowance from production and passes it down', () => {
  const fs  = require('fs');
  const dev = fs.readFileSync('drivers/energy_management/device.js', 'utf8');

  // From pvW, not from the meter: the share is a share of what the roof makes, and the
  // meter only shows what is left after everything has taken its part.
  assert.match(dev, /Math\.max\(0, Math\.round\(Math\.max\(0, pvW\) \* _share\)\)/,
    'the allowance is no longer derived from production');
  assert.match(dev, /_runPriorityLoop\(\s*\n?\s*battery, effectiveGridW, chargers, cfg, pvW, houseW, priorityOrder, simpleEval, rampAllowanceW,/,
    'the allowance never reaches the priority loop');
  // No ramp configured must stay null all the way down, not become 0 — 0 would stop
  // every device on installations that never asked for a share.
  assert.match(dev, /\(_share === null \|\| pvW === null\)\s*\n?\s*\? null/,
    'an absent ramp no longer yields null');
});

// ── the short hold on the battery state of charge ────────────────────────────
// Since an absent SoC holds the hard stop rather than releasing it, a single dropped
// reading would stop every controllable device for one tick and start them again on the
// next. _getBattery therefore keeps the last good figure for a minute, the same way
// _getGridW keeps the last grid reading — checked by reading device.js, which needs the
// `homey` module and never loads in the test process.
test('an unreadable state of charge falls back to the last one, briefly', () => {
  const fs = require('fs');
  const dev = fs.readFileSync('drivers/energy_management/device.js', 'utf8');
  const fn  = dev.slice(dev.indexOf('async _getBattery'), dev.indexOf('async _checkBatteryTriggers'));

  assert.match(fn, /this\._lastValidSoc\s+= soc;/, 'no good reading is ever remembered');
  assert.match(fn, /< BATTERY_SOC_HOLD_MS/, 'the fallback has no time limit, so a dead battery reads as full forever');
  // powerW must NOT be held: it feeds the ramp's discharge cap, where a stale value would
  // let the ramp keep lending against an absorption that has stopped.
  assert.ok(!/_lastValidPowerW/.test(fn), 'the battery power is being held too — that is the dangerous direction');

  const consts = require('../lib/ems/constants');
  assert.strictEqual(consts.BATTERY_SOC_HOLD_MS, 60_000);
});

// ── the confirmation time before reducing the charge current ─────────────────
// The behaviour is tested in test/ems.test.js against _stepCharger. What cannot be tested
// there is the plumbing on either side of it: device.js needs the `homey` module and never
// loads in the test process, and the settings page is not executed at all. Both are checked
// by reading them — mutation testing found each of these silently survivable otherwise.
test('the down-hold setting reaches the charger the tick reasons about', () => {
  const fs = require('fs');
  const dev = fs.readFileSync('drivers/energy_management/device.js', 'utf8');

  assert.match(dev, /stepDownHoldMs: Math\.max\(0, Number\(c\.step_down_hold_s\) \|\| 0\) \* 1000,/,
    'the configured value never becomes a figure _stepCharger can see');
  // 0 has to stay reachable — it is the default and it means "reduce immediately".
  assert.match(dev, /clamp\(c, 'step_down_hold_s', 0, 600\);/,
    'the clamp floor is not 0, so "reduce immediately" cannot be configured');
});

test('the settings page saves the down-hold, and keeps a deliberate zero', () => {
  const fs = require('fs');
  const html = fs.readFileSync('settings/index.html', 'utf8');

  assert.match(html, /dataset\.field = 'step_down_hold_s';/, 'the input is gone');
  assert.match(html, /c\.step_down_hold_s = \(isFinite\(downS\) && downS > 0\) \? downS : 0;/,
    'the value is not saved, or a zero no longer survives the save');
  assert.match(html, /downInput\.min = 0;/, 'the input will not accept "reduce immediately"');
});

test('both adjustment directions are labelled and explained in all three locales', () => {
  const fs = require('fs');
  for (const lang of ['en', 'de', 'nl']) {
    const c = JSON.parse(fs.readFileSync(`locales/${lang}.json`, 'utf8')).settings.chargers;
    assert.ok(c.adjustmentInterval, `adjustmentInterval missing in ${lang}`);
    assert.ok(c.adjustmentIntervalDown, `adjustmentIntervalDown missing in ${lang}`);
    // The hint used to promise that reducing happens "at once, with no wait". With a
    // configurable delay that is only true at 0, and the hint has to say so.
    assert.match(c.adjustmentIntervalHint, /↓/, `the ${lang} hint does not mention the down direction`);
  }
});

// ── the feed-in tariff on the settings page ──────────────────────────────────
// The field's empty state carries meaning: unset is "nobody has said what an exported kWh
// earns", zero is "it earns nothing". Every other price box may collapse an empty value to
// 0 — an unset price to PAY is 0 either way — but this one must not, or saving the page
// would silently claim the user exports for free.
test('the feed-in tariff keeps its empty state through a save', () => {
  const fs = require('fs');
  const html = fs.readFileSync('settings/index.html', 'utf8');

  assert.match(html, /id="ems-price-feed-in"/, 'the input is gone');
  assert.match(html, /price_feed_in: emsPriceFeedInValue\(\)/,
    'the value is collected some other way — check it still preserves empty');

  const fn = html.slice(html.indexOf('function emsPriceFeedInValue'), html.indexOf('function emsRenderPriceConfig'));
  assert.ok(fn.length > 50, 'emsPriceFeedInValue is gone');
  assert.match(fn, /if \(raw === ''\) return null;/, 'an empty box no longer stays empty');
  assert.match(fn, /n >= 0/, 'a negative tariff would turn sunny sessions into a profit');
  assert.ok(!/parseFloat\(document\.getElementById\('ems-price-feed-in'\)\.value\) \|\| 0/.test(html),
    'the `|| 0` pattern is back, which turns "not configured" into "earns nothing"');

  // And it survives the trip back into the form.
  assert.match(html, /ems-price-feed-in'\)\.value\s*=\s*\n?\s*\(pc\.price_feed_in === undefined \|\| pc\.price_feed_in === null\) \? '' : pc\.price_feed_in;/,
    'rendering an unset tariff does not leave the box empty');
});

test('the feed-in tariff is labelled and explained in all three locales', () => {
  const fs = require('fs');
  for (const lang of ['en', 'de', 'nl']) {
    const price = JSON.parse(fs.readFileSync(`locales/${lang}.json`, 'utf8')).settings.price;
    assert.ok(price.feedInPerKwh, `feedInPerKwh missing in ${lang}`);
    assert.ok(price.feedInHint, `feedInHint missing in ${lang}`);
    // The hint has to say what leaving it empty means, or the field looks like a bug.
    assert.ok(price.feedInHint.length > 80, `the ${lang} hint does not explain the empty case`);
  }
});

// ── the released surplus, logged beside the measured one ─────────────────────
// measure_solar_surplus is the meter reading. The share ramp lends the devices power the
// meter never sees, so on a ramp day the two figures differ by exactly the lent amount —
// and only the second one explains why a device was allowed to run. Both are logged so the
// gap between them can be read over the day.
test('the released surplus is a capability of its own, charted like the measured one', () => {
  const fs = require('fs');
  const appJson = JSON.parse(fs.readFileSync('app.json', 'utf8'));
  const cap = appJson.capabilities.measure_released_surplus;

  assert.ok(cap, 'measure_released_surplus is not defined');
  assert.strictEqual(cap.type, 'number');
  assert.strictEqual(cap.units.en, 'W');
  assert.strictEqual(cap.decimals, 0);
  assert.strictEqual(cap.setable, false, 'a reading must not be writable');
  // Without insights there is no history to look at, which is the entire point of it.
  assert.strictEqual(cap.insights, true, 'the released surplus is not charted');

  for (const lang of ['en', 'de', 'nl']) {
    assert.ok(cap.title[lang], `capability title missing for ${lang}`);
  }
  assert.ok(fs.existsSync(cap.icon.replace(/^\//, '')), `icon ${cap.icon} does not exist`);

  const drv = appJson.drivers.find((d) => d.id === 'energy_management');
  assert.ok(drv.capabilities.includes('measure_released_surplus'),
    'the EMS device does not carry the capability');
  for (const lang of ['en', 'de', 'nl']) {
    assert.ok(drv.capabilitiesOptions.measure_released_surplus.title[lang],
      `device tile title missing for ${lang}`);
  }
});

// The figure is spent as it is handed out: _runPriorityLoop lowers effectiveGridW with every
// allocation, so reading it after the loop records what is LEFT — near zero on exactly the
// busy days the chart is meant to explain.
test('the released surplus is recorded before the priority loop spends it', () => {
  const fs = require('fs');
  const dev = fs.readFileSync('drivers/energy_management/device.js', 'utf8');

  const set  = dev.indexOf("_set('measure_released_surplus', Math.max(0, Math.round(-effectiveGridW)))");
  const ramp = dev.indexOf('const _shareBudgetW = this._batteryShareBudgetW(');
  const loop = dev.indexOf('effectiveGridW = await this._runPriorityLoop(');

  assert.ok(set > 0, 'the released surplus is never published, or no longer from effectiveGridW');
  assert.ok(ramp > 0 && loop > 0, 'the tick no longer looks the way this test assumes');
  assert.ok(set > ramp, 'it is read before the ramp is added, so it would equal the meter reading');
  assert.ok(set < loop, 'it is read after the loop has spent it');
});

// Two branches hold all control and hand out nothing: EMS off / no API key, and a dead grid
// sensor. Neither used to touch the capability, which would leave the last live figure
// standing and draw a flat line at that height through the whole outage.
test('a held tick reports nothing released, rather than the last live figure', () => {
  const fs = require('fs');
  const dev = fs.readFileSync('drivers/energy_management/device.js', 'utf8');
  const zeroed = dev.split("_set('measure_released_surplus', 0)").length - 1;
  assert.strictEqual(zeroed, 2, 'expected both held branches to zero the released surplus');

  // And an existing device has to grow the capability on update, or it stays empty forever.
  const ensureAt = dev.indexOf('async _ensureCapabilities');
  assert.ok(ensureAt > 0, '_ensureCapabilities is gone');
  const ensure = dev.slice(ensureAt, dev.indexOf('// _offpeakWindow / _parseTime', ensureAt));
  assert.match(ensure, /'measure_released_surplus'/,
    'the capability is never added to devices that already exist');
});

// A pasted log is how a problem arrives from the field, and the first question about any log
// is which build produced it. Twice that had to be reconstructed from commit timestamps, and
// once the reconstruction led straight to a wrong conclusion about a feature that was fine.
test('the startup line names the version that is running', () => {
  const fs = require('fs');
  const src = fs.readFileSync('app.js', 'utf8');
  const at = src.indexOf('is running...');
  assert.ok(at > 0, 'the startup line is gone');

  // The whole statement, not one line: the version is read into a variable first, because
  // it has to survive a Homey that hands over no manifest at all.
  const block = src.slice(Math.max(0, at - 400), at + 60);
  assert.match(block, /manifest\.version/,
    'the startup line no longer says which version it is — read from the manifest, not a literal');
  assert.match(block, /\$\{version \?/,
    'the version is used unguarded — a missing manifest would throw inside onInit and the app would not start');
});
