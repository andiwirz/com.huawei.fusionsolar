'use strict';

// Two findings from the review of 2026-10-10 (1.2.319), both in the energy management.
//
//   1. A restart in the middle of a charge restored the session's total cost but not its two
//      halves (grid and solar): they were missing from the persisted fields, the first tick
//      afterwards added a price to undefined, and the session reached the log with grid and
//      solar at 0.00 beside a correct total.
//   2. A scheduled task ran only if a tick happened to land in its exact minute. A 60 s tick
//      that drifts steps over a minute now and then, and a slow or failed tick over several;
//      the task was then gone for the day.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const chargerStateMixin   = require('../lib/ems/chargerState');
const chargerMixin        = require('../lib/ems/chargerControl');
const chargeSessionsMixin = require('../lib/ems/chargeSessions');
const priceMixin          = require('../lib/ems/price');
const { CHARGER_STATE_KEY, CHARGER_STATE_MAX_GAP_MS, SCHEDULER_CATCHUP_MS } = require('../lib/ems/constants');

// ── 1. the cost split across a restart ─────────────────────────────────────────

const CH  = 'charger-1';
const T0  = 1_770_000_000_000;
const CFG = { price_config: { mode: 'fixed', price_fixed: 0.30, price_feed_in: 0.10, currency: 'CHF' } };
const HOUR = 3600_000;

// The real persistence, session and price code over a settings store that outlives the
// device object — which is what a restart is.
function makeDevice(store) {
  const dev = {
    logs: [],
    log(m) { this.logs.push(m); },
    error() {},
    _chargerStates: new Map(),
    _chargeSessions: [],
    _getConfig: () => CFG,
    _addHistoryEvent() {},
    setStoreValue: () => Promise.resolve(),
    _carForCharger: () => null,
    homey: { settings: { get: (k) => store[k], set: (k, v) => { store[k] = v; } } },
  };
  Object.assign(dev, chargerStateMixin, chargerMixin, chargeSessionsMixin, priceMixin);
  dev._getCurrentPrice = () => 0.30;
  return dev;
}

// One hour at 2 kW with 1 kW imported: 1 kWh from the grid (0.30), 1 kWh of sun (0.10).
function chargeOneHour(dev) {
  dev._trackChargeSession({ id: CH, connected: true, rawPowerW: 2000 }, CFG, HOUR, 1000);
}
function unplug(dev) {
  dev._trackChargeSession({ id: CH, connected: false, rawPowerW: 0 }, CFG, 0, 0);
  return dev._chargeSessions[dev._chargeSessions.length - 1];
}

test('the grid and solar halves of a session survive a restart in the middle of it', () => {
  const store = {};
  const before = makeDevice(store);
  chargeOneHour(before);
  chargeOneHour(before);
  assert.ok(before._saveChargerStates(true, T0));

  const after = makeDevice(store);
  after._restoreChargerStates(T0 + 60_000);
  chargeOneHour(after);
  const row = unplug(after);

  assert.strictEqual(row.energyKwh, 6);
  assert.strictEqual(row.cost, 1.2, '3 kWh at 0.30 plus 3 kWh at 0.10');
  assert.strictEqual(row.gridCost, 0.9, 'all three hours of grid, not 0.00');
  assert.strictEqual(row.solarCost, 0.3, 'all three hours of sun, not 0.00');
});

test('the two halves are among the persisted fields', () => {
  const { CHARGER_STATE_FIELDS } = chargerStateMixin;
  assert.ok(CHARGER_STATE_FIELDS.includes('sessionGridCost'));
  assert.ok(CHARGER_STATE_FIELDS.includes('sessionSolarCost'));
});

test('a session saved by the previous version, without the halves, does not turn them into NaN', () => {
  // What is on disk on the day of the update: the total, no halves.
  const store = {
    [CHARGER_STATE_KEY]: {
      savedAt: T0,
      states: { [CH]: {
        sessionActive: true, sessionStartedAt: T0 - 2 * HOUR, sessionEnergyKwh: 4,
        sessionGridKwh: 2, sessionCostSum: 0.8, sessionCostedKwh: 4,
      } },
    },
  };
  const dev = makeDevice(store);
  dev._restoreChargerStates(T0 + 60_000);
  chargeOneHour(dev);
  const st = dev._getChargerState(CH);
  assert.ok(Number.isFinite(st.sessionGridCost) && Number.isFinite(st.sessionSolarCost));
  const row = unplug(dev);
  // The hour after the update is split; the two before it cannot be.
  assert.strictEqual(row.gridCost, 0.3);
  assert.strictEqual(row.solarCost, 0.1);
  assert.strictEqual(row.cost, 1.2, 'the total is complete as before');
});

