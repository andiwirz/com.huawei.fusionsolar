'use strict';

const { Device } = require('homey');
const { withSettingsLog } = require('../../lib/change-log');
const OcppServer = require('../../lib/ocpp-server');

const MIN_AMPS            = 6;
const MAX_AMPS            = 32;
const AMPS_TO_WATTS       = (amps, phases = 3) => Math.round(amps * phases * 230);
const BLOCK_AMPS          = 0; // server converts 0A → 1W (Huawei firmware bug workaround)
// How long after sending the starting current a second attempt is treated as the same one.
// The restart timer and the connect handler can both fire on a restart with the charger
// still attached; wide enough to cover the gap between them, short enough that a charger
// reconnecting minutes later is served again.
const INIT_PROFILE_DEDUP_MS = 10_000;
const IDLE_GUARD_MS       = 300_000;
const QUICK_ABORT_MS      = 2000;
const MAX_SESSION_HIST    = 10;
const OFFLINE_AFTER_MS    = 180_000;
const LOW_POWER_W         = 100;
const LOW_POWER_FINISH_MS = 180_000;

// This app's own vocabulary for what the charger is doing. It drives _computeSessionStatus
// and the session_status capability, which is ours and accepts these words.
const OCPP_STATUS_MAP = {
  'Available':     'idle',
  'Preparing':     'connected',
  'Charging':      'charging',
  'SuspendedEVSE': 'connected',
  'SuspendedEV':   'connected',
  'Finishing':     'idle',
  'Reserved':      'idle',
  'Unavailable':   'error',
  'Faulted':       'error',
};

// Homey's vocabulary, which is a different thing entirely. evcharger_charging_state is a
// built-in enum accepting exactly these five words; anything else is rejected outright.
//
// Field-caught 2026-09-03, in a log that showed the app writing 'idle':
//   _set(evcharger_charging_state, idle) failed: Invalid enum capability value: idle.
//   Expected: plugged_in_charging,plugged_in_discharging,plugged_in_paused,plugged_in,plugged_out
//
// Every word in the map above is in the same position - none of idle, connected, charging
// or error is a member of that enum - so the capability was never once written
// successfully, on any installation, since it was added. It read as "-" for ever, and the
// places comparing against it read null and fell through to their idle branch.
const HOMEY_EV_STATE = {
  idle:      'plugged_out',
  connected: 'plugged_in',
  charging:  'plugged_in_charging',
  // No member of the enum means "faulted". Writing plugged_out would state that the cable
  // is out, which is not something a lost connection tells us. The fault is reported by
  // session_status and by setUnavailable, both of which say it plainly.
  error:     null,
};

// Reading back the other way, so the state survives a restart. Deliberately lossy:
// plugged_in_paused comes back as 'connected', because this app has no paused state of its
// own - pausing is tracked on the session, not here.
const INTERNAL_FROM_HOMEY = {
  plugged_out:            'idle',
  plugged_in:             'connected',
  plugged_in_paused:      'connected',
  plugged_in_charging:    'charging',
  plugged_in_discharging: 'charging',
};

// Where OCPP is more specific than this app's own vocabulary, say so to Homey. Both
// Suspended states mean the cable is in and nothing is flowing, which is exactly what
// plugged_in_paused is for; internally they stay 'connected'.
const OCPP_HOMEY_STATE = {
  'SuspendedEVSE': 'plugged_in_paused',
  'SuspendedEV':   'plugged_in_paused',
};

// Capabilities the user can turn off. A charger reports the car's state of charge only if
// the car sends it over OCPP, and many cars never do — leaving a tile that shows "-" for
// the life of the device. An empty tile is not information, so it can be removed; the
// setting is opt-out rather than opt-in because a car that does report SoC should show it
// without anyone having to find a switch first.
const OPTIONAL_CAPABILITIES = {
  vehicle_soc: 'show_vehicle_soc',
};

const REQUIRED_CAPABILITIES = [
  'evcharger_charging',
  'target_power',
  'target_power_mode',
  'target_current',
  'measure_power',
  'meter_power',
  'evcharger_charging_state',
  'vehicle_soc',
  'ocpp_server_status',
  'ocpp_last_message',
  'measure_current',
  'measure_current.l1',
  'measure_current.l2',
  'measure_current.l3',
  'measure_voltage',
  'measure_voltage.l1',
  'measure_voltage.l2',
  'measure_voltage.l3',
  'measure_temperature',
  'session_status',
  'charging_profile',
  'status_summary',
  'pause_charging',
  'resume_charging',
  'charge_now',
  'release_charger',
  'meter_session_energy',
  'session_duration',
];

// Old capabilities to remove during migration.
// resume_automation: the built-in solar/off-peak engine moved to the EMS device —
// this driver is now a pure charger interface.
const REMOVE_CAPABILITIES = [
  'button.pause_charging',
  'button.resume_charging',
  'button.release_charger',
  'resume_automation',
  // Migrated to the standard EV capability `evcharger_charging` (Homey v12.4.5+),
  // which auto-generates the native "Start charging" / "Is charging" flow cards.
  'onoff',
];

class SmartChargerOcppDevice extends Device {

  async onInit() {
    this.log(`[OCPP] Device initializing: ${this.getName()}`);

    // ── Migrate old button.* capabilities to custom capabilities ────────────
    for (const cap of REMOVE_CAPABILITIES) {
      if (this.hasCapability(cap)) {
        try {
          await this.removeCapability(cap);
          this.log(`[OCPP] Removed old capability: ${cap}`);
        } catch (e) { this.log(`[OCPP] Remove ${cap} failed: ${e.message}`); }
      }
    }
    await this._ensureCapabilities();

    // Effective controller is always Homey (the charger has no self-scheduling of
    // its own — automation lives in the EMS device), so seed the mode once.
    if (this.hasCapability('target_power_mode') && this.getCapabilityValue('target_power_mode') == null) {
      await this._set('target_power_mode', 'homey');
    }

    // ── One-time setting migrations ─────────────────────────────────────────
    try {
      const v = this.getSetting('charger_vendor');
      if (!v || v === 'Unknown (not yet connected)' || v === 'Unknown') {
        await this.setSettings({ charger_vendor: 'Huawei' });
        this.log('[OCPP] Corrected stale charger_vendor setting to "Huawei"');
      }
    } catch (e) { this.log(`[OCPP] charger_vendor migration error: ${e.message}`); }

    // Dropdown value-type migration: Homey shows "–" for a dropdown on the
    // device settings list when the stored value's type doesn't match the
    // option ids (which are strings). Devices configured under older versions
    // may have numbers stored — convert once.
    try {
      const DROPDOWN_DEFAULTS = {
        number_of_phases: '3',
        default_charging_amps: '16',
        charger_model: 'other',
      };
      const fixes = {};
      for (const [key, def] of Object.entries(DROPDOWN_DEFAULTS)) {
        const v = this.getSetting(key);
        if (typeof v === 'number') fixes[key] = String(v);
        else if (v === null || v === undefined || v === '') fixes[key] = def;
      }
      if (Object.keys(fixes).length) {
        await this.setSettings(fixes);
        this.log(`[OCPP] Migrated dropdown settings: ${JSON.stringify(fixes)}`);
      }
    } catch (e) { this.log(`[OCPP] Dropdown migration skipped: ${e.message}`); }

    // ── Core session state ──────────────────────────────────────────────────
    this._txnId                = null;
    this._txnStartTime         = null;
    this._txnMeterStart        = 0;
    this._txnAmps              = null;
    this._autoStartBlocked     = false;
    this._initialProfileAt     = null;  // when the starting current was last sent
    this._manualStartRequested = false;
    this._quickAbortCount      = 0;
    this.sessionPhaseOverride  = null;
    this.pendingStartAmps      = null;
    this.idTag                 = 'homey';
    this._startInFlight        = false;
    this.assumeActiveFromRestart = false;
    this._lastNonZero          = null;

    // ── Session ownership (tracks who started the current session) ──────────
    this.sessionOwner = null; // 'user' | null ('solar'/'offpeak' were pre-EMS engine owners, may still appear in old stored sessions)

    // ── Adaptive car-phase memory ───────────────────────────────────────────
    this._rememberedCarPhases = null;

    // ── Learned idTag for RemoteStart after restart ─────────────────────────
    this.learnedIdTag = 'homey';

    // ── Timer handles ───────────────────────────────────────────────────────
    this._idleGuardTimer                  = null;
    this._pendingTxProfileTimer           = null;
    this._pendingStartNotificationTimeout = null;

    // ── State tracking ──────────────────────────────────────────────────────
    this._prevState        = null;
    this._prevRawStatus    = null;
    this._connectionStart  = null;
    this._lowPowerSince    = null;
    this._startVerify      = null;

    // ── Masked pause / resume ───────────────────────────────────────────────
    this.stitchedSession = null;
    this.isPaused        = false;

    // ── Stop-reason / Fully-Charged heuristic ──────────────────────────────
    this.lastStopReason = null;

    // ── Offline watchdog ────────────────────────────────────────────────────
    this.chargerOffline        = false;
    this._expectedOfflineUntil = 0;
    this._offlineWatchdog      = null;
    this._offlineWasAlerted    = false;
    this._bootGraceStart       = null;

    // ── Restore persisted state ─────────────────────────────────────────────
    try {
      const sess = await this.getStoreValue('activeSession');
      if (sess && sess.txnId) {
        this._txnId         = sess.txnId;
        this._txnStartTime  = sess.startTime || null;
        this._txnMeterStart = sess.meterStart || 0;
        this._txnAmps       = sess.amps || null;
        this.sessionPhaseOverride = sess.phases || null;
        this.sessionOwner   = sess.owner || null;
        this.log(`[OCPP] Restored session: txnId=${sess.txnId}, amps=${sess.amps}, owner=${sess.owner}`);
      }
    } catch (e) { /* ignore */ }

    try {
      const cs = await this.getStoreValue('connectionStart');
      if (cs) this._connectionStart = cs;
    } catch (e) { /* ignore */ }

    try {
      const ps = await this.getStoreValue('prevState');
      if (ps) { this._prevState = ps.state; this._prevRawStatus = ps.raw; }
    } catch (e) { /* ignore */ }

    try {
      const stitched = await this.getStoreValue('stitchedSession');
      if (stitched && stitched.originalStartTime) {
        this.stitchedSession = stitched;
        this.isPaused = stitched.paused === true;
        if (stitched.owner) this.sessionOwner = stitched.owner;
        this.log(`[OCPP] Restored stitched session: started ${new Date(stitched.originalStartTime).toISOString()}, accum=${stitched.accumulatedEnergyWh || 0}Wh, paused=${this.isPaused}, owner=${stitched.owner}`);
      }
    } catch (e) { /* ignore */ }

    try {
      const sr = await this.getStoreValue('lastStopReason');
      if (sr) this.lastStopReason = sr;
    } catch (e) { /* ignore */ }

    try {
      const lnz = await this.getStoreValue('lastNonZero');
      if (lnz) this._lastNonZero = lnz;
    } catch (e) { /* ignore */ }

    try {
      const rcp = await this.getStoreValue('rememberedCarPhases');
      if (rcp === 1 || rcp === 2 || rcp === 3) this._rememberedCarPhases = rcp;
    } catch (e) { /* ignore */ }

    try {
      const lt = await this.getStoreValue('learnedIdTag');
      if (lt) this.learnedIdTag = lt;
    } catch (e) { /* ignore */ }

    // Restore offline state across restarts so the device card stays correct
    // and the "back online" notification fires once rather than being silently lost.
    try {
      if (await this.getStoreValue('chargerWasOffline')) {
        this.chargerOffline = true;
        this._offlineWasAlerted = true;
        this.log('[OCPP] Restored offline state after restart — waiting for charger (quietly)');
      }
    } catch (e) { /* ignore */ }

    // After restart, if the device was charging, suppress the idle guard
    // until the charger reconnects and sends a StatusNotification.
    const wasCharging = this._chargingState() === 'charging';
    this.assumeActiveFromRestart = wasCharging;

    // Charging automation lives in the Energy Management System device —
    // this driver is a pure charger interface (control + telemetry only).

    // Session tile sensors: 60s refresh so the tile shows live numbers
    // during a session; one immediate pass to show restored session on boot.
    this._sessionTileInterval = this.homey.setInterval(() => {
      this._updateSessionTileSensors().catch(() => {});
    }, 60_000);
    this._updateSessionTileSensors().catch(() => {});

    // ── Register with OcppServer ────────────────────────────────────────────
    const stationId = this.getSetting('station_id');
    const ocppPort  = parseInt(this.getSetting('ocpp_port'), 10) || 8887;
    const server    = OcppServer.getInstance(this.homey, ocppPort);
    server.registerDevice(stationId, this);
    server.setCredentials(stationId, this.getSetting('ocpp_username'), this.getSetting('ocpp_password'));

    await this._set('ocpp_server_status', 'starting');
    await this._applyTargetPowerRange();
    this._registerCapabilityListeners();
    this._registerFlowActions();
    this._registerFlowConditions();
    this._startIdleGuard();

    // Offline watchdog — fires every 30 s
    this._offlineWatchdog = this.homey.setInterval(() => {
      this._checkChargerOnline().catch((err) => this.log(`[OCPP] Watchdog error: ${err.message}`));
    }, 30_000);

    // Three seconds after init, for the charger that was already connected when the app
    // restarted. A charger that turns up later is served by onOcppConnected instead — see
    // _applyInitialProfile for why one timer alone was not enough.
    this.homey.setTimeout(() => {
      this._applyInitialProfile('app restart').catch(() => {});
    }, 3000);

    this._updateChargingProfile().catch(() => {});
    this.log('[OCPP] Device initialized');
  }

