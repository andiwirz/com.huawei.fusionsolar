'use strict';

// Flow conditions and the fault trigger for the OCPP charger. Run: node --test
//
// The driver had ten triggers, eleven actions and no conditions — alone among the drivers
// in this app, which have twenty-two between them. A flow could command the charger and ask
// it nothing. "Is the charger online" was the one most missed: every one of those eleven
// actions fails on an offline charger, and there was no way to check first.
//
// The fault trigger closes the other gap. Every StatusNotification carries an errorCode,
// and it went no further than a log line. A fault did reach a flow, as state "error" on the
// state-changed trigger, but WHICH fault did not — a ground fault and an over-temperature
// shutdown looked identical to anyone building an alert.

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

const APP  = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8'));
const FLOW = APP.flow;
const SRC  = fs.readFileSync(
  path.join(__dirname, '..', 'drivers', 'smartcharger_ocpp', 'device.js'), 'utf8');

const CONDITIONS = [
  'ocpp_charger_is_online', 'ocpp_is_charging',
  'ocpp_car_is_plugged_in', 'ocpp_session_status_is',
];

// Collects the run listeners the driver registers, so each can be called with arguments.
function collectListeners() {
  const listeners = {};
  const d = Object.create(ChargerDevice.prototype);
  d.homey = {
    flow: {
      getConditionCard: (id) => ({
        registerRunListener: (fn) => { listeners[id] = fn; },
      }),
    },
  };
  d._registerFlowConditions();
  return listeners;
}

const LISTENERS = collectListeners();

// A stand-in for whichever charger the flow points at.
function device({ state = 'idle', raw = null, offline = false, sessionStatus = null } = {}) {
  return {
    chargerOffline: offline,
    _prevRawStatus: raw,
    _chargingState: () => state,
    _carPluggedIn: ChargerDevice.prototype._carPluggedIn,
    getCapabilityValue: () => sessionStatus,
  };
}

test('the charger has conditions at all, in every language', () => {
  for (const id of CONDITIONS) {
    const card = FLOW.conditions.find((c) => c.id === id);
    assert.ok(card, `${id} is missing from app.json`);
    for (const lang of ['en', 'de', 'nl']) {
      assert.strictEqual(typeof card.title[lang], 'string', `${id}: ${lang} title missing`);
      assert.match(card.title[lang], /!\{\{[^|]+\|[^}]+\}\}/,
        `${id}: ${lang} title has no is/is-not toggle, so it reads as a statement`);
    }
    assert.ok((card.args || []).some((a) => a.type === 'device'
      && String(a.filter).includes('smartcharger_ocpp')),
    `${id} is not scoped to the OCPP charger`);
  }
});

test('every condition is actually wired to a listener', () => {
  for (const id of CONDITIONS) {
    assert.strictEqual(typeof LISTENERS[id], 'function',
      `${id} exists as a card but nothing answers it — the flow would fail at runtime`);
  }
});

test('online asks the charger, and says no while it is offline', async () => {
  assert.strictEqual(await LISTENERS.ocpp_charger_is_online({ device: device({}) }), true);
  assert.strictEqual(
    await LISTENERS.ocpp_charger_is_online({ device: device({ offline: true }) }), false);
});

test('charging means current is flowing, not merely that a cable is in', async () => {
  const run = (state) => LISTENERS.ocpp_is_charging({ device: device({ state }) });
  assert.strictEqual(await run('charging'), true);
  assert.strictEqual(await run('connected'), false, 'a connected car counts as charging');
  assert.strictEqual(await run('idle'), false);
});

// Plugged in spans everything from the cable going in to it coming out.
test('plugged in covers waiting, charging and finished, and nothing else', async () => {
  const run = (state, raw = null) => LISTENERS.ocpp_car_is_plugged_in({ device: device({ state, raw }) });
  assert.strictEqual(await run('connected'), true, 'a car waiting to start is plugged in');
  assert.strictEqual(await run('charging'), true, 'a charging car is plugged in');
  assert.strictEqual(await run('idle', 'Available'), false);
  // Finishing maps to idle like an empty socket, but the cable is still in (1.2.287).
  assert.strictEqual(await run('idle', 'Finishing'), true, 'a finished car with the cable still in counts as unplugged');
  assert.strictEqual(await run('idle'), false);
  // A lost connection is not an empty socket — the charger simply stopped telling us.
  assert.strictEqual(await run('error'), false,
    'a fault is reported as a car being plugged in, which the charger never said');
});

test('the status condition compares against the value on the device', async () => {
  const run = (sessionStatus, status) =>
    LISTENERS.ocpp_session_status_is({ device: device({ sessionStatus }), status });
  assert.strictEqual(await run('fully_charged', 'fully_charged'), true);
  assert.strictEqual(await run('charging', 'fully_charged'), false);
});