test('a session closed from a state too old to resume keeps its halves too', () => {
  const store = {};
  const before = makeDevice(store);
  chargeOneHour(before);
  before._saveChargerStates(true, T0);

  const after = makeDevice(store);
  after._restoreChargerStates(T0 + CHARGER_STATE_MAX_GAP_MS + 60_000);
  const row = after._chargeSessions[0];
  assert.strictEqual(row.endedAt, T0);
  assert.strictEqual(row.gridCost, 0.3);
  assert.strictEqual(row.solarCost, 0.1);
});

// ── 2. the scheduler ───────────────────────────────────────────────────────────

const TZ = 'Europe/Zurich';

function makeScheduler(tasks) {
  const fired = [];
  const dev = {
    logs: [],
    log(m) { this.logs.push(m); },
    error() {},
    homey: { clock: { getTimezone: () => TZ } },
    _schedulerFired: new Map(),
    _schedulerCheckedAt: null,
    _api: { triggerFlow: (id) => { fired.push({ id, at: dev._now }); return Promise.resolve(); } },
  };
  Object.assign(dev, priceMixin);
  dev.cfg = { scheduled_tasks: tasks };
  dev.check = async (iso) => {
    dev._now = typeof iso === 'number' ? iso : Date.parse(iso);
    await dev._checkScheduler(dev.cfg, dev._now);
  };
  dev.fired = fired;
  return dev;
}

const daily = (id, time, over = {}) => ({ id, name: id, enabled: true, type: 'daily', time, flow_id: `flow-${id}`, ...over });

test('a 60 s tick that steps over 07:00 still runs the 07:00 task, once, and says it was late', async () => {
  const dev = makeScheduler([daily('a', '07:00')]);
  await dev.check('2026-10-10T06:59:59.600+02:00');
  await dev.check('2026-10-10T07:01:00.200+02:00');   // no tick inside 07:00
  assert.deepStrictEqual(dev.fired.map((f) => f.id), ['flow-a']);
  assert.match(dev.logs.join('\n'), /caught up, 60 s after 07:00/);
  await dev.check('2026-10-10T07:02:00.800+02:00');
  await dev.check('2026-10-10T07:03:01.400+02:00');
  assert.strictEqual(dev.fired.length, 1, 'and not again');
});

test('a whole day of drifting 60 s ticks runs every task exactly once, at most a minute late', async () => {
  const times = ['00:00', '00:01', '06:30', '07:00', '12:34', '18:59', '23:58', '23:59'];
  const dev = makeScheduler(times.map((t) => daily(t, t)));
  // From just after midnight to just before the next one, a little over a minute apart.
  const end = Date.parse('2026-10-11T00:00:00+02:00');
  for (let t = Date.parse('2026-10-10T00:00:05+02:00'); t < end; t += 60_000 + 437) await dev.check(t);
  const byTask = new Map();
  for (const f of dev.fired) byTask.set(f.id, (byTask.get(f.id) || []).concat(f.at));
  for (const time of times) {
    const at = byTask.get(`flow-${time}`) || [];
    assert.strictEqual(at.length, 1, `${time} ran ${at.length} times`);
    const due = Date.parse(`2026-10-10T${time}:00+02:00`);
    assert.ok(at[0] >= due && at[0] - due < 2 * 60_000, `${time} ran ${(at[0] - due) / 1000} s after it was due`);
  }
});

test('a slow tick runs everything that fell due in the minutes it missed', async () => {
  const dev = makeScheduler([daily('a', '07:00'), daily('b', '07:02'), daily('c', '07:04'), daily('d', '07:06')]);
  await dev.check('2026-10-10T06:59:30+02:00');
  await dev.check('2026-10-10T07:04:10+02:00');        // a tick that took 4½ minutes
  assert.deepStrictEqual(dev.fired.map((f) => f.id).sort(), ['flow-a', 'flow-b', 'flow-c']);
});

test('a task older than the catch-up window is not run late — a restart or an outage is not a slow tick', async () => {
  const dev = makeScheduler([daily('a', '07:00'), daily('b', '07:08')]);
  await dev.check('2026-10-10T06:30:00+02:00');
  await dev.check('2026-10-10T07:10:00+02:00');        // forty minutes without a check
  assert.deepStrictEqual(dev.fired.map((f) => f.id), ['flow-b'], 'only what lies within the window');
  assert.ok(SCHEDULER_CATCHUP_MS <= 10 * 60_000);
});

test('the first check after a start looks at its own minute only', async () => {
  const dev = makeScheduler([daily('a', '07:00')]);
  await dev.check('2026-10-10T07:02:00+02:00');
  assert.strictEqual(dev.fired.length, 0, 'a task two minutes before the app started is not run');
  const dev2 = makeScheduler([daily('a', '07:00')]);
  await dev2.check('2026-10-10T07:00:40+02:00');
  assert.strictEqual(dev2.fired.length, 1, 'the current minute is, as it always was');
});