  async onSettings({ newSettings, changedKeys }) {
    const stationId = this.getSetting('station_id');
    const ocppPort  = parseInt(newSettings.ocpp_port, 10) || 8887;
    const server    = OcppServer.getInstance(this.homey, ocppPort);
    server.setCredentials(stationId, newSettings.ocpp_username, newSettings.ocpp_password);

    // newSettings, not getSetting(): Homey persists only after this method resolves, so
    // reading the stored value here would still give the old one and the tile would appear
    // or disappear one save too late.
    if (changedKeys.some((k) => Object.values(OPTIONAL_CAPABILITIES).includes(k))) {
      await this._applyOptionalCapabilities(newSettings);
    }

    const amps      = parseInt(newSettings.default_charging_amps, 10) || 16;
    const autoStart = newSettings.auto_start_charging !== false;

    if (newSettings.charger_model === '7ks' && String(newSettings.number_of_phases) === '3') {
      throw new Error('SCharger-7KS-S0 only supports Mono-Phase wiring — please set "Number of phases" to 1.');
    }
    if (newSettings.charger_model === '22kt' && String(newSettings.number_of_phases) === '1') {
      throw new Error('SCharger-22KT-S0 requires Tri-Phase wiring — please set "Number of phases" to 3.');
    }

    if (changedKeys.includes('auto_start_charging')) {
      this._startIdleGuard();
      const currentState = this._chargingState();
      this._updateSessionStatus(currentState, autoStart).catch(() => {});

      if (!autoStart) {
        if (!this._txnId) {
          try {
            const r = await server.setMaxCurrentAsync(stationId, BLOCK_AMPS, this._getPhases());
            this.log('[OCPP] Block TxDefault response:', JSON.stringify(r));
          } catch (e) { this.log('[OCPP] Block TxDefault failed:', e.message); }
        } else {
          this._autoStartBlocked = true;
          try {
            const r = await server.setTxProfileAsync(stationId, this._txnId, BLOCK_AMPS, this._getPhases());
            this.log('[OCPP] Block TxProfile response:', JSON.stringify(r));
          } catch (e) { this.log('[OCPP] Block TxProfile failed:', e.message); }
        }
      } else {
        if (!this._txnId) {
          try {
            const r = await server.setMaxCurrentAsync(stationId, amps, this._getPhases());
            this.log('[OCPP] Restore TxDefault response:', JSON.stringify(r));
          } catch (e) { this.log('[OCPP] Restore TxDefault failed:', e.message); }
        }
      }
    }

    if (changedKeys.includes('default_charging_amps')) {
      if (!this._txnId) {
        const targetAmps = autoStart ? amps : BLOCK_AMPS;
        try {
          const r = await server.setMaxCurrentAsync(stationId, targetAmps, this._getPhases());
          this.log('[OCPP] Updated TxDefault response:', JSON.stringify(r));
        } catch (e) { this.log('[OCPP] Updated TxDefault failed:', e.message); }
      } else if (!this._autoStartBlocked) {
        this._txnAmps = amps;
        try {
          const r = await server.setTxProfileAsync(stationId, this._txnId, amps, this._getPhases());
          this.log('[OCPP] Updated TxProfile response:', JSON.stringify(r));
        } catch (e) { this.log('[OCPP] Updated TxProfile failed:', e.message); }
        await this._saveSession();
      }
      if (!autoStart) this._startIdleGuard();
    }

    if (changedKeys.includes('number_of_phases')) {
      this._updateChargingProfile().catch(() => {});
      // newSettings, not the stored value: Homey persists after this resolves.
      this._applyTargetPowerRange(parseInt(newSettings.number_of_phases, 10)).catch(() => {});
    }
  }

  // Homey's target_power slider speaks watts, and which watt values mean anything depends
  // on how many phases are wired. The pilot signal (IEC 61851) cannot express less than
  // 6 A, and Huawei's firmware ignores the phase count inside a charging profile and
  // spreads the watt limit across every physical phase — so on a three-phase unit the
  // smallest deliverable power is 6 A on each of the three, about 4140 W, not 1380 W.
  //
  // The options were fixed at the single-phase figures: a dead zone up to 1380 W and a
  // 230 W step. On a three-phase charger Homey would therefore offer 2000 W as a valid
  // request, and the driver would raise it to its 6 A minimum without saying so — asking
  // for less than half of what actually flowed. Homey's own documentation scales both with
  // the phase count, and this does the same.
  //
  // Existing options are read and spread rather than replaced, so the titles declared in
  // app.json survive whatever the merge semantics turn out to be.
  async _applyTargetPowerRange(phaseOverride) {
    if (!this.hasCapability('target_power')) return;
    const phases = (phaseOverride === 1 || phaseOverride === 3) ? phaseOverride : this._devicePhases();
    const step   = phases * 230;
    try {
      const current = this.getCapabilityOptions('target_power') || {};
      await this.setCapabilityOptions('target_power', {
        ...current,
        min:        0,               // this charger does not discharge
        max:        MAX_AMPS * step,
        step,
        excludeMin: 0,
        excludeMax: MIN_AMPS * step, // below this the charger cannot deliver at all
      });
      this.log(`[OCPP] target_power range: 0–${MAX_AMPS * step} W, step ${step} W, `
        + `nothing below ${MIN_AMPS * step} W (${phases}-phase)`);
    } catch (err) {
      this.error('setCapabilityOptions(target_power) failed:', err.message);
    }
  }

  async onDeleted() {
    this._clearTimers();
    OcppServer.getInstance(this.homey).unregisterDevice(this.getSetting('station_id'));
    this.log('[OCPP] Device deleted');
  }

  async onUninit() {
    this._clearTimers();
    OcppServer.getInstance(this.homey).unregisterDevice(this.getSetting('station_id'));
  }

  _clearTimers() {
    this._clearIdleGuard();
    if (this._sessionTileInterval) {
      this.homey.clearInterval(this._sessionTileInterval);
      this._sessionTileInterval = null;
    }
    if (this._offlineWatchdog) {
      this.homey.clearInterval(this._offlineWatchdog);
      this._offlineWatchdog = null;
    }
    if (this._pendingTxProfileTimer) {
      this.homey.clearTimeout(this._pendingTxProfileTimer);
      this._pendingTxProfileTimer = null;
    }
    if (this._pendingStartNotificationTimeout) {
      this.homey.clearTimeout(this._pendingStartNotificationTimeout);
      this._pendingStartNotificationTimeout = null;
    }
  }

  // ─── Called by OcppServer ────────────────────────────────────────────────

  onOcppConnected() {
    this.log('[OCPP] Charger connected');
    this._set('ocpp_server_status', 'connected').catch(() => {});
    // A moment to settle before being told anything, the same two seconds the server waits
    // before configuring the sampling interval.
    this.homey.setTimeout(() => {
      this._applyInitialProfile('charger connected').catch(() => {});
    }, 2000);
  }

  /**
   * Send the configured starting current to the charger.
   *
   * It used to be one shot, three seconds after the app started — which serves a charger
   * that is already connected and nobody else. After a Homey restart the charger reconnects
   * on its own schedule, often well past that mark, and then never received the current at
   * all: it kept whatever limit it had. Invisible to anyone running the EMS, because the
   * next tick writes a value anyway; the people it actually cost are those using
   * auto_start_charging with a default of their own.
   *
   * So it now runs on connect as well. Both paths share this method, which is also the only
   * place that decides whether sending is worth trying at all:
   *
   * A charger that is not connected gets nothing and no complaint. The device has already
   * said it is "waiting for charger (quietly)"; announcing three seconds later that a send
   * failed because the charger is not there contradicts that, and it was the only error
   * line in the log of the report that prompted this — so it read as the fault itself.
   */
  async _applyInitialProfile(reason) {
    if (this._txnId && !this._autoStartBlocked) return; // live session — leave alone

    const server    = OcppServer.getInstance(this.homey);
    const stationId = this.getSetting('station_id');
    if (!server.isConnected(stationId)) return;

    // On an app restart with the charger still attached, both paths fire within a couple of
    // seconds of each other. Sending the same profile twice is harmless and says nothing.
    if (this._initialProfileAt && Date.now() - this._initialProfileAt < INIT_PROFILE_DEDUP_MS) return;
    this._initialProfileAt = Date.now();

    const autoStart = this.getSetting('auto_start_charging') !== false;
    const initAmps  = autoStart ? (parseInt(this.getSetting('default_charging_amps'), 10) || 16) : BLOCK_AMPS;
    try {
      const r = await server.setMaxCurrentAsync(stationId, initAmps, this._getPhases());
      this.log(`[OCPP] Init profile ${initAmps}A (${reason}) → ${(r && r.status) || 'no status'}`);
    } catch (e) {
      this.log(`[OCPP] Init profile ${initAmps}A (${reason}) failed: ${e.message}`);
    }
  }

  onOcppDisconnected() {
    this.log('[OCPP] Charger disconnected');
    this._txnId = null;
    this._autoStartBlocked = false;
    this._set('ocpp_server_status', 'waiting').catch(() => {});
    // 'error' not 'idle': connectivity loss must be visible to the user
    this._setChargingState('error').catch(() => {});
    this._updateSessionStatus('error').catch(() => {});
    this._set('measure_power', 0).catch(() => {});
  }

  onBootNotification(payload) {
    this.log('[OCPP] BootNotification:', JSON.stringify(payload));
    this._set('ocpp_last_message', 'Boot: ' + (payload.chargePointModel || '?')).catch(() => {});
    if (!this.getAvailable()) this.setAvailable().catch(() => {});
    const autoStart   = this.getSetting('auto_start_charging') !== false;
    const defaultAmps = parseInt(this.getSetting('default_charging_amps'), 10) || 16;
    const bootAmps    = autoStart ? defaultAmps : BLOCK_AMPS;
    this.homey.setTimeout(async () => {
      try {
        const r = await OcppServer.getInstance(this.homey)
          .setMaxCurrentAsync(this.getSetting('station_id'), bootAmps, this._getPhases());
        this.log(`[OCPP] Boot profile ${bootAmps}A → ${(r && r.status) || 'no status'}`);
      } catch (e) { this.log(`[OCPP] Boot profile ${bootAmps}A failed: ${e.message}`); }
    }, 3000);
  }

