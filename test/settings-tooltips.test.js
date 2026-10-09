'use strict';

// Every settings tooltip, checked against the code and Huawei's own documents (1.2.285).
//
// The working mode's (i) named two of its seven options until 1.2.284. Going through all the
// others turned up more of the same and some plain errors: two port hints sent SDongle users to
// 6607, which is the inverter's built-in WLAN access point (Huawei's SDongle guide says 502);
// the end-of-discharge SoC claimed a default the LUNA2000 manual does not give and left out its
// 24-hour rule; the cloud devices' user name, system code and plant code had no tooltip at all;
// the EMS notification switch named two of the five things it silences.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const ROOT  = path.join(__dirname, '..');
const app   = require(path.join(ROOT, 'app.json'));
const LANGS = ['en', 'de', 'nl'];
const QUOTES = { en: ['"', '"'], de: ['„', '“'], nl: ['„', '”'] };

const flat = (l) => (l || []).flatMap((x) => (x.type === 'group' ? flat(x.children) : [x]));
const rows = () => app.drivers.flatMap((d) => flat(d.settings).filter((s) => s.type !== 'label').map((s) => ({ d: d.id, s })));
const setting = (driverId, id) => flat(app.drivers.find((d) => d.id === driverId).settings).find((s) => s.id === id);

test('every setting has a tooltip, in all three languages', () => {
  const missing = [];
  for (const { d, s } of rows()) for (const l of LANGS) if (!(s.hint && s.hint[l])) missing.push(`${d}/${s.id} (${l})`);
  assert.deepStrictEqual(missing, []);
});

test('a tooltip gives the same numbers in every language', () => {
  // Registers, ranges, defaults: a number that is in the English text and not in the Dutch
  // one is a sentence that was not translated, or a value that was changed in one place.
  const digits = (t) => (t.match(/\d+(?:[.,]\d+)?/g) || []).map((x) => x.replace(',', '.')).sort().join(' ');
  const differ = [];
  for (const { d, s } of rows()) {
    const n = LANGS.map((l) => digits(s.hint[l]));
    if (n[1] !== n[0] || n[2] !== n[0]) differ.push(`${d}/${s.id}: en[${n[0]}] de[${n[1]}] nl[${n[2]}]`);
  }
  assert.deepStrictEqual(differ, []);
});

test('a mode dropdown explains each of its options by the name the dropdown shows', () => {
  let checked = 0;
  for (const { d, s } of rows()) {
    if (s.type !== 'dropdown' || !(/^mode_/.test(s.id) || s.id === 'charger_model')) continue;
    checked++;
    for (const v of s.values) {
      for (const l of LANGS) {
        const quoted = QUOTES[l][0] + v.label[l] + QUOTES[l][1];
        assert.ok(s.hint[l].includes(quoted), `${d}/${s.id} (${l}) does not explain ${quoted}`);
      }
    }
  }
  // LUNA2000 Modbus 4, EMMA battery 2, SUN2000 Modbus 1, OCPP charger model 1.
  assert.strictEqual(checked, 8, 'a mode dropdown was added or removed — check its tooltip');
});

test('6607 is only ever given as the inverter\'s own WLAN access point, never as the SDongle\'s', () => {
  const ap = { en: /WLAN access point/, de: /WLAN-Zugangspunkt/, nl: /wifi-toegangspunt/ };
  let seen = 0;
  for (const { d, s } of rows()) {
    for (const l of LANGS) {
      if (!s.hint[l].includes('6607')) continue;
      seen++;
      assert.match(s.hint[l], ap[l], `${d}/${s.id} (${l}) names 6607 without saying it is the inverter's access point`);
      assert.doesNotMatch(s.hint[l], /SDongle[^.(]*6607/, `${d}/${s.id} (${l}) gives 6607 as the SDongle's port`);
    }
  }
  assert.ok(seen >= 4, 'the port tooltips no longer mention 6607 — check what they say instead');
});

test('the end-of-discharge SoC says what Huawei says, and no default Huawei does not give', () => {
  // LUNA2000-(5-30)-S0 user manual, "Setting the Mode for the Grid-tied ESS": 0–20 %, at least
  // 15 % without PV or after 24 hours without sunlight, and a warning against 0 %. The register
  // list says default 15, the manual 5 for the LUNA2000 — so the tooltip names neither.
  const h = setting('luna2000_modbus', 'discharge_cutoff_capacity').hint;
  const NO_DEFAULT = { en: /default/i, de: /Standard/, nl: /standaard/i };
  for (const l of LANGS) {
    assert.match(h[l], /24/, `${l}: the 24-hour rule is missing`);
    assert.match(h[l], /15 %/, l);
    assert.doesNotMatch(h[l], NO_DEFAULT[l], `${l}: names a default`);
  }
});

test('the cloud credentials say which devices a change reaches — exactly as the coordinator does', () => {
  // lib/openapi-coordinator.js copies these keys onto every device of the plant when one
  // device's settings change; the plant code moves only the device it is changed on.
  const src  = fs.readFileSync(path.join(ROOT, 'lib', 'openapi-coordinator.js'), 'utf8');
  const keys = JSON.parse(src.match(/const KEYS = (\[[^\]]*\]);/)[1].replace(/'/g, '"'));
  assert.deepStrictEqual(keys, ['base_url_region', 'base_url', 'username', 'system_code']);
  const ALL = { en: 'every OpenAPI device of the same plant', de: 'alle OpenAPI-Geräte derselben Anlage', nl: 'alle OpenAPI-apparaten van dezelfde installatie' };
  let checked = 0;
  for (const d of app.drivers.filter((x) => /openapi_fusionsolar$/.test(x.id))) {
    for (const id of [...keys, 'station_code']) {
      const s = setting(d.id, id);
      for (const l of LANGS) assert.strictEqual(s.hint[l].includes(ALL[l]), keys.includes(id), `${d.id}/${id} (${l})`);
      checked++;
    }
  }
  assert.strictEqual(checked, 7 * 5);
});

test('the EMS notification switch names everything it silences', () => {
  // _postNotification is called for: a device started/stopped, battery full, battery low,
  // a stale price forecast, a tick overrun.
  const calls = ['lib/ems/simpleDevices.js', 'lib/ems/priceForecast.js', 'lib/ems/history.js', 'drivers/energy_management/device.js']
    .map((f) => (fs.readFileSync(path.join(ROOT, f), 'utf8').match(/this\._postNotification\(`/g) || []).length)
    .reduce((a, b) => a + b, 0);
  assert.strictEqual(calls, 5, 'the EMS posts to the timeline on more or fewer occasions now — update the tooltip');
  const h = setting('energy_management', 'enable_timeline_notifications').hint.de;
  for (const word of ['startet oder stoppt', 'voll', 'niedrig', 'Preisprognose', 'überlastet']) assert.ok(h.includes(word), word);
});
