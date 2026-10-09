'use strict';

/**
 * The battery's Time of Use windows (register 47255, 43 words), as text in the device
 * settings — one line per window, in the format of the Home Assistant integration
 * (wlcrs/huawei_solar, service set_tou_periods):
 *
 *   00:00-06:00/12345/+
 *   start-end / days, 1 = Monday … 7 = Sunday / + charge, - discharge
 *
 * The register layout and the checks are wlcrs/huawei-solar-lib's
 * (register_definitions/periods.py, HUAWEI_LUNA2000_TimeOfUseRegisters): the number of
 * windows, then 14 slots of three words — start and end in minutes since midnight, and one
 * word whose high byte is the flag (0 charge, 1 discharge) and whose low byte holds the
 * days, bit 0 = Sunday … bit 6 = Saturday. Unused slots are zero. A window must start
 * before it ends, within the day, and two windows must not overlap on a day they share.
 *
 * Errors carry a `code` and the `line` they are about, so the device can say in the user's
 * language what is wrong where; the English message is for the log.
 */

const MAX_PERIODS = 14;
const WORDS = 1 + 3 * MAX_PERIODS; // 43
const DAY_MINUTES = 24 * 60;

class TouError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// days[0] is Sunday, as in the register; the text says Sunday last, as 7.
function daysToText(days) {
  let out = '';
  for (let d = 1; d <= 7; d++) if (days[d % 7]) out += String(d);
  return out;
}

/** 43 register words → windows. Throws on a count no battery can hold. */
function decode(words) {
  if (!Array.isArray(words) || words.length < WORDS) {
    throw new TouError('length', `expected ${WORDS} words, got ${Array.isArray(words) ? words.length : typeof words}`);
  }
  const count = words[0];
  if (count > MAX_PERIODS) throw new TouError('count', `device reports ${count} windows, the maximum is ${MAX_PERIODS}`);
  const periods = [];
  for (let i = 0; i < count; i++) {
    const [start, end, packed] = words.slice(1 + i * 3, 4 + i * 3);
    const bits = packed & 0xFF;
    periods.push({
      start,
      end,
      charge: (packed >> 8) === 0,
      days: Array.from({ length: 7 }, (_, d) => (bits & (1 << d)) !== 0),
    });
  }
  return periods;
}

/** Windows → 43 register words, after the same checks parse() makes. */
function encode(periods) {
  validate(periods);
  const words = [periods.length];
  for (const p of periods) {
    let bits = 0;
    p.days.forEach((on, d) => { if (on) bits |= 1 << d; });
    words.push(p.start, p.end, ((p.charge ? 0 : 1) << 8) | bits);
  }
  while (words.length < WORDS) words.push(0);
  return words;
}

/** Windows → the text the setting shows, one line each. No windows → empty. */
function format(periods) {
  return periods.map((p) => `${hhmm(p.start)}-${hhmm(p.end)}/${daysToText(p.days)}/${p.charge ? '+' : '-'}`).join('\n');
}

const LINE = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*\/\s*([1-7]+)\s*\/\s*([+-])$/;

/** The setting's text → windows. Blank lines are skipped; anything else must be a window. */
function parse(text) {
  const periods = [];
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) return;
    const n = idx + 1;
    const m = LINE.exec(line);
    if (!m) throw new TouError('format', `line ${n}: "${line}" is not start-end/days/+ or -`, { line: n, text: line });
    const [h1, m1, h2, m2] = [m[1], m[2], m[3], m[4]].map(Number);
    if (m1 > 59 || m2 > 59 || h1 * 60 + m1 > DAY_MINUTES || h2 * 60 + m2 > DAY_MINUTES) {
      throw new TouError('time', `line ${n}: "${line}" has a time outside 00:00–24:00`, { line: n, text: line });
    }
    const days = Array(7).fill(false);
    for (const ch of m[5]) {
      const d = Number(ch) % 7;
      if (days[d]) throw new TouError('days', `line ${n}: "${line}" names a day twice`, { line: n, text: line });
      days[d] = true;
    }
    periods.push({ start: h1 * 60 + m1, end: h2 * 60 + m2, charge: m[6] === '+', days, line: n, text: line });
  });
  validate(periods);
  return periods;
}

function validate(periods) {
  if (periods.length > MAX_PERIODS) {
    throw new TouError('tooMany', `${periods.length} windows, the battery holds ${MAX_PERIODS}`, { count: periods.length });
  }
  for (const p of periods) {
    if (!(p.start >= 0 && p.end <= DAY_MINUTES && p.start < p.end)) {
      throw new TouError('order', `"${p.text || format([p])}" does not start before it ends`, { line: p.line, text: p.text || format([p]) });
    }
    if (!p.days.some(Boolean)) {
      throw new TouError('days', `"${p.text || format([p])}" is on no day`, { line: p.line, text: p.text || format([p]) });
    }
  }
  for (let d = 0; d < 7; d++) {
    const today = periods.filter((p) => p.days[d]).sort((a, b) => a.start - b.start);
    for (let i = 1; i < today.length; i++) {
      if (today[i].start < today[i - 1].end) {
        const [a, b] = [today[i - 1], today[i]];
        throw new TouError('overlap', `"${a.text || format([a])}" and "${b.text || format([b])}" overlap`, {
          line: b.line, text: a.text || format([a]), other: b.text || format([b]),
        });
      }
    }
  }
}

/** A parse error in the user's language (locales: modbus.tou.*), for the settings dialog. */
function message(homey, err) {
  const known = ['format', 'time', 'days', 'order', 'overlap', 'tooMany'];
  if (!err || !known.includes(err.code)) return (err && err.message) || String(err);
  const fill = { line: err.line, text: err.text, other: err.other, count: err.count, max: MAX_PERIODS };
  return homey.__(`modbus.tou.${err.code}`).replace(/\{\{(\w+)\}\}/g, (m, k) => (fill[k] ?? m));
}

/** The windows as the setting would show them, or null when the text does not parse. */
function normalize(text) {
  try { return format(parse(text)); } catch (_) { return null; }
}

module.exports = { MAX_PERIODS, WORDS, TouError, decode, encode, format, parse, validate, normalize, message };
