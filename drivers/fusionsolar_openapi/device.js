'use strict';

const { Device } = require('homey');
const {
  login,
  getStationRealKpi,
  getDevList,
  getDevRealKpi,
} = require('../../lib/openapi-client');

const DEFAULT_INTERVAL_MIN = 10;
const MIN_INTERVAL_MIN     = 5;

const DEV_TYPE_INVERTER      = 1;   // String inverter (SUN2000)
const DEV_TYPE_METER         = 17;  // Grid meter (DTSU666)
const DEV_TYPE_BATTERY       = 39;  // Residential battery (LUNA2000)
const DEV_TYPE_BATTERY_ESS   = 41;  // C&I and utility ESS
const DEV_TYPE_POWER_SENSOR  = 47;  // Power sensor

// Station-level capabilities — always present
const REQUIRED_CAPABILITIES = [
  'meter_power',         // total lifetime yield (kWh)
  'meter_power.daily',   // today's yield (kWh)
  'meter_power_monthly', // this month's yield (kWh)
];

// Capabilities removed in previous versions — cleaned up on init
const DEPRECATED_CAPABILITIES = [
  'measure_power',                  // replaced by measure_power.mppt (Solarleistung)
  'measure_power.batt_plant',       // moved to dedicated battery device
  'meter_power.today_batt_input',   // moved to dedicated battery device
  'measure_power.chargesetting',    // moved to dedicated battery device
  'measure_voltage.busbar',         // moved to dedicated battery device
  'meter_power.batt_rated',         // moved to dedicated battery device
  'openapi_battery_run_state',      // moved to dedicated battery device
];

// Inverter-level capabilities — always present (show — until data arrives)
const INVERTER_CAPABILITIES = [
  'measure_temperature.invertor', // internal temperature (°C)
  'measure_power.active_power',   // AC active power sum (W)
];

// Additional inverter capabilities — added dynamically when data is available
const INVERTER_EXTRA_CAPABILITIES = [
  'huawei_status',                // inverter state string
  'measure_voltage.ab_u',         // line voltage AB (V)
  'measure_voltage.bc_u',         // line voltage BC (V)
  'measure_voltage.ca_u',         // line voltage CA (V)
  'measure_voltage.a_u',          // phase A voltage (V)
  'measure_voltage.b_u',          // phase B voltage (V)
  'measure_voltage.c_u',          // phase C voltage (V)
  'measure_current.a_i',          // phase A current (A)
  'measure_current.b_i',          // phase B current (A)
  'measure_current.c_i',          // phase C current (A)
  'meter_power.inv_daily',        // inverter daily yield (kWh)
  'measure_power.mppt',           // MPPT DC input power (W)
];

// Battery-level capabilities — added dynamically when battery data is available
const BATTERY_CAPABILITIES = [
  'measure_battery',               // SoC (%)
  'meter_power.today_batt_output', // discharged today (kWh)
];

// Additional battery capabilities — added dynamically when data is available
const BATTERY_EXTRA_CAPABILITIES = [
  'openapi_battery_status',        // running state string
  'measure_power.dischargesetting',// max discharge power (W)
  'openapi_battery_mode',          // charge/discharge mode string
];

// Grid meter capabilities — added dynamically when meter data is available
const METER_CAPABILITIES = [
  'measure_power.grid_import', // grid import power (W)
  'measure_power.grid_export', // grid export power (W)
];

// Power sensor capabilities — added dynamically when power sensor data is available
const POWER_SENSOR_CAPABILITIES = [
  'measure_voltage.meter_u',   // Phase A voltage (V)
  'measure_current.meter_i',   // Phase A current (A)
  'measure_power.grid_import', // active power import (W) — shared with type 17
  'measure_power.grid_export', // active power export (W) — shared with type 17
  'meter_power.grid_import',   // total imported energy (kWh)
  'meter_power.grid_export',   // total exported energy (kWh)
];

const BATTERY_STATUS_MAP = {
  0: 'Offline',
  1: 'Standby',
  2: 'Running',
  3: 'Faulty',
  4: 'Hibernating',
};

