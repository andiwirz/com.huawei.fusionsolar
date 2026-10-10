'use strict';

// Per-charger charging session tracking (energy + cost). Mixed into
// EmsDevice.prototype; `this` is the device instance. Works for every charging
// mode (solar/off-peak/price/low-tariff/always) — it just integrates the already
// tick-sampled charger power over time, independent of how/why the charger is on.
const { CHARGE_SESSIONS_MAX } = require('./constants');

module.exports = {

  async _restoreChargeSessions() {
    this._chargeSessions = [];
    try {
      const stored = await this.getStoreValue('chargeSessions');
      if (Array.isArray(stored)) this._chargeSessions = stored;
    } catch (e) { /* ignore */ }
  },

  _saveChargeSessions() {
    if (this._chargeSessions.length > CHARGE_SESSIONS_MAX) {
      this._chargeSessions.splice(0, this._chargeSessions.length - CHARGE_SESSIONS_MAX);
    }
    this.setStoreValue('chargeSessions', this._chargeSessions).catch(() => {});
  },

  // Called once per charger per tick (any charge mode) with the current tick's
  // dtMs — the measured gap to the previous tick, clamped, and 0 on the very first one.
  // Only ever multiplied here, so a zero simply books nothing. A session runs from
  // "car connected" to "car disconnected"; energy/cost only accumulate on ticks
  // where the charger actually drew power, so pauses (no surplus, price waiting,
  // battery protection, …) within one plug-in period don't split it into several
  // sessions — matches how a user thinks of "last night's charge" as one session.
  _trackChargeSession(charger, cfg, dtMs, gridW) {
    const st = this._getChargerState(charger.id);

    if (charger.connected && !st.sessionActive) {
      st.sessionActive        = true;
      st.sessionStartedAt     = Date.now();
      st.sessionEnergyKwh     = 0;
      st.sessionCostSum       = 0;
      st.sessionCostedKwh     = 0; // only the energy for which a price was known — avg-price denominator
      st.sessionGridKwh       = 0; // the part drawn from the grid (see the split below)
      // The two halves of sessionCostSum, kept apart because they are two different kinds
      // of money: sessionGridCost left the owner's account, sessionSolarCost is revenue
      // they chose not to take. A field question asked exactly this of a 0.51 CHF session
      // that was 97 % solar — the sum alone cannot answer it.
      st.sessionGridCost      = 0;
      st.sessionSolarCost     = 0;
      const car = this._carForCharger(charger);
      st.sessionCarName = (car && car.name) || null;
    }

    // Bill the MEASURED draw, not `powerW`: the latter carries an amps×phases estimate
    // floor (device.js _getChargers) that exists solely to stop a false "no surplus"
    // charger stop during startup lag. A car that self-caps below the commanded current
    // (tapering near full, or a 1-phase car on a 3-phase charger) really draws only
    // `rawPowerW` — billing the estimate instead inflated logged session kWh and cost by
    // up to ~3×. Same field, and the same reasoning, as the house-load energy balance in
    // device.js _getHouseW. Falls back to powerW only when the charger reports no power
    // capability at all, where the estimate is the sole figure available.
    const drawW = charger.rawPowerW ?? charger.powerW ?? 0;
    if (st.sessionActive && drawW > 0) {
      const kwh = (drawW / 1000) * (dtMs / 3600_000);
      st.sessionEnergyKwh += kwh;

      // Split the draw into grid and solar. The charger is treated as the marginal load:
      // whatever the house imports at this moment is attributed to it first, up to its own
      // draw. For an EV charger that is the honest reading — it is the load the EMS switched
      // on, so it is the one that pushed the meter into import. Import beyond its own draw
      // belongs to the rest of the house, not to the car.
      const importW = Math.max(0, (gridW === null || gridW === undefined) ? 0 : gridW);
      const gridKwh = (Math.min(drawW, importW) / 1000) * (dtMs / 3600_000);
      st.sessionGridKwh += gridKwh;

      // Grid energy costs what it costs.
      const price = this._getCurrentPrice(cfg);
      if (typeof price === 'number' && gridKwh > 0) {
        st.sessionCostSum   += gridKwh * price;
        // `|| 0`: a session restored from a version that did not save the two halves.
        st.sessionGridCost   = (st.sessionGridCost || 0) + gridKwh * price;
        st.sessionCostedKwh += gridKwh;
      }

      // Solar the car takes was never bought — but on a contract that pays for exports it
      // was not free either: it is revenue given up, at exactly the feed-in rate. This line
      // used to read "solar costs nothing", which is only true where feeding in earns
      // nothing. A sunny session then showed 0.00 and looked like the whole story.
      //
      // Only when the rate is actually configured. Without it we do not know what the solar
      // was worth, and guessing zero is what made the figure wrong in the first place — so
      // that energy stays out of the average, as it always has, and the average keeps saying
      // "per kWh whose price was known".
      const feedIn = this._feedInTariff(cfg);
      const solarKwh = Math.max(0, kwh - gridKwh);
      if (typeof feedIn === 'number' && solarKwh > 0) {
        st.sessionCostSum   += solarKwh * feedIn;
        st.sessionSolarCost  = (st.sessionSolarCost || 0) + solarKwh * feedIn;
        st.sessionCostedKwh += solarKwh;
      }
    }

    if (!charger.connected && st.sessionActive) {
      this._finalizeChargeSession(charger, st, cfg);
      st.sessionActive = false;
    }
  },

  // Ignore sessions with negligible energy (e.g. a car briefly plugged in and out,
  // or a connection-state blip) — not worth cluttering the log.
  //
  // `endedAt` defaults to now, which is right for the normal path (the tick that saw the
  // cable come out). It is passed explicitly when closing a session recovered from
  // persisted state after a long outage: there the last true reading is the moment the
  // state was written, and dating the session to "now" would stretch it across a downtime
  // in which nothing was charging.
  _finalizeChargeSession(charger, st, cfg, endedAt = Date.now()) {
    if (!(st.sessionEnergyKwh >= 0.05)) return;
    const row = this._chargeSessionRow(charger.id, st, cfg, endedAt);
    this._chargeSessions.push(row);
    this._saveChargeSessions();
    this.log(`[EMS] charger ${charger.id}: session ended — ${row.energyKwh} kWh`
      + (row.cost != null ? `, ${row.cost} ${row.currency} (avg ${row.avgPrice}/kWh)` : ''));
  },

  /**
   * One session's figures, in one place.
   *
   * Built here rather than inline in _finalizeChargeSession because a RUNNING session is
   * now shown alongside the finished ones, and two builders would drift into two subtly
   * different row shapes — the reader would meet a list whose columns mean slightly
   * different things depending on the row.
   */
  _chargeSessionRow(chargerId, st, cfg, endedAt) {
    const kwh = Number(st.sessionEnergyKwh) || 0;
    const gridKwh = Math.round((st.sessionGridKwh || 0) * 100) / 100;
    return {
      chargerId,
      carName:   st.sessionCarName || null,
      startedAt: st.sessionStartedAt,
      endedAt,
      energyKwh: Math.round(kwh * 100) / 100,
      gridKwh,
      pvKwh:     Math.round(Math.max(0, kwh - (st.sessionGridKwh || 0)) * 100) / 100,
      pvShare:   kwh > 0 ? Math.round((1 - (st.sessionGridKwh || 0) / kwh) * 100) : null,
      cost:      st.sessionCostedKwh > 0 ? Math.round(st.sessionCostSum * 100) / 100 : null,
      // The two halves of `cost`. Rounded independently, so they can differ from `cost` by
      // a rappen — `cost` stays the authoritative total rather than the sum of these two,
      // because it is the figure every earlier session was already stored with.
      gridCost:  st.sessionCostedKwh > 0 ? Math.round((st.sessionGridCost || 0) * 100) / 100 : null,
      solarCost: st.sessionCostedKwh > 0 ? Math.round((st.sessionSolarCost || 0) * 100) / 100 : null,
      avgPrice:  st.sessionCostedKwh > 0 ? Math.round((st.sessionCostSum / st.sessionCostedKwh) * 1000) / 1000 : null,
      currency:  (cfg.price_config && cfg.price_config.currency) || 'CHF',
    };
  },

  /**
   * Finished sessions, newest first — preceded by any session still running.
   *
   * A session is closed on UNPLUG, so a car left on the cable for a weekend produced
   * nothing at all to look at: the owner charged on the Friday and the Saturday and found
   * a list whose newest entry was nine days old. The energy was never lost — it was still
   * accumulating in an open session — but "somewhere in the device's memory" is not a
   * place anyone can look.
   *
   * The running one carries `running: true` and `endedAt: null`, and is deliberately NOT
   * subject to the 0.05 kWh floor that _finalizeChargeSession applies: a session that has
   * just begun is exactly the one whose absence would puzzle someone.
   */
  getEmsChargeSessions(cfg = this._getConfig()) {
    const done = (this._chargeSessions || []).slice(-CHARGE_SESSIONS_MAX)
      .map((s) => ({ ...s })).reverse();

    const running = [];
    for (const [id, st] of (this._chargerStates || new Map())) {
      if (!st || !st.sessionActive) continue;
      running.push({
        ...this._chargeSessionRow(id, st, cfg, null),
        running: true,
        // Plugged in is not the same as drawing: between two solar windows the EMS holds
        // the charger at zero and the session stays open. The session-history widget shows
        // that as "paused" rather than "in progress".
        charging: (st.currentAmps ?? 0) > 0,
      });
    }
    running.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return [...running, ...done];
  },

};
