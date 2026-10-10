'use strict';

const { Device } = require('homey');
const { withSettingsLog } = require('../../lib/change-log');
const { DEV_TYPE_BATTERY_RACK, calculate } = require('../../lib/isitepower-utils');
const { logPollOk } = require('../../lib/poll-log');
const capabilitySet = require('../../lib/capability-set');

const REQUIRED_CAPABILITIES = [
  'measure_power',
  'measure_battery',
  'measure_power.batt_charge',
  'measure_power.batt_discharge',
  'meter_power.charged',
  'meter_power.discharged',
  'measure_voltage.battery',
  'battery_state_string',
];

// iSitePower-M battery_state values (different from standard LUNA2000)
const BATTERY_STATE_MAP = {
  0: 'Initial power-on',
  1: 'Power-off',
  2: 'Float charging',
  3: 'Boost charging',
  4: 'Discharging',
  5: 'Charging',
  6: 'Testing',
  7: 'Hibernation',
  8: 'Standby',
};

class ISitePowerBatteryDevice extends Device {

  async onInit() {
    this.log(`iSitePower-M Battery device initialised: ${this.getName()}`);
    this._prevSoc            = null;
    this._prevChargingState  = null;
    this._lastEnergyTs       = this.getStoreValue('energy_ts') || Date.now();
    this._chargedKwh         = this.getStoreValue('charged_kwh') || 0;
    await this._ensureCapabilities();
    this._registerConditionListeners();
    this.homey.app.getCoordinator().register(this);
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('station_code')) {
      const oldCode = this.getStoreValue('_prev_station_code');
      await this.setStoreValue('_prev_station_code', newSettings.station_code);
      this.homey.app.getCoordinator().reregister(this, oldCode, newSettings.station_code);
    } else if (changedKeys.some((k) => ['base_url_region', 'base_url', 'username', 'system_code', 'poll_interval'].includes(k))) {
      // newSettings, not getSetting(): Homey persists only after this resolves, so the
      // coordinator would otherwise copy the OLD values onto the sibling devices.
      this.homey.app.getCoordinator().settingsChanged(this, newSettings);
    }
  }

  async onUninit() { this.homey.app.getCoordinator().unregister(this); }
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

  getDevTypes() { return [DEV_TYPE_BATTERY_RACK]; }

  async onPollData({ kpiByType, freshKpiByType }) {
    const v = calculate(kpiByType, freshKpiByType);

    const signed = v.dischargeW > 0 ? -v.dischargeW : v.chargeW;
    await this._set('measure_power', signed);
    if (v.soc !== null) await this._set('measure_battery', Math.max(0, Math.min(100, v.soc)));
    await this._set('measure_power.batt_charge', v.chargeW);
    await this._set('measure_power.batt_discharge', v.dischargeW);
    await this._set('measure_voltage.battery', v.battVoltage);

    // total_discharge from API (cumulative kWh) — no need to accumulate. Summed over the
    // racks, so a rack missing from one poll lowers it; held at its high-water mark like every
    // lifetime total Homey Energy reads (lib/capability-set.js, review 2026-10-10).
    if (v.totalDischargeKwh !== null) {
      await this._setCumulative('meter_power.discharged', v.totalDischargeKwh);
    }

    // charged kWh — API has no total_charge field, must accumulate locally
    await this._accumulateCharged(v.chargeW);

    // battery_state_string
    if (v.soc !== null) {
      const IDLE_W = 50;
      let label;
      let labelAlways = false;
      if (v.soc >= 100) { label = 'Full'; labelAlways = true; }
      else if (v.soc < 5 && Math.abs(signed) <= IDLE_W) { label = 'Empty'; labelAlways = true; }
      else { label = signed < 0 ? '🔻' : '🔺'; }
      const watts = Math.round(Math.abs(signed));
      const str = watts === 0
        ? labelAlways ? `${label} (${Math.round(v.soc)}%)` : `(${Math.round(v.soc)}%)`
        : `${watts} W ${label} ${Math.round(v.soc)}%`;
      await this._set('battery_state_string', str);
    }

    if (v.battStatus !== null) {
      const statusStr = BATTERY_STATE_MAP[v.battStatus] ?? `State ${v.battStatus}`;
      if (!this.hasCapability('openapi_battery_status')) await this.addCapability('openapi_battery_status').catch(() => {});
      await this._set('openapi_battery_status', statusStr);
    }

    // Extra capabilities — added dynamically
    if (v.battCurrent !== null) {
      if (!this.hasCapability('measure_current.battery')) await this.addCapability('measure_current.battery').catch(() => {});
      await this._set('measure_current.battery', v.battCurrent);
    }
    if (v.remainingBackupH !== null) {
      if (!this.hasCapability('isitepower_remaining_backup_time')) await this.addCapability('isitepower_remaining_backup_time').catch(() => {});
      await this._set('isitepower_remaining_backup_time', v.remainingBackupH);
    }
    if (v.totalCapacityKwh !== null) {
      if (!this.hasCapability('isitepower_total_capacity')) await this.addCapability('isitepower_total_capacity').catch(() => {});
      await this._set('isitepower_total_capacity', v.totalCapacityKwh);
    }
    if (v.dischargeCycles !== null) {
      if (!this.hasCapability('isitepower_discharge_cycles')) await this.addCapability('isitepower_discharge_cycles').catch(() => {});
      await this._set('isitepower_discharge_cycles', v.dischargeCycles);
    }

    // ─── Flow triggers ─────────────────────────────────────────────────────────
    const soc = v.soc !== null ? Math.round(v.soc) : null;
    if (soc !== null && soc !== this._prevSoc) {
      this._prevSoc = soc;
      this.homey.flow.getDeviceTriggerCard('luna2000_soc_changed')
        .trigger(this, { soc })
        .catch((err) => this.log('Flow trigger luna2000_soc_changed failed:', err.message));
    }

    const IDLE_THRESHOLD_W = 50;
    const chargingState = signed > IDLE_THRESHOLD_W ? 'charging'
      : signed < -IDLE_THRESHOLD_W ? 'discharging'
      : 'idle';

    if (this._prevChargingState !== null && chargingState !== this._prevChargingState) {
      this.homey.flow.getDeviceTriggerCard('luna2000_charging_state_changed')
        .trigger(this, { state: chargingState })
        .catch((err) => this.log('Flow trigger luna2000_charging_state_changed failed:', err.message));
      if (chargingState === 'charging') {
        this.homey.flow.getDeviceTriggerCard('luna2000_charging_started')
          .trigger(this, {}).catch((err) => this.log('Flow trigger luna2000_charging_started failed:', err.message));
      } else if (chargingState === 'discharging') {
        this.homey.flow.getDeviceTriggerCard('luna2000_discharging_started')
          .trigger(this, {}).catch((err) => this.log('Flow trigger luna2000_discharging_started failed:', err.message));
      }
    }
    this._prevChargingState = chargingState;

    if (!this.getAvailable()) await this.setAvailable();
    logPollOk(this, 'Poll OK: SoC=' + Math.round(v.soc ?? 0) + '% P=' + Math.round(signed) + 'W');
  }

  async _accumulateCharged(chargeW) {
    const now = Date.now();
    const h = Math.max(0, Math.min(1, (now - this._lastEnergyTs) / 3600000));
    this._lastEnergyTs = now;
    this._chargedKwh += ((chargeW || 0) * h) / 1000;
    await this.setStoreValue('energy_ts', now);
    await this.setStoreValue('charged_kwh', this._chargedKwh);
    if (!this.hasCapability('meter_power.charged')) await this.addCapability('meter_power.charged').catch(() => {});
    await this._set('meter_power.charged', Number(this._chargedKwh.toFixed(3)));
  }

  async _ensureCapabilities() {
    for (const cap of REQUIRED_CAPABILITIES) {
      if (!this.hasCapability(cap)) {
        try { await this.addCapability(cap); } catch (err) {
          this.error("addCapability(" + cap + ") failed:", err.message);
        }
      }
    }
  }

}

Object.assign(ISitePowerBatteryDevice.prototype, capabilitySet);

// Every saved settings page in the log and the change log — see lib/change-log.js.
withSettingsLog(ISitePowerBatteryDevice);

module.exports = ISitePowerBatteryDevice;
