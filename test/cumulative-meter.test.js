'use strict';

// A cumulative meter that must not move backwards (lib/capability-set.js, _setCumulative).
//
// Reported as issue #34 by Jamesquare78, with the Insights curve that proved it. FusionSolar's
// station total behaves as "finished days plus today's running share", so at the nightly
// rollover today's share leaves the sum before the finished day is folded in. Measured on his
// plant, three nights running:
//
//     27 Sep 01:00   8149 kWh
//     27 Sep 01:15   8127 kWh     <- the rollover, mid-flight
//     shortly after  8149 kWh
//
// Homey derives a daily figure from a cumulative meter by difference and does not subtract
// when the meter falls — it re-anchors and counts the recovery as new energy. The next
// morning, before sunrise, Homey Energy reported 21.2 kWh of solar. The previous day's real
// production was 21.22.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');

const capabilitySet = require('../lib/capability-set');

const CAP = 'meter_power.pv_total';
const T0  = 1_770_000_000_000;
const HOUR = 3_600_000;

// A device with just enough of Homey's surface for _setCumulative: a capability value, a
// store, and a log. _set is the real one.
function makeDevice({ store = {}, caps = [CAP] } = {}) {
  const dev = {
    values: {}, logs: [], store: { ...store }, writes: 0,
    log(m) { this.logs.push(String(m)); },
    hasCapability(c) { return caps.includes(c); },
    getCapabilityValue(c) { return this.values[c] === undefined ? null : this.values[c]; },
    async setCapabilityValue(c, v) { this.values[c] = v; this.writes += 1; },
    getStoreValue(k) { return this.store[k]; },
    async setStoreValue(k, v) { this.store[k] = v; },
  };
  Object.assign(dev, capabilitySet);
  return dev;
}

const HIGH_KEY = `cumulative_high.${CAP}`;

// ── the reported failure ────────────────────────────────────────────────────────

test("Jamesquare's night: the dip never reaches the capability", async () => {
  const dev = makeDevice();
  // 27 Sep, as his Insights recorded it.
  await dev._setCumulative(CAP, 8149, T0);
  await dev._setCumulative(CAP, 8127, T0 + 15 * 60_000);
  await dev._setCumulative(CAP, 8149, T0 + 30 * 60_000);

  assert.strictEqual(dev.getCapabilityValue(CAP), 8149);
  assert.ok(!Object.values(dev.values).includes(8127), 'the dip was written through');
  assert.strictEqual(dev.writes, 1, 'the capability moved more than once across a flat night');
});

test('and the morning after adds only the day that really happened', async () => {
  // The whole point: Homey takes the difference. Across the dip the difference must be zero,
  // and then exactly the real production.
  const dev = makeDevice();
  await dev._setCumulative(CAP, 8170, T0);                       // evening of the 27th
  const beforeNight = dev.getCapabilityValue(CAP);

  await dev._setCumulative(CAP, 8149, T0 + 1 * HOUR);            // 01:25, the rollover
  await dev._setCumulative(CAP, 8170, T0 + 1.5 * HOUR);          // recovered
  const atDawn = dev.getCapabilityValue(CAP);

  await dev._setCumulative(CAP, 8191.22, T0 + 14 * HOUR);        // a real 21.22 kWh day

  assert.strictEqual(atDawn - beforeNight, 0,
    `Homey would have booked ${atDawn - beforeNight} kWh of solar overnight`);
  // Tolerance, not equality: 8191.22 − 8170 is 21.220000000000255 in binary floating point,
  // and the assertion is about the day being counted once, not about IEEE 754.
  assert.ok(Math.abs((dev.getCapabilityValue(CAP) - atDawn) - 21.22) < 1e-6);
});

test('the dip is announced once, not on every poll inside it', async () => {
  const dev = makeDevice();
  await dev._setCumulative(CAP, 8170, T0);
  for (let i = 1; i <= 5; i++) await dev._setCumulative(CAP, 8149, T0 + i * 5 * 60_000);

  const held = dev.logs.filter((l) => l.includes('holding'));
  assert.strictEqual(held.length, 1, `logged the same dip ${held.length} times`);
});

test('the recovery says so, so a field log shows the dip happened at all', async () => {
  const dev = makeDevice();
  await dev._setCumulative(CAP, 8170, T0);
  await dev._setCumulative(CAP, 8149, T0 + HOUR);
  await dev._setCumulative(CAP, 8170, T0 + 1.5 * HOUR);

  assert.ok(dev.logs.some((l) => l.includes('never written')),
    'nothing in the log would tell you the counter had dipped');
});

