'use strict';

// One device type going quiet while the rest of the plant answers. Run: node --test
//
// From a diagnostic capture in issue #25, taken on a plant with an inverter, a battery,
// an EMMA and a SmartGuard:
//
//   getDevRealKpi(type=1)     -> 1 device(s)
//   getDevRealKpi(type=39)    -> 0 device(s)   ← the battery
//   getDevRealKpi(type=23070) -> 1 device(s)   ← the EMMA
//   getDevRealKpi(type=23071) -> 0 device(s)
//
// The battery call SUCCEEDED and returned nothing. The station-wide staleness check is
// deliberately generous — one type delivering keeps the whole station healthy — so nothing
// was announced, no device was flagged, and the battery kept the last figures it had ever
// received. Meanwhile the coordinator was dropping its cached battery KPI for being too
// old, on the stated grounds that "an old number is indistinguishable from a measurement".
// The driver then received no data, returned early, and left that same old number on
// screen. The guard reached the cache and stopped short of the device.

const test   = require('node:test');
const assert = require('node:assert');

const { StationSession } = require('../lib/openapi-coordinator');

const MINUTE   = 60_000;
const BATTERY  = 39;
const EMMA     = 23070;
const ESS      = 41;   // declared by the battery driver; absent from this plant

function fakeDevice(name, types) {
  const d = {
    available: true,
    polls: [],
    reasons: [],
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

// A plant that owns a battery and an EMMA. The battery device also declares the C&I ESS
// type, which this plant does not have — a type that was never coming must not count as
// one that went quiet.
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
  const meter   = fakeDevice('Power Sensor', [EMMA]);
  s.addDevice(battery);
  s.addDevice(meter);
  s._ensureDevIds = async () => { s._devIdsByType = { [BATTERY]: ['b1'], [EMMA]: ['e1'] }; };
  s._interRequestDelayMs = 0; // the real 1.5 s pacing has nothing to do with what is tested here
  s._queue = [];
  s._withAutoRelogin = async () => {
    if (!s._queue.length) throw new Error('the test ran out of canned answers');
    return s._queue.shift();
  };
  // Answers are queued in the order the poll asks for them: station, then one call per
  // type that this plant actually has devices for.
  s.poll = async ({ station, battery: bat, emma }) => {
    s._queue = [station, bat, emma];
    s._lastPollAt = 0;
    await s._poll();
  };
  return { s, battery, meter, logs };
}

const OK_STATION = { expired: false, kpi: { day_power: 1 } };
const BAT_DATA   = { devices: [{ dataItemMap: { battery_soc: 47, ch_discharge_power: -510 } }] };
const EMMA_DATA  = { devices: [{ dataItemMap: { active_power: 0.074 } }] };
const NOTHING    = { devices: [] };   // a successful call that returned no devices

test('a healthy plant leaves both devices available', async () => {
  const { s, battery, meter } = fakePlant();
  await s.poll({ station: OK_STATION, battery: BAT_DATA, emma: EMMA_DATA });
  assert.strictEqual(battery.available, true);
  assert.strictEqual(meter.available, true);
});

// The short outage is bridged, exactly as a station-wide one is. Flagging a device on the
// first empty answer would make every hiccup visible as a fault.
test('one empty answer is bridged from the cache, not flagged', async () => {
  const { s, battery, logs } = fakePlant();
  await s.poll({ station: OK_STATION, battery: BAT_DATA, emma: EMMA_DATA });
  await s.poll({ station: OK_STATION, battery: NOTHING, emma: EMMA_DATA });
  assert.strictEqual(battery.available, true, 'a single empty answer took the battery offline');
  assert.deepStrictEqual(battery.polls[1].kpiByType[BATTERY], [{ battery_soc: 47, ch_discharge_power: -510 }]);
  assert.ok(logs.some((l) => /Using cached KPI for type 39/.test(l)));
});

// The heart of it: the station is healthy, the meter is answering, and the battery is not.
test('a type that stays quiet takes its own device offline, and nothing else', async () => {
  const { s, battery, meter } = fakePlant();
  await s.poll({ station: OK_STATION, battery: BAT_DATA, emma: EMMA_DATA });
  s._lastGoodKpiByType[BATTERY].at = Date.now() - 6 * 60 * MINUTE;
  await s.poll({ station: OK_STATION, battery: NOTHING, emma: EMMA_DATA });

  assert.strictEqual(battery.available, false,
    'the battery reports itself healthy while showing figures nothing has refreshed');
  assert.strictEqual(meter.available, true,
    'the meter was taken offline too — it was answering perfectly well');
  assert.match(battery.reasons.at(-1), /39/,
    'the reason does not name the device type, so nobody can tell what went quiet');
});

// The station-wide check must stay generous: one type going quiet is not an outage.
test('one quiet type does not declare the whole station stale', async () => {
  const { s, logs } = fakePlant();
  await s.poll({ station: OK_STATION, battery: BAT_DATA, emma: EMMA_DATA });
  s._lastGoodKpiByType[BATTERY].at = Date.now() - 6 * 60 * MINUTE;
  await s.poll({ station: OK_STATION, battery: NOTHING, emma: EMMA_DATA });
  assert.strictEqual(s._staleSince, null,
    'the station was declared stale although two of its three sources answered');
  assert.ok(!logs.some((l) => /nothing fresh for/.test(l)));
});

test('the device comes back on its own when its type answers again', async () => {
  const { s, battery } = fakePlant();
  await s.poll({ station: OK_STATION, battery: BAT_DATA, emma: EMMA_DATA });
  s._lastGoodKpiByType[BATTERY].at = Date.now() - 6 * 60 * MINUTE;
  await s.poll({ station: OK_STATION, battery: NOTHING, emma: EMMA_DATA });
  assert.strictEqual(battery.available, false);

  await s.poll({ station: OK_STATION, battery: BAT_DATA, emma: EMMA_DATA });
  assert.strictEqual(battery.available, true, 'the device needs a restart to recover');
});

// A driver naming a type this plant does not own must not be judged on it. The battery
// driver asks for the C&I ESS type as well; a residential plant has none, and that absence
// is permanent rather than a symptom.
test('a type the plant never had does not count as one that went quiet', async () => {
  const { s, battery } = fakePlant();
  await s.poll({ station: OK_STATION, battery: BAT_DATA, emma: EMMA_DATA });
  assert.strictEqual(battery.available, true,
    'the missing C&I ESS type was treated as a fault, taking a working battery offline');
  assert.ok(!battery.polls[0].kpiByType[ESS], 'precondition: the plant has no ESS data');
});

// A device reading from several types it does own is starved only when all of them stop.
// The inverter driver also asks for meter types; losing those is not losing the inverter.
test('a device with one live type among several stays available', async () => {
  const { s } = fakePlant();
  const both = fakeDevice('Inverter', [BATTERY, EMMA]);
  s.addDevice(both);
  await s.poll({ station: OK_STATION, battery: BAT_DATA, emma: EMMA_DATA });
  s._lastGoodKpiByType[BATTERY].at = Date.now() - 6 * 60 * MINUTE;
  await s.poll({ station: OK_STATION, battery: NOTHING, emma: EMMA_DATA });
  assert.strictEqual(both.available, true,
    'a device lost one of its two sources and was taken offline with the other still live');
});

// A device whose types this plant has none of at all — a battery device left paired after
// the battery was removed, say. `present` is then empty, and an empty list satisfies
// "every type is starved" vacuously. Left unguarded that marks the device unavailable on
// the first poll, which is a different decision from the one being made here and would
// also fire during the window before the device list has been fetched.
test('a device whose types the plant has none of is left alone', async () => {
  const { s } = fakePlant();
  const orphan = fakeDevice('Battery from a former plant', [ESS]);
  s.addDevice(orphan);
  await s.poll({ station: OK_STATION, battery: BAT_DATA, emma: EMMA_DATA });
  assert.strictEqual(orphan.available, true,
    'a device for hardware this plant does not have was flagged as starved, which is a '
    + 'claim about data rather than about the plant');
  assert.deepStrictEqual(orphan.reasons, []);
});
