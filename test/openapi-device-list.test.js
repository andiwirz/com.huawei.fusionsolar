'use strict';

// The OpenAPI availability rule, the part the developer note left open (D2), 1.2.280.
//
// During operation a single empty answer is bridged from the cache (1.2.197, issue #26) —
// test/openapi-starved-type.test.js holds that. Three gaps were left:
//
//   - right after an app start there is no cache, so one empty answer marked a working device
//     as having no data at once — the case the note measured: a battery offline with valid,
//     eight-minute-old values;
//   - the device list was fetched once per app start, so one empty or incomplete getDevList
//     answer stayed until the next restart;
//   - a device whose types that list lacked got no warning and kept showing its last values.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');

const { StationSession } = require('../lib/openapi-coordinator');

const BATTERY = 39;
const ESS     = 41;
const EMMA    = 23070;
const HOUR    = 60 * 60_000;

function fakeDevice(name, types) {
  const d = {
    available: true, polls: [], reasons: [],
    getName: () => name,
    getSetting: (k) => ({ username: 'u', system_code: 'c' }[k] ?? null),
    getDevTypes: () => types,
    onPollData: async (p) => { d.polls.push(p); },
    getAvailable: () => d.available,
    setAvailable: async () => { d.available = true; },
    setUnavailable: async (r) => { d.available = false; d.reasons.push(r); },
  };
  return d;
}

// A plant whose device lists are handed out one per fetch, from `lists`; the last one repeats.
function fakePlant(lists) {
  const logs = [];
  const homey = {
    log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push('ERROR ' + a.join(' ')),
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  };
  const s = new StationSession(homey, 'ST1');
  const battery = fakeDevice('LUNA2000', [BATTERY, ESS]);
  const meter   = fakeDevice('Power Sensor', [EMMA]);
  s.addDevice(battery);
  s.addDevice(meter);
  s._interRequestDelayMs = 0;
  s.listFetches = 0;
  s._loadDevList = async () => { const l = lists[Math.min(s.listFetches, lists.length - 1)]; s.listFetches++; return JSON.parse(JSON.stringify(l)); };
  s._queue = [];
  s._withAutoRelogin = async () => {
    if (!s._queue.length) throw new Error('the test ran out of canned answers');
    return s._queue.shift();
  };
  // Answers in the order the poll asks: the station, then one per type the plant lists.
  s.poll = async (answers) => {
    s._queue = [{ expired: false, kpi: { day_power: 1 } }, ...answers];
    s._lastPollAt = 0;
    await s._poll();
  };
  s.age = (ms) => { s._devIdsAt -= ms; };  // let time pass for the device list
  return { s, battery, meter, logs };
}

const BOTH     = { [BATTERY]: ['b1'], [EMMA]: ['e1'] };
const NO_BAT   = { [EMMA]: ['e1'] };
const EMPTY    = {};
const BAT_DATA = { devices: [{ dataItemMap: { battery_soc: 47 } }] };
const EMMA_DAT = { devices: [{ dataItemMap: { active_power: 0.074 } }] };
const NOTHING  = { devices: [] };

// ── right after a start ─────────────────────────────────────────────────────────

test('after a start, one empty answer gets one more cycle before the device counts as without data', async () => {
  const { s, battery, meter, logs } = fakePlant([BOTH]);
  await s.poll([NOTHING, EMMA_DAT]);
  assert.strictEqual(battery.available, true, 'one empty answer right after a start took the battery offline');
  assert.ok(logs.some((l) => /Type 39 answered empty with nothing cached — one more cycle/.test(l)));
  await s.poll([NOTHING, EMMA_DAT]);
  assert.strictEqual(battery.available, false);
  assert.match(battery.reasons.at(-1), /No data from FusionSolar for device type 39/);
  assert.strictEqual(meter.available, true);
});

test('after a start, an answer on the second cycle means it was never offline', async () => {
  const { s, battery } = fakePlant([BOTH]);
  await s.poll([NOTHING, EMMA_DAT]);
  await s.poll([BAT_DATA, EMMA_DAT]);
  assert.strictEqual(battery.available, true);
  assert.deepStrictEqual(battery.reasons, []);
});

