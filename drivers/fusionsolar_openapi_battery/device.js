'use strict';

const { Device } = require('homey');

const DEV_TYPE_BATTERY     = 39; // Residential battery (LUNA2000)
const DEV_TYPE_BATTERY_ESS = 41; // C&I and utility ESS

const REQUIRED_CAPABILITIES = [
  'measure_power',    // battery power (W): positive = charging, negative = discharging
  'measure_battery',  // SoC (%)
];

const EXTRA_CAPABILITIES = [
  'measure_power.batt_charge',      // charge power (W, positive only)
  'measure_power.batt_discharge',   // discharge power (W, positive only)
  'measure_power.chargesetting',    // max charge power (W)
  'measure_power.dischargesetting', // max discharge power (W)
  'meter_power.today_batt_input',   // charged today (kWh)
  'meter_power.today_batt_output',  // discharged today (kWh)
  'measure_battery.soh',            // battery state of health (%)
  'openapi_battery_status',         // running state string
];

// Removed capabilities — stripped from already-paired devices on init
const DEPRECATED_CAPABILITIES = [
  'measure_voltage.busbar',
  'meter_power.batt_rated',
  'meter_power.charged',
  'meter_power.discharged',
  'openapi_battery_mode',
  'openapi_battery_run_state',
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

class FusionSolarBatteryDevice extends Device {

  async onInit() {
    this.log(`Battery device initialised: ${this.getName()}`);
    this._prevSoc            = null;
    this._prevChargingState  = null;
    await this._ensureCapabilities();
    this.homey.app.getCoordinator().register(this);
  }

  async onSettings({ newSettings, changedKeys }) {
    const stationChanged = changedKeys.includes('station_code');
    if (stationChanged) {
      const oldCode = this.getStoreValue('_prev_station_code');
      await this.setStoreValue('_prev_station_code', newSettings.station_code);
      this.homey.app.getCoordinator().reregister(this, oldCode);
    } else if (changedKeys.some((k) => ['base_url', 'username', 'system_code', 'poll_interval'].includes(k))) {
      this.homey.app.getCoordinator().settingsChanged(this);
    }
  }

  async onUninit()  { this.homey.app.getCoordinator().unregister(this); }
  async onDeleted() { this.homey.app.getCoordinator().unregister(this); }

  // ─── Coordinator interface ─────────────────────────────────────────────────

  getDevTypes() { return [DEV_TYPE_BATTERY, DEV_TYPE_BATTERY_ESS]; }

  async onPollData({ kpiByType }) {
    // Use residential battery (39) if available, otherwise C&I ESS (41)
    const maps = (kpiByType[DEV_TYPE_BATTERY] || []).length
      ? kpiByType[DEV_TYPE_BATTERY]
      : kpiByType[DEV_TYPE_BATTERY_ESS] || [];

    if (!maps.length) return;

    const num     = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
    const avg     = (key) => {
      const vals = maps.map((m) => num(m[key])).filter((v) => v !== null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const sumRndW = (key) => {
      const vals = maps.map((m) => num(m[key])).filter((v) => v !== null);
      return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0)) : null;
    };
    const sumKwh  = (key) => {
      const vals = maps.map((m) => num(m[key])).filter((v) => v !== null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    };

    const battPowerW = sumRndW('ch_discharge_power'); // + = charging, − = discharging
    await this._set('measure_power',   battPowerW);
    await this._set('measure_battery', avg('battery_soc'));

    // Add extra capabilities dynamically on first successful fetch
    for (const cap of EXTRA_CAPABILITIES) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(() => {});
    }

    await this._set('measure_power.batt_charge',      battPowerW !== null ? Math.max(0,  battPowerW) : null);
    await this._set('measure_power.batt_discharge',   battPowerW !== null ? Math.max(0, -battPowerW) : null);
    await this._set('measure_power.chargesetting',    sumRndW('max_charge_power'));
    await this._set('measure_power.dischargesetting', sumRndW('max_discharge_power'));
    await this._set('meter_power.today_batt_input',   sumKwh('charge_cap'));
    await this._set('meter_power.today_batt_output',  sumKwh('discharge_cap'));

    await this._set('measure_battery.soh',            avg('battery_soh'));

    const battStatusVal = num(maps[0].battery_status);
    if (battStatusVal !== null) {
      await this._set('openapi_battery_status', BATTERY_STATUS_MAP[battStatusVal] ?? `State ${battStatusVal}`);
    }

    // ─── Flow triggers ─────────────────────────────────────────────────────────

    const soc = avg('battery_soc');
    if (soc !== null && soc !== this._prevSoc) {
      this._prevSoc = soc;
      await this.homey.flow
        .getDeviceTriggerCard('openapi_battery_soc_changed')
        .trigger(this, { soc })
        .catch(() => {});
    }

    const IDLE_THRESHOLD_W = 50;
    const powerW = battPowerW ?? 0;
    const chargingState = powerW > IDLE_THRESHOLD_W ? 'charging'
      : powerW < -IDLE_THRESHOLD_W ? 'discharging'
      : 'idle';

    if (this._prevChargingState !== null && chargingState !== this._prevChargingState) {
      await this.homey.flow
        .getDeviceTriggerCard('openapi_battery_charging_state_changed')
        .trigger(this, { state: chargingState })
        .catch(() => {});
    }
    this._prevChargingState = chargingState;
  }

  // ─── Capabilities ──────────────────────────────────────────────────────────

  async _ensureCapabilities() {
    for (const cap of DEPRECATED_CAPABILITIES) {
      if (this.hasCapability(cap)) {
        try { await this.removeCapability(cap); } catch (_) {}
      }
    }
    for (const cap of REQUIRED_CAPABILITIES) {
      if (!this.hasCapability(cap)) await this.addCapability(cap);
    }
  }

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

module.exports = FusionSolarBatteryDevice;
