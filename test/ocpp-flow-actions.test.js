'use strict';

// The OCPP charger's Flow actions and who is in control of its power. Run: node --test
//
// Two things closed here, both found by reading rather than by a field report.
//
// The eleven action cards called their methods on `this` and guarded with
// `if (args.device.id !== this.id) return;`. That is correct for one charger and silently
// wrong for two: Homey keeps only the LAST run listener registered on a card, and every
// device registers over the previous one. The survivor's guard then rejects every device
// but itself, so a Flow step aimed at the other charger does nothing — no error, no log,
// a step that looks like it succeeded.
//
// And target_power_mode was logged and otherwise ignored, which made Homey's mode picker
// decorative: it could read "Automatic" — device in control — while the app acted on every
// watt figure handed to it. Homey's documentation is explicit that values are ignored in
// that mode.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const Module = require('module');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  return origLoad.call(this, request, parent, isMain);
};
const ChargerDevice = require(path.join('..', 'drivers', 'smartcharger_ocpp', 'device.js'));
Module._load = origLoad;

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'drivers', 'smartcharger_ocpp', 'device.js'), 'utf8');
const APP = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8'));

const ACTION_IDS = APP.flow.actions
  .filter((c) => (c.args || []).some((a) => a.type === 'device'
    && String(a.filter).includes('smartcharger_ocpp')))
  .map((c) => c.id);

// Collects the action listeners, the way Homey would.
function collectActions() {
  const listeners = {};
  const d = Object.create(ChargerDevice.prototype);
  d.id = 'registering-device';
  d.homey = {
    flow: {
      getActionCard: (id) => ({ registerRunListener: (fn) => { listeners[id] = fn; } }),
    },
  };
  d._registerFlowActions();
  return listeners;
}

const ACTIONS = collectActions();

// A charger that records what was asked of it. Deliberately NOT the one that registered.
function otherCharger() {
  const calls = [];
  return {
    id: 'a-completely-different-charger',
    calls,
    setChargingLimit: async (...a) => { calls.push(['setChargingLimit', ...a]); },
    setChargingLimitFromCard: async (...a) => { calls.push(['setChargingLimitFromCard', ...a]); },
    startCharging:    async (...a) => { calls.push(['startCharging', ...a]); },
    stopCharging:     async (...a) => { calls.push(['stopCharging', ...a]); },
    pauseCharging:    async (...a) => { calls.push(['pauseCharging', ...a]); },
    resumeCharging:   async (...a) => { calls.push(['resumeCharging', ...a]); },
    releaseCharger:   async (...a) => { calls.push(['releaseCharger', ...a]); },
    rebootCharger:    async (...a) => { calls.push(['rebootCharger', ...a]); },
    chargeNow:        async (...a) => { calls.push(['chargeNow', ...a]); },
  };
}

test('every action card declared for this charger has a listener', () => {
  assert.ok(ACTION_IDS.length >= 11, `only ${ACTION_IDS.length} action cards found`);
  for (const id of ACTION_IDS) {
    assert.strictEqual(typeof ACTIONS[id], 'function',
      `${id} is declared in app.json but nothing answers it`);
  }
});

// The heart of it: the listener was registered by one device and is used on another.
test('an action reaches the charger the Flow names, not the one that registered', async () => {
  for (const id of ACTION_IDS) {
    const device = otherCharger();
    await ACTIONS[id]({ device, amperes: 16, phases: '3', type: 'Soft' });
    assert.strictEqual(device.calls.length, 1,
      `${id} did nothing for a charger other than the one that registered the listener — `
      + 'with two chargers paired, this Flow step would silently fail');
  }
});

test('no listener filters on the registering device any more', () => {
  const at = SRC.indexOf('  _registerFlowActions() {');
  const end = SRC.indexOf('\n  }\n', at);
  const body = SRC.slice(at, end);
  // The comment above the block explains the old guard, so only the code is examined.
  const code = body.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /args\.device\.id !== this\.id/,
    'the per-device guard is back, so only the last-registered charger can be acted on');
  assert.doesNotMatch(code, /await this\.(start|stop|pause|resume|set|charge|release|reboot)/,
    'a listener calls a method on `this` again instead of on the device the Flow names');
});

test('the arguments are passed through, not dropped', async () => {
  const d1 = otherCharger();
  await ACTIONS.ocpp_set_max_current({ device: d1, amperes: 12 });
  // Through setChargingLimitFromCard since 1.2.287, which turns 0 A into a pause.
  assert.deepStrictEqual(d1.calls, [['setChargingLimitFromCard', 12]]);

  const d2 = otherCharger();
  await ACTIONS.ocpp_start_charging_at_phase({ device: d2, amperes: 10, phases: '1' });
  assert.deepStrictEqual(d2.calls, [['startCharging', 10, 1]],
    'the phase count is not converted to a number, so the driver would compare a string');

  const d3 = otherCharger();
  await ACTIONS.ocpp_reboot_charger({ device: d3 });
  assert.deepStrictEqual(d3.calls, [['rebootCharger', 'Soft']],
    'a reboot without a type argument no longer defaults to Soft');
});

// ─── Who controls the power ─────────────────────────────────────────────────

test('a target power is ignored while the charger is in control', () => {
  const at = SRC.indexOf("['evcharger_charging', 'target_power', 'target_power_mode']");
  assert.ok(at > 0, 'the combined capability listener is gone');
  const body = SRC.slice(at, at + 2600);
  assert.match(body, /if \(effectiveMode !== 'homey'\)/,
    'the mode is read but not acted on, so Homey can show "Automatic" while the app '
    + 'follows every watt figure it is handed');
  assert.match(body, /target_power \$\{target_power\} W ignored/,
    'a target power dropped for the mode is dropped silently, and nobody can tell why '
    + 'the slider did nothing');
});

// The mode arrives with the value whenever Homey takes control — that is what the debounced
// multi-listener is for. So honouring the mode must not break the case that matters.
test('a value arriving together with homey mode is acted on', () => {
  const at = SRC.indexOf("const effectiveMode = target_power_mode");
  assert.ok(at > 0, 'the effective mode is no longer derived');
  assert.match(SRC.slice(at, at + 120), /target_power_mode \?\? previousMode \?\? 'homey'/,
    'the mode sent in this very call must win over the stored one, or Homey taking '
    + 'control would be ignored on the call that takes it');
});

// Stopping is the on/off switch, not a power target. A charger in its own control still
// has to obey a stop.
test('an explicit stop is obeyed in either mode', () => {
  const at = SRC.indexOf('// Explicit stop wins over everything else');
  assert.ok(at > 0, 'the explicit-stop branch is gone');
  const modeCheck = SRC.indexOf("if (effectiveMode !== 'homey')");
  assert.ok(modeCheck > at,
    'the mode check now sits before the stop branch, so a charger in device mode could '
    + 'not be stopped from Homey at all');
});
