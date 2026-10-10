'use strict';

// Five findings from the review of 2026-10-10 (1.2.323): three OCPP edge cases, two Modbus ones.
//
//   OCPP
//   1. The device without a Station ID took every unknown charger that connected: a second one
//      moved it over, its commands went there, and the messages of both arrived at the one
//      device.
//   2. One server for the whole app, its port a setting of each device: two chargers on two
//      ports moved it back and forth, and each save cut the other charger off.
//   3. One slot per Station ID: a second device with the same ID — or a second one left empty —
//      silently replaced the first, and deleting either removed the slot from under the other.
//
//   Modbus
//   4. A new poll interval was read with getSetting() inside onSettings, where it is still the
//      old one: it took effect only when the timer was next started for some other reason. The
//      poll right after the save went to the old address for the same reason.
//   5. A poll that had read the registers before a save stored them afterwards: the old value
//      went back into the field until the next poll, logged as the device changing it.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

// No real sockets: a server "starts" by recording its port.
const OcppServer = require('../lib/ocpp-server.js');
const STARTED = [];
OcppServer.prototype._start = function (port) {
  this._requestedPort = port; this._port = port; this.started = (this.started || 0) + 1; STARTED.push(port);
};

const homeyLog = () => {
  const logs = [];
  return { logs, log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
};

class FakeSocket extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; this.sent = []; }
  send(d) { this.sent.push(JSON.parse(d)); }
  ping() {}
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
}
const req = (id) => ({ url: `/ocpp/${id}`, socket: { remoteAddress: '192.0.2.50' }, headers: {} });

function charger(name) {
  return {
    name, connects: 0, disconnects: 0, boots: 0, refused: [], registered: 0,
    getName() { return name; },
    onOcppConnected() { this.connects++; }, onOcppDisconnected() { this.disconnects++; },
    onBootNotification() { this.boots++; }, onServerStarted() {},
    onRegistrationRefused(id, holder, port) { this.refused.push([id, holder, port]); },
    onRegistered() { this.registered++; },
  };
}
function server() {
  const h = homeyLog();
  const s = new OcppServer(h);
  s.logs = h.logs;
  s._configureCharger = () => {};
  return s;
}
const boot = (ws) => ws.emit('message', Buffer.from(JSON.stringify([2, 'm' + Math.random(), 'BootNotification', {}])));

// ── 1. the device without a Station ID keeps its charger ───────────────────────

test('a second unknown charger does not take the device without a Station ID away from the first', () => {
  const s = server();
  const any = charger('Garage');
  s.registerDevice('', any);
  const a = new FakeSocket();
  const b = new FakeSocket();
  s._onConnection(a, req('A'));
  s._onConnection(b, req('B'));

  assert.strictEqual(s._resolveStationId(''), 'A', 'the commands now go to the second charger');
  assert.strictEqual(any.connects, 1);
  boot(b);
  assert.strictEqual(any.boots, 0, "B's messages reached the device");
  boot(a);
  assert.strictEqual(any.boots, 1);
  assert.ok(s.logs.some((l) => /B: no device has this Station ID, and the one without a Station ID serves A/.test(l)));

  b.close();
  assert.strictEqual(any.disconnects, 0, "B leaving was reported as the device's charger leaving");
  assert.strictEqual(s._resolveStationId(''), 'A');
  a.close();
});

test('once its charger has gone, the next one may take the slot — and the log says it changed', () => {
  const s = server();
  const any = charger('Garage');
  s.registerDevice('', any);
  const a = new FakeSocket();
  s._onConnection(a, req('A'));
  a.close();
  assert.strictEqual(any.disconnects, 1);
  const b = new FakeSocket();
  s._onConnection(b, req('B'));
  assert.strictEqual(s._resolveStationId(''), 'B');
  assert.ok(s.logs.some((l) => /now serves B \(before: A\)/.test(l)));
  b.close();
});

test('a charger the slot still names but that is no longer connected does not keep it', () => {
  const s = server();
  const any = charger('Garage');
  s.registerDevice('', any);
  s._resolvedStationIds.set('', 'A');                    // left behind, its socket long gone
  const b = new FakeSocket();
  s._onConnection(b, req('B'));
  assert.strictEqual(s._resolveStationId(''), 'B');
  assert.strictEqual(any.connects, 1);
  b.close();
});

