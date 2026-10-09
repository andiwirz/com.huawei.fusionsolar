'use strict';

const { App }             = require('homey');
const OpenAPICoordinator  = require('./lib/openapi-coordinator');
const changeLog           = require('./lib/change-log');
const { downsample }      = require('./lib/chart-downsample');
const { isReachable }     = require('./lib/widget-data');
const localTime           = require('./lib/local-time');

class FusionSolarApp extends App {

  async onInit() {
    this._appLogBuffer = [];
    this._wrapLogger(); // capture stdout/stderr into the ring buffer for the Settings → Logs tab
    // Before any driver registers a card: every action card logs what it was asked to do,
    // and why it refused — see lib/change-log.js.
    changeLog.wrapFlowCards(this.homey, (...a) => this.log(...a));
    // The version, because a pasted log is how a problem arrives — and twice now the
    // answer to "which build is this?" had to be reconstructed from commit timestamps,
    // once leading straight to the wrong conclusion.
    const version = this.homey.manifest && this.homey.manifest.version;
    this.log(`FusionSolar app${version ? ` v${version}` : ''} is running...`);

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
    this._capHistoryCoarse = new Map();
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
   *
   * From the real next local midnight (lib/local-time.js), not 86 400 s minus the time
   * gone: on the 25-hour day in October that fired at 23:00:05 and wrote tomorrow's
   * baseline an hour early, on the 23-hour day in March an hour late (1.2.299).
   * Node.js runs UTC — we use Intl.DateTimeFormat to read the current wall-clock
   * time in the local timezone and compute the offset to the next midnight.
   */
  _msUntilLocalMidnight(nowMs = Date.now()) {
    const tz = localTime.safeTz(this._getHomeyTz());
    return localTime.nextLocalMidnight(tz, nowMs) - nowMs + 5000;
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
      // An iSitePower plant also needs its PV and house baselines (1.2.300).
      const extraDone = (key, driverId) => !this._getDevice(driverId)
        || (stored(key) && stored(key).date === today);
      if (exportStored && exportStored.date === today
       && importStored && importStored.date === today
       && extraDone('eb_pv_baseline', 'isitepower_solar_openapi_fusionsolar')
       && extraDone('eb_house_baseline', 'isitepower_home_openapi_fusionsolar')) return; // already complete

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
      // iSitePower keeps lifetime totals only, so its grid, PV and house days are deltas
      // against these baselines too — the two widgets had nothing for it before (1.2.300).
      const ispGrid     = this._getDevice('isitepower_grid_openapi_fusionsolar');
      const ispSolar    = this._getDevice('isitepower_solar_openapi_fusionsolar');
      const ispHome     = this._getDevice('isitepower_home_openapi_fusionsolar');
      if (!sun2000 && !sun2000emma && !pmOa && !sunOa && !ispGrid) return { written, reason: 'no-source' };

      // Cumulative grid counters — MUST use the same source priority as the
      // energy-balance widget's rawExport/rawImport (sun2000 → sun2000emma →
      // powermeter OpenAPI → sun2000 OpenAPI), otherwise baseline and live value
      // come from different meters and the daily delta is wrong. The EMMA power
      // meter needs no baseline: it has native daily counters the widget falls
      // back to directly.
      //
      // The OpenAPI METER still names these meter_power / meter_power.exported, the way
      // the DTSU666 does; the OpenAPI INVERTER was renamed in 1.2.212 to the grid_import /
      // grid_export pair its Modbus twin uses. Each device is therefore read by its own
      // name — reading a plain meter_power off the inverter as an EXPORT figure would
      // silently baseline the import counter against the export one.
      const gridExport = this._cap(sun2000, 'meter_power.grid_export')
                      ?? this._cap(sun2000emma, 'meter_power.grid_export')
                      ?? this._cap(pmOa, 'meter_power.exported')
                      ?? this._cap(sunOa, 'meter_power.grid_export')
                      ?? this._cap(ispGrid, 'meter_power.exported');
      const gridImport = this._cap(sun2000, 'meter_power.grid_import')
                      ?? this._cap(sun2000emma, 'meter_power.grid_import')
                      ?? this._cap(pmOa, 'meter_power')
                      ?? this._cap(sunOa, 'meter_power.grid_import')
                      ?? this._cap(ispGrid, 'meter_power');

      // Not part of the "both written" verdict below: only an iSitePower plant has them.
      const pvTotal    = this._cap(ispSolar, 'meter_power');
      const houseTotal = this._cap(ispHome, 'meter_power');
      if (pvTotal !== null) {
        this.homey.settings.set('eb_pv_baseline', { date: today, baseline: pvTotal });
        this.log(`Midnight baseline saved – PV (iSitePower): ${pvTotal} kWh`);
      }
      if (houseTotal !== null) {
        this.homey.settings.set('eb_house_baseline', { date: today, baseline: houseTotal });
        this.log(`Midnight baseline saved – house (iSitePower): ${houseTotal} kWh`);
      }

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

  /**
   * Every device's change log (lib/change-log.js), newest first, for Settings → Logs. Unlike
   * the live log it survives restarts and updates; it holds the last entries of each device.
   */
  getChangeLog() {
    const out = [];
    let drivers = {};
    try { drivers = this.homey.drivers.getDrivers(); } catch (_) { /* none yet */ }
    for (const driver of Object.values(drivers)) {
      let devices = [];
      try { devices = driver.getDevices(); } catch (_) { /* driver not ready */ }
      for (const device of devices) {
        let name = '';
        try { name = device.getName(); } catch (_) { /* unnamed */ }
        for (const e of changeLog.entries(device)) {
          out.push({ t: e.t, at: this._logStamp(new Date(e.t)), device: name, source: e.source, text: e.text, n: e.n || 1 });
        }
      }
    }
    return out.sort((a, b) => b.t - a.t).slice(0, 300);
  }

  clearAppLog() {
    this._appLogBuffer = [];
  }

  // ── Sensor-chart: capability history ──────────────────────────────────────

  /**
   * The history key for one capability of one device.
   *
   * device.getId() and NOT device.getData().id. The data id is the app's own identifier,
   * unique only within its driver — and all seven OpenAPI drivers mint the same one for a
   * plant: `openapi:<server>:<stationCode>`. The inverter, the battery and the power sensor
   * of one plant therefore shared a single key, each overwriting the other's measure_power
   * once a minute, and every chart drew whichever wrote last. Reported as #29: three
   * widgets, three devices, one curve.
   *
   * getId() is Homey's own device id and is unique across the installation by construction,
   * so the ambiguity cannot come back by picking a different string.
   */
  static _seriesKey(device, capId) {
    return `${device.getId()}::${capId}`;
  }

  /**
   * What to call a series in the picker and the legend.
   *
   * The device name alone is not enough: a device contributes one entry per capability, so
   * a list of rows all reading "Power Sensor (OpenAPI)" is unpickable — and once picked,
   * the legend said as little. The capability's own title is what tells them apart.
   */
  static _seriesLabel(device, capId, lang = 'en') {
    const name = device.getName();
    let title = null;
    try {
      const t = device.getCapabilityOptions(capId)?.title;
      title = typeof t === 'string' ? t : (t?.[lang] ?? t?.en ?? null);
    } catch (e) { /* no options set for this capability */ }
    return title ? `${name} · ${title}` : `${name} · ${capId}`;
  }

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
        let lang = 'en';
        try { lang = this.homey.i18n.getLanguage() || 'en'; } catch (e) { /* keep en */ }
        try {
          const drivers = this.homey.drivers.getDrivers();
          for (const driver of Object.values(drivers)) {
            try {
              for (const device of driver.getDevices()) {
                for (const capId of device.getCapabilities()) {
                  if (!FusionSolarApp._isMeaningfulCap(capId)) continue;
                  const val = device.getCapabilityValue(capId);
                  if (typeof val !== 'number') continue;

                  const id   = FusionSolarApp._seriesKey(device, capId);
                  const name = FusionSolarApp._seriesLabel(device, capId, lang);

                  if (!query || query.length === 0
                      || name.toLowerCase().includes(query.toLowerCase())) {
                    results.push({ id, name, description: fmtVal(val) });
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

    /** Small inline helper — a power reading with its unit. It used to append " W" to
     *  a figure already in kW, which read "2.3 kW W". */
    function fmtVal(v) {
      if (v === null || v === undefined) return '—';
      const a = Math.abs(v);
      if (a >= 1000) return (v / 1000).toFixed(1) + ' kW';
      return Math.round(v) + ' W';
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

  // The long tier (1.2.299): one point per quarter hour — average, low and high — for a
  // week. The chart's stepper offered 48 h, 72 h and 7 days while only the 25 h above were
  // kept, so all three drew the same day under a longer label. 7 × 96 = 672 buckets, with a
  // little headroom; stored beside the minute points as sch_hist7_<logId>.
  static get CAP_HISTORY_COARSE_MS()  { return 15 * 60 * 1000; }
  static get CAP_HISTORY_COARSE_MAX() { return 700; }

  /** Fold one minute point into the quarter-hour tier. */
  static _addCoarse(buckets, t, v) {
    const q = FusionSolarApp.CAP_HISTORY_COARSE_MS;
    const bt = Math.floor(t / q) * q;
    const last = buckets[buckets.length - 1];
    if (last && last.t === bt) {
      last.v  = (last.v * last.n + v) / (last.n + 1);
      last.lo = Math.min(last.lo, v);
      last.hi = Math.max(last.hi, v);
      last.n += 1;
    } else if (!last || bt > last.t) {
      buckets.push({ t: bt, v, lo: v, hi: v, n: 1 });
    }
    const max = FusionSolarApp.CAP_HISTORY_COARSE_MAX;
    if (buckets.length > max) buckets.splice(0, buckets.length - max);
  }

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
      // Persist every 15 minutes (15 × 60 s ticks). Every save rewrites every series —
      // ~30 KB each — and onUninit saves too, so an app update or restart loses nothing;
      // only a crash costs up to a quarter of an hour of points (1.2.299, was 5 minutes).
      this._capHistoryPollCount++;
      if (this._capHistoryPollCount % 15 === 0) this._saveCapHistory();
    }, 60 * 1000);
  }

  /**
   * Load persisted history from homey.settings into _capHistory.
   * Settings key format: sch_hist_<logId>
   * Stored value:        [[timestamp_ms, value], ...]
   */
  _loadCapHistory() {
    let loaded = 0;
    if (!this._capHistoryCoarse) this._capHistoryCoarse = new Map();
    // Collected while walking the currently paired devices, then handed to the orphan
    // cleanup below — the same walk answers both "what do I restore" and "what is stale".
    const validLogIds = new Set();
    let enumerationComplete = true;
    try {
      const drivers = this.homey.drivers.getDrivers();
      for (const driver of Object.values(drivers)) {
        try {
          for (const device of driver.getDevices()) {
            for (const capId of device.getCapabilities()) {
              if (!FusionSolarApp._isMeaningfulCap(capId)) continue;

              const logId = FusionSolarApp._seriesKey(device, capId);
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

              // The quarter-hour tier, or — the first start after 1.2.299 — built from
              // the minute points, so the longer views have a day to show at once.
              const rawCoarse = this.homey.settings.get(`sch_hist7_${logId}`);
              const coarse = [];
              if (Array.isArray(rawCoarse) && rawCoarse.length) {
                for (const [t, v, lo, hi, n] of rawCoarse) {
                  coarse.push({ t: Number(t), v, lo: lo ?? v, hi: hi ?? v, n: n || 1 });
                }
              } else {
                for (const p of points) FusionSolarApp._addCoarse(coarse, p.t, p.v);
              }
              this._capHistoryCoarse.set(logId, coarse);
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
      const PREFIXES = ['sch_hist_', 'sch_hist7_'];
      const keys = this.homey.settings.getKeys() || [];
      let removed = 0;
      for (const key of keys) {
        const prefix = PREFIXES.find((p) => key.startsWith(p));
        if (!prefix) continue;
        if (validLogIds.has(key.slice(prefix.length))) continue;
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
      const r2 = (x) => Math.round(x * 100) / 100;
      for (const [logId, buckets] of (this._capHistoryCoarse || new Map()).entries()) {
        this.homey.settings.set(`sch_hist7_${logId}`,
          buckets.map((b) => [b.t, r2(b.v), r2(b.lo), r2(b.hi), b.n]));
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
            // An unreachable device still hands back its last reading, and recording it
            // once a minute drew a flat line at that value for as long as the device was
            // away. Nothing is recorded instead, and the chart shows the hole (1.2.299) —
            // the same rule lib/widget-data.js applies to every other widget.
            if (!isReachable(device)) continue;
            for (const capId of device.getCapabilities()) {
              if (!FusionSolarApp._isMeaningfulCap(capId)) continue;
              const val = device.getCapabilityValue(capId);
              if (typeof val !== 'number') continue;

              const logId = FusionSolarApp._seriesKey(device, capId);
              let pts = this._capHistory.get(logId);
              if (!pts) { pts = []; this._capHistory.set(logId, pts); }

              pts.push({ t: now, v: val });
              if (pts.length > max) pts.splice(0, pts.length - max);

              if (!this._capHistoryCoarse) this._capHistoryCoarse = new Map();
              let coarse = this._capHistoryCoarse.get(logId);
              if (!coarse) { coarse = []; this._capHistoryCoarse.set(logId, coarse); }
              FusionSolarApp._addCoarse(coarse, now, val);
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
    const hours  = Math.min(168, Math.max(1, parseFloat(query.hours) || 24));
    const now    = Date.now();
    const cutoff = now - hours * 3600 * 1000;
    const series = [];

    // For the first seconds after a start the history is not loaded yet, and every series
    // looked unknown — the widget then asked the user to pick them all again. Saying "not
    // ready" lets it wait instead (1.2.299).
    if (!this._capHistoryInited) return { series, ready: false };

    // A day or less from the minute points, more from the quarter hours. A gap is wider
    // than three of the tier's own steps: a missed poll is not a hole, an hour away is.
    const long   = hours > 24;
    const gapMs  = long ? 3 * FusionSolarApp.CAP_HISTORY_COARSE_MS : 3 * 60 * 1000;
    const coarseMap = this._capHistoryCoarse || new Map();

    for (const key of ['s1', 's2', 's3', 's4']) {
      const id = query[key];
      if (!id) continue;

      // A series whose key the history has never heard of is not one that is still filling
      // up — it is one saved against the old key format, and no amount of waiting will make
      // it appear. Saying which of the two it is turns a permanently empty chart into an
      // instruction; the widget shows "pick this series again".
      const known    = !!(this._capHistory && this._capHistory.has(id));
      const fine     = known ? this._capHistory.get(id) : [];
      const source   = long ? (coarseMap.get(id) || []) : fine;
      const filtered = source.filter((p) => p.t >= cutoff).map((p) => ({ t: p.t, v: Math.round(p.v * 10) / 10 }));
      // The reading now, for the legend — or none when the last point is older than the
      // gap rule allows: a device that went away has no current value.
      const last     = fine[fine.length - 1];
      const current  = last && now - last.t <= 3 * 60 * 1000 ? Math.round(last.v * 10) / 10 : null;
      series.push({ id, known, current, points: downsample(filtered, 240, gapMs) });
    }

    return { series, ready: true };
  }

}

module.exports = FusionSolarApp;