// The dropdown has to offer values the capability can actually hold, or the condition is
// never true and nothing says why.
test('the status dropdown offers only values the device can report', () => {
  const card = FLOW.conditions.find((c) => c.id === 'ocpp_session_status_is');
  const arg  = card.args.find((a) => a.name === 'status');
  assert.ok(arg, 'the status argument is gone');
  const allowed = APP.capabilities.session_status.values.map((v) => v.id);
  for (const v of arg.values) {
    assert.ok(allowed.includes(v.id),
      `the dropdown offers "${v.id}", which session_status never holds`);
    for (const lang of ['en', 'de', 'nl']) {
      assert.strictEqual(typeof v.title[lang], 'string', `${v.id}: ${lang} title missing`);
    }
  }
  assert.match(card.titleFormatted.en, /\[\[status\]\]/,
    'the formatted title does not show which status was chosen');
});

// ─── The fault trigger ──────────────────────────────────────────────────────

function faultDevice() {
  const d = Object.create(ChargerDevice.prototype);
  d.fired = [];
  d.log = () => {};
  d.homey = {
    flow: {
      getDeviceTriggerCard: (id) => ({
        trigger: async (_dev, tokens) => { d.fired.push({ id, tokens }); },
      }),
    },
  };
  return d;
}

test('the fault trigger exists with the codes as tokens', () => {
  const card = FLOW.triggers.find((c) => c.id === 'ocpp_charger_fault');
  assert.ok(card, 'the fault trigger is missing from app.json');
  const tokens = (card.tokens || []).map((t) => t.name).sort();
  assert.deepStrictEqual(tokens, ['error_code', 'info', 'status', 'vendor_error_code'],
    'the error code is what the trigger exists for; without it this is the state-changed '
    + 'trigger again');
});

test('a healthy notification does not fire it', async () => {
  const d = faultDevice();
  d._fireFaultTrigger({ errorCode: 'NoError', status: 'Available' }, 'Available');
  d._fireFaultTrigger({ status: 'Charging' }, 'Charging'); // no errorCode at all
  assert.deepStrictEqual(d.fired, [],
    'NoError is the normal value on every healthy notification and must not alert');
});

test('a fault fires once, with what the charger said', async () => {
  const d = faultDevice();
  d._fireFaultTrigger({
    errorCode: 'GroundFailure', vendorErrorCode: 'E42', info: 'RCD tripped', status: 'Faulted',
  }, 'Faulted');
  assert.strictEqual(d.fired.length, 1);
  assert.deepStrictEqual(d.fired[0], {
    id: 'ocpp_charger_fault',
    tokens: {
      error_code: 'GroundFailure', vendor_error_code: 'E42',
      info: 'RCD tripped', status: 'Faulted',
    },
  });
});

// A faulted charger repeats its code on every status change until it clears. One alert is
// the point; one per notification is a reason to turn the flow off.
test('the same fault repeated does not alert again', async () => {
  const d = faultDevice();
  for (let i = 0; i < 3; i++) {
    d._fireFaultTrigger({ errorCode: 'HighTemperature', status: 'Faulted' }, 'Faulted');
  }
  assert.strictEqual(d.fired.length, 1, `it alerted ${d.fired.length} times for one fault`);
});

test('a different fault after the first still alerts', async () => {
  const d = faultDevice();
  d._fireFaultTrigger({ errorCode: 'HighTemperature', status: 'Faulted' }, 'Faulted');
  d._fireFaultTrigger({ errorCode: 'OverCurrentFailure', status: 'Faulted' }, 'Faulted');
  assert.strictEqual(d.fired.length, 2, 'a second, different fault was swallowed');
});

// Clearing has to reset the memory, or a fault that returns is never reported again.
test('a fault that clears and comes back alerts again', async () => {
  const d = faultDevice();
  d._fireFaultTrigger({ errorCode: 'GroundFailure', status: 'Faulted' }, 'Faulted');
  d._fireFaultTrigger({ errorCode: 'NoError', status: 'Available' }, 'Available');
  d._fireFaultTrigger({ errorCode: 'GroundFailure', status: 'Faulted' }, 'Faulted');
  assert.strictEqual(d.fired.length, 2,
    'the same fault returning after it cleared is treated as the old one');
});

// Registered once at startup alongside the actions, or none of the above runs.
test('the conditions are registered when the device starts', () => {
  assert.match(SRC, /this\._registerFlowConditions\(\);/,
    'the conditions are defined but never registered, so every one of them fails');
});
