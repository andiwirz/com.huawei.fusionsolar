'use strict';

// A setting the app takes over from the device must be able to hold the device's value (1.3.18).
//
// Wim_Hartman's log (forum, 2026-11-19), every two minutes, without end:
//
//   Setting follows the device [max_grid_charge_power]: 2400 → 2366
//
// The battery reported 2366 W, the app stored it, and Homey stored the value rounded to the
// setting's step of 100 W — 2400. The next sync saw 2366 against 2400 again and wrote again:
// a settings write and a log line every control poll, and a field that never showed the real
// value. The same log shows Homey rounding to the step: output_limit_pct (step 1) went
// "1 → 2.9", then "3 → 3.6", then "4 → 1.7".
//
// So for every synced setting: rounding to its step must move a value by no more than the
// sync's tolerance, or the sync can never settle. The five 100 W settings now take whole watts.
//
// Andi: "Ja, bauen".
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const app  = require(path.join(ROOT, 'app.json'));
const src  = (driver) => fs.readFileSync(path.join(ROOT, 'drivers', driver, 'device.js'), 'utf8');
const flat = (l) => (l || []).flatMap((x) => (x.type === 'group' ? flat(x.children) : [x]));
const setting = (driver, id) => flat(app.drivers.find((d) => d.id === driver).settings).find((s) => s.id === id);

// What each driver syncs, with the tolerance below which it leaves the setting alone — read
// from the code, so a setting added to a sync later is checked too.
function synced() {
  const out = [];
  // SUN2000: ['registerKey', 'setting_id', tolerance, min, max]
  for (const m of src('sun2000_modbus').matchAll(/\['\w+',\s*'(\w+)',\s*([\d.]+),\s*[\d.]+,\s*[\d.]+\s*\]/g)) {
    out.push(['sun2000_modbus', m[1], Number(m[2])]);
  }
  // LUNA2000: ['registerKey', 'setting_id'] at 0.5, and the grid charge power on its own
  const luna = src('luna2000_modbus');
  const table = luna.slice(luna.indexOf('const numericSync = ['), luna.indexOf('];', luna.indexOf('const numericSync = [')));
  for (const m of table.matchAll(/\['\w+',\s*'(\w+)'\]/g)) out.push(['luna2000_modbus', m[1], 0.5]);
  assert.match(luna, /Math\.abs\(v - current\) > 0\.5\) settingUpdates\.max_grid_charge_power = v;/);
  out.push(['luna2000_modbus', 'max_grid_charge_power', 0.5]);
  return out;
}

// Homey, as the log shows it: a number setting is stored rounded to its step.
const stored = (s, v) => (s.step ? Math.round(v / s.step) * s.step : v);

test('the syncs are found — five on the inverter, nine on the battery', () => {
  const all = synced();
  assert.strictEqual(all.filter(([d]) => d === 'sun2000_modbus').length, 5, JSON.stringify(all));
  assert.strictEqual(all.filter(([d]) => d === 'luna2000_modbus').length, 9, JSON.stringify(all));
});

test('every synced setting can hold what the device reports: rounding stays within the tolerance', () => {
  const loops = [];
  for (const [driver, id, tol] of synced()) {
    const s = setting(driver, id);
    assert.ok(s, `${driver}: no setting ${id}`);
    if ((s.step || 0) / 2 > tol) loops.push(`${driver} ${id}: step ${s.step}, tolerance ${tol}`);
  }
  assert.deepStrictEqual(loops, []);
});

test('Wim\'s batteries: 2366 W and 1633 W are stored as they are, and the next sync leaves them', () => {
  const s = setting('luna2000_modbus', 'max_grid_charge_power');
  for (const v of [2366, 1633]) {
    const kept = stored(s, v);
    assert.strictEqual(kept, v);
    assert.ok(!(Math.abs(v - kept) > 0.5), `${v} would be written again`);
  }
});

test('the five watt settings take whole watts', () => {
  for (const [driver, id] of [
    ['sun2000_modbus', 'max_feed_in_power'],
    ['luna2000_modbus', 'max_charge_power'],
    ['luna2000_modbus', 'max_discharge_power'],
    ['luna2000_modbus', 'max_grid_charge_power'],
    ['luna2000_modbus', 'max_grid_charge_ceiling'],
  ]) {
    assert.strictEqual(setting(driver, id).step, 1, `${driver} ${id}`);
  }
});

test('the release: version 1.3.18 or later, with the fix in the changelog', () => {
  const [ma, mi, pa] = app.version.split('.').map(Number);
  assert.ok(ma * 1e6 + mi * 1e3 + pa >= 1003018, app.version);
  const log = require(path.join(ROOT, '.homeychangelog.json'))['1.3.18'];
  assert.ok(log, 'no changelog entry for 1.3.18');
  for (const l of ['en', 'de', 'nl']) assert.match(log[l], /2366/, l);
});