  onStatusNotification(payload) {
    if (payload.connectorId !== undefined && payload.connectorId !== 1) return;
    this.log('[OCPP] StatusNotification:', JSON.stringify(payload));
    const rawStatus  = payload.status || '';
    const homeyState = OCPP_STATUS_MAP[rawStatus] || 'idle';

    // First StatusNotification after restart confirms charger is live — clear
    // the restart-guard so the idle guard can run normally from here on.
    this.assumeActiveFromRestart = false;

    this._setChargingState(homeyState, OCPP_HOMEY_STATE[rawStatus]).catch(() => {});
    this._set('ocpp_last_message', 'Status: ' + rawStatus).catch(() => {});

    if (rawStatus === 'Charging' && !this._autoStartBlocked) {
      this._set('evcharger_charging', true).catch(() => {});
    } else if (rawStatus === 'Available' || rawStatus === 'Finishing') {
      this._set('evcharger_charging', false).catch(() => {});
    }

    this._updateSessionStatus(homeyState).catch(() => {});

    this._handleStateChange(homeyState, rawStatus)
      .catch((err) => this.log('[OCPP] State change error:', err.message));

    this.homey.flow.getDeviceTriggerCard('ocpp_charging_state_changed')
      .trigger(this, { state: homeyState })
      .catch(() => {});

    this._fireFaultTrigger(payload, rawStatus);
  }

  // Every StatusNotification carries errorCode, and it used to go no further than the log
  // line above. A fault did reach a flow — as state "error" on the state-changed trigger —
  // but WHICH fault did not, so a ground fault and an over-temperature shutdown were
  // indistinguishable to anyone building an alert.
  //
  // Fired on the error code rather than on the connector status: a charger can report a
  // fault while the connector still reads Available or Charging, and NoError is the normal
  // value on every healthy notification. Repeats are suppressed, because a charger that is
  // faulted says so on every status change until it clears.
  _fireFaultTrigger(payload, rawStatus) {
    const code = (payload.errorCode || '').trim();
    const faulted = code && code !== 'NoError';
    if (!faulted) {
      this._lastFaultCode = null;
      return;
    }
    if (this._lastFaultCode === code) return;
    this._lastFaultCode = code;

    this.log(`[OCPP] Charger fault: ${code}${payload.info ? ` — ${payload.info}` : ''}`);
    this.homey.flow.getDeviceTriggerCard('ocpp_charger_fault')
      .trigger(this, {
        error_code:        code,
        vendor_error_code: payload.vendorErrorCode || '',
        info:              payload.info || '',
        status:            rawStatus,
      })
      .catch((err) => this.log('[OCPP] Trigger ocpp_charger_fault failed:', err.message));
  }

  async _handleStateChange(newState, rawStatus) {
    const oldState     = this._prevState;
    const oldRawStatus = this._prevRawStatus;

    // Genuine unplug detection — only rawStatus='Available' means cable-free
    const cableWasIn = oldState === 'connected' || oldState === 'charging'
      || (oldState === 'idle' && oldRawStatus === 'Finishing');
    if (cableWasIn && rawStatus === 'Available' && oldRawStatus !== 'Available') {
      const connStart = this._connectionStart;
      this._connectionStart = null;
      await this.setStoreValue('connectionStart', null).catch(() => {});
      await this._resetSessionTileSensors();
      // Deferred 4 s: let pending StopTransaction settle before reporting unplug
      this.homey.setTimeout(async () => {
        if (this._txnId) return;
        await this._handleUnpluggedWithoutCharging(connStart);
      }, 4000);
    }

    // Fresh plug-in: clear stale "Fully Charged" flag from previous session
    if (newState === 'connected' && oldRawStatus === 'Available' && this.lastStopReason) {
      this.log(`[OCPP] Fresh plug-in — clearing previous stop reason (was ${this.lastStopReason})`);
      this.lastStopReason = null;
      await this.setStoreValue('lastStopReason', null).catch(() => {});
    }

    if (newState === oldState) {
      this._prevRawStatus = rawStatus;
      return;
    }

    this.log(`[OCPP] State: ${oldState || 'null'} → ${newState}`);

    const wasGenuinelyFree = oldState === null
      || (oldState === 'idle' && oldRawStatus !== 'Finishing' && oldRawStatus !== 'Reserved');

    if (wasGenuinelyFree && newState === 'connected') {
      // Boot replay guard: if this is the first StatusNotification after a
      // restart and we already restored a connectionStart from the store,
      // keep the original plug-in time instead of stamping Date.now().
      const bootReplay = oldState === null && this._connectionStart;
      if (!bootReplay) {
        this._connectionStart = Date.now();
        await this.setStoreValue('connectionStart', this._connectionStart).catch(() => {});
      }
      this.log('[OCPP] Car plugged in');

      const autoStart = this.getSetting('auto_start_charging') !== false;
      if (autoStart) {
        this.log('[OCPP] Auto-start ON — proactively sending RemoteStartTransaction');
        this.homey.setTimeout(() => {
          if (this._txnId && !this._autoStartBlocked) {
            this.log('[OCPP] Session already active — skipping proactive RemoteStart');
            return;
          }
          try { this.startCharging().catch(() => {}); } catch (e) { /* ignore */ }
        }, 500);
      } else {
        await this._postNotification('🚗', 'Car Plugged In', 'Car connected — ready to start');
        this.homey.flow.getDeviceTriggerCard('ocpp_car_plugged_waiting')
          .trigger(this, {})
          .catch((err) => this.log('[OCPP] Trigger ocpp_car_plugged_waiting failed:', err.message));
      }
    }

    // State-driven session hooks — secondary guard alongside StartTransaction/StopTransaction
    if (oldState !== 'charging' && newState === 'charging') {
      await this.handleSessionStart();
    }
    if (oldState === 'charging' && (newState === 'idle' || newState === 'connected' || newState === 'error')) {
      await this.handleSessionEnd();
    }

    if (oldState === 'connected' && newState === 'idle' && !this._txnId) {
      this._connectionStart = null;
      await this.setStoreValue('connectionStart', null).catch(() => {});
    }

    this._prevState     = newState;
    this._prevRawStatus = rawStatus;
    await this.setStoreValue('prevState', { state: newState, raw: rawStatus }).catch(() => {});
  }

  // Status-driven session hooks — secondary guard alongside StartTransaction/StopTransaction.
  // handleSessionStart establishes a baseline if none exists (e.g. charger self-authorized).
  // handleSessionEnd logs only — onStopTransaction owns the actual cleanup.
  async handleSessionStart() {
    if (!this._txnId) {
      this._txnId        = Math.floor(Date.now() / 1000);
      this._txnStartTime = Date.now();
      this._txnMeterStart = (this.getCapabilityValue('meter_power') || 0) * 1000;
      this.log(`[OCPP] handleSessionStart: synthetic txnId=${this._txnId}`);
    } else {
      this.log(`[OCPP] handleSessionStart: session already tracked (txnId=${this._txnId})`);
    }
  }

  async handleSessionEnd() {
    const currentEnergy = this.getCapabilityValue('meter_power') || 0;
    const energyWh      = Math.max(0, Math.round((currentEnergy * 1000) - this._txnMeterStart));
    const durationMs    = this._txnStartTime ? (Date.now() - this._txnStartTime) : 0;
    this.log(`[OCPP] handleSessionEnd: ~${energyWh}Wh over ${this._formatDuration(durationMs)}`);
    // Do NOT reset transactionId here — onStopTransaction is the sole owner of that cleanup.
  }

  async _handleUnpluggedWithoutCharging(connStart) {
    if (this.stitchedSession) {
      await this._finalizeStitchedSession('EVDisconnected');
    }
    this.lastStopReason = null;
    await this.setStoreValue('lastStopReason', null).catch(() => {});

    const durationMs  = connStart ? (Date.now() - connStart) : 0;
    const durationStr = this._formatDuration(durationMs);
    const message     = `Disconnected · plugged in for ${durationStr}`;

    await this._postNotification('🚗', 'Disconnected', message);
    this.homey.flow.getDeviceTriggerCard('ocpp_disconnected')
      .trigger(this, { connected_minutes: Math.round(durationMs / 60000), message })
      .catch((err) => this.log('[OCPP] Trigger ocpp_disconnected failed:', err.message));
  }

  onMeterValues(payload) {
    if (payload.connectorId !== undefined && payload.connectorId !== 1) return;
    this.log('[OCPP] MeterValues');

    for (const mv of (payload.meterValue || [])) {
      const sampledValues = mv.sampledValue || [];

      for (const sv of sampledValues) {
        const measurand = sv.measurand || 'Energy.Active.Import.Register';
        let val = parseFloat(sv.value);
        if (!Number.isFinite(val)) continue;
        const unit = (sv.unit || '').toLowerCase();
        if (unit.startsWith('k')) val *= 1000;
        else if (unit === 'mw' || unit === 'mwh' || unit === 'ma') val /= 1000;

        switch (measurand) {

          case 'Power.Active.Import': {
            const powerW = Math.round(val);
            this._set('measure_power', powerW).catch(() => {});
            this._trackLastNonZero('measure_power', powerW);

            // Power-verified start: first real draw → announce started / resumed
            if (this._startVerify && this._startVerify.txId === this._txnId && powerW > LOW_POWER_W) {
              const v = this._startVerify;
              this._startVerify = null;
              if (this._pendingStartNotificationTimeout) {
                this.homey.clearTimeout(this._pendingStartNotificationTimeout);
                this._pendingStartNotificationTimeout = null;
              }
              this.log(`[OCPP] Power flowing (${powerW}W) — announcing verified ${v.isMaskedResume ? 'resume' : 'start'}`);
              this._announceVerifiedStart(v).catch((err) => this.log(`[OCPP] Announce error: ${err.message}`));
            }

            // Low-power streak: Charging but ~0W for 3 min → 'finishing'
            if (this._txnId && this._chargingState() === 'charging') {
              if (powerW < LOW_POWER_W) {
                if (!this._lowPowerSince) this._lowPowerSince = Date.now();
              } else {
                this._lowPowerSince = null;
              }
              this._updateSessionStatus('charging').catch(() => {});
            } else {
              this._lowPowerSince = null;
            }
            break;
          }

          case 'Energy.Active.Import.Register':
            this._set('meter_power', parseFloat((val / 1000).toFixed(3))).catch(() => {});
            this._trackLastNonZero('meter_power', val / 1000);
            break;

          case 'SoC':
            this._set('vehicle_soc', Math.round(val)).catch(() => {});
            break;

          case 'Current.Import': {
            const ph = sv.phase || '';
            if (ph.startsWith('L1'))      { this._set('measure_current.l1', val).catch(() => {}); this._trackLastNonZero('measure_current.l1', val); }
            else if (ph.startsWith('L2')) { this._set('measure_current.l2', val).catch(() => {}); this._trackLastNonZero('measure_current.l2', val); }
            else if (ph.startsWith('L3')) { this._set('measure_current.l3', val).catch(() => {}); this._trackLastNonZero('measure_current.l3', val); }
            break;
          }

          case 'Voltage': {
            const ph = sv.phase || '';
            if (ph.startsWith('L1'))      { this._set('measure_voltage.l1', val).catch(() => {}); this._trackLastNonZero('measure_voltage.l1', val); }
            else if (ph.startsWith('L2')) { this._set('measure_voltage.l2', val).catch(() => {}); this._trackLastNonZero('measure_voltage.l2', val); }
            else if (ph.startsWith('L3')) { this._set('measure_voltage.l3', val).catch(() => {}); this._trackLastNonZero('measure_voltage.l3', val); }
            break;
          }

          case 'Temperature':
            this._set('measure_temperature', val).catch(() => {});
            this._trackLastNonZero('measure_temperature', val);
            break;
        }
      }

      // Aggregates from per-phase values
      let totalA = 0, countA = 0, totalV = 0, countV = 0;
      for (const sv of sampledValues) {
        if (sv.measurand === 'Current.Import' && sv.phase) { totalA += parseFloat(sv.value) || 0; countA++; }
        if (sv.measurand === 'Voltage' && sv.phase)        { totalV += parseFloat(sv.value) || 0; countV++; }
      }
      if (countA > 0) this._set('measure_current', totalA).catch(() => {});
      if (countV > 0) this._set('measure_voltage', totalV / countV).catch(() => {});
    }

    this._set('ocpp_last_message', 'MeterValues received').catch(() => {});
  }

