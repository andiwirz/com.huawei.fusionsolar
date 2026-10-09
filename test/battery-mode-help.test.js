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

// Until 1.2.284 the (i) named two of the seven working modes. Each mode the dropdown offers
// now has its own line, opened by the exact label the dropdown shows, in that language's
// quotation marks — and a mode the dropdown does not offer (the EMMA battery has four) is not
// explained there. Sources for the wording: Huawei's LUNA2000-(5-30)-S0 user manual, "Setting
// the Mode for the Grid-tied ESS"; SPC177 for the three LG modes.
test('the working mode (i) explains every option its dropdown offers, and only those', () => {
  const QUOTES = { en: ['"', '"'], de: ['„', '“'], nl: ['„', '”'] };
  const every  = labelRow('luna2000_modbus', 'mode_storage_working').values;   // all seven
  assert.strictEqual(every.length, 7);
  for (const id of ['luna2000_modbus', 'luna2000_emma_modbus']) {
    const row     = labelRow(id, 'mode_storage_working');
    const offered = new Set(row.values.map((v) => v.id));
    for (const v of every) {
      for (const lang of LANGS) {
        const quoted = QUOTES[lang][0] + v.label[lang] + QUOTES[lang][1];
        assert.strictEqual(row.hint[lang].includes(quoted), offered.has(v.id),
          `${id} (${lang}): ${quoted} is ${offered.has(v.id) ? 'offered but not explained' : 'explained but not offered'}`);
      }
    }
  }
});

test('"Fully Fed to Grid" is explained as Huawei describes it — the battery also discharges', () => {
  // Easy to get wrong by guessing from the name: below the inverter's maximum output the
  // battery discharges, so the inverter keeps feeding in as much as it can.
  const SENTENCE = { en: /"Fully Fed to Grid"[^\n]*discharges/, de: /„Volleinspeisung“[^\n]*entlädt/, nl: /„Volledig terugleveren”[^\n]*ontlaadt/ };
  for (const id of ['luna2000_modbus', 'luna2000_emma_modbus']) {
    for (const lang of LANGS) assert.match(labelRow(id, 'mode_storage_working').hint[lang], SENTENCE[lang], `${id} (${lang})`);
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

// ── short enough to read (1.2.306) ──────────────────────────────────────────

// 1.2.284 gave every option its own explanation; by 1.2.305 the (i) had grown to 1700
// characters and Andi found it too long, in the settings and on the card alike. Now: one
// line to say what the mode is, one short line per option (the three a LUNA2000 must not
// use share one). The checks above still demand that every option is named.
test('the working-mode (i) stays short: one line per option, under 1000 characters', () => {
  const hints = [
    ...['luna2000_set_working_mode', 'luna2000_emma_set_working_mode'].map((id) => [id, action(id).hint]),
    ...['luna2000_modbus', 'luna2000_emma_modbus'].map((id) => [id, labelRow(id, 'mode_storage_working').hint]),
  ];
  for (const [id, hint] of hints) {
    for (const lang of LANGS) {
      assert.ok(hint[lang].length <= 1000, `${id} (${lang}) is ${hint[lang].length} characters again`);
      for (const line of hint[lang].split('\n')) {
        assert.ok(line.length <= 230, `${id} (${lang}) has a line of ${line.length} characters: "${line}"`);
      }
    }
  }
});

// The excess-PV setting does something only in Time of Use. The setting and the tile said so;
// the cards said it in the tooltip at most, and the flow showed "PV-Überschuss-Nutzung auf
// Batterie laden setzen" as if it always applied.
test('the excess-PV cards say TOU in the title the flow shows', () => {
  const cards = [
    ...['luna2000_set_excess_pv', 'luna2000_emma_set_excess_pv'].map((id) => action(id)),
    manifest.flow.conditions.find((c) => c.id === 'luna2000_excess_pv_is'),
    manifest.flow.triggers.find((c) => c.id === 'luna2000_excess_pv_changed'),
  ];
  for (const c of cards) {
    for (const lang of LANGS) {
      assert.match(c.title[lang], /TOU/, `${c.id} title (${lang})`);
      if (c.titleFormatted) assert.match(c.titleFormatted[lang], /TOU/, `${c.id} titleFormatted (${lang})`);
    }
  }
  // …and the tooltip names the working mode by the label its card shows, in that card's language
  for (const [id, modeCard] of [['luna2000_set_excess_pv', 'luna2000_set_working_mode'],
    ['luna2000_emma_set_excess_pv', 'luna2000_emma_set_working_mode']]) {
    const tou = action(modeCard).args.find((a) => a.type === 'dropdown').values.find((v) => v.id === '5').label;
    const QUOTES = { en: ['"', '"'], de: ['„', '“'], nl: ['„', '”'] };
    for (const lang of LANGS) {
      assert.ok(action(id).hint[lang].includes(QUOTES[lang][0] + tou[lang] + QUOTES[lang][1]), `${id} (${lang})`);
    }
  }
  // the tiles agree: the EMMA battery's said "PV-Überschuss-Nutzung" with no mode
  for (const d of ['luna2000_modbus', 'luna2000_emma_modbus']) {
    for (const lang of LANGS) {
      assert.match(driver(d).capabilitiesOptions.storage_excess_pv_energy_use_in_tou.title[lang], /TOU/, `${d} tile (${lang})`);
    }
  }
});