const BATTERY_MODE_MAP = {
  0:  'None',
  1:  'Forced charge/discharge',
  2:  'Time-of-use price',
  3:  'Fixed charge/discharge',
  4:  'Automatic charge/discharge',
  5:  'Fully fed to grid',
  6:  'TOU',
  7:  'Remote scheduling – max. self-consumption',
  8:  'Remote scheduling – fully fed to grid',
  9:  'Remote scheduling – TOU',
  10: 'AI energy control',
  11: 'Remote control – AI energy control',
  12: 'Third-party dispatch',
};

const INVERTER_STATE_MAP = {
  0:   'Standby: initializing',
  256: 'Standby: detecting insulation resistance',
  512: 'Standby: detecting irradiation',
  513: 'Standby: grid detecting',
  514: 'Normal: on-grid',
  515: 'Normal: power limited',
  516: 'Normal: self-derating',
  517: 'Shutdown: fault',
  518: 'Shutdown: command',
  519: 'Shutdown: OVGR',
  521: 'Shutdown: reactive power over-limit',
  522: 'Shutdown: output over-current',
  523: 'Shutdown: SOP protection',
  524: 'Shutdown: grid-side SOP',
  527: 'Shutdown: PV under-voltage',
  528: 'Shutdown: PV over-current',
  529: 'Shutdown: event caused',
  533: 'Shutdown: manual',
  534: 'Shutdown: temperature',
  535: 'Shutdown: frequency',
  536: 'Grid scheduling: cosφ-P curve',
  537: 'Grid scheduling: Q-U curve',
  538: 'Spot-check ready',
  539: 'Spot-checking',
  541: 'Inspection: PV string',
  768: 'Low voltage ride-through',
  769: 'High voltage ride-through',
  770: 'Low frequency ride-through',
  771: 'High frequency ride-through',
  776: 'Shutdown: off-grid',
  777: 'Off-grid: initializing',
  778: 'Off-grid: grid-tied',
  1025: 'Reactive compensation',
  1026: 'Idle',
};

class FusionSolarOpenAPIDevice extends Device {

  async onInit() {
    this.log(`Device initialised: ${this.getName()}`);
    this._token          = null;
    this._devIdsByType   = null; // { [typeId]: [devId, ...] } — shared cache for all device types
    this._loginBackoffUntil = 0; // timestamp — no login attempts before this time
    await this._ensureCapabilities();
    await this._startPolling();
    this._fetchAndUpdate().catch((err) => {
      this.error('Initial fetch failed:', err.message);
    });
  }

  async onSettings({ changedKeys }) {
    if (['base_url', 'username', 'system_code', 'poll_interval'].some((k) => changedKeys.includes(k))) {
      this._token        = null;
      this._devIdsByType = null;
      await this._stopPolling();
      await this._startPolling();
      this._fetchAndUpdate().catch((err) => {
        this.error('Fetch after settings change failed:', err.message);
      });
    }
  }

  async onUninit() { await this._stopPolling(); }
  async onDeleted() { await this._stopPolling(); }

  // ─── Capabilities ──────────────────────────────────────────────────────────

  async _ensureCapabilities() {
    for (const cap of DEPRECATED_CAPABILITIES) {
      if (this.hasCapability(cap)) {
        try { await this.removeCapability(cap); } catch (_) {}
      }
    }
    for (const cap of [...REQUIRED_CAPABILITIES, ...INVERTER_CAPABILITIES]) {
      if (!this.hasCapability(cap)) await this.addCapability(cap);
    }
  }

  // ─── Polling ───────────────────────────────────────────────────────────────

  _intervalMs() {
    let min = parseInt(this.getSetting('poll_interval'), 10);
    if (!Number.isFinite(min) || min < MIN_INTERVAL_MIN) min = DEFAULT_INTERVAL_MIN;
    return min * 60 * 1000;
  }

  async _startPolling() {
    this._timer = this.homey.setInterval(() => {
      this._fetchAndUpdate().catch((err) => this.error('Poll failed:', err.message));
    }, this._intervalMs());
  }

  async _stopPolling() {
    if (this._timer) { this.homey.clearInterval(this._timer); this._timer = null; }
  }

  // ─── Auth ──────────────────────────────────────────────────────────────────