test('a charger that gets a device of its own is no longer served by the one without', () => {
  const s = server();
  s.registerDevice('', charger('Any'));
  const a = new FakeSocket();
  s._onConnection(a, req('A'));
  s.registerDevice('A', charger('Own'));
  assert.strictEqual(s._resolvedStationIds.get(''), undefined);
  a.close();
});

// ── 3. one device per Station ID ───────────────────────────────────────────────

test('a second device with the same Station ID is refused and told by whom, not swapped in', () => {
  const s = server();
  const first = charger('Carport');
  const second = charger('Carport copy');
  assert.strictEqual(s.registerDevice('CP1', first), true);
  assert.strictEqual(s.registerDevice('CP1', second), false);
  assert.strictEqual(s._devices.get('CP1'), first);
  assert.deepStrictEqual(second.refused, [['CP1', 'Carport', s._requestedPort]]);
});

test('two devices without a Station ID: the second waits, and takes over when the first is deleted', () => {
  const s = server();
  const first = charger('One');
  const second = charger('Two');
  s.registerDevice('', first);
  s.registerDevice('', second);
  assert.strictEqual(s._devices.get(''), first);

  s.unregisterDevice('', second);                         // deleting the refused one …
  assert.strictEqual(s._devices.get(''), first, '… took the slot from under the other');
  s.registerDevice('', second);

  s.unregisterDevice('', first);
  assert.strictEqual(s._devices.get(''), second);
  assert.strictEqual(second.registered, 1, 'the waiting device was not told it is registered now');
});

test('a device that changes to a free Station ID leaves its old one to the device waiting for it', () => {
  const s = server();
  const first = charger('One');
  const second = charger('Two');
  s.registerDevice('CP1', first);
  s.registerDevice('CP1', second);
  assert.strictEqual(s.renameDevice('CP1', 'CP9', first), true);
  assert.strictEqual(s._devices.get('CP9'), first);
  assert.strictEqual(s._devices.get('CP1'), second);
});

test('renaming onto a Station ID another device holds is refused', () => {
  const s = server();
  const a = charger('A');
  const b = charger('B');
  s.registerDevice('CP1', a);
  s.registerDevice('CP2', b);
  assert.strictEqual(s.renameDevice('CP2', 'CP1', b), false);
  assert.strictEqual(s._devices.get('CP1'), a);
  assert.deepStrictEqual(s.holderOf('CP1', b), a);
  assert.strictEqual(s.holderOf('CP1', a), null);
});

// ── 2. one server per port ─────────────────────────────────────────────────────

test('two ports are two servers — asking for one never restarts the other', () => {
  const h = homeyLog();
  const s1 = OcppServer.getInstance(h, 18887);
  const s2 = OcppServer.getInstance(h, 19000);
  assert.notStrictEqual(s1, s2);
  assert.strictEqual(OcppServer.getInstance(h, '18887'), s1);
  assert.strictEqual(s1.started, 1, 'the first server was started again');
  assert.strictEqual(OcppServer.existing(19001), null, 'existing() started a server');

  const a = charger('A'); const b = charger('B');
  s1.registerDevice('CP1', a);
  s2.registerDevice('CP2', b);
  const ws = new FakeSocket();
  s1._onConnection(ws, req('CP1'));
  s2.unregisterDevice('CP2', b);                        // the second charger's device goes
  assert.strictEqual(OcppServer.existing(19000), null, 'an empty server keeps its port');
  assert.strictEqual(s1.isConnected('CP1'), true, 'the other charger was cut off');
  ws.close();
  s1.unregisterDevice('CP1', a);
  assert.strictEqual(OcppServer.existing(18887), null);
});

// ── the device, moving between ports and Station IDs ───────────────────────────

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  return origLoad.call(this, request, parent, isMain);
};
const OcppDevice = require('../drivers/smartcharger_ocpp/device.js');
Module._load = origLoad;

