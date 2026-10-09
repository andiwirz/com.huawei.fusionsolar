'use strict';

// Four code faults the flow-card audit of 1.2.286 turned up (1.2.287).
//
//   1. "Set max charging current" promised that 0 A pauses, and refused it (6–32 A only). An
//      EMS stop sends 0 A, so a flow from "EMS wants to set charger current" to this card
//      failed on every stop.
//   2. "Car is plugged in" was false while the charger reported Finishing, cable still in.
//   3. The EMS mode capability had no solar_aircon — the EMS sets it, and the write failed —
//      and the "EMS is in mode" condition offered neither it nor instant_ev.
//   4. The EMMA grid-charge card allowed 100 kW where register 40002 takes 50; the OCPP
//      offline watchdog read the server-wide last message, so with two chargers a silent one
//      looked online; five conditions answered for the device that registered them last.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const app  = require(path.join(ROOT, 'app.json'));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  return origLoad.call(this, request, parent, isMain);
};
const Charger    = require(path.join(ROOT, 'drivers', 'smartcharger_ocpp', 'device.js'));
const OcppServer = require(path.join(ROOT, 'lib', 'ocpp-server.js'));
const { MODES }  = require(path.join(ROOT, 'lib', 'ems', 'constants.js'));
Module._load = origLoad;

// ── 1. 0 A pauses, and the next current resumes what 0 A paused ─────────────────

function charger({ txn = 'tx1', stitched = null } = {}) {
  const d = Object.create(Charger.prototype);
  d.calls = [];
  d._txnId = txn;
  d.stitchedSession = stitched;
  d.log = () => {};
  d._getPhases = () => 3;
  d._validateProfileRequest = () => {};
  d._persistStitched = async () => { d.calls.push(['persist', { ...d.stitchedSession }]); };
  d.pauseCharging = async () => { d.calls.push(['pause']); d.stitchedSession = { paused: true, resumeAmps: 16 }; };
  d.resumeCharging = async (src) => { d.calls.push(['resume', src, d.stitchedSession.resumeAmps]); };
  d.setChargingLimit = async (a) => { d.calls.push(['limit', a]); };
  return d;
}

test('0 A pauses a running session and marks the pause as its own', async () => {
  const d = charger();
  await d.setChargingLimitFromCard(0);
  assert.deepStrictEqual(d.calls.map((c) => c[0]), ['pause', 'persist']);
  assert.strictEqual(d.stitchedSession.zeroAmpPause, true);
});

test('0 A with nothing running is not an error — an EMS stop with no car must not fail the flow', async () => {
  const d = charger({ txn: null });
  await d.setChargingLimitFromCard(0);
  assert.deepStrictEqual(d.calls, []);
});

test('the next current above 0 resumes a 0 A pause, at that current', async () => {
  const d = charger({ txn: null, stitched: { paused: true, zeroAmpPause: true, resumeAmps: 16 } });
  await d.setChargingLimitFromCard(10);
  assert.deepStrictEqual(d.calls, [['resume', 'user', 10]]);
});

test('a pause made by hand stays paused when a current is set', async () => {
  const d = charger({ txn: null, stitched: { paused: true, resumeAmps: 16 } });
  await d.setChargingLimitFromCard(10);
  assert.deepStrictEqual(d.calls, [['limit', 10]], 'a deliberate pause was undone by a limit card');
  // …and a 0 A arriving on top of it does not claim it either.
  const e = charger({ stitched: { paused: true, resumeAmps: 16 } });
  e.pauseCharging = async () => { e.calls.push(['pause']); };
  await e.setChargingLimitFromCard(0);
  assert.strictEqual(e.stitchedSession.zeroAmpPause, undefined);
});

test('1–5 A is still refused, also when it would resume', async () => {
  await assert.rejects(charger({ stitched: { paused: true, zeroAmpPause: true } }).setChargingLimitFromCard(4), /between 6 and 32/);
  const d = charger();
  d.setChargingLimit = Charger.prototype.setChargingLimit;
  await assert.rejects(d.setChargingLimitFromCard(5), /between 6 and 32/);
});

