'use strict';

const { App }             = require('homey');
const OpenAPICoordinator  = require('./lib/openapi-coordinator');

class FusionSolarApp extends App {

  async onInit() {
    this._appLogBuffer = [];
    this._wrapLogger(); // capture stdout/stderr into the ring buffer for the Settings → Logs tab
    this.log('FusionSolar app is running...');

    this._coordinator = new OpenAPICoordinator(this.homey);

    // sun2000_set_export_limit_enabled is registered in sun2000_modbus/device.js
    // (writes register 47415 directly). A second registration here would override
    // it with a broken variant: setCapabilityValue never fires capability listeners.

    this.homey.flow
      .getConditionCard('is_producing')
      .registerRunListener(async ({ device }) => {
        const power = device.getCapabilityValue('measure_power');
        return typeof power === 'number' && power > 0;
      });

    this.homey.flow
      .getConditionCard('modbus_is_producing')
      .registerRunListener(async ({ device }) => {
        const power = device.getCapabilityValue('measure_power');
        return typeof power === 'number' && power > 0;
      });

    // EMS Solcast forecast conditions — read the forecast helpers on the EMS device.
    this.homey.flow
      .getConditionCard('ems_pv_forecast_today')
      .registerRunListener(async ({ device, kwh }) => device._pvForecastRemainingTodayKwh() > kwh);

    this.homey.flow
      .getConditionCard('ems_pv_forecast_next_hours')
      .registerRunListener(async ({ device, hours, kwh }) => device._pvForecastNextKwh(hours) > kwh);

    // "below" phrasing: true when the remaining forecast until the cutoff is below kwh.
    this.homey.flow
      .getConditionCard('ems_pv_forecast_until')
      .registerRunListener(async ({ device, cutoff, kwh }) => device._pvForecastUntilKwh(cutoff) < kwh);

    this._scheduleMidnightBaseline();
    this._ensureTodayBaseline();

    // Sensor-chart: initialise in-memory rolling history after drivers are ready
    this._capHistory       = new Map();
    this._capHistoryInited = false;
    this._registerSensorChartAutocomplete();
    this.homey.setTimeout(() => this._initCapHistory(), 5000);
    this._registerEmsDeviceAutocomplete();

    // EMS charger triggers — global cards, filter by charger_device_id arg vs state
    this.homey.flow
      .getTriggerCard('ems_set_charger_current')
      .registerRunListener((args, state) => args.charger_device_id === state.charger_device_id);
    this.homey.flow
      .getTriggerCard('ems_start_charger')
      .registerRunListener((args, state) => args.charger_device_id === state.charger_device_id);
    // Every EMS trigger card carries a device-id argument; a card with arguments
    // NEEDS a run listener or flows built on it never fire (field-caught: the
    // dehumidifier stop flow never ran — only heat pump/charger had listeners).
    const emsDeviceTriggers = {
      ems_start_heat_pump:           'heat_pump_device_id',
      ems_stop_heat_pump:            'heat_pump_device_id',
      ems_start_boiler:              'boiler_device_id',
      ems_stop_boiler:               'boiler_device_id',
      ems_start_pool:                'pool_device_id',
      ems_stop_pool:                 'pool_device_id',
      ems_start_dehumidifier:        'dehumidifier_device_id',
      ems_stop_dehumidifier:         'dehumidifier_device_id',
      ems_start_aircon:              'aircon_device_id',
      ems_stop_aircon:               'aircon_device_id',
      ems_battery_full:              'battery_device_id',
      ems_battery_low:               'battery_device_id',
      // Battery price control (_checkBatteryPriceControl → TRIGGER_BY_MODE). Same
      // omission as the dehumidifier above, and just as invisible: the EMS fired these
      // three, the log said "price mode → charge", and the user's flow never ran.
      ems_battery_force_charge:        'battery_device_id',
      ems_battery_max_discharge_power: 'battery_device_id',
      ems_battery_normal_mode:         'battery_device_id',
      // Placeholders by design, not omissions: EMS Setup Flows builds a scaffold flow
      // whose WHEN the user replaces (each card says so in its own hint). Nothing fires
      // these — they are listed anyway so the rule above holds without exceptions. An
      // exception list is what let the three above sit unnoticed since 1.2.38.
      ems_battery_force_discharge:     'battery_device_id',
      ems_battery_max_charge_power:    'battery_device_id',
      ems_inverter_export_limit_on:  'inverter_device_id',
      ems_inverter_export_limit_off: 'inverter_device_id',
      ems_inverter_set_power_w:        'inverter_device_id',
      ems_inverter_set_power_pct:      'inverter_device_id',
      ems_inverter_remove_limit:       'inverter_device_id',
    };
    for (const [cardId, argName] of Object.entries(emsDeviceTriggers)) {
      this.homey.flow
        .getTriggerCard(cardId)
        .registerRunListener((args, state) => args[argName] === state[argName]);
    }

    // Car target-charge trigger — matched by car id + optional target-% filter
    // (so per-value flows like "set 80%" / "set 100%" fire independently).
    this.homey.flow
      .getTriggerCard('ems_set_car_target')
      .registerRunListener(FusionSolarApp.matchCarTarget);
  }

