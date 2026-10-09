'use strict';

const net = require('net');
const Modbus = require('jsmodbus');
const { STATIC_REGISTER_ADDRESSES } = require('./modbus-registers');

// Nameplate registers (model, software version, rated power) are re-read on every poll even
// though they cannot change. Cached for a day here. The saving is modest and worth stating
// honestly: five requests per cycle across inverter and battery, not the 74 register words
// they cover — cost is driven by the number of requests, not their width.
//
// The cache lives in memory on purpose: restarting the app empties it, so "refresh daily and
// on restart" needs no persistence and no scheduling. It also means a device swapped behind
// the same IP shows its old nameplate for at most a day, or until the next restart.
const STATIC_TTL_MS = 24 * 60 * 60 * 1000;
const _staticCache = new Map(); // "host:port:unit:address" → { value, at }

function _staticKey(host, port, unitId, address) {
  return `${host}:${port}:${unitId}:${address}`;
}

// Deliberately NOT here: suppressing registers that repeatedly fail to answer. That was tried
// in 1.2.53 on the assumption that such registers are simply absent on the hardware. The
// assumption was wrong — the register that failed was always whichever one happened to be read
// FIRST after connecting, so suppressing it would have promoted the next one into that position
// to fail in turn, emptying a whole block of working registers one poll at a time. The cause is
// handled where it belongs, in readRegisters. Do not reintroduce suppression without evidence
// that a register fails in a position other than first.

// Pacing/timeout values follow wlcrs/huawei-solar-lib, which has far more field exposure
// across Huawei hardware than we do (see modbus_client.py: DEFAULT_COOLDOWN_TIME 0.05,
// DEFAULT_TIMEOUT 10 — "especially the SDongle can react quite slowly").
const READ_DELAY_MS = 50;          // pause between requests (= their DEFAULT_COOLDOWN_TIME)
const POST_CONNECT_MS = 1000;      // = their wait_after_connect
const CONNECT_TIMEOUT_MS  = 10000;
// How long a probe that hit its timeout waits for the socket it destroyed to actually go
// away before handing the bus on. Only ever paid on a probe that already gave up.
const SOCKET_CLOSE_GRACE_MS = 2000;
// Per-request read timeout (jsmodbus). Only reads use this default — writes pass
// WRITE_TIMEOUT_MS explicitly.
//
// This was 10 s, which turned out to dominate everything else. A register the device does
// not answer holds the host lock for the full timeout, and field logs showed several such
// registers per cycle (modelName, meterStatus, essMaxChargePower, connectionType), so a
// single settings-page probe of 13 registers took 12.1 s — 10 s of it waiting on one dead
// register. Measured against the same logs, a healthy response arrives in ~11 ms.
//
// Cut to 3 s on that measurement, then raised to 5 s by the owner after comparing against
// wlcrs/huawei-solar-lib, which runs DEFAULT_TIMEOUT = 10 with up to 6 backoff retries per
// read. We do not retry a batch at all, so a single slow answer is lost until the next
// poll — 5 s buys back some of that margin while staying half the reference value.
//
// The cost is explicit: a silent register now holds the per-host lock for 5 s instead of 3,
// and that lock is shared by every device behind the same SDongle. At ~11 ms for a healthy
// response this is still roughly 450x headroom.
const RESPONSE_TIMEOUT_MS = 5000;
const WRITE_TIMEOUT_MS    = 25000; // SDongle often processes the write but responds late

// Batching limits, same as the reference library (const.py). Deliberately far below the
// Modbus maximum of 125 words per request: Huawei devices reject or corrupt reads that
// span too far, and a gap wider than this costs more than a second request would.
const MAX_BATCHED_REGISTERS_COUNT = 64; // max words covered by one request
const MAX_BATCHED_REGISTERS_GAP   = 16; // max unused words tolerated between two registers

// Circuit breaker per host:port. Without it an unreachable device costs
// CONNECT_TIMEOUT + retry + CONNECT_TIMEOUT on every single poll — all of it while
// holding the host lock, so every other device behind the same SDongle stalls too.
const CIRCUIT_FAIL_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS    = 60000;
const _circuit = new Map(); // "host:port" → { fails, openUntil }

function _circuitOpen(key) {
  const c = _circuit.get(key);
  return !!(c && c.openUntil > Date.now());
}
function _circuitRecord(key, ok) {
  const c = _circuit.get(key) || { fails: 0, openUntil: 0 };
  if (ok) {
    c.fails = 0;
    c.openUntil = 0;
  } else {
    c.fails += 1;
    if (c.fails >= CIRCUIT_FAIL_THRESHOLD) {
      c.openUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
      c.fails = 0; // start counting again after the cooldown
    }
  }
  _circuit.set(key, c);
}

// Serialises all Modbus traffic to the same host:port so that multiple devices
// (e.g. SUN2000 + LUNA2000) sharing one SDongle never open concurrent connections.
const _hostQueue = new Map(); // key: "host:port" → Promise (tail of pending chain)