test('the card is wired to it, and its tooltip says so', () => {
  assert.match(read('drivers/smartcharger_ocpp/device.js'), /getActionCard\('ocpp_set_max_current'\)\s*\n\s*\.registerRunListener\(async \(args\) => args\.device\.setChargingLimitFromCard\(Number\(args\.amperes\)\)\)/);
  const c = app.flow.actions.find((x) => x.id === 'ocpp_set_max_current');
  assert.strictEqual(c.args.find((a) => a.name === 'amperes').min, 0, '0 has to stay selectable');
  for (const l of ['en', 'de', 'nl']) assert.match(c.hint[l], /0 A/, l);
});

// ── 2. Finishing is plugged in ────────────────────────────────────────────────────

test('Finishing counts as plugged in, Available does not', () => {
  const p = (state, raw) => Charger.prototype._carPluggedIn.call({ _chargingState: () => state, _prevRawStatus: raw });
  assert.strictEqual(p('idle', 'Finishing'), true);
  assert.strictEqual(p('idle', 'Available'), false);
  assert.strictEqual(p('error', 'Finishing'), false, 'an error state is not proof of a cable');
  assert.strictEqual(p('connected', 'SuspendedEV'), true);
});

// ── 3. every mode the EMS sets is a value its capability and condition know ───────────

test('every ems_mode the EMS can set is in the capability and in "EMS is in mode"', () => {
  const HISTORY_ONLY = new Set([MODES.EXPORT_LIMIT_ON, MODES.EXPORT_LIMIT_OFF]);
  const set  = Object.values(MODES).filter((m) => !HISTORY_ONLY.has(m));
  const cap  = app.capabilities.ems_mode.values.map((v) => v.id);
  const cond = app.flow.conditions.find((c) => c.id === 'ems_is_in_mode').args.find((a) => a.type === 'dropdown').values.map((v) => v.id);
  assert.deepStrictEqual(set.filter((m) => !cap.includes(m)), [], 'the capability write fails for these');
  assert.deepStrictEqual(set.filter((m) => !cond.includes(m)), [], 'the condition can never be true for these');
  assert.deepStrictEqual(cond, cap, 'the condition and the capability list the modes differently');
});

// ── 4. the smaller three ──────────────────────────────────────────────────────────

test('the EMMA grid-charge card stops at 50 kW, card and code', () => {
  const c = app.flow.actions.find((x) => x.id === 'luna2000_emma_set_max_grid_charge_power');
  assert.strictEqual(c.args.find((a) => a.name === 'power').max, 50);
  assert.match(read('drivers/luna2000_emma_modbus/device.js'), /const kw\s+= Math\.min\(50, Math\.max\(0, parseFloat\(power\) \|\| 0\)\);/);
});

test('each charger is timed by its own last message', () => {
  const s = new OcppServer({ log() {}, error() {} });
  s._onMessage('garage', null, [9]);                 // an unknown frame type still counts as heard
  const garageAt = s.lastMessageAtFor('garage');
  assert.ok(garageAt > 0);
  assert.strictEqual(s.lastMessageAtFor('carport'), null, 'a charger that never spoke borrowed another one\'s time');
  // The catch-all device ('') is timed by the charger that took its slot — also after it left.
  s._lastResolvedIds.set('', 'carport');
  s._onMessage('carport', null, [9]);
  assert.ok(s.lastMessageAtFor('') > 0);
  assert.match(read('drivers/smartcharger_ocpp/device.js'), /server\.lastMessageAtFor\(this\.getSetting\('station_id'\) \|\| ''\)/);
  assert.doesNotMatch(read('drivers/smartcharger_ocpp/device.js'), /server\.lastMessageAt\b(?!For)/);
});

test('the five conditions answer for the device the flow picked', () => {
  const CASES = [
    ['drivers/luna2000_modbus/device.js', ['luna2000_working_mode_is', 'luna2000_excess_pv_is', 'luna2000_remote_mode_is']],
    ['drivers/luna2000_emma_modbus/device.js', ['luna2000_working_mode_is', 'luna2000_excess_pv_is']],
    ['drivers/sun2000_modbus/device.js', ['sun2000_status_is']],
    ['drivers/dtsu666_modbus/device.js', ['dtsu666_meter_status_is']],
  ];
  for (const [file, ids] of CASES) {
    const src = read(file);
    for (const id of ids) {
      const m = src.match(new RegExp(`getConditionCard\\('${id}'\\)\\s*\\n\\s*\\.registerRunListener\\(([^\\n]*)\\);`));
      assert.ok(m, `${file}: ${id} not found`);
      assert.match(m[1], /args\.device\.getCapabilityValue/, `${file}: ${id} still asks this`);
    }
  }
});
