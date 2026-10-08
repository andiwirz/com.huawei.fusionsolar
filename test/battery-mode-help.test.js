'use strict';

// Does the app say what the battery modes actually do? Run: node --test
//
// From issue #30. A user switched the battery to "Time of Use", it began discharging at
// once on a sunny morning, and he could not tell why there is both a working mode and a
// remote charge/discharge mode. Both answers were missing everywhere he looked:
//
//   - The flow-card hints named the register and nothing else ("Sets the working mode of
//     the LUNA2000 battery via Modbus (register 47086)"). That is the implementation, not
//     the effect, and it is the effect he needed: Time of Use follows a schedule stored
//     inside the inverter, which this app never writes.
//   - The device settings page said nothing at all, and his own words were "I do not
//     understand the difference in SETTINGS between battery modus and battery distance
//     modus" — that is where he was standing.
//
// So the text is now checked the way code is. A register number that comes back without
// the consequence, or an explanation that outlives the capability it describes, fails here.

const test     = require('node:test');
const assert   = require('node:assert');
const manifest = require('../app.json');

const LANGS = ['en', 'de', 'nl'];

const driver = (id) => manifest.drivers.find((d) => d.id === id);
const action = (id) => manifest.flow.actions.find((c) => c.id === id);

// Every setting sits in a group since 1.2.270, so collect both levels.
function settingsOf(d) {
  const out = [];
  for (const s of d.settings || []) {
    if (s.children) out.push(...s.children);
    else out.push(s);
  }
  return out;
}

const labelRow = (driverId, settingId) =>
  settingsOf(driver(driverId)).find((s) => s.id === settingId);

// Markers chosen per language rather than one shared word: the point is that each
// translation carries the meaning, and a German hint that still says "Local Control" has
// not been translated, it has been copied.
// The exact words the capability's own picker uses — since 1.2.242 the box above the hint
// shows those, so a hint that said "Lokale besturing" contradicted the "Lokale sturing"
// beside it. test/enum-label.test.js keeps that from coming back.
const LOCAL_CONTROL = { en: 'Local Control', de: 'Lokale Steuerung', nl: 'Lokale sturing' };
const EMS_DEVICE    = { en: 'Energy Management', de: 'Energieverwaltung', nl: 'Energiebeheer' };

// ── the settings page, where he was looking ─────────────────────────────────

test('every battery driver with a working mode explains it', () => {
  const withMode = manifest.drivers.filter(
    (d) => (d.capabilities || []).includes('storage_working_mode_settings'));
  assert.ok(withMode.length >= 2, 'no battery drivers found — the test is looking in the wrong place');

  // Since 1.2.272 the explanation is the (i) of the dropdown that changes the mode — the box
  // that used to carry it only repeated what the dropdown shows.
  for (const d of withMode) {
    const row = labelRow(d.id, 'mode_storage_working');
    assert.ok(row, `${d.id} offers a working mode with nothing that says what it does`);
    assert.strictEqual(row.type, 'dropdown');
    for (const lang of LANGS) {
      assert.ok(row.hint[lang], `${d.id} mode_storage_working has no ${lang} text`);
      assert.match(row.hint[lang], /FusionSolar/,
        `${d.id} (${lang}) does not say where the Time of Use schedule has to be set`);
    }
  }
});

// The sharper half: an explanation that outlives its capability is worse than none. The
// EMMA battery has no remote mode, so it must not be told about one.
test('the remote mode is explained exactly where it exists', () => {
  for (const d of manifest.drivers) {
    const hasCap = (d.capabilities || []).includes('remote_charge_discharge_control_mode');
    const hasRow = !!labelRow(d.id, 'mode_remote_dispatch');
    assert.strictEqual(hasRow, hasCap,
      hasCap ? `${d.id} has a remote mode and does not explain it`
             : `${d.id} explains a remote mode it does not have`);
  }
});

