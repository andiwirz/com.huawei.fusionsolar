'use strict';

// A refused call is not a missing device. Run: node --test
//
// getDevRealKpi returns a rate limit the same way it returns an empty plant: success, and
// no devices. That empty list fed the starved check, which took the device offline saying
// "No data from FusionSolar for device type 39" — and issue #28 spent days reading that as
// a battery the API would not hand over. The battery was answering; the call had been
// refused, because the diagnostic was bursting four calls at a plant whose whole allowance
// is four per five minutes.
//
// Huawei's traffic-limiting policy names two kinds and asks for different answers:
//
//   407         this user calling one interface too often
//               "lower your frequency of calls to this API until it drops into range"
//   403 / 429   the system as a whole being busy
//               "wait for 1 minute and try again"
//
// And section 3.1.6.1 gives the allowance for this interface:
//
//   calls per 5 minutes = Σ over device types of Roundup(devices of that type / 100)
//
// which on a household plant is one call per type per five minutes.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const fs     = require('fs');

const { StationSession } = require('../lib/openapi-coordinator');

const BATTERY = 39;
const ESS     = 41;    // declared by the battery driver, absent from this plant
const METER   = 17;    // likewise absent
const SENSOR  = 47;
const EMMA    = 23070;

function fakeDevice(name, types, pollInterval = 5) {
  const d = {
    available: true,
    polls: [],
    reasons: [],
    getName: () => name,
    getSetting: (k) => ({ username: 'u', system_code: 'c', poll_interval: pollInterval }[k] ?? null),
    getDevTypes: () => types,
    onPollData: async (p) => { d.polls.push(p); },
    getAvailable: () => d.available,
    setAvailable: async () => { d.available = true; },
    setUnavailable: async (r) => { d.available = false; d.reasons.push(r); },
  };
  return d;
}

// A battery reading one type, and a meter reading two — so "one of my types was refused"
// can be told apart from "every type I could read was refused".
function fakePlant() {
  const logs = [];
  const homey = {
    log:   (...a) => logs.push(a.join(' ')),
    error: (...a) => logs.push('ERROR ' + a.join(' ')),
    setTimeout: () => 0, clearTimeout: () => {},
    setInterval: () => 0, clearInterval: () => {},
  };
  const s       = new StationSession(homey, 'ST1');
  const battery = fakeDevice('LUNA2000', [BATTERY, ESS]);
  const meter   = fakeDevice('Power Sensor', [METER, SENSOR, EMMA]);
  s.addDevice(battery);
  s.addDevice(meter);
  s._ensureDevIds = async () => {
    s._devIdsByType = { [BATTERY]: ['b1'], [SENSOR]: ['p1'], [EMMA]: ['e1'] };
  };
  s._interRequestDelayMs = 0;
  s._queue = [];
  s._withAutoRelogin = async () => {
    if (!s._queue.length) throw new Error('the test ran out of canned answers');
    return s._queue.shift();
  };
  // Queued in the order the poll asks: station, then battery (39), sensor (47), EMMA (23070).
  s.poll = async ({ station, bat, sensor, emma }) => {
    s._queue = [station, bat, sensor, emma];
    s._lastPollAt = 0;
    s._backoffUntil = 0;
    await s._poll();
  };
  return { s, battery, meter, logs };
}

const OK_STATION = { expired: false, kpi: { day_power: 1 } };
const BAT_DATA   = { devices: [{ dataItemMap: { battery_soc: 47 } }] };
const SENSOR_DATA = { devices: [{ dataItemMap: { active_power: 16 } }] };
const EMMA_DATA  = { devices: [{ dataItemMap: { active_power: 0.007 } }] };
const NOTHING    = { devices: [], failCode: null, failMessage: null };

const refused = (failCode, failMessage) => ({ devices: [], failCode, failMessage });
const LIMIT_407 = refused(407, 'Rate limit exceeded — too many API calls, please reduce poll frequency');
const LIMIT_429 = refused(429, 'System-wide rate limit exceeded — wait 1 minute and retry');
const LIMIT_403 = refused(403, 'System-wide rate limit exceeded — wait 1 minute and retry');

