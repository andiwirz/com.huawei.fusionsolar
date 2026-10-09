'use strict';

// EMS chargerControl methods. Mixed into EmsDevice.prototype; `this` is the device
// instance. Extracted from drivers/energy_management/device.js.
const {
  AMPS_LADDER, STEP_HOLD_MS, IMPORT_HOLD_MS, FLIP_COOLDOWN_MS, PHASE_SWITCH_COOLDOWN_MS,
  CHARGER_START_GRACE_MS, CHARGER_START_GIVEUP_MS, CHARGER_IGNORED_BACKOFF_MS,
  CHARGER_IGNORED_BACKOFF_MAX_MS,
  IMPORT_ACT_W, EXPORT_GUARD_W, UP_MARGIN_W, MIN_3PH_W, PHASE_UP_MARGIN_W, MIN_CHARGE_W, MODES, HIST,
  CHARGER_LIVE_W, CHARGER_STOP_WARN_TICKS, TRIGGER_BUDGET_MS, OVERFLOW_KEEP_W, OVERFLOW_START_W,
} = require('./constants');

module.exports = {

  /**
   * Turns the stored per-device priority order into evaluation runs.
   *
   * `order` is a list of device ids. Devices not in it (just added, or a config from
   * before the per-device order existed) are appended in their configured order, so a new
   * device is never silently skipped — it simply goes last.
   *
   * Consecutive devices of the same kind are grouped into one run. That matters for
   * chargers: _evaluateEvChargers shares the available surplus between every charger it
   * receives in one call, and calling it once per charger would replace that with
   * first-come-first-served without anyone noticing.
   *
   * Separated on purpose from _tickBody so it can be tested without a full tick.
   *
   * @returns {Array<{kind: string, list: Array}>}
   */
  // Walks the priority runs in order, carrying the surplus budget from one run to the
  // next: run #1 is served against the full surplus, run #2 against whatever is left, and
  // so on. That carrying IS the priority mechanism — the order alone would decide nothing
  // if every run saw the same budget.
  //
  // Lives here rather than inline in device.js _tickBody so it can be tested: test/ems.test.js
  // deliberately never loads device.js (it needs the `homey` module, absent outside Homey).
  //
  // Returns the remaining budget so the caller can keep using it.
  /**
   * @param {number|null} allowanceW  Ceiling on the TOTAL draw of every EMS-controlled
   *   device this tick — the surplus ramp's share of production. null when no ramp is
   *   configured, which leaves the loop behaving exactly as it did before.
   *
   * Two carriers, and they answer different questions. effectiveGridW is "how much more may
   * be taken before the meter turns", and it is what CREATES budget: the ramp is folded into
   * it in device.js, so a device can claim while the grid sits at zero and the battery has
   * everything. remainingW is "how much of the ramp's share is left", and it BOUNDS that
   * budget.
   *
   * Without the ceiling the creating half alone is self-justifying for anything already
   * running: a charger's budget is its own draw minus the meter, and with the meter at zero
   * that is simply its own draw. Measured 2026-08-29 at 62 % SoC, share 32 %: the ramp
   * promised the devices 2354 W of 7448 W, and the car held 6152 W — 83 % — while the
   * battery took 346 W. The ramp gated starts and rises but never reclaimed, so whatever a
   * device reached first, it kept.
   *
   * Priority order decides who spends the share: run #1 takes what it needs, run #2 sees the
   * remainder. That is the same mechanism effectiveGridW already implements, applied to the
   * second carrier so the two cannot disagree about who was served first.
   */
  async _runPriorityLoop(battery, gridW, chargers, cfg, pvW, houseW, priorityOrder, simpleEval, allowanceW = null) {
    let effectiveGridW = gridW;
    let remainingW     = allowanceW;
    for (const run of this._buildPriorityRuns(priorityOrder, chargers, simpleEval)) {
      if (run.kind === 'charger') {
        const prevChargerW = run.list.reduce((s, c) => s + c.powerW, 0);
        const allocatedW   = await this._evaluateEvChargers(battery, effectiveGridW, run.list, cfg, pvW, houseW, remainingW);
        // Adjust only by the delta: the existing charger draw is already reflected in gridW
        const deltaW = allocatedW - prevChargerW;
        if (effectiveGridW !== null && deltaW !== 0) effectiveGridW += deltaW;
        // The share is spent by what was GRANTED, not by the delta: a charger already
        // running consumed its part of the allowance before this tick began.
        if (remainingW !== null) remainingW = Math.max(0, remainingW - allocatedW);
      } else {
        const s = simpleEval[run.kind];
        // What these devices were ALREADY drawing before this run. _evaluateSimpleDevices
        // returns only the delta — what it newly switched on — so the running draw has to be
        // added here or a pool that started an hour ago would cost the share nothing.
        //
        // A device with no power capability (cap_power empty) reports null, and there its
        // configured minSurplusW stands in. That figure is what the owner said it needs to
        // run, which is the best estimate available; treating it as zero would let exactly
        // the unmeasured devices slip past the ceiling.
        const states = s.states && typeof s.states.get === 'function' ? s.states : null;
        const prevOnW = (remainingW === null || !states) ? 0 : run.list.reduce((sum, dev) => {
          const st = states.get(dev.id);
          if (!st || !st.isOn) return sum;
          return sum + (dev.powerW ?? dev.minSurplusW ?? 0);
        }, 0);
        const allocatedW = await this._evaluateSimpleDevices(
          battery, effectiveGridW, run.list, s.states, s.start, s.stop, s.arg, cfg, remainingW,
        );
        if (effectiveGridW !== null && allocatedW) effectiveGridW += allocatedW;
        if (remainingW !== null) remainingW = Math.max(0, remainingW - prevOnW - Math.max(0, allocatedW));
      }
    }
    return effectiveGridW;
  },

  _buildPriorityRuns(order, chargers, simpleEval) {
    const byId = new Map();
    for (const c of chargers || []) byId.set(c.id, { kind: 'charger', dev: c });
    for (const [kind, s] of Object.entries(simpleEval || {})) {
      for (const d of s.list || []) byId.set(d.id, { kind, dev: d });
    }

    const seq = [];
    for (const id of Array.isArray(order) ? order : []) {
      const hit = byId.get(id);
      if (hit) { seq.push(hit); byId.delete(id); }
    }
    for (const rest of byId.values()) seq.push(rest); // unlisted devices go last

    const runs = [];
    for (const { kind, dev } of seq) {
      const last = runs[runs.length - 1];
      if (last && last.kind === kind) last.list.push(dev);
      else runs.push({ kind, list: [dev] });
    }
    return runs;
  },

  _getChargerState(id) {
    if (!this._chargerStates.has(id)) {
      this._chargerStates.set(id, {
        currentAmps:       null,
        currentPhases:     null,
        pendingStepAmps:   null,
        pendingStepSince:  null,
        pendingDownSince:  null,
        lastDownStepAt:    null,
        lastPhaseSwitchAt: null,
        targetReachedCar:  null, // carId whose charge target is reached (hold until unplug)
        uncommandedTicks:  0,    // consecutive ticks drawing power the EMS did not ask for
        commandedSince:    null, // when the current command chain began; null once it draws
        startRetried:      false,// the one repeat of ems_start_charger for this attempt
        startBlockedUntil: null, // surplus path stays off this charger until then
        ignoredStreak:     0,    // give-ups in a row with no amp drawn between them
      });
    }
    return this._chargerStates.get(id);
  },

  async _chargerStop(id, now = Date.now()) {
    this.log(`[EMS] charger ${id}: stop`);
    this._addHistoryEvent(HIST.CHARGER, 'stop', '0A', id);
    this.log(`[EMS] charger ${id}: stop → trigger ems_set_charger_current (0A)`);
    await this._settleWithin(
      this.homey.flow
        .getTriggerCard('ems_set_charger_current')
        .trigger({ amps: 0, phase1: 0, phase2: 0, phase3: 0, charger_device_id: id }, { charger_device_id: id })
        .catch((e) => this.log(`[EMS] charger ${id}: stop trigger failed: ${e.message}`)),
      TRIGGER_BUDGET_MS, `charger ${id} stop`);
    const st = this._getChargerState(id);
    st.currentAmps = null; st.pendingStepAmps = null; st.pendingStepSince = null;
    st.pendingDownSince = null;
    st.currentPhases = null;
    st.commandedSince = null;
    st.startRetried   = false;
    // The tick's time, like every other stamp the cooldown is compared with (1.2.279).
    st.lastDownStepAt = now; // always apply FLIP_COOLDOWN_MS after any stop
  },

  async _chargerSetAmps(id, amps, phases) {
    const st = this._getChargerState(id);

    if (st.currentAmps === null) {
      this.log(`[EMS] charger ${id}: → trigger ems_start_charger`);
      await this._settleWithin(
        this.homey.flow
          .getTriggerCard('ems_start_charger')
          .trigger({ charger_device_id: id }, { charger_device_id: id })
          .catch((e) => this.log(`[EMS] charger ${id}: start trigger failed: ${e.message}`)),
        TRIGGER_BUDGET_MS, `charger ${id} start`);
    }

    const p1 = amps;
    const p2 = phases >= 2 ? amps : 0;
    const p3 = phases >= 3 ? amps : 0;
    const prevAmps = st.currentAmps;
    if (prevAmps === null || prevAmps !== amps) {
      this._addHistoryEvent(HIST.CHARGER, prevAmps === null ? 'start' : 'set_amps', `${amps}A/${phases}ph`, id);
    }
    this.log(`[EMS] charger ${id}: ${amps}A / ${phases}ph (L1=${p1} L2=${p2} L3=${p3}) → trigger ems_set_charger_current`);
    // The most frequently fired trigger in the app — a solar ramp sets amps every 80 s for
    // as long as the sun moves — and until 1.2.175 the only one of the charger's three that
    // was still unbounded. Start and stop got their budget in July; this one was missed
    // because the bug being chased then was a stop that never landed.
    await this._settleWithin(
      this.homey.flow
        .getTriggerCard('ems_set_charger_current')
        .trigger({ amps, phase1: p1, phase2: p2, phase3: p3, charger_device_id: id }, { charger_device_id: id })
        .catch((e) => this.log(`[EMS] charger ${id}: set trigger failed: ${e.message}`)),
      TRIGGER_BUDGET_MS, `charger ${id} set ${amps}A`);
    // Recorded whether or not the flow answered in time: the EMS commanded this current,
    // and the next tick must reason from what it asked for, not from what it heard back.
    st.currentAmps   = amps;
    st.currentPhases = phases; // always track phases so phase-switch logic sees correct state next tick
  },

  /**
   * One phase or three, for this budget — with hysteresis, because the threshold moves the
   * floor under the charger.
   *
   * Three phases cannot draw less than MIN_3PH_W (6 A × 3 × 230 = 4140 W). Switching over at
   * exactly that figure therefore commits the charger to a floor equal to the budget that
   * justified the switch: one watt less and no rung fits at all, and the only remaining
   * action is a full stop — the amp ladder has nowhere lower to go.
   *
   * Measured on 2026-08-26 between 15:33 and 17:45: eight start/stop cycles, and in every
   * one of the five where the charger reached three phases it stopped within two minutes.
   * The two cycles that stayed single-phase ran on.
   *
   * So the switch UP now wants a rung of headroom above the floor; staying at three phases
   * only wants the floor itself. The same shape as UP_MARGIN_W on the amp ladder — which
   * this decision never had, although it is the more consequential of the two.
   */
  _bestPhases(budgetW, currentPhases = 1) {
    if (currentPhases === 3) return budgetW >= MIN_3PH_W ? 3 : 1;
    return budgetW >= (MIN_3PH_W + PHASE_UP_MARGIN_W) ? 3 : 1;
  },

  // Whole-house grid-import ceiling (cfg.grid_import_limit_kw, 0/unset = unlimited) —
  // a hard main-fuse safety limit. this._gridImportCommittedW is
  // seeded once per tick in device.js _tickBody to the ALREADY-measured grid import (so
  // ordinary house baseline load is accounted for), then every unconditional-draw tier
  // (Instant/Always/Off-peak here, price/low-tariff charging and battery force-charge
  // elsewhere) claims against it as it runs. This GRACEFULLY reduces to the highest amp-ladder rung that still
  // fits — better to charge slower than to stop outright when only just over the limit.
  // Returns the granted amps (0 if even the minimum doesn't fit — charger should stop).
  //
  // `currentDrawW` is what THIS charger is already drawing. It matters because the
  // running total is seeded (device.js _tickBody) from the MEASURED grid import, which
  // already contains that draw — so claiming the new target on top of it would count the
  // same charger twice. That is exactly what used to happen: a charger sitting well
  // inside the ceiling was stopped, its draw then left the meter reading, the next tick
  // saw plenty of headroom and started it again — a permanent 15 s start/stop cycle.
  // The claim is therefore a DELTA: take this charger's own draw back out before
  // measuring headroom, then add back only what is granted. (The on/off simple devices
  // in simpleDevices.js never hit this because they only ever claim on a NEW start.)
  _gridImportClaimAmps(cfg, minAmps, desiredAmps, phases, currentDrawW = 0) {
    const limitKw = Number(cfg.grid_import_limit_kw) || 0;
    if (limitKw <= 0) return desiredAmps; // unlimited — no tracking needed
    const committed  = this._gridImportCommittedW || 0;
    const baselineW  = committed - Math.max(0, currentDrawW);
    // Deliberately NOT clamped at 0: when the house is already over the ceiling the
    // headroom is negative, which correctly forces a step DOWN instead of leaving the
    // charger at its current amps.
    const headroomW  = limitKw * 1000 - baselineW;
    const ladder     = AMPS_LADDER.filter((a) => a >= minAmps && a <= desiredAmps);
    let granted = 0;
    for (const a of ladder) { if (a * phases * 230 <= headroomW) granted = a; }
    this._gridImportCommittedW = baselineW + granted * phases * 230;
    return granted;
  },

  // Binary variant of _gridImportClaimAmps for on/off devices (heat pump, boiler, pool,
  // dehumidifier) that have no amp ladder to gracefully reduce — either the fixed power
  // fits under the ceiling or the start is denied outright. Shares the same tick-scoped
  // this._gridImportCommittedW bookkeeping as the graceful EV-charger version above and
  // the battery force-charge check in device.js _checkBatteryPriceControl.
  _gridImportClaimFixed(cfg, powerW) {
    const limitKw = Number(cfg.grid_import_limit_kw) || 0;
    if (limitKw <= 0) return true; // unlimited — no tracking needed
    const committed = this._gridImportCommittedW || 0;
    if (committed + powerW > limitKw * 1000) return false;
    this._gridImportCommittedW = committed + powerW;
    return true;
  },

  // Instant charging is a toggle the user turns on deliberately; nothing but this clears
  // it again. Unplugging is the one end-of-charge signal every setup has — target SOC is
  // only known when the vehicle exposes it. Without this the toggle would still be on the
  // next time a car is plugged in and would immediately charge it at full power.
  async _clearChargeNowWhenUnplugged(chargers) {
    if (this.getCapabilityValue('charge_now') !== true) {
      this._chargeNowSawConnected = false; // reset for the next time it is switched on
      return;
    }
    if ((chargers || []).some((c) => c.connected)) {
      this._chargeNowSawConnected = true;
      return;
    }
    // Only switch off once a charger has actually been connected while this was on.
    // setEmsChargeNow ticks immediately after the write, so clearing on "nothing plugged
    // in" would undo the user's own toggle within the same tick and make it look dead —
    // and it stops you arming instant charging before plugging the car in.
    if (!this._chargeNowSawConnected) return;
    this.log('[EMS] instant charging: charger disconnected → switching off');
    this._chargeNowSawConnected = false;
    await this.setCapabilityValue('charge_now', false).catch(() => {});
  },

  async _evaluateEvChargers(battery, gridW, chargers, cfg, pvW = null, houseW = null, allowanceW = null) {
    await this._clearChargeNowWhenUnplugged(chargers);
    if (!chargers.length) return 0;
    // Per-device "EMS controls this device" toggle (set via the ems-device
    // widget or Settings) — a charger with enabled===false is left alone
    // entirely: no start/stop/amp commands, not counted in the surplus-sharing
    // loop below. Any charging it does anyway (manual/external) still shows up
    // in the grid meter reading and is still logged as a charge session — see
    // device.js _tickBody, which tracks sessions independent of this filter.
    chargers = chargers.filter((c) => c.enabled !== false);
    if (!chargers.length) return 0;
    const { minSoc, minSocLow, hasLowZone, batLow, batReserve } = this._batteryZones(cfg, battery);
    const now = Date.now();

    let anyConnected = chargers.some((c) => c.connected);
    let totalW       = chargers.reduce((s, c) => s + c.powerW, 0);

    // ── P0: Instant charging ─────────────────────────────────────────────────
    if (this.getCapabilityValue('charge_now') === true) {
      if (!anyConnected) {
        const p0SocStr = battery.soc !== null ? ` · Bat ${Math.round(battery.soc)}%` : '';
        await this._setMode(MODES.IDLE, `kein EV verbunden${p0SocStr}`);
        return 0;
      }
      const instantGranted = [];
      for (const c of chargers) {
        if (!c.connected) continue;
        // A phase-switching charger runs 3-phase here, same as every other tier
        // (P3/P3b/P3c) — instant charging wants maximum power.
        const phases = c.phaseSwitch ? 3 : c.phases;
        const grantedAmps = this._gridImportClaimAmps(cfg, c.minAmps, c.maxAmps, phases, c.powerW);
        const st = this._getChargerState(c.id);
        if (grantedAmps <= 0) {
          if (st.currentAmps !== null) await this._chargerStop(c.id, now);
          continue;
        }
        if (this._warmupDone && (st.currentAmps !== grantedAmps || st.currentPhases !== phases)) {
          await this._chargerSetAmps(c.id, grantedAmps, phases);
        }
        instantGranted.push({ c, amps: grantedAmps, phases });
      }
      const parts = instantGranted.map(({ amps, phases }) => `${amps}A/${phases}ph`).join(' + ');
      // Instant charging ignores the charge target on purpose — P2.5 below never runs,
      // because this branch returns first, and that is the whole meaning of the mode: full
      // power until the OWNER says otherwise, not until the car says so. Stopping here would
      // take a decision the user reserved for themselves.
      //
      // But a car at its target draws nothing, and the tile then read "16A/3ph" for hours
      // with not one watt behind it. The amps are real — we are still granting them, and the
      // car may resume at any moment — so they stay in the text. What changes is that the
      // text no longer implies they are flowing.
      const full = [];
      for (const { c } of instantGranted) {
        const car = this._carForCharger(c);
        if (car && car.soc !== null && car.target !== null && car.soc >= car.target) full.push(car);
      }
      let instantText = parts;
      if (full.length === 1) {
        const car = full[0];
        instantText = `${car.name} voll (${Math.round(car.soc)}% ≥ ${Math.round(car.target)}%) — wartet auf Abstecken · ${parts}`;
      } else if (full.length > 1) {
        instantText = `${full.length} Fahrzeuge am Ladeziel — warten auf Abstecken · ${parts}`;
      }
      await this._setMode(MODES.INSTANT_EV, instantText);
      return instantGranted.reduce((s, { amps, phases }) => s + amps * phases * 230, 0);
    }

    // ── P0.5: "Always charge" mode ───────────────────────────────────────────
    // Charges at max power as soon as the cable is in — independent of solar and
    // battery state (same standing as instant charging). These chargers are then
    // removed from the solar/off-peak logic below.
    let alwaysW = 0;
    const alwaysGrantedAmps = new Map(); // c.id → { amps, phases } granted, for the status text below
    const alwaysChargers = chargers.filter((c) => c.chargeMode === 'always');
    if (alwaysChargers.length) {
      for (const c of alwaysChargers) {
        const st = this._getChargerState(c.id);
        if (!c.connected) {
          if (st.currentAmps !== null) await this._chargerStop(c.id, now);
          continue;
        }
        // Phase-switching charger runs 3-phase, same as every other tier (see P0).
        const phases = c.phaseSwitch ? 3 : c.phases;
        const grantedAmps = this._gridImportClaimAmps(cfg, c.minAmps, c.maxAmps, phases, c.powerW);
        if (grantedAmps <= 0) {
          if (st.currentAmps !== null) await this._chargerStop(c.id, now);
          continue;
        }
        if (this._warmupDone && (st.currentAmps !== grantedAmps || st.currentPhases !== phases)) {
          await this._chargerSetAmps(c.id, grantedAmps, phases);
        }
        alwaysGrantedAmps.set(c.id, { amps: grantedAmps, phases });
        alwaysW += grantedAmps * phases * 230;
      }
      chargers = chargers.filter((c) => c.chargeMode !== 'always');
      if (!chargers.length) {
        const connAlways = alwaysChargers.filter((c) => c.connected && alwaysGrantedAmps.has(c.id));
        if (!connAlways.length) {
          const aSocStr = battery.soc !== null ? ` · Bat ${Math.round(battery.soc)}%` : '';
          await this._setMode(MODES.IDLE, `kein EV verbunden${aSocStr}`);
          return 0;
        }
        const aParts = connAlways.map((c) => {
          const g = alwaysGrantedAmps.get(c.id);
          return `${g.amps}A/${g.phases}ph`;
        }).join(' + ');
        await this._setMode(MODES.INSTANT_EV, `Immer laden · ${aParts}`);
        return alwaysW;
      }
      // Recompute for the remaining (solar-managed) chargers
      anyConnected = chargers.some((c) => c.connected);
      totalW       = chargers.reduce((s, c) => s + c.powerW, 0);
    }

    // ── P1: Battery priority ─────────────────────────────────────────────────
    // Three zones based on SOC vs. two thresholds (min_soc_low < min_soc):
    //   soc ≥ min_soc               → normal operation
    //   min_soc_low ≤ soc < min_soc → orange zone: devices share orange budget
    //   soc < min_soc_low           → hard stop (with overflow exception for grid export)
    let batOverflowMode = false;
    let batReserveMode = false;

    if (batLow) {
      if (batReserve) {
        // Orange zone: devices share the orange budget; battery keeps solar priority
        batReserveMode = true;
      } else {
        // Hard stop zone: soc < minSocLow (or no low zone configured)
        const batCharging    = battery.powerW !== null && battery.powerW > 0;
        const exportSurplusW = gridW !== null ? -gridW : 0;

        // Hysteresis: starting the charger reduces the very export that justified it, so
        // the bar to START is higher than the bar to CONTINUE. It is now derived rather
        // than guessed — enough for the smallest rung AND the remainder that keeps the
        // condition true afterwards — and the allocation below holds that remainder back.
        // The old pair (2×MIN_CHARGE_W to start, ½× to continue) left the middle open: the
        // charger took the highest rung that fit the whole export and stopped itself on the
        // next tick. See OVERFLOW_KEEP_W in constants.js for the measurement.
        const anyChargerRunning = chargers.some(
          (c) => (this._getChargerState(c.id).currentAmps ?? 0) > 0,
        );
        const overflowThreshold = anyChargerRunning ? OVERFLOW_KEEP_W : OVERFLOW_START_W;
        const hasOverflow       = batCharging && exportSurplusW >= overflowThreshold;

        if (!hasOverflow) {
          // Only stop chargers that EMS has running — avoids repeated stop triggers each tick
          for (const c of chargers) {
            if (this._getChargerState(c.id).currentAmps !== null) await this._chargerStop(c.id, now);
          }
          const socLimit  = hasLowZone ? minSocLow : minSoc;
          const stTextBat = `${Math.round(battery.soc)}% < ${socLimit}%`;
          await this._setMode(MODES.BATTERY_PRIORITY, stTextBat);
          return alwaysW;
        }
        batOverflowMode = true;
      }
    }

    // ── P2: No EV connected ──────────────────────────────────────────────────
    if (!anyConnected) {
      this._importSince = null;
      for (const c of chargers) {
        const st = this._getChargerState(c.id);
        st.targetReachedCar = null; // cable out → clear the "target reached" hold
        // A different car may be perfectly willing to charge, so the back-off from the last
        // one's ignored start must not outlive the cable.
        st.startBlockedUntil = null;
        st.ignoredStreak = 0;
        if (st.currentAmps !== null) await this._chargerStop(c.id, now);
      }
      const idleSocStr      = battery.soc !== null ? ` · Bat ${Math.round(battery.soc)}%` : '';
      const idleSurplusW    = gridW !== null ? Math.round(-gridW) : null;
      const idleSurplusStr  = idleSurplusW !== null && idleSurplusW > 0
        ? `${idleSurplusW} W Überschuss${idleSocStr}`
        : `kein Überschuss${idleSocStr}`;
      await this._setMode(MODES.IDLE, idleSurplusStr);
      return alwaysW;
    }

    // ── P2.5: Charge target reached ──────────────────────────────────────────
    // The car is still plugged in but already at its configured target. Without
    // this the EMS keeps re-tuning amps against a car that no longer draws —
    // for the whole afternoon, as long as surplus exists. Hold until the cable
    // is unplugged (cleared in P2 above) or the target is raised.
    // Resolve each charger's car (explicit car_id mapping, else heuristic) and hold
    // THAT charger when ITS car is at target — without stopping a charger whose car
    // is still below target. Freed surplus stays in the budget for the other chargers.
    this._updateTargetHold(chargers);
    // Stop the chargers holding at target.
    const heldChargers = chargers.filter((c) => c.connected && this._getChargerState(c.id).targetReachedCar);
    for (const c of heldChargers) {
      if (this._getChargerState(c.id).currentAmps !== null) await this._chargerStop(c.id, now);
    }
    const connectedCount = chargers.filter((c) => c.connected).length;
    if (connectedCount && heldChargers.length === connectedCount) {
      // Every connected charger is at target → nothing left to manage.
      const tSocStr = battery.soc !== null ? ` · Bat ${Math.round(battery.soc)}%` : '';
      const heldCar = this._carForCharger(heldChargers[0]);
      const stTextTarget = heldCar
        ? `${heldCar.name}: Ladeziel erreicht (${Math.round(heldCar.soc)}% ≥ ${Math.round(heldCar.target)}%) — wartet auf Abstecken${tSocStr}`
        : `Ladeziel erreicht — wartet auf Abstecken${tSocStr}`;
      await this._setMode(MODES.HOLDING, stTextTarget);
      return alwaysW;
    }
    // Some (not all) chargers held → keep them out of the off-peak/solar allocation
    // below. totalW is intentionally NOT recomputed: the freed power stays as budget
    // for the remaining chargers.
    if (heldChargers.length) {
      chargers = chargers.filter((c) => !(c.connected && this._getChargerState(c.id).targetReachedCar));
    }

    // ── P3: Off-peak ──────────────────────────────────────────────────────────
    const offpeakWin = this._offpeakWindow(cfg);
    // Off-peak applies to chargers in "Solar & off-peak window" mode. The global
    // offpeak_enabled tile toggle still works as a legacy/global enable — but only
    // for chargers left on the default 'solar' mode. A charger explicitly set to a
    // different price-aware mode (solar_price / solar_lowtariff) made a deliberate
    // choice; the global toggle must not silently override it.
    const offpeakChargers = chargers.filter((c) => c.connected
      && (c.chargeMode === 'solar_offpeak' || (c.chargeMode === 'solar' && this.getCapabilityValue('offpeak_enabled') === true)));
    if (!batOverflowMode && !batReserveMode && offpeakChargers.length && offpeakWin.active) {
      // Solar-first: if there's enough export surplus to cover the minimum step,
      // let the solar logic handle it — free energy outranks cheap grid energy.
      const solarFirst    = cfg.offpeak_solar_first !== false; // default true
      // Threshold scales with the actual chargers present: hand off to solar only once
      // export surplus can cover the *smallest* off-peak charger's minimum draw (a
      // phase-switching charger can drop to 1-phase, a fixed 3-phase one cannot). A flat
      // MIN_CHARGE_W would hand off on 1380 W even when every charger needs 4140 W (3ph),
      // leaving them idle instead of using cheap off-peak power.
      const minClaimW     = Math.min(...offpeakChargers.map((c) => c.minAmps * (c.phaseSwitch ? 1 : c.phases) * 230));
      const solarCanClaim = solarFirst && gridW !== null && gridW <= -minClaimW;

      if (!solarCanClaim) {
        this._importSince = null; // clear stale import timer so solar mode starts fresh after off-peak
        const opAmps = offpeakWin.amps;
        const offpeakGranted = [];
        for (const c of offpeakChargers) {
          const opPhases   = c.phaseSwitch ? 3 : c.phases;
          const st         = this._getChargerState(c.id);
          const grantedAmps = this._gridImportClaimAmps(cfg, c.minAmps, opAmps, opPhases, c.powerW);
          if (grantedAmps <= 0) {
            if (st.currentAmps !== null) await this._chargerStop(c.id, now);
            continue;
          }
          if (this._warmupDone && (st.currentAmps !== grantedAmps || st.currentPhases !== opPhases)) {
            await this._chargerSetAmps(c.id, grantedAmps, opPhases);
            if (c.phaseSwitch) st.lastPhaseSwitchAt = now;
          }
          offpeakGranted.push({ c, amps: grantedAmps, phases: opPhases });
        }
        const stTextOffpeak = offpeakGranted.map(({ amps }) => amps).join('/') + `A × ${offpeakGranted.length} Lader`;
        await this._setMode(MODES.OFFPEAK_EV, stTextOffpeak);
        return alwaysW + offpeakGranted.reduce((s, { amps, phases }) => s + amps * phases * 230, 0);
      }
      // else: solar has surplus — fall through to solar surplus logic below
    }

    // ── P3b: Price-optimised charging (D10) ─────────────────────────────────────
    // Chargers in "Solar & price-optimised" mode. Unlike the fixed off-peak window
    // above, the "charge now" decision comes from _priceShouldChargeNow (per charger's
    // assigned car): it nets the Solcast PV forecast off the car's remaining energy
    // need, then — only for what solar won't cover — checks whether now is one of the
    // cheapest price slots before the car's deadline. A charger this tick decides NOT
    // to charge simply falls through to the normal solar-surplus loop below, so it
    // still benefits from any live surplus while waiting for a cheaper grid slot.
    const priceChargers = chargers.filter((c) => c.connected && c.chargeMode === 'solar_price');
    if (!batOverflowMode && !batReserveMode && priceChargers.length) {
      const solarFirst    = cfg.offpeak_solar_first !== false; // default true, same knob as off-peak
      const minClaimW     = Math.min(...priceChargers.map((c) => c.minAmps * (c.phaseSwitch ? 1 : c.phases) * 230));
      const solarCanClaim = solarFirst && gridW !== null && gridW <= -minClaimW;

      const chargingNow = [];
      if (!solarCanClaim) {
        for (const c of priceChargers) {
          const car           = this._carForCharger(c);
          const phases        = c.phaseSwitch ? 3 : c.phases;
          const chargerPowerW = c.maxAmps * phases * 230;
          const decision = this._priceShouldChargeNow(car, chargerPowerW, cfg, now);
          this._debugLog(`charger ${c.id} (solar_price): ${decision.shouldCharge ? 'wants' : 'not'} to charge — ${decision.reason}`);
          if (!decision.shouldCharge) continue;
          // The whole-house main-fuse ceiling reduces the request to the amps that actually
          // fit, and is claimed for exactly those — never for the theoretical maximum, which
          // would exhaust it faster than reality and wrongly deny the chargers after this one.
          const grantedAmps = this._gridImportClaimAmps(cfg, c.minAmps, c.maxAmps, phases, c.powerW);
          if (grantedAmps <= 0) continue;
          const grantedW = grantedAmps * phases * 230;
          this._debugLog(`charger ${c.id}: grid-charging at ${grantedAmps}A/${phases}ph (${grantedW}W)`);
          chargingNow.push({ c, phases, amps: grantedAmps });
        }
      }
      if (chargingNow.length) {
        this._importSince = null; // clear stale import timer so solar mode starts fresh afterwards
        for (const { c, phases, amps } of chargingNow) {
          const st = this._getChargerState(c.id);
          if (this._warmupDone && (st.currentAmps !== amps || st.currentPhases !== phases)) {
            await this._chargerSetAmps(c.id, amps, phases);
            if (c.phaseSwitch) st.lastPhaseSwitchAt = now;
          }
        }
        const stTextPrice = `${chargingNow.length} Lader · günstiger Strompreis`;
        await this._setMode(MODES.PRICE_EV, stTextPrice);
        return alwaysW + chargingNow.reduce((s, { amps, phases }) => s + amps * phases * 230, 0);
      }
      // else: no price-charger needs grid charging right now — fall through so they
      // still get solar surplus (and any others aren't affected).
    }

    // ── P3c: Low-tariff window (dual "Low / high tariff" price model) ──────────
    // Chargers in "Solar & low tariff" mode. Unlike the fixed Off-Peak Charging window
    // above (P3), this reuses the weekday high/low windows already configured under
    // Electricity Price → Low / high tariff — charges at full power whenever that
    // schedule says the LOW tariff currently applies. No effect if the tariff model
    // isn't set to "dual" or no window is configured for today.
    const lowTariffChargers = chargers.filter((c) => c.connected && c.chargeMode === 'solar_lowtariff');
    if (!batOverflowMode && !batReserveMode && lowTariffChargers.length) {
      const dual = this._dualTariffWindow(cfg);
      this._debugLog(`low-tariff chargers: dual-tariff ${dual.configured ? (dual.isHigh ? 'HIGH now' : 'LOW now') : 'not configured'}`);
      if (dual.configured && !dual.isHigh) {
        const solarFirst    = cfg.offpeak_solar_first !== false; // default true, same knob as off-peak
        const minClaimW     = Math.min(...lowTariffChargers.map((c) => c.minAmps * (c.phaseSwitch ? 1 : c.phases) * 230));
        const solarCanClaim = solarFirst && gridW !== null && gridW <= -minClaimW;

        if (!solarCanClaim) {
          // Same as P3b: a low-tariff charger that does not fit under the whole-house ceiling
          // skips grid-charging this tick and falls through to the normal solar loop.
          const fitting = [];
          for (const c of lowTariffChargers) {
            const phases = c.phaseSwitch ? 3 : c.phases;
            // Same bound-then-claim order as P3b — see the rationale there.
            const grantedAmps = this._gridImportClaimAmps(cfg, c.minAmps, c.maxAmps, phases, c.powerW);
            if (grantedAmps <= 0) continue;
            const grantedW = grantedAmps * phases * 230;
            this._debugLog(`charger ${c.id}: grid-charging at ${grantedAmps}A/${phases}ph (${grantedW}W)`);
            fitting.push({ c, phases, amps: grantedAmps });
          }
          if (fitting.length) {
            this._importSince = null; // clear stale import timer so solar mode starts fresh after low tariff
            for (const { c, phases, amps } of fitting) {
              const st = this._getChargerState(c.id);
              if (this._warmupDone && (st.currentAmps !== amps || st.currentPhases !== phases)) {
                await this._chargerSetAmps(c.id, amps, phases);
                if (c.phaseSwitch) st.lastPhaseSwitchAt = now;
              }
            }
            const stTextLowTariff = `${fitting.length} Lader · Niedertarif`;
            await this._setMode(MODES.LOWTARIFF_EV, stTextLowTariff);
            return alwaysW + fitting.reduce((s, { amps, phases }) => s + amps * phases * 230, 0);
          }
          // else: nothing fit the remaining budget — fall through to solar surplus logic below
        }
        // else: solar has surplus — fall through to solar surplus logic below
      }
      // else: not currently low tariff (or not configured) — falls through to solar loop
    }

    // ── Import guard (60 s) ───────────────────────────────────────────────────
    const importing       = gridW !== null && gridW >= IMPORT_ACT_W;
    this._importSince     = importing ? (this._importSince ?? now) : null;
    const sustainedImport = importing && (now - this._importSince) >= IMPORT_HOLD_MS;
    if (sustainedImport) this._importSince = null;

    // ── Solar surplus allocation ───────────────────────────────────────────────
    // Battery correction: penalise EV budget only when battery is discharging AND
    // grid is importing — both sources draining simultaneously is too much EV load.
    // When grid is still exporting, solar surplus exists and the inverter manages
    // the battery itself; applying correction here caused start/stop oscillation.
    const batDischarging = battery.powerW !== null && battery.powerW < 0;
    const batCharging    = battery.powerW !== null && battery.powerW > 0;
    const batCorr  = batDischarging && gridW !== null && gridW > 0 ? battery.powerW : 0;
    let budgetW    = totalW - (gridW ?? 0) + batCorr;

    // When a SOC ramp is configured it IS the budget, and the two mechanisms below must
    // stand down. Both predate the ramp, both answer the same question it answers — "how
    // much of what the battery is absorbing may the charger take instead?" — and both
    // answer it with "all of it", which is precisely what the ramp exists to refuse.
    //
    // Measured 2026-08-17, ramp 50→100 % / 20→100 %: at 51 % SoC the ramp allowed 916 W of
    // 4241 W production; the charger was given 12 A on one phase, 2760 W. The difference is
    // the battery's own charging power, added again below. The charger then pulled the
    // battery under the 50 % hard stop, was stopped, the battery recovered, the charger
    // restarted — four times in one hour.
    //
    // device.js has already folded _batteryShareBudgetW into effectiveGridW, so the ramp's
    // allowance is in budgetW above. It is derived from pvW directly rather than from the
    // grid meter, which is what the cross-check was for, so nothing is lost by skipping it.
    const socRampOn = this._batterySurplusShare(cfg, battery.soc) !== null;

    // Green zone: battery is charging from solar → that power is also available to the EV
    // charger. The inverter reduces battery charging proportionally when the charger draws
    // more, so battery charging wattage counts as additional budget (= 100% solar − house).
    // This handles the common case where all PV flows into the battery (grid ≈ 0W) and the
    // grid-based budget alone would read near zero, preventing the charger from starting.
    if (!socRampOn && !batOverflowMode && !batReserveMode && batCharging) budgetW += battery.powerW;

    // PV-based cross-check: pvW − houseW converges to the same value as the battery-boost
    // above when sensors are accurate, but takes precedence if it reads higher (handles
    // sensor lag or setups without a battery power sensor).
    if (!socRampOn && !batOverflowMode && pvW !== null && houseW !== null) {
      const pvBudgetW = Math.max(0, pvW - houseW);
      const pvWins = pvBudgetW > budgetW;
      // Which of the two estimates wins is a STATE, not an event, so only the changeover is
      // logged; the watts are in the diagnostics panel either way.
      //
      // That alone was not enough. At night both estimates sit on zero — 0 W against 1 W,
      // against 10 W, against 2 W — and the comparison genuinely flips on meter noise, so
      // the "changeover" fired all night: about 120 lines in two hours of one field log,
      // again the most frequent line in it. Below the smallest rung a charger can take, the
      // question the line answers ("which budget did the charger get?") has no subject. Both
      // answers mean the same thing there: no surplus.
      //
      // The last LOGGED winner is tracked separately from the current one. Tracking only the
      // current one would let a silent flip below the floor swallow the next real changeover.
      const decisive = Math.max(pvBudgetW, budgetW) >= MIN_CHARGE_W;
      if (decisive && pvWins !== this._pvBudgetLoggedWon) {
        this._pvBudgetLoggedWon = pvWins;
        this.log(pvWins
          ? `[EMS] PV budget ${Math.round(pvBudgetW)}W > battery-boost budget ${Math.round(budgetW)}W — using PV`
          : `[EMS] battery-boost budget ${Math.round(budgetW)}W ≥ PV budget ${Math.round(pvBudgetW)}W — using battery boost`);
      }
      if (pvWins) budgetW = pvBudgetW;
    }

    // ── The surplus ramp as a ceiling ─────────────────────────────────────────
    // Everything above CREATES budget; this bounds it. Without the bound the creating half
    // is self-justifying for a charger already running: its budget is its own draw minus the
    // meter, and once it consumes everything the meter reads zero, so the budget is simply
    // what it already takes. Measured 2026-08-29 at 62 % SoC with a 32 % share: the ramp
    // promised 2354 W of 7448 W and the car held 6152 W while the battery got 346 W. The
    // ramp gated starts and rises but never reclaimed.
    //
    // allowanceW is what is LEFT of the share after the devices ahead of this one in the
    // priority order have taken theirs, so the order decides who spends it.
    //
    // Only ever downwards — like every other guard in this file, it can make the EMS more
    // cautious and never less. null means no ramp is configured, and then nothing changes.
    if (allowanceW !== null && allowanceW !== undefined) {
      budgetW = Math.min(budgetW, Math.max(0, allowanceW));
    }

    // Orange zone: budget already expanded by orangeBudget via effectiveGridW (injected in main tick).
    // No override needed; batReserveMode only suppresses battery-boost addition below.

    // In overflow mode keep the budget below the 3-phase threshold so _stepCharger never
    // triggers a 1ph→3ph switch. That switch doubles the charger draw instantly, which
    // pulls the battery out of charging and breaks the overflow condition on the next tick.
    if (batOverflowMode) {
      // Two ceilings, both about not undoing the condition that got us here.
      //
      // MIN_3PH_W - 1 keeps _stepCharger from triggering a 1ph→3ph switch, which doubles
      // the draw instantly, pulls the battery out of charging and breaks the overflow
      // condition on the next tick.
      //
      // OVERFLOW_KEEP_W is the remainder the charger must leave exported so that it still
      // satisfies the continue threshold once it is drawing. Without it the charger took
      // the highest rung that fit the entire export and stopped itself one tick later —
      // measured across the whole 2760–4750 W band.
      budgetW = Math.max(0, Math.min(budgetW, MIN_3PH_W - 1) - OVERFLOW_KEEP_W);
    }

    // Solar-forecast gate. Reached only here, after every deliberate tier has returned:
    // instant, "always charge", off-peak, price and low-tariff are the user asking for a
    // charge at a particular time, and holding those back would ignore the instruction.
    // Solar surplus charging is the opposite — it is the EMS spending whatever is left, and
    // on a day the forecast cannot refill the house battery there is nothing left to spend.
    //
    // Holds only STARTS, exactly as it does for the heat pump and boiler: a charge already
    // running finishes, because stopping mid-session to save the battery would leave the
    // car with neither. The budget is zeroed rather than the charger skipped so _stepCharger
    // still runs — it is what notices a charger drawing power the EMS never commanded.
    const gateBlocksStarts = this._forecastGateBlocksStarts(cfg, battery, now);

    const statuses = [];

    for (const charger of chargers) {
      if (!charger.connected) {
        if (this._getChargerState(charger.id).currentAmps !== null) await this._chargerStop(charger.id, now);
        continue;
      }
      const running = (this._getChargerState(charger.id).currentAmps ?? 0) > 0;
      const chargerBudgetW = gateBlocksStarts && !running ? 0 : budgetW;
      const result = await this._stepCharger(charger, chargerBudgetW, charger.phases, now, gridW, sustainedImport);
      statuses.push(result);
      budgetW = Math.max(0, budgetW - result.allocatedW);
    }

    // ── Mode & status ────────────────────────────────────────────────────────
    const socStr   = battery.soc !== null ? ` · Bat ${Math.round(battery.soc)}%` : '';
    const batPwStr = battery.powerW !== null
      ? (battery.powerW >= 0 ? ` ↑${Math.round(battery.powerW)}W` : ` ↓${Math.round(Math.abs(battery.powerW))}W`)
      : '';
    const active = statuses.filter((s) => s.allocatedW > 0);
    if (!active.length) {
      // The gate is named in the status text, not folded into "kein Überschuss": there may
      // well BE surplus, and a user looking at a sunny afternoon and a stopped charger
      // deserves to read the actual reason on the device tile.
      const stTextWait = batOverflowMode
        ? `Überschuss vorhanden · wartend${socStr}${batPwStr}`
        : batReserveMode
          ? `Orange Budget · kein Überschuss${socStr}${batPwStr}`
          : gateBlocksStarts
            ? `Prognose-Sperre · Batterie wird geschont${socStr}${batPwStr}`
            : `kein Überschuss${socStr}${batPwStr}`;
      const waitMode = (batOverflowMode || batReserveMode) ? MODES.BATTERY_PRIORITY : MODES.HOLDING;
      await this._setMode(waitMode, stTextWait);
      return alwaysW;
    } else {
      const parts  = active.map((s) => `${s.amps}A/${s.phases}ph`).join(' + ');
      const prefix = batOverflowMode ? 'Überschuss · ' : batReserveMode ? 'Reserve · ' : '';
      const stTextSolar = `${prefix}${parts}${active.length > 1 ? ` (${active.length} Lader)` : ''}${socStr}${batPwStr}`;
      await this._setMode(MODES.SOLAR_EV, stTextSolar);
      return alwaysW + active.reduce((s, r) => s + r.allocatedW, 0);
    }
  },

  /**
   * A charger is drawing power the EMS did not command. Logged once when it starts, and
   * once more if repeated stop commands are plainly not reaching it.
   */
  _noteUncommandedDraw(charger, amps) {
    const st = this._getChargerState(charger.id);
    st.uncommandedTicks += 1;
    const w = Math.round(charger.powerW);
    if (st.uncommandedTicks === 1) {
      this.log(`[EMS] charger ${charger.id}: drawing ${w}W without an EMS command — adopting at ${amps}A`);
    } else if (st.uncommandedTicks === CHARGER_STOP_WARN_TICKS) {
      // The stop is re-sent on every tick now, so without this the log would fill with
      // identical "stop" lines and still never say the obvious thing: they are not working.
      this.log(`[EMS] charger ${charger.id}: still drawing ${w}W after ${st.uncommandedTicks} stop attempts — the 0A command is not reaching it`);
      this._addHistoryEvent(HIST.CHARGER, 'stop_ineffective', `${w}W`, charger.id);
    }
  },

  /**
   * Decide, per charger, whether its car is done and the charger should be held.
   *
   * Extracted from _evaluateEvChargers because it produced a field bug that nothing here
   * could have caught: the hold is released in exactly one place, and that place sits
   * behind `car.target !== null`.
   *
   * The release used to be unreachable for a car with no target at all. 1.2.231 stopped
   * inventing an 80% limit for cars whose vehicle app reports none — but a charger already
   * holding from when that invented limit existed had nothing left to release it, because
   * the branch that clears the hold needs a target to compare against. Reported the same
   * day: an Audi at 80%, 3.3 kW going to the grid, and a charger stopped "until unplug"
   * against a limit that no longer existed.
   *
   * So: a car that has no target is a car nobody asked to stop, and any standing hold on it
   * goes. A car whose target source exists but has not answered yet is a different thing —
   * the hold stays, because releasing it on a momentary gap would restart a car that really
   * is full.
   */
  _updateTargetHold(chargers) {
    for (const c of chargers) {
      if (!c.connected) continue;
      const st  = this._getChargerState(c.id);
      const car = this._carForCharger(c);
      if (!car) continue;

      if (car.soc !== null && car.target !== null) {
        st.socBlindLogged = false;
        if (car.soc >= car.target) {
          if (st.targetReachedCar !== car.id) {
            this.log(`[EMS] charger ${c.id}: "${car.name}" reached target ${car.target}% (now ${car.soc}%) — holding until unplug`);
            this._addHistoryEvent(HIST.CHARGER, 'target_reached', `${car.name} ${car.soc}% ≥ ${car.target}%`, c.id);
          }
          st.targetReachedCar = car.id;
        } else if (car.soc < car.target - 2) {
          st.targetReachedCar = null; // target raised or battery drained → resume
        }
        continue;
      }

      // No target to compare against. Whether the charger may run is decided by normal
      // allocation from here — but only once any standing hold is gone, and that depends
      // on WHY there is no target.
      if (car.targetConfigured === false && st.targetReachedCar) {
        this.log(`[EMS] charger ${c.id}: "${car.name}" has no charge target any more — releasing the hold`);
        this._addHistoryEvent(HIST.CHARGER, 'target_released', `${car.name} — no target set`, c.id);
        st.targetReachedCar = null;
      }

      // Once per blind spell, not once per tick: a 100% car that only reports its SoC after
      // charging wakes it looks exactly like this for the two minutes before the truth
      // arrives, and the log used to show only the start and, later, the stop, with nothing
      // to connect them.
      if (!st.socBlindLogged) {
        st.socBlindLogged = true;
        const n = (v) => (v === null || v === undefined ? 'unknown' : `${v}%`);
        if (car.targetConfigured === false) {
          this.log(`[EMS] charger ${c.id}: "${car.name}" has no charge target — charging without a limit`);
        } else {
          this.log(`[EMS] charger ${c.id}: "${car.name}" charge target not checkable `
            + `(soc ${n(car.soc)}, target ${n(car.target)}) — charging until the car reports`);
        }
      }
    }
  },

  async _stepCharger(charger, budgetW, configPhases, now, gridW, forcedDown) {
    const st  = this._getChargerState(charger.id);
    let   cur = st.currentAmps ?? 0;

    // ── Steer by the meter, not by our own memory ────────────────────────────
    // st.currentAmps records what was last COMMANDED, and _chargerStop clears it the
    // moment the command is SENT — not when it takes effect. Two real failures came out
    // of trusting it:
    //   · a session started outside the EMS was invisible here, so it was never regulated
    //     down and never stopped, and the house battery quietly paid for the car;
    //   · a stop the charger ignored looked stopped forever. The stop path is guarded by
    //     `cur > 0`, and cur had just been reset, so exactly one command was ever sent.
    //     Reported from the field: history said "Lader gestoppt" at 19:43 and the battery
    //     was still giving up 3002 W a minute later.
    // Measured power settles both: a charger that is drawing is running, whoever started
    // it. The existing ladder logic then does the right thing on its own — with no budget
    // it finds no rung, sees cur > 0, and issues the stop again on the next tick.
    // An absent reading is "not drawing", never "drawing an unknown amount": `undefined <
    // CHARGER_LIVE_W` is false, which would have sent the adoption below straight into
    // Math.round(undefined / …) and put NaN amps on the wire.
    const hasMeter = Number.isFinite(charger.powerW);
    const drawnW = hasMeter ? charger.powerW : 0;
    if (drawnW < CHARGER_LIVE_W) {
      st.uncommandedTicks = 0;
    } else {
      // It is drawing, so whatever was asked of it arrived. Everything the silent-start
      // handling below remembers is about a start that did not, and none of it is true any
      // more — including a back-off from an earlier attempt.
      st.commandedSince = null;
      st.startRetried   = false;
      st.startBlockedUntil = null;
      st.ignoredStreak  = 0;
      if (cur === 0) {
        const ph = st.currentPhases ?? configPhases;
        cur = Math.max(charger.minAmps, Math.round(drawnW / (ph * 230)));
        st.currentAmps   = cur;
        st.currentPhases = ph;
        this._noteUncommandedDraw(charger, cur);
      }
    }

    // First tick after startup: observe only — no charger commands.
    // Prevents a spurious start/stop caused by stale phase state (currentPhases=null)
    // triggering an immediate phase-switch before the 30 s STEP_HOLD_MS guard kicks in.
    if (!this._warmupDone) return { amps: cur, phases: configPhases, allocatedW: cur * configPhases * 230 };

    // ── A start the charger never acted on ────────────────────────────────────
    // The mirror of the adoption above, and the half it does not cover. That block raises
    // cur when the meter shows MORE than was commanded; nothing lowered it when the meter
    // showed nothing at all. So a charger that ignored its start kept its whole share of
    // the surplus while drawing zero — 11 A × 230 V of it in the 2026-09-25 log — and the
    // devices behind it in the priority order went without power that was being exported.
    //
    // From the field: the EMS started the charger eleven times between 15:10 and 17:30,
    // every attempt stopped again inside a minute, the dehumidifier was pushed into
    // stop-grace by each start and released by each stop — twenty-two mode changes — and
    // charging began only when the owner pressed Start in the charger's own app.
    //
    // Three steps, and the order is the point:
    //   · hold   — a car mid-handshake is not a charger ignoring anything.
    //   · retry  — send the start once more. A start swallowed while the charger sat
    //              paused at 0 A is the likeliest cause and costs one trigger to rule out.
    //   · give up— stop, hand the surplus back, and stay off it for a while. The back-off
    //              is what breaks the loop; FLIP_COOLDOWN_MS alone just paces it.
    // hasMeter, not drawnW === 0. The adoption above may read an absent value as "not
    // drawing", because guessing low there only ever makes the EMS more cautious. Here the
    // same guess would be a verdict: a charger device with no power capability at all reads
    // silent on every tick for ever, and this block would stop it five minutes after every
    // start and then refuse it the surplus for half an hour. Without a meter there is
    // nothing to notice, so nothing is done.
    if (cur > 0 && hasMeter && drawnW < CHARGER_LIVE_W) {
      // Stamped here, not where the start was sent: this is the only place with the tick's
      // own clock in hand, and _chargerSetAmps is reached from five tiers that would each
      // have to thread it through. It also measures the right thing — the first tick that
      // SAW the charger silent, so a start is never blamed for the gap before anyone looked.
      // The retry below re-enters _chargerSetAmps with currentAmps cleared; because the
      // stamp lives here and only clears on a stop or a draw, that retry does not push the
      // give-up deadline out of reach.
      if (st.commandedSince === null) st.commandedSince = now;
      const silentMs = now - st.commandedSince;
      const heldPhases = st.currentPhases ?? configPhases;
      const held = { amps: cur, phases: heldPhases, allocatedW: cur * heldPhases * 230 };

      if (silentMs >= CHARGER_START_GIVEUP_MS) {
        // Doubling, not a fixed wait. The first give-up may be a car that was slow or a
        // charger that was briefly busy, and five minutes is the right answer to that. The
        // fifth in a row is not any of those things, and asking again every few minutes for
        // the rest of the afternoon helps nobody.
        st.ignoredStreak += 1;
        const backoffMs = Math.min(
          CHARGER_IGNORED_BACKOFF_MAX_MS,
          CHARGER_IGNORED_BACKOFF_MS * (2 ** (st.ignoredStreak - 1)),
        );
        const nth = st.ignoredStreak > 1 ? ` (${st.ignoredStreak} in a row)` : '';
        this.log(`[EMS] charger ${charger.id}: drew nothing for ${Math.round(silentMs / 1000)}s `
          + `after two start commands${nth} — releasing its ${held.allocatedW}W of surplus and `
          + `leaving it alone for ${Math.round(backoffMs / 60_000)} min. Check that the flow on `
          + `ems_start_charger really starts the charger, not only sets its current.`);
        await this._chargerStop(charger.id, now);
        st.startBlockedUntil = now + backoffMs;
        return { amps: 0, phases: heldPhases, allocatedW: 0 };
      }

      if (silentMs >= CHARGER_START_GRACE_MS && !st.startRetried) {
        st.startRetried = true;
        this.log(`[EMS] charger ${charger.id}: nothing drawn ${Math.round(silentMs / 1000)}s after `
          + `the start — sending it once more`);
        st.currentAmps = null; // the start branch of _chargerSetAmps fires on null
        await this._chargerSetAmps(charger.id, held.amps, heldPhases);
        return held;
      }

      return held; // inside the grace, or past the retry and still waiting — hold, do not stop
    }

    // The back-off itself. Only NEW starts from surplus are suppressed: a charger already
    // drawing never reaches here (cleared above), and instant, always-charge and off-peak
    // call _chargerSetAmps directly without coming through _stepCharger at all — a user
    // asking for a charge still gets one.
    //
    // The `cur === 0` test is belt and braces and provably so: startBlockedUntil is set in
    // exactly one place, inside the metered block above, which returns; a draw clears it
    // before this line is reached; a commanded-but-silent charger returns from that block
    // too; and it is not among the fields chargerState.js carries across a restart. There
    // is no path here with it set and cur above zero. It stays because reading the line
    // should not require having checked all four.
    if (cur === 0 && st.startBlockedUntil && now < st.startBlockedUntil) {
      return { amps: 0, phases: configPhases, allocatedW: 0 };
    }

    // ── Phase determination ───────────────────────────────────────────────────
    let phases = configPhases;
    if (charger.phaseSwitch) {
      const currentPhases = st.currentPhases ?? configPhases;
      const targetPhases  = this._bestPhases(budgetW, currentPhases);

      if (targetPhases !== currentPhases) {
        if (cur > 0) {
          // Charger already running: attempt immediate phase switch (with cooldown).
          const cooldownOver = !st.lastPhaseSwitchAt || (now - st.lastPhaseSwitchAt) >= PHASE_SWITCH_COOLDOWN_MS;
          // The cooldown exists to stop the charger flipping between phase counts. Dropping
          // to one phase when three no longer fit is not that kind of flip: the alternative
          // is not "stay where you are", it is a full stop, because MIN_3PH_W is the lowest
          // three-phase rung there is. Holding the cooldown here bought stability by trading
          // a phase change for an outage — five times in two hours in the 2026-08-26 log.
          //
          // Only downwards. Upwards the cooldown still applies in full, and together with
          // the margin in _bestPhases that is what keeps this from becoming a new oscillation.
          const trapped = targetPhases === 1 && currentPhases === 3 && budgetW < MIN_3PH_W;
          const canSwitch = cooldownOver || trapped;
          if (canSwitch && !forcedDown) {
            const maxA      = targetPhases === 1 ? Math.min(charger.maxAmps, 16) : charger.maxAmps;
            const newLadder = AMPS_LADDER
              .filter((a) => a >= charger.minAmps && a <= maxA)
              .map((a) => ({ amps: a, watts: a * targetPhases * 230 }));
            const newTarget = [...newLadder].reverse().find((r) => r.watts <= budgetW) ?? newLadder[0];
            if (newTarget) {
              st.currentPhases     = targetPhases;
              st.lastPhaseSwitchAt = now;
              st.pendingStepAmps   = null;
              st.pendingStepSince  = null;
              await this._chargerSetAmps(charger.id, newTarget.amps, targetPhases);
              return { amps: newTarget.amps, phases: targetPhases, allocatedW: newTarget.amps * targetPhases * 230 };
            }
          }
          phases = currentPhases; // waiting for cooldown — keep current phases
        } else {
          // Charger stopped: use target phases for the amp ladder so the
          // pending-step mechanism starts at the correct phase count.
          // _chargerSetAmps will persist currentPhases when it fires.
          phases = targetPhases;
        }
      } else {
        phases = currentPhases;
      }
    }

    // ── Build amp ladder for effective phase count ────────────────────────────
    const maxA   = (charger.phaseSwitch && phases === 1) ? Math.min(charger.maxAmps, 16) : charger.maxAmps;
    const ladder = AMPS_LADDER
      .filter((a) => a >= charger.minAmps && a <= maxA)
      .map((a) => ({ amps: a, watts: a * phases * 230 }));
    // Find highest rung that fits the budget. If none fits (budget below the
    // smallest rung), target stays null → handled below (hold-at-min or stop).
    let target = null;
    for (const r of ladder) { if (r.watts <= budgetW) target = r; }

    if (!target) {
      if (cur > 0) {
        // Export guard: if we're still exporting, hold at minimum instead of stopping.
        // Prevents oscillation when budget dips just below the smallest rung due to
        // battery correction while solar surplus is visibly present.
        if (!forcedDown && gridW !== null && gridW <= -EXPORT_GUARD_W) {
          const minRung = ladder[0];
          if (minRung) {
            if (minRung.amps !== cur) await this._chargerSetAmps(charger.id, minRung.amps, phases);
            return { amps: minRung.amps, phases, allocatedW: minRung.amps * phases * 230 };
          }
        }
        await this._chargerStop(charger.id, now);
      }
      return { amps: 0, phases, allocatedW: 0 };
    }

    // Forced step-down (sustained import) — bypass anti-thrash, and the down-hold below
    // with it. That delay exists to ride out a passing cloud; sustained import is not a
    // passing cloud, it is the house already paying for the overdraw.
    if (forcedDown && target.amps < cur) {
      st.pendingStepAmps = null; st.pendingStepSince = null;
      st.pendingDownSince = null;
      st.lastDownStepAt  = now;
      await this._chargerSetAmps(charger.id, target.amps, phases);
      return { amps: target.amps, phases, allocatedW: target.amps * phases * 230 };
    }

    if (target.amps > cur) {
      // ── Step up ──────────────────────────────────────────────────────────
      // Whatever happens below, a pending reduction is off: the surplus that would have
      // caused it is back. Leaving the clock running would let an old, already-answered
      // dip fire a reduction later, straight through a rise.
      st.pendingDownSince = null;
      const okCooldown = !st.lastDownStepAt || (now - st.lastDownStepAt) >= FLIP_COOLDOWN_MS;
      if (!okCooldown) return { amps: cur, phases, allocatedW: cur * phases * 230 };

      // Step-up destination. A running charger leaves UP_MARGIN_W of headroom above the
      // new rung so a brief surplus dip won't immediately flip to import. We pick the
      // HIGHEST rung whose watts + margin still fit the budget — checking
      // `budget >= target.watts + margin` directly was unsatisfiable whenever the rung
      // gap is smaller than the margin (single-phase rungs are 230 W apart, margin is
      // 250 W), which used to pin 1-phase chargers at their start amps forever.
      // A fresh start (cur === 0) has no margin requirement — it commits to `target`.
      let up = target;
      if (cur > 0) {
        up = [...ladder].reverse().find((r) => r.amps > cur && (r.watts + UP_MARGIN_W) <= budgetW) ?? null;
        if (!up) {
          st.pendingStepAmps = null; st.pendingStepSince = null;
          return { amps: cur, phases, allocatedW: cur * phases * 230 };
        }
      }

      if (st.pendingStepAmps !== up.amps) {
        st.pendingStepAmps = up.amps; st.pendingStepSince = now;
        return { amps: cur, phases, allocatedW: cur * phases * 230 };
      }

      const stepHoldMs = charger.stepHoldMs || STEP_HOLD_MS;
      if ((now - st.pendingStepSince) < stepHoldMs) {
        return { amps: cur, phases, allocatedW: cur * phases * 230 };
      }

      st.pendingStepAmps = null; st.pendingStepSince = null;
      await this._chargerSetAmps(charger.id, up.amps, phases);
      return { amps: up.amps, phases, allocatedW: up.amps * phases * 230 };

    } else if (target.amps < cur) {
      // ── Step down ────────────────────────────────────────────────────────
      if (gridW !== null && gridW <= -EXPORT_GUARD_W) {
        st.pendingStepAmps = null; st.pendingStepSince = null;
        st.pendingDownSince = null;
        return { amps: cur, phases, allocatedW: cur * phases * 230 };
      }

      // Optional confirmation time before reducing, the mirror of the step-up hold above.
      // Off by default (0), which is exactly the behaviour that existed before: down was
      // immediate while up had to be earned. That asymmetry is right for a house without
      // storage, where every second over budget is bought from the grid. With a battery it
      // is needlessly twitchy — the battery covers the gap for a passing cloud, and the
      // charger drops a rung it has to climb back a minute later, each drop costing another
      // FLIP_COOLDOWN_MS before it may rise again.
      //
      // Deliberately NOT keyed on the target amps, only on "a reduction is wanted". Keying
      // it on the destination would restart the clock whenever the target wobbled between
      // two rungs, and the step would never come. When the wait is over we step to whatever
      // the target is at that moment, not to the one that started the clock.
      //
      // The wait is bounded from outside: 60 s of real grid import raises forcedDown above,
      // which ignores this entirely. So it can only ever spend battery or brief import,
      // never a sustained draw.
      const downHoldMs = charger.stepDownHoldMs || 0;
      if (downHoldMs > 0) {
        if (!st.pendingDownSince) st.pendingDownSince = now;
        if ((now - st.pendingDownSince) < downHoldMs) {
          st.pendingStepAmps = null; st.pendingStepSince = null;
          return { amps: cur, phases, allocatedW: cur * phases * 230 };
        }
      }

      st.pendingStepAmps = null; st.pendingStepSince = null;
      st.pendingDownSince = null;
      st.lastDownStepAt  = now;
      await this._chargerSetAmps(charger.id, target.amps, phases);
      return { amps: target.amps, phases, allocatedW: target.amps * phases * 230 };

    } else {
      // ── Steady ───────────────────────────────────────────────────────────
      st.pendingStepAmps = null; st.pendingStepSince = null;
      st.pendingDownSince = null; // the surplus came back — the reduction is off
      return { amps: target.amps, phases, allocatedW: target.amps * phases * 230 };
    }
  },

};
