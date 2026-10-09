'use strict';

// The SDongle pairing view warns about Homey Energy (1.2.296).
//
// The SDongle device's measure_power is the house's whole consumption (loadPower). It has no
// energy block and is class sensor, so Homey Energy counts it as one more consumer on top of
// the devices that make up that consumption — the figures come out wrong. Only the owner can
// exclude it (Homey's "Exclude from Energy"), so the pairing view says so before the device
// is added, every time: unlike the kiosk device, this is wrong whatever else is paired.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'drivers', 'sdongle_a_modbus', 'pair', 'start.html'), 'utf8');

test('the warning stands on the reason: the SDongle\'s power is the house\'s consumption', () => {
  const src = fs.readFileSync(path.join(ROOT, 'drivers', 'sdongle_a_modbus', 'device.js'), 'utf8');
  assert.match(src, /await this\._set\('measure_power',\s+data\.loadPower\s+\?\? null\);/);
  const app = require(path.join(ROOT, 'app.json'));
  const d = app.drivers.find((x) => x.id === 'sdongle_a_modbus');
  assert.ok(!d.energy, 'the driver has an energy block now — check whether the warning still applies');
});

test('the pairing view shows it at once, in both languages, before "Connect"', () => {
  assert.match(html, /id="energy-warning"/);
  const show = html.indexOf("document.getElementById('energy-warning').textContent = t.energyWarning;");
  assert.ok(show > 0, 'the warning is never filled in');
  assert.ok(show < html.indexOf('async function connect()'), 'shown only after connecting');
  const texts = [...html.matchAll(/energyWarning: '((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
  assert.strictEqual(texts.length, 2, 'en and de');
  for (const t of texts) assert.ok(/Exclude from Energy/.test(t), t);
});
