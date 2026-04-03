'use strict';

const {
  login,
  getStationRealKpi,
  getDevList,
  getDevRealKpi,
} = require('./openapi-client');

const DEFAULT_INTERVAL_MIN = 10;
const MIN_INTERVAL_MIN     = 10; // Huawei limits ~5 login calls per 5 min; keep margin

// ─── StationSession ──────────────────────────────────────────────────────────
//
// Manages all polling for a single station code. Multiple device instances
// (inverter, battery, meter) share one session → one API call set per interval.

class StationSession {

  constructor(homey, stationCode) {
    this._homey           = homey;
    this._stationCode     = stationCode;
    this._devices         = new Set();
    this._token           = null;
    this._devIdsByType    = null;
    this._backoffUntil    = 0;
    this._timer           = null;
    this._fetchInProgress = false;
  }

  addDevice(device) {
    this._devices.add(device);
    this._restartTimer();
  }

  removeDevice(device) {
    this._devices.delete(device);
    if (this._devices.size === 0) {
      this._stopTimer();
    } else {
      this._restartTimer();
    }
  }

  isEmpty() { return this._devices.size === 0; }

  invalidateToken()      { this._token = null; }
  invalidateDeviceList() { this._devIdsByType = null; }

  triggerPoll() {
    this._poll().catch((err) => this._homey.error('[Coordinator] Triggered poll error:', err.message));
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  _intervalMs() {
    let min = DEFAULT_INTERVAL_MIN;
    for (const d of this._devices) {
      const v = parseInt(d.getSetting('poll_interval'), 10);
      if (Number.isFinite(v) && v >= MIN_INTERVAL_MIN && v < min) min = v;
    }
    return min * 60 * 1000;
  }

  _getCredentials() {
    for (const d of this._devices) {
      const baseUrl    = (d.getSetting('base_url') || 'https://eu5.fusionsolar.huawei.com').trim().replace(/\/$/, '');
      const username   = d.getSetting('username');
      const systemCode = d.getSetting('system_code');
      if (username && systemCode) return { baseUrl, username, systemCode };
    }
    return null;
  }

  _restartTimer() {
    this._stopTimer();
    this._timer = this._homey.setInterval(
      () => this._poll().catch((err) => this._homey.error('[Coordinator] Poll error:', err.message)),
      this._intervalMs(),
    );
  }

  _stopTimer() {
    if (this._timer) {
      this._homey.clearInterval(this._timer);
      this._timer = null;
    }
  }

  async _ensureToken(creds) {
    if (this._token) return this._token;
    const remaining = this._backoffUntil - Date.now();
    if (remaining > 0) {
      throw new Error(`Rate limited — login paused for ${Math.ceil(remaining / 60000)} more minute(s)`);
    }
    this._token = await login(creds.baseUrl, creds.username, creds.systemCode);
    return this._token;
  }

  async _withAutoRelogin(creds, fn) {
    const token  = await this._ensureToken(creds);
    let   result = await fn(token);
    // Only re-login once per poll cycle — if we already refreshed the token
    // this poll, don't attempt another login even if the API still returns expired.
    if (result.expired && !this._tokenRefreshedThisPoll) {
      this._tokenRefreshedThisPoll = true;
      this._token = null;
      result      = await fn(await this._ensureToken(creds));
    }
    return result;
  }

  async _ensureDevIds(creds) {
    if (this._devIdsByType) return;
    const { devices } = await this._withAutoRelogin(creds,
      (t) => getDevList(creds.baseUrl, t, this._stationCode),
    );
    // devTypeId reference (from Huawei SmartPVMS Northbound API):
    //   1   – string inverter (SUN2000)
    //   2   – SmartLogger
    //   8   – STS
    //   10  – EMI
    //   13  – protocol converter
    //   16  – general device
    //   17  – grid meter (DTSU666)
    //   22  – PID
    //   37  – Pinnet data logger
    //   38  – residential inverter
    //   39  – battery (LUNA2000 residential)
    //   40  – backup box
    //   41  – ESS (C&I / utility battery)
    //   45  – PLC
    //   46  – optimizer
    //   47  – power sensor
    //   62  – Dongle
    //   63  – distributed SmartLogger
    //   70  – safety box
    //   60001 – mains
    //   60003 – genset
    //   60043 – SSU group
    //   60044 – SSU
    //   60092 – power converter
    //   60014 – lithium battery rack
    //   60010 – AC output power distribution
    //   23070 – SmartAssistant
    this._devIdsByType = {};
    for (const d of devices) {
      const typeId = Number(d.devTypeId);
      if (!this._devIdsByType[typeId]) this._devIdsByType[typeId] = [];
      if (d.id) this._devIdsByType[typeId].push(String(d.id));
    }
    this._homey.log(`[Coordinator] Device list for ${this._stationCode}:`,
      JSON.stringify(Object.fromEntries(
        Object.entries(this._devIdsByType).map(([k, v]) => [k, v.length]),
      )));
  }

  async _poll() {
    if (this._fetchInProgress || this._devices.size === 0) return;
    this._fetchInProgress        = true;
    this._tokenRefreshedThisPoll = false; // reset: allow at most one re-login per cycle

    const creds = this._getCredentials();
    if (!creds) { this._fetchInProgress = false; return; }

    try {
      // 1. Station-level KPI
      const stationResult = await this._withAutoRelogin(creds,
        (t) => getStationRealKpi(creds.baseUrl, t, this._stationCode),
      );
      const stationKpi = stationResult.kpi || null;

      // 2. Device list (cached after first call)
      await this._ensureDevIds(creds);

      // 3. Collect all dev types needed across registered devices
      const neededTypes = new Set();
      for (const device of this._devices) {
        for (const type of device.getDevTypes()) neededTypes.add(type);
      }

      // 4. Fetch device KPIs for each needed type
      const kpiByType = {};
      for (const typeId of neededTypes) {
        const ids = this._devIdsByType[typeId] || [];
        if (!ids.length) continue;
        const result = await this._withAutoRelogin(creds,
          (t) => getDevRealKpi(creds.baseUrl, t, ids, typeId),
        );
        kpiByType[typeId] = result.devices.map((d) => d.dataItemMap).filter(Boolean);
      }

      // 5. Distribute data to all registered devices
      for (const device of this._devices) {
        try {
          await device.onPollData({ stationKpi, kpiByType, devIdsByType: this._devIdsByType });
          if (!device.getAvailable()) await device.setAvailable();
        } catch (err) {
          this._homey.error(`[Coordinator] onPollData error (${device.getName()}):`, err.message);
        }
      }

    } catch (err) {
      this._homey.error(`[Coordinator] Station ${this._stationCode} poll error:`, err.message);

      if (err.message.includes('407') || err.message.includes('Rate limit')) {
        this._backoffUntil = Date.now() + 15 * 60 * 1000;
        this._token = null;
        this._homey.log('[Coordinator] Rate limit hit — login paused 15 minutes');
      } else if (err.message.includes('Login failed') || err.message.includes('noCredentials')) {
        this._token = null;
      }

      for (const device of this._devices) {
        await device.setUnavailable(err.message).catch(() => {});
      }
    } finally {
      this._fetchInProgress = false;
    }
  }

}

// ─── OpenAPICoordinator ──────────────────────────────────────────────────────

class OpenAPICoordinator {