// ── The misdiagnosis ─────────────────────────────────────────────────────────

test('a refused type does not put "no data for device type" on the device', async () => {
  const { s, battery } = fakePlant();
  await s.poll({ station: OK_STATION, bat: LIMIT_407, sensor: SENSOR_DATA, emma: EMMA_DATA });

  assert.strictEqual(battery.available, false, 'there is no reading, so it cannot stay available');
  assert.strictEqual(battery.reasons.length, 1);
  assert.doesNotMatch(battery.reasons[0], /No data from FusionSolar for device type/,
    'a refused call is reported as a device that stopped reporting — the wrong hunt');
  // Huawei's own words, not a house phrase that merely says "rate limit": the message is
  // what tells a user whether their own frequency (407) or the system (403/429) refused,
  // and a generic fallback would satisfy a looser assertion while losing that.
  assert.strictEqual(battery.reasons[0], LIMIT_407.failMessage,
    'the specific reason was replaced by a generic one, which cannot be acted on');
});

test('a genuinely silent type still says so', async () => {
  const { s, battery } = fakePlant();
  await s.poll({ station: OK_STATION, bat: NOTHING, sensor: SENSOR_DATA, emma: EMMA_DATA });
  assert.strictEqual(battery.available, false);
  assert.match(battery.reasons[0], /No data from FusionSolar for device type 39/,
    'the honest "this type went quiet" message was lost with the wrong one');
});

test('a device whose other type answered stays available', async () => {
  const { s, meter } = fakePlant();
  await s.poll({ station: OK_STATION, bat: BAT_DATA, sensor: SENSOR_DATA, emma: LIMIT_407 });
  assert.strictEqual(meter.available, true,
    'one refused type of three took a device offline that had a reading in hand');
  assert.deepStrictEqual(meter.polls[0].kpiByType[SENSOR], [{ active_power: 16 }]);
});

test('a cached reading still bridges a refused call', async () => {
  const { s, battery, logs } = fakePlant();
  await s.poll({ station: OK_STATION, bat: BAT_DATA, sensor: SENSOR_DATA, emma: EMMA_DATA });
  await s.poll({ station: OK_STATION, bat: LIMIT_407, sensor: SENSOR_DATA, emma: EMMA_DATA });
  assert.strictEqual(battery.available, true, 'a fresh cache was thrown away over a refusal');
  assert.ok(logs.some((l) => /Using cached KPI for type 39/.test(l)));
});

// ── Acting on it ─────────────────────────────────────────────────────────────

test('a 407 pauses polling, which this path never used to do', async () => {
  const { s, logs } = fakePlant();
  await s.poll({ station: OK_STATION, bat: LIMIT_407, sensor: SENSOR_DATA, emma: EMMA_DATA });
  const pause = s._backoffUntil - Date.now();
  assert.ok(pause > 14 * 60_000 && pause <= 15 * 60_000,
    `polling was paused for ${Math.round(pause / 1000)}s, not the 15 minutes the app uses elsewhere`);
  assert.ok(logs.some((l) => /rate limit \(407\)/i.test(l)));
});

// The policy asks for a minute on a system-level limit, and the next poll is at least five
// minutes out — so there is nothing left to pause, and pausing anyway would cost a user
// fifteen minutes of readings for someone else's traffic.
test('a 403 or 429 does not pause polling', async () => {
  for (const limit of [LIMIT_403, LIMIT_429]) {
    const { s } = fakePlant();
    await s.poll({ station: OK_STATION, bat: limit, sensor: SENSOR_DATA, emma: EMMA_DATA });
    assert.strictEqual(s._backoffUntil, 0,
      `failCode ${limit.failCode} paused polling for 15 minutes; the policy asks for one`);
  }
});

test('a 403 or 429 is still reported as a rate limit on the device', async () => {
  const { s, battery } = fakePlant();
  await s.poll({ station: OK_STATION, bat: LIMIT_429, sensor: SENSOR_DATA, emma: EMMA_DATA });
  assert.match(battery.reasons[0], /[Rr]ate limit/);
  assert.doesNotMatch(battery.reasons[0], /No data from FusionSolar for device type/);
});

