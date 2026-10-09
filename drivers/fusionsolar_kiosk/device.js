'use strict';

const { Device } = require('homey');
const { withSettingsLog } = require('../../lib/change-log');
const { parseKioskUrl, buildApiUrl, fetchKioskData, extractKpiValues } = require('../../lib/kiosk-api');
const { logPollOk, logPollError } = require('../../lib/poll-log');

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
      if (!this.hasCapability(cap)) {
        try {
          await this.addCapability(cap);
        } catch (err) {
          this.error("addCapability(" + cap + ") failed:", err.message);
        }
      }
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
      await this._setCumulative('meter_power', kpi.cumulativeEnergy);
      await this._set('meter_power.daily',    kpi.dailyEnergy);
      await this._set('meter_power_monthly',  kpi.monthEnergy);
      await this._set('meter_power_yearly',   kpi.yearEnergy);

      // Trigger flows. Not on a figure the API did not report: the token is a number, and a
      // flow that switches on "production above X" must not be handed a null to compare.
      if (kpi.realTimePower !== null) {
        await this.homey.flow
          .getDeviceTriggerCard('power_changed')
          .trigger(this, { power: kpi.realTimePower })
          .catch((err) => this.log('Flow trigger power_changed failed:', err.message));
      }

      if (kpi.dailyEnergy !== null) {
        await this.homey.flow
          .getDeviceTriggerCard('daily_energy_updated')
          .trigger(this, { daily_energy: kpi.dailyEnergy })
          .catch((err) => this.log('Flow trigger daily_energy_updated failed:', err.message));
      }

      if (!this.getAvailable()) await this.setAvailable();
      this._failureCount = 0;
      // Every other driver in this app reports its polls through the same throttled pair;
      // this one logged nothing at all on success, so a device that had quietly stopped
      // updating left an hour of log with no evidence either way. Throttled to one line per
      // 15 minutes, so a 5-minute interval does not fill the log.
      logPollOk(this, `Poll OK: ${kpi.realTimePower === null ? '—' : `${kpi.realTimePower} W`}`);

    } catch (err) {
      this._failureCount = (this._failureCount || 0) + 1;
      logPollError(this, `Fetch error (${this._failureCount}): ${err.message}`, err.message);
      await this.setUnavailable(
        `${this.homey.__('errors.fetchFailed')}: ${err.message}`,
      );
    }
  }

  // A figure the API did not report is not a measurement of zero. Writing null through would
  // blank the tile; writing 0 would be worse still on the cumulative counter, from which
  // Homey derives the daily yield by difference. Holding the last known value is the least
  // wrong of the three, and the poll log above is what makes the gap visible.
  async _set(capability, value) {
    if (value === null || value === undefined) return;
    if (this.hasCapability(capability) && this.getCapabilityValue(capability) !== value) {
      await this.setCapabilityValue(capability, value);
    }
  }

}

// Only _setCumulative, deliberately not the whole mixin: this driver keeps its own _set for
// the reason spelled out above it, and _setCumulative calls through to whatever _set the
// device has. The kiosk page is a different source from the OpenAPI station total, and no
// dip has been measured on it — but it is the same kind of number under the same Homey
// contract, and the README records a 0 here once booking an entire lifetime as one day.
Object.assign(FusionSolarKioskDevice.prototype, {
  _setCumulative: require('../../lib/capability-set')._setCumulative,
});

// Every saved settings page in the log and the change log — see lib/change-log.js.
withSettingsLog(FusionSolarKioskDevice);

module.exports = FusionSolarKioskDevice;
