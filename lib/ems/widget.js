'use strict';

// Backend support for the ems-device and ems-battery dashboard widgets. Mixed
// into EmsDevice.prototype; `this` is the device instance. Keeps all
// widget-facing read/write logic in one place, separate from the tick loop
// itself (widgets/ems-device/api.js and widgets/ems-battery/api.js call these).

const CHARGE_MODES = ['solar', 'solar_offpeak', 'solar_lowtariff', 'solar_price', 'always'];

// How long a resolved Homey device name is reused before being looked up again.
// Names only change when the user renames the device, so a long TTL is safe; the
// point is that getEmsControllableStatus is polled by every open widget and used to
// re-fetch the WHOLE device object over HTTP on every single poll just for this string.
const WIDGET_NAME_TTL_MS = 10 * 60_000;

// kind → { cfgKey: where the device lives in ems_config, stateKey: this[stateKey]
// is the Map tracking its on/off bookkeeping (see simpleDevices.js) }
const SIMPLE_KIND = {
  heat_pump:    { cfgKey: 'heat_pump_devices',    stateKey: '_heatPumpStates' },
  boiler:       { cfgKey: 'boiler_devices',       stateKey: '_boilerStates' },
  pool:         { cfgKey: 'pool_devices',         stateKey: '_poolStates' },
  dehumidifier: { cfgKey: 'dehumidifier_devices', stateKey: '_dehumidifierStates' },
  aircon:       { cfgKey: 'aircon_devices',       stateKey: '_airconStates' },
};

