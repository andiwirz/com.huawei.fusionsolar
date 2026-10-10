'use strict';

// Three FusionSolar-cloud faults from the review of 2026-10-10 (1.2.317).
//
//   1. A changed station code was not applied: reregister read the device's setting, which
//      during onSettings still holds the OLD code, and looked for the old session under a
//      code stored at the previous change. The device stayed with the old plant; deleted
//      before a restart, it was polled for ever.
//   2. A pause — after a 407, or for a diagnostic run — only held a poll that had to log in.
//      With a session open, polling went on straight through it. And a type refused for
//      frequency was asked a second time at once, with its type as a string.
//   3. One timed-out call failed the whole poll and took every device of the plant offline;
//      the cache meant to bridge a hiccup only covered refusals, which do not throw.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const { EventEmitter } = require('events');

const OpenAPICoordinator = require('../lib/openapi-coordinator');
const { StationSession } = OpenAPICoordinator;

const quietHomey = () => ({
  logs: [],
  log(...a) { this.logs.push(a.join(' ')); }, error(...a) { this.logs.push('ERROR ' + a.join(' ')); },
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
});

// ── 1. a changed station code ────────────────────────────────────────────────────

test('a changed station code moves the device to the new plant — at once, and only there', () => {
  const coord = new OpenAPICoordinator(quietHomey());
  const settings = { station_code: 'A', username: 'u', system_code: 'c' };
  const device = { getSetting: (k) => settings[k], getName: () => 'SUN2000', getDevTypes: () => [1] };
  coord.register(device);
  assert.deepStrictEqual([...coord._sessions.keys()], ['A']);

  // onSettings: the stored setting still says A; nothing was ever stored for the old code.
  coord.reregister(device, undefined, 'B');
  assert.deepStrictEqual([...coord._sessions.keys()], ['B'], 'the device stayed with plant A');
  assert.ok(coord._sessions.get('B')._devices.has(device));

  coord.reregister(device, 'B', 'C');                  // a second change before any restart
  assert.deepStrictEqual([...coord._sessions.keys()], ['C'], 'the device sits in two sessions');

  settings.station_code = 'C';
  coord.unregister(device);                            // deleted: nothing may go on polling for it
  assert.deepStrictEqual([...coord._sessions.keys()], []);
});

test('deleting a device finds it even where its setting no longer points', () => {
  const coord = new OpenAPICoordinator(quietHomey());
  const settings = { station_code: 'A' };
  const device = { getSetting: (k) => settings[k], getDevTypes: () => [1] };
  coord.register(device);
  settings.station_code = 'B';                         // the setting moved, the device did not
  coord.unregister(device);
  assert.deepStrictEqual([...coord._sessions.keys()], [], 'a deleted device was left in session A, polled for ever');
});

// ── a plant to poll ──────────────────────────────────────────────────────────────

const BATTERY = 39;
const METER   = 47;
function plant() {
  const homey = quietHomey();
  const s = new StationSession(homey, 'ST1');
  const device = {
    available: true, reasons: [], polls: [],
    getName: () => 'LUNA2000',
    getSetting: (k) => ({ username: 'u', system_code: 'c', poll_interval: 5 }[k] ?? null),
    getDevTypes: () => [BATTERY, METER],
    onPollData: async (p) => { device.polls.push(p); },
    getAvailable: () => device.available,
    setAvailable: async () => { device.available = true; },
    setUnavailable: async (r) => { device.available = false; device.reasons.push(r); },
  };
  s.addDevice(device);
  s._ensureDevIds = async () => { s._devIdsByType = { [BATTERY]: ['b1'], [METER]: ['m1'] }; };
  s._interRequestDelayMs = 0;
  s._calls = 0;
  s._answers = [];
  s._withAutoRelogin = async () => {
    s._calls++;
    const a = s._answers.shift();
    if (a instanceof Error) throw a;
    return a;
  };
  return { s, device, homey };
}
const kpi = (v) => ({ devices: [{ dataItemMap: { v } }] });

// ── 2. a pause holds the poll ────────────────────────────────────────────────────