// ── The arithmetic, written down where a field report will carry it ──────────

test('the allowance is computed and logged once', async () => {
  const { s, logs } = fakePlant();
  await s.poll({ station: OK_STATION, bat: BAT_DATA, sensor: SENSOR_DATA, emma: EMMA_DATA });
  await s.poll({ station: OK_STATION, bat: BAT_DATA, sensor: SENSOR_DATA, emma: EMMA_DATA });

  const lines = logs.filter((l) => /allowance/.test(l));
  assert.strictEqual(lines.length, 1, 'the arithmetic is repeated every poll, or never printed');
  // Three types of one device each: Roundup(1/100) three times. Three calls per poll at a
  // five-minute interval is exactly three per window — inside the allowance, but only just.
  assert.match(lines[0], /3 calls \/ 5 min/, 'the allowance is not the sum from section 3.1.6.1');
  assert.match(lines[0], /makes 3 per poll at 5 min = 3\.0 \/ 5 min/);
  assert.doesNotMatch(lines[0], /OVER the allowance/, 'a plant inside its allowance is warned anyway');
});

// The app cannot currently exceed its allowance, and the arithmetic says why: one call per
// type per poll, an allowance of at least one call per type per five minutes, and a hard
// five-minute floor in _intervalMs. The three cancel.
//
// That floor is also why the iSitePower drivers offering a one-minute setting was a lie in
// the settings screen rather than a flood of calls — a user could type 1 and the coordinator
// would poll at 5 regardless. Worth correcting, but it was never over the limit.
test('the five-minute floor is what keeps the app inside the allowance', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'openapi-coordinator.js'), 'utf8');
  assert.match(src, /const MIN_INTERVAL_MIN\s*=\s*5;/,
    'the floor moved; with it below five minutes the allowance can be exceeded');
  assert.match(src, /v >= MIN_INTERVAL_MIN && v < min/,
    'the floor is no longer applied to a device setting, so a faster interval takes effect');
});

// The warning branch guards against exactly that floor being lowered later, so it is driven
// here with a shorter interval rather than through a setting the floor would reject.
test('a plant polling faster than its allowance would be told so', async () => {
  const { s, logs } = fakePlant();
  s._intervalMs = () => 60_000;
  await s.poll({ station: OK_STATION, bat: BAT_DATA, sensor: SENSOR_DATA, emma: EMMA_DATA });
  const line = logs.find((l) => /allowance/.test(l));
  assert.match(line, /makes 3 per poll at 1 min = 15\.0 \/ 5 min/);
  assert.match(line, /OVER the allowance, expect failCode 407/);
});

// ── The manifest half ────────────────────────────────────────────────────────

test('no cloud driver offers an interval the allowance cannot serve', () => {
  const app = require(path.join(__dirname, '..', 'app.json'));
  // Settings sit in groups since 1.2.277 — look inside them, and count what was checked: a
  // lookup that misses everything would otherwise pass by checking nothing.
  const flat = (l) => (l || []).flatMap((x) => (x.type === 'group' ? flat(x.children) : [x]));
  let checked = 0;
  for (const d of app.drivers) {
    const s = flat(d.settings).find((x) => x.id === 'poll_interval');
    if (!s || !/openapi_fusionsolar$/.test(d.id)) continue;
    checked++;
    assert.ok(s.min >= 5,
      `${d.id} allows a ${s.min}-minute interval; the allowance is one call per device type `
      + 'per five minutes, so anything under five is over it by construction');
  }
  assert.strictEqual(checked, 7, 'the cloud drivers were not all found');
});

test('the system-level code Huawei documents beside 429 is known too', () => {
  const src   = fs.readFileSync(path.join(__dirname, '..', 'lib', 'openapi-client.js'), 'utf8');
  const from  = src.indexOf('const FAIL_MESSAGES');
  const table = src.slice(from, src.indexOf('};', from));
  assert.match(table, /^\s*403:/m, '403 is unmapped, so it surfaces as a bare "Error 403"');
  assert.match(table, /^\s*429:/m);
  assert.match(table, /^\s*407:/m);
});
