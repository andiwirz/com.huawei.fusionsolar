'use strict';

const { Device } = require('homey');

const DEV_TYPE_INVERTER     = 1;
const DEV_TYPE_METER        = 17; // Grid meter (DTSU666)
const DEV_TYPE_POWER_SENSOR = 47; // Power sensor

const REQUIRED_CAPABILITIES = [
  'measure_power',                // AC active power (W) — primary for Homey Energy dashboard
  'measure_power.mppt',           // MPPT DC input power (W)
  'measure_power.active_power',   // AC active power sum (W)
  'measure_temperature.invertor', // internal temperature (°C)
  'meter_power.inv_total',        // inverter total yield (kWh)
  'meter_power.inv_daily',        // inverter daily yield (kWh)
  'measure_power.grid_active_power', // grid active power (W) — Netzwirkleistung
  'meter_power',                     // grid accumulated import energy (kWh) — Netzimport
  'meter_power.exported',            // grid accumulated export energy (kWh) — Netzexport
];

const EXTRA_CAPABILITIES = [
  'measure_voltage.pv1',      // PV1 voltage (V)
  'measure_voltage.pv2',      // PV2 voltage (V)
  'measure_current.pv1',      // PV1 current (A)
  'measure_current.pv2',      // PV2 current (A)
];

// Removed capabilities — stripped from already-paired devices on init
const DEPRECATED_CAPABILITIES = [
  'measure_voltage.ab_u',
  'measure_voltage.bc_u',
  'measure_voltage.ca_u',
  'meter_power.daily',
  'meter_power_monthly',
  'meter_power.mppt_total',
  'huawei_status',
  'measure_voltage.a_u',
  'measure_voltage.b_u',
  'measure_voltage.c_u',
  'measure_current.a_i',
  'measure_current.b_i',
  'measure_current.c_i',
];

const INVERTER_STATE_MAP = {
  0:    'Standby: initializing',
  256:  'Standby: detecting insulation resistance',
  512:  'Standby: detecting irradiation',
  513:  'Standby: grid detecting',
  514:  'Normal: on-grid',
  515:  'Normal: power limited',
  516:  'Normal: self-derating',
  517:  'Shutdown: fault',
  518:  'Shutdown: command',
  519:  'Shutdown: OVGR',
  521:  'Shutdown: reactive power over-limit',
  522:  'Shutdown: output over-current',
  523:  'Shutdown: SOP protection',
  524:  'Shutdown: grid-side SOP',
  527:  'Shutdown: PV under-voltage',
  528:  'Shutdown: PV over-current',
  529:  'Shutdown: event caused',
  533:  'Shutdown: manual',
  534:  'Shutdown: temperature',
  535:  'Shutdown: frequency',
  536:  'Grid scheduling: cosφ-P curve',
  537:  'Grid scheduling: Q-U curve',
  538:  'Spot-check ready',
  539:  'Spot-checking',
  541:  'Inspection: PV string',
  768:  'Low voltage ride-through',
  769:  'High voltage ride-through',
  770:  'Low frequency ride-through',
  771:  'High frequency ride-through',
  776:  'Shutdown: off-grid',
  777:  'Off-grid: initializing',
  778:  'Off-grid: grid-tied',
  1025: 'Reactive compensation',
  1026: 'Idle',
};

class FusionSolarInverterDevice extends Device {

  async onInit() {
    this.log(`Inverter device initialised: ${this.getName()}`);
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

  getDevTypes() { return [DEV_TYPE_INVERTER, DEV_TYPE_METER, DEV_TYPE_POWER_SENSOR]; }

  async onPollData({ stationKpi, kpiByType }) {
    // Station-level KPI
    // stationKpi retained for future use


    // Inverter device KPI
    const maps = kpiByType[DEV_TYPE_INVERTER] || [];
    if (!maps.length) return;

    const num  = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
    const avg  = (key) => {
      const vals = maps.map((m) => num(m?.[key])).filter((v) => v !== null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const sumW = (key) => {
      const vals = maps.map((m) => num(m?.[key])).filter((v) => v !== null);
      return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) * 1000) : null; // kW → W
    };
    const sumKwh = (key) => {
      const vals = maps.map((m) => num(m?.[key])).filter((v) => v !== null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    };

    const activePowerW = sumW('active_power');
    await this._set('measure_power',              activePowerW);  // primary — used by Homey Energy dashboard
    await this._set('measure_power.active_power', activePowerW);
    await this._set('measure_temperature.invertor', avg('temperature'));

    // Add extra capabilities dynamically on first successful fetch
    for (const cap of EXTRA_CAPABILITIES) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(() => {});
    }


    await this._set('measure_voltage.pv1',     avg('pv1_u'));
    await this._set('measure_voltage.pv2',     avg('pv2_u'));
    await this._set('measure_current.pv1',     avg('pv1_i'));
    await this._set('measure_current.pv2',     avg('pv2_i'));
    await this._set('meter_power.inv_daily',   sumKwh('day_cap'));
    await this._set('meter_power.inv_total',   sumKwh('total_cap'));
    await this._set('measure_power.mppt',      sumW('mppt_power'));

    // Grid import/export — from power sensor (type 47) or grid meter (type 17)
    const gridMaps = (kpiByType[DEV_TYPE_POWER_SENSOR] || []).length
      ? kpiByType[DEV_TYPE_POWER_SENSOR]
      : (kpiByType[DEV_TYPE_METER] || []);
    if (gridMaps.length) {
      const sumWGrid   = (key) => {
        const vals = gridMaps.map((m) => { const n = parseFloat(m[key]); return Number.isFinite(n) ? n : null; }).filter((v) => v !== null);
        return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0)) : null;
      };
      const sumKwhGrid = (key) => {
        const vals = gridMaps.map((m) => { const n = parseFloat(m[key]); return Number.isFinite(n) ? n : null; }).filter((v) => v !== null);
        return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
      };
      await this._set('measure_power.grid_active_power', sumWGrid('active_power'));
      await this._set('meter_power',          sumKwhGrid('reverse_active_cap'));
      await this._set('meter_power.exported', sumKwhGrid('active_cap'));
    }

    const powerW = activePowerW ?? 0;
    await this.homey.flow
      .getDeviceTriggerCard('openapi_power_changed')
      .trigger(this, { power: powerW })
      .catch((err) => this.log('Flow trigger openapi_power_changed failed:', err.message));
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

module.exports = FusionSolarInverterDevice;