module.exports = {

  // ── Daily energy/runtime tracking for simple devices (heat pump/boiler/pool/
  // dehumidifier) — these don't have a "plug in → unplug" session like EV
  // chargers, so we accumulate per calendar day instead (reset at local
  // midnight), mirroring how evcc resets heating-device sessions daily.
  // Persisted to the device store (see _restoreSimpleDailyStats /
  // _saveSimpleDailyStats) so an app restart doesn't lose today's count —
  // saved periodically (SLOW_REFRESH_MS, ~60s) rather than every tick, to
  // keep the write frequency reasonable. Called once per device-type per
  // tick from device.js _tickBody, right next to _trackChargeSession.
  _trackSimpleDeviceDaily(devices, stateMap, dtMs) {
    if (!this._simpleDailyStats) this._simpleDailyStats = {};
    const dateStr = this._localDateStr();
    for (const d of devices) {
      const st = stateMap.get(d.id);
      if (!st) continue;
      let rec = this._simpleDailyStats[d.id];
      if (!rec || rec.date !== dateStr) rec = this._simpleDailyStats[d.id] = { date: dateStr, kwh: 0, runtimeMs: 0 };
      // These counters describe the DEVICE, not the EMS's decision — the opposite of the
      // mode, which names only what the EMS steers. So a device outside EMS control still
      // counts its hours, but from the live reading: its state entry stopped being
      // maintained when the EMS stopped steering it (see _simpleActive), and counting a
      // frozen `true` books a running device around the clock. A device whose state cannot
      // be read at all (actualOn null — no power capability, or the plug went silent)
      // counts as not running: an unknown is not a measurement.
      const running = d.enabled === false ? d.actualOn === true : st.isOn;
      if (running) {
        rec.runtimeMs += dtMs;
        if (d.powerW != null && d.powerW > 0) rec.kwh += (d.powerW / 1000) * (dtMs / 3600_000);
      }
    }
  },

  // Today's accumulated stats for one simple device (0/0 if none yet today).
  _simpleDeviceDaily(id) {
    const rec = (this._simpleDailyStats || {})[id];
    if (!rec || rec.date !== this._localDateStr()) return { kwh: 0, runtimeMs: 0 };
    return { kwh: Math.round(rec.kwh * 100) / 100, runtimeMs: rec.runtimeMs };
  },

  // Called once from onInit, before the tick loop starts.
  async _restoreSimpleDailyStats() {
    this._simpleDailyStats = {};
    try {
      const stored = await this.getStoreValue('simpleDailyStats');
      if (stored && typeof stored === 'object') this._simpleDailyStats = stored;
    } catch (e) { /* ignore — starts today's counters at 0 */ }
  },

  // Fire-and-forget persist — called from the slow-tick block in _tickBody
  // (~every 60s) and once more on a clean shutdown (onUninit/onDeleted), so
  // the loss window on a restart is at most one slow-tick interval.
  _saveSimpleDailyStats() {
    this.setStoreValue('simpleDailyStats', this._simpleDailyStats || {}).catch(() => {});
  },

  // Local (Homey timezone) calendar date as "YYYY-MM-DD" — used to detect the
  // midnight rollover for daily stats. Node itself always runs UTC on Homey Pro.
  _localDateStr() {
    const tz = this.homey.clock?.getTimezone?.() || 'UTC';
    if (!this._dailyFmt || this._dailyFmtTz !== tz) {
      this._dailyFmt   = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
      this._dailyFmtTz = tz;
    }
    return this._dailyFmt.format(new Date());
  },

  // ── Device listing (widget settings autocomplete picker) ────────────────
  // Every EV charger and every simple device (heat pump/boiler/pool/dehumidifier)
  // configured on this EMS, with its real Homey device name resolved via the
  // local API where possible (config only stores the raw device id).
  async getEmsControllableDevices() {
    const cfg = this._getConfig();
    let names = {};
    try {
      const all = await this._api.getDevices();
      if (!this._widgetNameCache) this._widgetNameCache = new Map();
      for (const d of Object.values(all || {})) {
        if (!d || !d.id) continue;
        names[d.id] = d.name;
        // Warm the per-device cache used by getEmsControllableStatus — this listing
        // already has every name, so its pollers never need their own lookup.
        if (d.name) this._widgetNameCache.set(d.id, { name: d.name, at: Date.now() });
      }
    } catch (e) { /* homey_api_key not set / API unreachable — fall back to short id below */ }
    const nameFor = (id) => names[id] || `${String(id).slice(0, 8)}…`;

    const out = [];
    for (const c of (cfg.chargers || []))
      if (c.id) out.push({ id: c.id, kind: 'charger', name: nameFor(c.id) });
    for (const [kind, { cfgKey }] of Object.entries(SIMPLE_KIND))
      for (const c of (cfg[cfgKey] || []))
        if (c.id) out.push({ id: c.id, kind, name: nameFor(c.id) });
    return out;
  },

  // Finds which list (and raw config entry) a controllable-device id belongs
  // to. Returns null if the id is no longer configured (e.g. removed since the
  // widget was set up).
  _findControllable(cfg, id) {
    const chg = (cfg.chargers || []).find((c) => c.id === id);
    if (chg) return { kind: 'charger', entry: chg };
    for (const [kind, { cfgKey }] of Object.entries(SIMPLE_KIND)) {
      const entry = (cfg[cfgKey] || []).find((c) => c.id === id);
      if (entry) return { kind, entry };
    }
    return null;
  },

  // Resolves a Homey device name, cached for WIDGET_NAME_TTL_MS. Deliberately does NOT
  // go through device.js _cap/_devCache: that cache is cleared at the top of every tick,
  // so a widget polling between ticks would still trigger a fresh full-device HTTP fetch.
  async _widgetDeviceName(id) {
    if (!this._widgetNameCache) this._widgetNameCache = new Map();
    const hit = this._widgetNameCache.get(id);
    if (hit && (Date.now() - hit.at) < WIDGET_NAME_TTL_MS) return hit.name;
    try {
      const dev = await this._api.getDevice(id);
      if (dev && dev.name) {
        this._widgetNameCache.set(id, { name: dev.name, at: Date.now() });
        return dev.name;
      }
    } catch (e) { /* API key missing / unreachable — fall through */ }
    // A failed or empty lookup is NOT cached, so it retries on the next poll instead of
    // pinning a placeholder for the whole TTL. An expired-but-known name still beats the
    // id-derived placeholder, so prefer it.
    return hit ? hit.name : `${String(id).slice(0, 8)}…`;
  },

  // ── Live status for one controllable device (widget polling) ────────────
  async getEmsControllableStatus(id) {
    const cfg   = this._getConfig();
    const found = this._findControllable(cfg, id);
    if (!found) return { error: 'not_found' };
    const { kind, entry } = found;

    const name = await this._widgetDeviceName(id);

    if (kind === 'charger') {
      const [charger] = await this._getChargers({ ...cfg, chargers: [entry] });
      const st  = this._getChargerState(id);
      const car = this._carForCharger(charger);
      const enabled = entry.enabled !== false;
      return {
        kind, id, name, enabled,
        connected:  charger.connected,
        // What the charger measures. charger.powerW is the control floor — at least
        // amps × phases × 230 V while the EMS has set a current — so a car drawing nothing
        // was shown at 6.9 kW, with the bolt and a remaining time (1.2.299).
        powerW:     charger.rawPowerW ?? null,
        chargeMode: charger.chargeMode,
        // Instant charge (P0) — the same "charge_now" capability as the device
        // tile's own button. Device-wide, not per-charger: while on, EVERY
        // connected+enabled charger on this EMS charges at max power. See
        // chargerControl.js.
        chargeNow:  this.getCapabilityValue('charge_now') === true,
        carName:        car ? car.name : null,
        // The widget's charge-limit picker posts this back to /ems/car-target.
        carId:          car ? car.id : null,
        carSoc:         car ? car.soc : null,
        carTarget:      car ? car.target : null,
        // capacityKwh + readyBy let the widget estimate a remaining-time figure
        // and show the price-planner deadline — same fields the D10 deadline
        // planner itself uses (see lib/ems/priceForecast.js).
        carCapacityKwh: car ? (Number(car.capacityKwh) || null) : null,
        carReadyBy:     car ? (car.readyBy || null) : null,
        sessionEnergyKwh:  st.sessionActive ? Math.round((st.sessionEnergyKwh || 0) * 100) / 100 : 0,
        sessionStartedAt:  st.sessionActive ? st.sessionStartedAt : null,
      };
    }

    const { cfgKey, stateKey } = SIMPLE_KIND[kind];
    const [device] = await this._getSimpleDevices(cfgKey, { [cfgKey]: [entry] });
    const stateMap = this[stateKey];
    const st      = stateMap ? stateMap.get(id) : null;
    const daily   = this._simpleDeviceDaily(id);
    const enabled = entry.enabled !== false;
    // When EMS isn't controlling this device, its stateMap entry stops being
    // updated (see simpleDevices.js _evaluateSimpleDevices) — read the real
    // live capability value instead so the widget still shows accurate on/off.
    const isOn = enabled ? !!(st && st.isOn) : (device.actualOn === true);
    return {
      kind, id, name, enabled,
      isOn,
      powerW:         device.powerW,
      minSurplusW:    device.minSurplusW,
      todayKwh:       daily.kwh,
      runtimeMs:      (enabled && st && st.isOn && st.startedAt) ? (Date.now() - st.startedAt) : 0,
      todayRuntimeMs: daily.runtimeMs,
    };
  },

  // The single reading of the per-device flag: absent means enabled, the same opt-out
  // chargerControl and simpleDevices apply when they filter. null for an unknown id, so
  // callers can tell "switched off" from "no longer configured".
  _isControllableEnabled(cfg, id) {
    const found = this._findControllable(cfg, id);
    return found ? found.entry.enabled !== false : null;
  },

  // Every device the EMS can switch on and off, in the order the settings page lists
  // them. Backs the flow action's device picker; kept next to _findControllable so the
  // two stay in step — a picker offering something _findControllable cannot resolve
  // would produce an action that silently does nothing.
  _listControllables(cfg) {
    const out = (cfg.chargers || []).map((c) => ({ id: c.id, kind: 'charger' }));
    for (const [kind, { cfgKey }] of Object.entries(SIMPLE_KIND)) {
      for (const entry of (cfg[cfgKey] || [])) out.push({ id: entry.id, kind });
    }
    return out.filter((d) => d.id);
  },

  // ── Writers — patch one field on one configured device, persist, and run a tick ─
  //
  // They used to restart the tick loop, as a full settings save does. A restart begins
  // with a tick that only observes, so the change waited a whole interval, and a mode that
  // tick decided was written without its trigger — the next tick then saw no change, and
  // ems_mode_changed never fired for it (1.2.299). The tick reads ems_config afresh, so a
  // plain tick is all a single-field change needs. One already running picks it up anyway.
  _applyWidgetChange() {
    if (this._tickInProgress) return;
    this._tick().catch((e) => this.log(`[EMS] widget tick: ${e.message}`));
  },

  async setEmsDeviceEnabled(id, enabled) {
    // A missing flag used to switch the device off (!!undefined), the string "false" on.
    if (typeof enabled !== 'boolean') return { error: 'invalid_value' };
    const cfg   = this._getConfig();
    const found = this._findControllable(cfg, id);
    // Unconditional so the log shows whether the call arrives at all, and with which id.
    // The master-lift line below only appears in one specific case and therefore proves
    // nothing about the request itself.
    this.log(`[EMS] setEmsDeviceEnabled("${id}", ${enabled}) — ${found ? `found as ${found.kind}` : 'NOT FOUND in config'}`);
    if (!found) return { error: 'not_found' };
    found.entry.enabled = !!enabled;
    this.homey.settings.set('ems_config', cfg);
    this._applyWidgetChange();
    return { ok: true };
  },

  async setEmsChargerMode(id, mode) {
    if (!CHARGE_MODES.includes(mode)) return { error: 'invalid_mode' };
    const cfg   = this._getConfig();
    const entry = (cfg.chargers || []).find((c) => c.id === id);
    if (!entry) return { error: 'not_found' };
    entry.charge_mode = mode;
    this.homey.settings.set('ems_config', cfg);
    this._applyWidgetChange();
    return { ok: true };
  },

  // Instant charge (P0) — the exact same "charge_now" capability toggled by
  // the device tile's own button, just reachable from the ev-charger widget
  // too so a one-off full-power charge doesn't require switching the
  // charging mode to "Always charge". Device-wide (see getEmsControllableStatus
  // above) — no device id needed, unlike the per-device writers above.
  async setEmsChargeNow(value) {
    try {
      await this.setCapabilityValue('charge_now', !!value);
    } catch (e) {
      return { error: e.message };
    }
    this._tick().catch(() => {}); // same as the capability listener in onInit
    return { ok: true };
  },

  // ── Battery widget — aggregate view, no per-device picker needed (the SOC
  // zone settings are already global, same as the settings page) ──────────
  async getEmsBatteryStatus() {
    const cfg     = this._getConfig();
    const battery = await this._getBattery(cfg);
    const zones   = this._batteryZones(cfg, battery);
    const devices = cfg.battery_devices || [];
    const priceEnabled = devices.some((d) => d.price_charge_enabled);
    let priceMode = null;
    if (priceEnabled) {
      for (const d of devices) {
        const st = this._batteryStates.get(d.id);
        if (st && st.priceMode && st.priceMode !== 'normal') { priceMode = st.priceMode; break; }
      }
    }
    // Usable capacity summed across batteries → absolute kWh alongside the % SoC, e.g.
    // "8.7 of 13.4 kWh". Through _capacityKwhFor, so it is the same number the adaptive
    // solar-forecast gate is deciding on — read from the battery where one reports it, and
    // the typed figure everywhere else.
    const capacityKwh = devices.reduce((s, d) => s + this._capacityKwhFor(d), 0);
    const energyKwh = (capacityKwh > 0 && battery.soc != null)
      ? Math.round(capacityKwh * battery.soc / 100 * 10) / 10
      : null;
    return {
      hasBattery: devices.length > 0,
      soc: battery.soc, powerW: battery.powerW,
      capacityKwh: capacityKwh > 0 ? Math.round(capacityKwh * 10) / 10 : null,
      energyKwh,
      // One threshold now, plus the ramp's share on top of it. normalSoc/reserveSoc stay in
      // the payload so an older widget build keeps rendering something sane.
      stopSoc: zones.minSoc,
      share: this._batterySurplusShare(cfg, battery.soc),
      normalSoc: zones.minSoc, reserveSoc: null,
      zone: zones.batHardStop ? 'red' : 'green',
      priceEnabled, priceMode,
    };
  },

  // The widget edits the one threshold there is — and writes it where _batteryZones reads
  // it. With the surplus ramp on, that is the ramp's lower point; without it, the old
  // single floor. The field used to write the ramp's lower point in every case: without a
  // ramp that changed nothing and the field snapped back, and with one, a value at or above
  // the upper point switched the ramp off — the stop fell back to the old floor, 80 % by
  // default, and every device stopped (1.2.299). Such a value is refused now, with the
  // limit, and the answer carries the stop that applies afterwards.
  //
  // normalSoc is still accepted so an older widget build keeps working.
  async setEmsBatteryZones({ stopSoc, normalSoc }) {
    const cfg = this._getConfig();
    const raw = (stopSoc !== undefined && stopSoc !== null) ? stopSoc : normalSoc;
    const v = (typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '')) ? Number(raw) : NaN;
    if (!Number.isFinite(v) || v < 0 || v > 100) return { error: 'invalid_value' };
    const soc = Math.round(v);

    const low  = Number(cfg.share_soc_low ?? 0);
    const high = Number(cfg.share_soc_high ?? 0);
    if (high > low) {
      if (soc >= high) return { error: 'above_ramp', max: high - 1 };
      cfg.share_soc_low = soc;
    } else {
      // No ramp: one floor. The reserve-zone floor goes with it, or _validateConfig would
      // disable it the moment the new value passed it, and the stop would jump again.
      cfg.min_battery_soc = soc;
      cfg.min_battery_soc_low = 0;
    }
    // _validateConfig clamps in place; its boolean return only reports whether it changed
    // anything, which we don't need here — cfg is the object being persisted either way.
    this._validateConfig(cfg);
    this.homey.settings.set('ems_config', cfg);
    this._applyWidgetChange();
    return { ok: true, stopSoc: this._batteryZones(cfg, { soc: null }).minSoc };
  },

};
