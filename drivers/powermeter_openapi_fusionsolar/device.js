'use strict';

const { Device } = require('homey');
const capabilitySet = require('../../lib/capability-set');

const DEV_TYPE_METER        = 17; // Grid meter (DTSU666)
const DEV_TYPE_POWER_SENSOR = 47; // Power sensor
// EMMA-A02 energy manager. It reports the grid connection point, so it serves this device
// where no separate meter is registered — an EMMA installation has no type 17 or 47 at
// all, which is why the device sat empty: the coordinator was never asked for 23070.
//
// It is NOT a drop-in for the power-sensor mapping above, and the two differences both
// fail silently, so they are handled in their own branch rather than by widening that one:
//
//   Unit      EMMA reports active_power in kW, the power sensor in W. Reusing sumW() would
//             have turned a 1.3 kW export into "1 W". The same split already exists inside
//             the SUN2000 driver, which converts kW→W for the inverter and not for the
//             meter — the API is simply not consistent across device types.
//   Direction EMMA's active_cap is IMPORT and reverse_active_cap is EXPORT. The power
//             sensor branch maps those the other way round. Verified against one owner's
//             FusionSolar lifetime totals (issue #25): active_cap 5298.26 kWh against a
//             portal import of 5.31 MWh, reverse_active_cap 912.84 kWh against an export
//             of 917.61 kWh. The power sensor's opposite mapping has since been measured
//             too, on a plant carrying this device and a Modbus DTSU666 side by side: its
//             reverse_active_cap read 23167.8 kWh against the DTSU666's identical import
//             total. Both mappings are right — the two device types simply disagree, and
//             the sign of active_power follows the same split (see the type 47 branch).
const DEV_TYPE_EMMA         = 23070;

// Same values and the same two words as drivers/dtsu666_modbus/device.js. The capability
// is that driver's too — dtsu666_meter_status — so the status card and the condition card
// work on this device without a second pair, exactly as the export/import triggers already
// do. An unknown code is shown as a code rather than guessed at.
const METER_STATUS_MAP = {
  0: 'Offline',
  1: 'Normal',
};

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
  'measure_frequency',        // Grid frequency (Hz)
  'powermeter_state_string',  // "Export 1234 W" / "Import 1234 W"
];

// Removed capabilities — stripped from already-paired devices on init
const DEPRECATED_CAPABILITIES = [
  'openapi_meter_status',
  'measure_reactive_power',
  'measure_power_factor',
  'openapi_meter_run_state',
  'measure_voltage.ab_u',
  'measure_voltage.bc_u',
  'measure_voltage.ca_u',
];

class FusionSolarMeterDevice extends Device {