  /**
   * Does this ems_set_car_target flow apply to the target the EMS just set?
   *
   * The card is shared by several flows at once — the generated "Set charge 80/90/100%"
   * ones differ only in their target_pct argument — which is why it needs a matcher at all
   * where the other EMS triggers do not.
   *
   * An empty filter means "any target", which is what app.json promises the user in the
   * argument's own label ("leave empty for any"). The EMS device used to register a second
   * listener for this same card that lacked that case, so Homey logged "Run listener was
   * already registered" on every start and a hand-built flow with the field left blank
   * never fired. One listener now, and it lives with the card's siblings rather than
   * inside a device that can be deleted and re-paired.
   *
   * Compared as strings throughout: the argument is declared type "text" and the state is
   * built with String().
   */
  static matchCarTarget(args, state) {
    if (String(args.car_device_id ?? '') !== String(state.car_device_id ?? '')) return false;
    if (args.target_pct == null || String(args.target_pct).trim() === '') return true;
    return String(args.target_pct).trim() === String(state.target_pct ?? '').trim();
  }

  async onUninit() {
    this.log('FusionSolar app is stopping...');
    if (this._midnightTimer)       this.homey.clearTimeout(this._midnightTimer);
    if (this._baselineTimer)       this.homey.clearTimeout(this._baselineTimer);
    if (this._capHistoryPollTimer) this.homey.clearInterval(this._capHistoryPollTimer);
    this._saveCapHistory(); // persist before shutdown
  }


  /**
   * Schedules a snapshot of cumulative grid counters every midnight.
   * Stored in homey.settings so the energy-balance widget can compute daily deltas.
   * Uses the Homey timezone so midnight fires at local 00:00 regardless of the
   * Node.js process timezone (which is UTC on Homey Pro).
   */
  _scheduleMidnightBaseline() {
    const msUntilMidnight = this._msUntilLocalMidnight();

    this._midnightTimer = this.homey.setTimeout(() => {
      this._saveMidnightBaseline();
      // Re-schedule for the next midnight
      this._scheduleMidnightBaseline();
    }, msUntilMidnight);

    this.log(`Midnight baseline scheduled in ${Math.round(msUntilMidnight / 60000)} min (tz: ${this._getHomeyTz()})`);
  }

  /** Returns the Homey timezone string (IANA), falling back to 'UTC'. */
  _getHomeyTz() {
    try { return this.homey.clock.getTimezone() || 'UTC'; } catch { return 'UTC'; }
  }

