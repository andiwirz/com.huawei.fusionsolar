'use strict';

const { Device } = require('homey');
const capabilitySet = require('../../lib/capability-set');

const DEV_TYPE_INVERTER             = 1;
const DEV_TYPE_RESIDENTIAL_INVERTER = 38;
const DEV_TYPE_METER                = 17; // Grid meter (DTSU666)
const DEV_TYPE_POWER_SENSOR         = 47; // Power sensor
const DEV_TYPE_EMMA                 = 23070; // EMMA-A02 energy manager

// How the PV generation meter moves — see _writePvMeter.
const PV_PRESENT_W              = 10;               // above this the panels are producing
const PV_GATE_MAX_GAP_MS        = 60 * 60 * 1000;   // longer since the last look is an outage, not a night
const PV_MAX_PLAUSIBLE_KW       = 1000;             // faster than this is a counter swap, not a sunny day
// The plausibility window never shrinks below one poll interval. The cloud updates its
// counter on its own schedule, so a step can arrive on a poll seconds after the last one
// and still be minutes of real production; judged against seconds it would read as a swap.
const PV_BOUND_MIN_WINDOW_MS    = 5 * 60 * 1000;
const PV_COUNTER_STALL_WARN_MS  = 3 * 60 * 60 * 1000; // daylight with a counter that never moves

