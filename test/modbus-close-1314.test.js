'use strict';

// How a Modbus connection ends (1.3.14, logs 39715fcb and 06618e47).
//
// The same EMMA reported twice: from the second poll on, every connection was accepted and
// closed again before the first reply — what the EMMA does to a client it will not serve —
// and only an app restart helped. The owner's own client, holding one connection, ran for
// hours. After a read the app sends a FIN and waits a second for the device to close too;
// if it did not, the socket was left behind, open, until the process ended — on a device
// with one client slot, that slot. Now it is reset, the log says once per host which way the
// device behaves, a lost connection ends the poll instead of one failure line per register,
// and the back-off names the failure that started it.
//
// Run: node --test

const Module = require('module');
const _origLoad = Module._load;
let _fakeRead = null;
const setFakeRead = (fn) => { _fakeRead = fn; };
Module._load = function (request, parent, isMain) {
  if (request === 'jsmodbus') {
    return {
      client: {
        TCP: class {
          async readHoldingRegisters(start, count) {
            if (!_fakeRead) throw new Error('no read handler installed');
            return _fakeRead(start, count);
          }
        },
      },
    };
  }
  return _origLoad.call(this, request, parent, isMain);
};

const test   = require('node:test');
const assert = require('node:assert');
const net    = require('net');
const path   = require('path');
const modbus = require('../lib/modbus-client.js');
Module._load = _origLoad;

const { readRegisters, unavailableMessage } = modbus;
const en = require(path.join('..', 'locales', 'en.json'));
const homey = { __: (k) => k.split('.').reduce((o, p) => o[p], en) };

const REGS = { a: [100, 1, 'UINT16', '', 0] };
const answer = (start, count) => {
  const buf = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) buf.writeUInt16BE((start + i) & 0xFFFF, i * 2);
  return { response: { body: { valuesAsBuffer: buf } } };
};
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// How a torn-down connection shows on the device's side: Linux says ECONNRESET or EPIPE,
// Windows ECONNABORTED.
const TORN_DOWN = new Set(['ECONNRESET', 'ECONNABORTED', 'EPIPE']);

