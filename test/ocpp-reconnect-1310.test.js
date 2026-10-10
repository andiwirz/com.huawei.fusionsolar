'use strict';

// A charger that reconnects, and a transaction across a lost connection (1.2.310, review of
// 2026-10-10).
//
//   1. A charger that loses power or its WiFi does not close its socket; it opens a new one when
//      it is back. The old one was found dead only later — the server's ping never checks for
//      an answer — and its close removed the NEW socket from the server and reported the charger
//      disconnected. Data kept arriving, every command failed with "not connected".
//   2. The device dropped its transaction on every disconnect, and nothing brought it back: the
//      charger's "Charging" after the reconnect was no change of state. Stop did nothing, a 0 A
//      pause had "nothing to pause", a new limit was overridden by the session's own profile —
//      the EMS had lost the car for the rest of the session.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const Module = require('module');

// ── 1. the server ───────────────────────────────────────────────────────────────

const OcppServer = require('../lib/ocpp-server.js');

class FakeSocket extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; this.sent = []; this.terminated = false; }
  send(d) { this.sent.push(d); }
  ping() {}
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
  terminate() { this.terminated = true; this.close(); }
}
const req = (id) => ({ url: `/ocpp/${id}`, socket: { remoteAddress: '192.0.2.50' }, headers: {} });

function server() {
  const logs = [];
  const s = new OcppServer({ log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) });
  s.logs = logs;
  return s;
}
function chargerDevice() {
  return { connects: 0, disconnects: 0, onOcppConnected() { this.connects++; }, onOcppDisconnected() { this.disconnects++; },
    onServerStarted() {}, onStatusNotification() {}, onMeterValues() {}, onHeartbeat() {} };
}
const shut = (...sockets) => sockets.forEach((w) => w.close());   // ends their ping timers

test('a charger that reconnects keeps its new connection when the old one dies', () => {
  const s = server();
  const dev = chargerDevice();
  s._devices.set('CP1', dev);
  const old = new FakeSocket();
  const fresh = new FakeSocket();

  s._onConnection(old, req('CP1'));
  s._onConnection(fresh, req('CP1'));          // back after a power cut; the old socket never closed

  assert.strictEqual(s._clients.get('CP1'), fresh);
  assert.strictEqual(old.terminated, true, 'the dead connection was left lying around');
  assert.strictEqual(s.isConnected('CP1'), true, 'commands would fail with "not connected"');
  assert.strictEqual(dev.disconnects, 0, 'the old socket\'s close reported a live charger as gone');
  assert.ok(s.logs.some((l) => /CP1 reconnected — closing its previous connection/.test(l)));

  fresh.close();                               // a real disconnect still counts
  assert.strictEqual(s.isConnected('CP1'), false);
  assert.strictEqual(dev.disconnects, 1);
});

test('a late close of the old socket — the order the field produces — changes nothing', () => {
  const s = server();
  const dev = chargerDevice();
  s._devices.set('CP1', dev);
  const old = new FakeSocket();
  old.terminate = () => {};                    // half-open: terminating it does not close it yet
  const fresh = new FakeSocket();
  s._onConnection(old, req('CP1'));
  s._onConnection(fresh, req('CP1'));
  old.readyState = 3; old.emit('close');       // minutes later, when a ping finally fails

  assert.strictEqual(s._clients.get('CP1'), fresh);
  assert.strictEqual(dev.disconnects, 0);
  shut(fresh);
});

test('the catch-all device keeps its charger when that charger reconnects', () => {
  const s = server();
  const dev = chargerDevice();
  s._devices.set('', dev);                     // a device with no Station ID takes any charger
  const old = new FakeSocket();
  const fresh = new FakeSocket();
  s._onConnection(old, req('Garage'));
  s._onConnection(fresh, req('Garage'));
  assert.strictEqual(s._resolvedStationIds.get(''), 'Garage');
  assert.strictEqual(s.isConnected(''), true);
  assert.strictEqual(dev.disconnects, 0);
  shut(fresh);
});

test('a stop uses the transaction the device holds when the server has none — after an app update', async () => {
  const s = server();
  const ws = new FakeSocket();
  s._devices.set('CP1', chargerDevice());
  s._onConnection(ws, req('CP1'));
  let sent = null;
  s._sendCallAsync = async (socket, action, payload) => { sent = { action, payload }; return { status: 'Accepted' }; };

  await assert.rejects(s.remoteStopAsync('CP1'), /No active transaction/, 'the server map is meant to be empty here');
  await s.remoteStopAsync('CP1', 4711);
  assert.deepStrictEqual(sent, { action: 'RemoteStopTransaction', payload: { transactionId: 4711 } });

  s._txnIds.set('CP1', 99);                    // the server's own, fresher one wins
  await s.remoteStopAsync('CP1', 4711);
  assert.strictEqual(sent.payload.transactionId, 99);
  shut(ws);
});

// ── 2. the device ───────────────────────────────────────────────────────────────

