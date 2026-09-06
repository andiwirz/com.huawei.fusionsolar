'use strict';

const { Device } = require('homey');
const capabilitySet = require('../../lib/capability-set');

const DEV_TYPE_INVERTER             = 1;
const DEV_TYPE_RESIDENTIAL_INVERTER = 38;
const DEV_TYPE_METER                = 17; // Grid meter (DTSU666)
const DEV_TYPE_POWER_SENSOR         = 47; // Power sensor
const DEV_TYPE_EMMA                 = 23070; // EMMA-A02 energy manager

const REQUIRED_CAPABILITIES = [
  'measure_power',                // PV generation (W) — the solar figure for Homey Energy
  'measure_power.mppt',           // MPPT DC input power (W)
  'measure_power.active_power',   // AC active power sum (W)
  'measure_temperature.invertor', // internal temperature (°C)
  'meter_power.inv_total',        // inverter total yield (kWh)
  'meter_power.inv_daily',        // inverter daily yield (kWh)
  'measure_power.grid_active_power', // grid active power (W) — Netzwirkleistung
  // Named exactly as sun2000_modbus names them, so the two inverters are read the same way
  // everywhere. See DEPRECATED_CAPABILITIES for what they used to be called and why.
  'meter_power.grid_import',         // grid accumulated import energy (kWh) — Netzimport
  'meter_power.grid_export',         // grid accumulated export energy (kWh) — Netzexport
];

const EXTRA_CAPABILITIES = [
  'measure_voltage.pv1',             // PV1 voltage (V)
  'measure_voltage.pv2',             // PV2 voltage (V)
  'measure_current.pv1',             // PV1 current (A)
  'measure_current.pv2',             // PV2 current (A)
  'huawei_status',                   // inverter state string
  'measure_frequency',               // grid frequency (Hz)
  'openapi_inverter_efficiency',     // inverter efficiency (%)
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
  'openapi_active_power_control',
  // Renamed to meter_power.grid_import / meter_power.grid_export in 1.2.212. This driver's
  // class is solarpanel, and on a solarpanel Homey reads plain meter_power as generated
  // energy — while here it held the grid IMPORT total: tens of MWh of household
  // consumption filed under the name reserved for yield. Only energy
  // .meterPowerExportedCapability pointing at meter_power.inv_total kept it out of the
  // Energy figures, one manifest line standing between a counter and the wrong meaning.
  'meter_power',
  'meter_power.exported',
];

// OpenAPI inverter_state values (different from Modbus register 32089!)
const INVERTER_STATE_MAP = {
  0:     'Standby: initializing',
  1:     'Standby: insulation resistance detecting',
  2:     'Standby: irradiation detecting',
  3:     'Standby: grid detecting',
  256:   'Start',
  512:   'Grid-connected',
  513:   'Grid-connected: power limited',
  514:   'Grid-connected: self-derating',
  768:   'Shutdown: on fault',
  769:   'Shutdown: on command',
  770:   'Shutdown: OVGR',
  771:   'Shutdown: communication interrupted',
  772:   'Shutdown: power limited',
  773:   'Shutdown: manual startup required',
  774:   'Shutdown: DC switch disconnected',
  1025:  'Grid scheduling: cosψ-P curve',
  1026:  'Grid scheduling: Q-U curve',
  1280:  'Ready for terminal test',
  1281:  'Terminal testing',
  1536:  'Inspection in progress',
  1792:  'AFCI self-check',
  2048:  'I-V scanning',
  2304:  'DC input detection',
  40960: 'Standby: no irradiation',
  45056: 'Communication interrupted',
  49152: 'Loading',
};

class FusionSolarInverterDevice extends Device {

