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

// ── the device warning (1.2.297) ─────────────────────────────────────────────────────
//
// The same warning the kiosk device carries beside a SUN2000 (lib/energy-warning.js), here
// without a condition: the SDongle counts wrongly in Energy whatever else is paired.

const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  return origLoad.call(this, request, parent, isMain);
};
const SdongleDevice = require(path.join(ROOT, 'drivers', 'sdongle_a_modbus', 'device.js'));
Module._load = origLoad;
const en = require(path.join(ROOT, 'locales', 'en.json'));

function sdongle(settings = {}) {
  const d = Object.create(SdongleDevice.prototype);
  d.calls = [];
  d.logs = [];
  d.settings = { address: '192.0.2.40', ...settings };
  d.homey = { __: (k) => k.split('.').reduce((o, x) => o[x], en) };
  d.getSettings = () => ({ ...d.settings });
  d.getSetting = (k) => d.settings[k];
  d.setWarning = async (m) => { d.calls.push(['set', m]); };
  d.unsetWarning = async () => { d.calls.push(['unset']); };
  d.log = (...a) => { d.logs.push(a.join(' ')); };
  d.error = () => {};
  return d;
}

test('a SDongle not excluded from Energy carries the warning — set once', async () => {
  const d = sdongle();
  await d._updateEnergyWarning();
  await d._updateEnergyWarning();
  assert.deepStrictEqual(d.calls, [['set', en.sdongle.energyWarning]]);
  assert.ok(d.logs.some((l) => /"Exclude from Energy" is not visible to the app/.test(l)));
});

test('excluded — seen by Homey or confirmed in the settings — it goes', async () => {
  const seen = sdongle({ energy_exclude: true });
  await seen._updateEnergyWarning();
  assert.deepStrictEqual(seen.calls, [['unset']]);

  const confirmed = sdongle();
  await confirmed._updateEnergyWarning();
  await confirmed.onSettings({ newSettings: { excluded_from_energy: true }, changedKeys: ['excluded_from_energy'] });
  assert.deepStrictEqual(confirmed.calls, [['set', en.sdongle.energyWarning], ['unset']]);
});

test('the check runs at every poll, also when a poll is still in progress', async () => {
  const d = sdongle({ energy_exclude: false });
  d._fetchInProgress = true;                // the poll itself returns at once
  await d._fetchAndUpdate();
  d.settings.energy_exclude = true;
  await d._fetchAndUpdate();
  assert.deepStrictEqual(d.calls, [['set', en.sdongle.energyWarning], ['unset']]);
});

test('the fallback setting exists, and the warning names it in every language', () => {
  const app = require(path.join(ROOT, 'app.json'));
  const flat = (l) => (l || []).flatMap((x) => (x.type === 'group' ? flat(x.children) : [x]));
  const s = flat(app.drivers.find((x) => x.id === 'sdongle_a_modbus').settings).find((x) => x.id === 'excluded_from_energy');
  assert.strictEqual(s.type, 'checkbox');
  for (const l of ['en', 'de', 'nl']) {
    const warning = require(path.join(ROOT, 'locales', `${l}.json`)).sdongle.energyWarning;
    assert.ok(warning.includes(s.label[l]), `${l}: the warning does not name "${s.label[l]}"`);
  }
});