  async onStartTransaction(payload, txnId) {
    this.log('[OCPP] StartTransaction txnId:', txnId);
    this._lowPowerSince = null;

    if (payload.idTag) {
      this.idTag = payload.idTag;
      // Persist idTag so RemoteStart works correctly after a Homey restart
      this.learnedIdTag = payload.idTag;
      this.setStoreValue('learnedIdTag', payload.idTag).catch(() => {});
    }

    const autoStart   = this.getSetting('auto_start_charging') !== false;
    const defaultAmps = parseInt(this.getSetting('default_charging_amps'), 10) || 16;

    this._txnId         = txnId;
    this._txnStartTime  = Date.now();
    this._txnMeterStart = payload.meterStart != null
      ? payload.meterStart
      : (this.getCapabilityValue('meter_power') || 0) * 1000;
    this.lastStopReason = null;
    await this.setStoreValue('lastStopReason', null).catch(() => {});

    const manualStart = this._manualStartRequested;
    this._manualStartRequested = false;

    if (!autoStart && !manualStart) {
      this._autoStartBlocked = true;
      this._txnAmps = BLOCK_AMPS;
      this.log(`[OCPP] Auto-start OFF — blocking with ${BLOCK_AMPS}A TxProfile`);
      try {
        const r = await OcppServer.getInstance(this.homey)
          .setTxProfileAsync(this.getSetting('station_id'), txnId, BLOCK_AMPS, this._getPhases());
        this.log(`[OCPP] Block TxProfile → ${(r && r.status) || 'no status'}`);
      } catch (e) { this.log('[OCPP] Block TxProfile failed:', e.message); }

      await this._set('evcharger_charging', false);
      await this._setChargingState('connected');
      await this._set('ocpp_last_message', 'Car connected — waiting for start');
      await this._saveSession();
      await this._updateSessionStatus('connected');

    } else {
      const isMaskedResume = !!(this.stitchedSession && this.stitchedSession.resuming);
      const activeAmps     = this._txnAmps || this.pendingStartAmps || defaultAmps;
      this._txnAmps        = activeAmps;
      this.pendingStartAmps = null;
      this._autoStartBlocked = false;
      await this._saveSession();
      await this._set('evcharger_charging', true);
      await this._setChargingState('charging');
      await this._set('ocpp_last_message', isMaskedResume ? 'Charging resumed' : 'Charging started');
      await this._updateSessionStatus('charging');
      this._updateChargingProfile().catch(() => {});

      // Power-verified start: set watcher; fires _announceVerifiedStart() when >100W arrives.
      const startedTxId = txnId;
      this._startVerify = { txId: startedTxId, isMaskedResume, activeAmps };

      if (this._pendingStartNotificationTimeout) this.homey.clearTimeout(this._pendingStartNotificationTimeout);
      this._pendingStartNotificationTimeout = this.homey.setTimeout(async () => {
        this._pendingStartNotificationTimeout = null;
        if (!this._startVerify || this._startVerify.txId !== startedTxId) return;
        if (this._txnId !== startedTxId) return;
        const what = isMaskedResume ? 'Resume' : 'Start';
        this.log(`[OCPP] ${what} requested but no power after 90s — car may be full`);
        await this._postNotification('🪫', `${what} Requested`, `${what} requested · car isn't drawing power (battery may be full?)`);
      }, 90_000);
    }
  }

  async onStopTransaction(payload) {
    this.log('[OCPP] StopTransaction:', JSON.stringify(payload));

    const meterStop  = payload.meterStop || 0;
    const reason     = payload.reason || 'Unknown';
    const durationMs = this._txnStartTime ? (Date.now() - this._txnStartTime) : 0;
    const energyWh   = Math.max(0, meterStop - this._txnMeterStart);

    // ── Masked pause: this stop is OURS — accumulate segment, suppress events ──
    if (this.stitchedSession && this.stitchedSession.stopRequested) {
      this.stitchedSession.stopRequested       = false;
      this.stitchedSession.accumulatedEnergyWh = (this.stitchedSession.accumulatedEnergyWh || 0) + Math.max(0, energyWh);
      await this._persistStitched();
      this.log(`[OCPP] Masked pause: segment closed (+${Math.max(0, energyWh)}Wh, ${this.stitchedSession.accumulatedEnergyWh}Wh accumulated)`);

      this._quickAbortCount = 0;
      this._txnId = null; this._txnStartTime = null;
      this._txnMeterStart = 0;
      // Deliberately preserve _txnAmps — it's the resume target shown by charging_profile.
      this._autoStartBlocked = false;
      this._lowPowerSince = null;
      this._startVerify   = null;
      if (this._pendingStartNotificationTimeout) {
        this.homey.clearTimeout(this._pendingStartNotificationTimeout);
        this._pendingStartNotificationTimeout = null;
      }
      if (this._pendingTxProfileTimer) {
        this.homey.clearTimeout(this._pendingTxProfileTimer);
        this._pendingTxProfileTimer = null;
      }
      await this.setStoreValue('activeSession', null).catch(() => {});
      await this._set('evcharger_charging', false);
      await this._updateSessionStatus('connected');

      this.homey.setTimeout(async () => {
        try {
          const r = await OcppServer.getInstance(this.homey)
            .setMaxCurrentAsync(this.getSetting('station_id'), BLOCK_AMPS, this._getPhases());
          this.log(`[OCPP] Masked pause: ${BLOCK_AMPS}A hold → ${(r && r.status) || 'no status'}`);
        } catch (e) { this.log(`[OCPP] Masked pause hold failed: ${e.message}`); }
      }, 2000);
      return;
    }

    // ── Quick-abort: charger aborts <2 s (reason=Other) — retry once ─────────
    const wasQuickAbort = reason === 'Other' && durationMs > 0 && durationMs < QUICK_ABORT_MS;
    if (wasQuickAbort && this._quickAbortCount < 1 && this._txnAmps && this._txnAmps > 0) {
      const retryAmps   = this._txnAmps;
      const retryPhases = this.sessionPhaseOverride;
      this._quickAbortCount++;
      this.log(`[OCPP] Quick abort (${durationMs}ms, reason=Other) — retrying at ${retryAmps}A in 3s`);

      if (this._pendingStartNotificationTimeout) {
        this.homey.clearTimeout(this._pendingStartNotificationTimeout);
        this._pendingStartNotificationTimeout = null;
      }
      if (this._pendingTxProfileTimer) {
        this.homey.clearTimeout(this._pendingTxProfileTimer);
        this._pendingTxProfileTimer = null;
      }
      this._startVerify = null;
      this._txnId = null; this._txnStartTime = null;
      this._autoStartBlocked = false;
      this.sessionPhaseOverride = null;
      await this.setStoreValue('activeSession', null).catch(() => {});
      await this._set('evcharger_charging', false);
      await this._setChargingState('connected');

      const stationId = this.getSetting('station_id');
      this.homey.setTimeout(async () => {
        try {
          this._manualStartRequested = true;
          this.sessionPhaseOverride = retryPhases;
          const server = OcppServer.getInstance(this.homey);
          const limit = await server.setMaxCurrentAsync(stationId, retryAmps, retryPhases || this._devicePhases());
          const start = await server.remoteStartAsync(stationId);
          this.log(`[OCPP] Quick-abort retry: profile → ${(limit && limit.status) || 'no status'}, `
            + `start → ${(start && start.status) || 'no status'}`);
        } catch (e) { this.log('[OCPP] Retry failed:', e.message); }
      }, 3000);
      return;
    }
    this._quickAbortCount = 0;

    // ── Stitched resume ended — report as ONE continuous session ─────────────
    let reportStartTime = this._txnStartTime;
    let reportEnergyWh  = energyWh;
    if (this.stitchedSession) {
      reportStartTime = this.stitchedSession.originalStartTime;
      reportEnergyWh  = (this.stitchedSession.accumulatedEnergyWh || 0) + Math.max(0, energyWh);
      this.log(`[OCPP] Masked pause: final stop — stitched session total=${reportEnergyWh}Wh, reason=${reason}`);
      this.stitchedSession = null;
      this.isPaused = false;
      await this._persistStitched();
    }
    const reportDurationMs = reportStartTime ? (Date.now() - reportStartTime) : 0;

    const wasBlocked      = this._autoStartBlocked;
    const sessionAmps     = this._txnAmps;
    const sessionPhases   = this._getPhases();
    const sessionOwnerWas = this.sessionOwner;

    this.lastStopReason = reason;
    await this.setStoreValue('lastStopReason', reason).catch(() => {});

    this._txnId = null; this._txnStartTime = null;
    this._txnMeterStart = 0; this._txnAmps = null;
    this._autoStartBlocked = false;
    this._lowPowerSince = null;
    this._startVerify   = null;
    this.sessionPhaseOverride = null;
    this.isPaused = false;
    this.sessionOwner = null;
    if (this._pendingStartNotificationTimeout) {
      this.homey.clearTimeout(this._pendingStartNotificationTimeout);
      this._pendingStartNotificationTimeout = null;
    }
    if (this._pendingTxProfileTimer) {
      this.homey.clearTimeout(this._pendingTxProfileTimer);
      this._pendingTxProfileTimer = null;
    }
    await this.setStoreValue('activeSession', null).catch(() => {});

    await this._set('evcharger_charging', false);
    const settledState = (() => {
      const cur = this._chargingState();
      if (cur && cur !== 'charging') return cur;
      return 'connected';
    })();
    await this._setChargingState(settledState);
    await this._set('measure_power', 0);
    if (meterStop) await this._set('meter_power', parseFloat((meterStop / 1000).toFixed(3)));
    await this._set('ocpp_last_message', 'Charging stopped');
    await this._updateSessionStatus(settledState);
    this._updateChargingProfile().catch(() => {});

    const autoStart   = this.getSetting('auto_start_charging') !== false;
    const defaultAmps = parseInt(this.getSetting('default_charging_amps'), 10) || 16;
    const restoreAmps = autoStart ? defaultAmps : BLOCK_AMPS;
    this.homey.setTimeout(async () => {
      try {
        const r = await OcppServer.getInstance(this.homey)
          .setMaxCurrentAsync(this.getSetting('station_id'), restoreAmps, this._getPhases());
        this.log(`[OCPP] Restore profile ${restoreAmps}A → ${(r && r.status) || 'no status'}`);
      } catch (e) { this.log(`[OCPP] Restore profile ${restoreAmps}A failed: ${e.message}`); }
    }, 2000);

    if (!wasBlocked) {
      if (reportDurationMs >= 5000) {
        await this._recordSession({ durationMs: reportDurationMs, energyWh: reportEnergyWh, amps: sessionAmps, phases: sessionPhases, reason, startTime: reportStartTime, owner: sessionOwnerWas });
      }

      const durationStr = this._formatDuration(reportDurationMs);
      const energyStr   = this._formatEnergy(reportEnergyWh);
      const energyKwh   = parseFloat((reportEnergyWh / 1000).toFixed(3));
      const message     = `Charging finished · ${energyStr} · ${durationStr}`;

      if (reportEnergyWh > 0) {
        await this._postNotification('🔌', 'Charging Stopped', message);
      }

      this.homey.flow.getDeviceTriggerCard('ocpp_charging_stopped')
        .trigger(this, {
          energy_delivered_kwh:       energyKwh,
          energy_delivered_wh:        reportEnergyWh,
          energy_delivered_formatted: energyStr,
          duration_minutes:           Math.round(reportDurationMs / 60000),
          duration_formatted:         durationStr,
          reason,
          amps:    sessionAmps || 0,
          phases:  sessionPhases,
          message,
        })
        .catch((err) => this.log('[OCPP] Trigger ocpp_charging_stopped failed:', err.message));
    }
  }

