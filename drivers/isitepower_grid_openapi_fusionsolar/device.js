'use strict';

const { Device } = require('homey');
const { withSettingsLog } = require('../../lib/change-log');
const { DEV_TYPE_MAINS, DEV_TYPE_AC_OUTPUT, DEV_TYPE_SOLAR_GROUP, DEV_TYPE_BATTERY_RACK, calculate } = require('../../lib/isitepower-utils');
const { logPollOk } = require('../../lib/poll-log');
const capabilitySet = require('../../lib/capability-set');

const REQUIRED_CAPABILITIES = [
  'measure_power',
  'meter_power',
  'meter_power.exported',
  'measure_voltage.phase1',
  'measure_current.phase1',
  'measure_frequency',
];

class ISitePowerGridDevice extends Device {

  async onInit() {
    this.log(`iSitePower-M Grid device initialised: ${this.getName()}`);
    this._prevExporting  = null;
    this._prevGridW      = 0;
    this._lastEnergyTs   = this.getStoreValue('energy_ts') || Date.now();
    this._importedKwh    = this.getStoreValue('imported_kwh') || 0;
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

  getDevTypes() { return [DEV_TYPE_MAINS, DEV_TYPE_AC_OUTPUT, DEV_TYPE_SOLAR_GROUP, DEV_TYPE_BATTERY_RACK]; }

  async onPollData({ kpiByType, freshKpiByType }) {
    const v = calculate(kpiByType, freshKpiByType);

    // Grid is calculated, not measured — suppress single-poll spikes caused by
    // timing differences between AC output and battery sensors.
    // Only report grid > 0 if it was also > 0 on the previous poll.
    const GRID_THRESHOLD = 50;
    const rawGridW = v.gridImportW;
    let gridW;
    if (rawGridW <= GRID_THRESHOLD) {
      gridW = 0;
    } else if (this._prevGridW > GRID_THRESHOLD) {
      gridW = rawGridW;
    } else {
      gridW = 0;
    }
    this._prevGridW = rawGridW;

    await this._set('measure_power', gridW);
    await this._set('measure_voltage.phase1', v.acVoltage);
    await this._set('measure_current.phase1', v.acCurrent);
    await this._set('measure_frequency', v.acFrequency);

    // Cumulative grid import: prefer direct 60001 total_energy_consumption (authoritative meter
    // reading) over local time-integration. Guard with Math.max to prevent backward jumps when
    // only one of two Mains units returns data in a given poll cycle.
    if (v.mainsTotalKwh !== null && v.mainsTotalKwh > 0) {
      const newKwh = Math.max(this._importedKwh, v.mainsTotalKwh);
      if (newKwh !== this._importedKwh) {
        this._importedKwh = newKwh;
        await this.setStoreValue('imported_kwh', newKwh);
        await this._set('meter_power', Number(newKwh.toFixed(3)));
      }
      this._lastEnergyTs = Date.now();
    } else {
      await this._accumulate(gridW);
    }

    if (!this.getAvailable()) await this.setAvailable();
    logPollOk(this, 'Poll OK: Grid=' + Math.round(gridW) + 'W (raw=' + Math.round(rawGridW) + 'W)');
  }

  async _accumulate(importW) {
    const now = Date.now();
    const h = Math.max(0, Math.min(1, (now - this._lastEnergyTs) / 3600000));
    this._lastEnergyTs = now;
    this._importedKwh += ((importW || 0) * h) / 1000;
    await this.setStoreValue('energy_ts', now);
    await this.setStoreValue('imported_kwh', this._importedKwh);
    await this._set('meter_power', Number(this._importedKwh.toFixed(3)));
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

Object.assign(ISitePowerGridDevice.prototype, capabilitySet);

// Every saved settings page in the log and the change log — see lib/change-log.js.
withSettingsLog(ISitePowerGridDevice);

module.exports = ISitePowerGridDevice;
