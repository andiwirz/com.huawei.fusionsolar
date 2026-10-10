'use strict';

// Two small findings from the review of 2026-10-10 (1.2.318).
//
//   1. Where daylight saving starts AT midnight — Chile, the Azores, Cuba — local 00:00 does
//      not exist on that day. lib/local-time.js placed it at 23:00 of the evening before, so
//      "the next midnight" lay in the past: the midnight timer fired at 23:00, wrote the day's
//      baselines an hour early, and rescheduled itself with a delay of zero or less, about
//      1.8 million times until 01:00.
//   2. Pairing a kiosk device wrote its share token (kk) to the app log in full; that token
//      alone gives read access to the plant's kiosk data.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const Module = require('module');

const L = require('../lib/local-time.js');

// The three zones whose clocks jump from 23:59:59 to 01:00, on their 2026 dates.
const JUMPS = [
  // zone, the day, the instant the clocks jump (= 01:00 local, the first moment of that day)
  ['America/Santiago', [2026, 9, 6], '2026-09-06T04:00:00Z'],
  ['Atlantic/Azores',  [2026, 3, 29], '2026-03-29T01:00:00Z'],
  ['America/Havana',   [2026, 3, 8], '2026-03-08T05:00:00Z'],
];

test('a midnight the clocks jump over is the moment they jump — not 23:00 the evening before', () => {
  for (const [tz, [y, m, d], jump] of JUMPS) {
    const t = L.localToEpoch(tz, y, m, d);
    assert.strictEqual(new Date(t).toISOString(), new Date(jump).toISOString(), tz);
    const p = L.localParts(tz, t);
    assert.deepStrictEqual([p.d, p.hh], [d, 1], `${tz}: "midnight" lands on ${p.d}. ${p.hh}:00`);
  }
});

test('the next midnight is never in the past, and the day starts when the clocks jump', () => {
  for (const [tz, [y, m, d], jump] of JUMPS) {
    const evening = Date.parse(jump) - 30 * 60_000;               // half an hour before the jump
    const next = L.nextLocalMidnight(tz, evening);
    assert.ok(next > evening, `${tz}: the next midnight lies ${(evening - next) / 60_000} min in the past`);
    assert.strictEqual(next, Date.parse(jump));
    const noon = Date.parse(jump) + 11 * 3600_000;
    assert.strictEqual(L.startOfLocalDay(tz, noon), Date.parse(jump), `${tz}: start of the day`);
    // and the day after is an ordinary one again
    const nextDay = L.nextLocalMidnight(tz, noon);
    const q = L.localParts(tz, nextDay);
    assert.deepStrictEqual([q.hh, q.mi], [0, 0]);
  }
});

test('every wall time that does exist still comes back to itself, in these zones and in Zurich', () => {
  for (const tz of ['America/Santiago', 'Atlantic/Azores', 'America/Havana', 'Europe/Zurich']) {
    for (let day = 1; day <= 28; day += 3) {
      for (const month of [1, 3, 4, 9, 10, 11]) {
        for (const hh of [0, 3, 12, 23]) {
          const t = L.localToEpoch(tz, 2026, month, day, hh, 15);
          const p = L.localParts(tz, t);
          // 00:15 may not exist on a jump day; then it is the jump, 01:00, and is checked above.
          if (p.hh === 1 && hh === 0 && p.mi === 0) continue;
          assert.deepStrictEqual([p.y, p.m, p.d, p.hh, p.mi], [2026, month, day, hh, 15], `${tz} ${day}.${month}. ${hh}:15`);
        }
      }
    }
  }
});

test('the midnight timer runs once a day across a jump at midnight — no burst of timers', () => {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'homey') return { App: class {}, Device: class {}, Driver: class {} };
    return origLoad.call(this, request, parent, isMain);
  };
  const App = require('../app.js');
  Module._load = origLoad;
  const app = Object.create(App.prototype);
  app._getHomeyTz = () => 'America/Santiago';

  let now = Date.parse('2026-09-05T20:00:00-04:00');               // Saturday evening
  const fired = [];
  for (let i = 0; i < 5; i++) {
    const delay = app._msUntilLocalMidnight(now);
    assert.ok(delay >= 60_000, `a delay of ${delay} ms — the timer would refire at once`);
    now += delay;
    fired.push(new Date(now).toISOString());
  }
  // Once on the jump (04:00Z + 5 s), then at each following local midnight (UTC−3 from then on).
  assert.deepStrictEqual(fired.slice(0, 3), [
    '2026-09-06T04:00:05.000Z', '2026-09-07T03:00:05.000Z', '2026-09-08T03:00:05.000Z',
  ]);
});

test('pairing a kiosk logs only the end of its share token', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'drivers', 'fusionsolar_kiosk', 'driver.js'), 'utf8');
  assert.ok(!/kk=\$\{kk\}/.test(src), 'the whole kk token still goes to the log');
  assert.match(src, /kk=…\$\{String\(kk\)\.slice\(-4\)\}/);
  // and nowhere else in the kiosk code is it logged
  for (const f of ['drivers/fusionsolar_kiosk/device.js', 'lib/kiosk-api.js']) {
    const s = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/(log|error)\([^)]*\$\{kk\}/.test(s), `${f} logs the token`);
  }
});

test('a midnight less than a minute away is waited for a whole minute — never a zero delay', () => {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'homey') return { App: class {}, Device: class {}, Driver: class {} };
    return origLoad.call(this, request, parent, isMain);
  };
  const App = require('../app.js');
  Module._load = origLoad;
  const app = Object.create(App.prototype);
  app._getHomeyTz = () => 'Europe/Zurich';
  // 30 s before midnight: 35 s to wait, raised to the floor; the timer then fires at 00:00:30.
  assert.strictEqual(app._msUntilLocalMidnight(Date.parse('2026-10-09T23:59:30+02:00')), 60_000);
  // an ordinary evening is untouched
  assert.strictEqual(app._msUntilLocalMidnight(Date.parse('2026-10-09T22:00:00+02:00')), 2 * 3600_000 + 5000);
});
