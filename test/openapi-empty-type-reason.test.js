'use strict';

// Why a device type came back empty. Run: node --test
//
// Issue #28. A LUNA2000 that FusionSolar shows with a live state of charge — 19 % at 23:02,
// with the EMMA answering normally in the same minute — while getDevRealKpi(type=39) returns
// no device at all. The app could only report "0 device(s)", which reads the same whether
// Huawei is refusing the device, has never heard of the id, or has nothing to say right now.
// Several rounds of the issue went into deducing what the API had probably been saying all
// along and we were dropping.
//
// The client makes two attempts — numeric devTypeId, then the string form, because some
// FusionSolar servers only accept one of them — so "which failure" is a real question. The
// tests below pin the answer to each combination.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

// Canned responses, consumed in order by the stubbed https.request.
let queue = [];
let sent  = [];

function fakeRequest(options, onResponse) {
  const req = new EventEmitter();
  req.write = (payload) => { sent.push({ options, payload: JSON.parse(payload) }); };
  req.end = () => {
    const body = queue.shift() ?? { success: false, failCode: 999, message: 'test ran out of responses' };
    const res = new EventEmitter();
    res.headers = {};
    // Asynchronously, the way a socket delivers: a synchronous emit would fire before the
    // client has attached its listeners and the promise would never settle.
    setImmediate(() => {
      res.emit('data', JSON.stringify(body));
      res.emit('end');
    });
    onResponse(res);
  };
  req.destroy = () => {};
  return req;
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'https') return { request: fakeRequest };
  return origLoad.call(this, request, parent, isMain);
};
const { getDevRealKpi } = require(path.join('..', 'lib', 'openapi-client.js'));
Module._load = origLoad;

const call = async (...responses) => {
  queue = [...responses];
  sent  = [];
  return getDevRealKpi('https://eu5.fusionsolar.huawei.com', 'tok', ['1002'], 39);
};

const OK   = (rows) => ({ success: true, data: rows });
const FAIL = (failCode, message) => ({ success: false, failCode, message });

test('a device with data reports no failure, and does not retry', async () => {
  const r = await call(OK([{ devId: 1002, dataItemMap: { battery_soc: 19 } }]));
  assert.strictEqual(r.devices.length, 1);
  assert.strictEqual(r.failCode, null);
  assert.strictEqual(r.failMessage, null);
  assert.strictEqual(sent.length, 1, 'the string-devTypeId retry ran even though the first attempt worked');
});

// The reporter's case: the API says yes and hands back nothing.
test('an empty but successful answer is reported as having no failure code', async () => {
  const r = await call(OK([]), OK([]));
  assert.deepStrictEqual(r.devices, []);
  assert.strictEqual(r.failCode, null,
    'a code was invented for an answer that carried none');
  assert.strictEqual(r.expired, false);
  assert.strictEqual(sent.length, 2, 'the string retry was skipped, so a server that needs it gets nothing');
});

test("the retry's failure code is what comes back", async () => {
  const r = await call(OK([]), FAIL(20001, 'Permission denied'));
  assert.strictEqual(r.failCode, 20001);
  assert.strictEqual(r.failMessage, 'Permission denied',
    'the caller still has to guess why a device type is empty');
  assert.deepStrictEqual(r.devices, []);
});

// A known code is translated; the mapping is what turns a number into something a user can
// act on. 20009 is the one a silent device type is most likely to carry.
test('a known code is given its plain-language message', async () => {
  const r = await call(OK([]), FAIL(20009, null));
  assert.strictEqual(r.failCode, 20009);
  assert.strictEqual(r.failMessage, 'No data available');
});

test("an unknown code keeps Huawei's own wording rather than being swallowed", async () => {
  const r = await call(OK([]), FAIL(31415, 'Something specific from Huawei'));
  assert.strictEqual(r.failCode, 31415);
  assert.strictEqual(r.failMessage, 'Something specific from Huawei');
});

// The first attempt is the one that explains why a retry was needed. Losing it would hide
// the case where the numeric form is rejected and the string form merely returns nothing.
test('where only the first attempt complained, its code is the one reported', async () => {
  const r = await call(FAIL(20001, 'Permission denied'), OK([]));
  assert.strictEqual(r.failCode, 20001);
  assert.strictEqual(r.failMessage, 'Permission denied');
  assert.deepStrictEqual(r.devices, []);
});

test('a retry that succeeds with data reports no failure, even after a first-attempt error', async () => {
  const r = await call(FAIL(20009, null), OK([{ devId: 1002, dataItemMap: { battery_soc: 19 } }]));
  assert.strictEqual(r.devices.length, 1);
  assert.strictEqual(r.failCode, null,
    'a successful reading is labelled with the failure that preceded it');
});

// Session expiry has its own path, and the caller re-logs in on it. It must keep saying so,
// and now also carry the code rather than only the flag.
test('an expired session still reports as expired, and names the code', async () => {
  const r = await call(FAIL(305, null));
  assert.strictEqual(r.expired, true);
  assert.strictEqual(r.failCode, 305);
  assert.strictEqual(r.failMessage, 'Session expired');
  assert.strictEqual(sent.length, 1, 'it retried instead of re-logging in');
});

test('an expired session on the retry is still an expiry, not a plain failure', async () => {
  const r = await call(OK([]), FAIL(306, null));
  assert.strictEqual(r.expired, true, 'the poll will not re-login, so the type stays empty for good');
  assert.strictEqual(r.failCode, 306);
});

// ── The two places the reason has to surface ─────────────────────────────────

const fs  = require('fs');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('the diagnostic report prints the reason beside the device count', () => {
  const src = read('api.js');
  const block = src.slice(src.indexOf('const why = r.kpiDevices.length === 0'),
                         src.indexOf('device(s)${why}') + 40);
  assert.ok(block, 'the diagnostic no longer builds a reason at all');
  assert.match(block, /failCode \$\{r\.failCode\}/,
    'the code is dropped again, so a report still reads only "0 device(s)"');
  assert.match(block, /answered successfully with an empty list/,
    'an answer that carried no code says nothing about that, which reads as a bug in us');
  assert.match(src, /\.then\(\(\{ devices: kpiDevices, failCode, failMessage \}\)/,
    'the reason is not destructured out of the client result, so it can never be printed');
});

test('the coordinator logs the reason once per reason, not once per poll', () => {
  const src = read('lib', 'openapi-coordinator.js');
  assert.match(src, /this\._loggedEmptyReason\[typeId\] !== reason/,
    'an empty type logs on every poll — 288 identical lines a day at a 5-minute interval');
  assert.match(src, /delete this\._loggedEmptyReason\[typeId\];/,
    'a type that recovers keeps its old reason, so the next dry spell is suppressed');
  assert.match(src, /No devices for type \$\{typeId\} — \$\{reason\}/,
    'the log line no longer names the type or the reason');
});
