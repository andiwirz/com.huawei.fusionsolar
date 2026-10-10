'use strict';

// OCPP 1.6 JSON Central System (WebSocket Server)
// One per port, shared by every OCPP SmartCharger device set to that port.
// The SCharger connects to: ws://[homey-ip]:[port]/[station-id]

const DEFAULT_OCPP_PORT = 8887;
const PING_INTERVAL_MS  = 30_000;

// Seed transaction ID counter with Unix timestamp so it survives restarts
let _txnCounter = Math.floor(Date.now() / 1000);
// port → server. Until 1.2.323 there was one server for the whole app, and the port was a
// setting of each device: two chargers set to two ports moved it back and forth, each device
// restarting it on its own port whenever it started or its settings were saved — the other
// charger was cut off every time (review 2026-10-10).
const _instances = new Map();

class OcppServer {

  constructor(homey) {
    this._homey              = homey;
    this._devices            = new Map(); // stationId → device instance
    this._clients            = new Map(); // stationId → WebSocket
    this._txnIds             = new Map(); // stationId → active transactionId (null when idle)
    this._creds              = new Map(); // stationId → {username, password} or null
    this._wss                = null;
    this._port               = 0;
    this._requestedPort      = 0;
    this.lastMessageAt       = null;
    this._lastMessageAt      = new Map(); // actual stationId → time of its last message
    this._lastResolvedIds    = new Map(); // deviceKey → actual stationId, kept after a disconnect
    // Catch-all routing: when a device is registered with station_id=""
    // the first charger that connects gets its actual path ID stored here,
    // so outgoing commands can find the right WebSocket client.
    this._resolvedStationIds = new Map(); // deviceKey → actualStationId
    this._pendingCalls       = new Map(); // uniqueId  → { resolve, reject, timer }
    this._waiting            = new Map(); // stationId → devices refused it, first in line first
    this._loggedUnclaimed    = new Set(); // stations already reported as served by no device
  }

  /** The server on `port`, started if there is none yet. */
  static getInstance(homey, port) {
    let p;
    if (port == null) {
      // A caller that does not say which: the one server, when there is one.
      if (_instances.size === 1) return _instances.values().next().value;
      p = DEFAULT_OCPP_PORT;
    } else {
      p = parseInt(port, 10) || DEFAULT_OCPP_PORT;
    }
    let server = _instances.get(p);
    if (!server) {
      server = new OcppServer(homey);
      _instances.set(p, server);
      server._start(p);
    }
    return server;
  }

  /** The server on `port` if it runs, without starting one — for leaving it. */
  static existing(port) {
    return _instances.get(parseInt(port, 10) || DEFAULT_OCPP_PORT) || null;
  }

  get devices() { return this._devices; }

  /** The device holding `stationId` here when that is not `device` — else null. */
  holderOf(stationId, device) {
    const holder = this._devices.get(stationId);
    return holder && holder !== device ? holder : null;
  }

  /**
   * One device per Station ID, and one for "any charger" (''). Until 1.2.323 a second device
   * with the same Station ID — or a second one left empty — silently replaced the first in the
   * one slot there is: the first heard nothing from then on, and deleting either removed the
   * slot from under the other (review 2026-10-10). The second is now refused and told why, and
   * takes the slot when the first leaves it.
   */
  registerDevice(stationId, device) {
    const holder = this.holderOf(stationId, device);
    if (holder) {
      const queue = this._waiting.get(stationId) || [];
      if (!queue.includes(device)) queue.push(device);
      this._waiting.set(stationId, queue);
      const name = typeof holder.getName === 'function' ? holder.getName() : '?';
      this._homey.log(`[OcppServer] Station ID ${stationId || '(any)'} is already taken by "${name}" — not registered`);
      if (typeof device.onRegistrationRefused === 'function') device.onRegistrationRefused(stationId, name, this._requestedPort);
      return false;
    }
    this._homey.log(`[OcppServer] Registered device: ${stationId}`);
    this._devices.set(stationId, device);
    this._removeWaiting(stationId, device);
    // A charger the "any" device had taken now has a device of its own.
    if (stationId !== '' && this._resolvedStationIds.get('') === stationId) this._resolvedStationIds.delete('');
    if (typeof device.onRegistered === 'function') device.onRegistered();
    if (this._port) device.onServerStarted(this._port);
    return true;
  }

