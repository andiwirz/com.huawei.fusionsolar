'use strict';

// The charging state of a charger from another app (1.3.10).
//
// Matthias_Konenberg (forum, 2026-11-03) wants his Keba controlled by the EMS. The Keba app
// (se.cohen.keba) reports "Plugged in" as plug_status (true/false) and "Charging" as
// charge_status, beside onoff. The settings offered only values with "charging" in their name
// and onoff, so onoff was the one left — and on a wallbox it means "enabled". With the 0 A
// stop wired to "Turn off", the EMS then read the car as unplugged and never started the
// charger again. Now a value named after the plug, cable or connection comes before onoff.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const vm     = require('node:vm');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const PAGE = read('settings', 'index.html');
const DEV  = read('drivers', 'energy_management', 'device.js');

function fnSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `function ${name} is not in the page`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}

// The detection and the list the dropdown offers, as the page runs them.
function page() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext([
    fnSource(PAGE, 'emsDetectCap'),
    fnSource(PAGE, 'emsIsPlugCap'),
    fnSource(PAGE, 'emsDetectChargerState'),
    'function offered(caps) {',
    `  ${PAGE.match(/var stateCaps = caps\.filter\([^\n]*/)[0]}`,
    '  return stateCaps.length ? stateCaps : caps;',
    '}',
    'function chosen(caps, stored) {',
    `  ${PAGE.match(/var defState = [^\n]*/)[0]}`,
    '  return defState;',
    '}',
  ].join('\n'), ctx);
  return {
    detect:  (caps) => ctx.emsDetectChargerState(caps),
    offered: (caps) => [...ctx.offered(caps)],
    chosen:  (caps, stored) => ctx.chosen(caps, stored),
  };
}

// The Keba app's P20/P30 device, from its manifest (1.1.13).
const KEBA = [
  'onoff', 'charge_power', 'plug_status', 'charge_status', 'charge_power_selector',
  'measure_current_1', 'measure_voltage_1', 'measure_current_2', 'measure_voltage_2',
  'measure_current_3', 'measure_voltage_3', 'measure_power', 'measure_energy_current',
  'measure_energy_total',
];

test('the Keba: "Plugged in" is taken, not onoff', () => {
  assert.strictEqual(page().detect(KEBA), 'plug_status');
});

test('the Keba: the dropdown offers plug_status beside onoff', () => {
  // charge_status is "charging", not "plugged in": as the state it would read every pause as
  // an unplugged car — the same dead end as onoff, so it is not offered.
  assert.deepStrictEqual(page().offered(KEBA), ['onoff', 'plug_status']);
});

test('Homey\'s own charging state still comes first', () => {
  const p = page();
  assert.strictEqual(p.detect(['onoff', 'car_connected', 'evcharger_charging_state']), 'evcharger_charging_state');
  assert.strictEqual(p.detect(['onoff', 'cable_locked', 'charging_state']), 'charging_state');
});

test('a value named after the cable or the connection counts too', () => {
  const p = page();
  assert.strictEqual(p.detect(['onoff', 'cable_locked']), 'cable_locked');
  assert.strictEqual(p.detect(['onoff', 'car_connected']), 'car_connected');
  assert.strictEqual(p.detect(['onoff', 'Car_Plugged']), 'Car_Plugged', 'capitals do not hide it');
  assert.deepStrictEqual(p.offered(['onoff', 'cable_locked', 'car_connected', 'measure_power']),
    ['onoff', 'cable_locked', 'car_connected']);
});

test('alarms and readings that mention a plug or a connection are not a state', () => {
  const p = page();
  const caps = ['onoff', 'alarm_connectivity', 'measure_temperature.plug', 'meter_power.cable', 'measure_power'];
  assert.strictEqual(p.detect(caps), 'onoff');
  assert.deepStrictEqual(p.offered(caps), ['onoff']);
});

test('onoff stays the fallback for a charger that has nothing else', () => {
  const p = page();
  assert.strictEqual(p.detect(['onoff', 'measure_power']), 'onoff');
  assert.strictEqual(p.detect(['measure_power']), null);
});

test('a charging state saved earlier stays as it is', () => {
  const p = page();
  assert.strictEqual(p.chosen(KEBA, { cap_state: 'onoff' }), 'onoff');
  assert.strictEqual(p.chosen(KEBA, null), 'plug_status');
});

test('the EMS reads plug_status true as plugged in and false as unplugged', () => {
  const line = DEV.match(/const DISCONNECTED_STATES = new Set\([^\n]*\);/);
  assert.ok(line, 'DISCONNECTED_STATES is not in the EMS device');
  const set = vm.runInNewContext(line[0].replace('const DISCONNECTED_STATES =', ''));
  assert.ok(set.has(false), 'false is unplugged');
  assert.ok(!set.has(true), 'true is plugged in');
});
