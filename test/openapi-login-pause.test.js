'use strict';

// The login pause after a rate limit ends (1.2.313, review of 2026-10-10).
//
// A login refused with 407 pauses logging in for 15 minutes. While the pause runs,
// _ensureToken refuses with "Rate limited — login paused for N more minute(s)" — and the catch
// in _poll paused for 15 minutes on anything that reads "Rate limit". So every poll inside the
// pause started the pause again; at a 5- or 10-minute interval it never ended, and every cloud
// device of the plant stayed offline until the app restarted. Saving the credentials again did
// not help either. Simulated in the review: after one refused login, twelve polls ten minutes
// apart made no further login at all.
//
// These run the real StationSession against a stubbed FusionSolar client and a clock that the
// test moves. Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const Module = require('module');

let loginAnswers = [];          // what each login does: 'ok' or an Error to throw
let logins = 0;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './openapi-client') {
    const real = origLoad.call(this, request, parent, isMain);
    return {
      ...real,
      login: async () => {
        logins++;
        const next = loginAnswers.shift();
        if (next instanceof Error) throw next;
        return 'token-' + logins;
      },
      // the poll goes no further than the first call after a login — enough to see it ran
      getStationRealKpi: async () => { throw new Error('test: stop after the login'); },
    };
  }
  return origLoad.call(this, request, parent, isMain);
};
const { StationSession } = require('../lib/openapi-coordinator');
Module._load = origLoad;

const MIN = 60_000;
const REFUSED = () => new Error('Login failed (407): Rate limit exceeded — too many API calls, please reduce poll frequency');

function plant() {
  const logs = [];
  const homey = {
    log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push('ERROR ' + a.join(' ')),
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  };
  const s = new StationSession(homey, 'ST1');
  const device = {
    reasons: [], available: true,
    getName: () => 'SUN2000',
    getSetting: (k) => ({ username: 'u', system_code: 'c', poll_interval: 5 }[k] ?? null),
    getDevTypes: () => [1],
    onPollData: async () => {},
    getAvailable: () => device.available,
    setAvailable: async () => { device.available = true; },
    setUnavailable: async (r) => { device.available = false; device.reasons.push(r); },
  };
  s.addDevice(device);
  return { s, device, logs };
}

// A clock the test moves; the poll reads Date.now() for both its gap guard and the pause.
let clock = Date.UTC(2026, 9, 10, 12, 0, 0);
const realNow = Date.now;
test.before(() => { Date.now = () => clock; });
test.after(() => { Date.now = realNow; });
const at = async (s, minutes, t0) => { clock = t0 + minutes * MIN; await s._poll(); };

test('the pause after a refused login ends — every poll inside it no longer starts it again', async () => {
  logins = 0; loginAnswers = [REFUSED(), 'ok'];
  const { s, device } = plant();
  const t0 = clock;

  await at(s, 0, t0);                                   // the refused login: paused until +15
  assert.strictEqual(logins, 1);
  const until = s._backoffUntil;
  assert.strictEqual(until, t0 + 15 * MIN);

  for (const m of [5, 10]) {                            // polls inside the pause
    await at(s, m, t0);
    assert.strictEqual(s._backoffUntil, until, `the poll at +${m} min moved the end of the pause`);
  }
  assert.strictEqual(logins, 1, 'logged in during the pause');
  assert.match(device.reasons[device.reasons.length - 1], /login paused for \d+ more minute/,
    'the device does not say why it is offline');

  await at(s, 15, t0);                                  // due: one login, and it works
  assert.strictEqual(logins, 2, 'the pause never ended — no login after it was due');
  assert.strictEqual(s._token, 'token-2');
});

test('the review\'s case: a 10-minute interval for two hours', async () => {
  logins = 0; loginAnswers = [REFUSED(), 'ok'];
  const { s } = plant();
  const t0 = clock + 24 * 60 * MIN;
  for (let m = 0; m <= 120; m += 10) await at(s, m, t0);
  assert.strictEqual(logins, 2, `${logins} logins in two hours — the first one after the pause never came`);
});

test('a login refused again after the pause pauses again — for 15 minutes from then', async () => {
  logins = 0; loginAnswers = [REFUSED(), REFUSED(), 'ok'];
  const { s } = plant();
  const t0 = clock + 48 * 60 * MIN;
  await at(s, 0, t0);
  await at(s, 15, t0);                                  // refused again
  assert.strictEqual(logins, 2);
  assert.strictEqual(s._backoffUntil, t0 + 30 * MIN);
  await at(s, 20, t0); await at(s, 25, t0);
  assert.strictEqual(logins, 2);
  await at(s, 30, t0);
  assert.strictEqual(logins, 3);
});
