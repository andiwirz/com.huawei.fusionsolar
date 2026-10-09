'use strict';

// Every driver a card's filter admits registers that card's run listener (1.2.292).
//
// Homey keeps one run listener per card for the whole app — but a driver that never registers
// it contributes nothing, and on an installation without the driver that does, there is none.
// The cloud meter fired "Meter status changed" and the cloud battery "Battery unit status
// changed" with no listener of their own: on a plant without a DTSU666 or a Modbus battery
// the status dropdown of those triggers filtered nothing, and "Meter status is" had no
// listener at all. Each now registers the same listener as its Modbus counterpart.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const app  = require(path.join(ROOT, 'app.json'));
const read = (rel) => (fs.existsSync(path.join(ROOT, rel)) ? fs.readFileSync(path.join(ROOT, rel), 'utf8') : '');
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

function registers(code, method, id) {
  if (new RegExp(`${method}\\(\\s*'${id}'\\s*\\)\\s*\\.registerRunListener`).test(code)) return true;
  const v = code.match(new RegExp(`const (\\w+) = this\\.homey\\.flow\\.${method}\\(\\s*'${id}'\\s*\\);`));
  return !!v && new RegExp(`\\b${v[1]}\\.registerRunListener`).test(code);
}

test('every trigger with arguments and every condition has a listener in each driver it admits', () => {
  // app.js registers a few cards once for the whole app ("is producing", the PV forecast
  // conditions): those have a listener whatever is installed.
  const appCode = noComments(read('app.js'));
  const gaps = [];
  let checked = 0;
  for (const [method, list] of [['getDeviceTriggerCard', app.flow.triggers], ['getConditionCard', app.flow.conditions]]) {
    for (const c of list) {
      const dev = (c.args || []).find((a) => a.type === 'device');
      if (!dev) continue;
      if (method === 'getDeviceTriggerCard' && !(c.args || []).some((a) => a.type !== 'device')) continue;
      if (registers(appCode, method, c.id)) { checked++; continue; }
      for (const driver of String(dev.filter).split('||').map((f) => f.replace('driver_id=', ''))) {
        const code = noComments(read(`drivers/${driver}/device.js`) + '\n' + read(`drivers/${driver}/driver.js`));
        checked++;
        if (!registers(code, method, c.id)) gaps.push(`${c.id} ← ${driver}`);
      }
    }
  }
  assert.deepStrictEqual(gaps, [], 'on an installation with only these drivers, the card has no listener');
  assert.ok(checked >= 55, `only ${checked} card/driver pairs checked`);   // 59 in 1.2.292
});

// ── what the new listeners do ──────────────────────────────────────────────────────

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  return origLoad.call(this, request, parent, isMain);
};
const CloudMeter   = require(path.join(ROOT, 'drivers', 'powermeter_openapi_fusionsolar', 'device.js'));
const CloudBattery = require(path.join(ROOT, 'drivers', 'luna2000_openapi_fusionsolar', 'device.js'));
Module._load = origLoad;

function listeners(Cls, method) {
  const got = {};
  const d = Object.create(Cls.prototype);
  const card = (id) => ({ registerRunListener(fn) { got[id] = fn; return this; }, registerArgumentAutocompleteListener() { return this; } });
  d.homey = { flow: { getConditionCard: card, getDeviceTriggerCard: card, getActionCard: card, getTriggerCard: card } };
  d[method]();
  return got;
}
const holding = (cap, value) => ({ getCapabilityValue: (c) => (c === cap ? value : null) });

test('the cloud meter answers both meter-status cards', () => {
  const l = listeners(CloudMeter, '_registerConditions');
  assert.strictEqual(l.dtsu666_meter_status_changed({ status: 'Offline' }, { status: 'Offline' }), true);
  assert.strictEqual(l.dtsu666_meter_status_changed({ status: 'Normal' }, { status: 'Offline' }), false, 'the dropdown does not filter');
  assert.strictEqual(l.dtsu666_meter_status_is({ device: holding('dtsu666_meter_status', 'Normal'), status: 'Normal' }), true);
  assert.strictEqual(l.dtsu666_meter_status_is({ device: holding('dtsu666_meter_status', 'Offline'), status: 'Normal' }), false);
});

test('the cloud battery answers its status trigger', () => {
  const l = listeners(CloudBattery, '_registerConditionListeners');
  assert.strictEqual(l.luna2000_battery_status_changed({ status: 'Fault' }, { status: 'Fault' }), true);
  assert.strictEqual(l.luna2000_battery_status_changed({ status: 'Running' }, { status: 'Fault' }), false);
});

test('the shared listeners are the same on both sides, so registration order does not matter', () => {
  const pairs = [
    ['drivers/dtsu666_modbus/device.js', 'drivers/powermeter_openapi_fusionsolar/device.js', 'getDeviceTriggerCard', 'dtsu666_meter_status_changed'],
    ['drivers/dtsu666_modbus/device.js', 'drivers/powermeter_openapi_fusionsolar/device.js', 'getConditionCard', 'dtsu666_meter_status_is'],
    ['drivers/luna2000_modbus/device.js', 'drivers/luna2000_openapi_fusionsolar/device.js', 'getDeviceTriggerCard', 'luna2000_battery_status_changed'],
  ];
  const body = (file, method, id) => {
    const m = noComments(read(file)).match(new RegExp(`${method}\\(\\s*'${id}'\\s*\\)\\s*\\.registerRunListener\\(([^\\n]*)\\);`));
    assert.ok(m, `${file}: ${id}`);
    return m[1].replace(/\s+/g, ' ');
  };
  for (const [a, b, method, id] of pairs) assert.strictEqual(body(b, method, id), body(a, method, id), id);
});