  async onInit() {
    this.log(`Inverter device initialised: ${this.getName()}`);
    this._powerHistory = [];
    this._prevDeviceStatus = null;
    await this._ensureCapabilities();
    this._registerPowerThresholdListeners();
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

  getDevTypes() {
    return [DEV_TYPE_INVERTER, DEV_TYPE_RESIDENTIAL_INVERTER,
      DEV_TYPE_METER, DEV_TYPE_POWER_SENSOR, DEV_TYPE_EMMA];
  }

  async onPollData({ stationKpi, kpiByType }) {
    // Today's PV production, from the station summary rather than from the inverter.
    //
    // The inverter's own day_cap is its AC output, and on a hybrid the battery hangs on the
    // DC bus in front of that — so everything charged into the battery never crosses the
    // meter day_cap counts and is missing from it. Reported in issue #28: FusionSolar said
    // 2.03 kWh produced while day_cap said 1.43 kWh, at a moment when 1.94 kW of 2.45 kW of
    // PV was going into the battery.
    //
    // A capture from a plant that runs Modbus and cloud side by side settles which figure
    // is which, to a hundredth of a kWh:
    //
    //   day_cap 24.79 + charge_cap 13.12 - discharge_cap 4.53 = 33.38   day_power 33.37
    //
    // and the same capture's house total falls out of it:
    //
    //   33.37 - 8.59 (battery, net) - 4.53 (exported) = 20.25           day_use_energy 20.30
    //
    // So day_power is the generation and day_cap is what the inverter delivered. This is
    // read before the inverter block below, which returns early when a station reports no
    // inverter device: the station figure does not depend on one.
    //
    // Zero is a real reading here — it is what the counter says at midnight and all night —
    // so only null counts as absent.
    await this._setOptional('meter_power.pv_daily', stationKpi?.dailyEnergy ?? null);


    // Inverter device KPI (type 1 = string inverter, type 38 = residential inverter)
    const maps = [
      ...(kpiByType[DEV_TYPE_INVERTER] || []),
      ...(kpiByType[DEV_TYPE_RESIDENTIAL_INVERTER] || []),
    ];
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
    const mpptPowerW   = sumW('mppt_power');

    // measure_power is the solar figure, because this driver's class is solarpanel and that
    // is the capability Homey Energy files under "Solar panels". So it has to be generation
    // and nothing else.
    //
    // It used to be active_power — the inverter's AC output. On a hybrid SUN2000 that is
    // whatever the inverter is putting out, from whichever side it came. Reported in #25
    // with two captures hours after sunset: SUN2000 +2.35 kW against LUNA2000 -2.35 kW, and
    // again +587 W against -587 W, with PV at zero both times. Homey duly filed the battery
    // discharge under solar. The household total still came out right, because the two
    // cancelled, which is why this could sit there unnoticed.
    //
    // mppt_power is the DC input from the strings: the generation itself, before the
    // inverter turns it into AC and before anything from the battery joins it. It reads a
    // couple of per cent above the AC figure for exactly that reason.
    //
    // The fallback is deliberate rather than lazy. An inverter that does not report
    // mppt_power keeps what it has always shown instead of losing its power reading, and on
    // an inverter with no battery the AC output IS the generation, so nothing is misfiled.
    // The AC figure has not gone anywhere either — it is measure_power.active_power, and
    // that is still what the power-changed flow card reports, so existing flows keep
    // meaning what they meant.
    const solarPowerW = mpptPowerW ?? activePowerW;
    if (mpptPowerW === null && activePowerW !== null && !this._mpptFallbackLogged) {
      this._mpptFallbackLogged = true;
      this.log('mppt_power not reported by this inverter — measure_power falls back to '
        + 'active_power, which on a hybrid inverter can include battery discharge');
    }
    await this._set('measure_power',              solarPowerW);   // solar — used by Homey Energy
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
    await this._set('measure_power.mppt',      mpptPowerW);
    await this._set('openapi_inverter_efficiency', avg('efficiency'));
    await this._set('measure_frequency',       avg('elec_freq'));

    const stateVal = maps[0]?.inverter_state;
    if (stateVal !== undefined && stateVal !== null) {
      const stateNum = parseInt(stateVal, 10);
      const label = INVERTER_STATE_MAP[stateNum] ?? `State ${stateNum}`;
      await this._set('huawei_status', label);
      // Announced the way sun2000_modbus announces it. The first reading after a restart
      // is not a change, so _prevDeviceStatus starting at null keeps the timeline quiet
      // until the inverter actually does something different.
      if (this._prevDeviceStatus !== null && label !== this._prevDeviceStatus
          && this.getSetting('enable_timeline_notifications') !== false) {
        this.homey.notifications.createNotification({ excerpt: `${this.getName()}: ${label}` })
          .catch((err) => this.log('Timeline notification failed:', err.message));
      }
      this._prevDeviceStatus = label;
    }

    // Grid import/export, mirrored from whichever device measures the grid connection.
    //
    // EMMA (23070) was missing from getDevTypes altogether, so on a plant where an EMMA is
    // the connection point the coordinator never fetched that type for this device and all
    // three capabilities stayed null for good. Reported in #28 with a Developer Tools
    // capture that showed it plainly: the meter device full of readings, the inverter's
    // three grid rows empty. Nothing filled in behind them either — an EMMA plant carries
    // no type 17 or 47 to fall back on.
    //
    // It gets its own branch rather than being folded into the one below, because it
    // differs in all three ways that matter here, and each of the three fails silently:
    //
    //   Unit       EMMA reports active_power in kW, the power sensor in watts.
    //   Direction  EMMA's active_cap is the IMPORT total; the power sensor's is the export.
    //   Sign       EMMA already counts import as positive; the other two count feed-in as
    //              positive and are negated.
    //
    // drivers/powermeter_openapi_fusionsolar/device.js carries the measurement behind each
    // of those. This is deliberately the same split, made the same way — see the test that
    // holds the two drivers to the same answer.
    const gridSum = (source, key, scale) => {
      const vals = source
        .map((m) => { const n = parseFloat(m[key]); return Number.isFinite(n) ? n : null; })
        .filter((v) => v !== null);
      if (!vals.length) return null;
      const sum = vals.reduce((a, b) => a + b, 0);
      return scale === undefined ? sum : Math.round(sum * scale);
    };

    const emmaMaps = kpiByType[DEV_TYPE_EMMA] || [];
    if (emmaMaps.length) {
      await this._set('measure_power.grid_active_power', gridSum(emmaMaps, 'active_power', 1000));
      await this._set('meter_power.grid_import',  gridSum(emmaMaps, 'active_cap'));
      await this._set('meter_power.grid_export',  gridSum(emmaMaps, 'reverse_active_cap'));
    } else {
      const gridMaps = (kpiByType[DEV_TYPE_POWER_SENSOR] || []).length
        ? kpiByType[DEV_TYPE_POWER_SENSOR]
        : (kpiByType[DEV_TYPE_METER] || []);
      if (gridMaps.length) {
        const watts = gridSum(gridMaps, 'active_power', 1);
        await this._set('measure_power.grid_active_power', watts === null ? null : -watts);
        await this._set('meter_power.grid_import',  gridSum(gridMaps, 'reverse_active_cap'));
        await this._set('meter_power.grid_export',  gridSum(gridMaps, 'active_cap'));
      }
    }

    const powerW = activePowerW ?? 0;
    this._trackPower(powerW);
    await this.homey.flow
      .getDeviceTriggerCard('openapi_power_changed')
      .trigger(this, { power: powerW })
      .catch((err) => this.log('Flow trigger openapi_power_changed failed:', err.message));
  }

  // ─── Power threshold triggers ──────────────────────────────────────────────

  _registerPowerThresholdListeners() {
    const makeListener = (above) => (args) => {
      const durationMs = (args.duration || 1) * 60000;
      const cutoff     = Date.now() - durationMs;
      const history    = args.device._powerHistory || [];
      const recent     = history.filter((e) => e.t >= cutoff);
      const hasOlder   = history.some((e) => e.t < cutoff);
      if (!hasOlder || recent.length === 0) return false;
      return above ? recent.every((e) => e.p > args.power)
                   : recent.every((e) => e.p < args.power);
    };
    this.homey.flow.getConditionCard('sun2000_power_above_for').registerRunListener(makeListener(true));
    this.homey.flow.getConditionCard('sun2000_power_below_for').registerRunListener(makeListener(false));
  }

  _trackPower(power) {
    const now = Date.now();
    this._powerHistory.push({ t: now, p: power });
    const cutoff = now - 7200000; // keep 2 hours
    this._powerHistory = this._powerHistory.filter((e) => e.t >= cutoff);
  }

  // ─── Capabilities ──────────────────────────────────────────────────────────

  // Adds a capability the first time a usable value arrives, then writes it. A plant whose
  // API never sends the field keeps a tile without a permanently empty row.
  async _setOptional(capability, value) {
    if (value === null || value === undefined) return;
    if (!this.hasCapability(capability)) await this.addCapability(capability).catch(() => {});
    await this._set(capability, value);
  }

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

Object.assign(FusionSolarInverterDevice.prototype, capabilitySet);

module.exports = FusionSolarInverterDevice;
