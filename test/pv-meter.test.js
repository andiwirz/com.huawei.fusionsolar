'use strict';

// The PV generation meter Homey Energy reads (sun2000_openapi_fusionsolar, _writePvMeter).
//
// Issue #34, second round. 1.2.261 put a high-water guard on the station total, and the field
// log e985ff15 showed in five nights why no guard can make that number a meter. FusionSolar's
// production figure is a balance — AC yield + battery charge − battery discharge — so it sinks
// every evening, dips by a day at the rollover, and is re-settled after midnight, sometimes
// above the evening figure:
//
//     02 Oct 18:54   8254.39   evening, written
//     03 Oct 00:04   8256.12   re-settled ABOVE it — passes any high-water guard: +1.73 kWh
//     03 Oct 00:09   8253.81   and down again
//
// Since 1.2.262 the meter is seeded from what Homey last saw and then moves only with the
// inverter's own DC counter, mppt_total_cap — and only while the panels produce.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  return origLoad.call(this, request, parent, isMain);
};
const InverterDevice = require(path.join('..', 'drivers', 'sun2000_openapi_fusionsolar', 'device.js'));
Module._load = origLoad;

const CAP  = 'meter_power.pv_total';
const T0   = 1_770_000_000_000;
const MIN  = 60_000;
const HOUR = 60 * MIN;

// Real _set and _setCumulative from the prototype; a store, capability values and a log.
function makeInverter({ store = {}, values = {} } = {}) {
  const d = Object.create(InverterDevice.prototype);
  d.values = { ...values };
  d.store  = store;
  d.logs   = [];
  d.caps   = new Set([CAP, 'measure_power', 'measure_power.mppt', 'measure_power.active_power',
    'meter_power.inv_total', 'meter_power.inv_daily']);
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = () => {};
  d.getName = () => 'Inverter';
  d.getSetting = () => true;
  d.hasCapability = (c) => d.caps.has(c);
  d.addCapability = async (c) => { d.caps.add(c); };
  d.getCapabilityValue = (c) => (c in d.values ? d.values[c] : null);
  d.setCapabilityValue = async (c, v) => { d.values[c] = v; };
  d.getStoreValue = (k) => d.store[k];
  d.setStoreValue = async (k, v) => { d.store[k] = v; };
  d._trackPower = () => {};
  d.homey = {
    notifications: { createNotification: async () => {} },
    flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
  };
  return d;
}

// One poll's worth for the meter: the station total, the DC counter and the PV power.
const tick = (d, now, { station = null, mppt = null, powerW = 0 } = {}) =>
  d._writePvMeter({ stationTotal: station, mpptTotal: mppt, mpptPowerW: powerW, now });

const shown = (d) => d.getCapabilityValue(CAP);
const near  = (a, b) => Math.abs(a - b) < 1e-6;

// A device the way 1.2.261 left Jamesquare's: the guarded station total written, its mark
// in the store.
const after1261 = () => makeInverter({
  store:  { [`cumulative_high.${CAP}`]: 8253.85 },
  values: { [CAP]: 8253.85 },
});

// ── the switch ──────────────────────────────────────────────────────────────────

test('switching what drives the meter is not itself a step Homey could book', async () => {
  // The DC counter is a different number altogether — 9100 against 8253.85 here. Writing it
  // straight in would hand Homey hundreds of kWh in one poll.
  const d = after1261();
  await tick(d, T0, { station: 8253.85, mppt: 9100, powerW: 0 });

  assert.strictEqual(shown(d), 8253.85, 'the meter jumped when its source changed');
  assert.ok(d.logs.some((l) => l.includes('continuing from 8253.85')),
    'the switch is not visible in the log');
});

test('the anchor is what Homey last saw, not what the station says right now', async () => {
  // Found by the mutation probe. Had the update landed at 00:04 on 3 October, the station
  // stood at 8256.12 while Homey had last been shown 8253.85 — anchoring on the station
  // would have handed over the very 2.27 kWh the switch exists to stop.
  const d = after1261();
  await tick(d, T0, { station: 8256.12, mppt: 9100, powerW: 0 });

  assert.strictEqual(shown(d), 8253.85,
    `anchored on the station: Homey would book ${(shown(d) - 8253.85).toFixed(2)} kWh`);
});

test('daylight moves the meter exactly as far as the DC counter moves', async () => {
  const d = after1261();
  await tick(d, T0,           { station: 8253.85, mppt: 9100.00, powerW: 1200 });
  await tick(d, T0 + 5 * MIN, { station: 8254.40, mppt: 9100.50, powerW: 3000 });
  await tick(d, T0 + 10 * MIN, { station: 8255.30, mppt: 9101.20, powerW: 3400 });

  assert.ok(near(shown(d), 8255.05), `expected 8255.05, got ${shown(d)}`);
});

// ── the night that started round two ────────────────────────────────────────────

