'use strict';

// Unit tests for the Modbus read path. Run: node --test
//
// This layer talks to every Modbus driver in the app. The fake client below answers
// readHoldingRegisters(start, count) from a synthetic memory image, which lets us assert
// the decoded values and the exact requests issued.
//
// Batched (multi-register) reads were tried in v1.2.47 and reverted — the SDongle gateway
// rejects them, see lib/modbus-client.js. These tests therefore assert one request per
// register, plus the behaviour that has to hold whatever the transport does.
const Module = require('module');
const _origLoad = Module._load;

// Tests that only care about timing or connection counts leave this null, so every read
// fails — which is what they want. The cache tests install a handler to get real values back.
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
const { readRegisters, parseBuffer, buildReadPlan } = require('../lib/modbus-client.js');

// A device whose register N holds the value N, so a correctly sliced read is trivially
// verifiable: whatever address we ask for must come back as that address.
function fakeClient({ memory = null, failSpans = [], deadAddresses = [], record = [] } = {}) {
  return {
    calls: record,
    async readHoldingRegisters(start, count) {
      record.push({ start, count });
      if (failSpans.some(([s, c]) => s === start && c === count)) {
        throw new Error(`simulated failure at ${start}/${count}`);
      }
      // Real hardware refuses the whole request if any address in it is unreadable —
      // not just one exact span. Bisection has to cope with that.
      for (let i = 0; i < count; i++) {
        if (deadAddresses.includes(start + i)) throw new Error(`illegal data address ${start + i}`);
      }
      const buf = Buffer.alloc(count * 2);
      for (let i = 0; i < count; i++) {
        const addr = start + i;
        const v = memory ? (memory[addr] ?? 0) : addr;
        buf.writeUInt16BE(v & 0xFFFF, i * 2);
      }
      return { response: { body: { valuesAsBuffer: buf } } };
    },
  };
}

// ── buildReadPlan ────────────────────────────────────────────────────────────
test('readRegisters — batched values are identical to reading each register alone', async () => {
  const regs = {
    u16:  [100, 1, 'UINT16', '', 0],
    i16:  [101, 1, 'INT16',  '', 0],
    u32:  [102, 2, 'UINT32', '', 0],
    far:  [400, 1, 'UINT16', '', 0],
  };
  const memory = { 100: 1234, 101: 0xFFFF /* -1 */, 102: 0x0001, 103: 0x0000, 400: 77 };
  const out = await readRegisters(regs, fakeClient({ memory }));
  assert.strictEqual(out.u16, 1234);
  assert.strictEqual(out.i16, -1);          // signed decoding survives the slicing
  assert.strictEqual(out.u32, 0x00010000);  // 32-bit value spanning two words
  assert.strictEqual(out.far, 77);
});

test('readRegisters — applies decimalPower scaling exactly as before', async () => {
  const out = await readRegisters(
    { soc: [100, 1, 'UINT16', '', -1], kwh: [101, 1, 'UINT16', '', -2] },
    fakeClient({ memory: { 100: 505, 101: 12345 } }),
  );
  assert.strictEqual(out.soc, 50.5);
  assert.strictEqual(out.kwh, 123.45);
});

test('readRegisters — one unreadable address only costs itself, neighbours still resolve', async () => {
  const regs = { a: [100, 1, 'UINT16', '', 0], bad: [101, 1, 'UINT16', '', 0], c: [102, 1, 'UINT16', '', 0] };
  // 101 is unreadable in ANY span it appears in, exactly as a real inverter behaves.
  const out = await readRegisters(regs, fakeClient({ deadAddresses: [101] }));
  assert.strictEqual(out.a, 100);
  assert.strictEqual(out.bad, null);   // only this one is lost
  assert.strictEqual(out.c, 102);      // bisection still recovers its neighbours
});

test('readRegisters — every requested name is present even when nothing can be read', async () => {
  const client = { async readHoldingRegisters() { throw new Error('device offline'); } };
  const out = await readRegisters({ a: [100, 1, 'UINT16', '', 0], b: [200, 1, 'UINT16', '', 0] }, client);
  assert.deepStrictEqual(out, { a: null, b: null });
});

test('readRegisters — a short response falls back instead of decoding garbage', async () => {
  // Returns fewer words than requested — must not be sliced into bogus values.
  const client = {
    n: 0,
    async readHoldingRegisters(start, count) {
      this.n++;
      const words = this.n === 1 ? 1 : count;           // first (batched) reply is truncated
      const buf = Buffer.alloc(words * 2);
      for (let i = 0; i < words; i++) buf.writeUInt16BE((start + i) & 0xFFFF, i * 2);
      return { response: { body: { valuesAsBuffer: buf } } };
    },
  };
  const out = await readRegisters({ a: [100, 1, 'UINT16', '', 0], b: [101, 1, 'UINT16', '', 0] }, client);
  assert.deepStrictEqual(out, { a: 100, b: 101 });
});

test('readRegisters — shouldAbort stops the loop early (a write is waiting)', async () => {
  const regs = { a: [100, 1, 'UINT16', '', 0], b: [500, 1, 'UINT16', '', 0], c: [900, 1, 'UINT16', '', 0] };
  const record = [];
  let calls = 0;
  await readRegisters(regs, fakeClient({ record }), () => ++calls > 1);
  assert.ok(record.length < 3, `expected an early exit, got ${record.length} requests`);
});