  onServerStarted(port) {
    this.log(`[OCPP] Server listening on port ${port}`);
    this._set('ocpp_server_status', 'waiting').catch(() => {});
  }

  onServerError(err) {
    this.error('[OCPP] Server error:', err.message);
    this._set('ocpp_server_status', 'error').catch(() => {});
    this.setUnavailable('OCPP server error: ' + err.message).catch(() => {});
  }

  // ─── Charging control ────────────────────────────────────────────────────

  async startCharging(amps, overridePhases, owner) {
    this._startInFlight = true;
    try {
      return await this._startChargingInner(amps, overridePhases, owner);
    } finally {
      this._startInFlight = false;
    }
  }

  async _startChargingInner(amps, overridePhases, owner) {
    const stationId   = this.getSetting('station_id');
    const server      = OcppServer.getInstance(this.homey);
    const defaultAmps = parseInt(this.getSetting('default_charging_amps'), 10) || 16;

    // Set (or clear) session phase override before any _getPhases() call
    this.sessionPhaseOverride = (overridePhases === 1 || overridePhases === 3) ? overridePhases : null;

    const targetAmps = amps != null ? amps : (this.pendingStartAmps || defaultAmps);
    this.pendingStartAmps = null;

    // Hardware floor check before any state mutation
    this._validateProfileRequest(targetAmps, this._getPhases());

    if (this._txnId && this._autoStartBlocked) {
      // Existing blocked transaction: raise the limit instead of starting fresh
      this._autoStartBlocked = false;
      this._txnAmps = targetAmps;
      this.sessionOwner = owner || 'user';
      await this._saveSession();
      const unblockResp = await server.setTxProfileAsync(stationId, this._txnId, targetAmps, this._getPhases());
      this.log(`[OCPP] Unblock TxProfile response: ${JSON.stringify(unblockResp)}`);
      await this._set('evcharger_charging', true);
      await this._setChargingState('charging');
      await this._set('ocpp_last_message', 'Charging started');
      await this._updateSessionStatus('charging');
      this._updateChargingProfile().catch(() => {});
      const phases  = this._getPhases();
      const message = `Charging started · ${this._kwLabel(targetAmps, phases)} (${targetAmps}A) / ${this._phaseLabel(phases)}`;
      await this._postNotification('🔋', 'Charging Started', message);
      this.homey.flow.getDeviceTriggerCard('ocpp_charging_started')
        .trigger(this, { amps: targetAmps, phases, phase_label: this._phaseLabel(phases), message,
          transaction_id: this._txnId || 0, meter_start: this._txnMeterStart || 0 })
        .catch(() => {});
      this.log(`[OCPP] Unblocked transaction ${this._txnId} at ${targetAmps}A (owner: ${this.sessionOwner})`);
      return;
    }

    // No active transaction — set limit and send RemoteStartTransaction
    this._txnAmps = targetAmps;
    this.sessionOwner = owner || 'user';
    this._manualStartRequested = true;
    try {
      const limitResp = await server.setMaxCurrentAsync(stationId, targetAmps, this._getPhases());
      this.log(`[OCPP] setMaxCurrent response: ${JSON.stringify(limitResp)}`);
    } catch (e) { this.log('[OCPP] setMaxCurrent before start failed:', e.message); }
    const startResp = await server.remoteStartAsync(stationId);
    this.log(`[OCPP] RemoteStart response: ${JSON.stringify(startResp)}`);
    if (startResp && startResp.status === 'Rejected') {
      this.log('[OCPP] RemoteStart rejected by charger');
    }
    this._updateChargingProfile().catch(() => {});

    // Safety-net: re-apply TxProfile 3 s after RemoteStart
    if (this._pendingTxProfileTimer) this.homey.clearTimeout(this._pendingTxProfileTimer);
    const safetyAmps   = targetAmps;
    const safetyPhases = this._getPhases();
    this._pendingTxProfileTimer = this.homey.setTimeout(() => {
      this._pendingTxProfileTimer = null;
      if (!this._txnId || this._autoStartBlocked) return;
      server.setTxProfileAsync(stationId, this._txnId, safetyAmps, safetyPhases)
        .then(r => this.log(`[OCPP] Safety-net TxProfile applied: ${safetyAmps}A — ${JSON.stringify(r)}`))
        .catch(e => this.log(`[OCPP] Safety-net TxProfile failed: ${e.message}`));
    }, 3000);
  }

  async stopCharging(source) {
    if (!this._txnId) {
      if (this.stitchedSession && this.stitchedSession.paused) {
        this.log('[OCPP] Stop during masked pause — finalizing logical session');
        await this._finalizeStitchedSession('Remote');
        await this._updateSessionStatus('connected');
        return;
      }
      this.log('[OCPP] No active transaction to stop');
      return;
    }
    try {
      const response = await OcppServer.getInstance(this.homey).remoteStopAsync(this.getSetting('station_id'));
      this.log('[OCPP] RemoteStop response:', JSON.stringify(response));
    } catch (e) {
      this.log('[OCPP] RemoteStop failed:', e.message);
      throw e;
    }
  }

  // ─── Masked Pause / Resume ───────────────────────────────────────────────

  async pauseCharging(context) {
    if (this.stitchedSession && this.stitchedSession.paused) {
      this.log('[OCPP] Already paused — ignoring duplicate pause');
      return;
    }
    if (!this._txnId) {
      throw new Error('No active charging session to pause.');
    }

    if (!context || context === 'user') {
      this.sessionOwner = 'user';
    }

    const resumeAmps   = this._txnAmps || parseInt(this.getSetting('default_charging_amps'), 10) || 16;
    const resumePhases = this.sessionPhaseOverride;
    const prior        = this.stitchedSession;
    const pauseOwner   = this.sessionOwner;

    this.stitchedSession = {
      originalStartTime:   prior ? prior.originalStartTime   : this._txnStartTime,
      accumulatedEnergyWh: prior ? (prior.accumulatedEnergyWh || 0) : 0,
      paused:              true,
      stopRequested:       true,
      resuming:            false,
      resumeAmps,
      resumePhases,
      owner:               pauseOwner,
    };
    this.isPaused = true;
    await this._persistStitched();

    this.log(`[OCPP] Masked pause: stopping transaction ${this._txnId} (context=${context || 'user'}, will resume at ${resumeAmps}A)`);

    const pauseMessage = 'Charging paused';

    try {
      const stopResponse = await OcppServer.getInstance(this.homey).remoteStopAsync(this.getSetting('station_id'));
      if (stopResponse && stopResponse.status === 'Rejected') {
        throw new Error('Charger rejected the stop request');
      }
      await this._postNotification('⏸️', 'Charging Paused', pauseMessage);
      this.homey.flow.getDeviceTriggerCard('ocpp_charging_paused')
        .trigger(this, { resume_amps: resumeAmps, message: pauseMessage })
        .catch((err) => this.log('[OCPP] Trigger ocpp_charging_paused failed:', err.message));
    } catch (e) {
      this.log(`[OCPP] Pause failed: ${e.message}`);
      this.stitchedSession = prior || null;
      this.isPaused = !!(prior && prior.paused);
      await this._persistStitched();
      throw e;
    }
  }

  async resumeCharging(source) {
    if (!this.stitchedSession || !this.stitchedSession.paused) {
      if (this._txnId) {
        this.log('[OCPP] Not paused — ignoring resume');
        return;
      }
      throw new Error('No paused charging session to resume.');
    }

    const { resumeAmps, resumePhases } = this.stitchedSession;
    this.stitchedSession.paused   = false;
    this.stitchedSession.resuming = true;
    this.isPaused = false;
    await this._persistStitched();

    this.log(`[OCPP] Masked resume: starting transaction stitched onto paused session (${resumeAmps}A${resumePhases ? `/${resumePhases}P` : ''})`);
    try {
      // Preserve the phase override from the paused session; keep existing owner
      await this.startCharging(this._txnAmps || resumeAmps, resumePhases || undefined, this.sessionOwner);
    } catch (e) {
      this.log(`[OCPP] Resume failed: ${e.message}`);
      this.stitchedSession.paused   = true;
      this.stitchedSession.resuming = false;
      this.isPaused = true;
      await this._persistStitched();
      throw e;
    }
  }

  async _persistStitched() {
    await this.setStoreValue('stitchedSession', this.stitchedSession).catch(() => {});
  }

  async _finalizeStitchedSession(reason) {
    const s = this.stitchedSession;
    if (!s) return;
    this.stitchedSession = null;
    this.isPaused = false;
    await this._persistStitched();

    const reportDurationMs = s.originalStartTime ? (Date.now() - s.originalStartTime) : 0;
    const reportEnergyWh   = s.accumulatedEnergyWh || 0;
    const durationStr      = this._formatDuration(reportDurationMs);
    const energyStr        = this._formatEnergy(reportEnergyWh);
    const message          = `Charging finished · ${energyStr} · ${durationStr}`;

    this.log(`[OCPP] Stitched session finalized (${reason}): ${reportEnergyWh}Wh over ${durationStr}`);
    this.lastStopReason = reason;
    await this.setStoreValue('lastStopReason', reason).catch(() => {});

    if (reportDurationMs >= 5000 && s.originalStartTime) {
      await this._recordSession({ durationMs: reportDurationMs, energyWh: reportEnergyWh, amps: s.resumeAmps || null, phases: this._getPhases(), reason, startTime: s.originalStartTime, owner: s.owner || null });
    }
    if (reportEnergyWh > 0) {
      await this._postNotification('🔌', 'Charging Stopped', message);
    }
    this.homey.flow.getDeviceTriggerCard('ocpp_charging_stopped')
      .trigger(this, {
        energy_delivered_kwh:       parseFloat((reportEnergyWh / 1000).toFixed(3)),
        energy_delivered_wh:        reportEnergyWh,
        energy_delivered_formatted: energyStr,
        duration_minutes:           Math.round(reportDurationMs / 60000),
        duration_formatted:         durationStr,
        reason,
        amps:    s.resumeAmps || 0,
        phases:  this._getPhases(),
        message,
      })
      .catch((err) => this.log('[OCPP] Trigger ocpp_charging_stopped failed:', err.message));
  }

  // ─── Power-verified start announcement ──────────────────────────────────

  async _announceVerifiedStart(v) {
    const amps   = v.activeAmps || this._txnAmps || 0;
    const phases = this._getPhases();

    if (v.isMaskedResume) {
      if (this.stitchedSession) {
        this.stitchedSession.resuming = false;
        await this._persistStitched();
      }
      const message = `Charging resumed · ${this._kwLabel(amps, phases)} (${amps}A) / ${this._phaseLabel(phases)}`;
      await this._postNotification('▶️', 'Charging Resumed', message);
      this.homey.flow.getDeviceTriggerCard('ocpp_charging_resumed')
        .trigger(this, { amps, phases, phase_label: this._phaseLabel(phases), message })
        .catch((err) => this.log('[OCPP] Trigger ocpp_charging_resumed failed:', err.message));
      return;
    }

    const message = `Charging started · ${this._kwLabel(amps, phases)} (${amps}A) / ${this._phaseLabel(phases)}`;
    await this._postNotification('🔋', 'Charging Started', message);
    this.homey.flow.getDeviceTriggerCard('ocpp_charging_started')
      .trigger(this, { amps, phases, phase_label: this._phaseLabel(phases), message,
        transaction_id: this._txnId || 0, meter_start: this._txnMeterStart || 0 })
      .catch((err) => this.log('[OCPP] Trigger ocpp_charging_started failed:', err.message));
  }

