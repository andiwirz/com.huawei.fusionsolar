'use strict';

// A single-phase SCharger-22KT-S0 can save its settings (1.2.288).
//
// The settings refused "22KT-S0" with one phase: "requires Tri-Phase wiring". Huawei's
// manual lists the 22KT-S0 for TN/TT three-phase, TN/TT single-phase and IT single-phase,
// and the app's own dropdown entry reads "SCharger-22KT-S0 (Mono-Phase or Tri-Phase)". The
// 7KS-S0 really is single-phase only, and that refusal stays.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'drivers', 'smartcharger_ocpp', 'device.js'), 'utf8');
const app = require('../app.json');

const onSettings = SRC.slice(SRC.indexOf('  async onSettings('), SRC.indexOf('    if (changedKeys.includes(\'auto_start_charging\')) {'));

test('the 22KT-S0 is not refused on one phase', () => {
  assert.doesNotMatch(onSettings, /charger_model === '22kt'/, 'the 22KT phase rule is back');
  assert.doesNotMatch(SRC, /requires Tri-Phase wiring/);
});

test('the 7KS-S0 is still refused on three phases', () => {
  assert.match(onSettings, /newSettings\.charger_model === '7ks' && String\(newSettings\.number_of_phases\) === '3'/);
  assert.match(onSettings, /only supports Mono-Phase wiring/);
});

test('the dropdown says what the code now allows', () => {
  const flat = (l) => (l || []).flatMap((x) => (x.type === 'group' ? flat(x.children) : [x]));
  const model = flat(app.drivers.find((d) => d.id === 'smartcharger_ocpp').settings).find((s) => s.id === 'charger_model');
  assert.match(model.values.find((v) => v.id === '22kt').label.en, /Mono-Phase or Tri-Phase/);
  assert.match(model.values.find((v) => v.id === '7ks').label.en, /Mono-Phase only/);
});