function device(name, settings = {}) {
  const d = Object.create(OcppDevice.prototype);
  d.logs = [];
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = d.log;
  d.available = true;
  d.reasons = [];
  d.getName = () => name;
  d.settings = { station_id: 'CP1', ocpp_port: 28887, number_of_phases: '3', charger_model: '22kt', ...settings };
  d.getSetting = (k) => d.settings[k];
  d.setUnavailable = async (r) => { d.available = false; d.reasons.push(r); };
  d.setAvailable = async () => { d.available = true; };
  d.homey = { setTimeout: () => null, clearTimeout() {}, __: (k, v) => `${k} ${JSON.stringify(v || {})}`, ...homeyLog() };
  d._getPhases = () => 3;
  d._startIdleGuard = () => {};
  d._ocppPort = parseInt(d.settings.ocpp_port, 10);
  return d;
}
const save = (d, changes) => {
  const oldSettings = { ...d.settings };
  const newSettings = { ...d.settings, ...changes };
  return d.onSettings({ oldSettings, newSettings, changedKeys: Object.keys(changes) })
    .then(() => { d.settings = newSettings; });
};

test('a device saved with a new port moves to that port — the charger on the old one stays connected', async () => {
  const garage  = device('Garage',  { station_id: 'G', ocpp_port: 28887 });
  const carport = device('Carport', { station_id: 'C', ocpp_port: 28887 });
  const s = garage._ocppServer();
  s.registerDevice('G', garage);
  s.registerDevice('C', carport);
  const ws = new FakeSocket();
  s._onConnection(ws, req('G'));

  await save(carport, { ocpp_port: 29000 });

  assert.strictEqual(s.isConnected('G'), true, 'the garage charger was cut off by the carport save');
  assert.strictEqual(s._devices.has('C'), false);
  const moved = OcppServer.existing(29000);
  assert.ok(moved && moved._devices.get('C') === carport);
  assert.strictEqual(carport._ocppServer(), moved);

  // saving an unrelated setting on either device restarts nothing
  const started = s.started;
  await save(garage, { default_charging_amps: 10 });
  assert.strictEqual(s.started, started);
  assert.strictEqual(s.isConnected('G'), true);

  ws.close();
  s.unregisterDevice('G', garage);
  moved.unregisterDevice('C', carport);
});

test('a save onto a Station ID another device holds is refused with its name, and moves nothing', async () => {
  const a = device('Garage',  { station_id: 'A', ocpp_port: 28888 });
  const b = device('Carport', { station_id: 'B', ocpp_port: 28888 });
  const s = a._ocppServer();
  s.registerDevice('A', a);
  s.registerDevice('B', b);
  await assert.rejects(save(b, { station_id: 'A' }), /errors\.ocppStationIdTaken .*"name":"Garage"/);
  assert.strictEqual(s._devices.get('B'), b);
  assert.strictEqual(s._devices.get('A'), a);
  await assert.rejects(save(b, { station_id: 'A', ocpp_port: 28888 }), /ocppStationIdTaken/);
  s.unregisterDevice('A', a);
  s.unregisterDevice('B', b);
});

test('a device refused at start says why, the watchdog leaves that alone, and it recovers when the slot frees', async () => {
  const a = device('Garage',  { station_id: '', ocpp_port: 28889 });
  const b = device('Carport', { station_id: '', ocpp_port: 28889 });
  const s = a._ocppServer();
  s.registerDevice('', a);
  s.registerDevice('', b);
  assert.strictEqual(b.available, false);
  assert.match(b.reasons.at(-1), /errors\.ocppAnyStationTaken .*"name":"Garage"/);
  // Past the start-up grace, with nothing heard: the watchdog's "offline" branch.
  b._bootGraceStart = Date.now() - 60 * 60_000;
  b._chargingState = () => 'idle';
  b._updateSessionStatus = async () => {};
  b._postNotification = async () => {};
  b.setStoreValue = async () => {};
  b.homey.flow = { getDeviceTriggerCard: () => ({ trigger: async () => {} }) };
  await b._checkChargerOnline();
  assert.match(b.reasons.at(-1), /ocppAnyStationTaken/, 'the watchdog replaced the reason with "offline"');
  a._leaveOcppServer();                                   // the first device is deleted
  assert.strictEqual(b.available, true);
  assert.strictEqual(s._devices.get(''), b);
  b._leaveOcppServer();
  assert.strictEqual(OcppServer.existing(28889), null);
});

