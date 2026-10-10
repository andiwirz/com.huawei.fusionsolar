'use strict';

// The kiosk device and its settings page (1.2.324) — the pattern the Modbus drivers had until
// 1.2.323. onSettings restarted the timer with the interval read by getSetting(), where it is
// still the old one, so a new interval took effect only at the next restart of the timer; and
// the poll right after the save, run at once, fetched from the old URL.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  return origLoad.call(this, request, parent, isMain);
};
const KioskDevice = require(path.join('..', 'drivers', 'fusionsolar_kiosk', 'device.js'));
Module._load = origLoad;

function kiosk(settings = {}) {
  const timers = [];
  const d = Object.create(KioskDevice.prototype);
  d.settings = { kiosk_url: 'https://eu5.fusionsolar.huawei.com/kiosk?kk=OLD', poll_interval: 10, ...settings };
  d.getSetting = (k) => d.settings[k];
  d.getSettings = () => ({ ...d.settings });
  d.fetched = [];
  d._fetchAndUpdate = async () => { d.fetched.push(d.getSetting('kiosk_url')); };
  d.log = () => {};
  d.error = () => {};
  d.store = {};
  d.getStoreValue = (k) => d.store[k];
  d.setStoreValue = async (k, v) => { d.store[k] = v; };
  d.homey = {
    setInterval: (fn, ms) => { const t = { kind: 'interval', fn, ms, live: true }; timers.push(t); return t; },
    clearInterval: (t) => { if (t) t.live = false; },
    setTimeout: (fn, ms) => { const t = { kind: 'timeout', fn, ms, live: true }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.live = false; },
  };
  d.timers = timers;
  // The polling's own: the interval and the wait after a save — not the change log's flush.
  d.polling = () => timers.filter((t) => t.kind === 'interval' || t.ms === 2000);
  return d;
}

const save = (d, changes) => d.onSettings({
  oldSettings: { ...d.settings }, newSettings: { ...d.settings, ...changes }, changedKeys: Object.keys(changes),
});

test('a new interval runs from the save, not from the next restart of the timer', async () => {
  const d = kiosk({ poll_interval: 10 });
  await d._startPolling();
  await save(d, { poll_interval: 30 });                   // getSetting still says 10
  const live = d.timers.filter((t) => t.kind === 'interval' && t.live);
  assert.deepStrictEqual(live.map((t) => t.ms), [30 * 60_000]);
});

test('the poll right after a new URL waits until it is stored, and fetches from it', async () => {
  const d = kiosk();
  await save(d, { kiosk_url: 'https://eu5.fusionsolar.huawei.com/kiosk?kk=NEW' });
  assert.deepStrictEqual(d.fetched, [], 'it fetched at once, from the old URL');
  const later = d.timers.find((t) => t.kind === 'timeout' && t.live);
  assert.ok(later && later.ms >= 1000);
  d.settings.kiosk_url = 'https://eu5.fusionsolar.huawei.com/kiosk?kk=NEW';   // Homey stores the page
  later.fn();
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(d.fetched, ['https://eu5.fusionsolar.huawei.com/kiosk?kk=NEW']);
});

test('deleting the device also drops a poll still waiting for its settings', async () => {
  const d = kiosk();
  await save(d, { poll_interval: 15 });
  await d.onDeleted();
  assert.ok(d.polling().every((t) => !t.live), 'a timer outlived the device');
});

test('other settings leave the polling alone', async () => {
  const d = kiosk();
  await d._startPolling();
  d._updateEnergyWarning = async () => {};
  await save(d, { energy_exclude: true });
  assert.strictEqual(d.polling().length, 1, 'the timer was restarted for a setting that has nothing to do with it');
  assert.deepStrictEqual(d.fetched, []);
});

test('without settings handed over, the interval is the stored one, and too short falls back', () => {
  assert.strictEqual(kiosk({ poll_interval: 20 })._intervalMs(), 20 * 60_000);
  assert.strictEqual(kiosk({ poll_interval: 2 })._intervalMs(), 10 * 60_000);
  assert.strictEqual(kiosk({ poll_interval: 2 })._intervalMs({ poll_interval: 7 }), 7 * 60_000);
});
