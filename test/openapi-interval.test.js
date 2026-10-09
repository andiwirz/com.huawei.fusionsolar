'use strict';

// The cloud devices' poll interval takes effect (1.2.288).
//
// The setting offered 5 to 60 minutes and did nothing: _intervalMs looked for the shortest
// interval of a plant's devices but started the search at the default of five, which is also
// the floor, so the answer could only ever come down to five and never go up. Making it work
// touched three things built on the five-minute cycle: the cache limit (a fixed 15 minutes
// would drop every reading at its first use with a 30-minute interval), the minimum gap
// between polls (which, tied to the interval, would make a credentials change wait half an
// hour), and the running timer (which kept the old interval until the next app start).
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const OpenAPICoordinator = require('../lib/openapi-coordinator');
const { StationSession } = OpenAPICoordinator;

const BATTERY = 39;
const MIN = 60_000;

function fakeDevice(pollInterval) {
  const d = {
    available: true,
    reasons: [],
    getName: () => 'LUNA2000',
    getSetting: (k) => ({ username: 'u', system_code: 'c', poll_interval: pollInterval }[k] ?? null),
    getDevTypes: () => [BATTERY],
    onPollData: async () => {},
    getAvailable: () => d.available,
    setAvailable: async () => { d.available = true; },
    setUnavailable: async (r) => { d.available = false; d.reasons.push(r); },
  };
  return d;
}

function session(...intervals) {
  const logs = [];
  const timers = [];
  const homey = {
    log: (...a) => logs.push(a.join(' ')),
    error: (...a) => logs.push('ERROR ' + a.join(' ')),
    setTimeout: () => 0, clearTimeout: () => {},
    setInterval: (fn, ms) => { timers.push(ms); return timers.length; },
    clearInterval: () => {},
  };
  const s = new StationSession(homey, 'ST1');
  const devices = intervals.map((i) => fakeDevice(i));
  for (const d of devices) s.addDevice(d);
  return { s, devices, logs, timers };
}

// ── which interval ──────────────────────────────────────────────────────────────

test('a longer interval takes effect — the shortest of the plant\'s devices', () => {
  assert.strictEqual(session(30).s._intervalMs(), 30 * MIN, 'the setting still has no effect');
  assert.strictEqual(session(30, 10).s._intervalMs(), 10 * MIN);
  assert.strictEqual(session(60, '20').s._intervalMs(), 20 * MIN);
});

test('below the floor, unset or unreadable falls back to five minutes', () => {
  assert.strictEqual(session(3).s._intervalMs(), 5 * MIN, 'a value under the floor was used');
  assert.strictEqual(session(3, 20).s._intervalMs(), 20 * MIN, 'a value under the floor beat a valid one');
  assert.strictEqual(session(null).s._intervalMs(), 5 * MIN);
  assert.strictEqual(session('sixty').s._intervalMs(), 5 * MIN);
});

test('the timer runs at the interval, and a change restarts it at the new one', () => {
  const { s, devices, timers } = session(30);
  assert.strictEqual(timers[timers.length - 1], 30 * MIN);
  devices[0].getSetting = (k) => ({ username: 'u', system_code: 'c', poll_interval: 15 }[k] ?? null);
  s.restartTimer();
  assert.strictEqual(timers[timers.length - 1], 15 * MIN);
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'openapi-coordinator.js'), 'utf8');
  const changed = src.slice(src.indexOf('  settingsChanged('), src.indexOf('  // Call when station_code itself changes'));
  assert.match(changed, /session\.restartTimer\(\);/, 'a changed interval waits for the next app start again');
});

// ── what follows from it ─────────────────────────────────────────────────────────

test('the cache limit is three cycles, whatever the interval', () => {
  assert.strictEqual(session(5).s._staleLimitMs(), 15 * MIN, 'the default case changed');
  assert.strictEqual(session(30).s._staleLimitMs(), 90 * MIN);
});

async function pollWith(s, bat) {
  s._ensureDevIds = async () => { s._devIdsByType = { [BATTERY]: ['b1'] }; };
  s._interRequestDelayMs = 0;
  const queue = [{ expired: false, kpi: { day_power: 1 } }, bat];
  s._withAutoRelogin = async () => queue.shift();
  s._lastPollAt = 0;
  s._backoffUntil = 0;
  await s._poll();
}
const BAT_DATA = { devices: [{ dataItemMap: { battery_soc: 47 } }] };
const NOTHING  = { devices: [], failCode: null, failMessage: null };

test('with a 30-minute interval one empty answer is bridged by the last reading', async () => {
  const { s, devices, logs } = session(30);
  await pollWith(s, BAT_DATA);
  s._lastGoodKpiByType[BATTERY].at -= 30 * MIN;     // the next poll comes half an hour later
  await pollWith(s, NOTHING);
  assert.strictEqual(devices[0].available, true, 'the device went offline over one empty answer');
  assert.ok(logs.some((l) => /Using cached KPI for type 39/.test(l)));
});

test('at five minutes a reading half an hour old is still dropped, as before', async () => {
  const { s, logs } = session(5);
  await pollWith(s, BAT_DATA);
  s._lastGoodKpiByType[BATTERY].at -= 30 * MIN;
  await pollWith(s, NOTHING);
  assert.ok(logs.some((l) => /Dropped cached KPI for type 39/.test(l)), '#26: an old figure stayed on screen');
});

test('the gap between two polls is the five-minute floor, not the configured interval', async () => {
  const { s } = session(30);
  s._getCredentials = () => null;                   // stop right after the gap check
  s._lastPollAt = Date.now() - 6 * MIN;
  await s._poll();
  assert.ok(Date.now() - s._lastPollAt < MIN, 'a poll six minutes after the last was held back for the 30-minute interval');
  s._lastPollAt = Date.now() - 2 * MIN;
  const before = s._lastPollAt;
  await s._poll();
  assert.strictEqual(s._lastPollAt, before, 'two polls two minutes apart got through — over the allowance');
});

// ── the tooltip ─────────────────────────────────────────────────────────────────

test('the interval tooltip describes what the coordinator does', () => {
  const app = require('../app.json');
  const flat = (l) => (l || []).flatMap((x) => (x.type === 'group' ? flat(x.children) : [x]));
  const words = { en: 'the shortest interval', de: 'der kürzeste Wert', nl: 'de kortste ingestelde waarde' };
  let checked = 0;
  for (const d of app.drivers.filter((x) => /openapi_fusionsolar$/.test(x.id))) {
    const s = flat(d.settings).find((x) => x.id === 'poll_interval');
    assert.strictEqual(s.min, 5);
    for (const l of ['en', 'de', 'nl']) {
      assert.ok(s.hint[l].includes(words[l]), `${d.id} (${l})`);
      assert.doesNotMatch(s.hint[l], /below 5|unter 5|onder 5/, `${d.id} (${l}) warns about values it cannot be set to`);
    }
    checked++;
  }
  assert.strictEqual(checked, 7);
});