  _baseUrl() {
    return (this.getSetting('base_url') || 'https://eu5.fusionsolar.huawei.com').trim().replace(/\/$/, '');
  }

  async _ensureToken() {
    if (this._token) return this._token;

    const remaining = this._loginBackoffUntil - Date.now();
    if (remaining > 0) {
      const mins = Math.ceil(remaining / 60000);
      throw new Error(`Rate limited — login paused for ${mins} more minute(s)`);
    }

    const username   = this.getSetting('username');
    const systemCode = this.getSetting('system_code');
    if (!username || !systemCode) throw new Error(this.homey.__('openapi.errors.noCredentials'));
    this._token = await login(this._baseUrl(), username, systemCode);
    return this._token;
  }

  async _withAutoRelogin(fn) {
    const token = await this._ensureToken();
    let result  = await fn(token);
    if (result.expired) {
      this._token = null;
      const fresh = await this._ensureToken();
      result = await fn(fresh);
    }
    return result;
  }

  // ─── Device list cache (shared by all device-type fetchers) ────────────────

  async _ensureDevIdsByType(base, stationCode) {
    if (this._devIdsByType) return;
    const devResult = await this._withAutoRelogin(
      (t) => getDevList(base, t, stationCode),
    );
    this._devIdsByType = {};
    for (const d of devResult.devices) {
      const typeId = Number(d.devTypeId);
      if (!this._devIdsByType[typeId]) this._devIdsByType[typeId] = [];
      if (d.id) this._devIdsByType[typeId].push(String(d.id));
    }
    this.log(`Device list cached: ${JSON.stringify(Object.fromEntries(
      Object.entries(this._devIdsByType).map(([k, v]) => [k, v.length]),
    ))}`);
  }

  // ─── Data fetch ────────────────────────────────────────────────────────────

  async _fetchAndUpdate() {
    if (this._fetchInProgress) return;
    this._fetchInProgress = true;

    const stationCode = this.getSetting('station_code');
    if (!stationCode) {
      this._fetchInProgress = false;
      await this.setUnavailable(this.homey.__('openapi.errors.noStation'));
      return;
    }

    const base = this._baseUrl();

    try {
      // ── Station-level KPI ──
      const stationResult = await this._withAutoRelogin(
        (t) => getStationRealKpi(base, t, stationCode),
      );

      if (!stationResult.kpi) {
        await this.setUnavailable(this.homey.__('openapi.errors.noData'));
        this._fetchInProgress = false;
        return;
      }

      const { kpi } = stationResult;
      // Note: real_time_power does not exist in getStationRealKpi — power comes from inverter device KPI
      await this._set('meter_power',         kpi.totalEnergy);
      await this._set('meter_power.daily',   kpi.dailyEnergy);
      await this._set('meter_power_monthly', kpi.monthEnergy);

      // ── Non-blocking sub-fetches ──
      this._fetchInverterKpi(base, stationCode).catch(() => {});
      this._fetchBatteryKpi(base, stationCode).catch(() => {});
      this._fetchMeterKpi(base, stationCode).catch(() => {});
      this._fetchPowerSensorKpi(base, stationCode).catch(() => {});

      if (!this.getAvailable()) await this.setAvailable();

    } catch (err) {
      this.error('Fetch error:', err.message);
      if (err.message.includes('407') || err.message.includes('Rate limit')) {
        // Back off 15 minutes before attempting login again (login API: max 5×/10 min)
        this._loginBackoffUntil = Date.now() + 15 * 60 * 1000;
        this._token = null;
        this.log('Rate limit hit — login paused for 15 minutes');
      } else if (err.message.includes('Login failed') || err.message.includes('noCredentials')) {
        this._token = null;
      }
      await this.setUnavailable(`${this.homey.__('openapi.errors.fetchFailed')}: ${err.message}`);
    } finally {
      this._fetchInProgress = false;
    }
  }

