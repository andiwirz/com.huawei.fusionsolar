'use strict';

// Widget review of 2026-10-09, part B on the app side (1.2.300): the right device, the
// missing sources, error codes instead of English sentences, and one copy of the shared
// helpers instead of twelve.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// drivers maps driverId -> capability values, or { caps, available } for reachability.
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
        return { getDevices: () => [{
          getCapabilityValue: (c) => (c in caps ? caps[c] : null),
          getAvailable: () => available,
          getSetting: () => null,
          getName: () => id,
        }] };
      },
    },
  };
}
const today = (tz = 'Europe/Zurich') => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const { getPowerData } = require('../lib/widget-data');

// ── 20: sources that were there and not read ────────────────────────────────────────────

test('an EMMA inverter without its meter device still gives the grid figure', () => {
  const d = getPowerData(fakeHomey({ sun2000_emma_modbus: { measure_power: 4000, 'measure_power.grid_active_power': -1500 } }));
  assert.strictEqual(d.gridPower, -1500);
  assert.strictEqual(d.housePower, 2500);
});

test('the cloud inverter gives the grid figure where no meter answers', () => {
  const d = getPowerData(fakeHomey({ sun2000_openapi_fusionsolar: { measure_power: 3000, 'measure_power.grid_active_power': 200 } }));
  assert.strictEqual(d.gridPower, 200);
});

test('a kiosk-only plant gets its PV figure in the live widgets, last in line', () => {
  assert.strictEqual(getPowerData(fakeHomey({ fusionsolar_kiosk: { measure_power: 5300 } })).pvPower, 5300);
  assert.strictEqual(getPowerData(fakeHomey({ fusionsolar_kiosk: { measure_power: 5300 }, sun2000_modbus: { measure_power: 5100 } })).pvPower, 5100,
    'the minutes-old kiosk won over the local inverter');
});

test('iSitePower has its day in the yield and balance widgets, from midnight baselines', async () => {
  const settings = {
    eb_pv_baseline:          { date: today(), baseline: 1000 },
    eb_house_baseline:       { date: today(), baseline: 500 },
    eb_grid_import_baseline: { date: today(), baseline: 200 },
    eb_grid_export_baseline: { date: today(), baseline: 0 },
  };
  const drivers = {
    isitepower_solar_openapi_fusionsolar: { meter_power: 1012.5 },
    isitepower_home_openapi_fusionsolar:  { meter_power: 509 },
    isitepower_grid_openapi_fusionsolar:  { meter_power: 202, 'meter_power.exported': 0 },
  };
  const yieldApi = require('../widgets/daily-yield/api.js');
  const y = await yieldApi.getData({ homey: fakeHomey(drivers, { settings }) });
  assert.strictEqual(y.dailyKwh, 12.5);
  assert.strictEqual(y.totalKwh, 1012.5);
  assert.ok(!('co2SavedKg' in y), 'the unread CO₂ figure with its fixed factor is back');

  const balance = require('../widgets/energy-balance/api.js');
  const b = await balance.getData({ homey: fakeHomey(drivers, { settings }) });
  assert.strictEqual(b.pvTodayKwh, 12.5);
  assert.strictEqual(b.gridImportKwh, 2);
  assert.strictEqual(b.houseConsumptionKwh, 9);
  assert.strictEqual(b.selfSufficiencyPct, 78);
});

test('the midnight baselines cover iSitePower too, in the widget\'s own order', () => {
  const Module = require('module');
  const orig = Module._load;
  Module._load = function (r, p, m) { if (r === 'homey') return { App: class {} }; return orig.call(this, r, p, m); };
  const App = require('../app.js');
  Module._load = orig;
  const app = Object.create(App.prototype);
  const settings = {};
  const homey = fakeHomey({
    isitepower_solar_openapi_fusionsolar: { meter_power: 1000 },
    isitepower_home_openapi_fusionsolar:  { meter_power: 500 },
    isitepower_grid_openapi_fusionsolar:  { meter_power: 200, 'meter_power.exported': 0 },
  }, { settings });
  app.homey = homey;
  app.log = () => {}; app.error = () => {};
  app._cap = (dev, c) => (dev ? dev.getCapabilityValue(c) : null);
  const r = app._saveMidnightBaseline();
  assert.deepStrictEqual(r.written, ['export', 'import']);
  assert.strictEqual(settings.eb_pv_baseline.baseline, 1000);
  assert.strictEqual(settings.eb_house_baseline.baseline, 500);
  assert.strictEqual(settings.eb_grid_import_baseline.baseline, 200);
});

// ── 17: the baseline hint only where a baseline is missing ──────────────────────────────

test('the energy balance says it waits for a baseline only when it does', async () => {
  const balance = require('../widgets/energy-balance/api.js');
  const waiting = await balance.getData({ homey: fakeHomey({ sun2000_modbus: { 'meter_power.grid_export': 10, 'meter_power.grid_import': 5 } }) });
  assert.strictEqual(waiting.awaitingBaseline, true);
  const kioskOnly = await balance.getData({ homey: fakeHomey({ fusionsolar_kiosk: { 'meter_power.daily': 20 } }) });
  assert.strictEqual(kioskOnly.awaitingBaseline, false, 'a plant with no grid counters at all saw the hint for good');
  assert.strictEqual(kioskOnly.pvTodayKwh, 20);
});

// ── 16: the battery that answers ─────────────────────────────────────────────────────────

