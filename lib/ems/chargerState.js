'use strict';

// Persistence for the per-charger control state. Mixed into EmsDevice.prototype;
// `this` is the device instance. Counterpart to lib/ems/simpleDevices.js, which does
// the same job for the heat pump / boiler / pool timers.
const {
  CHARGER_STATE_KEY, CHARGER_STATE_MAX_GAP_MS, CHARGER_STATE_SAVE_MS,
} = require('./constants');

/**
 * What survives a restart — and, just as deliberately, what does not.
 *
 * Carried over: things no measurement can recover. `targetReachedCar` is a decision the
 * EMS made about a car it can no longer distinguish from any other full car; the session
 * accumulators are integrated over time and cannot be re-derived after the fact;
 * `lastPhaseSwitchAt` guards a physical relay, and losing it lets a restart switch phases
 * again immediately — exactly the wear the cooldown exists to prevent.
 *
 * NOT carried over: `currentAmps` / `currentPhases`. That is the July lesson, and it cost
 * a house battery. The EMS must never believe a current it did not command in this
 * process — after a restart the only honest source is the charger's measured draw, which
 * _stepCharger adopts (see CHARGER_LIVE_W). Restoring these would reintroduce precisely
 * the "steering by memory instead of by reality" bug.
 *
 * Also not carried over: pendingStepAmps / pendingStepSince / lastDownStepAt. Those are
 * 30-second anti-thrash timers — shorter than any restart, so they have expired anyway.
 */
const CHARGER_STATE_FIELDS = [
  'targetReachedCar',
  'sessionActive', 'sessionStartedAt', 'sessionEnergyKwh', 'sessionCostSum',
  'sessionCostedKwh', 'sessionGridKwh', 'sessionCarName',
  // The two halves of sessionCostSum (lib/ems/chargeSessions.js). Left out of this list when
  // they were added, so a restart mid-charge restored the sum but not its halves: the first
  // tick after it added a price to undefined, both became NaN, and the session went into the
  // log with grid and solar shown as 0.00 beside a correct total (review 2026-10-10).
  'sessionGridCost', 'sessionSolarCost',
  'lastPhaseSwitchAt',
];

// The subset whose change must reach disk immediately rather than wait for the periodic
// write: they are rare, and each one is a decision whose loss is visible to the user.
const CHARGER_DECISION_FIELDS = ['targetReachedCar', 'sessionActive'];

module.exports = {

  /**
   * Called once from onInit, after _restoreChargeSessions (which creates the array a
   * stale session may have to be finalized into).
   */
  _restoreChargerStates(now = Date.now()) {
    let saved;
    try { saved = this.homey.settings.get(CHARGER_STATE_KEY); } catch (_) { return; }
    if (!saved || !saved.states || typeof saved.states !== 'object') return;

    const savedAt = Number(saved.savedAt) || 0;
    const gap     = now - savedAt;

    // Too old to steer by — but not too old to account for. A session that was running
    // when the app went down really did put those kWh into the car, and dropping the
    // state silently would erase them from the session log. Close it instead, ending it
    // at the moment the numbers were last true rather than at "now", which would credit
    // the whole downtime to a charge that was not happening.
    if (!(gap >= 0) || gap > CHARGER_STATE_MAX_GAP_MS) {
      const closed = this._closeStaleSessions(saved.states, savedAt);
      this.log(`[EMS] charger state discarded — ${Math.round(gap / 60_000)} min old `
        + `(max ${CHARGER_STATE_MAX_GAP_MS / 60_000})`
        + (closed ? `; ${closed} running session(s) closed at their last known reading` : ''));
      return;
    }

    let restored = 0;
    let sessions = 0;
    for (const [id, stored] of Object.entries(saved.states)) {
      if (!stored || typeof stored !== 'object') continue;
      const st = this._getChargerState(id);
      for (const f of CHARGER_STATE_FIELDS) {
        const v = stored[f];
        if (v === undefined) continue;
        // A timestamp from the future means the clock moved, not that something is
        // scheduled — drop it rather than let a cooldown never expire.
        st[f] = (typeof v === 'number' && f.endsWith('At') && v > now) ? null : v;
      }
      if (st.sessionActive) sessions++;
      restored++;
    }
    if (restored) {
      this.log(`[EMS] charger state restored — ${restored} charger(s), ${sessions} running session(s), `
        + `${Math.round(gap / 1000)}s gap`);
    }
  },

  // Books the sessions from a state blob too old to resume. Returns how many were closed.
  _closeStaleSessions(states, endedAt) {
    let closed = 0;
    const cfg = this._getConfig();
    for (const [id, stored] of Object.entries(states)) {
      if (!stored || !stored.sessionActive) continue;
      // _finalizeChargeSession drops anything under 0.05 kWh on its own.
      const before = this._chargeSessions.length;
      this._finalizeChargeSession({ id }, stored, cfg, endedAt);
      if (this._chargeSessions.length > before) closed++;
    }
    return closed;
  },

  /**
   * Called at the end of every tick, and once more from onUninit.
   *
   * Writes when a decision changed, when CHARGER_STATE_SAVE_MS has passed, or when forced
   * (shutdown). Anything else is skipped, so an idle EMS with no car plugged in never
   * touches settings at all.
   */
  _saveChargerStates(force = false, now = Date.now()) {
    if (!this._chargerStates || !this._chargerStates.size) return false;

    const states = {};
    const decisions = [];
    for (const [id, st] of this._chargerStates.entries()) {
      const clean = {};
      for (const f of CHARGER_STATE_FIELDS) if (st[f] !== undefined) clean[f] = st[f];
      states[id] = clean;
      decisions.push(id + ':' + CHARGER_DECISION_FIELDS.map((f) => String(st[f])).join('/'));
    }

    const digest    = decisions.join('|');
    const decided   = digest !== this._lastChargerDecisionDigest;
    const overdue   = !this._lastChargerStateSaveAt
      || (now - this._lastChargerStateSaveAt) >= CHARGER_STATE_SAVE_MS;
    if (!force && !decided && !overdue) return false;

    this._lastChargerDecisionDigest = digest;
    this._lastChargerStateSaveAt = now;
    try {
      this.homey.settings.set(CHARGER_STATE_KEY, { savedAt: now, states });
    } catch (e) {
      this.log(`[EMS] charger state save failed: ${e.message}`);
      return false;
    }
    return true;
  },

};

module.exports.CHARGER_STATE_FIELDS = CHARGER_STATE_FIELDS;