test('the remote-mode text names the value to keep', () => {
  const row = labelRow('luna2000_modbus', 'mode_remote_dispatch');
  for (const lang of LANGS) {
    assert.ok(row.hint[lang].includes(LOCAL_CONTROL[lang]),
      `the ${lang} text does not name "${LOCAL_CONTROL[lang]}" as the normal setting`);
  }
  // His second question: why there are two modes at all.
  const WHY_BOTH = { en: /which is why both exist/, de: /deshalb gibt es beide/, nl: /daarom bestaan ze allebei/ };
  for (const lang of LANGS) assert.match(row.hint[lang], WHY_BOTH[lang], `${lang}: does not say why both modes exist`);
});

// What he was actually trying to build. Both battery drivers point at it, because on
// either one the modes are the wrong tool for a price- or forecast-driven plan.
test('both battery drivers point at the EMS for price-driven charging', () => {
  for (const id of ['luna2000_modbus', 'luna2000_emma_modbus']) {
    const row = labelRow(id, 'info_ems_battery');
    assert.ok(row, `${id} does not mention the Energy Management device`);
    for (const lang of LANGS) {
      assert.ok(row.hint[lang].includes(EMS_DEVICE[lang]),
        `${id} (${lang}) does not name the Energy Management device`);
    }
  }
});

// These rows are read-only and their id must be their own: one shared with a real setting
// would overwrite it.
//
// The value in app.json is a placeholder, not data. Homey renders a label row as a disabled
// box showing the value, so an empty default — which is what 1.2.237 shipped — reads as a
// setting with nothing in it for the moment between pairing and the first poll. The driver
// writes the real text from _applyControl; here we only pin that the default says "nothing
// yet" rather than nothing at all, and that it is never a hard-coded piece of English.
test('the explanation rows carry a placeholder, not data, and collide with nothing', () => {
  for (const id of ['luna2000_modbus', 'luna2000_emma_modbus']) {
    const all  = settingsOf(driver(id));
    const info = all.filter((s) => s.type === 'label');
    assert.ok(info.length, `${id} has no label rows`);
    for (const row of info) {
      assert.strictEqual(row.value, '—',
        `${id}/${row.id} defaults to ${JSON.stringify(row.value)}; a label row shows its value, `
        + 'so that is what a user sees before the first poll');
      assert.strictEqual(all.filter((s) => s.id === row.id).length, 1,
        `${id}/${row.id} shares its id with another setting and would overwrite it`);
    }
  }
});

// ── the flow cards, for whoever automates it instead ────────────────────────

// A hint that gives only the register number answers a question nobody asked. The
// register may stay — it is useful next to the Device Tester — but not on its own.
test('the working-mode cards say what happens, not only which register', () => {
  for (const id of ['luna2000_set_working_mode', 'luna2000_emma_set_working_mode']) {
    const hint = action(id).hint;
    for (const lang of LANGS) {
      assert.match(hint[lang], /FusionSolar/,
        `${id} (${lang}) does not say the Time of Use schedule lives in the inverter`);
      assert.ok(hint[lang].includes(EMS_DEVICE[lang]),
        `${id} (${lang}) does not point at the Energy Management device`);
    }
  }
});

test('the remote-mode card says who it hands control to', () => {
  const hint = action('luna2000_set_remote_mode').hint;
  for (const lang of LANGS) {
    assert.ok(hint[lang].includes(LOCAL_CONTROL[lang]),
      `luna2000_set_remote_mode (${lang}) does not name the value to keep`);
  }
});

// Every card that writes one of these two registers is covered above; this catches a
// fourth one being added later with the old register-only wording.
test('no battery mode card is left with a register-only hint', () => {
  const MODE_CARDS = manifest.flow.actions.filter(
    (c) => /_set_(working_mode|remote_mode)$/.test(c.id));
  assert.strictEqual(MODE_CARDS.length, 3, 'a mode card was added or removed — check its hint');
  for (const c of MODE_CARDS) {
    for (const lang of LANGS) {
      assert.ok(c.hint[lang].length > 150,
        `${c.id} (${lang}) is too short to explain anything: "${c.hint[lang]}"`);
    }
  }
});