const REQUIRED_CAPABILITIES = [
  'measure_power',                // PV generation (W) — the solar figure for Homey Energy
  'measure_power.mppt',           // MPPT DC input power (W)
  'measure_power.active_power',   // AC active power sum (W)
  'measure_temperature.invertor', // internal temperature (°C)
  'meter_power.inv_total',        // inverter total yield (kWh)
  'meter_power.inv_daily',        // inverter daily yield (kWh)
  'meter_power.pv_total',         // PV generation meter (kWh) — Homey Energy reads this; see _writePvMeter
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

    // The lifetime figure that daily one is a slice of, from the same summary, so today and
    // total finally cover the same period. They did not before: the yield widget paired a
    // station daily figure with the inverter's own lifetime counter. On the plant in #28
    // those read 7.67 MWh and 35.1 MWh — a plant record created in July 2025 against an
    // inverter running since 2022, confirmed by its owner against the yearly breakdown
    // (2.44 + 5.23 = 7.67). Both counters were right; only standing them side by side was
    // wrong, because nothing relates a lifetime to a day drawn from a different lifetime.
    //
    // This is also what energy.meterPowerExportedCapability points at, which is how Homey's
    // own Energy page stops showing the AC yield as solar generation. sun2000_emma_modbus
    // has pointed at its meter_power.pv_total for the same reason; the two drivers simply
    // disagreed until now.
    //
    // meter_power.inv_total keeps the inverter's own lifetime yield, under its own name.
    // It is the genuine figure for the hardware and the only one that survives a plant
    // record being recreated — which is exactly what happened on that plant in 2025.
    //
    // Since 1.2.262 the station total only seeds that meter; what moves it afterwards is the
    // inverter's own DC counter. Issue #34 showed in five nights of field log why the station
    // total cannot drive it — see _writePvMeter.

    // Inverter device KPI (type 1 = string inverter, type 38 = residential inverter)
    const maps = [
      ...(kpiByType[DEV_TYPE_INVERTER] || []),
      ...(kpiByType[DEV_TYPE_RESIDENTIAL_INVERTER] || []),
    ];

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

    // Before the early return: a station that reports no inverter device still has a
    // station total, and the meter falls back to it.
    const mpptTotal = sumKwh('mppt_total_cap');
    await this._writePvMeter({
      stationTotal: stationKpi?.totalEnergy ?? null,
      // Zero is not a lifetime DC counter, it is a field the inverter does not fill — and
      // treating it as one would freeze Homey's solar figure for good.
      mpptTotal:    mpptTotal !== null && mpptTotal > 0 ? mpptTotal : null,
      mpptPowerW:   sumW('mppt_power'),
    });

    if (!maps.length) return;

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

  /**
   * meter_power.pv_total — the generation meter Homey Energy reads.
   *
   * Until 1.2.262 this was the station's lifetime total, and the field log for issue #34
   * showed in five nights why that cannot work. FusionSolar's production figure is a balance,
   * not a meter — inverter AC yield + battery charge − battery discharge; the fixture in
   * test/openapi-pv-daily.test.js closes to 0.01 kWh. So it sinks every evening as the
   * battery discharges, dips by a whole day at the nightly rollover, and is re-settled after
   * midnight, sometimes above the evening figure. Homey books every rise as generation and
   * ignores every fall. A high-water guard hides the falls, not a false rise: 1.73 kWh at
   * 00:04 on 3 October, and its re-anchor once landed inside the dip and passed on 14.19.
   *
   * So the meter now advances with the inverter's own DC counter, mppt_total_cap: energy the
   * MPPT trackers actually harvested, the battery's share included. It is anchored at the
   * value Homey last saw, so changing what drives it is not itself a step Homey could book.
   *
   * Three guards, because "a hardware counter does not move in the dark" is physics, not yet
   * something measured on every plant:
   *   · it only counts while the panels are producing — movement in the dark is absorbed and
   *     logged, which also settles, plant by plant, whether it ever happens;
   *   · it never counts backwards, and re-bases instead;
   *   · a step faster than any plant can produce is a counter swap, and re-bases too.
   * After an outage — more than an hour since the last look — the darkness gate is lifted:
   * it is a lifetime counter, so what it gained meanwhile is real, counted late rather than
   * lost.
   *
   * An inverter that has never reported mppt_total_cap keeps the 1.2.261 behaviour: the
   * station total through _setCumulative.
   */
  async _writePvMeter({ stationTotal, mpptTotal, mpptPowerW, now = Date.now() }) {
    const CAP  = 'meter_power.pv_total';
    const num  = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
    const save = (k, v) => this.setStoreValue(k, v).catch(() => {});
    const r2   = (v) => Math.round(v * 100) / 100;

    // Nothing from either source and nothing remembered yet: nothing to write, and no reason
    // to open the store for it. A plant whose summary lacks a lifetime figure and whose
    // inverter lacks the DC counter is left exactly as 1.2.261 left it.
    if (stationTotal == null && mpptTotal == null && !this._pvMeter) return undefined;

    if (!this._pvMeter) {
      this._pvMeter = {
        value:  num(this.getStoreValue('pvmeter.value')),
        prev:   num(this.getStoreValue('pvmeter.mppt')),
        prevAt: num(this.getStoreValue('pvmeter.mppt_at')),
        source: this.getStoreValue('pvmeter.source') || null,
        // Memory only, deliberately: after a restart nobody knows what happened meanwhile,
        // so the next look counts as an outage rather than as another minute of the night.
        lastSampleAt: null,
        powerSeen:    false,
        stallMs:      0,
        stallWarned:  false,
      };
    }
    const st = this._pvMeter;

    const pvNow     = mpptPowerW !== null && mpptPowerW !== undefined && mpptPowerW > PV_PRESENT_W;
    // This poll or the one before: at dusk the counter's last step lands on a poll that
    // already reads 0 W, and that step is still the day's production.
    const pvPresent = pvNow || st.powerSeen;
    const gapMs     = st.lastSampleAt === null ? Infinity : now - st.lastSampleAt;
    st.powerSeen    = pvNow;
    st.lastSampleAt = now;

    if (mpptTotal === null || mpptTotal === undefined) {
      // Once the DC counter has been seen, a poll without it is just a missed poll: it is a
      // lifetime total and catches up next time. Falling back here would add the station's
      // movement on top of the counter's, and count the same sunshine twice.
      if (st.source === 'mppt') return;
      await this._setCumulative(CAP, stationTotal, now);
      const shown = num(this.getCapabilityValue(CAP));
      if (shown !== null && shown !== st.value) {
        st.value = shown;
        await save('pvmeter.value', shown);
      }
      return;
    }

    if (st.source !== 'mppt') {
      if (st.value === null) {
        st.value = num(this.getStoreValue(`cumulative_high.${CAP}`))
                ?? num(this.getCapabilityValue(CAP))
                ?? num(stationTotal)
                ?? mpptTotal;
      }
      st.source = 'mppt';
      st.prev   = mpptTotal;
      st.prevAt = now;
      await save('pvmeter.source', 'mppt');
      await save('pvmeter.value', st.value);
      await save('pvmeter.mppt', mpptTotal);
      await save('pvmeter.mppt_at', now);
      this.log(`${CAP}: now advancing with the inverter's own PV counter (mppt_total_cap ${mpptTotal}), `
        + `continuing from ${st.value}`);
      return this._setCumulative(CAP, r2(st.value), now);
    }

    if (mpptTotal !== st.prev) {
      const d   = mpptTotal - st.prev;
      const hrs = st.prevAt === null
        ? Infinity
        : Math.max(now - st.prevAt, PV_BOUND_MIN_WINDOW_MS) / 3_600_000;
      const sd  = `${d >= 0 ? '+' : ''}${d.toFixed(2)}`;
      if (d < 0) {
        this.log(`${CAP}: inverter PV counter went backwards (${st.prev} → ${mpptTotal}) — re-basing, nothing counted`);
      } else if (d > hrs * PV_MAX_PLAUSIBLE_KW) {
        this.log(`${CAP}: inverter PV counter jumped ${sd} kWh in ${hrs.toFixed(2)} h — more than any plant `
          + `produces, so a counter swap; re-basing, nothing counted`);
      } else if (gapMs <= PV_GATE_MAX_GAP_MS && !pvPresent) {
        this.log(`${CAP}: inverter PV counter moved ${sd} kWh while the panels were dark — not counted as generation`);
      } else {
        st.value += d;
        await save('pvmeter.value', st.value);
      }
      st.prev   = mpptTotal;
      st.prevAt = now;
      st.stallMs = 0;
      await save('pvmeter.mppt', mpptTotal);
      await save('pvmeter.mppt_at', now);
    } else if (pvPresent && Number.isFinite(gapMs)) {
      // Daylight and a counter that does not move means Homey Energy is shown no solar at
      // all. Said once, loudly, rather than guessed around: switching sources automatically
      // would risk counting the same sunshine twice.
      st.stallMs += Math.min(gapMs, PV_GATE_MAX_GAP_MS);
      if (!st.stallWarned && st.stallMs >= PV_COUNTER_STALL_WARN_MS) {
        st.stallWarned = true;
        this.log(`${CAP}: the inverter reports PV power but its PV counter (mppt_total_cap ${mpptTotal}) `
          + `has not moved in ${Math.round(st.stallMs / 3_600_000)} h of daylight — Homey Energy will show no `
          + `solar until it does. Please report this with a Log ID.`);
      }
    }

    return this._setCumulative(CAP, r2(st.value), now);
  }

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
