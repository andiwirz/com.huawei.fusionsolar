'use strict';

// The inverter puts a setting back when it refuses the write (1.2.276).
//
// The battery has done this since issue #31; the inverter only logged the failure, so its
// settings page went on showing a feed-in limit or output cap the inverter never took. With
// a house connection that depends on a feed-in limit (issue #35), that is the wrong thing to
// be shown.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const app  = require(path.join(ROOT, 'app.json'));

const writes = [];
const refuse = new Set();
const record = async (host, port, unit, reg, value) => {
  writes.push({ reg, value });
  await new Promise((r) => setImmediate(r)); // an answer comes over the network, after Homey stored the page
  if (refuse.has(reg)) throw new Error('Timed out');
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  if (request === '../../lib/modbus-client') {
    const real = origLoad.call(this, request, parent, isMain);
    return { ...real, writeModbusRegister: record, writeModbusU32: record };
  }
  return origLoad.call(this, request, parent, isMain);
};
const InverterDevice = require(path.join(ROOT, 'drivers', 'sun2000_modbus', 'device.js'));
Module._load = origLoad;

function makeDevice(settings) {
  const d = Object.create(InverterDevice.prototype);
  d.settings = { address: '192.0.2.10', port: 502, modbus_id: 1, enable_timeline_notifications: true, ...settings };
  d.notes = [];
  d.logs = [];
  d.homey = { notifications: { createNotification: async (n) => { d.notes.push(n.excerpt); } }, setTimeout: () => null, clearTimeout() {} };
  d.getName = () => 'Inverter';
  d.getSetting = (k) => d.settings[k];
  d.setSettings = async (o) => { d.guarded = d._updatingSettingFromModbus; Object.assign(d.settings, o); };
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = (...a) => d.logs.push(a.join(' '));
  d._settingsInitialized = true;
  d._updatingSettingFromModbus = false;
  return d;
}
// What Homey does: hands onSettings the old and new page, stores the new one once it returns.
const save = async (d, changes) => {
  const oldSettings = { ...d.settings };
  await d.onSettings({ oldSettings, newSettings: { ...d.settings, ...changes }, changedKeys: Object.keys(changes) });
  Object.assign(d.settings, changes);
};
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const reset = () => { writes.length = 0; refuse.clear(); };

test('a refused write puts the setting back, under the guard', async () => {
  reset(); refuse.add(47416);
  const d = makeDevice({ max_feed_in_power: 5000 });
  await save(d, { max_feed_in_power: 0 });
  assert.strictEqual(d.settings.max_feed_in_power, 0, 'the harness did not store the page');
  await settle();
  assert.strictEqual(d.settings.max_feed_in_power, 5000, 'the page still shows a limit the inverter refused');
  assert.strictEqual(d.guarded, true, 'put back without the guard — onSettings would write it again');
  assert.strictEqual(d._updatingSettingFromModbus, false);
});

test('the timeline names the setting and the value it went back to', async () => {
  reset(); refuse.add(40126);
  const d = makeDevice({ output_limit_w: 6000 });
  await save(d, { output_limit_w: 2000 });
  await settle();
  assert.deepStrictEqual(d.notes, ['Inverter: Inverter output limit (W) could not be written (Timed out) — put back to 6000.']);
});

test('with notifications off it is still put back, just not announced', async () => {
  reset(); refuse.add(47418);
  const d = makeDevice({ max_feed_in_power_pct: 70, enable_timeline_notifications: false });
  await save(d, { max_feed_in_power_pct: 50 });
  await settle();
  assert.strictEqual(d.settings.max_feed_in_power_pct, 70);
  assert.deepStrictEqual(d.notes, []);
});

test('a write the inverter took is left alone, beside one it refused', async () => {
  reset(); refuse.add(42055);
  const d = makeDevice({ mppt_multimodal: false, mppt_scan_interval: 15 });
  await save(d, { mppt_multimodal: true, mppt_scan_interval: 5 });
  await settle();
  assert.strictEqual(d.settings.mppt_multimodal, true);
  assert.strictEqual(d.settings.mppt_scan_interval, 15);
  assert.ok(d.logs.includes('Write OK     [mppt_multimodal → reg 42054]'));
});

test('nothing to put back when the page already holds the old value', async () => {
  reset(); refuse.add(47416);
  const d = makeDevice({ max_feed_in_power: 5000 });
  const calls = [];
  const real = d.setSettings;
  d.setSettings = async (o) => { calls.push(o); return real(o); };
  await d.onSettings({ oldSettings: { ...d.settings }, newSettings: { ...d.settings, max_feed_in_power: 0 }, changedKeys: ['max_feed_in_power'] });
  await settle(); // Homey never stored the page here
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(d.notes, [], 'announced a change that never happened');
});

test('the notification switch says it covers this warning too', () => {
  const flat = (l) => (l || []).flatMap((x) => (x.type === 'group' ? flat(x.children) : [x]));
  const s = flat(app.drivers.find((x) => x.id === 'sun2000_modbus').settings).find((x) => x.id === 'enable_timeline_notifications');
  assert.match(s.hint.en, /refuses a setting/);
  assert.match(s.hint.de, /ablehnt/);
  assert.match(s.hint.nl, /weigert/);
});
