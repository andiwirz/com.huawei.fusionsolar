'use strict';

const { Device } = require('homey');

const DEV_TYPE_METER        = 17; // Grid meter (DTSU666)
const DEV_TYPE_POWER_SENSOR = 47; // Power sensor

const REQUIRED_CAPABILITIES = [
  'measure_power',        // grid active power (W): positive = import, negative = export
  'meter_power',          // grid accumulated imported energy (kWh)
  'meter_power.exported', // grid exported energy (kWh)
];

// Added dynamically on first successful power sensor fetch
// Order matches DTSU666 display: voltage A/B/C → current A/B/C → power A/B/C → extras
const EXTRA_CAPABILITIES = [
  'measure_voltage.meter_u',  // Phase A voltage (V)
  'measure_voltage.b_u',      // Phase B voltage (V)
  'measure_voltage.c_u',      // Phase C voltage (V)
  'measure_current.meter_i',  // Phase A current (A)
  'measure_current.b_i',      // Phase B current (A)
  'measure_current.c_i',      // Phase C current (A)
  'measure_power.phase1',     // Active power Phase A (W)
  'measure_power.phase2',     // Active power Phase B (W)
  'measure_power.phase3',     // Active power Phase C (W)
];

// Removed capabilities — stripped from already-paired devices on init
const DEPRECATED_CAPABILITIES = [
  'openapi_meter_status',
  'measure_reactive_power',
  'measure_power_factor',
  'measure_frequency',
  'openapi_meter_run_state',
  'measure_voltage.ab_u',
  'measure_voltage.bc_u',
  'measure_voltage.ca_u',
];

class FusionSolarMeterDevice extends Device {

  async onInit() {
    this.log(`Meter device initialised: ${this.getName()}`);
    this._prevExporting = null;
    await this._ensureCapabilities();
    this._registerConditions();
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

  getDevTypes() { return [DEV_TYPE_METER, DEV_TYPE_POWER_SENSOR]; }

  async onPollData({ kpiByType }) {
    const num    = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
    const avg    = (maps, key) => {
      const vals = maps.map((m) => num(m[key])).filter((v) => v !== null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const sumW   = (maps, key) => {
      const vals = maps.map((m) => num(m[key])).filter((v) => v !== null);
      return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0)) : null;
    };
    const sumKwh = (maps, key) => {
      const vals = maps.map((m) => num(m[key])).filter((v) => v !== null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    };

    // Power sensor (type 47) — preferred, full data set
    const psMaps = kpiByType[DEV_TYPE_POWER_SENSOR] || [];
    if (psMaps.length) {
      // active_power: positive = import, negative = export
      const activePower = sumW(psMaps, 'active_power');
      await this._set('measure_power', activePower);
      this._fireExportImportTriggers(activePower);
      await this._set('meter_power',            sumKwh(psMaps, 'reverse_active_cap'));
      await this._set('meter_power.exported',   sumKwh(psMaps, 'active_cap'));

      // Add extra capabilities dynamically on first successful fetch
      for (const cap of EXTRA_CAPABILITIES) {
        if (!this.hasCapability(cap)) await this.addCapability(cap).catch(() => {});
      }

      await this._set('measure_voltage.meter_u', avg(psMaps, 'meter_u'));
      await this._set('measure_voltage.b_u',     avg(psMaps, 'b_u'));
      await this._set('measure_voltage.c_u',     avg(psMaps, 'c_u'));
      await this._set('measure_current.meter_i', avg(psMaps, 'meter_i'));
      await this._set('measure_current.b_i',     avg(psMaps, 'b_i'));
      await this._set('measure_current.c_i',     avg(psMaps, 'c_i'));
      await this._set('measure_power.phase1',    sumW(psMaps, 'active_power_a'));
      await this._set('measure_power.phase2',    sumW(psMaps, 'active_power_b'));
      await this._set('measure_power.phase3',    sumW(psMaps, 'active_power_c'));

      return;
    }

    // Grid meter (type 17) — fallback: active_power only
    const meterMaps = kpiByType[DEV_TYPE_METER] || [];
    if (meterMaps.length) {
      const activePower = sumW(meterMaps, 'active_power');
      await this._set('measure_power', activePower);
      this._fireExportImportTriggers(activePower);
    }
  }

  _fireExportImportTriggers(power) {
    if (power === null) return;
    const isExporting = power < 0;
    if (this._prevExporting !== null && isExporting !== this._prevExporting) {
      if (isExporting) {
        this.homey.flow.getDeviceTriggerCard('dtsu666_grid_export_started')
          .trigger(this, { power: Math.abs(power) }).catch((err) => this.log('Flow trigger dtsu666_grid_export_started failed:', err.message));
      } else {
        this.homey.flow.getDeviceTriggerCard('dtsu666_grid_import_started')
          .trigger(this, { power }).catch((err) => this.log('Flow trigger dtsu666_grid_import_started failed:', err.message));
      }
    }
    this._prevExporting = isExporting;
  }

  _registerConditions() {
    this.homey.flow
      .getConditionCard('grid_is_exporting')
      .registerRunListener((args) => args.device._prevExporting === true);
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

module.exports = FusionSolarMeterDevice;