  // ─── Release charger ─────────────────────────────────────────────────────

  async releaseCharger() {
    this.log('[OCPP] Releasing charger: ChangeAvailability → Operative');
    try {
      const response = await OcppServer.getInstance(this.homey).changeAvailabilityAsync(this.getSetting('station_id'), 0, 'Operative');
      this.log('[OCPP] ChangeAvailability response:', JSON.stringify(response));
    } catch (e) {
      this.log('[OCPP] Release failed:', e.message);
      throw e;
    }
  }

  // ─── Charge Now ──────────────────────────────────────────────────────────
  // One-tap 16A start — takes over any engine session without suppressing future automation.

  async chargeNow() {
    if (this.chargerOffline) {
      throw new Error('Charger is offline — cannot start charging.');
    }
    const state = this.getCapabilityValue('session_status');
    if (!this._txnId && state === 'not_connected') {
      throw new Error('No car connected — plug in first, then Charge Now.');
    }

    const targetAmps  = 16; // always 16A — "important travel" semantics
    this.log(`[OCPP] Charge Now: ${targetAmps}A`);

    // If an engine session is paused, resume it at 16A
    if (this.stitchedSession && this.stitchedSession.paused) {
      this._txnAmps = targetAmps;
      this.stitchedSession.resumeAmps = targetAmps;
      await this.resumeCharging('user');
      return;
    }
    // If a session is active (engine or otherwise), raise limit to 16A
    if (this._txnId && !this._autoStartBlocked) {
      await this.setChargingLimit(targetAmps, undefined, 'user');
      return;
    }
    // Otherwise start fresh at 16A
    await this.startCharging(targetAmps, undefined, 'user');
  }

  // ─── Reboot charger ──────────────────────────────────────────────────────
  // A reboot takes 2–3 minutes of silence — suppress the offline watchdog alert.

  async rebootCharger(type = 'Soft') {
    this._expectedOfflineUntil = Date.now() + 300_000;
    this.log(`[OCPP] Sending Reset (${type}) to charger...`);
    const response = await OcppServer.getInstance(this.homey).resetAsync(this.getSetting('station_id'), type);
    this.log(`[OCPP] Reset (${type}) response: ${JSON.stringify(response)}`);
    return response;
  }

  // ─── Set charging limit ───────────────────────────────────────────────────

  async setChargingLimit(amps, overridePhases, source) {
    if (!Number.isInteger(amps) || amps < MIN_AMPS || amps > MAX_AMPS) {
      throw new Error(`Invalid amps: ${amps}. Must be a whole number between ${MIN_AMPS} and ${MAX_AMPS}.`);
    }

    // Set phase override first so _getPhases() returns the right value for validate
    if (overridePhases === 1 || overridePhases === 3) {
      this.sessionPhaseOverride = overridePhases;
      this.log(`[OCPP] Phase override set to ${overridePhases} via explicit amps+phase card`);
    }

    // Hardware floor check before any state mutation
    this._validateProfileRequest(amps, this._getPhases());

    const stationId  = this.getSetting('station_id');
    const server     = OcppServer.getInstance(this.homey);
    const prevAmps   = this._txnAmps;
    const prevPhases = this._getPhases();

    // Cancel any pending safety-net TxProfile — an explicit limit always wins
    if (this._pendingTxProfileTimer) {
      this.homey.clearTimeout(this._pendingTxProfileTimer);
      this._pendingTxProfileTimer = null;
      this.log('[OCPP] Cancelled pending safety-net TxProfile — explicit limit takes precedence');
    }

    if (this._txnId && !this._autoStartBlocked) {
      this._txnAmps = amps;
      await this._saveSession();
      const r = await server.setTxProfileAsync(stationId, this._txnId, amps, this._getPhases());
      this.log(`[OCPP] setTxProfile response: ${JSON.stringify(r)}`);
      await this._set('target_current', amps);
      this._updateChargingProfile().catch(() => {});

      const newPhases = this._getPhases();
      if (prevAmps !== null && (prevAmps !== amps || prevPhases !== newPhases)) {
        const message = prevAmps
          ? `Charging limit changed · ${this._kwLabel(prevAmps, prevPhases)} (${prevAmps}A) → ${this._kwLabel(amps, newPhases)} (${amps}A) / ${this._phaseLabel(newPhases)}`
          : `Charging limit changed · ${this._kwLabel(amps, newPhases)} (${amps}A) / ${this._phaseLabel(newPhases)}`;
        await this._postNotification('⚡', 'Charging Limit Changed', message);
        this.homey.flow.getDeviceTriggerCard('ocpp_charging_limit_changed')
          .trigger(this, {
            amps,
            previous_amps: prevAmps || 0,
            phases:        newPhases,
            phase_label:   this._phaseLabel(newPhases),
            message,
          })
          .catch((err) => this.log('[OCPP] Trigger ocpp_charging_limit_changed failed:', err.message));
      }
    } else {
      // No active transaction: remember for next start
      this.pendingStartAmps = amps;
      const r = await server.setMaxCurrentAsync(stationId, amps, this._getPhases());
      this.log(`[OCPP] setMaxCurrent response: ${JSON.stringify(r)}`);
      await this._set('target_current', amps);
      this._updateChargingProfile().catch(() => {});
    }
    this.log(`[OCPP] Charging limit set to ${amps}A`);
  }

  // The "Set max charging current" card. 0 A pauses — what its tooltip promised all along, and
  // what an EMS stop sends through "EMS wants to set charger current" ({ amps: 0 }), which
  // setChargingLimit refuses (6–32 A only), so a flow wired that way failed on every stop.
  // A session paused this way resumes at the next current above 0; one paused by hand, or by
  // anything else, stays paused until it is resumed the usual way.
  async setChargingLimitFromCard(amps) {
    if (amps === 0) {
      if (!this._txnId) {
        this.log('[OCPP] 0 A with no session running — nothing to pause');
        return;
      }
      const wasPaused = !!(this.stitchedSession && this.stitchedSession.paused);
      await this.pauseCharging();
      if (!wasPaused && this.stitchedSession && this.stitchedSession.paused) {
        this.stitchedSession.zeroAmpPause = true;
        await this._persistStitched();
      }
      return;
    }
    if (this.stitchedSession && this.stitchedSession.paused && this.stitchedSession.zeroAmpPause) {
      if (!Number.isInteger(amps) || amps < MIN_AMPS || amps > MAX_AMPS) {
        throw new Error(`Invalid amps: ${amps}. Must be a whole number between ${MIN_AMPS} and ${MAX_AMPS}.`);
      }
      this._validateProfileRequest(amps, this._getPhases());
      this.log(`[OCPP] ${amps} A after a 0 A pause — resuming`);
      this.stitchedSession.resumeAmps = amps;
      return this.resumeCharging('user');
    }
    return this.setChargingLimit(amps);
  }

  // Finishing — the charger done, the cable still in — maps to 'idle' like an empty socket, so
  // it is asked for by its raw name, the way _handleStateChange already does to tell a real
  // unplug from the end of a session.
  _carPluggedIn() {
    const state = this._chargingState();
    return state === 'connected' || state === 'charging'
      || (state === 'idle' && this._prevRawStatus === 'Finishing');
  }

  // ─── Offline watchdog ─────────────────────────────────────────────────────

  async _checkChargerOnline() {
    const server   = OcppServer.getInstance(this.homey);
    // This charger's own last message, not the server's: with two chargers on one Homey the
    // server-wide time kept a silent one looking online for as long as the other talked.
    const lastSeen = server ? server.lastMessageAtFor(this.getSetting('station_id') || '') : null;
    const silentMs = lastSeen ? (Date.now() - lastSeen) : null;
    const isOffline = !server || silentMs === null || silentMs > OFFLINE_AFTER_MS;

    if (isOffline && !this.chargerOffline) {
      if (silentMs === null && !this._bootGraceStart) this._bootGraceStart = Date.now();
      if (silentMs === null && (Date.now() - this._bootGraceStart) < OFFLINE_AFTER_MS) return;

      this.chargerOffline = true;
      this.log(`[OCPP] Charger OFFLINE: ${silentMs === null ? 'never connected' : Math.round(silentMs / 1000) + 's silent'}`);
      await this.setUnavailable('Charger offline — no OCPP messages received').catch(() => {});
      await this._updateSessionStatus(this._chargingState());

      const expected = Date.now() < this._expectedOfflineUntil;
      if (!expected) {
        await this._postNotification('📡', 'Charger Offline', 'Charger offline — connection lost');
        this.homey.flow.getDeviceTriggerCard('ocpp_charger_offline')
          .trigger(this, { message: 'Charger offline — connection lost' })
          .catch((err) => this.log('[OCPP] Trigger ocpp_charger_offline failed:', err.message));
      }
      this._offlineWasAlerted = !expected;
      await this.setStoreValue('chargerWasOffline', true).catch(() => {});
      return;
    }

    if (!isOffline && this.chargerOffline) {
      this.chargerOffline = false;
      this._bootGraceStart = null;
      await this.setStoreValue('chargerWasOffline', false).catch(() => {});
      this.log('[OCPP] Charger back ONLINE');
      await this.setAvailable().catch(() => {});
      await this._updateSessionStatus(this._chargingState());

      if (this._offlineWasAlerted) {
        await this._postNotification('📡', 'Charger Online', 'Charger back online');
        this.homey.flow.getDeviceTriggerCard('ocpp_charger_online')
          .trigger(this, { message: 'Charger back online' })
          .catch((err) => this.log('[OCPP] Trigger ocpp_charger_online failed:', err.message));
      }
      this._offlineWasAlerted = false;
    }
  }

  // ─── Idle guard ─────────────────────────────────────────────────────────

  _startIdleGuard() {
    this._clearIdleGuard();
    const autoStart = this.getSetting('auto_start_charging') !== false;
    if (!autoStart) {
      this._idleGuardTimer = this.homey.setInterval(async () => {
        // Skip while a start sequence is in flight, or after a restart
        // while waiting for the charger to reconnect and send StatusNotification.
        if (this._startInFlight || this.assumeActiveFromRestart) return;
        if (!this._txnId) {
          try {
            const r = await OcppServer.getInstance(this.homey)
              .setMaxCurrentAsync(this.getSetting('station_id'), BLOCK_AMPS, this._getPhases());
            this.log(`[OCPP] Idle guard: refreshed 0A TxDefaultProfile → ${(r && r.status) || 'no status'}`);
          } catch (e) { this.log(`[OCPP] Idle guard refresh failed: ${e.message}`); }
        }
      }, IDLE_GUARD_MS);
      this.log('[OCPP] Idle guard started (auto-start OFF)');
    }
  }

  _clearIdleGuard() {
    if (this._idleGuardTimer) {
      this.homey.clearInterval(this._idleGuardTimer);
      this._idleGuardTimer = null;
    }
  }

  // ─── Session persistence ──────────────────────────────────────────────────

  async _saveSession() {
    await this.setStoreValue('activeSession', {
      txnId:      this._txnId,
      startTime:  this._txnStartTime,
      meterStart: this._txnMeterStart,
      amps:       this._txnAmps,
      phases:     this.sessionPhaseOverride,
      owner:      this.sessionOwner,
    }).catch(() => {});
  }