function withHostLock(host, port, fn) {
  const key = `${host}:${port}`;
  // Chain onto whatever is already queued; if the previous task failed, we still proceed.
  const next = (_hostQueue.get(key) ?? Promise.resolve()).then(fn, fn);
  // Store a non-rejecting tail so future tasks are not blocked by errors in earlier ones.
  _hostQueue.set(key, next.catch(() => {}));
  return next;
}

// A settings-page probe must not have to wait out a full polling cycle. With four devices
// on one SDongle the bus is busy roughly 60% of the time, so queueing politely behind the
// polls made the Registers page time out completely ("no response from app").
//
// Raising priority asks whatever read is currently in flight to stop early — readRegisters
// already supports that via shouldAbort, which the write path uses for the same reason. The
// interrupted poll simply returns what it has (the rest stay null, exactly as for any
// unreadable register) and picks up again on its next tick, while the lock frees within a
// few hundred milliseconds instead of tens of seconds.
const _busPriority = new Map(); // "host:port" → number of waiting priority requests

function _priorityWaiting(host, port) {
  return (_busPriority.get(`${host}:${port}`) || 0) > 0;
}
function _acquirePriority(host, port) {
  const key = `${host}:${port}`;
  _busPriority.set(key, (_busPriority.get(key) || 0) + 1);
}
function _releasePriority(host, port) {
  const key = `${host}:${port}`;
  const n = (_busPriority.get(key) || 1) - 1;
  if (n <= 0) _busPriority.delete(key);
  else _busPriority.set(key, n);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parses a raw Modbus response buffer into a typed value.
 *
 * @param {Buffer} buf
 * @param {string} dataType
 * @returns {number|string}
 */
function parseBuffer(buf, dataType) {
  switch (dataType) {
    case 'UINT16': return buf.readUInt16BE(0);
    case 'INT16':  return buf.readInt16BE(0);
    case 'UINT32': return buf.readUInt32BE(0);
    case 'INT32':  return buf.readInt32BE(0);
    case 'STRING': return buf.toString('ascii').replace(/\0/g, '').trim();
    // A block the caller decodes itself, word by word — the TOU windows (lib/tou-periods.js).
    case 'WORDS':  return Array.from({ length: buf.length >> 1 }, (_, i) => buf.readUInt16BE(i * 2));
    case 'UINT64': {
      // 4 × 16-bit words (big-endian) → 64-bit unsigned integer
      // JS Numbers are safe up to 2^53; energy kWh values never exceed this.
      const high = buf.readUInt32BE(0);
      const low  = buf.readUInt32BE(4);
      return Number((BigInt(high) << 32n) | BigInt(low));
    }
    default: throw new Error(`Unsupported data type: ${dataType}`);
  }
}

// A failed register read used to be swallowed whole (`catch {}`), which made the two
// causes indistinguishable in the log: a device answering "illegal data address" (the
// register genuinely is not there) versus no answer at all (the port was busy, a retry
// would succeed). Those need opposite reactions, so record the reason — rate-limited per
// address+reason so a permanently absent register cannot flood the log.
const _readErrLogged = new Map(); // "address:reason" → last logged timestamp

// Standard Modbus exception codes. Which one comes back matters: 2 means the register is not
// there at all and no amount of retrying will help, while 6 means the device is busy and the
// next poll will very likely succeed.
const MODBUS_EXCEPTION = {
  1: 'Illegal Function',
  2: 'Illegal Data Address',
  3: 'Illegal Data Value',
  4: 'Server Device Failure',
  5: 'Acknowledge',
  6: 'Server Device Busy',
  8: 'Memory Parity Error',
  10: 'Gateway Path Unavailable',
  11: 'Gateway Target Device Failed To Respond',
};

function _errReason(err) {
  if (!err) return 'unknown';
  // Look for the exception code BEFORE the message: jsmodbus reports these as an Error whose
  // message is only "A Modbus Exception Occurred - See Response Body", which told us nothing.
  // The code is the whole point of the message.
  const code = err.response && err.response.body && err.response.body.code;
  if (code !== undefined) {
    const name = MODBUS_EXCEPTION[code];
    return `Modbus exception ${code}${name ? ` (${name})` : ''}`;
  }
  if (err.message) return String(err.message);
  if (err.err) return String(err.err);   // jsmodbus sometimes rejects with a plain object
  try { return JSON.stringify(err).slice(0, 120); } catch { return String(err); }
}

// Only the falling edge used to be logged, so a burst of failures was followed by silence
// with no way to tell a fault that had passed from one still running.
//
// The first attempt at the rising edge announced each register span separately. That was
// the wrong altitude: the question a person actually has is "is this device being read
// properly again", not "did span 47589 answer". It also arrived up to two and a half
// minutes after the failure, because a span is only retried when its own register set
// comes round again, and it used the word "batch" where the failure had said "read".
//
// So the all-clear is per device and per poll: at the end of the first poll in which
// nothing failed, one line, in the same place the failures appeared.
let   _pollFailures  = 0;         // failures recorded during the poll currently running
const _hostDegraded  = new Map(); // "host:port" → consecutive polls that had failures

// Only transport trouble counts towards "this device is degraded". Exception 2, Illegal
// Data Address, means the register is simply not present on this hardware — it fails on
// every poll, for good, and is the reason a batch legitimately bisects. Counting it would
// mark the device as permanently faulty and the all-clear would never come.
function _noteSpanFailed(err) {
  if ((err && err.response && err.response.body && err.response.body.code) === 2) return;
  _pollFailures += 1;
}

function _noteReadError(address, length, err) {
  _noteSpanFailed(err);
  const reason = _errReason(err);
  const key = `${address}:${reason.slice(0, 60)}`;
  const last = _readErrLogged.get(key) || 0;
  if (Date.now() - last < 60000) return;
  _readErrLogged.set(key, Date.now());
  // eslint-disable-next-line no-console
  console.log(`[modbus] read ${address}/${length} failed: ${reason}`);
}

// A batch that fails is the expensive event: it is retried as two halves, and each half that
// fails splits again, so one refused register in a group of twenty costs several extra round
// trips. Without this line that cost is invisible — you would only see the single register
// that ended up failing, with no hint that the whole group had to be taken apart to find it.
function _noteBatchSplit(start, words, count, err, outcome = 'splitting') {
  _noteSpanFailed(err);
  const reason = _errReason(err);
  const key = `${start}:split:${reason.slice(0, 60)}`;
  const last = _readErrLogged.get(key) || 0;
  if (Date.now() - last < 60000) return;
  _readErrLogged.set(key, Date.now());
  // eslint-disable-next-line no-console
  console.log(`[modbus] batch ${start}/${words} (${count} registers) failed: ${reason} — ${outcome}`);
}

/**
 * True for the two failures that mean the socket's request/response pairing can no longer
 * be trusted, as opposed to a device that answered "no" to a specific question.
 *
 * A timeout leaves a request the device may still answer; a function-code mismatch is that
 * late answer arriving and being paired with whatever was asked next. Every read here is
 * FC03, so the code alone cannot tell two reads apart — a stale reply becomes registers
 * from the wrong address, plausible enough to be stored.
 */
function _isDesync(err) {
  const reason = _errReason(err);
  return /timed out|ETIMEDOUT/i.test(reason) || /fc does not match/i.test(reason);
}

/**
 * True when the failure is "there is no socket any more", as opposed to anything the device
 * said. jsmodbus rejects the request that was in flight when the socket closed with
 * "connection to modbus server closed", and every request queued after that — without
 * putting it on the wire at all — with "no connection to modbus server".
 *
 * Worth telling apart from every other failure because it says nothing about the registers
 * and everything about the connection. A poll that only ever saw this read no registers, but
 * it read none of them for a reason no driver can diagnose from its own data: the drivers
 * check their key register, find it null and report what that means when a device IS talking
 * — "LUNA2000 battery not detected", "DTSU666 meter not detected". A user with a healthy
 * battery is then sent to inspect the RS485 cable. Reported from the field on 2026-08-20
 * (log cee22305): 60 refused reads per poll, not one of which reached the wire, and a device
 * tile blaming the battery.
 */
function _isConnectionLost(err) {
  return /no connection to modbus server|connection to modbus server closed/i.test(_errReason(err));
}

// Reports what batching achieved, once per distinct register set. Logged on first use rather
// than every poll: it answers "did grouping actually work on this hardware" without becoming
// noise. A plan only changes when the register map or the nameplate cache changes, so this
// stays at a handful of lines per app start.
const _planLogged = new Set();

function _notePlan(plan, registerCount) {
  if (!plan.length) return;
  const key = `${plan[0][0].start}:${registerCount}:${plan.length}`;
  if (_planLogged.has(key)) return;
  _planLogged.add(key);
  // eslint-disable-next-line no-console
  console.log(`[modbus] read plan from ${plan[0][0].start}: ${registerCount} registers in ${plan.length} request(s)`);
}

function scaleValue(value, decimalPower) {
  if (typeof value === 'number' && decimalPower !== 0) {
    const scaled = value * Math.pow(10, decimalPower);
    return Math.round(scaled * 1e4) / 1e4;
  }
  return value;
}

/**
 * Reads a register map from the client, one register per request.
 *
 * Every name in `registers` is present in the result; a value that could not be read is
 * null. If `shouldAbort()` returns true the loop exits early (a write is waiting).
 *
 * Reading several adjacent registers in one request was tried (v1.2.47) and reverted:
 * the SDongle gateway rejects essentially every multi-register read — measured down to a
 * two-word span of two adjacent, individually readable registers. It cost a burst of
 * doomed requests per poll and returned nothing. If you ever talk to an inverter
 * directly rather than through an SDongle, it may be worth revisiting; the implementation
 * is in the v1.2.47 tag.
 *
 * @param {Object}   registers   { name: [address, length, dataType, label, decimalPower] }
 * @param {Object}   client      jsmodbus TCP client
 * @param {Function} [shouldAbort]  optional () => boolean abort callback
 * @returns {Promise<Object>} { name: scaledValue | null }
 */
/**
 * Groups registers into as few requests as possible, using the same rule as
 * wlcrs/huawei-solar-lib (device/base.py batch_update): extend a batch while the span stays
 * within MAX_BATCHED_REGISTERS_COUNT words and the gap to the next register stays below
 * MAX_BATCHED_REGISTERS_GAP. Reading a gap is cheaper than paying for a second round trip,
 * but only up to a point.
 *
 * @param {object} registers name → [address, length, dataType, unit, decimalPower]
 * @returns {Array<Array<{name: string, def: Array, start: number, end: number}>>}
 */
function buildReadPlan(registers) {
  const entries = Object.entries(registers)
    .filter(([, def]) => Array.isArray(def))
    .map(([name, def]) => ({ name, def, start: def[0], end: def[0] + def[1] - 1 }))
    .sort((a, b) => a.start - b.start);

  const plan = [];
  let i = 0;
  while (i < entries.length) {
    let j = i;
    while (
      j + 1 < entries.length
      && entries[j + 1].end - entries[i].start <= MAX_BATCHED_REGISTERS_COUNT
      && entries[j + 1].start - entries[j].end < MAX_BATCHED_REGISTERS_GAP
    ) j++;
    plan.push(entries.slice(i, j + 1));
    i = j + 1;
  }
  return plan;
}

// Slices one batched response into its individual register values. Each register sits at its
// own offset from the start of the span; the words covering gaps are simply never read.
function _decodeSpan(group, buf, result) {
  const base = group[0].start;
  for (const { name, def } of group) {
    const [address, length, dataType, , decimalPower] = def;
    const off = (address - base) * 2;
    if (off + length * 2 > buf.length) { result[name] = null; continue; }
    result[name] = scaleValue(parseBuffer(buf.subarray(off, off + length * 2), dataType), decimalPower || 0);
  }
}

/**
 * Reads one batch. On failure it halves the batch and retries each half, down to single
 * registers — real hardware refuses a whole request if any address in it is unreadable, so
 * one absent register must not cost its neighbours. Only a failing SINGLE register is
 * recorded as null and logged.
 *
 * `allowRetry` is used for the very first request of a connection: Huawei devices discard
 * that one whatever it is, so it gets one straight repeat before we conclude anything about
 * its contents. Without this the first batch would be bisected all the way down every time,
 * turning the positional quirk into a storm of extra round trips.
 */
async function _readSpan(group, client, result, allowRetry, stats) {
  const start = group[0].start;
  const words = group[group.length - 1].end - start + 1;

  await delay(READ_DELAY_MS);
  try {
    const resp = await client.readHoldingRegisters(start, words);
    const buf = resp.response.body.valuesAsBuffer;
    // A truncated reply must not be sliced into plausible-looking nonsense.
    if (buf.length < words * 2 && group.length > 1) throw new Error('short response');
    _decodeSpan(group, buf, result);
  } catch (err) {
    // Recorded on the poll's own object rather than a module-level flag: two hosts can be
    // polled concurrently (they only share a lock per host:port), and a shared flag would
    // let one host's dead socket describe the other's poll.
    if (stats && _isConnectionLost(err)) stats.connectionLost = true;
    if (allowRetry) return _readSpan(group, client, result, false, stats);
    if (group.length === 1) {
      result[group[0].name] = null;
      _noteReadError(start, words, err);
      return;
    }
    // Splitting assumes the socket still answers the question it was asked. After a timeout
    // or a function-code mismatch it demonstrably does not: in 18 h of field logs every
    // cascade opens with one of those two and then fails every sub-request that follows on
    // the same connection. Those doomed round trips cost real time — one tick was measured
    // at 7.3 s against a 352 ms average — and they are the only path that can hand a reply
    // from one address to a request for another, which is how max_feed_in_power once
    // arrived outside its own permitted range.
    //
    // Deliberately NOT abandoning the rest of the plan: Huawei devices discard the first
    // request of every connection whatever it is, so a timeout there is routine. Giving up
    // on the remaining batches would empty the block one register per poll — the regression
    // 1.2.53 caused and the test above pins. The batch is written off, the next one gets
    // its chance, and the next poll opens a fresh socket.
    if (_isDesync(err)) {
      _noteBatchSplit(start, words, group.length, err, 'pairing unreliable, batch skipped');
      for (const { name } of group) result[name] = null;
      return;
    }
    _noteBatchSplit(start, words, group.length, err);
    const mid = Math.ceil(group.length / 2);
    await _readSpan(group.slice(0, mid), client, result, false, stats);
    await _readSpan(group.slice(mid), client, result, false, stats);
  }
}

async function readRegisters(registers, client, shouldAbort) {
  const result = {};
  for (const name of Object.keys(registers)) result[name] = null;

  const stats = { connectionLost: false };
  const plan = buildReadPlan(registers);
  _notePlan(plan, Object.keys(result).length);
  for (let i = 0; i < plan.length; i++) {
    if (shouldAbort && shouldAbort()) break; // a write or a settings probe is waiting
    await _readSpan(plan[i], client, result, i === 0, stats);
  }

  // A poll that lost the socket and read nothing is a failed poll, not an empty one. Left as
  // a resolved all-nulls result it reached the driver as data, and each driver said what an
  // absent key register means when the device IS answering — the battery is not detected,
  // the meter is not detected — which is the wrong fault, pointed at the wrong hardware.
  //
  // Only when NOTHING was read. A poll that got some registers before the socket closed
  // keeps them: those replies were real, and discarding them would empty a block that is
  // partly working, which is the regression 1.2.53 caused (see _readSpan). The partial case
  // therefore still reaches the driver's own validity check, and can still name the wrong
  // cause; catching that needs a rule about how much of a poll may be missing, which is a
  // different question from this one.
  if (stats.connectionLost && Object.values(result).every((v) => v === null)) {
    const err = new Error('Modbus connection closed before any register could be read');
    err.modbusConnectionLost = true;
    throw err;
  }

  return result;
}

/**
 * Opens a Modbus TCP connection, reads the given registers, then closes.
 * Calls are serialised per host:port so concurrent device polls never race.
 *
 * @param {string}   host
 * @param {number}   port
 * @param {number}   unitId
 * @param {Object}   registers
 * @param {Function} [shouldAbort]  optional () => boolean — when true, stops reading early
 * @returns {Promise<Object>}
 */
function readModbusRegisters(host, port, unitId, registers, shouldAbort) {
  const key = `${host}:${port}`;
  // Checked BEFORE taking the host lock: the whole point is to not occupy the bus for
  // ~30 s per attempt while a device is down, which would drag every other device behind
  // the same SDongle down with it.
  if (_circuitOpen(key)) {
    return Promise.reject(new Error(`${key} unreachable — backing off, will retry shortly`));
  }
  // Yield the bus to a waiting settings-page probe as well as to the driver's own reason
  // (a queued write). Without this the probe would sit behind a full polling cycle.
  const abort = () => (shouldAbort ? !!shouldAbort() : false) || _priorityWaiting(host, port);

  // Decide what actually has to go on the bus: skip nameplate registers we already know and
  // registers that have proven they never answer. Both are served from `preset`.
  const now = Date.now();
  const preset = {};
  const toRead = {};
  for (const [name, def] of Object.entries(registers)) {
    const cacheKey = _staticKey(host, port, unitId, def[0]);
    const hit = STATIC_REGISTER_ADDRESSES.has(def[0]) ? _staticCache.get(cacheKey) : undefined;
    if (hit && now - hit.at < STATIC_TTL_MS) preset[name] = hit.value;
    else toRead[name] = def;
  }
  // If the cache would leave nothing to read we ignore it for this poll, so that a poll always
  // still opens a connection and an unreachable device is still detected as such.
  const usePreset = Object.keys(preset).length > 0 && Object.keys(toRead).length > 0;
  const wanted = usePreset ? toRead : registers;

  const attempt = async () => {
    const res = await _connect(host, port, unitId, (client) => readRegisters(wanted, client, abort));
    // Only remember successful reads: a timed-out nameplate register must not be cached as
    // empty for a whole day.
    for (const [name, def] of Object.entries(wanted)) {
      if (STATIC_REGISTER_ADDRESSES.has(def[0]) && res[name] !== null && res[name] !== undefined) {
        _staticCache.set(_staticKey(host, port, unitId, def[0]), { value: res[name], at: Date.now() });
      }
    }
    if (!usePreset) return res;
    // Rebuild in the caller's key order rather than spreading, so a partially served poll is
    // indistinguishable from a full one.
    const merged = {};
    for (const name of Object.keys(registers)) merged[name] = name in res ? res[name] : preset[name];
    return merged;
  };

  // One all-clear line per device, at the end of the first poll in which nothing failed.
  // Reported by a user of the per-span version: the failures said "read 47589/1 failed"
  // and the recovery arrived 148 s later as "batch 47589/1 reading again" — the wrong
  // altitude for the question actually being asked, which is whether this inverter is
  // being read properly again, and far enough away to read as an unrelated line.
  const _finishPoll = (ok) => {
    if (!ok) return;
    if (_pollFailures > 0) {
      _hostDegraded.set(key, (_hostDegraded.get(key) || 0) + 1);
      return;
    }
    const bad = _hostDegraded.get(key);
    if (!bad) return;
    _hostDegraded.delete(key);
    // eslint-disable-next-line no-console
    console.log(`[modbus] ${key}: all registers reading cleanly again, after ${bad} poll(s) with failures`);
  };

  return withHostLock(host, port, async () => {
    try {
      _pollFailures = 0;
      const res = await attempt();
      _circuitRecord(key, true);
      _finishPoll(true);
      return res;
    } catch (err) {
      // Huawei inverters/SDongles occasionally reject the first TCP connection.
      // One automatic retry after a short pause is enough to recover reliably.
      await delay(1500);
      try {
        _pollFailures = 0;   // the retry is its own poll; the first one's tally is spent
        const res = await attempt();
        _circuitRecord(key, true);
        _finishPoll(true);
        return res;
      } catch (err2) {
        _circuitRecord(key, false);
        throw err2;
      }
    }
  });
}

/**
 * Turns a failed poll into something the device tile can say to a person.
 *
 * Node's connection errors are precise and unreadable without a packet trace, and they
 * are what the tile showed: "Modbus read failed: Socket error: connect EHOSTUNREACH
 * 192.168.0.226:502". Every one of those three means the same thing to the owner — the
 * device is not answering at that address — and that is what they need to act on, since
 * it is nearly always a box that is powered off or a DHCP lease that moved.
 *
 * Only the connection-level errors are translated. A Modbus-level fault (a refused
 * register, an exception code) keeps its raw message, because there the detail IS the
 * information.
 */
function unavailableMessage(homey, err, host) {
  const msg = (err && err.message) || String(err || '');
  // Flagged rather than pattern-matched: readRegisters raises this one itself, and the text
  // it raises must be free to change without silently falling through to "read failed".
  if (err && err.modbusConnectionLost) {
    return homey.__('modbus.errors.host.closed').replace('{{host}}', host || '?');
  }
  const key = /EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ENOTFOUND/.test(msg) ? 'unreachable'
    : /ETIMEDOUT|timed out/i.test(msg) ? 'timeout'
      : /ECONNREFUSED/.test(msg) ? 'refused'
        : null;
  if (!key) return `${homey.__('modbus.errors.fetchFailed')}: ${msg}`;
  return homey.__(`modbus.errors.host.${key}`).replace('{{host}}', host || '?');
}

// `onSocket` hands the socket to the caller the moment it exists, so a caller that gives up
// early can tear the connection down instead of walking away from it. Nothing else may use
// it: the socket belongs to this function for every ordinary purpose.
function _connect(host, port, unitId, fn, responseTimeout = RESPONSE_TIMEOUT_MS, onSocket) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const client = new Modbus.client.TCP(socket, unitId, responseTimeout);
    socket.setKeepAlive(false);
    if (typeof onSocket === 'function') onSocket(socket);

    const connectTimeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Connection to ${host}:${port} timed out`));
    }, CONNECT_TIMEOUT_MS);

    socket.on('connect', async () => {
      clearTimeout(connectTimeout);
      try {
        // wlcrs/huawei-solar-lib settles for a full second after connecting
        // (create_client: wait_after_connect = 1.0). We used half that, which is the most
        // likely reason the first request of every connection went unanswered here and not
        // there — on top of the reference holding ONE persistent connection, so it pays this
        // settling cost once ever, while we reconnect for every block of every poll.
        await delay(POST_CONNECT_MS);
        const result = await fn(client);
        // Resolve only once the socket is really gone. socket.end() merely starts the FIN
        // handshake; returning immediately released the host lock while the connection was
        // still half-open, so the next queued request opened a second one. Huawei devices
        // accept exactly one Modbus connection and drop the older on a new connect — which
        // showed up as "connection to modbus server closed" mid-poll and wrong values.
        await new Promise((done) => {
          let settled = false;
          const finish = () => { if (settled) return; settled = true; done(); };
          socket.once('close', finish);
          socket.end();
          const t = setTimeout(finish, 1000); // never hang if 'close' does not arrive
          if (typeof t.unref === 'function') t.unref();
        });
        resolve(result);
      } catch (err) {
        socket.destroy();
        reject(err);
      }
    });

    socket.on('error', (err) => {
      clearTimeout(connectTimeout);
      reject(new Error(`Socket error: ${err.message}`));
    });

    socket.connect({ host, port });
  });
}

/**
 * Writes a single 16-bit register value via Modbus TCP (FC06).
 * Serialised through the same per-host lock as reads.
 *
 * @param {string} host
 * @param {number} port
 * @param {number} unitId
 * @param {number} address   Register address
 * @param {number} value     16-bit integer value to write
 * @returns {Promise<void>}
 */
function writeModbusRegister(host, port, unitId, address, value) {
  return withHostLock(host, port, async () => {
    const write = (client) => client.writeSingleRegister(address, value);
    // 2 attempts: the SDongle often processes the write but delays the TCP response.
    // A single retry is enough to recover from transient fc-mismatch rejections without
    // sending the same command 4× (which risks duplicate execution on slow SDongles).
    const delays = [3000];
    let lastErr;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        return await _connect(host, port, unitId, write, WRITE_TIMEOUT_MS);
      } catch (err) {
        lastErr = err;
        if (attempt < delays.length) await delay(delays[attempt]);
      }
    }
    throw lastErr;
  });
}

/**
 * Writes a 32-bit unsigned integer to two consecutive registers via Modbus TCP (FC16).
 * Used for U32 registers where FC06 (single-register) cannot span two words atomically.
 *
 * @param {string} host
 * @param {number} port
 * @param {number} unitId
 * @param {number} address   Starting register address (high word)
 * @param {number} value     32-bit unsigned integer value to write
 * @returns {Promise<void>}
 */
function writeModbusU32(host, port, unitId, address, value) {
  return withHostLock(host, port, async () => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(value >>> 0, 0); // big-endian U32
    const write = (client) => client.writeMultipleRegisters(address, buf);
    // 2 attempts: same rationale as writeModbusRegister above.
    const delays = [3000];
    let lastErr;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        return await _connect(host, port, unitId, write, WRITE_TIMEOUT_MS);
      } catch (err) {
        lastErr = err;
        if (attempt < delays.length) await delay(delays[attempt]);
      }
    }
    throw lastErr;
  });
}

/**
 * Writes consecutive 16-bit registers in one request (FC16) — a block that must change as
 * a whole, like the 43 words of the TOU windows at 47255. Same two attempts as above.
 *
 * @param {number[]} values  one unsigned 16-bit value per register
 */
function writeModbusRegisters(host, port, unitId, address, values) {
  return withHostLock(host, port, async () => {
    const buf = Buffer.alloc(values.length * 2);
    values.forEach((v, i) => buf.writeUInt16BE(v & 0xFFFF, i * 2));
    const write = (client) => client.writeMultipleRegisters(address, buf);
    const delays = [3000];
    let lastErr;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        return await _connect(host, port, unitId, write, WRITE_TIMEOUT_MS);
      } catch (err) {
        lastErr = err;
        if (attempt < delays.length) await delay(delays[attempt]);
      }
    }
    throw lastErr;
  });
}

/**
 * Probes a single Modbus unit ID with a hard timeout.
 *
 * Runs under the same per-host lock as polling. It used to bypass it, on the assumption
 * that the caller had paused polling first — but pausing only clears the interval timer,
 * so a poll already in flight keeps running, and api.js gives up waiting for it after 2 s.
 * The probe then opened a second connection to a device that permits exactly one, which
 * made the inverter drop the first: the running poll failed mid-way with "connection to
 * modbus server closed" and published wrong values (PV=0W), while the probe itself got
 * "no connection to modbus server" for every remaining register. That is the real cause
 * of the long-standing "may need several attempts if the Modbus port is busy" flakiness.
 *
 * The timeout starts only once the lock is held, so time spent queuing behind a poll is
 * not charged against the read budget. Retries are still skipped so that probing several
 * unit IDs stays quick.
 *
 * @param {string}  host
 * @param {number}  port
 * @param {number}  unitId
 * @param {Object}  registers   { key: [address, length, dataType, label, decimalPower] }
 * @param {number}  [timeoutMs=9000]
 * @returns {Promise<Object|null>}  Parsed register values, or null on error/timeout.
 */
function probeModbusUnit(host, port, unitId, registers, timeoutMs = 9000) {
  _acquirePriority(host, port);
  let released = false;
  const release = () => { if (!released) { released = true; _releasePriority(host, port); } };
  return withHostLock(host, port, async () => {
    release(); // we hold the bus now — stop asking the others to yield
    let timedOut = false;
    let socket = null;
    let timer;

    // Field-caught 2026-09-03: a unit-ID scan reported connections opening and not one
    // register with content, on a plant whose inverter answers in 1.6 s when asked alone.
    //
    // The race below used to be the whole of it, and a race only abandons the loser. When
    // the timeout won, this returned null and released the host lock while the connection
    // was still open and still working through its remaining reads — several seconds of it,
    // one response timeout per register. The next unit ID then opened a second connection
    // on a device that accepts one, and every address after the first slow one came back
    // empty. _connect's own comment describes exactly this failure for the success path;
    // the timeout path walked straight into it.
    //
    // So the timeout now tears the connection down and waits for it to be gone before the
    // bus is handed on. shouldAbort stops the read loop between registers; destroying the
    // socket is what ends the one already in flight.
    const attempt = _connect(
      host, port, unitId,
      (client) => readRegisters(registers, client, () => timedOut),
      RESPONSE_TIMEOUT_MS,
      (s) => { socket = s; },
    );
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => {
        timedOut = true;
        if (socket) socket.destroy();
        rej(new Error('Probe timeout'));
      }, timeoutMs);
    });

    try {
      return await Promise.race([attempt, timeout]);
    } finally {
      clearTimeout(timer);
      // Bounded: a socket that will not settle must not hold the bus for ever either. Two
      // seconds is past the close handshake and far short of the gap the scan keeps anyway.
      await Promise.race([
        attempt.catch(() => {}),
        new Promise((r) => {
          const t = setTimeout(r, SOCKET_CLOSE_GRACE_MS);
          if (typeof t.unref === 'function') t.unref();
        }),
      ]);
    }
  }).catch(() => null).finally(release); // always resolve — null means "no response"
}

/**
 * Safe integer parser — avoids the `parseInt("0") || 1 === 1` falsiness bug.
 * Use instead of `parseInt(val, 10) || fallback` everywhere a 0 is a valid value.
 */
function parseIntSafe(val, fallback) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Clears the per-host back-off. Called when a device's settings change or it is re-paired,
 *  so a corrected IP/port takes effect immediately instead of waiting out the cooldown. */
function resetModbusBackoff(host, port) {
  _circuit.delete(`${host}:${port}`);
}

/**
 * Modbus "Read Device Identification" — function code 0x2B, MEI type 0x0E.
 *
 * Asks a device who it is without knowing a single register address: the reply carries
 * vendor name, product code and revision as plain strings. That makes it the one probe
 * that says something useful about a device this app does not know, where a register scan
 * can only report silence.
 *
 * Written by hand because jsmodbus implements function codes 1-6, 15 and 16 and not this
 * one. The framing is small enough to be worth it rather than forking the library:
 *
 *   MBAP header  transaction(2) protocol(2)=0 length(2) unit(1)
 *   request PDU  0x2B 0x0E readDeviceIdCode(0x01=basic) objectId(0x00=VendorName)
 *   reply PDU    0x2B 0x0E code conformity moreFollows nextObjectId objectCount
 *                then per object: id(1) length(1) value(length)
 *   exception    0xAB followed by one exception code — 0x01 means the device does not
 *                implement this, which is common and is not an error worth showing.
 *
 * Read Device Identification is OPTIONAL in the Modbus specification, so a null result
 * means "did not answer", never "not a Modbus device".
 *
 * Goes through withHostLock like every other access here. It is a second TCP session to a
 * device that generally permits one, and opening it alongside a poll is what leaves these
 * devices half-open.
 */
const DEVICE_ID_OBJECTS = {
  0x00: 'vendorName',
  0x01: 'productCode',
  0x02: 'revision',
  0x03: 'vendorUrl',
  0x04: 'productName',
  0x05: 'modelName',
  0x06: 'applicationName',
};

function parseDeviceIdResponse(pdu) {
  // Exception reply: function code with the high bit set.
  if (pdu.length >= 2 && pdu[0] === 0xAB) return null;
  if (pdu.length < 7 || pdu[0] !== 0x2B || pdu[1] !== 0x0E) return null;

  const count = pdu[6];
  const out = {};
  let at = 7;
  for (let i = 0; i < count; i++) {
    if (at + 2 > pdu.length) break;              // truncated reply — keep what parsed
    const id = pdu[at];
    const len = pdu[at + 1];
    if (at + 2 + len > pdu.length) break;
    const name = DEVICE_ID_OBJECTS[id] || `object${id}`;
    // Latin-1: the spec says ISO-8859-1, and a stray high byte must not become U+FFFD.
    out[name] = pdu.slice(at + 2, at + 2 + len).toString('latin1').replace(/\0/g, '').trim();
    at += 2 + len;
  }
  return Object.keys(out).length ? out : null;
}

function readDeviceIdentification(host, port, unitId, timeoutMs = 3000) {
  return withHostLock(host, port, () => new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);

    socket.once('error', () => { clearTimeout(timer); done(null); });
    socket.once('close', () => { clearTimeout(timer); done(null); });

    socket.connect(port, host, () => {
      const pdu = Buffer.from([0x2B, 0x0E, 0x01, 0x00]);
      const frame = Buffer.alloc(7 + pdu.length);
      frame.writeUInt16BE(1, 0);                 // transaction id
      frame.writeUInt16BE(0, 2);                 // protocol id
      frame.writeUInt16BE(pdu.length + 1, 4);    // length: unit id + pdu
      frame.writeUInt8(unitId & 0xFF, 6);
      pdu.copy(frame, 7);
      socket.write(frame);
    });

    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 7) return;                // MBAP header not complete yet
      const declared = buf.readUInt16BE(4);      // unit id + pdu
      if (buf.length < 6 + declared) return;     // reply still arriving
      clearTimeout(timer);
      done(parseDeviceIdResponse(buf.slice(7, 6 + declared)));
    });
  })).catch(() => null);
}

module.exports = {
  readModbusRegisters,
  readDeviceIdentification,
  writeModbusRegister,
  writeModbusU32,
  writeModbusRegisters,
  probeModbusUnit,
  parseIntSafe,
  resetModbusBackoff,
  unavailableMessage,
  // The settings-page port scanner opens raw TCP sockets rather than speaking Modbus,
  // so it cannot go through probeModbusUnit — but it still hits port 502 on devices that
  // accept only one connection. It borrows the lock directly to stay off a busy bus.
  withHostLock,
  // exported for unit tests
  readRegisters,
  buildReadPlan,
  parseBuffer,
  // Test hook: also clears the failure bookkeeping, so one test's simulated outage cannot
  // make the next one announce a recovery.
  // Test hook: how many transport failures the poll that just ran recorded.
  _pollFailuresForTest: () => _pollFailures,
  _resetStaticCache: () => { _staticCache.clear(); _hostDegraded.clear(); _readErrLogged.clear(); _pollFailures = 0; },
};