const fakeServer = {
  stops: [], sent: [],
  isConnected: () => true,
  async remoteStopAsync(stationId, txnId) { fakeServer.stops.push(txnId); return { status: 'Accepted' }; },
  async setMaxCurrentAsync() { return { status: 'Accepted' }; },
  async setTxProfileAsync(id, txn, amps) { fakeServer.sent.push({ txn, amps }); return { status: 'Accepted' }; },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  if (request === '../../lib/ocpp-server') return { getInstance: () => fakeServer };
  return origLoad.call(this, request, parent, isMain);
};
const OcppDevice = require('../drivers/smartcharger_ocpp/device.js');
Module._load = origLoad;

function device() {
  const d = Object.create(OcppDevice.prototype);
  d.logs = [];
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = d.log;
  d.timers = [];
  d.homey = {
    setTimeout: (fn, ms) => { const t = { fn, ms }; d.timers.push(t); return t; },
    clearTimeout: (t) => { const i = d.timers.indexOf(t); if (i >= 0) d.timers.splice(i, 1); },
    flow: { getDeviceTriggerCard: () => ({ trigger: () => Promise.resolve() }) },
  };
  d.caps = { meter_power: 12.5 };
  d.store = {};
  d.settings = { station_id: 'CP1', auto_start_charging: true, default_charging_amps: '16' };
  d.getSetting = (k) => d.settings[k];
  d.getCapabilityValue = (k) => d.caps[k];
  d._set = async (k, v) => { d.caps[k] = v; };
  d.setStoreValue = async (k, v) => { d.store[k] = v; };
  d.getStoreValue = async (k) => d.store[k];
  d._setChargingState = async (st) => { d.caps.state = st; };
  d._updateSessionStatus = async () => {};
  d._updateChargingProfile = async () => {};
  d._postNotification = async () => {};
  d._recordSession = async (e) => { (d.sessions = d.sessions || []).push(e); };
  d._handleStateChange = async () => {};
  d._fireFaultTrigger = () => {};
  d._getPhases = () => 3;
  // a session in progress, as onStartTransaction leaves it
  d._txnId = 4711; d._txnStartTime = Date.now() - 600_000; d._txnMeterStart = 10_000;
  d._txnAmps = 16; d._autoStartBlocked = false; d._prevState = 'charging';
  d.stitchedSession = null; d._quickAbortCount = 0;
  return d;
}
const fireTimers = async (d) => { const due = d.timers.splice(0); for (const t of due) await t.fn(); await new Promise((r) => setImmediate(r)); };

test('a dropped connection keeps the transaction, so Stop still stops after the reconnect', async () => {
  fakeServer.stops = [];
  const d = device();
  d.onOcppDisconnected();
  assert.strictEqual(d._txnId, 4711, 'the transaction was forgotten on a mere connection loss');
  assert.ok(d.logs.some((l) => /transaction 4711 kept/.test(l)));

  d.onStatusNotification({ connectorId: 1, status: 'Charging', errorCode: 'NoError' });   // back, still charging
  await d.stopCharging();
  assert.deepStrictEqual(fakeServer.stops, [4711], 'Stop did nothing after the reconnect');
});

test('…and a new limit goes to the session, not to the default profile it would not override', async () => {
  fakeServer.sent = [];
  const d = device();
  d.onOcppDisconnected();
  await d.setChargingLimit(10);
  assert.deepStrictEqual(fakeServer.sent.map((x) => x.txn), [4711]);
});

test('an auto-start block survives the drop as well', () => {
  const d = device();
  d._autoStartBlocked = true;
  d.onOcppDisconnected();
  assert.strictEqual(d._autoStartBlocked, true, 'a blocked car would be released by the next limit');
});

test('a transaction that ended while the charger was away is closed once "Available" outlasts the grace', async () => {
  const d = device();
  d.onOcppDisconnected();
  d.onStatusNotification({ connectorId: 1, status: 'Available', errorCode: 'NoError' });   // rebooted, no car
  assert.strictEqual(d.timers.length, 1);
  assert.strictEqual(d.timers[0].ms, 30_000);
  await fireTimers(d);
  assert.strictEqual(d._txnId, null, 'the stale transaction stayed open for ever');
  assert.strictEqual(d.store.activeSession, null);
  assert.ok(d.logs.some((l) => /Transaction 4711 ended while the charger was away/.test(l)));

  // The charger's own StopTransaction, delivered late from its queue, is not booked twice.
  const before = (d.sessions || []).length;
  await d.onStopTransaction({ transactionId: 4711, meterStop: 13_000, reason: 'EVDisconnected' });
  assert.strictEqual((d.sessions || []).length, before, 'the same session was recorded twice');
  assert.ok(d.logs.some((l) => /arrived after it was closed here — already accounted/.test(l)));
});

test('a StopTransaction inside the grace wins, and a charger charging again is left alone', async () => {
  const d = device();
  d.onStatusNotification({ connectorId: 1, status: 'Available', errorCode: 'NoError' });
  await d.onStopTransaction({ transactionId: 4711, meterStop: 13_000, reason: 'EVDisconnected' });
  await fireTimers(d);
  assert.ok(!d.logs.some((l) => /ended while the charger was away/.test(l)), 'closed twice');

  const e = device();
  e.onStatusNotification({ connectorId: 1, status: 'Available', errorCode: 'NoError' });
  e.onStatusNotification({ connectorId: 1, status: 'Charging', errorCode: 'NoError' });   // a blip
  await fireTimers(e);
  assert.strictEqual(e._txnId, 4711, 'a running session was closed on a passing "Available"');
});
