'use strict';

// The software version ends the device tile (1.2.301).
//
// Homey shows capabilities in the order the device holds them, and every capability added
// after pairing is appended — so on a SUN2000 paired before its grid figures existed, the
// version sat between the feed-in mode and the grid frequency. lib/capability-order.js moves
// it back to the end by removing and re-adding it, which is safe for a version string: no
// Insights, no flow card, and its value is carried over.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const { keepLast } = require('../lib/capability-order');

const ROOT = path.join(__dirname, '..');

function fakeDevice(caps, values = {}) {
  const d = {
    caps: caps.slice(),
    values: { ...values },
    calls: [],
    hasCapability: (c) => d.caps.includes(c),
    getCapabilities: () => d.caps.slice(),
    getCapabilityValue: (c) => (c in d.values ? d.values[c] : null),
    removeCapability: async (c) => { d.calls.push(['remove', c]); d.caps = d.caps.filter((x) => x !== c); delete d.values[c]; },
    addCapability: async (c) => { d.calls.push(['add', c]); if (!d.caps.includes(c)) d.caps.push(c); },
    setCapabilityValue: async (c, v) => { d.values[c] = v; },
  };
  return d;
}

test('Andi\'s inverter tile: the version moves below the grid figures, with its value', async () => {
  // The order on the tile in the screenshot of 2026-10-09.
  const d = fakeDevice([
    'meter_power.daily', 'measure_voltage.pv1', 'measure_voltage.pv2', 'measure_current.pv1',
    'measure_current.pv2', 'huawei_status', 'activepower_controlmode', 'sun2000_software_version',
    'measure_frequency', 'measure_power.grid_active_power', 'meter_power.grid_export', 'meter_power.grid_import',
  ], { sun2000_software_version: 'V100R001C00SPC178' });
  assert.strictEqual(await keepLast(d, ['sun2000_software_version']), true);
  assert.strictEqual(d.caps[d.caps.length - 1], 'sun2000_software_version');
  assert.strictEqual(d.caps.indexOf('measure_frequency'), 7, 'the others kept their order');
  assert.strictEqual(d.values.sun2000_software_version, 'V100R001C00SPC178');
});

test('nothing moves when the version is already last — the check runs on every poll', async () => {
  const d = fakeDevice(['measure_power', 'sun2000_software_version']);
  assert.strictEqual(await keepLast(d, ['sun2000_software_version']), false);
  assert.deepStrictEqual(d.calls, []);
});

test('two versions end the tile in the order given; a missing one is left out', async () => {
  const d = fakeDevice(['luna2000_unit2_software_version', 'measure_battery', 'luna2000_unit1_software_version', 'battery_rated_capacity'],
    { luna2000_unit1_software_version: 'U1', luna2000_unit2_software_version: 'U2' });
  await keepLast(d, ['luna2000_unit1_software_version', 'luna2000_unit2_software_version']);
  assert.deepStrictEqual(d.caps.slice(-2), ['luna2000_unit1_software_version', 'luna2000_unit2_software_version']);
  assert.deepStrictEqual([d.values.luna2000_unit1_software_version, d.values.luna2000_unit2_software_version], ['U1', 'U2']);

  const one = fakeDevice(['luna2000_unit1_software_version', 'battery_rated_capacity']);
  await keepLast(one, ['luna2000_unit1_software_version', 'luna2000_unit2_software_version']);
  assert.deepStrictEqual(one.caps, ['battery_rated_capacity', 'luna2000_unit1_software_version']);
  assert.ok(!one.calls.some((c) => c[1] === 'luna2000_unit2_software_version'), 'an absent unit 2 was added');
});

test('a failed re-add is tried once more instead of losing the capability', async () => {
  const d = fakeDevice(['sun2000_software_version', 'measure_frequency'], { sun2000_software_version: 'V1' });
  let first = true;
  const add = d.addCapability;
  d.addCapability = async (c) => { if (first) { first = false; throw new Error('busy'); } return add(c); };
  await keepLast(d, ['sun2000_software_version']);
  assert.deepStrictEqual(d.caps, ['measure_frequency', 'sun2000_software_version']);
  assert.strictEqual(d.values.sun2000_software_version, 'V1');
});

test('only version strings without Insights are moved this way', () => {
  const app = require('../app.json');
  const moved = ['sun2000_software_version', 'luna2000_unit1_software_version', 'luna2000_unit2_software_version', 'sdongle_software_version'];
  for (const id of moved) {
    const def = app.capabilities[id];
    assert.strictEqual(def.type, 'string', id);
    assert.strictEqual(def.insights, false, `${id} keeps Insights — removing it would cost history`);
  }
});

test('the three drivers keep their versions last at start and after every poll', () => {
  const app = require('../app.json');
  const expect = {
    sun2000_modbus:   ['sun2000_software_version'],
    luna2000_modbus:  ['luna2000_unit1_software_version', 'luna2000_unit2_software_version'],
    sdongle_a_modbus: ['sdongle_software_version'],
  };
  for (const [driver, caps] of Object.entries(expect)) {
    const src = fs.readFileSync(path.join(ROOT, 'drivers', driver, 'device.js'), 'utf8');
    assert.ok(src.includes(`const VERSION_CAPABILITIES = ${JSON.stringify(caps).replace(/","/g, "', '").replace(/^\["/, "['").replace(/"\]$/, "']")};`), `${driver}: VERSION_CAPABILITIES`);
    const ensure = src.slice(src.indexOf('async _ensureCapabilities()'));
    assert.match(ensure.slice(0, ensure.indexOf('\n  }\n')), /await keepLast\(this, VERSION_CAPABILITIES\)/, `${driver}: not at start`);
    const before = src.slice(0, src.indexOf('if (!this.getAvailable()) await this.setAvailable();'));
    assert.match(before.slice(-300), /await keepLast\(this, VERSION_CAPABILITIES\)/, `${driver}: not after the poll`);
    // and last in the manifest, for devices paired from now on
    const manifest = app.drivers.find((d) => d.id === driver).capabilities;
    assert.deepStrictEqual(manifest.slice(-caps.length), caps, `${driver}: manifest order`);
  }
});
