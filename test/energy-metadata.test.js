'use strict';

// What each driver tells Homey Energy about itself. Run: node --test
//
// Reported in issue #25 with a clean measurement, taken after sunset with no solar at all:
//
//   FusionSolar   PV 0 W   battery discharging 2.445 kW   grid import 0.152 kW
//                 house 2.597 kW   (2.445 + 0.152 = 2.597, internally consistent)
//   Homey devices inverter 0 W   battery -2.39 kW   grid +40 W
//   Homey Energy  40 W total
//
// Every individual device read correctly, including the battery's negative sign. Only the
// total was wrong, and it was wrong by exactly the battery: Homey Energy showed the grid
// figure and nothing else, as though the battery were not part of the house at all.
//
// The difference between that battery and the three others in this app was in the manifest,
// not the code. All four declare homeBattery: true; his was the only one that declared it
// without also naming the cumulative charged/discharged meters — even though the driver has
// been filling those capabilities from the API all along.
//
// Whether Homey's aggregation strictly requires them is not something this repository can
// show. What it can show is that declaring a home battery without them is inconsistent with
// every other battery here, and that is what these tests hold.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const APP = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8'));

const homeBatteries = APP.drivers.filter((d) => (d.energy || {}).homeBattery === true);

test('there are home batteries to check at all', () => {
  assert.ok(homeBatteries.length >= 3,
    `only ${homeBatteries.length} driver(s) declare homeBattery — the rest lost the flag`);
});

test('a home battery names its cumulative charged and discharged meters', () => {
  for (const d of homeBatteries) {
    assert.ok(d.energy.meterPowerImportedCapability,
      `${d.id} is a home battery with no meterPowerImportedCapability, so the energy it `
      + 'takes in is never accounted for');
    assert.ok(d.energy.meterPowerExportedCapability,
      `${d.id} is a home battery with no meterPowerExportedCapability, so the energy it `
      + 'gives back to the house is never accounted for — which is exactly the report '
      + 'this test exists for');
  }
});

// A reference to a capability the driver does not have is a reference to nothing.
test('every capability named in an energy block is one the driver actually has', () => {
  const FIELDS = [
    'meterPowerImportedCapability',
    'meterPowerExportedCapability',
    'cumulativeImportedCapability',
    'cumulativeExportedCapability',
  ];
  for (const d of APP.drivers) {
    const energy = d.energy || {};
    const caps = d.capabilities || [];
    for (const field of FIELDS) {
      const cap = energy[field];
      if (!cap) continue;
      assert.ok(caps.includes(cap),
        `${d.id}.energy.${field} points at "${cap}", which is not in that driver's `
        + 'capabilities — Homey has nothing to read');
    }
  }
});

// The two that his battery was missing are filled by the driver from the FusionSolar API.
// The data was there the whole time; only the declaration was not.
test('the OpenAPI battery fills the meters it now declares', () => {
  const d = APP.drivers.find((x) => x.id === 'luna2000_openapi_fusionsolar');
  assert.ok(d, 'the OpenAPI battery driver is gone');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'drivers', 'luna2000_openapi_fusionsolar', 'device.js'), 'utf8');
  for (const [cap, field] of [
    ['meter_power.charged', 'total_charged_energy'],
    ['meter_power.discharged', 'total_discharged_energy'],
  ]) {
    assert.ok(d.capabilities.includes(cap), `${cap} is no longer declared`);
    assert.match(src, new RegExp(`_set\\('${cap.replace('.', '\\.')}',\\s*sumKwh\\('${field}'\\)\\)`),
      `${cap} is declared but nothing writes it, so the meter would sit at zero for ever`);
  }
});

// The sign convention the reporter confirmed over several charge and discharge states:
// positive is charging, negative is discharging. Homey expects that of a home battery, and
// getting it backwards would swap the battery's contribution to the household total.
test('battery power keeps the sign convention the field data confirmed', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'drivers', 'luna2000_openapi_fusionsolar', 'device.js'), 'utf8');
  assert.match(src, /ch_discharge_power'\); \/\/ \+ = charging, − = discharging/,
    'the sign convention note is gone; it is the thing that must not be "tidied up"');
  assert.match(src, /_set\('measure_power',\s+battPowerW\)/,
    'measure_power is no longer the raw battery power, so its sign may have been flipped');
});

// Declaring a capability in the manifest is not the same as putting it on a device that was
// paired before the declaration existed. Every driver here keeps its own list for that —
// REQUIRED_CAPABILITIES, added on init, or EXTRA_CAPABILITIES, added on the first successful
// fetch — and a capability in neither reaches existing installations only if Homey happens
// to sync the manifest change. An energy block pointing at such a capability reads nothing
// on exactly the devices that have been running longest.
test('every energy-block capability is one its driver adds to already-paired devices', () => {
  const FIELDS = [
    'meterPowerImportedCapability', 'meterPowerExportedCapability',
    'cumulativeImportedCapability', 'cumulativeExportedCapability',
  ];
  const listNames = ['REQUIRED_CAPABILITIES', 'EXTRA_CAPABILITIES'];

  for (const d of APP.drivers) {
    const targets = FIELDS.map((f) => (d.energy || {})[f]).filter(Boolean);
    if (!targets.length) continue;

    const file = path.join(__dirname, '..', 'drivers', d.id, 'device.js');
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');

    // Only drivers that use this pattern at all; the rest manage capabilities differently.
    const ensured = new Set();
    let found = false;
    for (const name of listNames) {
      const from = src.indexOf(`const ${name} = [`);
      if (from === -1) continue;
      found = true;
      const body = src.slice(from, src.indexOf('];', from));
      for (const m of body.matchAll(/'([^']+)'/g)) ensured.add(m[1]);
    }
    if (!found) continue;

    for (const cap of targets) {
      assert.ok(ensured.has(cap),
        `${d.id}.energy names "${cap}", but the driver never adds it to an existing device — `
        + `put it in ${listNames.join(' or ')}`);
    }
  }
});