  _removeWaiting(stationId, device) {
    const queue = this._waiting.get(stationId);
    if (!queue) return;
    const rest = queue.filter((d) => d !== device);
    if (rest.length) this._waiting.set(stationId, rest); else this._waiting.delete(stationId);
  }

  // The slot was left: the first device refused it takes it now.
  _promoteWaiting(stationId) {
    const queue = this._waiting.get(stationId);
    if (!queue || !queue.length) return false;
    const next = queue[0];
    this._removeWaiting(stationId, next);
    return this.registerDevice(stationId, next);
  }

  // A device whose Station ID was changed in its settings. Moved to the new key on the same
  // server: unregistering would stop the server when it is the only device. Until 1.2.315 the
  // change was not applied at all — the device stayed registered under the old ID while its
  // commands and its watchdog used the new one, so it went offline at once and every command
  // failed until the app restarted; deleting it later then left the old entry behind.
  renameDevice(oldId, newId, device) {
    if (oldId === newId) return true;
    this._homey.log(`[OcppServer] Station ID changed: ${oldId || '(any)'} → ${newId || '(any)'}`);
    const held = this._devices.get(oldId) === device;
    if (held) {
      this._devices.delete(oldId);
      this._creds.delete(oldId);
      this._resolvedStationIds.delete(oldId);
      this._lastResolvedIds.delete(oldId);
    }
    this._removeWaiting(oldId, device);
    const ok = this.registerDevice(newId, device);
    if (held) this._promoteWaiting(oldId);
    return ok;
  }

  // `device` names who is leaving: one that never held the slot only leaves the queue for it.
  unregisterDevice(stationId, device = null) {
    if (device && this._devices.get(stationId) !== device) {
      this._removeWaiting(stationId, device);
      this._stopIfIdle();
      return;
    }
    this._homey.log(`[OcppServer] Unregistered device: ${stationId}`);
    this._devices.delete(stationId);
    this._txnIds.delete(stationId);
    this._creds.delete(stationId);
    this._resolvedStationIds.delete(stationId);
    this._lastResolvedIds.delete(stationId);
    if (this._promoteWaiting(stationId)) return;
    this._stopIfIdle();
  }

  _stopIfIdle() {
    // Nobody waits without a holder: a holder leaving hands the slot on (_promoteWaiting).
    if (this._devices.size) return;
    this._stop();
    if (_instances.get(this._requestedPort) === this) _instances.delete(this._requestedPort);
  }

  // When a device last heard from its own charger, or null if never. A device knows its
  // configured station id, which is '' for the catch-all; the charger that took that slot is
  // looked up here, and still found after it disconnected, so its silence can be timed.
  lastMessageAtFor(stationId) {
    const actual = this._resolvedStationIds.get(stationId) || this._lastResolvedIds.get(stationId) || stationId;
    return this._lastMessageAt.get(actual) ?? null;
  }

  // Store optional Basic Auth credentials for a station.
  // If username is empty, authentication is skipped for that station.
  setCredentials(stationId, username, password) {
    if (username) {
      this._creds.set(stationId, { username, password: password || '' });
      this._homey.log(`[OcppServer] Credentials set for: ${stationId}`);
    } else {
      this._creds.delete(stationId);
    }
  }

  // ─── Server lifecycle ────────────────────────────────────────────────────

  _start(port) {
    this._requestedPort = port;
    try {
      const WebSocket = require('ws');
      this._wss = new WebSocket.Server({ port });
      this._homey.log(`[OcppServer] Starting WebSocket server on port ${port}`);

      this._wss.on('listening', () => {
        this._port = port;
        this._homey.log(`[OcppServer] Listening on port ${port}`);
        for (const device of this._devices.values()) device.onServerStarted(port);
      });

      this._wss.on('connection', (ws, req) => this._onConnection(ws, req));

      this._wss.on('error', (err) => {
        this._homey.error('[OcppServer] Server error:', err.message);
        for (const device of this._devices.values()) device.onServerError(err);
      });

    } catch (err) {
      this._homey.error('[OcppServer] Failed to require ws module:', err.message);
      for (const device of this._devices.values()) device.onServerError(err);
    }
  }

