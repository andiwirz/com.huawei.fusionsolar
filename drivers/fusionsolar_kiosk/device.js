'use strict';

const { Device } = require('homey');
const { withSettingsLog } = require('../../lib/change-log');
const { parseKioskUrl, buildApiUrl, fetchKioskData, extractKpiValues } = require('../../lib/kiosk-api');
const { logPollOk, logPollError } = require('../../lib/poll-log');
const { sun2000Names } = require('../../lib/sun2000-presence');
const { applyEnergyWarning, rememberEnergyExclude } = require('../../lib/energy-warning');

const DEFAULT_INTERVAL_MIN = 10;
const MIN_INTERVAL_MIN = 5;
// How long the poll right after a save waits for Homey to store the settings — the same two
// seconds as the Modbus drivers (lib/modbus-polling.js) and the cloud coordinator.
const SETTINGS_LAND_MS = 2000;

class FusionSolarKioskDevice extends Device {

  async onInit() {
    this.log(`Device initialised: ${this.getName()}`);

    await this._ensureCapabilities();
    await this._startPolling();
    await this._updateEnergyWarning();

    // Initial fetch – errors are non-fatal on startup
    this._fetchAndUpdate().catch((err) => {
      this.error('Initial fetch failed:', err.message);
    });
  }

  async onSettings({ newSettings, changedKeys }) {
    // newSettings, not getSettings(): Homey stores them only after this method resolves.
    if (await rememberEnergyExclude(this, { newSettings, changedKeys })) {
      await this._updateEnergyWarning({ ...this.getSettings(), ...newSettings });
    }
    if (changedKeys.includes('kiosk_url') || changedKeys.includes('poll_interval')) {
      await this._restartPolling(newSettings);
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

  // ─── Homey Energy ─────────────────────────────────────────────────────────
  //
  // Beside a paired SUN2000 this device reports the same solar production to Homey Energy a
  // second time — its class is solarpanel and its meter_power the plant's yield. Homey's own
  // "Exclude from Energy" setting takes it out; the app cannot set that for the user, so it
  // says so: a device warning until the conflict is gone (lib/energy-warning.js).

  async _updateEnergyWarning(settings = this.getSettings()) {
    const names = sun2000Names(this.homey);
    return applyEnergyWarning(this, {
      conflict: names.length > 0,
      message:  this.homey.__('kiosk.energyWarning'),
      settings,
      detail:   `SUN2000 paired as well (${names.join(', ')})`,
    });
  }

  // ─── Polling ──────────────────────────────────────────────────────────────

  // `settings`: the ones being saved, from onSettings. Read from getSetting() the interval was
  // still the old one at that moment, so a new interval took effect only at the next restart of
  // the timer; and the poll right after the save, run at once, used the old URL — the pattern
  // the Modbus drivers had until 1.2.323 (review 2026-10-10).
  _intervalMs(settings = null) {
    const raw = (settings && settings.poll_interval !== undefined) ? settings.poll_interval : this.getSetting('poll_interval');
    let min = parseInt(raw, 10);
    if (!Number.isFinite(min) || min < MIN_INTERVAL_MIN) min = DEFAULT_INTERVAL_MIN;
    return min * 60 * 1000;
  }

  async _startPolling(settings = null) {
    this._timer = this.homey.setInterval(() => {
      this._fetchAndUpdate().catch((err) => {
        this.error('Poll failed:', err.message);
      });
    }, this._intervalMs(settings));
  }

  // A new timer on the new interval, and one poll once the new URL is stored.
  async _restartPolling(newSettings) {
    await this._stopPolling();
    await this._startPolling(newSettings);
    this._fetchAfterSave = this.homey.setTimeout(() => {
      this._fetchAfterSave = null;
      this._fetchAndUpdate().catch((err) => {
        this.error('Fetch after settings change failed:', err.message);
      });
    }, SETTINGS_LAND_MS);
  }

  async _stopPolling() {
    if (this._timer) {
      this.homey.clearInterval(this._timer);
      this._timer = null;
    }
    if (this._fetchAfterSave) {
      this.homey.clearTimeout(this._fetchAfterSave);
      this._fetchAfterSave = null;
    }
  }

  // ─── Data fetch ───────────────────────────────────────────────────────────

  async _fetchAndUpdate() {
    // A SUN2000 paired, or removed, after this device: noticed at the next poll.
    await this._updateEnergyWarning().catch((err) => this.error('Energy warning check failed:', err.message));

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
