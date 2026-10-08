'use strict';

// The feed-in mode cannot be changed from the device tile (sun2000_modbus, issue #35).
//
// Reported by gsommer, whose house connection depends on a 5 kW feed-in limit: opening the
// inverter in the Homey app reset register 47415 to Unlimited. His log from 1.2.262:
//
//     11:53:41  Write start  [activepower_controlmode → reg 47415] value=0
//     11:53:48  Write OK     [activepower_controlmode → reg 47415]
//
// No flow, no EMS. The tile's picker is a scroll wheel with Unlimited at the top, on a screen
// people scroll through, and every movement of it went straight to the inverter.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const Module = require('module');

// Load the driver with Homey stubbed and the Modbus writes recorded instead of sent.
const writes = [];
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  if (request === '../../lib/modbus-client') {
    const real = origLoad.call(this, request, parent, isMain);
    return {
      ...real,
      writeModbusRegister: async (host, port, unit, reg, value) => { writes.push({ reg, value }); },
      writeModbusU32:      async (host, port, unit, reg, value) => { writes.push({ reg, value, u32: true }); },
    };
  }
  return origLoad.call(this, request, parent, isMain);
};
const InverterDevice = require(path.join('..', 'drivers', 'sun2000_modbus', 'device.js'));
Module._load = origLoad;

const app    = require(path.join('..', 'app.json'));
const source = fs.readFileSync(path.join(__dirname, '..', 'drivers', 'sun2000_modbus', 'device.js'), 'utf8');

// A device with the flow surface recorded: every card's run listener, by id, and every
// capability listener anyone tries to register.
function makeDevice() {
  const d = Object.create(InverterDevice.prototype);
  d.runListeners = {};
  d.capabilityListeners = [];
  const card = (id) => ({
    registerRunListener(fn) { d.runListeners[id] = fn; return this; },
    registerArgumentAutocompleteListener() { return this; },
    trigger: async () => {},
  });
  d.homey = {
    flow: { getActionCard: card, getConditionCard: card, getDeviceTriggerCard: card, getTriggerCard: card },
    setTimeout: () => null, clearTimeout: () => {}, setInterval: () => null, clearInterval: () => {},
  };
  d.registerCapabilityListener = (cap) => { d.capabilityListeners.push(cap); };
  d.getSetting = (k) => ({ address: '192.0.2.1', port: 502, modbus_id: 1 }[k]);
  d.setSettings = async () => {};
  d.getCapabilityValue = () => null;
  d.hasCapability = () => true;
  d._set = async () => {};
  d.log = () => {};
  d.error = () => {};
  return d;
}

const settle = () => new Promise((r) => setImmediate(r));

// ── the tile ────────────────────────────────────────────────────────────────────

test('the manifest shows the feed-in mode and does not offer to change it', () => {
  const cap = app.capabilities.activepower_controlmode;
  assert.strictEqual(cap.setable, false, 'the device tile can write to register 47415 again');
  assert.strictEqual(cap.uiComponent, 'sensor',
    'still rendered as a picker — a scroll wheel on a screen people scroll through');
});

test('no capability listener writes the feed-in mode, however the tile is rendered', () => {
  // setable: false stops Homey offering the picker. This is the second lock: a Homey app
  // still drawing the old picker from a cached definition has nothing to write through.
  assert.ok(!/registerCapabilityListener\s*\(/.test(source),
    'a capability listener is registered on the inverter again');
  assert.ok(!/this\._registerControlListeners\s*\(\s*\)/.test(source),
    'onInit calls the listener registration again');
  assert.strictEqual(typeof InverterDevice.prototype._registerControlListeners, 'undefined',
    'the method that wrote the tile value into 47415 is back');
});

test('registering the flow cards registers no capability listener on the side', () => {
  const d = makeDevice();
  d._registerFlowActions();
  assert.deepStrictEqual(d.capabilityListeners, []);
});

// ── the deliberate way still works ──────────────────────────────────────────────

test('"Set active power mode" still writes register 47415', async () => {
  // Changing the mode is meant to stay possible — by someone who means it, in a flow that
  // says what it does.
  writes.length = 0;
  const d = makeDevice();
  d._registerFlowActions();
  assert.ok(d.runListeners.sun2000_set_active_power_mode, 'the flow card is gone');

  await d.runListeners.sun2000_set_active_power_mode({ mode: '6' });
  await settle();

  assert.deepStrictEqual(writes.filter((w) => w.reg === 47415), [{ reg: 47415, value: 6 }]);
});

test('the zero-export cards still write register 47415 as well', async () => {
  writes.length = 0;
  const d = makeDevice();
  d._registerFlowActions();

  await d.runListeners.sun2000_enable_zero_export({});
  await settle();
  assert.ok(writes.some((w) => w.reg === 47415 && w.value === 6), 'enable zero export no longer writes');
});

test('the poll still shows what the inverter reports', () => {
  // Read-only is not blind: the tile must still say which mode the inverter is in.
  assert.ok(/this\._set\('activepower_controlmode', toEnum\(ctrl\.activePowerControlMode\)\)/.test(source),
    'the poll no longer updates the displayed feed-in mode');
});