test('the battery widget shows the battery that answers, and says when none does', async () => {
  const api = require('../widgets/battery-status/api.js');
  const both = await api.getData({ homey: fakeHomey({
    luna2000_modbus:              { caps: { measure_battery: 40, measure_power: 0 }, available: false },
    luna2000_openapi_fusionsolar: { measure_battery: 77, measure_power: 900 },
  }) });
  assert.strictEqual(both.soc, 77, 'the unreachable Modbus battery hid the cloud one');
  assert.strictEqual(both.unreachable, false);

  const gone = await api.getData({ homey: fakeHomey({ luna2000_modbus: { caps: { measure_battery: 40 }, available: false } }) });
  assert.strictEqual(gone.unreachable, true);
  assert.strictEqual(gone.paired, true);
  assert.strictEqual(gone.soc, null);
});

test('an EMMA battery hands over its own kWh to full and to empty — only while it answers', async () => {
  const api = require('../widgets/battery-status/api.js');
  const caps = { measure_battery: 50, measure_power: 2000,
    'meter_power.chargeable_capacity': 6.2, 'meter_power.dischargeable_capacity': 4.1 };
  const up = await api.getData({ homey: fakeHomey({ luna2000_emma_modbus: caps }) });
  assert.strictEqual(up.toFullKwh, 6.2);
  assert.strictEqual(up.toEmptyKwh, 4.1);
  const down = await api.getData({ homey: fakeHomey({ luna2000_emma_modbus: { caps, available: false } }) });
  assert.strictEqual(down.toFullKwh, null, 'an hour-old figure is not what is left now');
});

// ── 18: the charging sessions ────────────────────────────────────────────────────────────

test('the session list sends what is shown, and every session in progress', async () => {
  const api = require('../widgets/session-history/api.js');
  const done = Array.from({ length: 200 }, (_, i) => ({ chargerId: 'c', startedAt: 1000 + i, endedAt: 2000 + i, energyKwh: 1 }));
  const running = [
    { chargerId: 'a', running: true, charging: true,  startedAt: 5000, energyKwh: 2, carName: 'Q4' },
    { chargerId: 'b', running: true, charging: false, startedAt: 6000, energyKwh: 1, carName: 'ID.3' },
  ];
  const homey = { i18n: { getLanguage: () => 'de' }, drivers: { getDriver(id) {
    if (id !== 'energy_management') throw new Error('none');
    return { getDevices: () => [{ getEmsChargeSessions: () => [...running, ...done] }] };
  } } };
  const out = await api.getSessions({ homey });
  assert.ok(out.history.length <= 20, `${out.history.length} rows went out`);
  assert.strictEqual(out.currents.length, 2, 'the second charger running at the same time vanished');
  assert.strictEqual(out.currents[1].paused, true);
  assert.strictEqual(out.current.reason, out.currents[0].reason, 'an older widget build still gets current');
});

// ── 21/22: input checks and error codes ─────────────────────────────────────────────────

test('the EMS device endpoints check their input before asking the device', async () => {
  const api = require('../widgets/ems-device/api.js');
  let asked = 0;
  const ems = { setEmsDeviceEnabled: async () => { asked++; return { ok: true }; }, setEmsChargeNow: async () => { asked++; return { ok: true }; } };
  const homey = { i18n: { getLanguage: () => 'de' }, drivers: { getDriver: () => ({ getDevices: () => [ems] }) } };
  assert.deepStrictEqual(await api.setEnabled({ homey, body: { device: 'x' } }), { error: 'invalid_value' });
  assert.deepStrictEqual(await api.setEnabled({ homey, body: { device: 'x', enabled: 'false' } }), { error: 'invalid_value' });
  assert.deepStrictEqual(await api.setChargeNow({ homey, body: {} }), { error: 'invalid_value' });
  assert.strictEqual(asked, 0);
  assert.deepStrictEqual(await api.setEnabled({ homey, body: { device: 'x', enabled: false } }), { ok: true });
  assert.ok(!('getDevices' in api), 'the unrouted getDevices is back');
});

test('no endpoint answers with an English sentence where the widget expects a code', async () => {
  const none = { i18n: { getLanguage: () => 'de' }, drivers: { getDriver: () => { throw new Error('none'); } } };
  assert.strictEqual((await require('../widgets/charger-status/api.js').getStatus({ homey: none })).error, 'no_charger');
  assert.strictEqual((await require('../widgets/session-history/api.js').getSessions({ homey: none })).error, 'no_charger');
  assert.strictEqual((await require('../widgets/ems-history/api.js').getHistory({ homey: none, query: {} })).error, 'no_ems_device');
});

// ── 32: one copy of the shared helpers ──────────────────────────────────────────────────

test('the widget endpoints share one lang() and one EMS lookup', () => {
  const dirs = fs.readdirSync(path.join(ROOT, 'widgets'));
  assert.strictEqual(dirs.length, 12);
  for (const w of dirs) {
    const src = read('widgets', w, 'api.js');
    assert.ok(!/^function lang\(/m.test(src), `${w}/api.js carries its own lang() again`);
    assert.ok(!/^function getEmsDevice\(/m.test(src), `${w}/api.js carries its own getEmsDevice() again`);
  }
  assert.strictEqual(read('widgets', 'solar-power-flow', 'api.js'), read('widgets', 'netzampel', 'api.js'));
  assert.match(read('widgets', 'netzampel', 'api.js'), /return powerPayload\(homey\);/);
});