// ── decoding primitives still behave ─────────────────────────────────────────
test('parseBuffer — decodes each supported type', () => {
  assert.strictEqual(parseBuffer(Buffer.from([0x04, 0xD2]), 'UINT16'), 1234);
  assert.strictEqual(parseBuffer(Buffer.from([0xFF, 0xFF]), 'INT16'), -1);
  assert.strictEqual(parseBuffer(Buffer.from([0x00, 0x01, 0x00, 0x00]), 'UINT32'), 65536);
  assert.strictEqual(parseBuffer(Buffer.from([0xFF, 0xFF, 0xFF, 0xFF]), 'INT32'), -1);
  assert.strictEqual(parseBuffer(Buffer.from('SUN2000\0\0'), 'STRING'), 'SUN2000');
  // Up to the first NUL (1.3.7): this 30-byte model field held two names and was shown as one,
  // "SUN2000-3KTL-M1SUN2000-4KTL-M" (log 82295e2c). Padding in front is still skipped.
  assert.strictEqual(parseBuffer(Buffer.from('SUN2000-3KTL-M1\0SUN2000-4KTL-M'), 'STRING'), 'SUN2000-3KTL-M1');
  assert.strictEqual(parseBuffer(Buffer.from('\0\0EMMA-A02\0'), 'STRING'), 'EMMA-A02');
  assert.strictEqual(parseBuffer(Buffer.from('\0\0\0\0'), 'STRING'), '');
  assert.strictEqual(parseBuffer(Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]), 'UINT64'), 4294967296);
});

// ── the real register maps ───────────────────────────────────────────────────
// ── the Settings → Registers check ──────────────────────────────────────────
// api.js merges every register group of a driver into ONE flat map (keys are
// "groupName\x00registerName") and probes it in a single connection — the largest and
// most heterogeneous read in the app. Its whole purpose is to report which registers a
// device answers, so that answer must not shift with anything we do down here.
function mergedSunMap() {
  const R = require('../lib/modbus-registers.js');
  const sets = {
    REGISTERS: R.REGISTERS, POWER_METER_REGISTERS: R.POWER_METER_REGISTERS,
    BATTERY_REGISTERS: R.BATTERY_REGISTERS, CONTROL_REGISTERS: R.CONTROL_REGISTERS,
    BATTERY_MODULE_REGISTERS: R.BATTERY_MODULE_REGISTERS,
  };
  const merged = {};
  for (const [g, regs] of Object.entries(sets)) {
    for (const [k, d] of Object.entries(regs)) merged[`${g}\x00${k}`] = d;
  }
  return merged;
}

// Hardware with no battery and no power meter fitted: those ranges raise, as real
// inverters do for unpopulated equipment.
function partialHardwareClient() {
  const dead = (a) => (a >= 37000 && a < 37200) || (a >= 37700 && a < 37900) || (a >= 47000 && a < 48000);
  return {
    async readHoldingRegisters(start, count) {
      for (let i = 0; i < count; i++) if (dead(start + i)) throw new Error('illegal data address');
      const b = Buffer.alloc(count * 2);
      for (let i = 0; i < count; i++) b.writeUInt16BE((start + i) & 0xFFFF, i * 2);
      return { response: { body: { valuesAsBuffer: b } } };
    },
  };
}

test('settings register check — group-prefixed keys are preserved end to end', async () => {
  const merged = mergedSunMap();
  const out = await readRegisters(merged, partialHardwareClient());
  assert.deepStrictEqual(Object.keys(out).sort(), Object.keys(merged).sort());
  assert.ok(Object.keys(out).every((k) => k.includes('\u0000')), 'group prefix must be preserved');
});

test('settings register check — unsupported ranges still report exactly which registers answer', async () => {
  const merged = mergedSunMap();
  const silence = console.log;
  console.log = () => {}; // the fallback notice is expected here
  const out = await readRegisters(merged, partialHardwareClient());
  console.log = silence;

  // Everything in a dead range must be null, everything else must have answered — this is
  // precisely what the page displays, so it must not shift with batching.
  for (const [key, def] of Object.entries(merged)) {
    const a = def[0];
    const dead = (a >= 37000 && a < 37200) || (a >= 37700 && a < 37900) || (a >= 47000 && a < 48000);
    if (dead) assert.strictEqual(out[key], null, `${key} @${a} should be unreadable`);
    else assert.notStrictEqual(out[key], null, `${key} @${a} should have answered`);
  }
});


// ── failure reasons must reach the log ──────────────────────────────────────
// A silent `catch {}` made "the device says this register does not exist" and "the device
// did not answer in time" look identical — an empty cell either way. They call for
// opposite reactions (drop the register vs. retry), so the reason has to be recorded.
test('readRegisters — logs why a read failed, distinguishing exception from timeout', async () => {
  const lines = [];
  const real = console.log;
  console.log = (...a) => { if (String(a[0]).startsWith('[modbus]')) lines.push(String(a[0])); else real(...a); };

  const client = {
    async readHoldingRegisters(start) {
      if (start === 100) throw new Error('Req timed out');
      // jsmodbus rejects a Modbus exception with a plain object in some paths...
      if (start === 200) throw { err: 'ModbusException', response: { body: { code: 2 } } };
      // ...and in others with an Error whose message alone says nothing useful. Field logs
      // showed exactly this shape, which is why the code has to win over the message.
      const e = new Error('A Modbus Exception Occurred - See Response Body');
      e.response = { body: { code: 6 } };
      throw e;
    },
  };
  await readRegisters(
    { a: [100, 1, 'UINT16', '', 0], b: [200, 1, 'UINT16', '', 0], c: [300, 1, 'UINT16', '', 0] },
    client,
  );
  console.log = real;

  assert.strictEqual(lines.length, 3);
  assert.ok(lines.some((l) => l.includes('100/1') && l.includes('Req timed out')), lines.join(' | '));
  assert.ok(lines.some((l) => l.includes('200/1') && l.includes('exception 2') && l.includes('Illegal Data Address')),
    lines.join(' | '));
  assert.ok(lines.some((l) => l.includes('300/1') && l.includes('exception 6') && l.includes('Server Device Busy')),
    'the code must beat the useless message: ' + lines.join(' | '));
});

