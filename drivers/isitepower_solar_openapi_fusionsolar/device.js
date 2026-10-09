'use strict';

const { Device } = require('homey');
const { withSettingsLog } = require('../../lib/change-log');
const { DEV_TYPE_SOLAR_GROUP, DEV_TYPE_POWER_CONVERTER, calculate } = require('../../lib/isitepower-utils');
const { logPollOk } = require('../../lib/poll-log');
const capabilitySet = require('../../lib/capability-set');

const REQUIRED_CAPABILITIES = [
  'measure_power',
  'meter_power',
];

class ISitePowerSolarDevice extends Device {

  async onInit() {
    this.log(`iSitePower-M Solar device initialised: ${this.getName()}`);
    await this._ensureCapabilities();
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

  getDevTypes() { return [DEV_TYPE_SOLAR_GROUP, DEV_TYPE_POWER_CONVERTER]; }

  async onPollData({ stationKpi, kpiByType, freshKpiByType }) {
    const v = calculate(kpiByType, freshKpiByType);
    await this._set('measure_power', v.solarW);
    if (v.solarCurrentA !== null) {
      if (!this.hasCapability('measure_current')) await this.addCapability('measure_current').catch(() => {});
      await this._set('measure_current', v.solarCurrentA);
    }

    // The same station total that issue #34 caught dipping by a full day's production at
    // FusionSolar's nightly rollover. The old comment here claimed it "never resets"; it
    // does, briefly, and Homey books the recovery as generation. _setCumulative holds the
    // high reading through the dip.
    //
    // The > 0 test stays for a different failure: some off-grid stations return 0 for every
    // KPI, and while the guard below would hold that too, saying so here is cheaper than
    // making the reader work it out.
    if (stationKpi?.totalEnergy > 0) {
      await this._setCumulative('meter_power', stationKpi.totalEnergy);
    }

    if (!this.getAvailable()) await this.setAvailable();
    logPollOk(this, 'Poll OK: PV=' + Math.round(v.solarW) + 'W');
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

Object.assign(ISitePowerSolarDevice.prototype, capabilitySet);

// Every saved settings page in the log and the change log — see lib/change-log.js.
withSettingsLog(ISitePowerSolarDevice);

module.exports = ISitePowerSolarDevice;
