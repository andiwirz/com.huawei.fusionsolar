'use strict';

/**
 * The guarded capability write every polling driver needs.
 *
 * Nothing here is protocol-specific, which is why it sat byte-identically in fifteen
 * drivers across the Modbus and OpenAPI families. It lives on its own rather than inside
 * lib/modbus-polling.js so the OpenAPI drivers can use it without pulling in polling
 * machinery they do not have — they are driven by lib/openapi-coordinator.js instead.
 *
 * Applied the same way as the other mixins in this repo:
 *
 *     const capabilitySet = require('../../lib/capability-set');
 *     Object.assign(FooDevice.prototype, capabilitySet);
 *
 * Three drivers deliberately keep their own version and are not touched:
 * energy_management, fusionsolar_kiosk and smartcharger_ocpp each need different
 * behaviour here.
 */

// How long a lower reading must persist before it is believed rather than held.
//
// It was six hours in 1.2.261, and the field log for issue #34 showed what that cost. The
// station total also sinks a little every evening, as the battery discharges and
// FusionSolar's balance shrinks with it — and that small evening dip started the clock. On
// the night of 30 September it started at 19:28 and ran out at 01:28, in the middle of the
// big rollover dip: the guard re-anchored on 8207.27 and fifteen minutes later handed Homey
// the recovery to 8221.46, 14.19 kWh of solar at a quarter to two in the morning. Sunset and
// the rollover are about six hours apart, so this was close to systematic.
//
// A day clears every short-lived movement this counter has been seen to make: the evening
// sag is overtaken by the next morning's production, the rollover dip heals in half an hour.
// The only legitimate persistent drop on record — a FusionSolar plant record recreated in
// 2025, which took a station's lifetime total down with it for good — happens once in years,
// and waiting a day before believing it costs nothing worth keeping.
const CUMULATIVE_REANCHOR_MS = 24 * 60 * 60 * 1000;

module.exports = {

  /**
   * Set `capability` to `value`, skipping the writes not worth making.
   *
   * Skips null/undefined rather than clearing the capability: a single missing register
   * in an otherwise good poll should leave the last known reading standing, and a poll
   * that fails as a whole takes the device unavailable, which says it more clearly than
   * a field going blank would.
   *
   * Skips unchanged values, so a meter reporting the same figure all night costs nothing.
   *
   * Never throws: a rejected write is logged and the poll carries on to the remaining
   * capabilities, instead of one bad field aborting the whole update.
   */
  async _set(capability, value) {
    if (value === null || value === undefined) return;
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    try {
      await this.setCapabilityValue(capability, value);
    } catch (err) {
      this.log(`_set(${capability}, ${value}) failed:`, err.message);
    }
  },

  /**
   * Set a meter Homey treats as cumulative, holding the last high reading when the source
   * moves backwards.
   *
   * Homey derives a daily figure from a cumulative meter by difference, and it does not
   * subtract when the meter falls — it re-anchors and counts the recovery as new energy.
   * A source that dips and returns therefore injects the size of the dip as production out
   * of nothing. Measured on the plant in issue #34, three nights running:
   *
   *     27 Sep 01:00   8149 kWh
   *     27 Sep 01:15   8127 kWh     <- FusionSolar's rollover, mid-flight
   *     shortly after  8149 kWh
   *
   * and the next morning, before sunrise, Homey Energy reported 21.2 kWh of solar — the
   * previous day's real production, to two decimal places, generated in the dark.
   *
   * The cause is upstream and not ours to fix: the station total behaves as "finished days
   * plus today's running share", so at the rollover today's share leaves the sum before the
   * finished day is folded in. What is ours is that we hand that number to Homey under a
   * contract it does not keep.
   *
   * So: never write below the high-water mark, and remember the mark across restarts. A dip
   * is then simply not visible downstream — nothing is written, the capability holds, and
   * the recovery changes nothing.
   *
   * A lower reading that PERSISTS is a different thing and is eventually believed. That case
   * is real: a FusionSolar plant record recreated in 2025 took its lifetime total down with
   * it, and a counter frozen for ever at a figure the plant no longer has is worse than a
   * one-off step. Re-anchoring is logged, because a silent one would look exactly like the
   * bug this guards against.
   */
  async _setCumulative(capability, value, now = Date.now()) {
    if (value === null || value === undefined) return;
    if (!Number.isFinite(value)) return;
    if (!this.hasCapability(capability)) return;

    if (!this._cumulativeMarks) this._cumulativeMarks = {};
    let mark = this._cumulativeMarks[capability];
    if (!mark) {
      // Across a restart the mark matters more than it looks: without it the first poll
      // after an app update would accept whatever the source says, dip included.
      const stored = Number(this.getStoreValue(`cumulative_high.${capability}`));
      mark = { high: Number.isFinite(stored) ? stored : null, lowSince: null };
      this._cumulativeMarks[capability] = mark;
    }

    // The null test is belt and braces, and provably so: with no mark yet, `value >= null`
    // coerces to `value >= 0`, which is true for every figure a kWh counter can hold. It
    // stays because "there is no mark yet, take this one" is the thing being said here, and
    // leaning on null coercing to zero says it only to someone who already knows.
    if (mark.high === null || value >= mark.high) {
      if (mark.lowSince !== null) {
        this.log(`${capability}: back to ${value} — the dip below ${mark.high} was never written`);
        mark.lowSince = null;
      }
      if (value !== mark.high) {
        mark.high = value;
        await this.setStoreValue(`cumulative_high.${capability}`, value).catch(() => {});
      }
      return this._set(capability, value);
    }

    if (mark.lowSince === null) {
      mark.lowSince = now;
      this.log(`${capability}: source reports ${value}, below the high-water mark ${mark.high} `
        + `— holding. Believed if it lasts ${CUMULATIVE_REANCHOR_MS / 3_600_000} h.`);
      return undefined;
    }

    if (now - mark.lowSince < CUMULATIVE_REANCHOR_MS) return undefined;

    this.log(`${capability}: ${value} has stood below ${mark.high} for `
      + `${Math.round((now - mark.lowSince) / 3_600_000)} h — re-anchoring. Homey will read the `
      + `step down as a meter reset, not as production.`);
    mark.high = value;
    mark.lowSince = null;
    await this.setStoreValue(`cumulative_high.${capability}`, value).catch(() => {});
    return this._set(capability, value);
  },

};