test('2–3 October: the station re-settles above the evening, and the meter does not move', async () => {
  // e985ff15, times local. The DC counter stands still all night — the panels are dark.
  const d = after1261();
  const at = (hh, mm, day = 0) => T0 + day * 24 * HOUR + hh * HOUR + mm * MIN;
  const MPPT = 9100;

  await tick(d, at(18, 54), { station: 8254.39, mppt: MPPT, powerW: 0 });
  const evening = shown(d);
  for (let m = 59; m < 60 * 6; m += 5) {          // the evening, every five minutes
    await tick(d, at(18, 54) + m * MIN, { station: 8254.30, mppt: MPPT, powerW: 0 });
  }
  await tick(d, at(0, 4, 1),  { station: 8256.12, mppt: MPPT, powerW: 0 });   // re-settled above
  await tick(d, at(0, 9, 1),  { station: 8253.81, mppt: MPPT, powerW: 0 });   // and down
  await tick(d, at(6, 9, 1),  { station: 8253.85, mppt: MPPT, powerW: 0 });

  assert.strictEqual(shown(d) - evening, 0,
    `Homey would have booked ${(shown(d) - evening).toFixed(2)} kWh before sunrise`);
});

// ── the darkness gate ───────────────────────────────────────────────────────────

test('a DC counter that moves in the dark is not counted, and says so', async () => {
  // The assumption under all of this is that it never happens. If it does on some plant,
  // this line in a field log is how we learn it.
  const d = after1261();
  await tick(d, T0,            { mppt: 9100.0, powerW: 0 });
  await tick(d, T0 + 5 * MIN,  { mppt: 9100.4, powerW: 0 });

  assert.strictEqual(shown(d), 8253.85);
  assert.ok(d.logs.some((l) => l.includes('+0.40 kWh while the panels were dark')));
});

test("dusk: the counter's last step lands on a 0 W poll and still counts", async () => {
  // The poll before still saw production; that step is the day's last daylight.
  const d = after1261();
  await tick(d, T0,           { mppt: 9100.00, powerW: 800 });
  await tick(d, T0 + 5 * MIN, { mppt: 9100.05, powerW: 0 });

  assert.ok(near(shown(d), 8253.90), `the last five minutes of daylight were dropped: ${shown(d)}`);
});

test('two dark polls in a row: the second step is not daylight any more', async () => {
  const d = after1261();
  await tick(d, T0,            { mppt: 9100.00, powerW: 800 });
  await tick(d, T0 + 5 * MIN,  { mppt: 9100.05, powerW: 0 });   // dusk, counted
  await tick(d, T0 + 10 * MIN, { mppt: 9100.30, powerW: 0 });   // dark, absorbed

  assert.ok(near(shown(d), 8253.90));
});

test('after an outage the gate is lifted: what the counter gained meanwhile is real', async () => {
  // App down all afternoon, back after sunset. It is a lifetime counter, so the afternoon's
  // production is in it — counted late is better than lost.
  const store = {};
  const d1 = makeInverter({ store, values: { [CAP]: 8253.85 } });
  store[`cumulative_high.${CAP}`] = 8253.85;
  await tick(d1, T0, { mppt: 9100, powerW: 2500 });

  const d2 = makeInverter({ store, values: { [CAP]: shown(d1) } });   // restarted, at night
  await tick(d2, T0 + 6 * HOUR, { mppt: 9112, powerW: 0 });

  assert.ok(near(shown(d2), 8265.85), `the afternoon was lost: ${shown(d2)}`);
});

// ── counter anomalies ───────────────────────────────────────────────────────────

test('a counter that runs backwards re-bases instead of subtracting or recounting', async () => {
  const d = after1261();
  await tick(d, T0,            { mppt: 9100, powerW: 2000 });
  await tick(d, T0 + 5 * MIN,  { mppt: 9090, powerW: 2000 });   // backwards
  await tick(d, T0 + 10 * MIN, { mppt: 9091, powerW: 2000 });   // +1 from the new base

  assert.ok(near(shown(d), 8254.85), `got ${shown(d)}`);
  assert.ok(d.logs.some((l) => l.includes('went backwards')));
});

test('a real step on a poll seconds after the last one is not mistaken for a swap', async () => {
  // Found by the integration test below: two polls milliseconds apart shrank the plausibility
  // window to nothing, and 0.7 kWh of real production was re-based away. The cloud updates
  // the counter on its own schedule, so the step can be minutes of production that only
  // happened to arrive late.
  const d = after1261();
  await tick(d, T0,         { mppt: 9100.0, powerW: 3000 });
  await tick(d, T0 + 2000,  { mppt: 9100.7, powerW: 3000 });

  assert.ok(near(shown(d), 8254.55), `a real step was re-based away: ${shown(d)}`);
});

test('a jump no plant could produce is a counter swap, not sunshine', async () => {
  const d = after1261();
  await tick(d, T0,           { mppt: 9100, powerW: 2000 });
  await tick(d, T0 + 5 * MIN, { mppt: 52_000, powerW: 2000 });  // a different inverter

  assert.strictEqual(shown(d), 8253.85, 'a counter swap was booked as generation');
  assert.ok(d.logs.some((l) => l.includes('counter swap')));
});