  constructor(homey) {
    this._homey    = homey;
    this._sessions = new Map(); // stationCode → StationSession
  }

  register(device) {
    const code = device.getSetting('station_code');
    if (!code) return;

    if (!this._sessions.has(code)) {
      this._sessions.set(code, new StationSession(this._homey, code));
    }
    const session = this._sessions.get(code);
    session.addDevice(device);
    // Trigger an immediate first poll for the newly registered device
    session.triggerPoll();
  }

  unregister(device) {
    const code = device.getSetting('station_code');
    if (!code) return;
    const session = this._sessions.get(code);
    if (!session) return;
    session.removeDevice(device);
    if (session.isEmpty()) this._sessions.delete(code);
  }

  // Call when credentials or poll_interval change (but station_code is the same)
  settingsChanged(device) {
    const code = device.getSetting('station_code');
    const session = this._sessions.get(code);
    if (!session) return;
    session.invalidateToken();
    session.invalidateDeviceList();
    session.triggerPoll();
  }

  // Call when station_code itself changes
  reregister(device, oldStationCode) {
    if (oldStationCode) {
      const old = this._sessions.get(oldStationCode);
      if (old) {
        old.removeDevice(device);
        if (old.isEmpty()) this._sessions.delete(oldStationCode);
      }
    }
    this.register(device);
  }

}

module.exports = OpenAPICoordinator;
