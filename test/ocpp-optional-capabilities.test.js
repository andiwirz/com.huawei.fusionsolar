'use strict';

// The vehicle-battery tile can be switched off. Run: node --test
//
// A charger reports the car's state of charge only if the car sends it over OCPP, and many
// cars never do. The tile then reads "-" for the life of the device, which is not a fault
// and not information either — so it can be removed rather than explained away every time
// someone asks why it is empty.
//
// Opt-out rather than opt-in: a car that does report its charge should show it without
// anyone having to find a switch first, and a device paired before the switch existed keeps
// the tile it already has.

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

const APP = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8'));
const DRIVER = APP.drivers.find((d) => d.id === 'smartcharger_ocpp');

function fakeCharger(settings = {}) {
  const d = Object.create(ChargerDevice.prototype);
  d.caps = new Set(['vehicle_soc', 'measure_power']);
  d.settings = settings;
  d.added = [];
  d.removed = [];
  d.log = () => {};
  d.error = () => {};
  d.getSetting = (k) => d.settings[k];
  d.hasCapability = (c) => d.caps.has(c);
  d.addCapability = async (c) => { d.added.push(c); d.caps.add(c); };
  d.removeCapability = async (c) => { d.removed.push(c); d.caps.delete(c); };
  return d;
}

test('the setting exists on the driver, in every language', () => {
  // In a group since 1.2.271 — look through the groups, not just the top level.
  const flat = (list) => (list || []).flatMap((x) => (x.type === 'group' ? flat(x.children) : [x]));
  const s = flat(DRIVER.settings).find((x) => x.id === 'show_vehicle_soc');
  assert.ok(s, 'the switch is gone from the device settings');
  assert.strictEqual(s.type, 'checkbox');
  assert.strictEqual(s.value, true, 'the tile is hidden by default, so a car that does '
    + 'report its charge would show nothing until someone found the switch');
  for (const lang of ['en', 'de', 'nl']) {
    assert.strictEqual(typeof s.label[lang], 'string', `${lang}: label missing`);
    assert.strictEqual(typeof s.hint[lang], 'string', `${lang}: hint missing`);
  }
});

test('switching it off removes the tile', async () => {
  const d = fakeCharger({ show_vehicle_soc: false });
  await d._applyOptionalCapabilities();
  assert.ok(!d.caps.has('vehicle_soc'), 'the tile is still there after switching it off');
  assert.ok(d.caps.has('measure_power'), 'an unrelated capability was removed too');
});

test('switching it back on restores the tile', async () => {
  const d = fakeCharger({ show_vehicle_soc: false });
  await d._applyOptionalCapabilities();
  d.settings.show_vehicle_soc = true;
  await d._applyOptionalCapabilities();
  assert.ok(d.caps.has('vehicle_soc'), 'the tile does not come back');
});

// The device was paired before the setting existed, so the stored value is undefined. That
// must read as "keep it", not as "the user turned it off".
test('a device that has never seen the setting keeps its tile', async () => {
  const d = fakeCharger({});
  await d._applyOptionalCapabilities();
  assert.ok(d.caps.has('vehicle_soc'),
    'an unset setting removed a tile the owner never asked to lose');
});

// Homey persists settings only after onSettings resolves, so reading the stored value there
// gives the value before the save. The tile would then change one save late.
test('a change is applied from the new settings, not the stored ones', async () => {
  const d = fakeCharger({ show_vehicle_soc: true });
  await d._applyOptionalCapabilities({ show_vehicle_soc: false });
  assert.ok(!d.caps.has('vehicle_soc'),
    'the tile followed the stored value, so it changes one save behind the switch');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'drivers', 'smartcharger_ocpp', 'device.js'), 'utf8');
  assert.match(src, /await this\._applyOptionalCapabilities\(newSettings\);/,
    'onSettings no longer passes the new settings through');
});

// Startup has two jobs here, and they are not the same one. Checking only the end state
// lets either of them be deleted while the other covers up — which is exactly what a
// mutation run showed, so both are checked by what happens rather than by what is left.

// Job one: do not add what the switch says to leave out. Asserted on the calls, because
// adding and immediately removing it again lands on the right end state while writing to
// the device twice on every single start.
test('startup does not add a tile the switch turned off', async () => {
  const d = fakeCharger({ show_vehicle_soc: false });
  d.caps.delete('vehicle_soc');
  await d._ensureCapabilities();
  // Only this one. Startup legitimately adds every other capability the device is missing.
  assert.ok(!d.added.includes('vehicle_soc'),
    'the tile is added and then removed again on every start — right result, wrong route');
  assert.ok(!d.caps.has('vehicle_soc'),
    'the tile is added back on every start, so switching it off never sticks');
});

// Job two: take away what should no longer be there. This is the device that already has
// the tile — switched off while the app was down, or carried over from an older version.
test('startup removes a tile the switch turned off while it was already there', async () => {
  const d = fakeCharger({ show_vehicle_soc: false });
  assert.ok(d.caps.has('vehicle_soc'), 'precondition: the device starts with the tile');
  await d._ensureCapabilities();
  assert.deepStrictEqual(d.removed, ['vehicle_soc'],
    'a device that already had the tile keeps it forever, whatever the switch says');
});

test('startup still adds the tile when the switch is on', async () => {
  const d = fakeCharger({ show_vehicle_soc: true });
  d.caps.delete('vehicle_soc');
  await d._ensureCapabilities();
  assert.ok(d.caps.has('vehicle_soc'));
});

// The measurand stays requested either way. Removing SoC from MeterValuesSampledData to
// match the switch would risk the whole list — OCPP 1.6 has a charger reject all of it if
// one entry is unknown — and the list is not per-device anyway.
test('hiding the tile does not change what the charger is asked to sample', () => {
  const srv = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ocpp-server.js'), 'utf8');
  assert.match(srv, /MeterValuesSampledData[\s\S]{0,200}?SoC/,
    'SoC was dropped from the sampled list, which is a per-charger setting and not what '
    + 'this per-device switch is for');
});