  async onInit() {
    this.log(`Meter device initialised: ${this.getName()}`);
    this._prevExporting = null;
    this._prevMeterStatus = null;
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
    } else if (changedKeys.some((k) => ['base_url_region', 'base_url', 'username', 'system_code', 'poll_interval'].includes(k))) {
      // newSettings, not getSetting(): Homey persists only after this resolves, so the
      // coordinator would otherwise copy the OLD values onto the sibling devices.
      this.homey.app.getCoordinator().settingsChanged(this, newSettings);
    }
  }

  async onUninit()  { this.homey.app.getCoordinator().unregister(this); }
  async onDeleted() { this.homey.app.getCoordinator().unregister(this); }

  // ─── Coordinator interface ─────────────────────────────────────────────────

  getDevTypes() { return [DEV_TYPE_METER, DEV_TYPE_POWER_SENSOR, DEV_TYPE_EMMA]; }

  async onPollData({ stationKpi, kpiByType }) {
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
    // Huawei's power sensor and grid meter count feed-in as positive; this device's
    // measure_power counts import as positive. EMMA is not affected — it has its own
    // branch and, as the header note explains, its own convention.
    const negate = (v) => (v === null ? null : -v);

    // Adds a capability the first time a usable value for it arrives, and writes it.
    // Two things fall out of doing it in this order. A plant whose API never sends the
    // field keeps a tile without an empty row — the same reasoning that leaves EMMA
    // without a frequency. And the write cannot be dropped for want of the capability,
    // which is what happens to powermeter_state_string on a device's very first poll:
    // it is written above and only created by the EXTRA_CAPABILITIES loop below it.
    const setOptional = async (cap, value) => {
      if (value === null || value === undefined) return;
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(() => {});
      await this._set(cap, value);
    };

    // House consumption today, from the station KPI rather than from any single meter.
    // It is the one figure a cloud-only plant cannot derive: with no local inverter the
    // energy-balance widget has to compute the house from self-consumption plus import,
    // and Huawei has already done that sum. Zero is a real reading here — it is what the
    // counter says just after midnight — so only null is treated as absent.
    await setOptional('meter_power.consumption_today', stationKpi?.dayUseEnergy ?? null);

    // Meter status. The Modbus meter has shown this since it was written; here the field
    // arrived in every response and nothing read it. The device had a capability for it
    // once (openapi_meter_status, still stripped by DEPRECATED_CAPABILITIES) — this uses
    // the Modbus one instead, so the two meters answer the same flow cards.
    const meterStatusRaw = num((kpiByType[DEV_TYPE_POWER_SENSOR] || kpiByType[DEV_TYPE_METER] || [])[0]?.meter_status);
    if (meterStatusRaw !== null) {
      const label = METER_STATUS_MAP[meterStatusRaw] ?? `Status ${meterStatusRaw}`;
      await setOptional('dtsu666_meter_status', label);
      if (this._prevMeterStatus !== null && label !== this._prevMeterStatus) {
        this.homey.flow.getDeviceTriggerCard('dtsu666_meter_status_changed')
          .trigger(this, { status: label }, { status: label })
          .catch((err) => this.log('Flow trigger dtsu666_meter_status_changed failed:', err.message));
        if (this.getSetting('enable_timeline_notifications') !== false) {
          this.homey.notifications.createNotification({ excerpt: `${this.getName()}: ${label}` })
            .catch((err) => this.log('Timeline notification failed:', err.message));
        }
      }
      this._prevMeterStatus = label;
    }

    // EMMA (type 23070) — checked first: where one exists it IS the grid connection point,
    // and such an installation carries no type 17 or 47 to fall back to anyway.
    const emmaMaps = kpiByType[DEV_TYPE_EMMA] || [];
    if (emmaMaps.length) {
      const sumKw = (maps, key) => {
        const vals = maps.map((m) => num(m[key])).filter((v) => v !== null);
        return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) * 1000) : null; // kW → W
      };
      // Sign matches this device's convention already: positive = import, negative = export.
      const activePower = sumKw(emmaMaps, 'active_power');
      await this._set('measure_power', activePower);
      if (activePower !== null) {
        const gridWatts = Math.round(Math.abs(activePower));
        const label = activePower < 0 ? 'Export' : 'Import';
        await this._set('powermeter_state_string', gridWatts === 0 ? '0 W' : `${gridWatts} W ${label}`);
      }
      this._fireExportImportTriggers(activePower);
      await this._set('meter_power',          sumKwh(emmaMaps, 'active_cap'));
      await this._set('meter_power.exported', sumKwh(emmaMaps, 'reverse_active_cap'));

      // Everything the power sensor offers except the frequency, which EMMA does not
      // report — adding that capability would leave a permanently empty row on the tile.
      for (const cap of EXTRA_CAPABILITIES) {
        if (cap === 'measure_frequency') continue;
        if (!this.hasCapability(cap)) await this.addCapability(cap).catch(() => {});
      }

      // Phase A is a_u / a_i here; the power sensor calls the same two meter_u / meter_i.
      await this._set('measure_voltage.meter_u', avg(emmaMaps, 'a_u'));
      await this._set('measure_voltage.b_u',     avg(emmaMaps, 'b_u'));
      await this._set('measure_voltage.c_u',     avg(emmaMaps, 'c_u'));
      await this._set('measure_current.meter_i', avg(emmaMaps, 'a_i'));
      await this._set('measure_current.b_i',     avg(emmaMaps, 'b_i'));
      await this._set('measure_current.c_i',     avg(emmaMaps, 'c_i'));
      await this._set('measure_power.phase1',    sumKw(emmaMaps, 'active_power_a'));
      await this._set('measure_power.phase2',    sumKw(emmaMaps, 'active_power_b'));
      await this._set('measure_power.phase3',    sumKw(emmaMaps, 'active_power_c'));

      return;
    }

    // Power sensor (type 47) — preferred, full data set
    const psMaps = kpiByType[DEV_TYPE_POWER_SENSOR] || [];
    if (psMaps.length) {
      // Negated. The comment here used to claim active_power was positive on import; the
      // two lines below already said otherwise, mapping active_cap to the EXPORT total.
      //
      // Measured 2026-09-06 on a plant carrying this device and a Modbus DTSU666 at once:
      // within the same minute the DTSU666 read -4631 W ("Export") and this device +4650 W
      // ("Import"), while the SDongle put 7031 W of PV against 2402 W of house load — the
      // house was exporting. The cumulative counters agreed to the decimal (23167.8 kWh of
      // import on both), which is what pins the fault to the sign alone rather than to the
      // import/export assignment.
      //
      // Left uncorrected it inverted the grid figure for every cloud-only plant: Homey
      // Energy reads this device's measure_power as the whole home's draw (energy
      // .cumulative is true), the widgets derive house load as pv + grid, and the EMS reads
      // surplus as max(0, -grid) — so an exporting house showed no surplus at all.
      const activePower = negate(sumW(psMaps, 'active_power'));
      await this._set('measure_power', activePower);
      if (activePower !== null) {
        const gridWatts = Math.round(Math.abs(activePower));
        const label = activePower < 0 ? 'Export' : 'Import';
        await this._set('powermeter_state_string', gridWatts === 0 ? '0 W' : `${gridWatts} W ${label}`);
      }
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
      await this._set('measure_power.phase1',    negate(sumW(psMaps, 'active_power_a')));
      await this._set('measure_power.phase2',    negate(sumW(psMaps, 'active_power_b')));
      await this._set('measure_power.phase3',    negate(sumW(psMaps, 'active_power_c')));
      await this._set('measure_frequency',       avg(psMaps, 'grid_frequency'));

      return;
    }

    // Grid meter (type 17) — fallback: active_power only
    const meterMaps = kpiByType[DEV_TYPE_METER] || [];
    if (meterMaps.length) {
      // Negated on the same grounds as type 47, though nobody here owns a type 17 to
      // measure: the SUN2000 driver already reads both types through one mapping for the
      // energy counters, so a type 17 that disagreed about direction would have been
      // reporting its lifetime totals backwards all along.
      const activePower = negate(sumW(meterMaps, 'active_power'));
      await this._set('measure_power', activePower);
      if (activePower !== null) {
        const gridWatts = Math.round(Math.abs(activePower));
        const label = activePower < 0 ? 'Export' : 'Import';
        await this._set('powermeter_state_string', gridWatts === 0 ? '0 W' : `${gridWatts} W ${label}`);
      }
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

Object.assign(FusionSolarMeterDevice.prototype, capabilitySet);

module.exports = FusionSolarMeterDevice;
