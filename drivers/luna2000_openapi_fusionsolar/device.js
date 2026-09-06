'use strict';

const { Device } = require('homey');
const capabilitySet = require('../../lib/capability-set');

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
  'openapi_battery_status',         // running state string
  'openapi_battery_mode',           // charge/discharge mode string
  'measure_voltage.battery',        // battery bus voltage (V)
  'meter_power.charged',            // total lifetime charged (kWh)
  'meter_power.discharged',         // total lifetime discharged (kWh)
  'battery_state_string',           // human-readable: "1234 W 🔺 73%"
];

// Removed capabilities — stripped from already-paired devices on init
const DEPRECATED_CAPABILITIES = [
  'measure_voltage.busbar',
  'meter_power.batt_rated',
  'openapi_battery_run_state',
  'openapi_working_mode_control',
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
    this._prevBatteryMode    = null;
    this._prevBatteryStatus  = null;
    await this._ensureCapabilities();
    this._registerConditionListeners();
    this.homey.app.getCoordinator().register(this);
  }

  async onSettings({ newSettings, changedKeys }) {
    const stationChanged = changedKeys.includes('station_code');
    if (stationChanged) {
      const oldCode = this.getStoreValue('_prev_station_code');
      await this.setStoreValue('_prev_station_code', newSettings.station_code);
      this.homey.app.getCoordinator().reregister(this, oldCode);
    } else if (changedKeys.some((k) => ['base_url_region', 'base_url', 'username', 'system_code', 'poll_interval'].includes(k))) {
      // newSettings, not getSetting(): Homey persists only after this resolves, so the
      // coordinator would otherwise copy the OLD values onto the sibling devices.
      this.homey.app.getCoordinator().settingsChanged(this, newSettings);
    }
  }

  async onUninit()  { this.homey.app.getCoordinator().unregister(this); }
  async onDeleted() { this.homey.app.getCoordinator().unregister(this); }

  _registerConditionListeners() {
    this.homey.flow.getConditionCard('luna2000_is_charging')
      .registerRunListener((args) => (args.device.getCapabilityValue('measure_power') ?? 0) > 50);
    this.homey.flow.getConditionCard('luna2000_is_discharging')
      .registerRunListener((args) => (args.device.getCapabilityValue('measure_power') ?? 0) < -50);
    this.homey.flow.getConditionCard('luna2000_soc_above')
      .registerRunListener((args) => (args.device.getCapabilityValue('measure_battery') ?? 0) > args.soc);
    this.homey.flow.getConditionCard('luna2000_soc_below')
      .registerRunListener((args) => (args.device.getCapabilityValue('measure_battery') ?? 0) < args.soc);
  }

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

    // Huawei sends battery_soh as 0 on plants that publish no state of health, and 0 %
    // health reads as a battery at the end of its life rather than as a figure nobody
    // sent. The power meter driver already refuses to add EMMA's missing frequency for
    // the same reason: a row that can never be filled is worse than no row.
    //
    // A plant that once reported a real value keeps it if the field later goes quiet —
    // that is how _set treats every other missing field — so the capability is only
    // dropped while it has never held anything usable. Nothing here can flap.
    const soh = avg('battery_soh');
    if (soh !== null && soh > 0) {
      if (!this.hasCapability('measure_battery.soh')) {
        await this.addCapability('measure_battery.soh').catch(() => {});
      }
      await this._set('measure_battery.soh', soh);
    } else if (this.hasCapability('measure_battery.soh')
               && !(this.getCapabilityValue('measure_battery.soh') > 0)) {
      await this.removeCapability('measure_battery.soh').catch(() => {});
    }
    await this._set('measure_voltage.battery',       avg('busbar_u'));
    await this._set('meter_power.charged',           sumKwh('total_charged_energy'));
    await this._set('meter_power.discharged',        sumKwh('total_discharged_energy'));

    const battModeVal = num(maps[0].ch_discharge_model);
    if (battModeVal !== null) {
      await this._set('openapi_battery_mode', BATTERY_MODE_MAP[battModeVal] ?? `Mode ${battModeVal}`);
    }

    const battStatusVal = num(maps[0].battery_status);
    if (battStatusVal !== null) {
      const statusLabel = BATTERY_STATUS_MAP[battStatusVal] ?? `State ${battStatusVal}`;
      await this._set('openapi_battery_status', statusLabel);
      // Announced the way luna2000_modbus announces its unit status. The first reading
      // after a restart is not a change, so nothing is posted until the battery actually
      // moves between Running, Standby, Faulty and the rest.
      if (this._prevBatteryStatus !== null && statusLabel !== this._prevBatteryStatus
          && this.getSetting('enable_timeline_notifications') !== false) {
        this.homey.notifications.createNotification({ excerpt: `${this.getName()}: ${statusLabel}` })
          .catch((err) => this.log('Timeline notification failed:', err.message));
      }
      this._prevBatteryStatus = statusLabel;
    }

    // battery_state_string — same logic as luna2000_modbus
    const soc = avg('battery_soc');
    const battPower = battPowerW ?? 0;
    if (soc !== null) {
      const IDLE_W = 50;
      let battLabel;
      let battLabelAlways = false;
      if (soc >= 100) {
        battLabel = 'Full'; battLabelAlways = true;
      } else if (soc < 5 && Math.abs(battPower) <= IDLE_W) {
        battLabel = 'Empty'; battLabelAlways = true;
      } else {
        battLabel = battPower < 0 ? '🔻' : '🔺';
      }
      const battWatts = Math.round(Math.abs(battPower));
      const battStr = battWatts === 0
        ? battLabelAlways ? `${battLabel} (${Math.round(soc)}%)` : `(${Math.round(soc)}%)`
        : `${battWatts} W ${battLabel} ${Math.round(soc)}%`;
      await this._set('battery_state_string', battStr);
    }

    // ─── Flow triggers ─────────────────────────────────────────────────────────
    if (soc !== null && soc !== this._prevSoc) {
      this._prevSoc = soc;
      await this.homey.flow
        .getDeviceTriggerCard('openapi_battery_soc_changed')
        .trigger(this, { soc })
        .catch((err) => this.log('Flow trigger openapi_battery_soc_changed failed:', err.message));
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
        .catch((err) => this.log('Flow trigger openapi_battery_charging_state_changed failed:', err.message));
      if (chargingState === 'charging') {
        this.homey.flow.getDeviceTriggerCard('luna2000_charging_started')
          .trigger(this, {}).catch((err) => this.log('Flow trigger luna2000_charging_started failed:', err.message));
      } else if (chargingState === 'discharging') {
        this.homey.flow.getDeviceTriggerCard('luna2000_discharging_started')
          .trigger(this, {}).catch((err) => this.log('Flow trigger luna2000_discharging_started failed:', err.message));
      }
    }
    this._prevChargingState = chargingState;

    const battModeStr = this.getCapabilityValue('openapi_battery_mode');
    if (battModeStr !== null && this._prevBatteryMode !== null && battModeStr !== this._prevBatteryMode) {
      this.homey.flow.getDeviceTriggerCard('luna2000_working_mode_changed')
        .trigger(this, { mode: battModeStr })
        .catch((err) => this.log('Flow trigger luna2000_working_mode_changed failed:', err.message));
    }
    this._prevBatteryMode = battModeStr;
  }

  // ─── Capabilities ──────────────────────────────────────────────────────────

  async _ensureCapabilities() {
    for (const cap of DEPRECATED_CAPABILITIES) {
      if (this.hasCapability(cap)) {
        try { await this.removeCapability(cap); } catch (_) {}
      }
    }
    for (const cap of REQUIRED_CAPABILITIES) {
      if (!this.hasCapability(cap)) {
        try {
          await this.addCapability(cap);
        } catch (err) {
          this.error("addCapability(" + cap + ") failed:", err.message);
        }
      }
    }
  }

}

Object.assign(FusionSolarBatteryDevice.prototype, capabilitySet);

module.exports = FusionSolarBatteryDevice;
