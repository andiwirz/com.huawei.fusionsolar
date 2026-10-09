'use strict';

const { Device }    = require('homey');
const { withSettingsLog } = require('../../lib/change-log');
const HomeyLocalApi = require('../../lib/homey-local-api');

const {
  TICK_MS, TICK_MIN_S, TICK_MAX_S, GRID_SENSOR_HOLD_MS, BATTERY_SOC_HOLD_MS, SLOW_REFRESH_MS, HISTORY_SAVE_MS, TICK_MAX_DT_MS,
  AMPS_LADDER, MODES, HIST, TRIGGER_BUDGET_MS,
} = require('../../lib/ems/constants');

// EMS behaviour is split into lib/ems/* mixins to keep this orchestrator readable.
// Each module exports plain methods that are attached to the prototype below via
// Object.assign, so `this` is the device instance exactly as before — no call site
// changes. See the Object.assign block after the class definition.
const historyMixin        = require('../../lib/ems/history');
const timingMixin         = require('../../lib/ems/timing');
const priceMixin          = require('../../lib/ems/price');
const exportLimitMixin    = require('../../lib/ems/exportLimit');
const carsMixin           = require('../../lib/ems/cars');
const simpleDevicesMixin  = require('../../lib/ems/simpleDevices');
const chargerControlMixin = require('../../lib/ems/chargerControl');
const batteryMixin        = require('../../lib/ems/battery');
const pvForecastMixin     = require('../../lib/ems/pvForecast');
const priceForecastMixin  = require('../../lib/ems/priceForecast');
const chargeSessionsMixin = require('../../lib/ems/chargeSessions');
const chargerStateMixin   = require('../../lib/ems/chargerState');
const deviceDiagMixin     = require('../../lib/ems/deviceDiag');
const widgetMixin         = require('../../lib/ems/widget');

class EmsDevice extends Device {

  async onInit() {
    this._chargerStates   = new Map(); // deviceId → per-charger anti-thrash state
    this._heatPumpStates  = new Map(); // deviceId → { isOn: null | boolean }
    this._boilerStates        = new Map();
    this._poolStates          = new Map();
    this._dehumidifierStates  = new Map();
    this._airconStates        = new Map();
    // Timers in those maps only mean something if they survive a restart — otherwise a
    // deploy silently re-arms every stop-grace and min-run window. Restored before the
    // first tick so the adoption path in _evaluateSimpleDevices sees them already filled.
    this._restoreSimpleStates();
    this._batteryStates   = new Map(); // deviceId → { fullFired: boolean, lowFired: boolean }
    this._warmupDone      = false;     // first tick only reads state, no flows fired
    this._tickInProgress  = false;     // prevents overlapping concurrent ticks
    this._importSince     = null;
    this._tickTimer       = null;
    this._offpeakFmt      = null;      // cached Intl.DateTimeFormat (keyed by tz)
    this._offpeakFmtTz    = null;
    // Shallow copy is enough: settings.get() already returns a fresh parse, and history
    // event objects are never mutated in place (only push/splice on the array).
    this._emsHistory      = (this.homey.settings.get('ems_history') || []).slice();
    this._tickCount       = 0;
    this._lastLoggedMode  = null; // null forces the first flushed mode to log
    this._tickMode        = null; // buffered mode decision for the current tick
    // Diagnostics (B7 tick-health + E3 decision snapshot) — read via getEmsDiag().
    this._diag = {
      tickCount: 0, tickErrors: 0, lastTickMs: 0, avgTickMs: 0,
      // maxTickMs and tickSkipped exist because the average hides exactly what matters:
      // an EMA over 0.8/0.2 barely moves for one 12-second tick, yet that tick already
      // cost the loop a cycle. The peak and the skip count say it outright.
      maxTickMs: 0, tickSkipped: 0,
      lastError: null, lastErrorAt: null,
      gridW: null, pvW: null, soc: null, mode: null, modeText: null, decidedAt: null,
    };

    // ── App start / update event ──────────────────────────────────────────────
    const currentVersion = this.homey.app?.manifest?.version ?? '?';
    const lastVersion    = this.homey.settings.get('ems_app_version') ?? null;
    this.homey.settings.set('ems_app_version', currentVersion);
    const isAppUpdate = lastVersion !== null && lastVersion !== currentVersion;
    this._addHistoryEvent(
      HIST.SYSTEM,
      isAppUpdate ? 'app_update' : 'app_start',
      isAppUpdate ? `v${lastVersion} → v${currentVersion}` : `v${currentVersion}`,
    );
    this._lastValidGridW   = null; // sensor failure protection: last known good grid value
    this._gridSensorFail   = 0;   // consecutive ticks without valid grid reading
    this._loggedNoMeterDevices   = false; // one-shot log flag for missing meter config
    this._schedulerFired         = new Map(); // taskId → Date of last fire
    this._devCache               = new Map(); // per-tick device-object cache (cleared each tick)

    // Export limit coordinator state — persisted so an active limit survives an
    // app restart (otherwise the OFF trigger would never fire and the inverter
    // would stay throttled until the next full ON/OFF cycle).
    let exportLimitStore = null;
    try { exportLimitStore = this.getStoreValue('exportLimitState'); } catch (e) { /* ignore */ }
    this._exportLimitActive      = exportLimitStore?.active === true;
    this._exportLimitActivatedAt = exportLimitStore?.activatedAt ?? null;
    if (this._exportLimitActive) this.log('[EMS] restored active export limit from store');

    // Variable electricity price (set by the ems_set_electricity_price flow),
    // persisted so it survives an app restart.
    this._variablePrice = null;
    try {
      const vp = this.getStoreValue('variablePrice');
      if (typeof vp === 'number') this._variablePrice = vp;
    } catch (e) { /* ignore */ }
    this._lastPriceFired = null; // last price value pushed to the capability

    // Per-car live state + SOC-rise tracking (which car is on the charger)
    this._carStates   = [];
    this._carSocTrack = {}; // carId → { soc, lastRiseAt }

    // Per-car target SOC { carId: percent }, set by the ems_set_car_target_soc
    // flow, persisted across restarts.
    this._carTargets = {};

    // capabilityId → last title string applied via setCapabilityOptions — guards
    // _setCapTitle so a settings save doesn't re-fire it for every car when the
    // title text hasn't actually changed (Homey warns against calling it repeatedly).
    this._capTitlesApplied = {};
    try {
      const ts = this.getStoreValue('carTargets');
      if (ts && typeof ts === 'object') this._carTargets = ts;
    } catch (e) { /* ignore */ }
    await this._migrateCarTargetsIntoConfig();

    // Solcast PV forecast — restore cached forecast + last-fetch time (rate-limit safe).
    await this._restorePvForecast();
    // Price forecast (D10) — restore cached slots pushed via ems_set_price_forecast.
    await this._restorePriceForecast();
    // Charge session log (energy + cost per charging session, any charge mode).
    await this._restoreChargeSessions();
    // Per-charger control state. AFTER the session log: a state blob too old to resume
    // still has its running session booked into that array rather than dropped.
    this._restoreChargerStates();
    // "Battery low / full already announced" — so a deploy does not re-announce it.
    await this._restoreBatteryStates();
    // Daily energy/runtime for the ems-device widget's simple-device "today" stat.
    await this._restoreSimpleDailyStats();

    this._api = new HomeyLocalApi({
      homey:  this.homey,
      apiKey: this.getSetting('homey_api_key') || '',
    });

    await this._ensureCapabilities();
    await this._syncCarCapabilities(this._getConfig()); // add car caps only when a car is configured
    await this._syncPvForecastCapabilities(this._getConfig()); // pv forecast caps only when Solcast is configured
    await this._migrateControlFlags(); // fold class-wide control flags onto each device
    await this._migratePriorityOrder();  // expand the class order into device ids
    await this._migrateConfig(); // run once on startup, writes back if format changed
    const _startupCfg = this._getConfig(); // clamp any out-of-range values on startup too
    if (this._validateConfig(_startupCfg)) this.homey.settings.set('ems_config', _startupCfg);

    this.registerCapabilityListener('onoff',           (v) => this._onEnabledChanged(v));
    this.registerCapabilityListener('offpeak_enabled', (v) => {
      const cfg = this._getConfig();
      cfg.offpeak_enabled = v;
      this.homey.settings.set('ems_config', cfg);
      this._tick().catch(() => {});
    });
    this.registerCapabilityListener('charge_now',      () => this._tick().catch(() => {}));

    // Flow action: external app sets the variable electricity price
    this.homey.flow.getActionCard('ems_set_electricity_price')
      .registerRunListener(async (args) => {
        if (args.device.id !== this.id) return;
        const price = Number(args.price);
        if (!Number.isFinite(price)) throw new Error('Invalid price');
        this._variablePrice = price;
        await this.setStoreValue('variablePrice', price).catch(() => {});
        this.log(`[EMS] variable price set to ${price} via flow`);
        await this._updatePriceCapability(this._getConfig());
      });

    // Flow action: external price app (e.g. "Power by the Hour", Tibber) pushes an
    // hourly price forecast array (D10 — see lib/ems/priceForecast.js).
    this.homey.flow.getActionCard('ems_set_price_forecast')
      .registerRunListener(async (args) => {
        if (args.device.id !== this.id) return;
        await this._ingestPriceForecast(args.prices, args.period || 'next_hours');
      });

    // Sets a car's target SOC and relays it to the vehicle. Extracted from the flow
    // action's run listener so the ems-device widget can take exactly the same path:
    // the widget must not talk to the car itself, it only states the target and lets the
    // user's generated "Set charge <soc>%" flow do the rest.
    // Exposed on the device (not a local helper) so api.js can reach it.
    this.setCarTargetSoc = async (carId, rawSoc) => {
      const soc = Math.round(Number(rawSoc));
      if (!Number.isFinite(soc) || soc < 0 || soc > 100) throw new Error('Target SOC must be 0–100');
      this._carTargets[carId] = soc;
      (this._carTargetSetAt = this._carTargetSetAt || {})[carId] = Date.now();
      // _carStates is what the widget's /status reads, and it is only rebuilt on the 15 s
      // tick. Without this the very next poll — a second or two after the click — still
      // returns the old target and the widget snaps back before the tick ever runs.
      const liveState = (this._carStates || []).find((s) => s.id === carId);
      if (liveState) liveState.target = soc;
      await this.setStoreValue('carTargets', this._carTargets).catch(() => {});
      const car = (this._getConfig().car_devices || []).find((c) => c.id === carId);
      const carName = (car && car.name) || 'Car';
      this.log(`[EMS] car "${carName}" (${carId}) target SOC set to ${soc}% → trigger ems_set_car_target`);
      const capId = `measure_car_target_soc.${carId}`;
      await this._ensureCap(capId, true); // may be first use
      await this._setCapTitle(capId, `${carName} Target`);
      await this._set(capId, soc);
      // Relay to the vehicle: the created "Set charge <soc>%" flow filters on the
      // vehicle's device id + target_pct, so exactly the matching flow fires and
      // applies the fixed charge target to the car.
      await this.homey.flow.getTriggerCard('ems_set_car_target')
        .trigger(
          { target_soc: soc, car_name: carName, message: `${carName}: target charge ${soc}%` },
          { car_device_id: (car && car.device_id) || carId, target_pct: String(soc) },
        )
        .catch((e) => this.log(`[EMS] ems_set_car_target trigger failed: ${e.message}`));
      return soc;
    };

    // The ems_set_car_target run listener lives in app.js (FusionSolarKioskApp
    // .matchCarTarget), not here. It used to be registered in both places, which made
    // Homey log "Run listener was already registered" on every start — and this copy
    // lacked the "empty filter matches any target" case that the argument's own label
    // promises, so whichever of the two won decided whether a hand-built flow with a
    // blank filter fired at all. The card is app-level; a device that can be deleted and
    // re-paired is the wrong owner for it.

    // Flow action: external app / schedule sets a car's target SOC.
    const carTargetCard = this.homey.flow.getActionCard('ems_set_car_target_soc');
    carTargetCard.registerArgumentAutocompleteListener('car', async (query) => {
      const cars = this._getConfig().car_devices || [];
      const q = (query || '').toLowerCase();
      return cars
        .filter((c) => !q || (c.name || '').toLowerCase().includes(q))
        .map((c) => ({ id: c.id, name: c.name || c.id }));
    });
    carTargetCard.registerRunListener(async (args) => {
      if (args.device.id !== this.id) return;
      const carId = args.car && args.car.id;
      if (!carId) throw new Error('No car selected');
      await this.setCarTargetSoc(carId, args.soc);
    });

    // Per-device EMS control — the flow counterpart to the switch in the settings page
    // and in the ems-device widget. ems_set_enabled covers the whole EMS; this takes a
    // single charger or simple device out of it (holiday, maintenance) and leaves the
    // rest running. Writes through setEmsDeviceEnabled so all three entry points share
    // one path and cannot drift apart.
    // One picker definition for both the action and the ems_device_enabled condition, so
    // the two cards can never end up offering different device lists.
    this._controllableAutocomplete = async (query) => {
      const q = (query || '').toLowerCase();
      const out = [];
      for (const d of this._listControllables(this._getConfig())) {
        const name = (await this._widgetDeviceName(d.id)) || d.id;
        if (!q || name.toLowerCase().includes(q)) out.push({ id: d.id, name });
      }
      return out;
    };

    const devEnabledCard = this.homey.flow.getActionCard('ems_set_device_enabled');
    devEnabledCard.registerArgumentAutocompleteListener('target', this._controllableAutocomplete);
    devEnabledCard.registerRunListener(async (args) => {
      if (args.device.id !== this.id) return;
      const id = args.target && args.target.id;
      if (!id) throw new Error('No device selected');
      const res = await this.setEmsDeviceEnabled(id, args.enabled === 'true');
      if (res && res.error) throw new Error(res.error);
    });

    // The matching question to the action above, so a flow can check before it switches.
    // No "is this my EMS device" guard here: a condition has to answer, and returning
    // early would answer "no" rather than staying silent.
    const devEnabledCond = this.homey.flow.getConditionCard('ems_device_enabled');
    devEnabledCond.registerArgumentAutocompleteListener('target', this._controllableAutocomplete);
    devEnabledCond.registerRunListener(async (args) => {
      const id = args.target && args.target.id;
      if (!id) throw new Error('No device selected');
      const enabled = this._isControllableEnabled(this._getConfig(), id);
      if (enabled === null) throw new Error(`Device ${id} is no longer configured in the EMS`);
      return enabled;
    });

    this._applyPriceCurrencyUnit(this._getConfig());
    this._startTick();
    this.log('[EMS] initialized');
  }

