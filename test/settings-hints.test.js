'use strict';

// What the settings pages say has to match what the app does (1.2.273).
//
// A review against the code, the flow cards and Huawei's spec found: one name for two
// registers, a hint naming a feed-in mode that does not exist, notification switches that
// listed one occasion when they post several — warnings among them, which go silent too —
// and a German that called the same device "Inverter" and "Wechselrichter" on one page.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const app  = require(path.join(ROOT, 'app.json'));
const LANGS = ['en', 'de', 'nl'];

const flat = (l) => (l || []).flatMap((x) => (x.type === 'group' ? flat(x.children) : [x]));
const setting = (driverId, id) => flat(app.drivers.find((d) => d.id === driverId).settings).find((s) => s.id === id);
const card = (id) => app.flow.actions.find((c) => c.id === id);
const source = (driverId) => fs.readFileSync(path.join(ROOT, 'drivers', driverId, 'device.js'), 'utf8');

// ── the battery's two grid charge powers ─────────────────────────────────────────

test('the setting and the card that write different registers do not share a name', () => {
  const s = setting('luna2000_modbus', 'max_grid_charge_power');
  const ceiling = card('luna2000_set_max_grid_charge_power');
  const setPoint = card('luna2000_set_grid_charge_power');
  assert.match(source('luna2000_modbus'), /writeModbusU32\(address, port, modbusId, 47242, raw\)/, 'the setting no longer writes 47242');
  assert.match(ceiling.hint.en, /47244/);
  assert.match(setPoint.hint.en, /47242/);
  for (const lang of LANGS) {
    const label = s.label[lang].replace(/\s*\(W\)$/, '');
    assert.ok(!ceiling.title[lang].includes(label) || setPoint.title[lang].includes(label),
      `${lang}: "${s.label[lang]}" reads like the card for 47244, "${ceiling.title[lang]}"`);
    assert.doesNotMatch(s.label[lang], /max|Maxim/i, `${lang}: the set point is labelled as a maximum`);
    assert.match(s.hint[lang], /47242/);
    assert.match(s.hint[lang], /47244/, `${lang}: does not mention the ceiling it cannot exceed`);
  }
});

// ── the inverter's feed-in limits ───────────────────────────────────────────────

test('the feed-in limits name the modes exactly as the dropdown above them does', () => {
  const modes = Object.fromEntries(app.capabilities.activepower_controlmode.values.map((v) => [v.id, v.title]));
  for (const [id, mode] of [['max_feed_in_power', '6'], ['max_feed_in_power_pct', '7']]) {
    for (const lang of LANGS) {
      assert.ok(setting('sun2000_modbus', id).hint[lang].includes(modes[mode][lang]),
        `${id} (${lang}) does not name "${modes[mode][lang]}"`);
    }
  }
});

// ── how often a value is read back ──────────────────────────────────────────────

test('every battery setting read from a register says that it is synced', () => {
  for (const id of ['max_charge_power', 'max_discharge_power', 'charge_from_grid', 'max_grid_charge_power',
    'grid_charge_cutoff_soc', 'charging_cutoff_capacity', 'discharge_cutoff_capacity', 'backup_power_soc']) {
    const h = setting('luna2000_modbus', id).hint;
    assert.match(h.en, /Synced from the inverter/, `${id} (en)`);
    assert.match(h.de, /mit dem Wechselrichter synchronisiert/, `${id} (de)`);
    assert.match(h.nl, /met de omvormer gesynchroniseerd/, `${id} (nl)`);
  }
  // Only the set point comes round every fifth poll, and only while grid charging is on.
  assert.match(setting('luna2000_modbus', 'max_grid_charge_power').hint.en, /every fifth poll while grid charging is on/);
  assert.match(setting('luna2000_emma_modbus', 'max_grid_charge_power').hint.en, /Synced from the EMMA every 5 poll cycles/);
});

// ── the notification switches ───────────────────────────────────────────────────

test('each notification switch lists the warnings it also silences', () => {
  const luna = setting('luna2000_modbus', 'enable_timeline_notifications').hint;
  assert.match(luna.en, /refuses a setting/);
  assert.match(luna.en, /force charge or discharge could not be started/);
  const ocpp = setting('smartcharger_ocpp', 'enable_timeline_notifications').hint;
  assert.match(ocpp.en, /offline/);
  for (const lang of LANGS) {
    assert.ok(/silences|entfallen|entfällt|vervallen|vervalt/.test(luna[lang] + ocpp[lang]), `${lang}: does not say what goes silent`);
  }
});

test('the battery\'s list matches what the driver posts', () => {
  const src = source('luna2000_modbus');
  assert.match(src, /createNotification\(\{ excerpt: `\$\{this\.getName\(\)\}: \$\{statusLabel\}` \}\)/, 'status change');
  assert.match(src, /could not be written \(\$\{err\.message\}\) — put back to/, 'refused setting');
  assert.match(src, /_notifyForceAbort\(kind, targetSocPct, err\)/, 'aborted force charge');
});

test('the EMMA switch is about charging, discharging and idle — not the state of charge', () => {
  const h = setting('luna2000_emma_modbus', 'enable_timeline_notifications').hint;
  assert.doesNotMatch(h.de, /Ladezustand/, 'Ladezustand is the SoC, which moves on every poll');
  assert.match(h.en, /starts charging, starts discharging or goes idle/);
  assert.match(source('luna2000_emma_modbus'), /modbus\.battery\.state\.\$\{chargingState\}/);
});

// ── wording ─────────────────────────────────────────────────────────────────────

test('the German settings call the inverter "Wechselrichter"', () => {
  for (const id of ['luna2000_modbus', 'sun2000_modbus', 'luna2000_emma_modbus']) {
    for (const s of flat(app.drivers.find((d) => d.id === id).settings)) {
      assert.doesNotMatch((s.hint && s.hint.de) || '', /\bInverter/, `${id}/${s.id}`);
    }
  }
});

test('the OCPP station hint does not pin a port that can be changed', () => {
  for (const lang of LANGS) {
    assert.doesNotMatch(setting('smartcharger_ocpp', 'station_id').hint[lang], /:8887\//, lang);
  }
});

test('the README does not call 0 W "no limit" — it shuts the inverter down', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /Set to 0 for no limit/);
  assert.match(setting('sun2000_modbus', 'output_limit_w').hint.en, /Set to 0 to fully shut down/);
});
