'use strict';

// Four OCPP faults from the review of 2026-10-10 (1.2.315).
//
//   1. A resume after a 0 A pause started at the current from before the pause, not at the
//      one the card asked for.
//   2. Removing the last OCPP device left its charger connected to a dead server, so a device
//      added again never heard from it.
//   3. A Station ID changed in the settings was not applied until the app restarted.
//   4. Every charging profile ended after 24 hours.
// And one regression of 1.2.310 found on the way: a socket the server let go of itself (a
// port change) no longer told its device that it was disconnected.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const Module = require('module');

const OcppServer = require('../lib/ocpp-server.js');

class FakeSocket extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; this.sent = []; this.closedWith = null; }
  send(d) { this.sent.push(d); }
  ping() {}
  // As in the ws package: close() starts the closing handshake, and 'close' fires later —
  // after the server has already moved on (cleared its list, rebound its port).
  close(code, reason) {
    if (this.readyState >= 2) return;
    this.closedWith = { code, reason }; this.readyState = 2;
    setImmediate(() => { this.readyState = 3; this.emit('close'); });
  }
  terminate() { this.close(1006); }
}
const req = (id) => ({ url: `/ocpp/${id}`, socket: { remoteAddress: '192.0.2.50' }, headers: {} });
const server = () => new OcppServer({ log() {}, error() {} });
const chargerDevice = () => ({ disconnects: 0, onOcppConnected() {}, onOcppDisconnected() { this.disconnects++; },
  onServerStarted() {}, onStatusNotification() {}, onMeterValues() {} });

// ── 2. the last device removed ──────────────────────────────────────────────────

test('removing the last device lets its charger go, so it reconnects to the next server', () => {
  const s = server();
  const dev = chargerDevice();
  s.registerDevice('CP1', dev);
  const ws = new FakeSocket();
  s._onConnection(ws, req('CP1'));

  s.unregisterDevice('CP1');                   // the last one: the server stops

  assert.ok(ws.closedWith, 'the charger stayed on a server nobody uses any more');
  assert.strictEqual(ws.closedWith.code, 1001);
  assert.strictEqual(s._clients.size, 0);
});

test('a socket the server let go of itself still tells its device it is disconnected (1.2.310 regression)', async () => {
  const s = server();
  const dev = chargerDevice();
  s.registerDevice('CP1', dev);
  s.registerDevice('CP2', chargerDevice());   // not the last device: the server keeps running
  const ws = new FakeSocket();
  s._onConnection(ws, req('CP1'));
  s._stop();                                    // what a port change does before it rebinds
  await new Promise((r) => setImmediate(r));    // the close event, after the list was cleared
  assert.strictEqual(dev.disconnects, 1, 'the tile kept saying "connected" across a port change');
});

// ── 3. a Station ID changed ─────────────────────────────────────────────────────

test('the server moves a renamed device to its new ID, without stopping', () => {
  const s = server();
  const dev = chargerDevice();
  s.registerDevice('CP1', dev);
  s.setCredentials('CP1', 'user', 'secret');
  s.renameDevice('CP1', 'CP2', dev);
  assert.strictEqual(s._devices.get('CP2'), dev);
  assert.ok(!s._devices.has('CP1'), 'the old ID still routes to the device');
  assert.ok(!s._creds.has('CP1'));
  const ws = new FakeSocket();
  s._onConnection(ws, req('CP2'));
  assert.strictEqual(s.isConnected('CP2'), true);
  ws.close();
});

// ── 4. profiles without an end ──────────────────────────────────────────────────

test('charging profiles hold until replaced — no 24-hour end', async () => {
  const s = server();
  const ws = new FakeSocket();
  s.registerDevice('CP1', chargerDevice());
  s._onConnection(ws, req('CP1'));
  const sent = [];
  s._sendCallAsync = async (socket, action, payload) => { sent.push(payload); return { status: 'Accepted' }; };

  await s.setMaxCurrentAsync('CP1', 0, 3);            // the 1 W block of a car waiting for sun
  await s.setTxProfileAsync('CP1', 4711, 16, 3);
  assert.strictEqual(sent.length, 2);
  for (const p of sent) {
    const schedule = p.csChargingProfiles.chargingSchedule;
    assert.ok(!('duration' in schedule), `${p.csChargingProfiles.chargingProfilePurpose} still ends after ${schedule.duration} s`);
    assert.ok(schedule.startSchedule, 'an Absolute profile needs its start');
    assert.strictEqual(schedule.chargingSchedulePeriod.length, 1);
  }
  ws.close();
});

// ── the device: resume, and the Station ID in onSettings ────────────────────────

const fakeServer = {
  renamed: [], creds: [],
  renameDevice(oldId, newId) { fakeServer.renamed.push([oldId, newId]); },
  setCredentials(id, user) { fakeServer.creds.push([id, user]); },
  isConnected: () => true,
  holderOf: () => null, // 1.2.323: onSettings asks whether the Station ID is free
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  if (request === '../../lib/ocpp-server') return { getInstance: () => fakeServer, existing: () => fakeServer };
  return origLoad.call(this, request, parent, isMain);
};
const OcppDevice = require('../drivers/smartcharger_ocpp/device.js');
Module._load = origLoad;

function device(settings = {}) {
  const d = Object.create(OcppDevice.prototype);
  d.logs = [];
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = d.log;
  d.settings = { station_id: 'CP1', ocpp_port: 8887, number_of_phases: '3', charger_model: '22kt', ...settings };
  d.getSetting = (k) => d.settings[k];
  d.homey = { setTimeout: () => null, clearTimeout() {} };
  d._getPhases = () => 3;
  d._persistStitched = async () => {};
  d._startIdleGuard = () => {};
  return d;
}

test('a resume after a 0 A pause starts at the current the card asked for', async () => {
  const d = device();
  d._txnId = null;
  d._txnAmps = 16;                                    // kept through the pause on purpose
  d.stitchedSession = { paused: true, zeroAmpPause: true, resumeAmps: 16, resumePhases: null };
  d.isPaused = true;
  d.sessionOwner = 'ems';
  d._validateProfileRequest = () => {};
  const started = [];
  d.startCharging = async (amps, phases) => { started.push(amps); };

  await d.setChargingLimitFromCard(7);                // the EMS: 0 A earlier, now 7 A

  assert.deepStrictEqual(started, [7], 'resumed at the current from before the pause');
  assert.strictEqual(d._txnAmps, 7);
});

test('a changed Station ID is applied when saved — not after the next restart', async () => {
  fakeServer.renamed = []; fakeServer.creds = [];
  const d = device();
  const newSettings = { ...d.settings, station_id: 'CP2', ocpp_username: 'u' };
  await d.onSettings({ oldSettings: { ...d.settings }, newSettings, changedKeys: ['station_id'] });
  assert.deepStrictEqual(fakeServer.renamed, [['CP1', 'CP2']]);
  assert.deepStrictEqual(fakeServer.creds, [['CP2', 'u']], 'the credentials went to the old ID');
});

test('a page the settings refuse moves nothing', async () => {
  fakeServer.renamed = [];
  const d = device();
  const newSettings = { ...d.settings, station_id: 'CP2', charger_model: '7ks', number_of_phases: '3' };
  await assert.rejects(d.onSettings({ oldSettings: { ...d.settings }, newSettings, changedKeys: ['station_id', 'charger_model'] }));
  assert.deepStrictEqual(fakeServer.renamed, []);
});