  async _fetchInverterKpi(base, stationCode) {
    try {
      await this._ensureDevIdsByType(base, stationCode);
      const ids = this._devIdsByType[DEV_TYPE_INVERTER] || [];
      if (!ids.length) return;

      const kpiResult = await this._withAutoRelogin(
        (t) => getDevRealKpi(base, t, ids, DEV_TYPE_INVERTER),
      );
      if (!kpiResult.devices.length) return;

      const maps = kpiResult.devices.map((d) => d.dataItemMap).filter(Boolean);
      if (!maps.length) return;

      const num  = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
      const avg  = (key) => {
        const vals = maps.map((m) => num(m[key])).filter((v) => v !== null);
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      };
      const sumW = (key) => {
        const vals = maps.map((m) => num(m[key])).filter((v) => v !== null);
        return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) * 1000) : null; // kW → W
      };
      const sumKw = (key) => {
        const vals = maps.map((m) => num(m[key])).filter((v) => v !== null);
        return vals.length ? vals.reduce((a, b) => a + b, 0) : null; // stays in kW/kWh
      };

      const activePowerW = sumW('active_power');
      await this._set('measure_power.active_power',   activePowerW);
      await this._set('measure_temperature.invertor', avg('temperature'));

      // Add extra inverter capabilities dynamically on first successful fetch
      for (const cap of INVERTER_EXTRA_CAPABILITIES) {
        if (!this.hasCapability(cap)) await this.addCapability(cap).catch(() => {});
      }

      // Inverter state — use last inverter's state (or first one)
      const stateVal = num(maps[0].inverter_state);
      if (stateVal !== null) {
        const stateStr = INVERTER_STATE_MAP[stateVal] ?? `State ${stateVal}`;
        await this._set('huawei_status', stateStr);
      }

      await this._set('measure_voltage.ab_u', avg('ab_u'));
      await this._set('measure_voltage.bc_u', avg('bc_u'));
      await this._set('measure_voltage.ca_u', avg('ca_u'));
      await this._set('measure_voltage.a_u',  avg('a_u'));
      await this._set('measure_voltage.b_u',  avg('b_u'));
      await this._set('measure_voltage.c_u',  avg('c_u'));
      await this._set('measure_current.a_i',  avg('a_i'));
      await this._set('measure_current.b_i',  avg('b_i'));
      await this._set('measure_current.c_i',  avg('c_i'));
      await this._set('meter_power.inv_daily',  sumKw('day_cap'));       // kWh
      await this._set('measure_power.mppt',     sumW('mppt_power'));     // kW → W

