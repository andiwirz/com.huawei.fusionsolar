'use strict';

// Shared EMS constants. Extracted from drivers/energy_management/device.js so the
// device orchestrator and the lib/ems/* mixins reference one source of truth.
module.exports = {
  TICK_MS:                  15_000,       // default control-loop interval
  // Bounds for the configurable interval. Below 10 s the loop only re-reads the meters
  // more often without changing behaviour — nearly every decision is gated by hold timers
  // of 30 s and up. (Price, car SoC and PV forecast do not scale with it at all: they sit
  // behind SLOW_REFRESH_MS.) Above 60 s the battery floor and the import ceiling react too
  // late to be worth calling a safety limit.
  TICK_MIN_S:               10,
  TICK_MAX_S:               60,
  STEP_HOLD_MS:             30_000,
  IMPORT_HOLD_MS:           60_000,
  FLIP_COOLDOWN_MS:         5 * 60_000,
  // How long a charger may draw nothing after being started before the EMS stops believing
  // the start landed. A car on the VW MEB platform takes 30-60 s between the contactor
  // closing and the first amp; the 2026-09-25 field log shows the EMS giving up after 57,
  // which is inside that window. 90 s clears it without making a genuinely dead start
  // expensive.
  CHARGER_START_GRACE_MS:   90_000,
  // Total patience for one start attempt, grace and retry together. Past this the charger
  // is not going to charge on this attempt, and holding the surplus for it costs the
  // devices behind it in the priority order real running time.
  CHARGER_START_GIVEUP_MS:  5 * 60_000,
  // The FIRST back-off, after a charger ignores a start twice. Short on purpose: the
  // back-off costs nothing while a charger is charging (any draw clears it), but it does
  // delay the next offer of surplus to one that has started behaving — a car that wakes up,
  // a flow that gets fixed. Five minutes forgives that quickly.
  // The deliberate tiers (instant, always-charge, off-peak) are NOT blocked: those are the
  // user asking for a charge, and they never come through _stepCharger.
  CHARGER_IGNORED_BACKOFF_MS: 5 * 60_000,
  // Each further give-up without a single amp drawn in between doubles the wait — 5, 10,
  // 20 — up to this ceiling. The two halves of the trade want opposite things, and a fixed
  // number can only serve one: a charger that hiccups once is forgiven in five minutes, and
  // one that is genuinely not listening stops being asked every few minutes all afternoon.
  // Measured over the 140-minute window that prompted all this, with the charger silent
  // throughout: 26 starts at a flat five minutes, 12 escalating, 8 at a flat thirty. The
  // waits run 5 → 10 → 20 → 30 → 30. For scale, the field log before any of this: 11.
  // The streak resets on any draw and on the cable coming out, and is not carried across a
  // restart — a restarted app gives every charger the benefit of the doubt again.
  CHARGER_IGNORED_BACKOFF_MAX_MS: 30 * 60_000,
  SIMPLE_MIN_RUN_MS:        5 * 60_000,  // min run time for HP/boiler/pool before stop allowed
  SIMPLE_STATE_KEY:         'ems_simple_states', // simple-device timers, persisted across restarts
  // How long a stored state stays meaningful. An app update takes seconds and a Homey
  // reboot a few minutes; past this the timers describe a world that has moved on, so
  // the state is dropped and the devices are re-adopted from their actual on/off state.
  SIMPLE_STATE_MAX_GAP_MS:  10 * 60_000,
  // How stale `savedAt` may get while nothing changes. Without this the timestamp answered
  // the wrong question: it recorded when a timer last MOVED, not when the state was last
  // known good. A field log showed the cost side by side — one restart, two lines, same
  // second: "charger state restored, 18s gap" and "simple-device state discarded, 16 min
  // old". The app had been away eighteen seconds; the simple devices were thrown out
  // because nothing had happened for a quarter of an hour. The steadier the house, the more
  // reliably a deploy erased the timers.
  SIMPLE_STATE_SAVE_MS:     5 * 60_000,
  // Same idea for the chargers, which kept their state in memory only until 1.2.173.
  // Two things were lost on every deploy: the "this car is at its target, leave it alone
  // until it is unplugged" latch — so the EMS restarted a full car, ramped it to 16 A and
  // stopped again two minutes later once the SoC came back — and the running charge
  // session's accumulated kWh, which simply vanished from the session log.
  CHARGER_STATE_KEY:        'ems_charger_states',
  CHARGER_STATE_MAX_GAP_MS: 10 * 60_000,
  // A running session's energy changes every tick, so writing on every change would mean a
  // settings write every 20 s for the length of a charge. Decisions (the target latch, a
  // session opening or closing) are written the moment they change; the accumulating
  // numbers ride along at most this often, plus a flush on shutdown. A clean restart —
  // which is what a deploy is — therefore loses nothing at all, and only a crash costs up
  // to five minutes of kWh.
  CHARGER_STATE_SAVE_MS:    5 * 60_000,
  EMS_HISTORY_MAX:          400,          // max history events kept in memory + settings
  CHARGE_SESSIONS_MAX:      200,          // max completed charge sessions kept in memory + settings
  PRICE_FORECAST_STALE_NOTIFY_MS: 48 * 60 * 60_000, // notify once when a previously-fed forecast has been stale this long
  // Hysteresis on the solar-forecast gate: once closed, it reopens only when the remaining
  // forecast exceeds the deficit by this much. Without it the gate flapped at the crossing
  // (field, 2026-08-18: active at 5.1/5.7, open at 5.1/5.1, active again at 5.1/5.3, all
  // within 28 minutes) — and each opening STARTED devices whose draw slowed the battery's
  // charging, grew the deficit and closed the gate again. The opening undid itself; same
  // disease as the overflow exception, one level up. 1 kWh clears the observed flap band
  // (≤0.6 kWh) and the 1%-SoC quantisation of a 15 kWh battery (0.15 kWh) with margin,
  // while costing a genuine opening only a few minutes of morning sun.
  FORECAST_GATE_HYSTERESIS_KWH: 1,
  PHASE_SWITCH_COOLDOWN_MS: 10 * 60_000,
  // Everything below is wall-clock, deliberately. These used to be counted in ticks, which
  // silently tied their meaning to the tick length: at a 60 s interval "4 ticks" of stale
  // grid data would be four minutes of controlling on a dead sensor, and nobody would
  // connect that to a setting called "tick interval".
  GRID_SENSOR_HOLD_MS:      60_000,       // keep using the last valid gridW this long on sensor failure
  // A charger's plug state that could not be READ (the Web API timed out or failed) is not
  // "unplugged". Within this window the last state read stands; past it, a charger that still
  // cannot be read counts as unplugged, as before. Longer than the grid hold because a false
  // "unplugged" costs more than a false "plugged in": it switches instant charging off for
  // good and splits the charge session, while a charger with no car simply draws nothing.
  CHARGER_STATE_HOLD_MS:    2 * 60_000,
  // Same idea for the battery state of charge, and for a sharper reason: since 1.2.188 an
  // absent SoC HOLDS the hard stop rather than releasing it, so a single dropped reading
  // would otherwise stop every device for a tick and start them again on the next one.
  BATTERY_SOC_HOLD_MS:      60_000,
  SLOW_REFRESH_MS:          60_000,       // price / car SoC / PV forecast refresh cadence
  HISTORY_SAVE_MS:          5 * 60_000,   // periodic history flush (charger events)
  // Upper bound for "time since the previous tick". A restart, a suspended Homey or a
  // stopped debugger must not book the whole gap as runtime into a single tick.
  TICK_MAX_DT_MS:           2 * 60_000,
  // A charger drawing at least this much is charging, whatever the EMS last commanded.
  // Comfortably below the smallest rung a car can take (6 A × 1 ph × 230 V = 1380 W) and
  // comfortably above the idle draw of a charger that is merely powered on.
  CHARGER_LIVE_W:           500,
  // After this many consecutive ticks of a charger drawing power the EMS did not ask for,
  // stop assuming the next stop command will land and say so instead. At a 15-30 s tick
  // that is under two minutes — long enough that a car winding down is not reported as a
  // fault, short enough to catch before the house battery has given up much.
  CHARGER_STOP_WARN_TICKS:  4,
  // How long the control loop will wait for a flow trigger it fired. It only needs the
  // trigger dispatched, never its result, and every other await in a tick is already
  // bounded. Generous enough that a healthy Homey never hits it (dispatch is milliseconds),
  // short enough that a stuck flow costs a fraction of a tick instead of five minutes.
  TRIGGER_BUDGET_MS:        3000,
  IMPORT_ACT_W:             200,
  EXPORT_GUARD_W:           200,
  UP_MARGIN_W:              250,
  MIN_3PH_W:                6 * 3 * 230,      // 4140 W — minimum viable 3-phase load
  // Headroom a charger must see before it COMMITS to three phases. MIN_3PH_W is not just
  // the entry price, it is the floor afterwards, so switching over at exactly that figure
  // leaves nowhere to step down to and the next dip stops the charger outright. One rung of
  // three-phase current (1 A x 3 x 230). Staying at three phases needs only MIN_3PH_W.
  PHASE_UP_MARGIN_W:        1 * 3 * 230,      // 690 W
  AMPS_LADDER:              [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32],
  EXPORT_LIMIT_MIN_EXPORT_W: 100,          // export-limit coordinator: min. grid export (W) to count as "exporting"
  EXPORT_LIMIT_HOLD_MS:      5 * 60_000,    // min. hold before the export limit may deactivate (anti-oscillation)

  // ── Solcast PV forecast ──────────────────────────────────────────────────
  // Solcast's free Hobbyist tier allows ~10 API calls/day. Fetch at most every 3 h
  // (≤ 8/day) and persist the last fetch time so app restarts don't burn the budget.
  SOLCAST_BASE_URL:          'https://api.solcast.com.au',
  PV_FORECAST_MIN_INTERVAL_MS: 3 * 60 * 60_000,  // ≥ 3 h between successful fetches
  PV_FORECAST_BACKOFF_MS:      6 * 60 * 60_000,  // wait this long after an error / HTTP 429
  PV_FORECAST_TIMEOUT_MS:      15_000,
  PV_FORECAST_STALE_MS:        24 * 60 * 60_000, // older than this → treat as unavailable (fetches stuck)

  // ── Price forecast (D10) ─────────────────────────────────────────────────
  // Pushed via the ems_set_price_forecast flow action (e.g. from "Power by the Hour"
  // / Tibber / any price app) — no active fetch, so no rate limit. Staleness just
  // detects a broken/removed source flow.
  // Most day-ahead sources (Power by the Hour, Tibber, …) push once per day, so the
  // gap between updates is normally close to 24h — a 6h threshold flagged this as
  // stale for most of every day, spending most of the time in the fail-safe
  // (continuous charging) instead of actually price-optimising. 30h tolerates a
  // ~24h cadence plus slack for the trigger firing a bit later some days, while
  // still catching a genuinely broken/removed source flow within a day and a half.
  PRICE_FORECAST_STALE_MS:     30 * 60 * 60_000, // older than this → treat as unavailable
  PRICE_SLOT_HOURS:            1,               // hourly price slots (matches Power by the Hour / most day-ahead feeds)
  // Home-battery price charging has no real-world deadline (unlike an EV that must be
  // ready by a departure time) — it just buys the cheapest available power. A rolling
  // lookahead window (rather than a fixed clock-time cutoff) lets it wait for a
  // genuinely cheaper hour tomorrow instead of being forced to commit by an artificial
  // "by HH:MM" time. 24h keeps the search bounded to what's normally already known.
  PRICE_BATTERY_LOOKAHEAD_MS:  24 * 60 * 60_000,

  // Canonical EMS mode ids — MUST match the ems_mode enum in app.json. Centralised so
  // the value is written once instead of as scattered string literals.
  MODES: Object.freeze({
    IDLE: 'idle', NOT_CONFIGURED: 'not_configured', DISABLED: 'disabled', ERROR: 'error',
    BATTERY_PRIORITY: 'battery_priority', HOLDING: 'holding',
    SOLAR_EV: 'solar_ev', OFFPEAK_EV: 'offpeak_ev', INSTANT_EV: 'instant_ev', PRICE_EV: 'price_ev',
    LOWTARIFF_EV: 'lowtariff_ev',
    SOLAR_HP: 'solar_hp', SOLAR_BOILER: 'solar_boiler', SOLAR_POOL: 'solar_pool',
    SOLAR_DEHUMIDIFIER: 'solar_dehumidifier', SOLAR_AIRCON: 'solar_aircon',
    SOLAR_MULTI: 'solar_multi',
    // history-only mode events (not ems_mode enum values)
    EXPORT_LIMIT_ON: 'export_limit_on', EXPORT_LIMIT_OFF: 'export_limit_off',
  }),
  // History event categories.
  HIST: Object.freeze({ MODE: 'mode', DEVICE: 'device', SYSTEM: 'system', CHARGER: 'charger' }),
};
module.exports.MIN_CHARGE_W = module.exports.AMPS_LADDER[0] * 230; // 1380 W — single-phase minimum

/**
 * Export that must REMAIN after a device starts under the hard-stop overflow exception —
 * and, therefore, that must be held back when allocating to it. 690 W.
 *
 * One number for both jobs on purpose. It used to be two: the exception let a device start
 * at 2×MIN_CHARGE_W and kept it running down to ½×MIN_CHARGE_W, but nothing stopped the
 * allocation from consuming everything in between. Measured at 30% SoC with 7 kW of PV:
 * 3500 W of export started the charger at 15 A, which drew 3450 W and left 50 W — below
 * the continue threshold, so the next tick stopped it, and the flip cooldown then held it
 * off for five minutes before the whole thing repeated. Every export between 2760 W and
 * ~4750 W oscillated; above that it only held because the 3-phase cap happened to leave a
 * remainder.
 *
 * Reserving this figure makes the start threshold fall out of the arithmetic rather than
 * being guessed: enough for the smallest rung AND the remainder, i.e. MIN_CHARGE_W + this.
 */
module.exports.OVERFLOW_KEEP_W = module.exports.MIN_CHARGE_W / 2;
module.exports.OVERFLOW_START_W = module.exports.MIN_CHARGE_W + module.exports.OVERFLOW_KEEP_W;