// ── a reading that is genuinely lower ───────────────────────────────────────────

test('a lower reading that persists is eventually believed', async () => {
  // Real case, from the comment in the OpenAPI driver: a FusionSolar plant record recreated
  // in 2025 took the station's lifetime total down with it. A counter frozen for ever at a
  // figure the plant no longer has is worse than one honest step down.
  const dev = makeDevice();
  await dev._setCumulative(CAP, 8170, T0);
  await dev._setCumulative(CAP, 120, T0 + HOUR);
  assert.strictEqual(dev.getCapabilityValue(CAP), 8170, 'believed the drop immediately');

  // Six hours is no longer enough — that was 1.2.261, and the night of 30 September is why.
  await dev._setCumulative(CAP, 122, T0 + 7 * HOUR);
  assert.strictEqual(dev.getCapabilityValue(CAP), 8170, 'still re-anchoring after six hours');

  await dev._setCumulative(CAP, 125, T0 + 25 * HOUR);

  assert.strictEqual(dev.getCapabilityValue(CAP), 125, 'still frozen after a full day');
  assert.ok(dev.logs.some((l) => l.includes('re-anchoring')), 'the step down was silent');
});

test('the clock for that runs from the first low reading, not the last', async () => {
  // A plant that is climbing again from a new base reports a DIFFERENT lower value every
  // poll. Restarting the clock on each would mean never re-anchoring at all.
  const dev = makeDevice();
  await dev._setCumulative(CAP, 8170, T0);
  // First low reading at T0 + 1 h, so the day is up at T0 + 25 h — regardless of the
  // twenty-three further, different low readings in between.
  for (let h = 1; h <= 24; h++) await dev._setCumulative(CAP, 100 + h, T0 + h * HOUR);
  assert.strictEqual(dev.getCapabilityValue(CAP), 8170, 're-anchored early');

  await dev._setCumulative(CAP, 125, T0 + 25 * HOUR);
  assert.strictEqual(dev.getCapabilityValue(CAP), 125,
    'the clock restarted on each new low reading, so it would never re-anchor');
});

test('a dip that heals resets the patience, so two dips never add up to a re-anchor', async () => {
  const dev = makeDevice();
  await dev._setCumulative(CAP, 8170, T0);
  await dev._setCumulative(CAP, 8149, T0 + 4 * HOUR);      // dip one
  await dev._setCumulative(CAP, 8170, T0 + 4.5 * HOUR);    // healed
  await dev._setCumulative(CAP, 8149, T0 + 24 * HOUR);     // dip two, next night
  // 23 h into dip two, 43 h after dip one: only the healed-and-restarted clock keeps this
  // below a day.
  await dev._setCumulative(CAP, 8149, T0 + 47 * HOUR);

  assert.strictEqual(dev.getCapabilityValue(CAP), 8170, 'the two dips were counted together');
});

test('the night of 30 September, replayed from the field log, hands Homey nothing', async () => {
  // e985ff15, Jamesquare78, times local. In 1.2.261 the evening sag at 19:28 started the
  // six-hour clock, it ran out at 01:28 inside the rollover dip, the guard re-anchored on
  // 8207.27 and fifteen minutes later passed the recovery to 8221.46 — 14.19 kWh of solar at
  // a quarter to two in the morning.
  const dev = makeDevice();
  const at = (hh, mm, dayOffset = 0) => T0 + dayOffset * 24 * HOUR + hh * HOUR + mm * 60_000;

  await dev._setCumulative(CAP, 8221.97, at(19, 0));            // evening, written
  const evening = dev.getCapabilityValue(CAP);
  await dev._setCumulative(CAP, 8221.91, at(19, 28));           // the sag starts the clock
  await dev._setCumulative(CAP, 8207.27, at(1, 28, 1));         // six hours later: mid-dip
  await dev._setCumulative(CAP, 8207.26, at(1, 38, 1));
  await dev._setCumulative(CAP, 8221.46, at(1, 43, 1));         // recovered
  await dev._setCumulative(CAP, 8221.45, at(1, 48, 1));

  const written = Object.values(dev.values);
  assert.ok(!written.includes(8207.27), 're-anchored on the bottom of the dip');
  assert.strictEqual(dev.getCapabilityValue(CAP) - evening, 0,
    `Homey would have booked ${(dev.getCapabilityValue(CAP) - evening).toFixed(2)} kWh at night`);
});

