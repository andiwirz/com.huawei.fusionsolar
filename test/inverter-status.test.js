'use strict';

// The inverter status tile (huawei_status), from register 32089.
//
// It showed "Unknown (0x030c)" every evening on a hybrid inverter whose battery had reached its
// discharge cutoff with no PV left: a code in neither Huawei spec. FusionSolar shows the same
// moment as "Standby" in its overview and "Shutdown: end of ESS discharge" in the detail.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const { statusLabel } = require('../lib/modbus-registers');

test('0x030C says the battery is empty, not that something is unknown', () => {
  assert.strictEqual(statusLabel(0x030C), 'Standby: battery empty');
});

test('the codes only the V300R001 spec lists are named', () => {
  assert.strictEqual(statusLabel(0x0306), 'Shutdown: DC switches disconnected');
  assert.strictEqual(statusLabel(0x0308), 'Shutdown: input underpower');
  assert.strictEqual(statusLabel(0x0404), 'Grid scheduling: dry contact');
  assert.strictEqual(statusLabel(0x0500), 'Spot-check ready');
  assert.strictEqual(statusLabel(0x0501), 'Spot-checking');
  assert.strictEqual(statusLabel(0x0900), 'DC input detection');
});

test('the codes named before are named as before', () => {
  // A flow comparing the status text must keep working.
  assert.strictEqual(statusLabel(0x0000), 'Standby: initialising');
  assert.strictEqual(statusLabel(0x0200), 'On-grid');
  assert.strictEqual(statusLabel(0x0300), 'Shutdown: fault');
  assert.strictEqual(statusLabel(0x030B), 'Shutdown: backup power system abnormal');
  assert.strictEqual(statusLabel(0x0A01), 'Standby: backup power system abnormal');
  assert.strictEqual(statusLabel(0xA000), 'Standby: no irradiation');
});

test('a code no spec lists says which range it is in, and keeps its number', () => {
  assert.strictEqual(statusLabel(0x030D), 'Shutdown (0x030D)');
  assert.strictEqual(statusLabel(0x0007), 'Standby (0x0007)');
  assert.strictEqual(statusLabel(0x0110), 'Starting (0x0110)');
  assert.strictEqual(statusLabel(0x0204), 'On-grid (0x0204)');
  assert.strictEqual(statusLabel(0x0406), 'Grid scheduling (0x0406)');
  assert.strictEqual(statusLabel(0x0502), 'Spot-check (0x0502)');
  assert.strictEqual(statusLabel(0x0601), 'Inspecting (0x0601)');
  assert.strictEqual(statusLabel(0x0701), 'AFCI check (0x0701)');
  assert.strictEqual(statusLabel(0x0801), 'I-V scanning (0x0801)');
  assert.strictEqual(statusLabel(0x0901), 'DC input detection (0x0901)');
  assert.strictEqual(statusLabel(0xA001), 'Standby (0xA001)');
});

test('a range with mixed meanings, or none, stays unknown', () => {
  // 0x0A holds both "Running: off-grid charging" and a standby state.
  assert.strictEqual(statusLabel(0x0A02), 'Unknown (0x0A02)');
  assert.strictEqual(statusLabel(0x0B00), 'Unknown (0x0B00)');
  assert.strictEqual(statusLabel(0xFFFF), 'Unknown (0xFFFF)');
});

test('the cloud driver names the same state the same way', () => {
  // FusionSolar's inverter_state is register 32089 in decimal: 780 = 0x030C. Since 1.2.294 the
  // cloud driver takes its words from statusLabel itself (test/openapi-small-fixes-1294.test.js
  // runs it code by code); until then it kept a table of its own.
  const src = fs.readFileSync(path.join(__dirname, '..', 'drivers', 'sun2000_openapi_fusionsolar', 'device.js'), 'utf8');
  assert.match(src, /const \{ statusLabel \} = require\('\.\.\/\.\.\/lib\/modbus-registers'\);/);
  assert.match(src, /const inverterStateLabel = \(code\) => CLOUD_ONLY_STATES\[code\] \?\? statusLabel\(code\);/);
});

test('the tile and the status trigger both use this label', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'drivers', 'sun2000_modbus', 'device.js'), 'utf8');
  assert.match(src, /const label = statusLabel\(data\.deviceStatus\);\s*\n\s*await this\._set\('huawei_status', label\);/);
  assert.match(src, /getDeviceTriggerCard\('sun2000_status_changed'\)\s*\n\s*\.trigger\(this, \{ status: label \}/);
});
