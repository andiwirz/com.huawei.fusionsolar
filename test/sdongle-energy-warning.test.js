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

// store: the device store, shared between two device objects to stand for an app restart.
function sdongle(settings = {}, store = {}) {
  const d = Object.create(SdongleDevice.prototype);
  d.calls = [];
  d.logs = [];
  d.store = store;
  d.getStoreValue = (k) => d.store[k];
  d.setStoreValue = async (k, v) => { d.store[k] = v; };
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
  assert.ok(d.logs.some((l) => /"Exclude from Energy" at start — settings none, last reported none/.test(l)), 'the start is not logged');
});

// Measured 2026-10-09 on Andi's SDongle: excluded in Homey, the warning back after every app
// restart, gone after switching the setting off and on. Homey reports energy_exclude to
// onSettings when it changes, not at start — so the device keeps what it was told (1.2.298).

test('excluded in Homey: the warning goes, and stays gone after an app restart', async () => {
  const store = {};
  const before = sdongle({}, store);
  await before._updateEnergyWarning();
  await before.onSettings({ newSettings: { energy_exclude: true }, changedKeys: ['energy_exclude'] });
  assert.deepStrictEqual(before.calls, [['set', en.sdongle.energyWarning], ['unset']]);

  const after = sdongle({}, store);           // restarted: the settings show nothing again
  await after._updateEnergyWarning();
  await after._updateEnergyWarning();
  assert.deepStrictEqual(after.calls, [['unset']], 'the warning is back after the restart');
  assert.ok(after.logs.some((l) => /last reported true/.test(l)));
});

test('what Homey reported wins over what the settings show at start', async () => {
  const stale = sdongle({ energy_exclude: false }, { energyExcludeReported: true });
  await stale._updateEnergyWarning();
  assert.deepStrictEqual(stale.calls, [['unset']]);

  const included = sdongle({ energy_exclude: true }, { energyExcludeReported: false });
  await included._updateEnergyWarning();
  assert.deepStrictEqual(included.calls, [['set', en.sdongle.energyWarning]]);
});

test('taken back into Energy: the warning returns, also after a restart', async () => {
  const store = {};
  const d = sdongle({}, store);
  await d.onSettings({ newSettings: { energy_exclude: true }, changedKeys: ['energy_exclude'] });
  await d.onSettings({ newSettings: { energy_exclude: false }, changedKeys: ['energy_exclude'] });
  assert.deepStrictEqual(d.calls, [['unset'], ['set', en.sdongle.energyWarning]]);

  const after = sdongle({}, store);
  await after._updateEnergyWarning();
  assert.deepStrictEqual(after.calls, [['set', en.sdongle.energyWarning]]);
});

test('other settings leave the store and the warning alone', async () => {
  const d = sdongle({}, {});
  d._stopPolling = async () => {};
  d._startPolling = async () => {};
  d._fetchAndUpdate = async () => {};
  await d.onSettings({ newSettings: { poll_interval: 30 }, changedKeys: ['poll_interval'] });
  assert.deepStrictEqual(d.store, {});
  assert.deepStrictEqual(d.calls, []);
});

test('a Homey that does hand the setting over at start is believed too', async () => {
  const d = sdongle({ energy_exclude: true });
  await d._updateEnergyWarning();
  assert.deepStrictEqual(d.calls, [['unset']]);
});

test('the check runs at every poll, also when a poll is still in progress', async () => {
  const d = sdongle({ energy_exclude: false });
  d._fetchInProgress = true;                // the poll itself returns at once
  await d._fetchAndUpdate();
  d.settings.energy_exclude = true;
  await d._fetchAndUpdate();
  assert.deepStrictEqual(d.calls, [['set', en.sdongle.energyWarning], ['unset']]);
});

// The app's own checkbox "Excluded from Energy" (1.2.297) stood in for an exclusion the app
// could not see; with Homey's reports remembered it is gone, and the warning says instead what
// an owner who excluded the device before has to do.
const OFF_AND_ON = {
  en: 'switch that setting off and on once',
  de: 'einmal aus- und wieder einschalten',
  nl: 'één keer uit en weer aan',
};

test('no app checkbox any more; the warning tells an owner who excluded before what to do', () => {
  const app = require(path.join(ROOT, 'app.json'));
  for (const id of ['sdongle_a_modbus', 'fusionsolar_kiosk']) {
    assert.ok(!JSON.stringify(app.drivers.find((x) => x.id === id).settings).includes('excluded_from_energy'), id);
  }
  for (const l of ['en', 'de', 'nl']) {
    const loc = require(path.join(ROOT, 'locales', `${l}.json`));
    for (const w of [loc.sdongle.energyWarning, loc.kiosk.energyWarning]) {
      assert.ok(w.includes('Exclude from Energy'), `${l}: ${w}`);
      assert.ok(w.includes(OFF_AND_ON[l]), `${l}: ${w}`);
    }
  }
});