// ── across a restart ────────────────────────────────────────────────────────────

test('the high-water mark survives a restart', async () => {
  // Without it, the first poll after an app update would accept whatever the source says —
  // and app updates land at all hours, including inside the dip.
  const dev = makeDevice();
  await dev._setCumulative(CAP, 8170, T0);
  assert.strictEqual(dev.store[HIGH_KEY], 8170);

  const afterRestart = makeDevice({ store: dev.store });
  await afterRestart._setCumulative(CAP, 8149, T0 + HOUR);

  assert.strictEqual(afterRestart.getCapabilityValue(CAP), null, 'wrote the dip after a restart');
});

test('a device with no stored mark takes the first reading as the mark', async () => {
  const dev = makeDevice();
  await dev._setCumulative(CAP, 8149, T0);
  assert.strictEqual(dev.getCapabilityValue(CAP), 8149, 'the very first reading was refused');
  assert.strictEqual(dev.store[HIGH_KEY], 8149);
});

// ── the ordinary cases _set already covers ──────────────────────────────────────

test('null and nonsense are skipped rather than written', async () => {
  const dev = makeDevice();
  await dev._setCumulative(CAP, 8170, T0);
  for (const bad of [null, undefined, NaN, Infinity, 'lots']) {
    await dev._setCumulative(CAP, bad, T0 + HOUR);
  }
  assert.strictEqual(dev.getCapabilityValue(CAP), 8170);
  assert.strictEqual(dev.writes, 1);
});

test('a capability the device does not have is left alone', async () => {
  const dev = makeDevice({ caps: [] });
  await dev._setCumulative(CAP, 8170, T0);
  assert.strictEqual(dev.writes, 0);
  assert.strictEqual(dev.store[HIGH_KEY], undefined, 'stored a mark for a capability it has not got');
});

test('an unchanged reading costs no write', async () => {
  const dev = makeDevice();
  await dev._setCumulative(CAP, 8170, T0);
  await dev._setCumulative(CAP, 8170, T0 + HOUR);
  await dev._setCumulative(CAP, 8170, T0 + 2 * HOUR);
  assert.strictEqual(dev.writes, 1);
});

// ── every driver that feeds Homey's solar figure goes through it ────────────────

test('the drivers reading the station total use the guard, not the bare _set', async () => {
  // The two that read stationKpi.totalEnergy, plus the kiosk, which keeps its own _set and
  // is handed _setCumulative on its own. A future driver added without this is the same bug
  // again on a different tile.
  const fs   = require('fs');
  const path = require('path');
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', 'drivers', p, 'device.js'), 'utf8');

  // Since 1.2.262 the OpenAPI inverter does not hand the station total to Homey at all; it
  // goes through _writePvMeter, which writes the generation meter through _setCumulative.
  // test/pv-meter.test.js covers what that meter does — here only that nothing bypasses it.
  const inverter = read('sun2000_openapi_fusionsolar');
  assert.ok(/await this\._writePvMeter\(/.test(inverter),
    'the OpenAPI inverter no longer goes through its generation meter');
  assert.ok(!/_set(Optional|Cumulative)?\('meter_power\.pv_total'/.test(inverter),
    'something writes meter_power.pv_total directly, around the generation meter');
  assert.ok(/this\._setCumulative\(CAP,/.test(inverter),
    'the generation meter writes without the guard');

  const solar = read('isitepower_solar_openapi_fusionsolar');
  assert.ok(/_setCumulative\('meter_power'/.test(solar),
    'the iSitePower solar meter reads the same station total without the guard');
  // The original claim, verbatim. The replacement comment quotes it in order to correct it,
  // so matching on "never resets" alone would fail against the fix — the same mistake this
  // repo has made before with a test that found its own comment.
  assert.ok(!/real Huawei counter, never resets/.test(solar),
    'the comment still asserts the counter never resets — issue #34 measured it doing exactly that');

  const kiosk = read('fusionsolar_kiosk');
  assert.ok(/_setCumulative\('meter_power'/.test(kiosk), 'the kiosk counter is unguarded');
  assert.ok(/_setCumulative: require\('\.\.\/\.\.\/lib\/capability-set'\)\._setCumulative/.test(kiosk),
    'the kiosk has no _setCumulative to call');
});