test('the grace is once per gap, not once per empty answer', async () => {
  const { s, battery } = fakePlant([BOTH]);
  await s.poll([NOTHING, EMMA_DAT]);
  await s.poll([NOTHING, EMMA_DAT]);
  await s.poll([NOTHING, EMMA_DAT]);
  assert.strictEqual(battery.available, false);
  assert.strictEqual(battery.reasons.length, 2, 'a later empty answer was given grace again');
});

// ── the device list ─────────────────────────────────────────────────────────────

test('the device list is fetched once, and again once a day', async () => {
  const { s } = fakePlant([BOTH]);
  for (let i = 0; i < 3; i++) await s.poll([BAT_DATA, EMMA_DAT]);
  assert.strictEqual(s.listFetches, 1);
  s.age(25 * HOUR);
  await s.poll([BAT_DATA, EMMA_DAT]);
  assert.strictEqual(s.listFetches, 2, 'a list from yesterday was kept');
});

test('a device missing from the list is looked up again after 15 minutes, not before — and found', async () => {
  const { s, battery } = fakePlant([NO_BAT, BOTH]);
  await s.poll([EMMA_DAT]);
  assert.strictEqual(battery.available, true, 'one list without the battery was taken as the plant\'s word');
  await s.poll([EMMA_DAT]);
  assert.strictEqual(s.listFetches, 1, 'the list was fetched again on the very next poll');
  s.age(16 * 60_000);
  await s.poll([BAT_DATA, EMMA_DAT]);
  assert.strictEqual(s.listFetches, 2);
  assert.strictEqual(battery.available, true);
  assert.deepStrictEqual(battery.polls.at(-1).kpiByType[BATTERY], [{ battery_soc: 47 }]);
});

test('missing from the next list as well, the device says so — and stops asking', async () => {
  const { s, battery, meter } = fakePlant([NO_BAT]);
  await s.poll([EMMA_DAT]);
  s.age(16 * 60_000);
  await s.poll([EMMA_DAT]);
  assert.strictEqual(battery.available, false);
  assert.strictEqual(battery.reasons.at(-1), 'FusionSolar lists no device of type 39/41 for this plant');
  assert.strictEqual(meter.available, true);
  // Confirmed absent: no more lookups until the daily one.
  s.age(16 * 60_000);
  await s.poll([EMMA_DAT]);
  assert.strictEqual(s.listFetches, 2, 'a device confirmed absent kept the list being fetched every 15 minutes');
});

test('a device that turns up in a later list comes back on its own', async () => {
  const { s, battery } = fakePlant([NO_BAT, NO_BAT, BOTH]);
  await s.poll([EMMA_DAT]);
  s.age(16 * 60_000);
  await s.poll([EMMA_DAT]);
  assert.strictEqual(battery.available, false);
  s.age(25 * HOUR);
  await s.poll([BAT_DATA, EMMA_DAT]);
  assert.strictEqual(battery.available, true);
});

test('an empty list never replaces one that had devices in it', async () => {
  const { s, battery, meter, logs } = fakePlant([BOTH, EMPTY]);
  await s.poll([BAT_DATA, EMMA_DAT]);
  s.age(25 * HOUR);
  await s.poll([BAT_DATA, EMMA_DAT]);
  assert.deepStrictEqual(s._devIdsByType, BOTH);
  assert.strictEqual(battery.available, true);
  assert.strictEqual(meter.available, true);
  assert.ok(logs.some((l) => /came back empty — keeping the one from before/.test(l)));
});

test('a device that is removed is forgotten', async () => {
  const { s, battery } = fakePlant([NO_BAT]);
  await s.poll([EMMA_DAT]);
  assert.ok(s._absentSince.has(battery));
  s.removeDevice(battery);
  assert.ok(!s._absentSince.has(battery));
});

test('a device without data whose type then leaves the list is not declared available again', async () => {
  // Starved first, then a list without its type: unconfirmed absence leaves the device as it
  // is — offline, with no data — instead of flipping it to available while it shows nothing new.
  const { s, battery } = fakePlant([BOTH, NO_BAT]);
  await s.poll([NOTHING, EMMA_DAT]);
  await s.poll([NOTHING, EMMA_DAT]);
  assert.strictEqual(battery.available, false);
  s.age(25 * HOUR);
  await s.poll([EMMA_DAT]);
  assert.strictEqual(battery.available, false, 'a battery with no data was declared available');
});
