'use strict';

const { Device } = require('homey');
const { parseKioskUrl, buildApiUrl, fetchKioskData, extractKpiValues } = require('../../lib/kiosk-api');

const DEFAULT_INTERVAL_MIN = 10;
const MIN_INTERVAL_MIN = 5;

class FusionSolarKioskDevice extends Device {

  async onInit() {
    this.log(`Device initialised: ${this.getName()}`);

    await this._ensureCapabilities();
    await this._startPolling();

    // Initial fetch – errors are non-fatal on startup
    this._fetchAndUpdate().catch((err) => {
      this.error('Initial fetch failed:', err.message);
    });
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('kiosk_url') || changedKeys.includes('poll_interval')) {
      await this._stopPolling();
      await this._startPolling();
      this._fetchAndUpdate().catch((err) => {
        this.error('Fetch after settings change failed:', err.message);
      });
    }
  }

  async onUninit() {
    await this._stopPolling();
  }

  async onDeleted() {
    await this._stopPolling();
  }

  // ─── Capabilities ─────────────────────────────────────────────────────────

  async _ensureCapabilities() {
    const deprecated = [
      'meter_power_daily',
      'meter_power_cumulative',
    ];
    const required = [
      'measure_power',
      'meter_power',
      'meter_power.daily',
      'meter_power_monthly',
      'meter_power_yearly',
    ];

    for (const cap of deprecated) {
      if (this.hasCapability(cap)) {
        try { await this.removeCapability(cap); } catch (_) {}
      }
    }
    for (const cap of required) {
      if (!this.hasCapability(cap)) await this.addCapability(cap);
    }
  }

  // ─── Polling ──────────────────────────────────────────────────────────────

  _intervalMs() {
    let min = parseInt(this.getSetting('poll_interval'), 10);
    if (!Number.isFinite(min) || min < MIN_INTERVAL_MIN) min = DEFAULT_INTERVAL_MIN;
    return min * 60 * 1000;
  }

  async _startPolling() {
    this._timer = this.homey.setInterval(() => {
      this._fetchAndUpdate().catch((err) => {
        this.error('Poll failed:', err.message);
      });
    }, this._intervalMs());
  }

  async _stopPolling() {
    if (this._timer) {
      this.homey.clearInterval(this._timer);
      this._timer = null;
    }
  }

  // ─── Data fetch ───────────────────────────────────────────────────────────

  async _fetchAndUpdate() {
    const kioskUrl = this.getSetting('kiosk_url');

    if (!kioskUrl) {
      await this.setUnavailable(this.homey.__('errors.noUrl'));
      return;
    }

    try {
      const { baseUrl, kk } = parseKioskUrl(kioskUrl);
      const raw = await fetchKioskData(buildApiUrl(baseUrl, kk));
      const kpi = extractKpiValues(raw);

      await this._set('measure_power',       kpi.realTimePower);
      await this._set('meter_power',          kpi.cumulativeEnergy);
      await this._set('meter_power.daily',    kpi.dailyEnergy);
      await this._set('meter_power_monthly',  kpi.monthEnergy);
      await this._set('meter_power_yearly',   kpi.yearEnergy);

      // Trigger flows
      await this.homey.flow
        .getDeviceTriggerCard('power_changed')
        .trigger(this, { power: kpi.realTimePower })
        .catch((err) => this.log('Flow trigger power_changed failed:', err.message));

      await this.homey.flow
        .getDeviceTriggerCard('daily_energy_updated')
        .trigger(this, { daily_energy: kpi.dailyEnergy })
        .catch((err) => this.log('Flow trigger daily_energy_updated failed:', err.message));

      if (!this.getAvailable()) await this.setAvailable();

    } catch (err) {
      this.error('Fetch error:', err.message);
      await this.setUnavailable(
        `${this.homey.__('errors.fetchFailed')}: ${err.message}`,
      );
    }
  }

  async _set(capability, value) {
    if (this.hasCapability(capability) && this.getCapabilityValue(capability) !== value) {
      await this.setCapabilityValue(capability, value);
    }
  }

}

module.exports = FusionSolarKioskDevice;
