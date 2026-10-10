'use strict';

// Local midnight in the Homey's timezone, right on the two days a year that are not 24 hours
// long (1.2.299).
//
// Node runs in UTC on a Homey, so "the next midnight" was computed from the wall clock as
// 86 400 s minus the seconds already gone today. That is a day of 24 hours. On the last
// Sunday of October the day has 25: a timer set at 00:00:05 fired at 23:00:05 the same
// evening, and the energy-balance baseline it writes made the last hour of the day count
// from there — about nothing. In March the day has 23 and the timer fired at 01:00:05,
// an hour late. "Tomorrow's midnight minus 24 h" as today's start was off by the same hour.
//
// Here a local wall time is turned into an instant by asking Intl what the zone's offset
// is, twice: once at a first guess, once at the corrected instant, which settles the case
// where the guess and the answer fall on different sides of a clock change.

const _fmt = new Map();
function formatter(tz) {
  let f = _fmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    _fmt.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a timezone. */
function localParts(tz, ms) {
  const out = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = parseInt(p.value, 10);
  }
  if (out.hour === 24) out.hour = 0;
  return { y: out.year, m: out.month, d: out.day, hh: out.hour, mi: out.minute, ss: out.second };
}

/** The zone's offset from UTC at an instant, in ms (local minus UTC). */
function offsetMs(tz, ms) {
  const p = localParts(tz, ms);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mi, p.ss) - (Math.floor(ms / 1000) * 1000);
}

/**
 * The instant a local wall time occurs. Day overflow (d + 1 at month end) is allowed.
 *
 * A wall time the clocks jump over has no instant of its own. Where daylight saving starts
 * AT midnight — Chile, the Azores, Cuba — local 00:00 does not exist on that day: the clocks
 * go from 23:59:59 to 01:00. The two passes then settled on 23:00 of the evening BEFORE, so
 * "the next midnight" lay in the past: the app's midnight timer fired at 23:00, wrote the
 * day's baselines an hour early, and rescheduled itself with a delay of zero or less — about
 * 1.8 million times until 01:00 (review 2026-10-10). Such a time is taken as the moment the
 * clocks jump, which is the first instant of the new day: the later of the two candidates.
 */
function localToEpoch(tz, y, m, d, hh = 0, mi = 0, ss = 0) {
  const wall = Date.UTC(y, m - 1, d, hh, mi, ss);
  const t1 = wall - offsetMs(tz, wall);
  const t2 = wall - offsetMs(tz, t1);
  // t2 maps back to the wall time asked for on every ordinary day, and on the day the clocks
  // go back, as before. When it does not, the wall time is in the gap.
  if (t2 + offsetMs(tz, t2) === wall) return t2;
  return Math.max(t1, t2);
}

/** Start of the local calendar day an instant falls in. */
function startOfLocalDay(tz, ms) {
  const p = localParts(tz, ms);
  return localToEpoch(tz, p.y, p.m, p.d);
}

/** Start of the next local calendar day. */
function nextLocalMidnight(tz, ms) {
  const p = localParts(tz, ms);
  return localToEpoch(tz, p.y, p.m, p.d + 1);
}

function safeTz(tz) {
  try { formatter(tz || 'UTC'); return tz || 'UTC'; } catch { return 'UTC'; }
}

module.exports = { localParts, offsetMs, localToEpoch, startOfLocalDay, nextLocalMidnight, safeTz };