test('leaving starts no server — onDeleted and onUninit may both run for one device', () => {
  const d = device('Gone', { ocpp_port: 28890 });
  d._leaveOcppServer();
  d._leaveOcppServer();
  assert.strictEqual(OcppServer.existing(28890), null);
  assert.ok(!STARTED.includes(28890), 'a server was started on the port, only to be stopped again');
});

test('every command of the device goes through the server of its own port', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'drivers', 'smartcharger_ocpp', 'device.js'), 'utf8');
  assert.doesNotMatch(src, /OcppServer\.getInstance\(this\.homey\)/,
    'a call without a port reaches whichever server there is');
});

// ── 4. Modbus: the interval and the poll right after a save ────────────────────

const polling = require('../lib/modbus-polling');

function polled(settings) {
  const timers = [];
  const d = Object.assign(Object.create(polling), {
    pollDefaultS: 60, pollMinS: 10,
    settings: { poll_interval: 60, address: '192.0.2.1', ...settings },
    fetches: [],
    log() {}, error() {},
    homey: {
      setInterval: (fn, ms) => { const t = { kind: 'interval', fn, ms, live: true }; timers.push(t); return t; },
      clearInterval: (t) => { if (t) t.live = false; },
      setTimeout: (fn, ms) => { const t = { kind: 'timeout', fn, ms, live: true }; timers.push(t); return t; },
      clearTimeout: (t) => { if (t) t.live = false; },
    },
  });
  d.getSetting = (k) => d.settings[k];
  d._fetchAndUpdate = async () => { d.fetches.push(d.getSetting('address')); };
  d.timers = timers;
  return d;
}

test('a new poll interval runs from the save, not from the next restart of the timer', async () => {
  const d = polled({ poll_interval: 60 });
  await d._restartPolling({ poll_interval: 20, address: '192.0.2.9' });   // getSetting still says 60
  // The first interval is the poll; the second is the stuck-poll watchdog, on its own clock.
  const [poll] = d.timers.filter((t) => t.kind === 'interval' && t.live);
  assert.strictEqual(poll.ms, 20_000);
});

test('the poll right after a save waits until the new address is stored, and goes there', async () => {
  const d = polled({ address: '192.0.2.1' });
  await d._restartPolling({ address: '192.0.2.9', poll_interval: 60 });
  assert.deepStrictEqual(d.fetches, [], 'it ran at once, against the old address');
  const later = d.timers.find((t) => t.kind === 'timeout');
  assert.ok(later.ms >= 1000);
  d.settings.address = '192.0.2.9';                      // Homey stores the page
  later.fn();
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(d.fetches, ['192.0.2.9']);
});

test('stopping the device also drops a poll still waiting for its settings', async () => {
  const d = polled({});
  await d._restartPolling({ poll_interval: 30 });
  await d._stopPolling();
  assert.strictEqual(d.timers.find((t) => t.kind === 'timeout').live, false);
});

test('without settings handed over, the interval is the stored one, as before', () => {
  assert.strictEqual(polled({ poll_interval: 45 })._intervalMs(), 45_000);
  assert.strictEqual(polled({ poll_interval: 5 })._intervalMs(), 60_000, 'below the minimum: the default');
});

const MODBUS_DRIVERS = ['dtsu666_modbus', 'luna2000_emma_modbus', 'luna2000_modbus', 'powermeter_emma_modbus',
  'sdongle_a_modbus', 'smartcharger_emma_modbus', 'sun2000_emma_modbus', 'sun2000_modbus'];

function onSettingsSource(src) {
  const at = src.indexOf('  async onSettings(');
  assert.ok(at > 0, 'no onSettings');
  return src.slice(at, src.indexOf('\n  }\n', at));
}

test('every Modbus driver restarts its polling from the settings being saved', () => {
  for (const drv of MODBUS_DRIVERS) {
    const fn = onSettingsSource(fs.readFileSync(path.join(__dirname, '..', 'drivers', drv, 'device.js'), 'utf8').replace(/\r\n/g, '\n'));
    assert.match(fn, /await this\._restartPolling\(newSettings\);/, drv);
    assert.doesNotMatch(fn, /this\._startPolling\(\)/, `${drv} still starts the timer from the stored settings`);
  }
});