// A Modbus server stand-in. `closes: false` is the device that never closes its side: with
// allowHalfOpen our FIN arrives as 'end' and nothing more happens. Such a device can still
// write, so it keeps writing a byte every 100 ms — the write fails once the app has reset the
// connection, which makes the reset visible on every platform (a socket that has stopped
// reading after 'end' may never hear of it otherwise). Before 1.3.14 those writes simply
// went into the app's half-open socket, for good.
async function withServer({ closes }, fn) {
  const seen = { conns: 0, fins: 0, resets: 0, closed: 0 };
  const socks = new Set();
  const srv = net.createServer({ allowHalfOpen: !closes }, (s) => {
    seen.conns += 1;
    socks.add(s);
    s.on('end', () => { seen.fins += 1; });
    s.on('error', (e) => { if (TORN_DOWN.has(e.code)) seen.resets += 1; });
    s.on('close', () => { seen.closed += 1; socks.delete(s); });
    if (!closes) {
      const probe = setInterval(() => { if (!s.destroyed) s.write(Buffer.from([0])); }, 100);
      s.once('close', () => clearInterval(probe));
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  modbus.resetModbusBackoff('127.0.0.1', port);
  try { return await fn(port, seen); } finally {
    modbus.resetModbusBackoff('127.0.0.1', port);
    for (const s of socks) s.destroy(); // a connection left open must not hang the test
    await new Promise((r) => srv.close(r));
  }
}

async function waitFor(cond, ms = 2000) {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) await tick(25);
}

function captureLog() {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  return { lines, restore: () => { console.log = orig; } };
}

test('a device that does not close its side is reset, not left holding the connection — and the log says so once', async () => {
  modbus._resetStaticCache();
  setFakeRead(answer);
  const log = captureLog();
  try {
    await withServer({ closes: false }, async (port, seen) => {
      const res = await modbus.readModbusRegisters('127.0.0.1', port, 0, REGS);
      assert.strictEqual(res.a, 100, 'the read itself still works');
      await waitFor(() => seen.closed === 1);
      assert.strictEqual(seen.fins, 1, 'the app no longer says goodbye with a FIN first');
      assert.strictEqual(seen.resets, 1, 'the connection was left open on the device');
      assert.strictEqual(seen.closed, 1);

      await modbus.readModbusRegisters('127.0.0.1', port, 0, REGS);
      await waitFor(() => seen.closed === 2);
      assert.strictEqual(seen.resets, 2, 'every connection, not only the first');
      const notes = log.lines.filter((l) => l.includes('did not close its side'));
      assert.deepStrictEqual(notes, [
        `[modbus] 127.0.0.1:${port} did not close its side of the connection within 1000 ms — reset (TCP RST), so it does not keep holding a connection slot`,
      ], 'once per host, not on every poll');
    });
  } finally { log.restore(); setFakeRead(null); }
});

test('a device that closes its side is left to do so: no reset, and one line saying it closes', async () => {
  modbus._resetStaticCache();
  setFakeRead(answer);
  const log = captureLog();
  try {
    await withServer({ closes: true }, async (port, seen) => {
      await modbus.readModbusRegisters('127.0.0.1', port, 0, REGS);
      await modbus.readModbusRegisters('127.0.0.1', port, 0, REGS);
      await tick(100);
      assert.strictEqual(seen.resets, 0, 'a device that closes properly was reset all the same');
      assert.strictEqual(seen.closed, 2);
      const notes = log.lines.filter((l) => l.includes(`127.0.0.1:${port}`) && l.includes('its side'));
      assert.strictEqual(notes.length, 1, notes.join('\n'));
      assert.match(notes[0], new RegExp(`^\\[modbus\\] 127\\.0\\.0\\.1:${port} closes its side of the connection after \\d+ ms$`));
    });
  } finally { log.restore(); setFakeRead(null); }
});

test('a device that closes one connection and keeps the next gets a line for each', async () => {
  modbus._resetStaticCache();
  setFakeRead(answer);
  const log = captureLog();
  let n = 0;
  const srv = net.createServer({ allowHalfOpen: true }, (s) => {
    const first = ++n === 1;
    s.on('error', () => {});
    s.on('end', () => { if (first) s.end(); }); // the first is closed properly, the second not
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    await modbus.readModbusRegisters('127.0.0.1', port, 0, REGS);
    await modbus.readModbusRegisters('127.0.0.1', port, 0, REGS);
    const notes = log.lines.filter((l) => l.includes(`127.0.0.1:${port}`) && l.includes('its side'));
    assert.strictEqual(notes.length, 2, notes.join('\n'));
    assert.match(notes[0], /closes its side/);
    assert.match(notes[1], /did not close its side/);
  } finally {
    log.restore();
    setFakeRead(null);
    modbus.resetModbusBackoff('127.0.0.1', port);
    await new Promise((r) => { srv.close(r); setTimeout(r, 500); });
  }
});

test('a failed poll resets the connection too', async () => {
  modbus._resetStaticCache();
  setFakeRead(() => { throw new Error('Req timed out'); }); // a silent device: no retry, one connection
  try {
    await withServer({ closes: false }, async (port, seen) => {
      await assert.rejects(modbus.readModbusRegisters('127.0.0.1', port, 0, REGS), (err) => err.modbusSilent === true);
      await waitFor(() => seen.closed === 1);
      assert.strictEqual(seen.resets, 1, 'the failed poll left its connection open on the device');
    });
  } finally { setFakeRead(null); }
});

test('a lost connection ends the poll: what was read stays, the rest is "not read", one log line', async () => {
  modbus._resetStaticCache();
  const asked = [];
  const client = {
    async readHoldingRegisters(start, count) {
      asked.push(start);
      if (asked.length > 1) throw new Error('connection to modbus server closed');
      return answer(start, count);
    },
  };
  // three spans far apart; the socket dies on the second, a batch of two
  const regs = {
    a: [100, 1, 'UINT16', '', 0],
    b: [300, 1, 'UINT16', '', 0], b2: [301, 1, 'UINT16', '', 0],
    c: [600, 1, 'UINT16', '', 0],
  };
  const log = captureLog();
  let out;
  try { out = await readRegisters(regs, client); } finally { log.restore(); }
  assert.deepStrictEqual(asked, [100, 300], 'requests went on after the socket was gone');
  assert.strictEqual(out.a, 100, 'the register read before the hang-up was thrown away');
  assert.deepStrictEqual([out.b, out.b2, out.c], [null, null, null]);
  for (const name of ['b', 'b2', 'c']) {
    assert.ok(modbus.notRead(out, name), `${name} must count as not read, not as absent`);
  }
  assert.ok(!modbus.notRead(out, 'a'));
  assert.deepStrictEqual(log.lines.filter((l) => l.startsWith('[modbus] ') && !l.includes('read plan')), [
    '[modbus] batch 300/2 (2 registers) failed: connection to modbus server closed — connection lost, rest of this poll not read',
  ]);
});

test('the back-off names the failure that started it, and the tile keeps saying what happened', async () => {
  modbus._resetStaticCache();
  setFakeRead(() => { throw new Error('connection to modbus server closed'); }); // accepted, then hung up
  try {
    await withServer({ closes: true }, async (port) => {
      const poll = () => modbus.readModbusRegisters('127.0.0.1', port, 0, REGS);
      for (let i = 0; i < 3; i++) await assert.rejects(poll(), (err) => err.modbusConnectionLost === true);
      await assert.rejects(poll(), (err) => {
        assert.strictEqual(err.message, `127.0.0.1:${port} failed 3 polls in a row — backing off, will retry shortly (last: Modbus connection closed before any register could be read)`);
        assert.strictEqual(err.modbusBackoff, true);
        assert.strictEqual(unavailableMessage(homey, err, '127.0.0.1'), en.modbus.errors.host.closed.replace('{{host}}', '127.0.0.1'),
          'the tile went back to a generic "fetch failed" while the breaker was open');
        return true;
      });
    });
  } finally { setFakeRead(null); }
});

test('the back-off after refused connections says refused', async () => {
  modbus._resetStaticCache();
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r)); // nothing listens there any more
  modbus.resetModbusBackoff('127.0.0.1', port);
  try {
    const poll = () => modbus.readModbusRegisters('127.0.0.1', port, 0, REGS);
    for (let i = 0; i < 3; i++) await assert.rejects(poll(), /ECONNREFUSED/);
    await assert.rejects(poll(), (err) => {
      assert.match(err.message, /backing off, will retry shortly \(last: Socket error: connect ECONNREFUSED/);
      assert.strictEqual(err.modbusConnectionLost, undefined);
      assert.strictEqual(unavailableMessage(homey, err, '127.0.0.1'), en.modbus.errors.host.refused.replace('{{host}}', '127.0.0.1'));
      return true;
    });
  } finally { modbus.resetModbusBackoff('127.0.0.1', port); }
});

test('no reset while a socket is still connecting, and none for one that is gone', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'lib', 'modbus-client.js'), 'utf8');
  const connect = src.slice(src.indexOf('function _connect('), src.indexOf('function writeModbusRegister('));
  assert.match(connect, /const connectTimeout = setTimeout\(\(\) => \{\n\s+socket\.destroy\(\);/,
    'the connect timeout must destroy: resetAndDestroy on a connecting socket waits for the connection');
  assert.strictEqual((connect.match(/_abortSocket\(socket\)/g) || []).length, 2, 'the finished and the failed poll both reset');
  let called = false;
  const gone = { destroyed: true, resetAndDestroy() { called = true; }, destroy() { called = true; } };
  const abort = src.match(/function _abortSocket\(socket\) \{[\s\S]*?\n\}/)[0];
  // eslint-disable-next-line no-new-func
  const fn = new Function(`${abort}; return _abortSocket;`)();
  assert.strictEqual(fn(gone), 'gone');
  assert.strictEqual(called, false);
  const old = { destroyed: false, destroy() { called = true; } }; // a Node without resetAndDestroy
  assert.strictEqual(fn(old), 'destroyed');
  assert.strictEqual(called, true);
});

test('the release: a changelog entry 1.3.14 in all three languages, without Home Assistant', () => {
  const fs = require('fs');
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8'));
  assert.ok(app.version.split('.').map(Number).reduce((a, n) => a * 1000 + n, 0) >= 1003014, `version ${app.version} is older than the fix`);
  const entry = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.homeychangelog.json'), 'utf8'))['1.3.14'];
  for (const lang of ['en', 'de', 'nl']) {
    assert.ok(entry && entry[lang], `${lang} missing`);
    assert.ok(!/Home.?Assistant|\bHA\b/.test(entry[lang]));
  }
  assert.ok(!/ß/.test(entry.de));
});
