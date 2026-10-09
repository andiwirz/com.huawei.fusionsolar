'use strict';

// Kiosk device beside a paired SUN2000: Homey Energy warning (1.2.295).
//
// The kiosk device is a solarpanel reporting the plant's yield; a SUN2000 — by Modbus, through
// an EMMA or from the cloud — reports the same production. Both in Energy count it twice.
// Homey's "Exclude from Energy" is the user's setting, so the app warns: in the pairing view
// before the device is added, and afterwards with a persistent device warning until the
// conflict is gone — the SUN2000 removed, or Homey's exclusion seen. Homey reports
// energy_exclude to onSettings when it changes, not at start, so the device remembers it in its
// store (1.2.298, lib/energy-warning.js; the restart case is tested with the SDongle).
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {}, Driver: class {} };
  return origLoad.call(this, request, parent, isMain);
};
const KioskDevice = require(path.join(ROOT, 'drivers', 'fusionsolar_kiosk', 'device.js'));
const KioskDriver = require(path.join(ROOT, 'drivers', 'fusionsolar_kiosk', 'driver.js'));
const { sun2000Names, SUN2000_DRIVERS } = require(path.join(ROOT, 'lib', 'sun2000-presence.js'));
Module._load = origLoad;
const en = require(path.join(ROOT, 'locales', 'en.json'));

function homeyWith(paired) {
  return {
    __: (k) => k.split('.').reduce((o, x) => o[x], en),
    drivers: {
      getDriver: (id) => {
        if (!(id in paired)) throw new Error('Driver Not Initialized');
        return { getDevices: () => paired[id].map((n) => ({ getName: () => n })) };
      },
    },
  };
}

function kiosk(paired, settings = {}) {
  const d = Object.create(KioskDevice.prototype);
  d.calls = [];
  d.logs = [];
  d.store = {};
  d.getStoreValue = (k) => d.store[k];
  d.setStoreValue = async (k, v) => { d.store[k] = v; };
  d.settings = { kiosk_url: 'x', ...settings };
  d.homey = homeyWith(paired);
  d.getSettings = () => ({ ...d.settings });
  d.getSetting = (k) => d.settings[k];
  d.setWarning = async (m) => { d.calls.push(['set', m]); };
  d.unsetWarning = async () => { d.calls.push(['unset']); };
  d.log = (...a) => { d.logs.push(a.join(' ')); };
  d.error = () => {};
  return d;
}

// ── who counts as a SUN2000 ──────────────────────────────────────────────────────────

test('every SUN2000 driver counts, and one that is not ready yet does not break the check', () => {
  assert.deepStrictEqual(SUN2000_DRIVERS, ['sun2000_modbus', 'sun2000_emma_modbus', 'sun2000_openapi_fusionsolar']);
  assert.deepStrictEqual(sun2000Names(homeyWith({ sun2000_modbus: ['Wechselrichter'], sun2000_openapi_fusionsolar: ['Cloud'] })), ['Wechselrichter', 'Cloud']);
  assert.deepStrictEqual(sun2000Names(homeyWith({})), []);
});

// ── the device warning ───────────────────────────────────────────────────────────────

test('with a SUN2000 paired and nothing excluded, the device warns — once', async () => {
  const d = kiosk({ sun2000_modbus: ['Wechselrichter'] });
  await d._updateEnergyWarning();
  await d._updateEnergyWarning();
  assert.deepStrictEqual(d.calls, [['set', en.kiosk.energyWarning]]);
});

test('without a SUN2000 the warning is cleared — also one left from before a restart', async () => {
  const d = kiosk({ sun2000_modbus: [] });
  await d._updateEnergyWarning();
  assert.deepStrictEqual(d.calls, [['unset']]);
});

test('Homey\'s own exclusion clears it once Homey reports it, and it is remembered', async () => {
  const d = kiosk({ sun2000_modbus: ['Wechselrichter'] });
  await d._updateEnergyWarning();
  assert.ok(d.logs.some((l) => /"Exclude from Energy" at start — settings none, last reported none/.test(l)), 'the start is not logged');
  await d.onSettings({ newSettings: { energy_exclude: true }, changedKeys: ['energy_exclude'] });
  assert.deepStrictEqual(d.calls, [['set', en.kiosk.energyWarning], ['unset']]);
  assert.deepStrictEqual(d.store, { energyExcludeReported: true });
});

test('a SUN2000 added later is noticed at the next poll, and its removal too', async () => {
  const paired = { sun2000_modbus: [] };
  const d = kiosk(paired);
  d.setUnavailable = async () => {};
  d.settings.kiosk_url = '';                 // the poll stops right after the check
  await d._fetchAndUpdate();
  paired.sun2000_modbus.push('Wechselrichter');
  await d._fetchAndUpdate();
  paired.sun2000_modbus.length = 0;
  await d._fetchAndUpdate();
  assert.deepStrictEqual(d.calls.map((c) => c[0]), ['unset', 'set', 'unset']);
});

// ── the pairing view ────────────────────────────────────────────────────────────────────

test('pairing asks the driver for paired SUN2000s, before "Connect" adds the device', async () => {
  const drv = Object.create(KioskDriver.prototype);
  drv.homey = homeyWith({ sun2000_emma_modbus: ['EMMA-Wechselrichter'] });
  drv.log = () => {};
  const handlers = {};
  await drv.onPair({ setHandler: (n, fn) => { handlers[n] = fn; } });
  assert.deepStrictEqual(await handlers.sun2000_present(), { names: ['EMMA-Wechselrichter'] });

  const html = fs.readFileSync(path.join(ROOT, 'drivers', 'fusionsolar_kiosk', 'pair', 'start.html'), 'utf8');
  assert.ok(html.indexOf("Homey.emit('sun2000_present')") > 0);
  assert.ok(html.indexOf("Homey.emit('sun2000_present')") < html.indexOf('async function connect()'), 'asked only after connecting');
  assert.match(html, /id="energy-warning"/);
  for (const phrase of ['"Exclude from Energy"', '„Exclude from Energy“']) assert.ok(html.includes(phrase), phrase);
  assert.match(html, /el\.textContent = t\.energyWarning/, 'device names go in as text, not HTML');
});

// ── the setting and the texts ──────────────────────────────────────────────────────────

test('the warning names Homey\'s setting in every language', () => {
  for (const l of ['en', 'de', 'nl']) {
    assert.ok(require(path.join(ROOT, 'locales', `${l}.json`)).kiosk.energyWarning.includes('Exclude from Energy'), l);
  }
});
