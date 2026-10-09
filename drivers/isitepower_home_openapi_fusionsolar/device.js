'use strict';

const { Device } = require('homey');
const { withSettingsLog } = require('../../lib/change-log');
const { DEV_TYPE_MAINS, DEV_TYPE_AC_OUTPUT, calculate } = require('../../lib/isitepower-utils');
const { logPollOk } = require('../../lib/poll-log');
const capabilitySet = require('../../lib/capability-set');

const REQUIRED_CAPABILITIES = [
  'measure_power',
  'meter_power',
  'meter_power.exported',
];

class ISitePowerHomeDevice extends Device {

  async onInit() {
    this.log(`iSitePower-M Home device initialised: ${this.getName()}`);
    this._lastEnergyTs = this.getStoreValue('energy_ts') || Date.now();
    this._homeKwh      = this.getStoreValue('home_kwh') || 0;
    await this._ensureCapabilities();
    await this._set('meter_power.exported', 0);
    this.homey.app.getCoordinator().register(this);
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('station_code')) {
      const oldCode = this.getStoreValue('_prev_station_code');
      await this.setStoreValue('_prev_station_code', newSettings.station_code);
      this.homey.app.getCoordinator().reregister(this, oldCode);
    } else if (changedKeys.some((k) => ['base_url_region', 'base_url', 'username', 'system_code', 'poll_interval'].includes(k))) {
      // newSettings, not getSetting(): Homey persists only after this resolves, so the
      // coordinator would otherwise copy the OLD values onto the sibling devices.
      this.homey.app.getCoordinator().settingsChanged(this, newSettings);
    }
  }

  async onUninit() { this.homey.app.getCoordinator().unregister(this); }
  async onDeleted() { this.homey.app.getCoordinator().unregister(this); }

  getDevTypes() { return [DEV_TYPE_MAINS, DEV_TYPE_AC_OUTPUT]; }

  async onPollData({ kpiByType, freshKpiByType }) {
    const v = calculate(kpiByType, freshKpiByType);

    if (v.loadW !== null) {
      // Live or stale-cached data available — update display and accumulate
      await this._set('measure_power', v.loadW);
      await this._accumulate(v.loadW);
      logPollOk(this, 'Poll OK: Load=' + Math.round(v.loadW) + 'W');
    } else {
      // No 60010/60092 data — system is likely in solar/battery mode with no grid.
      // Keep accumulating using the last Homey-persisted measure_power so meter_power
      // stays continuous and the Energy tab doesn't show "— kWh".
      const lastW = this.getCapabilityValue('measure_power') ?? 0;
      await this._accumulate(lastW);
      logPollOk(this, 'Poll: no 60010/60092 data; accumulating with last known value (' + Math.round(lastW) + 'W)');
    }

    if (!this.getAvailable()) await this.setAvailable();
  }

  async _accumulate(homeW) {
    const now = Date.now();
    const h = Math.max(0, Math.min(1, (now - this._lastEnergyTs) / 3600000));
    this._lastEnergyTs = now;
    this._homeKwh += ((homeW || 0) * h) / 1000;
    await this.setStoreValue('energy_ts', now);
    await this.setStoreValue('home_kwh', this._homeKwh);
    await this._set('meter_power', Number(this._homeKwh.toFixed(3)));
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

Object.assign(ISitePowerHomeDevice.prototype, capabilitySet);

// Every saved settings page in the log and the change log — see lib/change-log.js.
withSettingsLog(ISitePowerHomeDevice);

module.exports = ISitePowerHomeDevice;