test('readRegisters — a permanently failing register does not flood the log', async () => {
  const lines = [];
  const real = console.log;
  console.log = (...a) => { if (String(a[0]).startsWith('[modbus]')) lines.push(String(a[0])); else real(...a); };

  const client = { async readHoldingRegisters() { throw new Error('illegal data address'); } };
  for (let i = 0; i < 5; i++) await readRegisters({ a: [100, 1, 'UINT16', '', 0] }, client);
  console.log = real;

  // The one-off read-plan line is separate; what must not repeat is the failure itself.
  const failures = lines.filter((l) => l.includes('failed'));
  assert.strictEqual(failures.length, 1, 'five polls must produce a single failure line: ' + lines.join(' | '));
});

// ── a probe must never run concurrently with a poll ─────────────────────────
// Huawei devices accept exactly one Modbus TCP connection. When the settings-page probe
// opened a second one, the inverter dropped the first: the running poll failed mid-way
// ("connection to modbus server closed") and published wrong values, and the probe got
// "no connection to modbus server" for every remaining register.
const modbus = require('../lib/modbus-client.js');

test('probeModbusUnit — is serialised against reads on the same host', async () => {
  const net = require('net');
  const order = [];
  let open = 0, maxOpen = 0;

  // Stand up a real TCP listener so _connect() can connect; it never speaks Modbus, so
  // every read fails — which is fine, we are asserting connection overlap, not values.
  const srv = net.createServer((sock) => {
    open++; maxOpen = Math.max(maxOpen, open);
    sock.on('close', () => { open--; });
    sock.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();

  try {
    const regs = { a: [100, 1, 'UINT16', '', 0] };
    await Promise.all([
      modbus.readModbusRegisters('127.0.0.1', port, 1, regs).then(() => order.push('read'), () => order.push('read')),
      modbus.probeModbusUnit('127.0.0.1', port, 1, regs, 4000).then(() => order.push('probe')),
    ]);
    assert.strictEqual(maxOpen, 1, `at most one connection at a time, saw ${maxOpen}`);
    assert.strictEqual(order.length, 2);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('probeModbusUnit — pre-empts a long-running poll instead of waiting it out', async () => {
  // Four devices on one SDongle keep the bus busy ~60% of the time. If the probe simply
  // queued, the Registers page timed out. It must ask the running read to stop early.
  const net = require('net');
  const srv = net.createServer((s) => s.on('error', () => {}));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();

  try {
    // 60 registers: read one at a time this would occupy the bus for many seconds.
    const many = {};
    for (let i = 0; i < 60; i++) many['r' + i] = [1000 + i * 20, 1, 'UINT16', '', 0];

    const t0 = Date.now();
    const poll = modbus.readModbusRegisters('127.0.0.1', port, 1, many).catch(() => null);
    await new Promise((r) => setTimeout(r, 700));      // let the poll get going
    const probeStart = Date.now();
    await modbus.probeModbusUnit('127.0.0.1', port, 1, { a: [100, 1, 'UINT16', '', 0] }, 4000);
    const probeWaited = Date.now() - probeStart;
    await poll;

    assert.ok(probeWaited < 4000,
      `probe should not wait out the whole poll, waited ${probeWaited}ms of a ${Date.now() - t0}ms cycle`);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('withHostLock — a raw TCP probe never overlaps an in-flight read', async () => {
  // The settings-page port scanner opens bare sockets instead of speaking Modbus, so it
  // cannot go through probeModbusUnit. Until v1.2.52 it bypassed the lock entirely and a
  // scan would drop the connection of every device it walked past (Huawei accepts one).
  const net = require('net');
  let open = 0;
  let maxOpen = 0;
  const srv = net.createServer((s) => {
    open++;
    maxOpen = Math.max(maxOpen, open);
    s.on('close', () => open--);
    s.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();

  // Exactly what api.js scanPorts does for a host we poll ourselves.
  const tcpCheck = (host, p) => new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => { if (!done) { done = true; sock.destroy(); resolve(ok); } };
    sock.setTimeout(400);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(p, host);
  });

  try {
    const regs = {};
    for (let i = 0; i < 20; i++) regs['r' + i] = [1000 + i * 20, 1, 'UINT16', '', 0];

    const poll = modbus.readModbusRegisters('127.0.0.1', port, 1, regs).catch(() => null);
    await new Promise((r) => setTimeout(r, 200));            // poll is connected by now
    await modbus.withHostLock('127.0.0.1', port, () => tcpCheck('127.0.0.1', port));
    await poll;

    assert.strictEqual(maxOpen, 1,
      `scan must not open a second connection while polling (saw ${maxOpen})`);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

// ── nameplate cache ──────────────────────────────────────────────────────────
// 30000 and 30073 are in STATIC_REGISTER_ADDRESSES; 32064 is a live value. The tuples below
// declare them as UINT16 because the cache keys on address only — the decoding is covered
// by the readRegisters tests above.
const NAMEPLATE = 30000;
const RATED     = 30073;
const LIVE      = 32064;

async function withServer(fn) {
  const net = require('net');
  const srv = net.createServer((s) => s.on('error', () => {}));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    return await fn(srv.address().port);
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

function respond(value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(value & 0xFFFF, 0);
  return { response: { body: { valuesAsBuffer: buf } } };
}

test('readModbusRegisters — a nameplate register is read once, then served from cache', async () => {
  modbus._resetStaticCache();
  const reads = [];
  setFakeRead((start) => { reads.push(start); return respond(start === NAMEPLATE ? 111 : 222); });

  try {
    await withServer(async (port) => {
      const regs = {
        modelName: [NAMEPLATE, 1, 'UINT16', '', 0],
        power:     [LIVE,      1, 'UINT16', '', 0],
      };
      const first  = await modbus.readModbusRegisters('127.0.0.1', port, 1, regs);
      const second = await modbus.readModbusRegisters('127.0.0.1', port, 1, regs);

      assert.strictEqual(reads.filter((a) => a === NAMEPLATE).length, 1,
        'nameplate must be read exactly once across two polls');
      assert.strictEqual(reads.filter((a) => a === LIVE).length, 2,
        'the live register must still be read every poll');
      assert.strictEqual(second.modelName, first.modelName, 'cached value must be returned');
      assert.strictEqual(second.power, 222);
      assert.deepStrictEqual(Object.keys(second), Object.keys(regs),
        'a cached poll must return the caller\'s key order unchanged');
    });
  } finally { setFakeRead(null); }
});

test('readModbusRegisters — a nameplate register that fails is not cached as empty', async () => {
  modbus._resetStaticCache();
  let nameplateAttempts = 0;
  // Times out on the first poll, answers on the second — the value must appear, not stay
  // null for a day.
  setFakeRead((start) => {
    if (start === NAMEPLATE) {
      nameplateAttempts++;
      if (nameplateAttempts <= 2) throw new Error('Req timed out');  // in-loop + warm retry
      return respond(111);
    }
    return respond(222);
  });

  try {
    await withServer(async (port) => {
      const regs = {
        modelName: [NAMEPLATE, 1, 'UINT16', '', 0],
        power:     [LIVE,      1, 'UINT16', '', 0],
      };
      const first  = await modbus.readModbusRegisters('127.0.0.1', port, 1, regs);
      const second = await modbus.readModbusRegisters('127.0.0.1', port, 1, regs);

      assert.strictEqual(first.modelName, null, 'a failed read stays null for that poll');
      assert.strictEqual(second.modelName, 111, 'the next poll must retry, not serve null');
      assert.strictEqual(nameplateAttempts, 3, 'two attempts on poll 1, one on poll 2');
    });
  } finally { setFakeRead(null); }
});

test('readModbusRegisters — an all-nameplate block still connects, so offline is detected', async () => {
  modbus._resetStaticCache();
  const reads = [];
  setFakeRead((start) => { reads.push(start); return respond(1); });

  try {
    await withServer(async (port) => {
      // Nothing live to read: serving purely from cache would mean a device could go offline
      // without the poll ever noticing.
      const regs = {
        modelName:  [NAMEPLATE, 1, 'UINT16', '', 0],
        ratedPower: [RATED,     1, 'UINT16', '', 0],
      };
      await modbus.readModbusRegisters('127.0.0.1', port, 1, regs);
      await modbus.readModbusRegisters('127.0.0.1', port, 1, regs);
      assert.strictEqual(reads.length, 4, 'both polls must hit the device');
    });
  } finally { setFakeRead(null); }
});

test('readModbusRegisters — the cache is per device, not per address', async () => {
  modbus._resetStaticCache();
  // 30000 is modelName on a SUN2000 and offeringName on a SmartCharger. Two devices behind
  // the same host must not read each other's nameplate.
  const reads = [];
  setFakeRead((start) => { reads.push(start); return respond(7); });

  try {
    await withServer(async (port) => {
      const regs = { name: [NAMEPLATE, 1, 'UINT16', '', 0], power: [LIVE, 1, 'UINT16', '', 0] };
      await modbus.readModbusRegisters('127.0.0.1', port, 1, regs);   // unit 1 fills its entry
      await modbus.readModbusRegisters('127.0.0.1', port, 2, regs);   // unit 2 must not reuse it
      await modbus.readModbusRegisters('127.0.0.1', port, 2, regs);   // ...but now it may

      assert.strictEqual(reads.filter((a) => a === NAMEPLATE).length, 2,
        'each unit must read the nameplate once; keying on address alone would give 1');
    });
  } finally { setFakeRead(null); }
});

test('readModbusRegisters — the first register of a block is retried on every poll', async () => {
  modbus._resetStaticCache();
  // Huawei drops the first request of a connection whatever it is, so the first register gets
  // a second attempt once the connection is warm. It must never be given up on: 1.2.53 briefly
  // suppressed repeatedly-failing registers, which would have promoted the next one into first
  // position to fail in turn, emptying the block one register per poll.
  const reads = [];
  setFakeRead((start) => {
    reads.push(start);
    if (start === 30100) throw new Error('Req timed out');
    return respond(5);
  });

  try {
    await withServer(async (port) => {
      // Batches are ordered by address, so the LOWEST address is the one that goes first and
      // therefore the one the device drops. 30100 sits well below LIVE and far enough away
      // (> MAX_BATCHED_REGISTERS_GAP) to stay a batch of its own.
      const regs = { power: [LIVE, 1, 'UINT16', '', 0], status: [30100, 1, 'UINT16', '', 0] };
      for (let i = 0; i < 6; i++) await modbus.readModbusRegisters('127.0.0.1', port, 1, regs);
      assert.strictEqual(reads.filter((a) => a === 30100).length, 12,
        'first batch must keep being tried: 2 attempts x 6 polls, never given up on');
    });
  } finally { setFakeRead(null); }
});

// ── batching (buildReadPlan) ─────────────────────────────────────────────────
test('buildReadPlan — splits on the gap limit, not before it', async () => {
  const plan = (regs) => buildReadPlan(regs).map((g) => g.map((x) => x.name));

  // Gap is measured as next.start - prev.end. 15 is still batched, 16 is not.
  assert.deepStrictEqual(
    plan({ a: [100, 1, 'UINT16', '', 0], b: [115, 1, 'UINT16', '', 0] }),
    [['a', 'b']], 'a gap of 15 must stay in one request');
  assert.deepStrictEqual(
    plan({ a: [100, 1, 'UINT16', '', 0], b: [116, 1, 'UINT16', '', 0] }),
    [['a'], ['b']], 'a gap of 16 must split');
});

test('buildReadPlan — splits on accumulated span even when every gap is small', async () => {
  // Deliberately 15 apart so the GAP rule never fires and only the 64-word span can split
  // the chain. (An earlier version of this test used far-apart registers, where the gap rule
  // fired first and the span limit was never actually exercised.)
  const regs = {};
  for (let i = 0; i < 10; i++) regs['r' + i] = [100 + i * 15, 1, 'UINT16', '', 0];
  const plan = buildReadPlan(regs);

  for (const group of plan) {
    const span = group[group.length - 1].end - group[0].start;
    assert.ok(span <= 64, `span ${span} exceeds the 64-word limit`);
  }
  assert.ok(plan.length > 1, 'ten registers 15 apart must not fit in one request');
});

test('buildReadPlan — sorts by address, so declaration order does not matter', async () => {
  const plan = buildReadPlan({ z: [200, 1, 'UINT16', '', 0], a: [100, 1, 'UINT16', '', 0] });
  assert.strictEqual(plan[0][0].name, 'a', 'lowest address must be read first');
});

test('readRegisters — batching cuts the request count on a real register map', async () => {
  const { REGISTERS } = require('../lib/modbus-registers.js');
  const record = [];
  await readRegisters(REGISTERS, fakeClient({ record }));
  const singles = Object.keys(REGISTERS).length;
  assert.ok(record.length < singles / 2,
    `expected far fewer requests than ${singles}, got ${record.length}`);
});

test('readRegisters — one refused register costs only its own batch, not the poll', async () => {
  // 37200 answers with a Modbus exception on this installation. Batched, it would take its
  // whole group down with it; bisection has to recover the neighbours.
  const regs = {
    ok1:      [37196, 1, 'UINT16', '', 0],
    refused:  [37200, 1, 'UINT16', '', 0],
    ok2:      [37201, 1, 'UINT16', '', 0],
  };
  const out = await readRegisters(regs, fakeClient({ deadAddresses: [37200] }));
  assert.strictEqual(out.refused, null);
  assert.strictEqual(out.ok1, 37196, 'neighbour before the refused register must survive');
  assert.strictEqual(out.ok2, 37201, 'neighbour after the refused register must survive');
});

test('readRegisters — a split batch is logged, not just the register that caused it', async () => {
  const lines = [];
  const real = console.log;
  console.log = (...a) => { if (String(a[0]).startsWith('[modbus]')) lines.push(String(a[0])); else real(...a); };

  const regs = {};
  for (let i = 0; i < 20; i++) regs['r' + i] = [41190 + i, 1, 'UINT16', '', 0];
  await readRegisters(regs, fakeClient({ deadAddresses: [41200] }));
  console.log = real;

  assert.ok(lines.some((l) => l.includes('batch 41190/20') && l.includes('splitting')),
    'the cost of taking a batch apart must be visible: ' + lines.join(' | '));
  assert.ok(lines.some((l) => l.includes('read 41200/1 failed')),
    'and the register actually responsible must still be named: ' + lines.join(' | '));
});

test('readRegisters — the read plan is reported once, not on every poll', async () => {
  const lines = [];
  const real = console.log;
  console.log = (...a) => { if (String(a[0]).startsWith('[modbus]')) lines.push(String(a[0])); else real(...a); };

  const regs = { a: [42000, 1, 'UINT16', '', 0], b: [42001, 1, 'UINT16', '', 0] };
  for (let i = 0; i < 5; i++) await readRegisters(regs, fakeClient({}));
  console.log = real;

  const planLines = lines.filter((l) => l.includes('read plan'));
  assert.strictEqual(planLines.length, 1, 'five polls must report the plan once: ' + lines.join(' | '));
  assert.ok(planLines[0].includes('2 registers in 1 request'), planLines[0]);
});

// ── unavailableMessage ───────────────────────────────────────────────────────
// Der Text landet auf der Gerätekachel. Bisher stand dort "Modbus-Abruf fehlgeschlagen:
// Socket error: connect EHOSTUNREACH 192.168.0.226:502" — praezise und fuer den Besitzer
// wertlos, obwohl genau er derjenige ist, der das Geraet einschalten kann.
const { unavailableMessage } = require('../lib/modbus-client');

const homeyStub = {
  __: (k) => ({
    'modbus.errors.fetchFailed': 'Modbus read failed',
    'modbus.errors.host.unreachable': 'No route to {{host}} — powered on?',
    'modbus.errors.host.timeout': '{{host}} is not responding',
    'modbus.errors.host.refused': '{{host}} refused the connection',
    'modbus.errors.host.closed': '{{host}} accepted the connection and closed it again',
  })[k] ?? k,
};

test('unavailableMessage — EHOSTUNREACH becomes a sentence naming the host', () => {
  const msg = unavailableMessage(homeyStub, new Error('Socket error: connect EHOSTUNREACH 192.168.0.226:502'), '192.168.0.226');
  assert.strictEqual(msg, 'No route to 192.168.0.226 — powered on?');
});

test('unavailableMessage — our own connect timeout is recognised', () => {
  const msg = unavailableMessage(homeyStub, new Error('Connection to 192.168.0.226:502 timed out'), '192.168.0.226');
  assert.strictEqual(msg, '192.168.0.226 is not responding');
});

test('unavailableMessage — ECONNREFUSED points at Modbus TCP, not at the power switch', () => {
  const msg = unavailableMessage(homeyStub, new Error('Socket error: connect ECONNREFUSED 192.168.0.226:502'), '192.168.0.226');
  assert.strictEqual(msg, '192.168.0.226 refused the connection');
});

test('unavailableMessage — a Modbus-level fault keeps its raw text', () => {
  // Hier IST das Detail die Information: welches Register, welcher Ausnahmecode.
  const msg = unavailableMessage(homeyStub, new Error('illegal data address 37200'), '192.168.0.226');
  assert.strictEqual(msg, 'Modbus read failed: illegal data address 37200');
});

test('unavailableMessage — an unknown host still yields a sentence, not "undefined"', () => {
  const msg = unavailableMessage(homeyStub, new Error('connect EHOSTUNREACH 10.0.0.5:502'), null);
  assert.strictEqual(msg, 'No route to ? — powered on?');
});

// ── a socket that is accepted and then hung up ───────────────────────────────
// Field log cee22305 (2026-08-20): the TCP handshake succeeded — _connect only runs the read
// function from its 'connect' handler, so nothing below could have been logged otherwise —
// and every one of ~60 reads was then refused with "no connection to modbus server", which
// jsmodbus raises WITHOUT putting the request on the wire.
//
// That poll used to resolve with an all-nulls object, so it reached the driver as data. Each
// driver checks its own key register, finds it null, and says what that means on a device
// that IS answering: "LUNA2000 battery not detected". The owner was told to inspect an RS485
// cable that was never the problem.

// jsmodbus wording, verbatim: the request in flight when the socket closes gets the first,
// everything queued behind it the second.
const OFFLINE_IN_FLIGHT = 'connection to modbus server closed';
const OFFLINE_QUEUED    = 'no connection to modbus server';

// Answers normally until `until` registers have been served, then behaves like a client whose
// socket has gone: instant rejection, no wire traffic, for every request that follows.
function hangUpClient(afterCalls, message = OFFLINE_QUEUED, record = []) {
  return {
    calls: record,
    async readHoldingRegisters(start, count) {
      record.push({ start, count });
      if (record.length > afterCalls) throw new Error(message);
      const buf = Buffer.alloc(count * 2);
      for (let i = 0; i < count; i++) buf.writeUInt16BE((start + i) & 0xFFFF, i * 2);
      return { response: { body: { valuesAsBuffer: buf } } };
    },
  };
}

test('readRegisters — a poll that lost the socket and read nothing fails, rather than returning nulls', async () => {
  const regs = { a: [100, 1, 'UINT16', '', 0], b: [200, 1, 'UINT16', '', 0] };
  await assert.rejects(
    () => readRegisters(regs, hangUpClient(0)),
    (err) => {
      assert.strictEqual(err.modbusConnectionLost, true, 'the flag the tile message keys on is missing');
      return true;
    },
  );
});

test('readRegisters — the in-flight wording is recognised as well as the queued one', async () => {
  const regs = { a: [100, 1, 'UINT16', '', 0] };
  await assert.rejects(
    () => readRegisters(regs, hangUpClient(0, OFFLINE_IN_FLIGHT)),
    (err) => err.modbusConnectionLost === true,
  );
});

// The first-request retry is for a device that drops the first request of a connection, not
// for a dead socket: since 1.3.14 a lost connection ends the poll at once (log 06618e47 showed
// one "no connection" line per register of every poll). The verdict must survive that.
test('readRegisters — a dead socket is neither retried nor read any further, and still fails the poll', async () => {
  const regs = { a: [100, 1, 'UINT16', '', 0], b: [200, 1, 'UINT16', '', 0] };
  const client = hangUpClient(0);
  await assert.rejects(() => readRegisters(regs, client), (err) => err.modbusConnectionLost === true);
  assert.strictEqual(client.calls.length, 1, 'requests went on after the socket was gone');
});

// Anything the device actually SAID keeps the old behaviour: those failures describe
// registers, and the driver's own check is the right place to interpret them.
test('readRegisters — a refused register is not mistaken for a lost connection', async () => {
  const regs = { a: [100, 1, 'UINT16', '', 0], b: [200, 1, 'UINT16', '', 0] };
  const client = { async readHoldingRegisters() { throw new Error('Modbus exception 2 (Illegal Data Address)'); } };
  const out = await readRegisters(regs, client);
  assert.deepStrictEqual(out, { a: null, b: null }, 'this must still resolve, not throw');
});

// Half a poll is still worth having: those replies were real. Discarding them would empty a
// block that is partly working — the 1.2.53 regression.
test('readRegisters — registers read before the hang-up are kept, and the poll still succeeds', async () => {
  const regs = { a: [100, 1, 'UINT16', '', 0], far: [500, 1, 'UINT16', '', 0] };
  const out = await readRegisters(regs, hangUpClient(1));  // first span answers, then the socket dies
  assert.strictEqual(out.a, 100, 'the register that was genuinely read was thrown away');
  assert.strictEqual(out.far, null);
});

// The field shape: adjacent registers, so buildReadPlan makes one batch of them. Until 1.3.14
// a lost connection on it was bisected all the way down, one doomed request per register;
// now the batch is written off whole. The verdict has to hold either way.
test('readRegisters — a batch that hangs up is not bisected, and still fails the poll', async () => {
  const regs = {};
  for (let i = 0; i < 8; i++) regs[`r${i}`] = [37760 + i, 1, 'UINT16', '', 0];
  const client = hangUpClient(0);
  await assert.rejects(
    () => readRegisters(regs, client),
    (err) => err.modbusConnectionLost === true,
  );
  assert.strictEqual(client.calls.length, 1, 'the batch was taken apart on a socket that was gone');
});

test('unavailableMessage — a hung-up socket names the connection, not the hardware', () => {
  const err = new Error('Modbus connection closed before any register could be read');
  err.modbusConnectionLost = true;
  const msg = unavailableMessage(homeyStub, err, '192.168.0.226');
  assert.strictEqual(msg, '192.168.0.226 accepted the connection and closed it again');
});

test('the hung-up-socket message exists in all three locales and names the host', () => {
  const fs = require('fs');
  for (const lang of ['en', 'de', 'nl']) {
    const host = JSON.parse(fs.readFileSync(`locales/${lang}.json`, 'utf8')).modbus.errors.host;
    assert.ok(host.closed, `modbus.errors.host.closed missing in ${lang}`);
    assert.match(host.closed, /\{\{host\}\}/, `${lang}: the message does not name the host`);
    assert.notStrictEqual(host.closed, host.refused, `${lang}: closed and refused say the same thing`);
  }
});

// ── desync: what happens on a socket whose pairing can no longer be trusted ───
// A timeout leaves a request the device may still answer; a function-code mismatch is
// that late answer being paired with whatever was asked next. Every read here is FC03, so
// the code cannot tell two reads apart, and a stale reply becomes registers from the wrong
// address. Splitting re-asks on that same socket — the only path by which such a value can
// reach a capability or a setting.

// Client that fails one span with a given message and serves everything else normally.
function desyncClient(failStart, message, record = []) {
  return {
    calls: record,
    async readHoldingRegisters(start, count) {
      record.push({ start, count });
      if (start === failStart) throw new Error(message);
      const buf = Buffer.alloc(count * 2);
      for (let i = 0; i < count; i++) buf.writeUInt16BE((start + i) & 0xFFFF, i * 2);
      return { response: { body: { valuesAsBuffer: buf } } };
    },
  };
}

for (const [label, message] of [
  ['a timeout',              'Req timed out'],
  ['a function-code mismatch', 'request fc and response fc does not match.'],
]) {
  test(`readRegisters — ${label} writes the batch off instead of re-asking on the same socket`, async () => {
    // A healthy batch goes first on purpose: the opening request of a connection gets one
    // free repeat (Huawei discards it whatever it is), which would otherwise be counted as
    // if it were bisection.
    const regs = { warm: [100, 1, 'UINT16', '', 0] };
    for (let i = 0; i < 8; i++) regs['r' + i] = [41190 + i, 1, 'UINT16', '', 0];
    const record = [];
    const res = await readRegisters(regs, desyncClient(41190, message, record));

    // Exactly one request for the failing batch and no sub-requests: bisecting it would
    // have produced several more, each of which the field logs show failing anyway.
    assert.deepStrictEqual(record.filter((c) => c.start >= 41190), [{ start: 41190, count: 8 }]);
    assert.strictEqual(res.warm, 100, 'the healthy batch is unaffected');
    for (const name of Object.keys(regs).filter((n) => n !== 'warm')) {
      assert.strictEqual(res[name], null, `${name} must be null, never a value from elsewhere`);
    }
  });
}

test('readRegisters — a refused address still splits, so its neighbours survive', async () => {
  // The contrast case: "illegal data address" is the device answering a specific question
  // with "no". The socket is fine, so bisection is still how the other 19 registers get read.
  const regs = {};
  for (let i = 0; i < 20; i++) regs['r' + i] = [41190 + i, 1, 'UINT16', '', 0];
  const res = await readRegisters(regs, fakeClient({ deadAddresses: [41200] }));
  assert.strictEqual(res.r10, null);            // 41200
  assert.strictEqual(res.r0, 41190);            // neighbours still resolve
  assert.strictEqual(res.r19, 41209);
});

test('readRegisters — a desynced batch does not cost the batches after it', async () => {
  // Huawei devices discard the first request of every connection whatever it is, so a
  // timeout on the opening batch is routine. Giving up on the rest would empty the block
  // one register per poll — the regression 1.2.53 caused.
  const regs = {
    a0: [100, 1, 'UINT16', '', 0], a1: [101, 1, 'UINT16', '', 0],
    b0: [900, 1, 'UINT16', '', 0], b1: [901, 1, 'UINT16', '', 0],
  };
  const res = await readRegisters(regs, desyncClient(100, 'Req timed out'));
  assert.strictEqual(res.a0, null);
  assert.strictEqual(res.a1, null);
  assert.strictEqual(res.b0, 900, 'the later batch must still be read');
  assert.strictEqual(res.b1, 901);
});

test('readRegisters — a desynced batch says so in the log, and does not claim to split', async () => {
  const lines = [];
  const real = console.log;
  console.log = (...a) => { if (String(a[0]).startsWith('[modbus]')) lines.push(String(a[0])); else real(...a); };
  const regs = {};
  for (let i = 0; i < 6; i++) regs['r' + i] = [45000 + i, 1, 'UINT16', '', 0];
  await readRegisters(regs, desyncClient(45000, 'Req timed out'));
  console.log = real;
  const line = lines.find((l) => l.includes('batch 45000/6'));
  assert.ok(line, lines.join(' | '));
  assert.match(line, /pairing unreliable, batch skipped/);
  assert.doesNotMatch(line, /splitting/);
});

// ── the sun2000 setting-sync guard ───────────────────────────────────────────
test('sun2000 numericSync ranges match the ranges app.json declares', () => {
  // The driver refuses to store a Modbus value that falls outside the setting's own range,
  // because a value the setting cannot hold came from a desynced read rather than from the
  // inverter (field log 2026-08-14 00:29). That guard is only as good as the numbers it
  // compares against, and they are written down twice — here is the check that they agree.
  // Writing them from memory got mppt_scan_interval wrong on the first attempt (0..1440
  // instead of 1..60), which is exactly what this catches.
  const fs = require('fs');
  const src = fs.readFileSync('drivers/sun2000_modbus/device.js', 'utf8');
  const block = /const numericSync = \[([\s\S]*?)\];/.exec(src);
  assert.ok(block, 'numericSync table not found');

  const rows = [...block[1].matchAll(/\[\s*'(\w+)',\s*'(\w+)',\s*([\d.]+),\s*(-?[\d.]+),\s*(\d+)\s*\]/g)]
    .map((m) => ({ settingId: m[2], min: Number(m[4]), max: Number(m[5]) }));
  assert.strictEqual(rows.length, 5, 'expected 5 synced numeric settings');

  const manifest = {};
  const walk = (arr) => { for (const s of arr || []) { if (s.children) walk(s.children); else if (s.id) manifest[s.id] = s; } };
  walk(require('../app.json').drivers.find((d) => d.id === 'sun2000_modbus').settings);

  for (const { settingId, min, max } of rows) {
    const decl = manifest[settingId];
    assert.ok(decl, `${settingId} is synced but not declared in app.json`);
    assert.strictEqual(min, decl.min, `${settingId}: min ${min} does not match app.json ${decl.min}`);
    assert.strictEqual(max, decl.max, `${settingId}: max ${max} does not match app.json ${decl.max}`);
  }
});

// ── recovery: the rising edge, not just the falling one ──────────────────────
// Only failures were ever logged, so a burst of them was followed by silence and there
// was no way to tell a fault that had passed from one still running — the more so since
// the driver's own "Poll OK" line is a 15-minute heartbeat.


// ── the all-clear, per device ────────────────────────────────────────────────
// Reported by a user of the first attempt at this: the failures said "read 47589/1
// failed", and the recovery arrived 148 s later as "batch 47589/1 reading again". Wrong
// altitude for the question being asked — which is whether this inverter is being read
// properly again — and far enough away to read as an unrelated line. So: one line per
// device, at the end of the first poll in which nothing failed.

function captureModbusLog(fn) {
  const lines = [];
  const real = console.log;
  console.log = (...a) => { if (String(a[0]).startsWith('[modbus]')) lines.push(String(a[0])); else real(...a); };
  return Promise.resolve(fn()).finally(() => { console.log = real; }).then(() => lines);
}

test('readModbusRegisters — a device that reads cleanly again says so, once', async () => {
  modbus._resetStaticCache();
  let broken = true;
  setFakeRead((start) => {
    if (broken && start === LIVE) throw new Error('Req timed out');
    return respond(5);
  });
  try {
    const lines = await captureModbusLog(async () => {
      await withServer(async (port) => {
        // A second register that answers: since 1.3.6 a poll in which nothing at all answered
        // is a failed poll, not a degraded one (modbus-silent-136.test.js).
        // Far from LIVE so it is a batch of its own, and not a nameplate address the cache
        // would serve.
        const regs = { power: [LIVE, 1, 'UINT16', '', 0], status: [33000, 1, 'UINT16', '', 0] };
        await modbus.readModbusRegisters('127.0.0.1', port, 1, regs);   // degraded
        await modbus.readModbusRegisters('127.0.0.1', port, 1, regs);   // still degraded
        broken = false;
        await modbus.readModbusRegisters('127.0.0.1', port, 1, regs);   // clean → all-clear
        await modbus.readModbusRegisters('127.0.0.1', port, 1, regs);   // and silent after
      });
    });
    const clear = lines.filter((l) => l.includes('reading cleanly again'));
    assert.strictEqual(clear.length, 1, 'exactly one all-clear: ' + lines.join(' | '));
    assert.match(clear[0], /after 2 poll\(s\) with failures/);
    assert.match(clear[0], /^\[modbus\] 127\.0\.0\.1:\d+:/, 'named by device, not by register span');
  } finally { setFakeRead(null); }
});

test('readModbusRegisters — a device that never failed says nothing', async () => {
  modbus._resetStaticCache();
  setFakeRead(() => respond(5));
  try {
    const lines = await captureModbusLog(async () => {
      await withServer(async (port) => {
        const regs = { power: [LIVE, 1, 'UINT16', '', 0] };
        await modbus.readModbusRegisters('127.0.0.1', port, 1, regs);
        await modbus.readModbusRegisters('127.0.0.1', port, 1, regs);
      });
    });
    assert.ok(!lines.some((l) => l.includes('reading cleanly again')), lines.join(' | '));
  } finally { setFakeRead(null); }
});

test('a permanently absent register never marks the device as degraded', async () => {
  // Exception 2 means the register is simply not on this hardware. It fails on every poll
  // for good, and is why a batch legitimately bisects — counting it would mark the device
  // faulty forever and the all-clear would never come.
  const lines = [];
  const real = console.log;
  console.log = (...a) => { if (String(a[0]).startsWith('[modbus]')) lines.push(String(a[0])); else real(...a); };
  const regs = {};
  for (let i = 0; i < 8; i++) regs['r' + i] = [43000 + i, 1, 'UINT16', '', 0];
  const illegal = () => { const e = new Error('A Modbus Exception Occurred'); e.response = { body: { code: 2 } }; throw e; };
  await readRegisters(regs, {
    async readHoldingRegisters(start, count) {
      for (let i = 0; i < count; i++) if (start + i === 43004) illegal();
      const buf = Buffer.alloc(count * 2);
      for (let i = 0; i < count; i++) buf.writeUInt16BE((start + i) & 0xFFFF, i * 2);
      return { response: { body: { valuesAsBuffer: buf } } };
    },
  });
  console.log = real;
  assert.ok(lines.some((l) => l.includes('43004')), 'the absent register is still reported: ' + lines.join(' | '));
  assert.strictEqual(modbus._pollFailuresForTest(), 0, 'but it must not count as transport trouble');
});