  // A deploy is a clean shutdown, so these are the writes that make an app update cost the
  // running charge session and the device timers nothing at all — `true` forces them past
  // the 5-minute cadence and stamps savedAt with the moment the state was last true.
  async onDeleted() { this._stopTick(); this._flushHistorySave(); this._saveSimpleDailyStats(); this._saveChargerStates(true); this._saveSimpleStates(true); }
  async onUninit()  { this._stopTick(); this._flushHistorySave(); this._saveSimpleDailyStats(); this._saveChargerStates(true); this._saveSimpleStates(true); }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('homey_api_key')) {
      this._api.setApiKey(newSettings.homey_api_key || '');
    }
    this._stopTick();
    this._startTick();
  }

  // Called from settings/index.html (via HomeyLocalApi POST /config) when the user saves EMS
  // configuration. Restarts the tick loop so the new settings take effect immediately.
  /**
   * Forget a flow-set charge target for any car whose settings now name one.
   *
   * There are two places a virtual target can come from — the number in the car's settings
   * and the ems_set_car_target_soc flow — and without this the flow's value would outrank
   * the field for ever, so typing 100 into a settings page that already had a stored 80
   * would appear to do nothing at all. Saving the page is the user stating the target in
   * the place it is configured, so it wins from that moment; a later flow run overrides it
   * again until the next save.
   */
  _dropCarTargetOverrides(cfg) {
    let changed = false;
    for (const car of cfg.car_devices || []) {
      const raw = car?.target_soc;
      const named = raw !== null && raw !== undefined && raw !== '' && Number(raw) > 0;
      if (named && car.id && this._carTargets[car.id] !== undefined) {
        delete this._carTargets[car.id];
        changed = true;
      }
    }
    if (changed) this.setStoreValue('carTargets', this._carTargets).catch(() => {});
  }

  /**
   * Moves a virtual charge target out of the device store and into the car's settings, once.
   *
   * Until this version the EMS wrote an 80 into that store the first time it saw a car with
   * no target capability, and then held the charger at 80% — a limit nobody had chosen. The
   * seeding is gone, but the number it already wrote is still sitting in the store of every
   * install that has such a car, so removing the code alone would leave the fault exactly
   * where it was and the new settings field would look broken: type nothing, nothing
   * changes.
   *
   * Moving it makes it visible and editable instead of silently deleting it, because the
   * store cannot tell an invented 80 from a deliberate one somebody set through the flow
   * action. Whatever it was, it was the effective target, so it becomes the stated one.
   *
   * Once, guarded by a store flag: afterwards the flow action's value is an override again,
   * and is not written into the settings behind the user's back.
   */
  async _migrateCarTargetsIntoConfig() {
    try {
      if (this.getStoreValue('carTargetsMigrated')) return;
    } catch (e) { return; }

    const cfg  = this._getConfig();
    const cars = cfg.car_devices || [];
    let moved = 0;
    for (const car of cars) {
      if (!car.id) continue;
      const stored = this._carTargets[car.id];
      if (typeof stored !== 'number') continue;
      const named = car.target_soc !== null && car.target_soc !== undefined && car.target_soc !== '';
      if (!named) car.target_soc = stored;
      delete this._carTargets[car.id];
      moved += 1;
    }

    if (moved) {
      this.log(`[EMS] moved ${moved} virtual charge target(s) from the store into the car settings`);
      this.homey.settings.set('ems_config', cfg);
      await this.setStoreValue('carTargets', this._carTargets).catch(() => {});
    }
    await this.setStoreValue('carTargetsMigrated', true).catch(() => {});
  }

  onConfigChanged() {
    const cfg = this._getConfig();
    if (this._validateConfig(cfg)) this.homey.settings.set('ems_config', cfg);
    this._dropCarTargetOverrides(cfg);
    this._syncCarCapabilities(cfg).catch((e) => this.error('[EMS] car cap sync:', e.message));
    this._syncPvForecastCapabilities(cfg).catch((e) => this.error('[EMS] pv cap sync:', e.message));
    this._priceUnitApplied = null; // currency may have changed → re-apply unit next tick
    this._stopTick();
    this._startTick();
  }

  // Clamps out-of-range config values and logs one line per fix. Returns true if
  // anything changed (caller persists). Belt-and-suspenders so a mistyped setting
  // cannot put the EMS into a nonsensical state.
  _validateConfig(cfg) {
    const warns = [];
    const clamp = (obj, key, lo, hi) => {
      if (obj[key] === undefined || obj[key] === null || obj[key] === '') return;
      const n = Number(obj[key]);
      if (!Number.isFinite(n)) return;
      const c = Math.min(hi, Math.max(lo, n));
      if (c !== n) { warns.push(`${key} ${n}→${c}`); obj[key] = c; }
    };
    clamp(cfg, 'tick_interval_s', TICK_MIN_S, TICK_MAX_S);
    clamp(cfg, 'min_battery_soc', 0, 100);
    clamp(cfg, 'min_battery_soc_low', 0, 100);
    if (Number(cfg.min_battery_soc_low) > 0 && Number(cfg.min_battery_soc_low) >= Number(cfg.min_battery_soc)) {
      warns.push(`min_battery_soc_low ≥ min_battery_soc → low zone disabled`);
      cfg.min_battery_soc_low = 0;
    }
    clamp(cfg, 'export_limit_trigger_soc', 0, 100);
    clamp(cfg, 'export_limit_deactivate_soc', 0, 100);
    if (cfg.export_limit_deactivate_soc != null && cfg.export_limit_trigger_soc != null
        && Number(cfg.export_limit_deactivate_soc) >= Number(cfg.export_limit_trigger_soc)) {
      const c = Math.max(0, Number(cfg.export_limit_trigger_soc) - 1);
      warns.push(`export_limit_deactivate_soc ≥ trigger → ${c}`);
      cfg.export_limit_deactivate_soc = c;
    }
    clamp(cfg, 'share_soc_low',  0, 100);
    clamp(cfg, 'share_soc_high', 0, 100);
    clamp(cfg, 'share_pct_low',  0, 100);
    clamp(cfg, 'share_pct_high', 0, 100);
    clamp(cfg, 'offpeak_amps', 6, 32);
    for (const c of (cfg.chargers || [])) {
      clamp(c, 'max_amps', 6, 32);
      clamp(c, 'step_hold_s', 15, 600);
      // 0 is a valid answer here and the default: it means 'reduce immediately', which is
      // what every install did before the field existed.
      clamp(c, 'step_down_hold_s', 0, 600);
    }
    for (const key of ['heat_pump_devices', 'boiler_devices', 'pool_devices', 'dehumidifier_devices', 'aircon_devices']) {
      for (const d of (cfg[key] || [])) {
        clamp(d, 'startup_grace_s', 0, 900);
        clamp(d, 'min_surplus_w', 0, 1000000);
      }
    }
    if (warns.length) this.log(`[EMS] config validation clamped: ${warns.join(', ')}`);
    return warns.length > 0;
  }

  _onEnabledChanged() {
    // _tickBody handles both states (it sets 'disabled' when off); running a tick
    // keeps the mode decision on the single buffered path in _flushMode.
    this._tick().catch(() => {});
  }

  // ─── Config ───────────────────────────────────────────────────────────────

  _getConfig() {
    return this.homey.settings.get('ems_config') || {};
  }

  /** Runs once at startup: converts legacy field names and writes the result back. */
  // "EMS controls this class" was a second, class-wide flag that short-circuited before the
  // per-device one was ever read — two stored truths for one question, and the class flag
  // silently won. Fold it into the per-device flag so only one remains.
  //
  // Own guard key, not _migrated: that one has long since been set on existing installs,
  // so this would never run. A class that was switched OFF must disable its devices — the
  // whole point is that nobody's EMS starts controlling things it was told not to touch.
  // device_priority_order used to hold device CLASSES; it now holds device ids. Expand the
  // stored class order into the ids of that class, in configured order, so the user's
  // existing ranking survives verbatim: [charger, boiler] with two chargers becomes
  // [chargerA, chargerB, boiler] — same behaviour, because adjacent chargers are still
  // evaluated as one run. Own guard key; _migrated and _controlPerDevice are already set
  // on existing installs.
  async _migratePriorityOrder() {
    const cfg = this.homey.settings.get('ems_config') || {};
    if (cfg._priorityPerDevice) return;
    const LIST_FOR = {
      charger:      'chargers',
      heat_pump:    'heat_pump_devices',
      boiler:       'boiler_devices',
      pool:         'pool_devices',
      dehumidifier: 'dehumidifier_devices',
      aircon:       'aircon_devices',
    };
    const stored = Array.isArray(cfg.device_priority_order) ? cfg.device_priority_order : [];

    // The settings page rewrites ems_config wholesale and does not carry _priorityPerDevice
    // back, so this runs again after every save. By then the stored order holds device ids,
    // and expanding those as if they were class names resolves nothing — which silently wiped
    // the user's ranking on every single save. Anything that is not one of the class names
    // above is an id, so the order has already been migrated: set the guard, change nothing.
    if (stored.some((k) => !LIST_FOR[k])) {
      cfg._priorityPerDevice = true;
      this.homey.settings.set('ems_config', cfg);
      this.log('[EMS] device priority already per-device — guard re-set, order untouched');
      return;
    }

    const classOrder = stored.length ? stored : Object.keys(LIST_FOR);
    const ids = [];
    for (const kind of classOrder) {
      const listKey = LIST_FOR[kind];
      if (!listKey) continue;                     // already an id, or an unknown class
      for (const d of cfg[listKey] || []) if (d.id) ids.push(d.id);
    }
    // Belt and braces: never replace an existing ranking with an empty one.
    if (!ids.length && stored.length) {
      cfg._priorityPerDevice = true;
      this.homey.settings.set('ems_config', cfg);
      return;
    }
    cfg.device_priority_order = ids;
    cfg._priorityPerDevice = true;
    this.homey.settings.set('ems_config', cfg);
    this.log(`[EMS] migrated device priority from classes to ${ids.length} device(s)`);
  }

  async _migrateControlFlags() {
    const cfg = this.homey.settings.get('ems_config') || {};
    if (cfg._controlPerDevice) return;
    const CLASSES = [
      ['charger_control',      'chargers'],
      ['heat_pump_control',    'heat_pump_devices'],
      ['boiler_control',       'boiler_devices'],
      ['pool_control',         'pool_devices'],
      ['dehumidifier_control', 'dehumidifier_devices'],
    ];
    for (const [flag, listKey] of CLASSES) {
      if (cfg[flag] === false) {
        const list = cfg[listKey] || [];
        for (const entry of list) entry.enabled = false;
        this.log(`[EMS] migrating ${flag}=false onto ${list.length} device(s) in ${listKey}`);
      }
      delete cfg[flag];
    }
    cfg._controlPerDevice = true;
    this.homey.settings.set('ems_config', cfg);
  }

  async _migrateConfig() {
    const cfg     = this.homey.settings.get('ems_config') || {};
    if (cfg._migrated) return;
    let   changed = false;

    if (!cfg.chargers && cfg.charger_device_id) {
      cfg.chargers = [{ id: cfg.charger_device_id, max_amps: parseInt(cfg.ev_max_amps, 10) || 16 }];
      changed = true;
    }

    if (!cfg.inverter_devices) {
      const ids = (cfg.grid_devices || []).map((d) => ({ id: d.id, cap_power: d.cap_power }));
      if (!ids.length) {
        const rawIds = cfg.grid_device_ids || (cfg.grid_device_id ? [cfg.grid_device_id] : []);
        const cap    = cfg.grid_capability || 'measure_power.grid_active_power';
        rawIds.forEach((id) => ids.push({ id, cap_power: cap }));
      }
      cfg.inverter_devices = ids;
      changed = true;
    }
    if (!cfg.meter_devices)  { cfg.meter_devices  = []; changed = true; }
    if (!cfg.house_devices)  { cfg.house_devices  = []; changed = true; }

    if (cfg.throttle_budget_w !== undefined && cfg.orange_budget_w === undefined) {
      cfg.orange_budget_w = cfg.throttle_budget_w;
      delete cfg.throttle_budget_w;
      changed = true;
    }
    if (cfg.ev_reserve_w !== undefined && cfg.orange_budget_w === undefined) {
      cfg.orange_budget_w = cfg.ev_reserve_w;
      delete cfg.ev_reserve_w;
      changed = true;
    }

    if (!cfg.battery_devices) {
      const ids = cfg.battery_device_ids || (cfg.battery_device_id ? [cfg.battery_device_id] : []);
      cfg.battery_devices = ids.map((id) => ({ id, cap_soc: 'measure_battery' }));
      changed = true;
    }

    cfg._migrated = true;
    if (changed) this.log('[EMS] config migrated');
    this.homey.settings.set('ems_config', cfg);
  }

  // ─── Tick ─────────────────────────────────────────────────────────────────

  /**
   * The control-loop interval in ms. Configurable since 1.2.148; TICK_MS is only the
   * default now. Clamped here as well as in _validateConfig, because this is the value
   * the timer actually runs on and a bad one would be felt, not just stored.
   */
  _tickMs(cfg = null) {
    const raw = Number((cfg || this._getConfig()).tick_interval_s);
    if (!Number.isFinite(raw) || raw <= 0) return TICK_MS;
    return Math.min(TICK_MAX_S, Math.max(TICK_MIN_S, Math.round(raw))) * 1000;
  }

  _startTick() {
    this._stopTick();
    this._warmupDone           = false;
    this._loggedNoMeterDevices = false;
    const tickMs = this._tickMs();
    if (tickMs !== TICK_MS) this.log(`[EMS] tick interval ${tickMs / 1000}s (default ${TICK_MS / 1000}s)`);
    this._tickTimer = this.homey.setInterval(
      () => this._tick().catch((e) => this.log(`[EMS] tick: ${e.message}`)),
      tickMs,
    );
    this._tick().catch((e) => this.log(`[EMS] init tick: ${e.message}`));
  }

  _stopTick() {
    if (this._tickTimer) { this.homey.clearInterval(this._tickTimer); this._tickTimer = null; }
  }

  async _tick() {
    if (this._tickInProgress) {
      // A skipped tick used to return here without a trace — no counter, no log. That is
      // the one event worth catching: the previous tick is still running, so this cycle
      // simply did not happen, and the control loop stopped keeping time without saying so.
      this._noteTickSkip(this._tickMs());
      return;
    }
    this._tickInProgress = true;
    const t0 = Date.now();
    // Kept on the instance so a SKIPPED tick can report how long the one that is blocking
    // it has been running. The diag figures cannot: avg and max are written in the finally
    // below, so at the moment an overrun is announced they describe every tick EXCEPT the
    // one causing it. That is how a five-minute tick was reported as "max 1755 ms".
    this._tickStartedAt = t0;
    this._tickPhase = 'start';
    try {
      await this._tickBody();
      this._tickPhase = 'flush';
      await this._flushMode(); // apply exactly one mode decision per tick
      this._consecTickErrors = 0;
    } catch (e) {
      // The first stack line names file and line. For a ReferenceError that IS the
      // diagnosis, and logging only e.message had us hunting for it.
      const where = (e.stack || '').split('\n')[1];
      this.log(`[EMS] tick error: ${e.message}${where ? ` — ${where.trim()}` : ''}`);
      this._tickMode = null; // drop a half-formed decision
      this._diag.tickErrors += 1;
      this._diag.lastError = e.message;
      this._diag.lastErrorAt = Date.now();
      // Surface it. A throwing tick controls nothing, but the device kept showing its last
      // good status, so a dead EMS looked like a working one — which is how a ReferenceError
      // in _tickBody survived a whole release. Two in a row, so one transient API hiccup
      // stays quiet.
      this._consecTickErrors = (this._consecTickErrors || 0) + 1;
      if (this._consecTickErrors >= 2) {
        await this._setMode(MODES.ERROR, `Tick-Fehler: ${e.message}`)
          .catch(() => { /* the mode write itself may be what is failing */ });
      }
    } finally {
      const dt = Date.now() - t0;
      this._diag.lastTickMs = dt;
      this._diag.avgTickMs  = this._diag.avgTickMs ? Math.round(this._diag.avgTickMs * 0.8 + dt * 0.2) : dt;
      if (dt > this._diag.maxTickMs) this._diag.maxTickMs = dt;
      this._diag.tickCount += 1;
      // A completed tick means the loop caught up; only unbroken runs of skips count.
      this._consecSkips = 0;
      this._tickInProgress = false;
      this._warmupDone = true;
      this._tickCount += 1;
      // By elapsed time: at 20 ticks this was ~5 min only as long as a tick was 15 s.
      if (!this._lastHistorySaveAt || (Date.now() - this._lastHistorySaveAt) >= HISTORY_SAVE_MS) {
        this._lastHistorySaveAt = Date.now();
        this._saveHistory();
      }
    }
  }

  // Diagnostics snapshot (B7 tick-health + E3 last decision + PV forecast + process memory).
  // Read by the settings/API. Memory is process-wide (the whole app), not just this device.
  getEmsDiag() {
    const cfg  = this._getConfig();
    const mode = (cfg.price_config && cfg.price_config.mode) || 'fixed';
    return {
      ...this._diag,
      // The settings footer used to carry a hand-typed build number, which stopped being
      // true at 1.2.151 and then travelled into every configuration export as a header —
      // the one line in a bug report a reader trusts without checking.
      appVersion: this.homey.app?.manifest?.version ?? '?',
      tickMs: this._tickMs(cfg),
      pv: this._pvForecastSummary(), price: this._priceForecastSummary(), mem: this._memUsage(),
      electricityPrice: this._getCurrentPrice(cfg), electricityPriceSource: mode,
      electricityPriceCurrency: (cfg.price_config && cfg.price_config.currency) || 'CHF',
      offpeakEnabled: this.getCapabilityValue('offpeak_enabled') === true,
      dualTariffConfigured: this._dualTariffWindow(cfg).configured,
      // Whole-house grid-import ceiling (load-shedding coordinator) — committedW reflects
      // the last completed tick's actual claims (seeded from measured gridW, then added to
      // by battery force-charge, every unconditional EV-charging tier, and any heat pump /
      // boiler / pool / dehumidifier start). maxKw 0 = no limit set.
      gridImportCeiling: {
        committedW: this._gridImportCommittedW || 0,
        maxKw: Number(cfg.grid_import_limit_kw) || 0,
      },
      // Solar-forecast start gate: state + the two figures it compared, so the settings
      // page can show why it is holding rather than only that it is.
      forecastGate: this._forecastGateDiag(cfg, this._diag.soc),
      // Measured beside believed, per device the EMS steers — see lib/ems/deviceDiag.js.
      devices: this._deviceDiag(),
      // The two "tell the user" thresholds behind ems_battery_low / _full. They lost their
      // input fields with the SOC zones in 1.2.108 but kept firing, so their defaults turn
      // up in the history as "53% < 80% — Batterie tief" and read like a limit that stops
      // something. Reported so the settings page can name them; they stop nothing.
      batteryAnnounce: this._batteryAnnounceThresholds(cfg),
    };
  }

  // process.memoryUsage() in MB. rss = total resident; heapUsed/heapTotal = V8 JS heap;
  // external/arrayBuffers = C++-bound buffers (Modbus/OCPP network I/O).
  _memUsage() {
    try {
      const m  = process.memoryUsage();
      const mb = (b) => Math.round((b / 1048576) * 10) / 10;
      return {
        rss:          mb(m.rss),
        heapUsed:     mb(m.heapUsed),
        heapTotal:    mb(m.heapTotal),
        external:     mb(m.external),
        arrayBuffers: mb(m.arrayBuffers),
      };
    } catch (e) {
      return null;
    }
  }

  async _tickBody() {
    // Read config once per tick and pass it down — avoids repeated settings reads
    const cfg     = this._getConfig();
    const enabled = this.getCapabilityValue('onoff') !== false;
    const hasKey  = !!this.getSetting('homey_api_key');
    this._devCache = new Map(); // fresh device snapshot per tick (see _cap)

    // How much time has actually passed since the previous tick — measured, not assumed.
    // The two differ even at a fixed interval: the timer drifts, a tick itself takes
    // ~200 ms, and a skipped tick doubles the gap outright. Runtime and energy totals
    // were booked as a flat TICK_MS regardless, so they counted short whenever the loop
    // ran late. Zero on the very first tick: no interval has been observed yet, and
    // guessing one would invent runtime that never happened.
    const nowMs = Date.now();
    const dtMs  = this._lastTickAt ? Math.min(nowMs - this._lastTickAt, TICK_MAX_DT_MS) : 0;
    this._lastTickAt = nowMs;

    // Price + car SOC change slowly, so refresh them on a slower cadence (~60 s) instead
    // of every tick — cuts settings reads and per-car HTTP calls. By elapsed time, not
    // every Nth tick: tied to a tick count, a faster interval would quietly multiply the
    // requests to the car APIs. Runs on the warm-up tick too so values populate
    // immediately. A variable price set via the ems_set_electricity_price flow still
    // updates instantly (handled in onInit).
    const slowDue = !this._warmupDone || !this._lastSlowRefreshAt
      || (nowMs - this._lastSlowRefreshAt) >= SLOW_REFRESH_MS;
    if (slowDue) {
      this._lastSlowRefreshAt = nowMs;
      await this._applyPriceCurrencyUnit(cfg);
      await this._updatePriceCapability(cfg);
      await this._updateCarCapabilities(cfg);
      await this._maybeFetchPvForecast(cfg); // rate-limited internally (≥3 h between fetches)
      await this._updatePvForecastCapabilities(); // recompute today/tomorrow/now from cache (no API call)
      this._checkPriceForecastStaleness(); // one-shot notification if a fed forecast goes stale
      this._saveSimpleDailyStats(); // persist the ems-device widget's "today" stat — see lib/ems/widget.js
    }

    if (!enabled || !hasKey) {
      if (hasKey) {
        // Display-only refresh — chargers are not fetched: nothing controls them here
        const [gridW, pvW, battery] = await Promise.all([
          this._getGridW(cfg), this._getPvW(cfg), this._getBattery(cfg),
        ]);
        if (gridW !== null) {
          await this._set('measure_solar_surplus', Math.max(0, Math.round(-gridW)));
          await this._set('measure_grid_power', Math.round(gridW));
          const houseW = await this._getHouseW(cfg, gridW, pvW, battery);
          if (houseW !== null) await this._set('measure_house_power', Math.round(houseW));
        }
        if (pvW !== null) await this._set('measure_pv_power', Math.round(pvW));
        if (battery.powerW !== null) await this._set('measure_battery_power', Math.round(battery.powerW));
      }
      // A switched-off EMS releases nothing. Leaving the last figure standing would draw a
      // flat line through the whole outage at whatever was released the moment it stopped.
      await this._set('measure_released_surplus', 0);
      if (!enabled) {
        await this._setMode(MODES.DISABLED, '—');
      } else {
        await this._setMode(MODES.ERROR, 'Kein API-Schlüssel — bitte in den Geräteeinstellungen eintragen');
      }
      return;
    }

    const [battery, gridW, pvW, chargers, heatPumps, boilers, pools, dehumidifiers, aircons] = await Promise.all([
      this._getBattery(cfg),
      this._getGridW(cfg),
      this._getPvW(cfg),
      this._getChargers(cfg),
      this._getSimpleDevices('heat_pump_devices', cfg),
      this._getSimpleDevices('boiler_devices', cfg),
      this._getSimpleDevices('pool_devices', cfg),
      this._getSimpleDevices('dehumidifier_devices', cfg),
      this._getSimpleDevices('aircon_devices', cfg),
    ]);
    this._diag.gridW = gridW; this._diag.pvW = pvW; this._diag.soc = battery.soc;
    // The battery's own power, which decides more than any other single reading: whether
    // the hard-stop overflow exception applies at all (batCharging), whether the battery
    // boost is added, and whether the discharge correction bites — seven call sites across
    // chargerControl and simpleDevices. It reached the diagnostics only as an arrow inside
    // modeText, which is prose, so a decision could be read but not recomputed.
    this._diag.batteryW = battery.powerW;
    // Per battery, for installations with more than one: battery.soc is the MINIMUM across
    // the bank, so an aggregate alone cannot show which one is holding the figure down.
    this._diag.socPerDevice = battery.socPerDevice || null;
    // Whole-house grid-import ceiling (cfg.grid_import_limit_kw) — seeded to the ALREADY
    // measured grid import so ordinary house baseline load (fridge, lights, whatever's
    // not EMS-controlled) is accounted for before any EMS-controlled load claims more.
    // Claimed by the battery price-charge check above and every EV-charger tier that
    // draws unconditionally (Instant/Always/Off-peak/Price/Low-tariff) in chargerControl.js.
    //
    // Because the seed is a MEASUREMENT, it already contains whatever EMS-controlled
    // loads are running right now. Any consumer that re-claims its full draw every tick
    // (EV chargers, battery force-charge) must therefore claim only the DELTA — it takes
    // its own current draw back out of the total first. Consumers that claim once on a
    // NEW start and not again while running (the on/off simple devices) correctly stay
    // part of this baseline. Getting that wrong made a charger inside the ceiling stop
    // and restart every tick — see chargerControl.js _gridImportClaimAmps.
    this._gridImportCommittedW = Math.max(0, gridW || 0);
    // Charge-session energy/cost tracking — every configured charger, every tick,
    // independent of charge mode (see lib/ems/chargeSessions.js). dtMs is the measured
    // gap to the previous tick, so a late or skipped tick books the time it really took.
    for (const c of chargers) this._trackChargeSession(c, cfg, dtMs, gridW);
    // Daily energy/runtime tracking for the ems-device widget's "today" stat —
    // see lib/ems/widget.js. Cheap (in-memory, no I/O) so it's fine every tick.
    this._trackSimpleDeviceDaily(heatPumps,     this._heatPumpStates,     dtMs);
    this._trackSimpleDeviceDaily(boilers,       this._boilerStates,       dtMs);
    this._trackSimpleDeviceDaily(pools,         this._poolStates,         dtMs);
    this._trackSimpleDeviceDaily(dehumidifiers, this._dehumidifierStates, dtMs);
    this._trackSimpleDeviceDaily(aircons, this._airconStates, dtMs);
    if (gridW !== null) {
      await this._set('measure_solar_surplus', Math.max(0, Math.round(-gridW)));
      await this._set('measure_grid_power', Math.round(gridW));
    }
    if (pvW !== null) await this._set('measure_pv_power', Math.round(pvW));
    if (battery.powerW !== null) await this._set('measure_battery_power', Math.round(battery.powerW));
    let houseW = null;
    if (gridW !== null) {
      this._tickPhase = 'house';
      houseW = await this._getHouseW(cfg, gridW, pvW, battery, chargers);
      if (houseW !== null) await this._set('measure_house_power', Math.round(houseW));
    }
    // Recorded here, not next to gridW/pvW/soc above: houseW is declared further down,
    // so assigning it earlier hit the temporal dead zone and threw on every tick.
    this._diag.houseW = houseW;
    this._tickPhase = 'battery';
    if (this._warmupDone) await this._checkBatteryTriggers(cfg, battery);
    if (this._warmupDone) await this._checkBatteryPriceControl(cfg, battery);
    // Right after the only place that moves the announcement flags; a no-op when unchanged.
    this._saveBatteryStates();
    // The solar-forecast gate is asked for its verdict once per device type and once for
    // the chargers; announcing it is done here, once, so the history gets one entry per
    // transition rather than one per consumer.
    if (this._warmupDone) this._announceForecastGate(cfg, battery);
    this._tickPhase = 'scheduler';
    if (this._warmupDone) await this._checkScheduler(cfg).catch((e) => this.error('[EMS] scheduler:', e.message));

    // ── Sensor failure guard ──────────────────────────────────────────────────
    // _getGridW returns null once the sensor has been silent for GRID_SENSOR_HOLD_MS.
    // Hold all device control and report error; PV/battery display is still updated above.
    if (gridW === null) {
      // Same as the disabled branch: control is held, so nothing is being released.
      await this._set('measure_released_surplus', 0);
      // Distinguish "no grid meter configured" (setup incomplete) from a genuine
      // sensor/API failure (configured but reads keep failing) so the status is honest
      // instead of always blaming the sensor.
      if (!(cfg.meter_devices || []).length) {
        await this._setMode(MODES.NOT_CONFIGURED, 'Kein Netzzähler konfiguriert');
      } else {
        const failSecs = Math.round((Date.now() - (this._gridSensorFailSince || Date.now())) / 1000);
        await this._setMode(MODES.ERROR, `Netzstrom-Sensor: ${failSecs}s kein Signal — EMS wartet`);
      }
      return;
    }

    // Device ids, no longer class names (see _migratePriorityOrder). Empty is harmless:
    // _buildPriorityRuns appends anything unlisted in configured order.
    const priorityOrder = Array.isArray(cfg.device_priority_order) ? cfg.device_priority_order : [];
    let effectiveGridW = gridW;
    // Orange zone: expand effective surplus by orange budget so devices can borrow from battery charging.
    // The budget is shared across all device types via effectiveGridW — as each type allocates power,
    // effectiveGridW rises (less virtual export), naturally limiting subsequent types.
    // The SOC ramp splits the surplus between battery and devices: the fuller the
    // battery, the larger the devices' share. Below the hard stop nothing runs at all
    // (see _batteryZones), so there is no second budget model any more.
    // battery.powerW caps the budget at what the battery actually absorbs — while it
    // discharges, the ramp has nothing to lend (see _batteryShareBudgetW).
    const _shareBudgetW = this._batteryShareBudgetW(cfg, battery.soc, pvW, gridW, battery.powerW);
    if (_shareBudgetW !== null) {
      if (_shareBudgetW > 0 && effectiveGridW !== null) effectiveGridW -= _shareBudgetW;
      this._diag.shareBudgetW = _shareBudgetW;
      this._diag.surplusShare = this._batterySurplusShare(cfg, battery.soc);
    }
    // What the devices may actually claim this tick: the measured export PLUS whatever the
    // SOC ramp lends on top of it. Read here and not one line later, because the priority
    // loop below spends this figure as it allocates — by the end of the tick effectiveGridW
    // says what is LEFT, which is a different number and not the one to record.
    //
    // measure_solar_surplus cannot show this. It is the meter reading, so on a day when the
    // devices ran on a share the meter never saw — the ramp's whole purpose — it looks
    // exactly like a day when they ran on genuine export. Logging both side by side is what
    // makes the ramp's effect readable over the day: the gap between the two lines IS the
    // share the battery handed over, and it widens as the SOC climbs.
    await this._set('measure_released_surplus', Math.max(0, Math.round(-effectiveGridW)));
    // Simple-device dispatch table — replaces four near-identical evaluator wrappers.
    // Each entry carries the device list, its state map and the flow-card / config ids.
    const simpleEval = {
      heat_pump:    { list: heatPumps,     states: this._heatPumpStates,    start: 'ems_start_heat_pump',    stop: 'ems_stop_heat_pump',    arg: 'heat_pump_device_id' },
      boiler:       { list: boilers,       states: this._boilerStates,      start: 'ems_start_boiler',       stop: 'ems_stop_boiler',       arg: 'boiler_device_id' },
      pool:         { list: pools,         states: this._poolStates,        start: 'ems_start_pool',         stop: 'ems_stop_pool',         arg: 'pool_device_id' },
      dehumidifier: { list: dehumidifiers, states: this._dehumidifierStates, start: 'ems_start_dehumidifier', stop: 'ems_stop_dehumidifier', arg: 'dehumidifier_device_id' },
      aircon:       { list: aircons,       states: this._airconStates,       start: 'ems_start_aircon',       stop: 'ems_stop_aircon',       arg: 'aircon_device_id' },
    };
    // Priority is per device, not per device class — see _runPriorityLoop in
    // chargerControl.js, which also carries the shrinking surplus budget between runs.
    this._tickPhase = 'devices';
    // The ramp's share of production, as a ceiling on what all EMS-controlled devices may
    // draw together. _batteryShareBudgetW above turned the same share into an ADDITION to
    // the measured export, which is what lets a device claim while the grid sits at zero —
    // but an addition alone cannot reclaim. A charger already running has a budget of "its
    // own draw minus the meter", and once it consumes everything the meter reads zero, so
    // it justifies itself. Measured 2026-08-29 at 62 % SoC with a 32 % share: 2354 W
    // promised, 6152 W taken, 346 W left for the battery.
    //
    // Derived from pvW directly, not from the grid meter: the share is a share of what the
    // roof makes, and the meter only shows what is left after everything has taken its part.
    const _share = this._batterySurplusShare(cfg, battery.soc);
    const rampAllowanceW = (_share === null || pvW === null)
      ? null
      : Math.max(0, Math.round(Math.max(0, pvW) * _share));
    this._diag.rampAllowanceW = rampAllowanceW;
    effectiveGridW = await this._runPriorityLoop(
      battery, effectiveGridW, chargers, cfg, pvW, houseW, priorityOrder, simpleEval, rampAllowanceW,
    );
    // Right after the only place that mutates the maps, and a no-op when nothing moved.
    this._saveSimpleStates();
    // Same, for the chargers: the priority loop above is what moves the target latch and
    // the session accumulators. Writes on a decision, otherwise at most every 5 min.
    this._saveChargerStates();

    // ── Export limit coordinator ──────────────────────────────────────────────
    if (this._warmupDone) {
      this._tickPhase = 'exportLimit';
      await this._evaluateExportLimit(cfg, battery, gridW)
        .catch((e) => this.log(`[EMS] export limit: ${e.message}`));
    }

    // ── Mode/status for simple devices ────────────────────────────────────────
    // Without chargers the charger evaluation never runs, so mode/status is set
    // here. WITH chargers the charger evaluation owns the mode — but when it
    // left a passive state ('holding'/'idle') while e.g. the pool is running,
    // the running simple devices take over the display.
    const simpleDevicesAll = [...heatPumps, ...boilers, ...pools, ...dehumidifiers, ...aircons];
    // This tick's readings, kept for the diagnostics — see _buildDeviceReadings.
    this._deviceReadings = this._buildDeviceReadings(chargers, simpleDevicesAll);
    const socStr = battery.soc !== null ? ` · Bat ${Math.round(battery.soc)}%` : '';
    // Which of them the EMS is actually running, and what that is called — see
    // _simpleActive (lib/ems/simpleDevices.js) for why a device outside EMS control is
    // left out of the count rather than merely left uncommanded.
    const active       = this._simpleActive({
      heat_pump: heatPumps, boiler: boilers, pool: pools,
      dehumidifier: dehumidifiers, aircon: aircons,
    }, socStr);
    const activeCount  = active.count;
    const simpleMode   = active.mode;
    const stTextActive = active.text;

    if (!chargers.length && !simpleDevicesAll.length) {
      await this._setMode(MODES.NOT_CONFIGURED, 'Konfiguriere EMS in App Settings');
    } else if (!chargers.length && simpleDevicesAll.length) {
      if (activeCount) {
        await this._setMode(simpleMode, stTextActive);
      } else {
        // Show battery-aware status when no device is active
        const { minSoc: _minSoc, minSocLow: _minSocLow, hasLowZone: _hasLow,
                batReserve: _batRes, batHardStop: _batHard } = this._batteryZones(cfg, battery);
        let stTextHolding, holdMode;
        if (_batHard) {
          const limit      = _hasLow ? _minSocLow : _minSoc;
          stTextHolding    = `${Math.round(battery.soc)}% < ${limit}%`;
          holdMode         = MODES.BATTERY_PRIORITY;
        } else if (_batRes) {
          stTextHolding    = `Reserve · kein Überschuss${socStr}`;
          holdMode         = MODES.BATTERY_PRIORITY;
        } else {
          stTextHolding    = `kein Überschuss${socStr}`;
          holdMode         = MODES.HOLDING;
        }
        await this._setMode(holdMode, stTextHolding);
      }
    } else if (chargers.length && activeCount) {
      // A charger is configured AND simple devices run. Check the mode proposed by
      // THIS tick (the buffered one), not the capability — that still holds the
      // previous tick's result, which made the mode alternate on every tick.
      const proposed = this._tickMode && this._tickMode.mode;
      const CHARGER_ACTIVE = new Set([MODES.SOLAR_EV, MODES.OFFPEAK_EV, MODES.INSTANT_EV]);
      if (proposed === MODES.HOLDING || proposed === MODES.IDLE) {
        // Charger passive → reflect the running simple devices.
        await this._setMode(simpleMode, stTextActive);
      } else if (CHARGER_ACTIVE.has(proposed)) {
        // Charger charging AND simple devices running at the same time → several
        // things at once. Show "Solar (multiple devices)" with a combined status
        // line, rather than letting the EV-charging mode hide the other devices.
        await this._setMode(MODES.SOLAR_MULTI, `EV, ${stTextActive}`);
      }
    }
  }

  // ─── Device reads ──────────────────────────────────────────────────────────

  // Per-tick cached capability read. HomeyLocalApi.getCapability fetches the
  // ENTIRE device object per call — with 2 caps per charger/simple device that
  // doubled the HTTP load. Here each device is fetched exactly once per tick
  // (single consistent snapshot); the cache is cleared at the top of _tickBody.
  async _cap(deviceId, capId) {
    if (!this._devCache.has(deviceId)) {
      this._devCache.set(deviceId, this._api.getDevice(deviceId).catch(() => null));
    }
    const device = await this._devCache.get(deviceId);
    const capObj = device?.capabilitiesObj || device?.capabilities || {};
    const entry  = !Array.isArray(capObj) ? capObj[capId] : null;
    if (entry === null || entry === undefined) return null;
    return typeof entry === 'object' ? (entry.value ?? null) : entry;
  }

  async _getBattery(cfg) {
    const devices = cfg.battery_devices || [];
    if (!devices.length) return { soc: null, powerW: null, socPerDevice: {} };
    const [socs, powers, capacities] = await Promise.all([
      Promise.all(devices.map((d) => this._cap(d.id, d.cap_soc || 'measure_battery'))),
      Promise.all(devices.map((d) => d.cap_power ? this._cap(d.id, d.cap_power) : Promise.resolve(null))),
      Promise.all(devices.map((d) => d.cap_capacity ? this._cap(d.id, d.cap_capacity) : Promise.resolve(null))),
    ]);

    // Remember the usable capacity a battery reported, so the four places that need it can
    // ask without each doing its own read. Held for the life of the app rather than for a
    // window: a nameplate capacity does not go stale between two polls, and the hold is not
    // about freshness. It is about never handing on a zero.
    //
    // Zero is not a small capacity, it is the word "unknown" at every consumer — the
    // adaptive solar-forecast gate returns inactive('no_capacity') and price-optimised
    // charging stops planning. One unreadable poll must not switch those off silently.
    this._capacityByBattery = this._capacityByBattery || {};
    devices.forEach((d, i) => {
      const value = capacities[i];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        this._capacityByBattery[d.id] = value;
      }
    });
    // Build per-device SOC map so _checkBatteryTriggers can reuse already-fetched values
    const socPerDevice = {};
    devices.forEach((d, i) => { socPerDevice[d.id] = socs[i]; });
    const validSoc   = socs.filter((s) => s !== null);
    const validPower = powers.filter((p) => p !== null);
    // Hold the last good state of charge for a short window, the same way _getGridW holds
    // the last grid reading. The reason is sharper here since 1.2.188: an absent SoC now
    // HOLDS the battery hard stop instead of releasing it, so without this a single dropped
    // reading would stop every controllable device for one tick and start them again on the
    // next — the churn the min-run and cooldown timers exist to prevent.
    //
    // Only the SoC. powerW feeds the surplus ramp's discharge cap, and there a stale value
    // is the dangerous direction: it would let the ramp keep lending against an absorption
    // that may have stopped. Missing power already means "no cap information", which the
    // ramp handles by falling back to the uncapped claim.
    let soc = validSoc.length ? Math.min(...validSoc) : null;
    if (soc !== null) {
      this._lastValidSoc   = soc;
      this._lastValidSocAt = Date.now();
    } else if (this._lastValidSoc !== undefined && this._lastValidSocAt
               && (Date.now() - this._lastValidSocAt) < BATTERY_SOC_HOLD_MS) {
      this.log(`[EMS] _getBattery: SoC unreadable, using cached ${this._lastValidSoc}%`);
      soc = this._lastValidSoc;
    }
    return {
      soc,
      powerW:       validPower.length ? validPower.reduce((a, b) => a + b, 0) : null,
      socPerDevice,
    };
  }

  async _checkBatteryTriggers(cfg, battery) {
    const devices    = cfg.battery_devices || [];
    // Derived from the surplus ramp where one is configured — see
    // _batteryAnnounceThresholds. The two points that mean something are where every device
    // stops and where the battery stops having priority.
    const { lowSoc: minSoc, fullSoc } = this._batteryAnnounceThresholds(cfg);

    for (const device of devices) {
      // Reuse per-device SOC already fetched in _getBattery — avoids a second API round-trip
      const soc = battery.socPerDevice?.[device.id] ?? null;
      if (soc === null) continue;

      if (!this._batteryStates.has(device.id)) {
        this._batteryStates.set(device.id, { fullFired: false, lowFired: false });
      }
      const st = this._batteryStates.get(device.id);

      if (soc >= fullSoc && !st.fullFired) {
        st.fullFired = true;
        st.lowFired  = false;
        this.log(`[EMS] battery ${device.id}: SOC ${Math.round(soc)}% ≥ ${fullSoc}% → ems_battery_full`);
        this._addHistoryEvent(HIST.DEVICE, 'battery_full', `${Math.round(soc)}% ≥ ${fullSoc}%`, device.id);
        this._postNotification(`EMS: Batterie voll — ${Math.round(soc)}%`);
        await this._settleWithin(
          this.homey.flow
            .getTriggerCard('ems_battery_full')
            .trigger({ battery_device_id: device.id, soc: Math.round(soc) }, { battery_device_id: device.id })
            .catch((e) => this.log(`[EMS] trigger ems_battery_full failed: ${e.message}`)),
          TRIGGER_BUDGET_MS, `battery ${device.id} full`);
      } else if (soc < fullSoc - 5) {
        st.fullFired = false;
      }

      if (soc < minSoc && !st.lowFired) {
        st.lowFired  = true;
        st.fullFired = false;
        this.log(`[EMS] battery ${device.id}: SOC ${Math.round(soc)}% < ${minSoc}% → ems_battery_low`);
        this._addHistoryEvent(HIST.DEVICE, 'battery_low', `${Math.round(soc)}% < ${minSoc}%`, device.id);
        this._postNotification(`EMS: Batterie niedrig — ${Math.round(soc)}%`);
        await this._settleWithin(
          this.homey.flow
            .getTriggerCard('ems_battery_low')
            .trigger({ battery_device_id: device.id, soc: Math.round(soc) }, { battery_device_id: device.id })
            .catch((e) => this.log(`[EMS] trigger ems_battery_low failed: ${e.message}`)),
          TRIGGER_BUDGET_MS, `battery ${device.id} low`);
      } else if (soc >= minSoc + 5) {
        st.lowFired = false;
      }
    }
  }

  // Home-battery price control (evcc-style "battery grid charge" + peak-hour reserve).
  // Opt-in per battery via price_charge_enabled. The decision (lib/ems/priceForecast.js
  // _batteryPriceMode) is fired only on CHANGE, mirroring the existing full/low battery
  // triggers below — each mode maps to one of the battery's own existing EMS trigger
  // cards (Flow setup already lets the user wire these to a Luna2000 action with a
  // fixed power/target value, e.g. "Force Charge 3000W until 90%").
  async _checkBatteryPriceControl(cfg, battery) {
    const devices = cfg.battery_devices || [];
    const TRIGGER_BY_MODE = {
      charge: 'ems_battery_force_charge',
      hold:   'ems_battery_max_discharge_power', // user's wired flow sets this to ~0
      normal: 'ems_battery_normal_mode',
    };

    for (const device of devices) {
      if (!device.price_charge_enabled) continue;
      const soc = battery.socPerDevice?.[device.id] ?? null;

      if (!this._batteryStates.has(device.id)) this._batteryStates.set(device.id, { fullFired: false, lowFired: false });
      const st = this._batteryStates.get(device.id);
      if (st.priceMode === undefined) st.priceMode = null;

      const decision = this._batteryPriceMode(device, soc, cfg);
      this._debugLog(`battery ${device.id}: soc=${soc ?? '—'} → ${decision.mode} (${decision.reason})`);
      if (decision.mode === 'charge') {
        const chargeW = Math.max(0, Number(device.price_charge_power_kw) || 0) * 1000;
        // Whole-house grid-import ceiling (cfg.grid_import_limit_kw) — a battery force-
        // charge trigger sets a FIXED power via the user's own flow, so unlike EV
        // chargers there's no amp ladder to gracefully reduce; if it wouldn't fit under
        // the main-fuse safety limit, skip grid-charging this tick (falls back to
        // whatever mode applies instead — see below).
        const limitKw = Number(cfg.grid_import_limit_kw) || 0;
        // Delta claim, same reasoning as the EV chargers (chargerControl.js
        // _gridImportClaimAmps): the running total is seeded from the MEASURED grid
        // import, so a battery that was ALREADY force-charging last tick has its draw in
        // there. Claiming chargeW on top would count it twice and deny a force-charge
        // that is in fact comfortably inside the ceiling — then re-allow it next tick
        // once the draw left the meter reading, oscillating the trigger.
        const alreadyChargingW = st.priceMode === 'charge' ? chargeW : 0;
        const baselineW   = Math.max(0, (this._gridImportCommittedW || 0) - alreadyChargingW);
        const fitsCeiling = limitKw <= 0 || baselineW + chargeW <= limitKw * 1000;
        if (!fitsCeiling) {
          this._debugLog(`battery ${device.id}: force-charge DENIED — grid import ceiling (${limitKw}kW) has no headroom`);
          // What the battery would have done anyway, decided by _batteryPriceMode itself
          // rather than inferred here from the slot lists — inferring it always produced
          // 'normal', so a denied charge released a battery that was reserving capacity.
          decision.mode   = decision.deniedMode || 'normal';
          decision.reason = `grid import ceiling denied the charge — ${decision.deniedReason || 'default battery behaviour'}`;
        } else {
          this._gridImportCommittedW = baselineW + chargeW;
        }
      }
      if (decision.mode === st.priceMode) continue; // unchanged — don't re-fire every tick

      const cardId = TRIGGER_BY_MODE[decision.mode];
      st.priceMode = decision.mode;
      this.log(`[EMS] battery ${device.id}: price mode → ${decision.mode} (${decision.reason})`);
      // The reason is what makes this readable later: "charge" alone does not say why.
      this._addHistoryEvent(HIST.DEVICE, `battery_${decision.mode}`, decision.reason, device.id);
      await this._settleWithin(
        this.homey.flow
          .getTriggerCard(cardId)
          .trigger({ battery_device_id: device.id }, { battery_device_id: device.id })
          .catch((e) => this.log(`[EMS] trigger ${cardId} failed: ${e.message}`)),
        TRIGGER_BUDGET_MS, `battery ${device.id} price mode ${decision.mode}`);
    }
  }

  // Read-back for the settings page: what would each price-enabled battery do right
  // now, and which upcoming slots did the planner pick — lets the UI show "next
  // charge window" / "reserved peak hours" without duplicating the decision logic.
  async getEmsBatteryPricePlans() {
    const cfg     = this._getConfig();
    const devices = (cfg.battery_devices || []).filter((d) => d.price_charge_enabled);
    if (!devices.length) return [];
    const battery = await this._getBattery(cfg);
    return devices.map((d) => {
      const soc      = battery.socPerDevice?.[d.id] ?? null;
      const decision = this._batteryPriceMode(d, soc, cfg);
      return {
        id: d.id, soc, mode: decision.mode, reason: decision.reason,
        chargeSlots: decision.chargeSlots || [], reserveSlots: decision.reserveSlots || [],
        // null unless the solar gate is configured — lets the UI show "34.2 / 15 kWh"
        // without recomputing the forecast sum itself.
        solarKwh: decision.solarKwh ?? null, solarLimitKwh: decision.solarLimitKwh ?? null,
      };
    });
  }

  // Read-back for the settings page: what would each price-aware charger do right
  // now, and (for D10 'solar_price' chargers) which upcoming slots did the planner
  // pick — mirrors getEmsBatteryPricePlans for the same "next charge window" preview.
  async getEmsChargerPricePlans() {
    const cfg      = this._getConfig();
    const chargers = await this._getChargers(cfg);
    const relevant = chargers.filter((c) => c.chargeMode === 'solar_price' || c.chargeMode === 'solar_lowtariff');
    if (!relevant.length) return [];
    const now = Date.now();
    return relevant.map((c) => {
      const phases        = c.phaseSwitch ? 3 : c.phases;
      const chargerPowerW = c.maxAmps * phases * 230;
      if (c.chargeMode === 'solar_price') {
        const car      = this._carForCharger(c);
        const decision = this._priceShouldChargeNow(car, chargerPowerW, cfg, now);
        return {
          id: c.id, chargeMode: 'solar_price', carName: (car && car.name) || null,
          shouldChargeNow: decision.shouldCharge, reason: decision.reason, chargeSlots: decision.chargeSlots || [],
        };
      }
      // solar_lowtariff — a fixed weekday window, not a forecast-driven slot selection,
      // so there's no "chargeSlots" list to plan — just today's configured window state.
      const dual = this._dualTariffWindow(cfg);
      return { id: c.id, chargeMode: 'solar_lowtariff', configured: dual.configured, isLowNow: dual.configured && !dual.isHigh };
    });
  }

  async _getHouseW(cfg, gridW, pvW, battery, chargers = null) {
    const devices = cfg.house_devices || [];
    if (devices.length) {
      const vals  = await Promise.all(devices.map((d) =>
        this._cap(d.id, d.cap_power || 'measure_power'),
      ));
      const valid = vals.filter((v) => v !== null && v >= 0);
      return valid.length ? valid.reduce((a, b) => a + b, 0) : null;
    }
    // Fallback: energy balance PV + grid − battery − chargers = house
    // Subtract charger consumption so the displayed house load doesn't include the EV charger.
    // Prefer the MEASURED charger power (already fetched this tick) over the amps×phases
    // estimate: a self-capping car draws less than requested, and overstating chargerW
    // understates houseW → the PV cross-check budget would over-allocate.
    if (gridW === null) return null;
    let chargerW = 0;
    if (Array.isArray(chargers) && chargers.length) {
      chargerW = chargers.reduce((s, c) => s + (c.rawPowerW ?? c.powerW ?? 0), 0);
    } else {
      for (const st of this._chargerStates.values()) {
        if (st.currentAmps != null && st.currentPhases != null) {
          chargerW += st.currentAmps * st.currentPhases * 230;
        }
      }
    }
    return Math.max(0, (pvW ?? 0) + gridW - (battery.powerW ?? 0) - chargerW);
  }

  async _getPvW(cfg) {
    const devices = cfg.inverter_devices || [];
    if (!devices.length) return null;
    const vals  = await Promise.all(devices.map((d) =>
      this._cap(d.id, d.cap_power || 'measure_power'),
    ));
    const valid = vals.filter((v) => v !== null && v >= 0); // PV is never negative
    return valid.length ? valid.reduce((a, b) => a + b, 0) : null;
  }

  async _getGridW(cfg) {
    const devices = cfg.meter_devices || [];
    if (!devices.length) {
      if (!this._loggedNoMeterDevices) {
        this.log('[EMS] _getGridW: no meter_devices configured');
        this._loggedNoMeterDevices = true;
      }
      return null;
    }
    const vals  = await Promise.all(devices.map((d) => {
      const cap = d.cap_power || 'measure_power';
      return this._cap(d.id, cap);
    }));
    const valid = vals.filter((v) => v !== null);
    if (!valid.length) {
      // How long the sensor has been silent, not how many ticks were missed. The window
      // this guards is a safety one — the EMS keeps controlling on the last known grid
      // value inside it — so it has to mean the same minute regardless of tick length.
      this._gridSensorFail += 1;
      if (!this._gridSensorFailSince) this._gridSensorFailSince = Date.now();
      const failedMs = Date.now() - this._gridSensorFailSince;
      if (failedMs < GRID_SENSOR_HOLD_MS && this._lastValidGridW !== null) {
        this.log(`[EMS] _getGridW: sensor fail #${this._gridSensorFail} (${Math.round(failedMs / 1000)}s/${GRID_SENSOR_HOLD_MS / 1000}s), using cached ${this._lastValidGridW}W`);
        return this._lastValidGridW; // stale but safe for a short window
      }
      this.log('[EMS] _getGridW: persistent failure, all reads returned null');
      return null;
    }
    const result         = valid.reduce((a, b) => a + b, 0);
    this._lastValidGridW = result;
    this._gridSensorFail = 0;
    this._gridSensorFailSince = null;
    return result;
  }

  async _getChargers(cfg) {
    const cfgs = cfg.chargers || [];
    return Promise.all(cfgs.map(async (c) => {
      const capState = c.cap_state || 'evcharger_charging_state';
      const capPower = c.cap_power || 'measure_power';
      const [rawState, rawPowerW] = await Promise.all([
        this._cap(c.id, capState)
          .then((v) => v !== null ? v : this._cap(c.id, 'onoff')),
        this._cap(c.id, capPower),
      ]);
      const st = this._getChargerState(c.id);
      // When EMS has amps set, use estimated power as a floor — prevents false "no surplus"
      // stop during the startup lag where the charger reports 0 W but the grid meter already
      // sees the draw, collapsing budgetW to near zero.
      const estimatedW = st.currentAmps > 0
        ? st.currentAmps * (st.currentPhases ?? (parseInt(c.ev_phases, 10) || 3)) * 230
        : 0;
      const powerW     = rawPowerW != null ? Math.max(rawPowerW, estimatedW) : estimatedW;
      // rawPowerW is kept separately for the house-load energy balance, where the
      // estimate floor would overstate a self-capping car's real draw.
      // "connected" = car is physically plugged in (Easee: plugged_in_paused / ready_to_charge / car_connected / completed / charging)
      const DISCONNECTED_STATES = new Set(['standby', 'plugged_out', 'unplugged', 'available', 'idle', null, undefined, false]);
      const connected  = !DISCONNECTED_STATES.has(rawState);
      return {
        id:          c.id,
        maxAmps:     parseInt(c.max_amps,  10) || 16,
        minAmps:     parseInt(c.min_amps,  10) || AMPS_LADDER[0],
        connected,
        powerW,
        rawPowerW,
        phases:      parseInt(c.ev_phases, 10) || 3,
        phaseSwitch: c.phase_switch === true,
        // 'solar' (default) | 'solar_offpeak' | 'always'
        chargeMode:  c.charge_mode || 'solar',
        // Optional explicit car↔charger mapping — which configured car charges here.
        // Used for the per-charger "charge target reached" hold; null → heuristic.
        carId:       c.car_id || null,
        // How long a higher amp target must hold before the EMS steps up (anti-thrash).
        // Per-charger; falls back to the global STEP_HOLD_MS default (30 s).
        stepHoldMs:  Math.max(0, Number(c.step_hold_s) || 30) * 1000,
        stepDownHoldMs: Math.max(0, Number(c.step_down_hold_s) || 0) * 1000,
        // Per-device "EMS controls this device" toggle — undefined/missing means
        // enabled (backward-compatible default). See lib/ems/widget.js.
        enabled:     c.enabled !== false,
      };
    }));
  }

  // _batteryZones → lib/ems/battery.js

  // Verbose per-tick logging, gated by the "Debug logging" device setting — off by
  // default (every-tick price/battery decisions would otherwise flood the log).
  // Reads the setting on every call rather than caching it, so toggling it in Homey
  // takes effect immediately without needing a tick-loop restart.
  _debugLog(msg) {
    if (this.getSetting('debug_logging')) this.log(`[EMS:DEBUG] ${msg}`);
  }

  // ─── Charger control ──────────────────────────────────────────────────────

  // ─── Evaluation ───────────────────────────────────────────────────────────

  // ─── Flow trigger on mode change ──────────────────────────────────────────

  async _triggerModeFlow(mode) {
    const flowId = this._getConfig()[`flow_on_${mode}`];
    if (!flowId) return;
    this.log(`[EMS] mode '${mode}' → trigger flow ${flowId}`);
    try { await this._api.triggerFlow(flowId); } catch (err) {
      this.log(`[EMS] mode '${mode}' flow ${flowId} failed: ${err.message}`);
    }
  }

  // ─── Scheduler ───────────────────────────────────────────────────────────

  // _checkScheduler / _priceWallClock / _getCurrentPrice / _applyPriceCurrencyUnit
  // / _updatePriceCapability → lib/ems/price.js

  // ─── State helpers ────────────────────────────────────────────────────────

  // Buffered: one tick may evaluate several device types, each proposing a mode
  // (e.g. the charger says "holding", the pool says "solar_pool"). Only the LAST
  // proposal of the tick is applied in _flushMode — otherwise the mode flaps back
  // and forth every tick, spamming history, the mode trigger and the mode flow.
  _setMode(mode, newStatusText = null) {
    this._tickMode = { mode, text: newStatusText };
  }

  // Applies the tick's final mode: capability, trigger, mode flow and history.
  async _flushMode() {
    const m = this._tickMode;
    this._tickMode = null;
    if (!m) return;
    this._diag.mode = m.mode; this._diag.modeText = m.text; this._diag.decidedAt = Date.now();
    if (m.text != null) await this._set('ems_status_text', m.text);
    const prev = this.getCapabilityValue('ems_mode');
    await this._set('ems_mode', m.mode);
    if (!this._warmupDone) return; // first tick: observe only
    if (prev !== m.mode) {
      this.log(`[EMS] mode: ${prev ?? '—'} → ${m.mode} → trigger ems_mode_changed`);
      this.homey.flow.getDeviceTriggerCard('ems_mode_changed').trigger(this, { mode: m.mode }).catch(() => {});
      await this._triggerModeFlow(m.mode);
    }
    if (m.mode !== this._lastLoggedMode) {
      const label = m.text != null ? m.text : (this.getCapabilityValue('ems_status_text') || '');
      this._addHistoryEvent(HIST.MODE, m.mode, label);
      this._lastLoggedMode = m.mode;
    }
  }

  async _set(cap, value) {
    if (!this.hasCapability(cap) || this.getCapabilityValue(cap) === value) return;
    await this.setCapabilityValue(cap, value).catch(() => {});
  }

  // _postNotification / _addHistoryEvent / _saveHistory / getEmsHistory → lib/ems/history.js

  async _ensureCapabilities() {
    // charge_now used to be uiComponent "button" with getable:false — a momentary push
    // button that fell back the instant it was pressed, so instant charging could never
    // stay on. It is a toggle now, but an existing device keeps the options it was created
    // with: changing app.json alone does nothing here. Drop and re-add it once so the new
    // options take effect. Guarded by a store flag so it happens exactly one time.
    if (this.hasCapability('charge_now') && !this.getStoreValue('chargeNowIsToggle')) {
      this.log('[EMS] migrating charge_now from button to toggle');
      await this.removeCapability('charge_now').catch(() => {});
      await this.addCapability('charge_now').catch((e) => this.error('[EMS] re-add charge_now failed:', e));
      await this.setStoreValue('chargeNowIsToggle', true).catch(() => {});
    }
    if (this.hasCapability('measure_power.surplus')) await this.removeCapability('measure_power.surplus').catch(() => {});
    if (this.hasCapability('measure_power.grid'))    await this.removeCapability('measure_power.grid').catch(() => {});
    if (this.hasCapability('measure_power.pv'))      await this.removeCapability('measure_power.pv').catch(() => {});
    if (this.hasCapability('measure_power.house'))   await this.removeCapability('measure_power.house').catch(() => {});
    if (this.hasCapability('measure_ev_budget'))     await this.removeCapability('measure_ev_budget').catch(() => {});
    // Legacy base car caps (no per-car suffix) — superseded by measure_car_soc.<id>
    // / measure_car_target_soc.<id>. Leftover instances show as empty "Auto-Ladestand"
    // / "Auto-Ziel-Ladestand" tiles; the suffix-less ids are never used directly.
    if (this.hasCapability('measure_car_soc'))         await this.removeCapability('measure_car_soc').catch(() => {});
    if (this.hasCapability('measure_car_target_soc'))  await this.removeCapability('measure_car_target_soc').catch(() => {});
    for (const cap of ['ems_mode', 'ems_status_text', 'measure_solar_surplus', 'measure_released_surplus', 'measure_pv_power', 'measure_house_power', 'measure_grid_power', 'measure_battery_power', 'measure_electricity_price', 'offpeak_enabled', 'charge_now']) {
      if (!this.hasCapability(cap)) {
        this.log(`[EMS] addCapability: ${cap}`);
        await this.addCapability(cap).catch((e) => this.error(`[EMS] addCapability ${cap} failed:`, e));
      }
    }
    if (this.getCapabilityValue('offpeak_enabled') === null) {
      const cfg = this._getConfig();
      await this.setCapabilityValue('offpeak_enabled', cfg.offpeak_enabled === true)
        .catch((e) => this.error('[EMS] setCapabilityValue offpeak_enabled failed:', e));
    }
    if (this.getCapabilityValue('charge_now') === null) {
      await this.setCapabilityValue('charge_now', false)
        .catch((e) => this.error('[EMS] setCapabilityValue charge_now failed:', e));
    }
  }

  // _offpeakWindow / _parseTime → lib/ems/price.js
  // _persistExportLimit / _fireExportLimitTrigger / _evaluateExportLimit → lib/ems/exportLimit.js

}

// ─── Mixins ───────────────────────────────────────────────────────────────
// Attach the extracted method groups to the prototype. `this` inside them is the
// device instance exactly as if they were defined in the class body.
Object.assign(
  EmsDevice.prototype,
  historyMixin,
  timingMixin,
  priceMixin,
  exportLimitMixin,
  carsMixin,
  simpleDevicesMixin,
  chargerControlMixin,
  batteryMixin,
  pvForecastMixin,
  priceForecastMixin,
  chargeSessionsMixin,
  chargerStateMixin,
  deviceDiagMixin,
  widgetMixin,
);

// Every saved settings page in the log and the change log — see lib/change-log.js.
withSettingsLog(EmsDevice);

module.exports = EmsDevice;