// ── without a DC counter ────────────────────────────────────────────────────────

test('an inverter that never reports one keeps the guarded station total', async () => {
  // 1.2.261 behaviour, now with the day-long re-anchor: the rollover dip never reaches Homey.
  const d = makeInverter();
  await tick(d, T0,                { station: 8170 });
  await tick(d, T0 + 1 * HOUR,     { station: 8149 });
  await tick(d, T0 + 1.5 * HOUR,   { station: 8170 });

  assert.strictEqual(shown(d), 8170);
  assert.ok(!Object.values(d.values).includes(8149));
});

test('once the DC counter has been seen, a poll without it changes nothing', async () => {
  // Falling back for one poll would add the station's movement on top of the counter's.
  const d = after1261();
  await tick(d, T0,           { station: 8253.85, mppt: 9100, powerW: 2000 });
  await tick(d, T0 + 5 * MIN, { station: 8260.00, mppt: null, powerW: 2000 });

  assert.strictEqual(shown(d), 8253.85);
});

test('a plant with neither figure is left alone, store and all', async () => {
  // Not touching the store at all, not merely not writing to it: several test fakes for
  // this driver have no store, and a real device with nothing to report has no business
  // reading one either. Found by the mutation probe, which only checked writes before.
  const d = makeInverter();
  let reads = 0;
  const realGet = d.getStoreValue;
  d.getStoreValue = (k) => { reads += 1; return realGet(k); };

  await tick(d, T0, { station: null, mppt: null });

  assert.strictEqual(reads, 0, `read the store ${reads} times with nothing to write`);
  assert.deepStrictEqual(d.store, {});
  assert.strictEqual(shown(d), null);
});

// ── across a restart ────────────────────────────────────────────────────────────

test('the meter, its source and its baseline survive a restart', async () => {
  const store = { [`cumulative_high.${CAP}`]: 8253.85 };
  const d1 = makeInverter({ store, values: { [CAP]: 8253.85 } });
  await tick(d1, T0,           { mppt: 9100.0, powerW: 2000 });
  await tick(d1, T0 + 5 * MIN, { mppt: 9100.5, powerW: 2000 });

  const d2 = makeInverter({ store, values: { [CAP]: shown(d1) } });
  await tick(d2, T0 + 10 * MIN, { station: 8999, mppt: 9101.0, powerW: 2000 });

  assert.ok(near(shown(d2), 8254.85), `restart lost the thread: ${shown(d2)}`);
  assert.ok(!d2.logs.some((l) => l.includes('continuing from')), 'the switch was replayed after a restart');
});

// ── the stall warning ───────────────────────────────────────────────────────────

test('daylight with a counter that never moves is reported once', async () => {
  // Homey Energy would show no solar at all. Said loudly rather than guessed around.
  const d = after1261();
  for (let m = 0; m <= 4 * 60; m += 5) await tick(d, T0 + m * MIN, { mppt: 9100, powerW: 2500 });

  const warned = d.logs.filter((l) => l.includes('has not moved'));
  assert.strictEqual(warned.length, 1, `warned ${warned.length} times`);
});

test('a night with a still counter is not a stall', async () => {
  const d = after1261();
  for (let m = 0; m <= 8 * 60; m += 5) await tick(d, T0 + m * MIN, { mppt: 9100, powerW: 0 });
  assert.ok(!d.logs.some((l) => l.includes('has not moved')));
});

// ── through the real poll ───────────────────────────────────────────────────────

const STATION = { dailyEnergy: 0, totalEnergy: 8253.85, healthState: 3 };
const pollWith = (d, inverter, station = STATION) =>
  d.onPollData({ stationKpi: station, kpiByType: { 38: [inverter] } });

test('onPollData feeds the meter from mppt_total_cap, not from the station total', async () => {
  const d = after1261();
  await pollWith(d, { mppt_power: 2.0, mppt_total_cap: 9100.0, active_power: 1.9, total_cap: 9000 });
  await pollWith(d, { mppt_power: 3.0, mppt_total_cap: 9100.7, active_power: 2.9, total_cap: 9000.6 },
    { ...STATION, totalEnergy: 8300 });   // the station moving on its own must not matter

  assert.ok(near(shown(d), 8254.55), `got ${shown(d)}`);
});

test('an mppt_total_cap of zero is a field the inverter leaves empty, not a counter', async () => {
  // Taken at face value it would freeze Homey's solar figure for good.
  const d = makeInverter();
  await pollWith(d, { mppt_power: 2.0, mppt_total_cap: 0, active_power: 1.9 });

  assert.strictEqual(shown(d), 8253.85, 'did not fall back to the station total');
  assert.notStrictEqual(d.store['pvmeter.source'], 'mppt', 'adopted an empty field as the counter');
});