test('a value saved together with a new address is written to the new address', () => {
  for (const drv of ['luna2000_modbus', 'sun2000_modbus', 'luna2000_emma_modbus']) {
    const fn = onSettingsSource(fs.readFileSync(path.join(__dirname, '..', 'drivers', drv, 'device.js'), 'utf8').replace(/\r\n/g, '\n'));
    assert.match(fn, /const address  = newSettings\.address \?\? this\.getSetting\('address'\);/, drv);
    assert.doesNotMatch(fn, /const address  = this\.getSetting\('address'\);/, drv);
  }
});

// ── 5. Modbus: a poll that read before the save stores nothing ─────────────────

const { withSettingsLog, applySettingSync, readBeforeSave } = require('../lib/change-log');
const { syncModeSettings } = require('../lib/mode-settings');

function syncing(settings) {
  const d = {
    settings: { ...settings }, logs: [], sets: [],
    log(...a) { d.logs.push(a.join(' ')); },
    getSetting: (k) => d.settings[k],
    setSettings: async (u) => { d.sets.push(u); Object.assign(d.settings, u); },
  };
  return d;
}

test('the settings page stamps when a save runs and when it ended', async () => {
  class Dev { async onSettings() { assert.strictEqual(this._settingsSaving, true); } }
  withSettingsLog(Dev);
  const d = new Dev();
  d.log = () => {};
  const before = Date.now();
  await d.onSettings({ changedKeys: [] });
  assert.strictEqual(d._settingsSaving, false);
  assert.ok(d._settingsSavedAt >= before);

  class Refused { async onSettings() { throw new Error('no'); } }
  withSettingsLog(Refused);
  const r = new Refused();
  r.log = () => {};
  await assert.rejects(r.onSettings({ changedKeys: [] }));
  assert.strictEqual(r._settingsSaving, false, 'a refused save left the flag up for good');
});

test('a poll that began before the save puts no old value back into the field', async () => {
  const d = syncing({ max_grid_charge_power: 2500 });       // the user's new value
  d._lastPollStart = 1000;                                  // the poll read the register …
  d._settingsSavedAt = 1500;                                // … before the save ended
  await applySettingSync(d, { max_grid_charge_power: 5000 });
  assert.deepStrictEqual(d.sets, []);
  assert.strictEqual(d.settings.max_grid_charge_power, 2500);
  assert.ok(d.logs.some((l) => /Setting sync skipped \[max_grid_charge_power\]: read before the last save/.test(l)));
});

test('the next poll, begun after the save, stores what the device reports again', async () => {
  const d = syncing({ max_grid_charge_power: 2500 });
  d._settingsSavedAt = 1500;
  d._lastPollStart = 2000;
  await applySettingSync(d, { max_grid_charge_power: 3000 });   // changed on the device since
  assert.deepStrictEqual(d.sets, [{ max_grid_charge_power: 3000 }]);
});

test('nothing is stored while a save is still running', async () => {
  const d = syncing({});
  d._settingsSaving = true;
  d._lastPollStart = 5000;
  assert.strictEqual(readBeforeSave(d), true);
  await applySettingSync(d, { a: 1 });
  assert.deepStrictEqual(d.sets, []);
});

test('the mode dropdowns are guarded the same way', async () => {
  const MODES = { mode_x: { ids: ['1', '2'], labels: {} } };
  const d = syncing({ mode_x: '2' });
  d.homey = { __: (k) => k };
  d._lastPollStart = 1000;
  d._settingsSavedAt = 1500;
  await syncModeSettings(d, MODES, { mode_x: 1 });
  assert.deepStrictEqual(d.sets, [], 'the old mode went back into the dropdown');
  d._lastPollStart = 2000;
  await syncModeSettings(d, MODES, { mode_x: 1 });
  assert.deepStrictEqual(d.sets, [{ mode_x: '1' }]);
});

test('a device that does not stamp its polls stores as before', async () => {
  const d = syncing({ a: 0 });
  d._settingsSavedAt = Date.now();
  await applySettingSync(d, { a: 1 });
  assert.deepStrictEqual(d.sets, [{ a: 1 }]);
});