      const powerW = activePowerW ?? 0;
      await this.homey.flow
        .getDeviceTriggerCard('openapi_power_changed')
        .trigger(this, { power: powerW })
        .catch(() => {});

    } catch (err) {
      this.error('Inverter KPI failed:', err.message);
    }
  }

  async _fetchBatteryKpi(base, stationCode) {
    try {
      await this._ensureDevIdsByType(base, stationCode);
      const ids39  = this._devIdsByType[DEV_TYPE_BATTERY]     || [];
      const ids41  = this._devIdsByType[DEV_TYPE_BATTERY_ESS] || [];
      // Query residential batteries (39) and C&I ESS (41) separately — same fields used
      const ids    = ids39.length ? ids39 : ids41;
      const typeId = ids39.length ? DEV_TYPE_BATTERY : DEV_TYPE_BATTERY_ESS;
      if (!ids.length) return;

      const result = await this._withAutoRelogin(
        (t) => getDevRealKpi(base, t, ids, typeId),
      );
      if (!result.devices.length) return;

      const maps = result.devices.map((d) => d.dataItemMap).filter(Boolean);
      if (!maps.length) return;

      const num     = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
      const avg     = (key) => {
        const vals = maps.map((m) => num(m[key])).filter((v) => v !== null);
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      };
      const sumRndW = (key) => {                                             // values already in W
        const vals = maps.map((m) => num(m[key])).filter((v) => v !== null);
        return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0)) : null;
      };
      const sumKwh  = (key) => {
        const vals = maps.map((m) => num(m[key])).filter((v) => v !== null);
        return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
      };

      // Add battery capabilities dynamically on first successful fetch
      for (const cap of [...BATTERY_CAPABILITIES, ...BATTERY_EXTRA_CAPABILITIES]) {
        if (!this.hasCapability(cap)) await this.addCapability(cap).catch(() => {});
      }

      await this._set('measure_battery',               avg('battery_soc'));
      await this._set('meter_power.today_batt_output', sumKwh('discharge_cap'));

      // Battery status
      const battStatusVal = num(maps[0].battery_status);
      if (battStatusVal !== null) {
        await this._set('openapi_battery_status', BATTERY_STATUS_MAP[battStatusVal] ?? `State ${battStatusVal}`);
      }

      // Charge/discharge mode
      const battModeVal = num(maps[0].ch_discharge_model);
      if (battModeVal !== null) {
        await this._set('openapi_battery_mode', BATTERY_MODE_MAP[battModeVal] ?? `Mode ${battModeVal}`);
      }

      await this._set('measure_power.dischargesetting', sumRndW('max_discharge_power')); // W

    } catch (err) {
      this.error('Battery KPI failed:', err.message);
    }
  }

  async _fetchMeterKpi(base, stationCode) {
    try {
      await this._ensureDevIdsByType(base, stationCode);
      const ids = this._devIdsByType[DEV_TYPE_METER] || [];
      if (!ids.length) return;

      const result = await this._withAutoRelogin(
        (t) => getDevRealKpi(base, t, ids, DEV_TYPE_METER),
      );
      if (!result.devices.length) return;

      const maps = result.devices.map((d) => d.dataItemMap).filter(Boolean);
      if (!maps.length) return;

      const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

      // Grid meter active_power is in W (not kW); positive = import, negative = export
      const totalW = maps
        .map((m) => num(m.active_power))
        .filter((v) => v !== null)
        .reduce((a, b) => a + b, 0);

      // Add meter capabilities dynamically on first successful fetch
      for (const cap of METER_CAPABILITIES) {
        if (!this.hasCapability(cap)) await this.addCapability(cap).catch(() => {});
      }

      await this._set('measure_power.grid_import', totalW >= 0 ? Math.round(totalW) : 0);
      await this._set('measure_power.grid_export', totalW <  0 ? Math.round(-totalW) : 0);

    } catch (err) {
      this.error('Meter KPI failed:', err.message);
    }
  }

  async _fetchPowerSensorKpi(base, stationCode) {
    try {
      await this._ensureDevIdsByType(base, stationCode);
      const ids = this._devIdsByType[DEV_TYPE_POWER_SENSOR] || [];
      if (!ids.length) return;

      const result = await this._withAutoRelogin(
        (t) => getDevRealKpi(base, t, ids, DEV_TYPE_POWER_SENSOR),
      );
      if (!result.devices.length) return;

      const maps = result.devices.map((d) => d.dataItemMap).filter(Boolean);
      if (!maps.length) return;

      const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
      const avg = (key) => {
        const vals = maps.map((m) => num(m[key])).filter((v) => v !== null);
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      };
      const sumKwh = (key) => {
        const vals = maps.map((m) => num(m[key])).filter((v) => v !== null);
        return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
      };

      // Add power sensor capabilities dynamically on first successful fetch
      for (const cap of POWER_SENSOR_CAPABILITIES) {
        if (!this.hasCapability(cap)) await this.addCapability(cap).catch(() => {});
      }

      await this._set('measure_voltage.meter_u', avg('meter_u'));
      await this._set('measure_current.meter_i', avg('meter_i'));

      // active_power is in W; positive = import, negative = export
      const totalW = maps
        .map((m) => num(m.active_power))
        .filter((v) => v !== null)
        .reduce((a, b) => a + b, 0);
      await this._set('measure_power.grid_import', totalW >= 0 ? Math.round(totalW) : 0);
      await this._set('measure_power.grid_export', totalW <  0 ? Math.round(-totalW) : 0);

      await this._set('meter_power.ps_active',  sumKwh('active_cap'));
      await this._set('meter_power.ps_reverse', sumKwh('reverse_active_cap'));

    } catch (err) {
      this.error('Power sensor KPI failed:', err.message);
    }
  }

  // ─── Helper ────────────────────────────────────────────────────────────────

  async _set(capability, value) {
    if (value === null || value === undefined) return;
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    try {
      await this.setCapabilityValue(capability, value);
    } catch (err) {
      this.log(`_set(${capability}, ${value}) failed:`, err.message);
    }
  }

}

module.exports = FusionSolarOpenAPIDevice;
