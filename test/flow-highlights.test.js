'use strict';

// Highlighted flow cards (1.2.293).
//
// Homey lists highlighted cards above the rest, per device and per card kind. Chosen from
// Flow Card Usage across all installations (2026-10-09): a card in at least 20 flows and
// clearly ahead of the next in its list, at most five per list. Homey's built-in cards
// (battery or power above/below, …) lead that statistic but are not the app's to highlight.
//
// "Set remote charge/discharge mode" (62 flows) is left out on purpose: highlighting invites
// use, and any value but Local Control overrides the working mode unless a third-party
// controller is really connected — its tooltip advises against it.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const app    = require('../app.json');

const CHOSEN = {
  // 'luna2000_set_force_charge_discharge' (72 flows) was retired in 1.2.304 for the HA-style
  // start and stop cards; 'luna2000_start_force_charge' (21 flows) took its place. In 1.2.305
  // Andi chose 'luna2000_start_force_discharge' over the two max-power cards (51 and 42 flows):
  // the start pair is what a forced run is built from now.
  actions: ['luna2000_set_working_mode', 'luna2000_start_force_charge', 'luna2000_start_force_discharge',
    'luna2000_set_charge_from_grid', 'sun2000_set_active_power_mode'],
  conditions: ['luna2000_soc_above', 'luna2000_soc_below', 'sun2000_power_above_for'],
  triggers: ['sun2000_status_changed'],
};

test('exactly the chosen cards are highlighted', () => {
  for (const kind of ['triggers', 'conditions', 'actions']) {
    const highlighted = app.flow[kind].filter((c) => c.highlight).map((c) => c.id).sort();
    assert.deepStrictEqual(highlighted, [...CHOSEN[kind]].sort(), kind);
  }
});

test('no device shows more than five highlighted cards of one kind', () => {
  // Homey's own advice: too many and the highlighted list is as hard to read as the full one.
  for (const kind of ['triggers', 'conditions', 'actions']) {
    const perDriver = {};
    for (const c of app.flow[kind].filter((x) => x.highlight)) {
      const dev = (c.args || []).find((a) => a.type === 'device');
      for (const f of String(dev ? dev.filter : '').split('||')) perDriver[f] = (perDriver[f] || 0) + 1;
    }
    for (const [driver, n] of Object.entries(perDriver)) assert.ok(n <= 5, `${driver}: ${n} highlighted ${kind}`);
  }
});

test('nothing deprecated and not the remote mode', () => {
  const all = [...app.flow.triggers, ...app.flow.conditions, ...app.flow.actions];
  assert.deepStrictEqual(all.filter((c) => c.highlight && c.deprecated).map((c) => c.id), []);
  assert.ok(!all.find((c) => c.id === 'luna2000_set_remote_mode').highlight, 'the remote mode is highlighted — see the header');
});