  _stop() {
    // ws 8: wss.close() stops accepting connections and leaves the open ones running. With the
    // last device removed the instance is dropped, but a connected charger stayed on this
    // dead server, answering its pings, and never reconnected — a device added again heard
    // nothing and went offline after three minutes, until the app restarted (review
    // 2026-10-10). Closing the sockets sends the charger looking for the server that replaces
    // this one.
    for (const ws of this._clients.values()) {
      try { ws.close(1001, 'Server stopping'); } catch (e) { /* already gone */ }
    }
    this._clients.clear();
    for (const { reject, timer } of this._pendingCalls.values()) {
      clearTimeout(timer); reject(new Error('Server stopping'));
    }
    this._pendingCalls.clear();
    if (this._wss) {
      this._wss.close();
      this._wss = null;
      this._port = 0;
      this._homey.log('[OcppServer] Server stopped');
    }
  }

  // ─── Connection handling ─────────────────────────────────────────────────

  _onConnection(ws, req) {
    // URL: /[station-id]  or  /ocpp/[station-id]
    const url       = req.url || '/';
    const stationId = url.split('/').filter(Boolean).pop() || 'unknown';
    this._homey.log(`[OcppServer] Client connected: ${stationId} (${req.socket.remoteAddress})`);

    // Resolve device: exact match first, then catch-all (station_id="").
    //
    // The catch-all keeps the charger it took for as long as that charger is connected. It used
    // to take every unknown station that connected: a second one moved it over, its commands
    // went to that charger, and the messages of both arrived at the one device (review
    // 2026-10-10). A station that finds it taken is answered, but no device hears of it.
    let deviceKey = this._devices.has(stationId) ? stationId : '';
    if (deviceKey === '') {
      const taken = this._resolvedStationIds.get('');
      if (taken && taken !== stationId && this._clients.has(taken)) deviceKey = null;
    }
    const device = deviceKey === null ? undefined : this._devices.get(deviceKey);
    if (deviceKey === null && this._devices.has('') && !this._loggedUnclaimed.has(stationId)) {
      this._loggedUnclaimed.add(stationId);
      this._homey.log(`[OcppServer] ${stationId}: no device has this Station ID, and the one without a Station ID `
        + `serves ${this._resolvedStationIds.get('')} — give this charger a device of its own`);
    }

    // Validate Basic Auth — check exact-match creds, then catch-all creds
    const creds = this._creds.get(stationId) || this._creds.get('');
    if (creds) {
      const authHeader = req.headers['authorization'] || '';
      const valid = this._checkBasicAuth(authHeader, creds.username, creds.password);
      if (!valid) {
        this._homey.log(`[OcppServer] Auth failed for ${stationId} — closing connection`);
        ws.close(1008, 'Unauthorized');
        return;
      }
    }

    // A charger that lost power or its WiFi does not close its socket; it opens a new one when it
    // is back, and the old one is only found dead much later — the ping below never checks for
    // an answer, so it ends when a ping finally fails, seconds to minutes after the reconnect.
    // That close used to remove the NEW socket from _clients and report the charger
    // disconnected: data kept arriving, and every command failed with "not connected" until
    // the charger happened to reconnect again (review 2026-10-10). The new socket wins, the
    // old one is closed now, and its close event below changes nothing (1.2.310).
    const previous = this._clients.get(stationId);
    this._clients.set(stationId, ws);
    if (previous && previous !== ws) {
      this._homey.log(`[OcppServer] ${stationId} reconnected — closing its previous connection`);
      try { previous.terminate(); } catch (e) { /* already gone */ }
    }

    // For catch-all devices: record which actual station ID connected so
    // outgoing commands can find the right WebSocket client.
    if (deviceKey === '') {
      if (this._lastResolvedIds.get('') && this._lastResolvedIds.get('') !== stationId) {
        this._homey.log(`[OcppServer] The device without a Station ID now serves ${stationId} (before: ${this._lastResolvedIds.get('')})`);
      }
      this._resolvedStationIds.set(deviceKey, stationId);
      this._lastResolvedIds.set(deviceKey, stationId);
      this._homey.log(`[OcppServer] Catch-all device matched: ${stationId}`);
    }

    if (device) device.onOcppConnected();

    // Configure on connect, not only after a BootNotification.
    //
    // A charger sends BootNotification when IT boots. When the Homey app restarts, the
    // charger has not booted — it just reconnects the WebSocket, and a field log from
    // 2026-09-03 shows exactly that: connect, StatusNotification, heartbeats, and no boot
    // message anywhere. So configuration hung off an event that may never arrive, and the
    // charger kept whatever sampling settings it already had.
    //
    // What that costs us specifically: this app follows solar surplus, and the 10-second
    // MeterValueSampleInterval below is what makes that control loop responsive. A charger
    // left on its own default reports far less often, and the app is slower to react
    // without anything appearing wrong. It is not the difference between data and no data —
    // Huawei chargers send MeterValues during a transaction whether asked or not, which is
    // why an app that never configures them at all still works.
    //
    // Both paths are kept: a real boot still reconfigures after its own delay, because a
    // charger that has just started may not accept settings immediately. ChangeConfiguration
    // is idempotent, so arriving twice costs nothing.
    setTimeout(() => this._configureCharger(stationId, ws), 2000);

    const pingTimer = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.ping();
    }, PING_INTERVAL_MS);

    ws.on('message', (data) => {
      try {
        this._onMessage(stationId, ws, JSON.parse(data.toString()));
      } catch (err) {
        this._homey.error(`[OcppServer] Parse error from ${stationId}:`, err.message);
      }
    });

    ws.on('close', () => {
      clearInterval(pingTimer);
      // Only the connection the station is on now may end its presence — see above. A socket
      // the server let go of itself (a port change, a stop) has no successor in _clients, and
      // its close is a real disconnect the device has to hear about.
      const current = this._clients.get(stationId);
      if (current && current !== ws) {
        this._homey.log(`[OcppServer] Previous connection of ${stationId} closed — it is on a newer one`);
        return;
      }
      this._clients.delete(stationId);
      // Before the catch-all lets go of this station: a station it never took is not its news.
      const dev = this._deviceFor(stationId);
      if (this._resolvedStationIds.get('') === stationId) this._resolvedStationIds.delete('');
      this._homey.log(`[OcppServer] Client disconnected: ${stationId}`);
      if (dev) dev.onOcppDisconnected();
    });

    ws.on('error', (err) => {
      this._homey.error(`[OcppServer] Client error (${stationId}):`, err.message);
    });
  }

  // ─── OCPP 1.6 message dispatch ───────────────────────────────────────────
  // Call:   [2, uniqueId, action, payload]
  // Result: [3, uniqueId, payload]
  // Error:  [4, uniqueId, errorCode, errorDescription, details]

  _onMessage(stationId, ws, msg) {
    if (!Array.isArray(msg)) return;
    this.lastMessageAt = Date.now();
    this._lastMessageAt.set(stationId, this.lastMessageAt);
    const [type, uniqueId, ...rest] = msg;

    if (type === 2) {
      const [action, payload] = rest;
      this._homey.log(`[OcppServer] ← ${stationId}: ${action}`);
      this._handleCall(stationId, ws, uniqueId, action, payload || {});
      return;
    }
    // type 3 = CallResult (response to an outgoing call we're tracking)
    if (type === 3) {
      const [payload] = rest;
      const pending = this._pendingCalls.get(uniqueId);
      if (pending) {
        this._pendingCalls.delete(uniqueId);
        clearTimeout(pending.timer);
        pending.resolve(payload);
      }
      return;
    }
    // type 4 = CallError
    if (type === 4) {
      const [errorCode, errorDesc] = rest;
      const pending = this._pendingCalls.get(uniqueId);
      if (pending) {
        this._pendingCalls.delete(uniqueId);
        clearTimeout(pending.timer);
        pending.reject(new Error(`${errorCode}: ${errorDesc || 'OCPP error'}`));
      }
    }
  }

  /** The device a station's messages belong to: its own, or the catch-all if it took this one. */
  _deviceFor(stationId) {
    const own = this._devices.get(stationId);
    if (own) return own;
    return this._resolvedStationIds.get('') === stationId ? this._devices.get('') : undefined;
  }

  _handleCall(stationId, ws, uniqueId, action, payload) {
    const device = this._deviceFor(stationId);
    const now    = new Date().toISOString();

    switch (action) {

      case 'BootNotification':
        this._send(ws, [3, uniqueId, {
          currentTime: now,
          interval:    60,
          status:      'Accepted',
        }]);
        if (device) device.onBootNotification(payload);
        // Configure charger 2 s after boot to let it settle
        setTimeout(() => this._configureCharger(stationId, ws), 2000);
        break;

      case 'Heartbeat':
        this._send(ws, [3, uniqueId, { currentTime: now }]);
        break;

      case 'StatusNotification': {
        this._send(ws, [3, uniqueId, {}]);
        // When charger becomes Available and we still hold a txnId → stale, clear it
        if ((payload.status === 'Available') && this._txnIds.get(stationId)) {
          this._txnIds.set(stationId, null);
        }
        if (device) device.onStatusNotification(payload);
        break;
      }

      case 'MeterValues':
        this._send(ws, [3, uniqueId, {}]);
        // Transaction recovery: if MeterValues carry a txnId we don't know about, adopt it
        if (payload.transactionId && !this._txnIds.get(stationId)) {
          this._txnIds.set(stationId, payload.transactionId);
        }
        if (device) device.onMeterValues(payload);
        break;

      case 'StartTransaction': {
        const txnId = ++_txnCounter;
        this._txnIds.set(stationId, txnId);
        this._send(ws, [3, uniqueId, {
          transactionId: txnId,
          idTagInfo:     { status: 'Accepted' },
        }]);
        if (device) device.onStartTransaction(payload, txnId);
        break;
      }

      case 'StopTransaction':
        this._txnIds.set(stationId, null);
        this._send(ws, [3, uniqueId, {
          idTagInfo: { status: 'Accepted' },
        }]);
        if (device) device.onStopTransaction(payload);
        break;

      case 'Authorize':
        this._send(ws, [3, uniqueId, { idTagInfo: { status: 'Accepted' } }]);
        break;

      case 'DataTransfer':
        this._send(ws, [3, uniqueId, { status: 'Accepted' }]);
        break;

      default:
        this._homey.log(`[OcppServer] Unknown action: ${action}`);
        this._send(ws, [4, uniqueId, 'NotImplemented', `Action ${action} not implemented`, {}]);
    }
  }

  // ─── Charger setup after BootNotification ────────────────────────────────

  // Each key is asked for, and the answer is read. It used to be sent and forgotten: the
  // charger's reply carries Accepted, Rejected or NotSupported per key, and dropping it
  // meant the app could not tell a setting that took effect from one the charger refused.
  // That matters for MeterValuesSampledData in particular — OCPP 1.6 requires a charger to
  // reject the WHOLE list if it does not know one measurand in it, so a single unsupported
  // entry silently costs every reading in the list.
  async _configureKey(stationId, ws, key, value) {
    if (!ws || ws.readyState !== ws.OPEN) return null;
    try {
      const res = await this._sendCallAsync(ws, 'ChangeConfiguration', { key, value });
      const status = (res && res.status) || 'no status';
      this._homey.log(`[OcppServer] ChangeConfiguration ${key} → ${status}`);
      return status;
    } catch (err) {
      // A charger that never answers is not a reason to abandon the remaining keys.
      this._homey.log(`[OcppServer] ChangeConfiguration ${key} failed: ${err.message}`);
      return null;
    }
  }

  async _configureCharger(stationId, ws) {
    if (!ws || ws.readyState !== ws.OPEN) return;
    this._homey.log(`[OcppServer] Configuring charger ${stationId}`);

    const pause = (ms) => new Promise((r) => setTimeout(r, ms)); // eslint-disable-line no-promise-executor-return

    // What to sample. Temperature is deliberately absent: the driver reads it if a charger
    // volunteers it, but asking for it would risk the whole list on firmware that does not
    // support that measurand, and no measurement says whether Huawei's does.
    await this._configureKey(stationId, ws, 'MeterValuesSampledData',
      'Power.Active.Import,Energy.Active.Import.Register,SoC,Current.Import,Voltage');
    await pause(500);
    // How often. This is what the surplus control loop follows.
    await this._configureKey(stationId, ws, 'MeterValueSampleInterval', '10');
    await pause(500);
    // Ping us every 30 s so the charger matches our server-side ping timer.
    await this._configureKey(stationId, ws, 'WebSocketPingInterval', '30');
  }

  // Resolve the actual WebSocket client key for a given station ID.
  // When station_id="" (catch-all device), the real connected ID is in _resolvedStationIds.
  _resolveStationId(stationId) {
    if (stationId === '') return this._resolvedStationIds.get('') || '';
    return stationId;
  }

  // ─── Outgoing commands ───────────────────────────────────────────────────

  // ─── Outgoing commands ───────────────────────────────────────────────────
  //
  // Every command waits for the charger's answer. There used to be a second, untracked
  // set of these — same names without the Async suffix — that wrote to the socket and
  // returned, so the caller logged success on the strength of having sent something. A
  // field log from 2026-09-03 shows what that reads like:
  //
  //   [OcppServer] → SetChargingProfile
  //   [OCPP] Init profile applied: 16A
  //
  // The second line was an assumption. A Rejected from the charger would have produced
  // exactly the same two lines. Both sets existed side by side and call sites picked
  // whichever, so the first profile after connecting — the one that decides whether the
  // car may charge at all — was the unchecked one.
  //
  // Notes that belong to the profile calls below, kept from those removed versions:
  //
  //   TxDefaultProfile on connector 1 is correct for single-connector chargers like the
  //   Huawei SCharger; evcc confirmed the purpose/connector combination.
  //
  //   Profiles go out in Watts (Absolute), and amperes=0 maps to 1 W rather than 0 W:
  //   0 W TxDefaultProfile is unreliable on Huawei firmware, while 1 W blocks just as
  //   effectively — it is far below the 6 A the pilot signal can express anyway.

  // Async RemoteStartTransaction — resolves with charger response ({ status: 'Accepted'|'Rejected' }).
  async remoteStartAsync(stationId, connectorId = 1, idTag = 'homey') {
    const actual = this._resolveStationId(stationId);
    const ws     = this._clients.get(actual);
    if (!ws || ws.readyState !== ws.OPEN) throw new Error(`Charger ${stationId} not connected`);
    return this._sendCallAsync(ws, 'RemoteStartTransaction', { connectorId, idTag });
  }

  // Async ChangeAvailability — resolves with charger response ({ status: 'Accepted'|'Rejected'|'Scheduled' }).
  async changeAvailabilityAsync(stationId, connectorId = 0, type = 'Operative') {
    const actual = this._resolveStationId(stationId);
    const ws     = this._clients.get(actual);
    if (!ws || ws.readyState !== ws.OPEN) throw new Error(`Charger ${stationId} not connected`);
    return this._sendCallAsync(ws, 'ChangeAvailability', { connectorId, type });
  }

  // Async SetChargingProfile (TxDefaultProfile) — resolves with charger response.
  async setMaxCurrentAsync(stationId, amperes, numberPhases = 3) {
    const ws    = this._clients.get(this._resolveStationId(stationId));
    if (!ws || ws.readyState !== ws.OPEN) throw new Error(`Charger ${stationId} not connected`);
    const limitW = amperes === 0 ? 1 : Math.round(amperes * numberPhases * 230);
    const start  = new Date(); start.setSeconds(0, 0);
    return this._sendCallAsync(ws, 'SetChargingProfile', {
      connectorId: 1,
      csChargingProfiles: {
        chargingProfileId:      1,
        stackLevel:             0,
        chargingProfilePurpose: 'TxDefaultProfile',
        chargingProfileKind:    'Absolute',
        chargingSchedule: {
          startSchedule:          start.toISOString(),
          // No duration: OCPP 1.6 lets the last period run until the profile is replaced.
          // It used to be 86400 — after 24 hours the limit lapsed, and a car blocked at 1 W
          // over a rainy weekend could then draw the charger's full current (review
          // 2026-10-10). Every limit this app sets is meant to hold until it sets another.
          chargingRateUnit:       'W',
          chargingSchedulePeriod: [{ startPeriod: 0, limit: limitW, numberPhases }],
        },
      },
    });
  }

  /**
   * Whether a charger is currently on the other end of a socket.
   *
   * The six send methods each raise "Charger X not connected" when it is not, which is the
   * right thing for a command somebody asked for — but wrong for a command the app issues
   * on its own schedule. A caller that only wants to know whether sending is worth trying
   * should ask instead of throwing and catching. Resolves the catch-all station id exactly
   * as the send methods do, so it cannot answer about a different socket than they use.
   */
  isConnected(stationId) {
    const ws = this._clients.get(this._resolveStationId(stationId));
    return !!ws && ws.readyState === ws.OPEN;
  }

  // Async SetChargingProfile (TxProfile) — resolves with charger response.
  async setTxProfileAsync(stationId, txnId, amperes, numberPhases = 3) {
    const ws    = this._clients.get(this._resolveStationId(stationId));
    if (!ws || ws.readyState !== ws.OPEN) throw new Error(`Charger ${stationId} not connected`);
    const limitW = amperes === 0 ? 1 : Math.round(amperes * numberPhases * 230);
    const start  = new Date(); start.setSeconds(0, 0);
    return this._sendCallAsync(ws, 'SetChargingProfile', {
      connectorId: 1,
      csChargingProfiles: {
        chargingProfileId:      2,
        transactionId:          txnId,
        stackLevel:             1,
        chargingProfilePurpose: 'TxProfile',
        chargingProfileKind:    'Absolute',
        chargingSchedule: {
          startSchedule:          start.toISOString(),
          // No duration: OCPP 1.6 lets the last period run until the profile is replaced.
          // It used to be 86400 — after 24 hours the limit lapsed, and a car blocked at 1 W
          // over a rainy weekend could then draw the charger's full current (review
          // 2026-10-10). Every limit this app sets is meant to hold until it sets another.
          chargingRateUnit:       'W',
          chargingSchedulePeriod: [{ startPeriod: 0, limit: limitW, numberPhases }],
        },
      },
    });
  }

  // Like _sendCall but returns a Promise that resolves with the charger's response payload,
  // or rejects after timeout. Required for pauseCharging/rebootCharger response handling.
  _sendCallAsync(ws, action, payload, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const uniqueId = `homey-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const timer = setTimeout(() => {
        this._pendingCalls.delete(uniqueId);
        reject(new Error(`OCPP call ${action} timed out after ${timeout}ms`));
      }, timeout);
      this._pendingCalls.set(uniqueId, { resolve, reject, timer });
      this._send(ws, [2, uniqueId, action, payload]);
      this._homey.log(`[OcppServer] → ${action} (id=${uniqueId})`);
    });
  }

  // Async RemoteStopTransaction — resolves with charger response ({ status: 'Accepted'|'Rejected' }).
  //
  // `knownTxnId` is the transaction the device holds. The server's own map lives in memory
  // and starts empty after an app restart or update — which a charger sees as a dropped
  // connection — and fills again only from a MeterValues message that names the transaction.
  // Until then a stop failed with "No active transaction" although the device was tracking
  // one, restored from its store (1.2.310).
  async remoteStopAsync(stationId, knownTxnId = null) {
    const actual = this._resolveStationId(stationId);
    const ws     = this._clients.get(actual);
    const txnId  = this._txnIds.get(actual) || knownTxnId;
    if (!ws || ws.readyState !== ws.OPEN) throw new Error(`Charger ${stationId} not connected`);
    if (!txnId) throw new Error(`No active transaction for ${stationId}`);
    return this._sendCallAsync(ws, 'RemoteStopTransaction', { transactionId: txnId });
  }

  // Async Reset — resolves with charger response ({ status: 'Accepted'|'Rejected' }).
  async resetAsync(stationId, type = 'Soft') {
    const actual = this._resolveStationId(stationId);
    const ws     = this._clients.get(actual);
    if (!ws || ws.readyState !== ws.OPEN) throw new Error(`Charger ${stationId} not connected`);
    return this._sendCallAsync(ws, 'Reset', { type });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  _checkBasicAuth(header, expectedUser, expectedPass) {
    if (!header.startsWith('Basic ')) return false;
    try {
      const decoded  = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const colon    = decoded.indexOf(':');
      const user     = decoded.slice(0, colon);
      const pass     = decoded.slice(colon + 1);
      return user === expectedUser && pass === expectedPass;
    } catch {
      return false;
    }
  }

  _send(ws, payload) {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(payload));
  }

}

module.exports = OcppServer;