  async _recordSession(entry) {
    try {
      const history = (await this.getStoreValue('sessionHistory')) || [];
      history.push({ ...entry, stopTime: Date.now() });
      while (history.length > MAX_SESSION_HIST) history.shift();
      await this.setStoreValue('sessionHistory', history);
    } catch (e) { /* ignore */ }
  }

  // ─── Capability listeners ────────────────────────────────────────────────

  _registerCapabilityListeners() {
    // Standard EV control capabilities. Homey's "Set target power" flow sets
    // target_power_mode, evcharger_charging and target_power in quick succession —
    // registerMultipleCapabilityListener debounces them into one call so we send
    // a single command to the charger. (Homey EV charger spec, v12.4.5+.)
    this.registerMultipleCapabilityListener(
      ['evcharger_charging', 'target_power', 'target_power_mode'],
      async ({ evcharger_charging, target_power, target_power_mode }) => {
        // Who is in charge. Homey's documentation is explicit: in "device" mode the
        // charger runs its own logic and target power values from Homey are ignored; in
        // "homey" mode Homey is in control and the device does what it is told.
        //
        // This used to be logged and otherwise disregarded, which made the mode picker
        // decorative — Homey could show "Automatic" while the app acted on every value it
        // was handed. Honouring it costs nothing at the moment it matters: Homey sends the
        // mode together with the value whenever it takes control, which is precisely why
        // these three capabilities share one debounced listener.
        const previousMode = this.getCapabilityValue('target_power_mode');
        if (target_power_mode !== undefined) {
          this.log(`[OCPP] target_power_mode → ${target_power_mode}`);
          // The documentation also asks that a switch back to device mode discard the
          // setpoint and resume internal logic. What is deliberately NOT done here is
          // yanking a session that is already running: this charger's automation lives in
          // the EMS device, which sets its own limit on the next decision anyway, and
          // cutting a car's charge because someone changed a picker would be its own bug.
          if (previousMode === 'homey' && target_power_mode !== 'homey') {
            this.log('[OCPP] Homey handed control back; the running limit stands until the '
              + 'charger or the EMS sets its own');
          }
        }
        const effectiveMode = target_power_mode ?? previousMode ?? 'homey';

        // Explicit stop wins over everything else. This is the on/off switch rather than a
        // power target, so it is honoured in either mode.
        if (evcharger_charging === false) {
          await this.stopCharging();
          return;
        }

        // A watt target translates to an amp limit (0 / dead-zone → stop).
        if (target_power !== undefined && target_power !== null) {
          if (effectiveMode !== 'homey') {
            this.log(`[OCPP] target_power ${target_power} W ignored — mode is `
              + `"${effectiveMode}", so the charger is in control`);
            return;
          }
          const amps = this._wattsToAmps(target_power);
          if (amps <= 0) {
            await this.stopCharging();
            return;
          }
          if (this._txnId && !this._autoStartBlocked) await this.setChargingLimit(amps);
          else await this.startCharging(amps);
          return;
        }

        // Plain start at the current/default limit.
        if (evcharger_charging === true) {
          await this.startCharging();
        }
      },
      500,
    );

    this.registerCapabilityListener('target_current', async (value) => {
      await this.setChargingLimit(value);
    });

    if (this.hasCapability('release_charger')) {
      this.registerCapabilityListener('release_charger', async () => {
        await this.releaseCharger();
      });
    }

    if (this.hasCapability('pause_charging')) {
      this.registerCapabilityListener('pause_charging', async () => {
        await this.pauseCharging('user');
      });
    }

    if (this.hasCapability('resume_charging')) {
      this.registerCapabilityListener('resume_charging', async () => {
        await this.resumeCharging('user');
      });
    }

    if (this.hasCapability('charge_now')) {
      this.registerCapabilityListener('charge_now', async () => {
        await this.chargeNow();
      });
    }

  }