test('a pause holds every call, with a session open too', async () => {
  const { s, homey } = plant();
  s._token = 'open-session';
  s.pausePolling(5 * 60_000);                           // a diagnostic run, or a 407
  await s._poll();
  assert.strictEqual(s._calls, 0, 'polled straight through the pause');
  assert.ok(homey.logs.some((l) => /polling paused for 5 more minute/.test(l)));

  s._backoffUntil = Date.now() - 1;                     // the pause is over
  s._answers = [{ kpi: { day_power: 1 } }, kpi(1), kpi(2)];
  await s._poll();
  assert.strictEqual(s._calls, 3);
});

test('a type refused for frequency is not asked again at once with its type as a string', async () => {
  const requests = [];
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'https') {
      return {
        request(options, onResponse) {
          const req = new EventEmitter();
          let body = '';
          req.write = (p) => { body += p; };
          req.end = () => {
            requests.push(JSON.parse(body));
            const res = new EventEmitter();
            res.headers = {};
            onResponse(res);
            res.emit('data', JSON.stringify({ success: false, failCode: 407, data: null }));
            res.emit('end');
          };
          return req;
        },
      };
    }
    return origLoad.call(this, request, parent, isMain);
  };
  const clientPath = require.resolve('../lib/openapi-client');
  delete require.cache[clientPath];
  try {
    const { getDevRealKpi } = require('../lib/openapi-client');
    const r = await getDevRealKpi('https://eu5.fusionsolar.huawei.com', 't', ['b1'], 39);
    assert.strictEqual(requests.length, 1, `${requests.length} calls for one refused type`);
    assert.strictEqual(r.failCode, 407);
    assert.deepStrictEqual(r.devices, []);
  } finally {
    Module._load = origLoad;
    delete require.cache[clientPath];
  }
});

// ── 3. one timeout ───────────────────────────────────────────────────────────────

test('one timed-out call skips the rest of the cycle; the cache bridges it and nothing goes offline', async () => {
  const { s, device } = plant();
  // A good cycle first, so there is something to bridge with.
  s._answers = [{ kpi: { day_power: 1 } }, kpi('bat'), kpi('meter')];
  await s._poll();
  assert.strictEqual(device.available, true);

  s._lastPollAt = 0;
  s._calls = 0;
  s._answers = [{ kpi: { day_power: 2 } }, new Error('Request timed out')];
  await s._poll();

  assert.strictEqual(device.available, true, `every device went offline: ${device.reasons.join(' | ')}`);
  assert.strictEqual(s._calls, 2, 'it went on calling after the timeout');
  const last = device.polls[device.polls.length - 1];
  assert.ok(last, 'the devices got nothing at all this cycle');
  assert.deepStrictEqual(last.kpiByType[BATTERY], [{ v: 'bat' }], 'the cache did not bridge the timed-out type');
  assert.deepStrictEqual(last.kpiByType[METER], [{ v: 'meter' }], 'the cache did not bridge the type never asked');
});

test('a gateway page that is not JSON is bridged the same way; a refused login is not', async () => {
  const { s, device } = plant();
  s._answers = [{ kpi: { day_power: 1 } }, kpi('bat'), kpi('meter')];
  await s._poll();

  s._lastPollAt = 0;
  s._answers = [new Error('Failed to parse response: Unexpected token <. Server returned: <html>502</html>')];
  await s._poll();
  assert.strictEqual(device.available, true);

  s._lastPollAt = 0;
  s._answers = [new Error('Login failed (20001): wrong system code')];
  await s._poll();
  assert.strictEqual(device.available, false, 'a refused login has nothing to bridge — the device must say so');
  assert.match(device.reasons[device.reasons.length - 1], /Login failed/);
});

test('every cloud driver hands the new station code over — its own setting is still the old one', () => {
  const fs = require('fs');
  const path = require('path');
  const drivers = fs.readdirSync(path.join(__dirname, '..', 'drivers')).filter((d) => /openapi_fusionsolar$/.test(d));
  assert.ok(drivers.length >= 7, `only ${drivers.length} cloud drivers found`);
  for (const d of drivers) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'drivers', d, 'device.js'), 'utf8');
    if (!src.includes('reregister(')) continue;
    assert.match(src, /reregister\(this, oldCode, newSettings\.station_code\)/, `${d} lets the coordinator read the stale setting`);
  }
});
