'use strict';

// Every flow-card tooltip, checked against the code (1.2.286).
//
// An audit of all 146 cards, each finding re-read in the code before the text changed, found
// tooltips that described what a card was meant to do rather than what it does: "power output
// changed" cards that fire on every poll, or watch the PV input instead of the AC output; the
// backup-reserve cards naming 47102 while the EMMA battery reads 30373; a heat-pump start tied to
// an off-peak window that only EV chargers have; force cards pointing to card names that do not
// exist; seven cards with no tooltip at all, and a German one missing a whole sentence.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const ROOT  = path.join(__dirname, '..');
const app   = require(path.join(ROOT, 'app.json'));
const REG   = require(path.join(ROOT, 'lib', 'modbus-registers.js'));
const LANGS = ['en', 'de', 'nl'];
const QUOTES = { en: ['"', '"'], de: ['„', '“'], nl: ['„', '”'] };

const cards = [...app.flow.triggers, ...app.flow.conditions, ...app.flow.actions];
const card  = (id) => cards.find((c) => c.id === id);
const read  = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('every flow card has a tooltip, in all three languages', () => {
  const missing = [];
  for (const c of cards) for (const l of LANGS) if (!(c.hint && c.hint[l])) missing.push(`${c.id} (${l})`);
  assert.deepStrictEqual(missing, []);
});

test('a card tooltip gives the same numbers in every language', () => {
  // How the German "EMS wants to set charger current" lost its sentence about the tokens.
  const digits = (t) => (t.match(/\d+(?:[.,]\d+)?/g) || []).map((x) => x.replace(',', '.')).sort().join(' ');
  const differ = [];
  for (const c of cards) {
    const n = LANGS.map((l) => digits(c.hint[l]));
    if (n[1] !== n[0] || n[2] !== n[0]) differ.push(`${c.id}: en[${n[0]}] de[${n[1]}] nl[${n[2]}]`);
  }
  assert.deepStrictEqual(differ, []);
});

test('the German tooltips write Swiss ss and a comma before "wenn"', () => {
  const off = cards.filter((c) => /ß|ausgelöst wenn/.test(c.hint.de)).map((c) => c.id);
  assert.deepStrictEqual(off, []);
});

test('"power output changed" names the register the trigger really carries', () => {
  // SUN2000 Modbus fires with inputPower (PV input), the EMMA inverter with the EMMA's PV power.
  assert.match(read('drivers/sun2000_modbus/device.js'), /const newPower\s+= data\.inputPower \?\? 0;/);
  assert.match(read('drivers/sun2000_emma_modbus/device.js'), /pvOutputPower/);
  const pvIn = String(REG.REGISTERS.inputPower[0]);
  const emma = String(REG.SUN2000_EMMA_DATA_REGISTERS.pvOutputPower[0]);
  for (const l of LANGS) {
    const h = card('modbus_power_changed').hint[l];
    assert.ok(h.includes(pvIn) && h.includes(emma), `${l}: ${h}`);
  }
});

test('the backup-reserve cards name the EMMA register as well as the inverter one', () => {
  const emma = String(REG.EMMA_REGISTERS.backupSoc[0]);
  for (const id of ['luna2000_backup_soc_changed', 'luna2000_backup_soc_above', 'luna2000_backup_soc_below']) {
    assert.match(card(id).args.find((a) => a.type === 'device').filter, /luna2000_emma_modbus/);
    for (const l of LANGS) assert.ok(card(id).hint[l].includes('47102') && card(id).hint[l].includes(emma), `${id} (${l})`);
  }
});

test('a mode card explains each option by the name its dropdown shows', () => {
  for (const id of ['luna2000_set_working_mode', 'luna2000_emma_set_working_mode', 'sun2000_set_active_power_mode']) {
    const dd = card(id).args.find((a) => a.type === 'dropdown');
    for (const v of dd.values) {
      for (const l of LANGS) {
        const quoted = QUOTES[l][0] + (v.label || v.title)[l] + QUOTES[l][1];
        assert.ok(card(id).hint[l].includes(quoted), `${id} (${l}) does not explain ${quoted}`);
      }
    }
  }
});

test('the force cards say the power is capped, as _forcePowerW does', () => {
  assert.match(read('drivers/luna2000_modbus/device.js'), /if \(Number\.isFinite\(limit\) && limit <= 0\) \{/);
  for (const id of ['luna2000_start_force_charge', 'luna2000_start_force_discharge', 'luna2000_start_force_charge_duration',
    'luna2000_start_force_discharge_duration', 'luna2000_set_force_charge_power', 'luna2000_set_force_discharge_power']) {
    for (const l of LANGS) assert.match(card(id).hint[l], /47075\/47077/, `${id} (${l})`);
  }
});

test('a tooltip that names another card names one that exists', () => {
  // 'Start force charge', 'Zwangsentladung starten' … were never card titles.
  const titles = new Set(cards.flatMap((c) => LANGS.map((l) => c.title[l])));
  const GONE = ['Start force charge', 'Start force discharge', 'Zwangsladen starten', 'Zwangsentladung starten', 'Geforceerd laden starten', 'Geforceerd ontladen starten'];
  for (const c of cards) for (const l of LANGS) for (const g of GONE) assert.ok(!c.hint[l].includes(g) || titles.has(g), `${c.id} (${l}) names "${g}"`);
});

test('the EMS charger-current trigger says what its tokens carry', () => {
  // chargerControl.js: a stop is sent as 0 A, [amps] is per phase, the unused phases are 0.
  const src = read('lib/ems/chargerControl.js');
  assert.match(src, /trigger\(\{ amps: 0, phase1: 0, phase2: 0, phase3: 0/);
  assert.match(src, /const p1 = amps;/);
  const words = { en: ['per phase', '0 A means stop'], de: ['pro Phase', '0 A heisst Laden stoppen'], nl: ['per fase', '0 A betekent laden stoppen'] };
  for (const l of LANGS) for (const w of words[l]) assert.ok(card('ems_set_charger_current').hint[l].includes(w), `${l}: ${w}`);
});

// Andi, 2026-10-10: the tooltips say what a card or a setting does, not which other
// integration it resembles. Code comments and the README may still name the sources.
test('no tooltip names Home Assistant', () => {
  const app = require('../app.json');
  const flatS = (l) => (l || []).flatMap((x) => (x.type === 'group' ? flatS(x.children) : [x]));
  const hits = [];
  const check = (where, hint) => { for (const l of LANGS) if (/Home.?Assistant|\bHA\b/.test((hint || {})[l] || '')) hits.push(`${where} (${l})`); };
  for (const k of ['triggers', 'conditions', 'actions']) for (const c of app.flow[k]) check(c.id, c.hint);
  for (const d of app.drivers) for (const s of flatS(d.settings)) check(`${d.id}/${s.id}`, s.hint);
  assert.deepStrictEqual(hits, []);
});

// The App Store shows the changelog, so the same rule applies to it (Andi, 2026-10-10).
test('no changelog entry names Home Assistant', () => {
  const changelog = require('../.homeychangelog.json');
  const hits = [];
  for (const [version, entry] of Object.entries(changelog)) {
    for (const l of LANGS) if (/Home.?Assistant|\bHA\b/.test((entry || {})[l] || '')) hits.push(`${version} (${l})`);
  }
  assert.deepStrictEqual(hits, []);
});