  // ─── Flow conditions ──────────────────────────────────────────────────────
  //
  // These answer questions rather than issue commands, which this driver could not do at
  // all until now — it had ten triggers and eleven actions and no conditions, alone among
  // the drivers in this app. "Is the charger online" is the one that was most missed:
  // every one of those eleven actions fails on an offline charger, and there was no way to
  // ask first.
  //
  // Read through args.device, not `this`. The action cards above register once per device
  // instance and then filter on the id, which works for one charger and quietly stops
  // working for two — Homey keeps only the last run listener registered on a card, so the
  // survivor's filter rejects every other device. Taking the device from the arguments
  // needs no filter and is correct however many chargers exist.
  _registerFlowConditions() {
    this.homey.flow.getConditionCard('ocpp_charger_is_online')
      .registerRunListener(async (args) => !args.device.chargerOffline);

    this.homey.flow.getConditionCard('ocpp_is_charging')
      .registerRunListener(async (args) => args.device._chargingState() === 'charging');

    // Plugged in covers everything from the cable going in to it coming out: waiting for a
    // start, charging, paused, finished. 'error' means the charger stopped telling us, which
    // is not the same as an empty socket — and not proof of a cable either.
    this.homey.flow.getConditionCard('ocpp_car_is_plugged_in')
      .registerRunListener(async (args) => args.device._carPluggedIn());

    this.homey.flow.getConditionCard('ocpp_session_status_is')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('session_status') === args.status);
  }

  // ─── Flow actions ─────────────────────────────────────────────────────────

  _registerFlowActions() {
    // Every listener acts on args.device, never on `this`.
    //
    // These used to call the methods on `this` and guard with
    // `if (args.device.id !== this.id) return;`. That works for one charger and stops
    // working, silently, for two: Homey keeps only the LAST run listener registered on a
    // card, and each device registers over the previous one. The survivor's guard then
    // rejects every device except itself, so an action pointed at the other charger does
    // nothing at all — no error, no log line, just a Flow step that appears to succeed.
    //
    // Taking the device from the arguments removes the need for a guard: whichever
    // instance happened to register last, the listener operates on the charger the Flow
    // actually names. The registration is still per device, which is now harmless.
    this.homey.flow.getActionCard('ocpp_set_max_current')
      .registerRunListener(async (args) => args.device.setChargingLimitFromCard(Number(args.amperes)));

    this.homey.flow.getActionCard('ocpp_remote_start')
      .registerRunListener(async (args) => args.device.startCharging());

    this.homey.flow.getActionCard('ocpp_start_charging_at')
      .registerRunListener(async (args) => args.device.startCharging(args.amperes));

    this.homey.flow.getActionCard('ocpp_start_charging_at_phase')
      .registerRunListener(async (args) =>
        args.device.startCharging(args.amperes, parseInt(args.phases, 10)));

    this.homey.flow.getActionCard('ocpp_set_charging_limit_at_phase')
      .registerRunListener(async (args) =>
        args.device.setChargingLimit(args.amperes, parseInt(args.phases, 10)));

    this.homey.flow.getActionCard('ocpp_remote_stop')
      .registerRunListener(async (args) => args.device.stopCharging());

    this.homey.flow.getActionCard('ocpp_pause_charging')
      .registerRunListener(async (args) => args.device.pauseCharging());

    this.homey.flow.getActionCard('ocpp_resume_charging')
      .registerRunListener(async (args) => args.device.resumeCharging());

    this.homey.flow.getActionCard('ocpp_release_charger')
      .registerRunListener(async (args) => args.device.releaseCharger());

    this.homey.flow.getActionCard('ocpp_reboot_charger')
      .registerRunListener(async (args) => args.device.rebootCharger(args.type || 'Soft'));

    this.homey.flow.getActionCard('ocpp_charge_now')
      .registerRunListener(async (args) => args.device.chargeNow());
  }

  // ─── Capabilities management ─────────────────────────────────────────────

  async _ensureCapabilities() {
    for (const cap of REQUIRED_CAPABILITIES) {
      // An optional capability that is switched off is handled below, not here — adding it
      // and removing it again on every start would churn the device for no reason.
      if (OPTIONAL_CAPABILITIES[cap] && !this._optionalWanted(cap)) continue;
      if (!this.hasCapability(cap)) {
        try {
          await this.addCapability(cap);
          this.log(`[OCPP] Added capability: ${cap}`);
        } catch (err) {
          this.error(`addCapability(${cap}) failed:`, err.message);
        }
      }
    }
    await this._applyOptionalCapabilities();
  }

  // Defaults to on when the setting has never been written — an existing device that was
  // paired before the switch existed keeps the tile it already has.
  _optionalWanted(cap) {
    return this.getSetting(OPTIONAL_CAPABILITIES[cap]) !== false;
  }

  // Brings the device in line with the switches. Called at startup and whenever one of them
  // changes, so the tile appears and disappears without needing the device re-paired.
  async _applyOptionalCapabilities(settings) {
    for (const [cap, key] of Object.entries(OPTIONAL_CAPABILITIES)) {
      const wanted = settings ? settings[key] !== false : this._optionalWanted(cap);
      const has    = this.hasCapability(cap);
      if (wanted === has) continue;
      try {
        if (wanted) await this.addCapability(cap);
        else        await this.removeCapability(cap);
        this.log(`[OCPP] ${wanted ? 'Added' : 'Removed'} optional capability: ${cap}`);
      } catch (err) {
        this.error(`${wanted ? 'add' : 'remove'}Capability(${cap}) failed:`, err.message);
      }
    }
  }

  async _set(capability, value) {
    if (value === null || value === undefined) return;
    if (!this.hasCapability(capability)) return;
    // Mirror the amp limit onto the standard `target_power` (W) capability so the
    // native EV tile/energy view reflects the setpoint. setCapabilityValue does not
    // re-trigger the capability listener, so this can't loop.
    if (capability === 'target_current' && this.hasCapability('target_power')) {
      const w = AMPS_TO_WATTS(value, this._getPhases());
      if (this.getCapabilityValue('target_power') !== w) {
        this.setCapabilityValue('target_power', w).catch(() => {});
      }
    }
    if (this.getCapabilityValue(capability) === value) return;
    try { await this.setCapabilityValue(capability, value); }
    catch (err) { this.log(`_set(${capability}, ${value}) failed:`, err.message); }
  }

  // ─── Session status capability ────────────────────────────────────────────

  // What the charger is doing, in this app's own words. Held in memory while running and
  // recovered from the Homey capability after a restart - which is why that capability has
  // to carry a value Homey will actually accept; see HOMEY_EV_STATE for why it did not.
  _chargingState() {
    if (this._internalChargingState) return this._internalChargingState;
    return INTERNAL_FROM_HOMEY[this.getCapabilityValue('evcharger_charging_state')] || 'idle';
  }

  // Writes both: this app's word is kept as it is, Homey's is translated. `homeyOverride`
  // lets a caller that knows more than the internal vocabulary can express - a paused
  // connector, say - pass the more precise enum value.
  async _setChargingState(internal, homeyOverride) {
    this._internalChargingState = internal;
    const homeyState = homeyOverride || HOMEY_EV_STATE[internal];
    if (homeyState) await this._set('evcharger_charging_state', homeyState);
  }

  _computeSessionStatus(chargingState, autoStartOverride) {
    if (this.chargerOffline) return 'offline';
    if (chargingState === 'error') return 'error';
    if (this.stitchedSession && this.stitchedSession.paused && chargingState !== 'idle') return 'paused';
    if (chargingState === 'charging') {
      if (this._lowPowerSince && (Date.now() - this._lowPowerSince) >= LOW_POWER_FINISH_MS) return 'finishing';
      return 'charging';
    }
    if (chargingState === 'idle') return 'not_connected';
    if (chargingState === 'connected') {
      if (this.lastStopReason === 'Local') return 'fully_charged';
      const autoStart = (autoStartOverride !== undefined)
        ? autoStartOverride !== false
        : this.getSetting('auto_start_charging') !== false;
      return autoStart ? 'connected' : 'smart_charging';
    }
    return 'not_connected';
  }

  async _updateSessionStatus(chargingState, autoStartOverride) {
    const status = this._computeSessionStatus(chargingState, autoStartOverride);
    await this._set('session_status', status);
    await this._set('status_summary', this._composeStatusSummary(status));
  }

  _composeStatusSummary(status) {
    const session = this.getCurrentSessionInfo();
    switch (status) {
      case 'charging': {
        const powerW = this.getCapabilityValue('measure_power') || 0;
        return `Charging · ${(powerW / 1000).toFixed(1)} kW`;
      }
      case 'finishing':
        return session ? `Finishing · ${this._formatEnergy(session.energyWh)}` : 'Finishing';
      case 'paused':
        return session ? `Paused · ${this._formatEnergy(session.energyWh)}` : 'Paused';
      case 'fully_charged':  return 'Fully Charged';
      case 'smart_charging': return 'Ready to start';
      case 'connected':      return 'Connected';
      case 'not_connected':  return 'Idle';
      case 'offline':        return 'Offline';
      case 'error':          return 'Error';
      default: return status;
    }
  }

  // ─── Charging profile capability ─────────────────────────────────────────

  async _updateChargingProfile() {
    const amps   = this._txnAmps || this.pendingStartAmps || parseInt(this.getSetting('default_charging_amps'), 10) || 16;
    const phases = this._getPhases();
    const kw     = (Math.floor(amps * phases * 230 / 100) / 10).toFixed(1);
    await this._set('charging_profile', `${kw} kW / ${amps}A / ${phases}P`);
    await this._set('target_current', amps);
  }

  // ─── Phase count ──────────────────────────────────────────────────────────

  _getPhases() {
    if (this.sessionPhaseOverride === 1 || this.sessionPhaseOverride === 3) return this.sessionPhaseOverride;
    const phases = parseInt(this.getSetting('number_of_phases'), 10);
    return (phases === 1 || phases === 3) ? phases : 3;
  }

  _devicePhases() {
    const phases = parseInt(this.getSetting('number_of_phases'), 10);
    return (phases === 1 || phases === 3) ? phases : 3;
  }

  // Convert a standard `target_power` (W) request into an amp limit for the
  // configured phase count. Anything inside the single-phase 6A dead-zone
  // (<1380 W) is treated as idle; otherwise clamp to the 6–32 A hardware range.
  _wattsToAmps(watts) {
    if (!Number.isFinite(watts) || Math.abs(watts) < 1380) return 0;
    const phases = this._getPhases();
    let amps = Math.round(Math.abs(watts) / (phases * 230));
    if (amps < MIN_AMPS) amps = MIN_AMPS;
    if (amps > MAX_AMPS) amps = MAX_AMPS;
    return amps;
  }

  // ─── Hardware floor validation ────────────────────────────────────────────
  // Huawei's OCPP firmware ignores numberPhases — it always spreads the watt
  // limit across all physical phases. A 6A request on a 3-phase unit results
  // in ~2A/phase (under the IEC 61851 6A floor), causing an instant abort.

  _validateProfileRequest(amps, requestedPhases) {
    const devicePhases = this._devicePhases();
    if (requestedPhases > devicePhases) {
      throw new Error(`This charger is configured as ${this._phaseLabel(devicePhases)} — a ${this._phaseLabel(requestedPhases)} profile can't be delivered on it.`);
    }
    const model = this.getSetting('charger_model') || 'other';
    const watts = AMPS_TO_WATTS(amps, requestedPhases);
    if (model === '7ks' || model === '22kt') {
      // Huawei firmware ignores numberPhases and spreads watts across all physical phases.
      // A 6A mono request on a 3-phase unit = 2A/phase → instant abort (IEC 61851 floor).
      const perPhaseAmps = watts / (devicePhases * 230);
      if (perPhaseAmps < 6) {
        const minKw = (Math.floor(1380 * devicePhases / 100) / 10).toFixed(1);
        throw new Error(`Below this charger's minimum: Huawei chargers ignore the phase choice, so the ${watts}W requested spreads across all ${devicePhases} phases (~${Math.round(perPhaseAmps * 10) / 10}A each, under the 6A hardware floor). Lowest deliverable is 6A ${this._phaseLabel(devicePhases)} = ${minKw} kW.`);
      }
    } else {
      // Other vendors may honour numberPhases — validate per requested phase.
      if (amps < 6) {
        throw new Error(`Below the 6A minimum charging current (IEC hardware floor) — ${amps}A ${this._phaseLabel(requestedPhases)} can't be delivered.`);
      }
    }
  }

  // ─── Label helpers ────────────────────────────────────────────────────────

  _kwLabel(amps, phases) {
    // Truncated to one decimal (EV convention: 16A mono = 3680W = "3.6 kW", not "3.7")
    return `${(Math.floor(AMPS_TO_WATTS(amps, phases) / 100) / 10).toFixed(1)} kW`;
  }

  _phaseLabel(phases) {
    return phases === 1 ? 'Mono-Phase' : 'Tri-Phase';
  }

  // ─── Timeline notifications ───────────────────────────────────────────────

  async _postNotification(emoji, title, text) {
    if (this.getSetting('enable_timeline_notifications') === false) {
      this.log(`[OCPP] Timeline notification skipped (disabled): ${emoji} ${title}`);
      return;
    }
    try {
      this.log(`[OCPP] Timeline: ${emoji} ${title} — ${text}`);
      await this.homey.notifications.createNotification({ excerpt: `${emoji} ${text}` });
    } catch (err) {
      this.log(`[OCPP] Notification failed: ${err.message}`);
      try {
        if (this.homey.timeline && this.homey.timeline.createPost) {
          await this.homey.timeline.createPost({ text: `${emoji} ${text}` });
          this.log(`[OCPP] Timeline posted (fallback): ${title}`);
        }
      } catch (err2) {
        this.log(`[OCPP] Timeline fallback also failed: ${err2.message}`);
      }
    }
  }

  // ─── Format helpers ───────────────────────────────────────────────────────

  _formatEnergy(wh) {
    if (wh >= 1000) return `${(wh / 1000).toFixed(2)} kWh`;
    return `${Math.round(wh)} Wh`;
  }

  _formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const hours   = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
  }

  // ─── Debug helpers ────────────────────────────────────────────────────────

  _trackLastNonZero(key, value) {
    if (!value || value <= 0) return;
    if (!this._lastNonZero) this._lastNonZero = {};
    this._lastNonZero[key] = { value, at: new Date().toISOString() };
    this.setStoreValue('lastNonZero', this._lastNonZero).catch((err) => {
      this.log(`[OCPP] Failed to persist lastNonZero: ${err.message}`);
    });
  }

  getDebugSummary() {
    const cap = (id) => {
      try { return this.getCapabilityValue(id); } catch (e) { return null; }
    };
    return {
      name:                this.getName(),
      chargingState:       cap('evcharger_charging_state'),
      sessionStatus:       cap('session_status'),
      charging:            cap('evcharger_charging'),
      txnId:               this._txnId,
      autoStartEnabled:    this.getSetting('auto_start_charging') !== false,
      isPaused:            this.isPaused,
      chargerVendor:       this.getSetting('charger_vendor') || 'Huawei',
      chargerModel:        this.getSetting('charger_model') || 'other',
      numberOfPhases:      this._getPhases(),
      physicalPhases:      this._devicePhases(),
      phaseOverrideActive: this.sessionPhaseOverride !== null,
      pendingStartAmps:    this.pendingStartAmps,
      current: {
        power:        cap('measure_power'),
        meterPower:   cap('meter_power'),
        currentTotal: cap('measure_current'),
        currentL1:    cap('measure_current.l1'),
        currentL2:    cap('measure_current.l2'),
        currentL3:    cap('measure_current.l3'),
        voltageAvg:   cap('measure_voltage'),
        voltageL1:    cap('measure_voltage.l1'),
        voltageL2:    cap('measure_voltage.l2'),
        voltageL3:    cap('measure_voltage.l3'),
        temperature:  cap('measure_temperature'),
      },
      lastNonZero: this._lastNonZero || {},
    };
  }

  // ─── Widget API ───────────────────────────────────────────────────────────

  getWidgetStatus() {
    const sessionStatus = this.getCapabilityValue('session_status') || 'not_connected';
    const session       = this.getCurrentSessionInfo();
    const amps          = this._txnAmps
      || (this.stitchedSession ? this.stitchedSession.resumeAmps : null)
      || null;
    const phases = this._getPhases();

    // Phase-current averaging: filter noise (<0.5 A) and average only active phases
    const phaseCurrents = [
      this.getCapabilityValue('measure_current.l1'),
      this.getCapabilityValue('measure_current.l2'),
      this.getCapabilityValue('measure_current.l3'),
    ].filter((v) => typeof v === 'number' && v > 0.5);
    const currentA = phaseCurrents.length > 0
      ? phaseCurrents.reduce((a, b) => a + b, 0) / phaseCurrents.length
      : (this.getCapabilityValue('measure_current') || 0);

    return {
      sessionStatus,
      sessionOwner:     this.sessionOwner || null,
      isPaused:         this.isPaused === true,
      requestedAmps:    amps,
      limitKw:          amps ? this._kwLabel(amps, phases) : null,
      phases,
      phaseLabel:       this._phaseLabel(phases),
      powerW:           this.getCapabilityValue('measure_power') || 0,
      currentA,
      sessionStartTime: session ? session.startTime : null,
      sessionEnergyWh:  session ? session.energyWh : null,
    };
  }

  async getSessionHistory() {
    try {
      const raw = (await this.getStoreValue('sessionHistory')) || [];
      return raw.map(s => ({
        ...s,
        startTime: s.stopTime != null && s.durationMs != null ? s.stopTime - s.durationMs : null,
      })).reverse();
    } catch (e) {
      return [];
    }
  }

  // ─── Session tile sensors ──────────────────────────────────────────────────
  // meter_session_energy (kWh) + session_duration ("2h 13m") mirror the same
  // stitched-session numbers as the history widget — one source of truth
  // (getCurrentSessionInfo), so restarts and masked pauses are already handled.
  // Refreshed every 60s while a session exists; reset on unplug.

  async _updateSessionTileSensors() {
    const info = this.getCurrentSessionInfo();
    if (!info) return; // between sessions: hold last values (reset happens on unplug)
    const kwh = Math.round((info.energyWh || 0) / 10) / 100;
    await this._set('meter_session_energy', kwh);
    await this._set('session_duration', this._formatDuration(info.durationMs || 0));
  }

  async _resetSessionTileSensors() {
    await this._set('meter_session_energy', 0);
    await this._set('session_duration', '—');
  }

  getCurrentSessionInfo() {
    const s         = this.stitchedSession;
    const startTime = s ? s.originalStartTime : this._txnStartTime;
    if (!startTime) return null;

    let energyWh;
    if (s) {
      const accumulated = s.accumulatedEnergyWh || 0;
      // When paused there is no active transaction; only accumulated segments count.
      // When resumed and running, add the live segment on top.
      if (!s.paused && this._txnId && this._txnMeterStart) {
        const meterNow = (this.getCapabilityValue('meter_power') || 0) * 1000;
        energyWh = accumulated + Math.max(0, meterNow - this._txnMeterStart);
      } else {
        energyWh = accumulated;
      }
    } else {
      const meterNow = (this.getCapabilityValue('meter_power') || 0) * 1000;
      energyWh = Math.max(0, meterNow - this._txnMeterStart);
    }

    return {
      startTime,
      paused:     !!(s && s.paused),
      durationMs: Date.now() - startTime,
      energyWh:   Math.round(energyWh),
      amps:       this._txnAmps || (s ? s.resumeAmps : null),
      phases:     this._getPhases(),
    };
  }
}

// Every saved settings page in the log and the change log — see lib/change-log.js.
withSettingsLog(SmartChargerOcppDevice);

module.exports = SmartChargerOcppDevice;