test('a task saved for the current minute just after a check still runs, once', async () => {
  const task = daily('a', '07:00', { enabled: false });
  const dev = makeScheduler([task]);
  await dev.check('2026-10-10T07:00:05+02:00');
  task.enabled = true;                                  // the user saves the settings page
  await dev.check('2026-10-10T07:00:20+02:00');
  await dev.check('2026-10-10T07:00:35+02:00');
  await dev.check('2026-10-10T07:01:05+02:00');
  assert.strictEqual(dev.fired.length, 1);
});

test('a weekday task at midnight is caught up on its own day, not the day before', async () => {
  const dev = makeScheduler([
    daily('mon', '00:00', { type: 'weekday', weekdays: [1] }),
    daily('sun', '00:00', { type: 'weekday', weekdays: [0] }),
  ]);
  await dev.check('2026-10-11T23:59:50+02:00');         // Sunday evening
  await dev.check('2026-10-12T00:01:00+02:00');         // Monday, the 00:00 tick missed
  assert.deepStrictEqual(dev.fired.map((f) => f.id), ['flow-mon']);
});

test('a task at a time the spring clock change skips runs when the clocks jump', async () => {
  // 28 March 2027, Zurich: 01:59:59 is followed by 03:00.
  const dev = makeScheduler([daily('a', '02:30'), daily('b', '03:00')]);
  await dev.check('2027-03-28T01:59:40+01:00');
  await dev.check('2027-03-28T03:00:10+02:00');
  assert.deepStrictEqual(dev.fired.map((f) => f.id).sort(), ['flow-a', 'flow-b']);
  assert.ok(!/caught up/.test(dev.logs.join('\n')), 'run at the jump, which is when 02:30 "happened"');
});

test('a task in the hour the autumn clock change repeats runs once', async () => {
  // 25 October 2026, Zurich: 02:00–02:59 comes twice, first at +02:00, then at +01:00.
  const dev = makeScheduler([daily('a', '02:30')]);
  const first = Date.parse('2026-10-25T02:00:00+02:00');
  for (let t = first; t < first + 2 * HOUR + 60_000; t += 60_000) await dev.check(t);
  assert.strictEqual(dev.fired.length, 1);
});

test('a time not in the HH:MM form the settings page writes is ignored, as before', async () => {
  // Compared as strings, these would land somewhere inside a window: '07:00:00' sorts
  // between 07:00 and 07:01, '1:00' between 19:59 and 20:00.
  const dev = makeScheduler([daily('a', '7:00'), daily('b', '07:00:00'), daily('c', '1:00')]);
  await dev.check('2026-10-10T07:00:10+02:00');
  await dev.check('2026-10-10T07:01:10+02:00');
  await dev.check('2026-10-10T19:59:30+02:00');
  await dev.check('2026-10-10T20:00:10+02:00');
  assert.strictEqual(dev.fired.length, 0);
});

test('a task at 23:59 that the last tick of the day missed runs just after midnight, as the day it belongs to', async () => {
  const dev = makeScheduler([
    daily('daily', '23:59'),
    daily('sun', '23:59', { type: 'weekday', weekdays: [0] }),
    daily('mon', '23:59', { type: 'weekday', weekdays: [1] }),
  ]);
  await dev.check('2026-10-11T23:58:50+02:00');         // Sunday
  await dev.check('2026-10-12T00:00:20+02:00');         // Monday
  assert.deepStrictEqual(dev.fired.map((f) => f.id).sort(), ['flow-daily', 'flow-sun']);
});

test('a clock set back after a check does not blind the scheduler to the current minute', async () => {
  const dev = makeScheduler([daily('a', '07:00')]);
  await dev.check('2026-10-10T07:30:00+02:00');         // the clock was half an hour fast
  await dev.check('2026-10-10T07:00:20+02:00');         // corrected
  assert.strictEqual(dev.fired.length, 1);
});

test('a switched-off EMS forgets where the scheduler stood, so nothing is run late when it comes back', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'drivers', 'energy_management', 'device.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  const branch = src.slice(src.indexOf('    if (!enabled || !hasKey) {'), src.indexOf('    const [battery, gridW, pvW, chargers'));
  assert.match(branch, /this\._schedulerCheckedAt = null;/);
});

test('after the reset, the minutes the EMS was off are not caught up', async () => {
  const dev = makeScheduler([daily('a', '07:00')]);
  await dev.check('2026-10-10T06:59:00+02:00');
  dev._schedulerCheckedAt = null;                       // what the switched-off tick does
  await dev.check('2026-10-10T07:01:30+02:00');         // switched back on
  assert.strictEqual(dev.fired.length, 0);
});