  /**
   * Milliseconds until 00:00:05 of the next calendar day in the Homey timezone.
   * Node.js runs UTC — we use Intl.DateTimeFormat to read the current wall-clock
   * time in the local timezone and compute the offset to the next midnight.
   */
  _msUntilLocalMidnight() {
    const tz  = this._getHomeyTz();
    const now = new Date();

    // Extract current time-of-day parts in the Homey timezone
    const parts = new Intl.DateTimeFormat('en', {
      timeZone: tz,
      hour: 'numeric', minute: 'numeric', second: 'numeric',
      hour12: false,
    }).formatToParts(now);

    const get = type => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);
    const secsElapsed = get('hour') * 3600 + get('minute') * 60 + get('second');
    // 5-second buffer past midnight
    return (86400 - secsElapsed + 5) * 1000;
  }

  /**
   * On app start: if no baseline exists for today yet, write one.
   *
   * Two things used to go wrong here, both visible in field log 9c7e4414 (2026-08-21),
   * where "No baseline for today yet – writing initial baseline" appeared after every one
   * of four app starts on the same day.
   *
   * The line announced the write BEFORE knowing whether one was possible. That installation
   * has no SUN2000 device at all, so _saveMidnightBaseline had nothing to read and wrote
   * nothing — leaving a log line claiming an action that never happened, on every start,
   * forever. The announcement now comes after the attempt and says what actually occurred.
   *
   * The second is worse and was not reported, because it is silent: the attempt was a single
   * shot 10 s after start. Ten seconds is a guess at how long a driver needs for its first
   * poll, and on a slow or briefly unreachable inverter it is too short. The counters read
   * null, nothing was written, and nothing tried again — so that whole day had no baseline
   * and the energy-balance widget's daily delta was wrong until the next midnight. It now
   * retries on a widening schedule and gives up only after ~21 minutes, saying why.
   *
   * No retry when no source device is paired: that is not a race, and repeating it would
   * only restate a fact that cannot change while the app runs.
   */
  _ensureTodayBaseline(attempt = 0) {
    const DELAYS_MS = [10_000, 60_000, 5 * 60_000, 15 * 60_000];
    if (attempt >= DELAYS_MS.length) return;

    this._baselineTimer = this.homey.setTimeout(() => {
      const today  = this._todayStr();
      const stored = (key) => { try { return this.homey.settings.get(key); } catch { return null; } };
      const exportStored = stored('eb_grid_export_baseline');
      const importStored = stored('eb_grid_import_baseline');
      if (exportStored && exportStored.date === today
       && importStored && importStored.date === today) return; // already complete

      const result = this._saveMidnightBaseline();
      if (result.written.length === 2) return;                 // done, it logged its own lines

      if (result.reason === 'no-reading' && attempt + 1 < DELAYS_MS.length) {
        this._ensureTodayBaseline(attempt + 1);
        return;
      }

      const totalMin = Math.round(DELAYS_MS.reduce((a, b) => a + b, 0) / 60000);
      this.log(result.reason === 'no-source'
        ? 'No baseline for today: no inverter or grid meter is paired that carries cumulative grid counters, so there is nothing to snapshot'
        : `No baseline for today: the grid counters were still unread after ${totalMin} min — the energy-balance widget's daily delta will be off until tomorrow`);
    }, DELAYS_MS[attempt]);
  }

  /**
   * Snapshots the cumulative grid counters for today.
   *
   * Returns what it managed to do, so the caller can tell a race from a dead end:
   *   { written: ['export','import'], reason: null }        both stored
   *   { written: [],                  reason: 'no-source' } nothing to read from
   *   { written: [...],               reason: 'no-reading'} source present, counter null
   * The midnight timer ignores the return; _ensureTodayBaseline uses it to decide whether
   * trying again could possibly help.
   */
  _saveMidnightBaseline() {
    const written = [];
    try {
      const today = this._todayStr();
      const sun2000     = this._getDevice('sun2000_modbus');
      const sun2000emma = this._getDevice('sun2000_emma_modbus');
      const pmOa        = this._getDevice('powermeter_openapi_fusionsolar');
      const sunOa       = this._getDevice('sun2000_openapi_fusionsolar');
      if (!sun2000 && !sun2000emma && !pmOa && !sunOa) return { written, reason: 'no-source' };

      // Cumulative grid counters — MUST use the same source priority as the
      // energy-balance widget's rawExport/rawImport (sun2000 → sun2000emma →
      // powermeter OpenAPI → sun2000 OpenAPI), otherwise baseline and live value
      // come from different meters and the daily delta is wrong. The EMMA power
      // meter needs no baseline: it has native daily counters the widget falls
      // back to directly.
      //
      // The OpenAPI pair names these counters differently — meter_power is the import
      // total and meter_power.exported the export total — so each is read by its own
      // name. Reading meter_power from the OpenAPI inverter as an EXPORT figure would
      // silently baseline the import counter against the export one.
      const gridExport = this._cap(sun2000, 'meter_power.grid_export')
                      ?? this._cap(sun2000emma, 'meter_power.grid_export')
                      ?? this._cap(pmOa, 'meter_power.exported')
                      ?? this._cap(sunOa, 'meter_power.exported');
      const gridImport = this._cap(sun2000, 'meter_power.grid_import')
                      ?? this._cap(sun2000emma, 'meter_power.grid_import')
                      ?? this._cap(pmOa, 'meter_power')
                      ?? this._cap(sunOa, 'meter_power');

      if (gridExport !== null) {
        this.homey.settings.set('eb_grid_export_baseline', { date: today, baseline: gridExport });
        this.log(`Midnight baseline saved – export: ${gridExport} kWh`);
        written.push('export');
      }
      if (gridImport !== null) {
        this.homey.settings.set('eb_grid_import_baseline', { date: today, baseline: gridImport });
        this.log(`Midnight baseline saved – import: ${gridImport} kWh`);
        written.push('import');
      }
    } catch (err) {
      this.error('Failed to save midnight baseline:', err.message);
    }
    return { written, reason: written.length === 2 ? null : 'no-reading' };
  }

  _getDevice(driverId) {
    try {
      const driver  = this.homey.drivers.getDriver(driverId);
      const devices = driver.getDevices();
      return devices.length > 0 ? devices[0] : null;
    } catch { return null; }
  }

  _cap(device, id) {
    if (!device) return null;
    try { return device.getCapabilityValue(id) ?? null; } catch { return null; }
  }

  /** Returns today's date as "YYYY-MM-DD" in the Homey (local) timezone. */
  _todayStr() {
    // en-CA locale formats as YYYY-MM-DD which is exactly what we need
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this._getHomeyTz(),
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  }

  getCoordinator() {
    return this._coordinator;
  }

  // ─── App log ring buffer (Settings → Logs tab) ────────────────────────────
  // Mirrors everything written to stdout/stderr (this.log/this.error of the app,
  // every driver and every device) into an in-memory ring buffer, exposed via
  // GET /log. The original streams are untouched — `homey app run` sees it all.

  static get APP_LOG_MAX() { return 1500; }

  // Homey's own leading stamp, e.g. "2026-08-15T08:06:34.144Z ". Stripped so it can be
  // replaced by a local one.
  static get LEADING_ISO() { return /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/; }

  _wrapLogger() {
    const origStdout = process.stdout.write.bind(process.stdout);
    const origStderr = process.stderr.write.bind(process.stderr);
    const capture = (chunk, level) => {
      try {
        chunk.toString().split('\n').filter(Boolean).forEach((line) => this._pushAppLog(line, level));
      } catch (e) { /* logging must never crash the app */ }
    };
    process.stdout.write = (chunk, ...args) => { capture(chunk, 'log'); return origStdout(chunk, ...args); };
    process.stderr.write = (chunk, ...args) => { capture(chunk, 'err'); return origStderr(chunk, ...args); };
  }

  /**
   * Timestamp for a buffered log line: local date and time, whole seconds.
   *
   * Homey stamps its own lines in UTC with milliseconds, and neither helps the person
   * reading their own log — they think in the time on their kitchen clock, and a Modbus
   * poll is not a millisecond-scale event. The `sv-SE` locale is used only because it
   * formats as "2026-08-15 08:06:34"; dropping the T and the Z is also the signal that
   * this is no longer UTC.
   *
   * Formatter cached because this runs on every single line written by the app.
   */
  _logStamp(now = new Date()) {
    try {
      if (!this._logStampFmt) {
        this._logStampFmt = new Intl.DateTimeFormat('sv-SE', {
          timeZone: this.homey.clock.getTimezone(),
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        });
      }
      return this._logStampFmt.format(now);
    } catch (e) {
      // No clock yet, or an unknown zone: UTC is still better than no timestamp, and the
      // milliseconds go either way.
      return now.toISOString().slice(0, 19).replace('T', ' ');
    }
  }

  _pushAppLog(msg, level) {
    // Rewritten rather than only added when missing: Homey's own stamp is UTC and carries
    // milliseconds, so leaving it in place would mean half the log reads in one time and
    // half in another. Done here rather than in the settings page so the Copy button stays
    // honest — what you read and what you paste are the same string.
    const m = FusionSolarApp.LEADING_ISO.exec(msg);
    // When Homey stamped the line, that stamp is when the line happened — reformat that
    // instant rather than substituting the moment we happened to capture it. One write can
    // carry several lines, and using "now" for all of them would collapse them onto a
    // single time.
    const at = m ? new Date(m[0].trim()) : new Date();
    const line = `${this._logStamp(Number.isNaN(at.getTime()) ? new Date() : at)} ${m ? msg.slice(m[0].length) : msg}`;
    this._appLogBuffer.push({ line, level });
    if (this._appLogBuffer.length > FusionSolarApp.APP_LOG_MAX) this._appLogBuffer.shift();
  }

  getAppLog() {
    return this._appLogBuffer;
  }

  clearAppLog() {
    this._appLogBuffer = [];
  }

  // ── Sensor-chart: capability history ──────────────────────────────────────

  /**
   * Returns true for capabilities that are meaningful to chart.
   * Limits the list to measure_*, meter_* and target_* — excludes alarm booleans,
   * status enums, module counts, etc.
   */
  /** Capabilities tracked and offered in the Sensor Chart autocomplete. */
  static _isMeaningfulCap(capId) {
    return capId === 'measure_power'
        || capId === 'measure_power.load';
  }

  /**
   * Register autocomplete listeners for the sensor-chart widget's series1–4 settings.
   * Called once from onInit() — safe to call before any device is ready.
   */
  _registerSensorChartAutocomplete() {
    try {
      const widget = this.homey.dashboards.getWidget('sensor-chart');

      const handler = async (query) => {
        const results = [];
        try {
          const drivers = this.homey.drivers.getDrivers();
          for (const driver of Object.values(drivers)) {
            try {
              for (const device of driver.getDevices()) {
                const deviceId   = device.getData().id;
                const deviceName = device.getName();
                if (!deviceId) continue;

                for (const capId of device.getCapabilities()) {
                  if (!FusionSolarApp._isMeaningfulCap(capId)) continue;
                  const val = device.getCapabilityValue(capId);
                  if (typeof val !== 'number') continue;

                  const id   = `${deviceId}::${capId}`;
                  const name = deviceName; // device name as label suggestion

                  if (!query || query.length === 0
                      || name.toLowerCase().includes(query.toLowerCase())) {
                    results.push({ id, name, description: `${fmtVal(val)} W` });
                  }
                }
              }
            } catch (e) { /* skip unavailable driver */ }
          }
        } catch (e) {
          this.error('sensor-chart autocomplete error:', e.message);
        }
        return results;
      };

      for (const s of ['series1', 'series2', 'series3', 'series4']) {
        widget.registerSettingAutocompleteListener(s, handler);
      }
      this.log('sensor-chart: autocomplete registered (series1–4)');
    } catch (e) {
      this.error('sensor-chart: autocomplete registration failed:', e.message);
    }

    /** Small inline helper — format a numeric value compactly */
    function fmtVal(v) {
      if (v === null || v === undefined) return '—';
      const a = Math.abs(v);
      if (a >= 1000) return (v / 1000).toFixed(1) + ' kW';
      return v.toFixed(1);
    }
  }

  // ── ems-device widget: controllable-device picker ──────────────────────

  /**
   * Register the autocomplete listener for the ems-device widget's "device"
   * setting — searches every EV charger and simple device (heat pump/boiler/
   * pool/dehumidifier) configured on the EMS driver's device. Called once from
   * onInit() — safe to call before the EMS device is ready (falls back to an
   * empty list until it is).
   */
  _registerEmsDeviceAutocomplete() {
    const KIND_LABEL = {
      charger: { en: 'EV charger', de: 'EV-Lader', nl: 'EV-lader' },
      heat_pump: { en: 'Heat pump', de: 'Wärmepumpe', nl: 'Warmtepomp' },
      boiler: { en: 'Boiler', de: 'Boiler', nl: 'Boiler' },
      pool: { en: 'Pool', de: 'Pool', nl: 'Zwembad' },
      dehumidifier: { en: 'Dehumidifier', de: 'Entfeuchter', nl: 'Ontvochtiger' },
      aircon: { en: 'Air conditioner', de: 'Klimaanlage', nl: 'Airco' },
    };
    try {
      const widget = this.homey.dashboards.getWidget('ems-device');
      const lang   = this.homey.i18n.getLanguage() || 'en';

      widget.registerSettingAutocompleteListener('device', async (query) => {
        try {
          const driver  = this.homey.drivers.getDriver('energy_management');
          const devices = driver.getDevices();
          if (!devices.length) return [];
          const list = await devices[0].getEmsControllableDevices();
          const q    = (query || '').toLowerCase();
          return list
            .filter((d) => !q || d.name.toLowerCase().includes(q))
            .map((d) => ({
              id: d.id,
              name: d.name,
              description: (KIND_LABEL[d.kind] && (KIND_LABEL[d.kind][lang] || KIND_LABEL[d.kind].en)) || d.kind,
            }));
        } catch (e) {
          this.error('ems-device autocomplete error:', e.message);
          return [];
        }
      });
      this.log('ems-device: autocomplete registered');
    } catch (e) {
      this.error('ems-device: autocomplete registration failed:', e.message);
    }
  }

  // Max data points kept per series in RAM and persisted to settings.
  // 1 500 pts × 60 s = 25 h; compact JSON ≈ 40 KB — well within the settings limit.
  static get CAP_HISTORY_MAX() { return 1500; }

  /**
   * Initialise rolling capability history and start the 60 s polling timer.
   * Called 5 s after app start so drivers have completed their first poll.
   * Guarded by _capHistoryInited — safe to call multiple times.
   */
  _initCapHistory() {
    if (this._capHistoryInited) return;
    this._capHistoryInited = true;

    // Restore persisted history from settings before taking the first snapshot
    this._loadCapHistory();

    // Snapshot current values immediately, then every 60 s
    this._snapshotAllCaps();
    this.log(`sensor-chart: ${this._capHistory.size} series in history`);

    this._capHistoryPollCount  = 0;
    this._capHistoryPollTimer  = this.homey.setInterval(() => {
      this._snapshotAllCaps();
      // Persist every 5 minutes (5 × 60 s ticks)
      this._capHistoryPollCount++;
      if (this._capHistoryPollCount % 5 === 0) this._saveCapHistory();
    }, 60 * 1000);
  }

  /**
   * Load persisted history from homey.settings into _capHistory.
   * Settings key format: sch_hist_<logId>
   * Stored value:        [[timestamp_ms, value], ...]
   */
  _loadCapHistory() {
    let loaded = 0;
    // Collected while walking the currently paired devices, then handed to the orphan
    // cleanup below — the same walk answers both "what do I restore" and "what is stale".
    const validLogIds = new Set();
    let enumerationComplete = true;
    try {
      const drivers = this.homey.drivers.getDrivers();
      for (const driver of Object.values(drivers)) {
        try {
          for (const device of driver.getDevices()) {
            const deviceId = device.getData().id;
            if (!deviceId) continue;

            for (const capId of device.getCapabilities()) {
              if (!FusionSolarApp._isMeaningfulCap(capId)) continue;

              const logId = `${deviceId}::${capId}`;
              validLogIds.add(logId);
              const raw   = this.homey.settings.get(`sch_hist_${logId}`);
              if (!Array.isArray(raw) || raw.length === 0) continue;

              // Keep the timestamp as epoch ms, exactly as persisted. It used to be
              // inflated into a 24-character ISO string per point — several times the
              // memory of a number, for a value that is only ever compared and
              // re-serialised numerically.
              const points = raw.map(([t, v]) => ({ t: Number(t), v }));
              this._capHistory.set(logId, points);
              loaded++;
            }
          }
        } catch (e) { enumerationComplete = false; /* skip unavailable driver */ }
      }
      if (loaded > 0) this.log(`sensor-chart: restored ${loaded} series from settings`);
    } catch (e) {
      enumerationComplete = false;
      this.error('sensor-chart: _loadCapHistory error:', e.message);
    }
    this._pruneOrphanCapHistory(validLogIds, enumerationComplete);
  }

  /**
   * Delete persisted series (`sch_hist_<logId>`) whose device or capability no longer
   * exists. _loadCapHistory only ever restores series for currently paired devices, so
   * an orphan is invisible in memory but stays in homey.settings forever — every removed
   * or re-paired device left ~1500 points behind, accumulating silently across years.
   *
   * Deliberately conservative: skipped whenever the device walk above hit an error, and
   * never run on an empty device list (far more likely a startup-timing artefact than the
   * user genuinely having removed every device). A wrongly deleted key costs real history.
   *
   * @param {Set<string>} validLogIds        logIds backed by a currently paired device
   * @param {boolean}     enumerationComplete false if any driver/device lookup threw
   */
  _pruneOrphanCapHistory(validLogIds, enumerationComplete) {
    if (!enumerationComplete) {
      this.log('sensor-chart: skipping orphan cleanup — device list was incomplete this start');
      return;
    }
    if (validLogIds.size === 0) return;
    try {
      const PREFIX = 'sch_hist_';
      const keys = this.homey.settings.getKeys() || [];
      let removed = 0;
      for (const key of keys) {
        if (!key.startsWith(PREFIX)) continue;
        if (validLogIds.has(key.slice(PREFIX.length))) continue;
        this.homey.settings.unset(key);
        removed++;
      }
      if (removed) this.log(`sensor-chart: removed ${removed} orphaned history series from settings`);
    } catch (e) {
      this.error('sensor-chart: orphan cleanup failed:', e.message);
    }
  }

  /**
   * Persist all series from _capHistory to homey.settings.
   * Each series is stored as compact [[timestamp_ms, value], ...] array.
   */
  _saveCapHistory() {
    if (!this._capHistory || this._capHistory.size === 0) return;
    try {
      for (const [logId, points] of this._capHistory.entries()) {
        // p.t is already epoch ms — no Date round-trip needed.
        const compact = points.map((p) => [p.t, Math.round(p.v * 100) / 100]);
        this.homey.settings.set(`sch_hist_${logId}`, compact);
      }
      // Every five minutes, forever, this said the same thing — ~290 lines a day confirming
      // that a periodic save ran, in a log that holds 1500. What is worth knowing is when
      // the set of series changes, which happens when the user adds or removes one.
      if (this._capHistory.size !== this._capHistorySizeLogged) {
        this._capHistorySizeLogged = this._capHistory.size;
        this.log(`sensor-chart: saving ${this._capHistory.size} series to settings`);
      }
    } catch (e) {
      this.error('sensor-chart: _saveCapHistory error:', e.message);
    }
  }

  /**
   * Snapshot the current value of every tracked capability and append it to
   * the rolling buffer.  Also auto-discovers devices added after app start.
   */
  _snapshotAllCaps() {
    if (!this._capHistory) return;
    // Epoch ms, not an ISO string: this value is written once per point per minute and
    // only ever compared/serialised numerically, so a string was pure overhead.
    const now = Date.now();
    const max = FusionSolarApp.CAP_HISTORY_MAX;
    try {
      const drivers = this.homey.drivers.getDrivers();
      for (const driver of Object.values(drivers)) {
        try {
          for (const device of driver.getDevices()) {
            const deviceId = device.getData().id;
            if (!deviceId) continue;

            for (const capId of device.getCapabilities()) {
              if (!FusionSolarApp._isMeaningfulCap(capId)) continue;
              const val = device.getCapabilityValue(capId);
              if (typeof val !== 'number') continue;

              const logId = `${deviceId}::${capId}`;
              let pts = this._capHistory.get(logId);
              if (!pts) { pts = []; this._capHistory.set(logId, pts); }

              pts.push({ t: now, v: val });
              if (pts.length > max) pts.splice(0, pts.length - max);
            }
          }
        } catch (e) { /* skip unavailable driver */ }
      }
    } catch (e) {
      this.error('sensor-chart: _snapshotAllCaps error:', e.message);
    }
  }

  /**
   * Called by widgets/sensor-chart/api.js — returns filtered history for up
   * to four capability series.
   *
   * @param {object} query  URL query params: s1–s4 (autocomplete ids), hours
   * @returns {{ series: Array<{id, points}> }}
   */
  getSensorChartData(query) {
    const hours  = Math.max(1, parseFloat(query.hours) || 24);
    const cutoff = Date.now() - hours * 3600 * 1000;
    const series = [];

    for (const key of ['s1', 's2', 's3', 's4']) {
      const id = query[key];
      if (!id) continue;

      const points   = this._capHistory ? (this._capHistory.get(id) || []) : [];
      const filtered = points.filter((p) => p.t >= cutoff);
      series.push({ id, points: filtered });
    }

    return { series };
  }

}

module.exports = FusionSolarApp;
