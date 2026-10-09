'use strict';

// The full Huawei register list, and the promises the Registers tab makes about it.
// Run: node --test
//
// lib/modbus-spec-registers.js was not typed out. Three of its four lists were parsed from
// the specification PDF, whose register tables are set in a column so narrow that the layout
// engine wrapped the signal names mid-word and dropped the space at every break:
// "[Energ / y / storag / e]Max / imum / charge / power". Every name in those lists is a
// reconstruction, so the point of these tests is that a reconstruction which went wrong
// cannot reach a user looking like a fact.
//
// The reconstruction has since been checked against the documentation's own tables, and the
// tables are kept in test/fixtures/spec-register-reference.json. That fixture is the strongest
// guard here: the generator has been re-run many times while its spacing rules were worked
// out, and without it a re-run could quietly undo a name that had already been confirmed.
//
// The strongest check is the last one: wherever the app polls a register the specification
// also describes, the two must agree on type and length. That compares the parse against a
// table written by hand and proven in the field, and it found the only two places where
// they disagree — both of which are the app's choice, not the parser's mistake, and both
// of which stay as they are (see KNOWN_DIVERGENCES).

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const SPEC = require('../lib/modbus-spec-registers');
const REG  = require('../lib/modbus-registers');

const LISTS = {
  INVERTER_SPEC_REGISTERS: SPEC.INVERTER_SPEC_REGISTERS,
  BATTERY_SPEC_REGISTERS:  SPEC.BATTERY_SPEC_REGISTERS,
  METER_SPEC_REGISTERS:    SPEC.METER_SPEC_REGISTERS,
  SDONGLE_SPEC_REGISTERS:  SPEC.SDONGLE_SPEC_REGISTERS,
  EMMA_SPEC_REGISTERS:     SPEC.EMMA_SPEC_REGISTERS,
  CHARGER_SPEC_REGISTERS:  SPEC.CHARGER_SPEC_REGISTERS,
};
const ALL = Object.values(LISTS).flat();

// How many 16-bit words each decoder consumes off the wire.
const WORDS = { UINT16: 1, INT16: 1, UINT32: 2, INT32: 2, UINT64: 4 };

// ── the list is a list, not a sketch ────────────────────────────────────────

test('every list has rows, and they are unique and in address order', () => {
  for (const [name, rows] of Object.entries(LISTS)) {
    // the shortest list is the charger's sixteen; anything under ten is a list that has
    // lost most of itself rather than a small device
    assert.ok(rows.length >= 10, `${name}: only ${rows.length} rows`);
    const seen = new Set();
    let previous = -1;
    for (const r of rows) {
      assert.ok(!seen.has(r.address), `${name}: ${r.address} appears twice`);
      seen.add(r.address);
      assert.ok(r.address > previous, `${name}: ${r.address} is out of order`);
      previous = r.address;
    }
  }
});

test('every row carries every field the Registers tab reads off it', () => {
  for (const [name, rows] of Object.entries(LISTS)) {
    for (const r of rows) {
      const where = `${name}/${r.address}`;
      assert.strictEqual(typeof r.address, 'number', `${where}: address`);
      assert.ok(Number.isInteger(r.length) && r.length >= 1, `${where}: length ${r.length}`);
      assert.ok(typeof r.specType === 'string' && r.specType, `${where}: specType`);
      assert.ok(typeof r.label === 'string' && r.label, `${where}: label`);
      assert.strictEqual(typeof r.unit, 'string', `${where}: unit`);
      assert.ok(Number.isInteger(r.decimalPower), `${where}: decimalPower`);
      assert.ok(['RO', 'RW', 'WO'].includes(r.rw), `${where}: rw is ${JSON.stringify(r.rw)}`);
    }
  }
});

test('a gain is a power of ten and never scales a value up', () => {
  // The spec states Gain as a divisor, so the stored power of ten is zero or negative.
  // A positive one would multiply a reading by ten or more and put a plausible-looking
  // wrong number on screen.
  for (const r of ALL) {
    assert.ok(r.decimalPower <= 0 && r.decimalPower >= -6,
      `${r.address}: decimalPower ${r.decimalPower} (${r.label})`);
  }
});

// ── nothing offers a read it cannot survive ─────────────────────────────────

test('a row is only typed with a decoder lib/modbus-client.js actually has', () => {
  // Read the decoder's own cases rather than restating them: a type dropped there and left
  // here would throw "Unsupported data type" the moment somebody clicked the row.
  const src   = fs.readFileSync(path.join(__dirname, '..', 'lib', 'modbus-client.js'), 'utf8');
  const start = src.indexOf('function parseBuffer(');
  assert.notStrictEqual(start, -1, 'parseBuffer is gone');
  const body      = src.slice(start, src.indexOf('\n}', start));
  const supported = new Set([...body.matchAll(/case '(\w+)':/g)].map((m) => m[1]));
  assert.ok(supported.size >= 5, `only found ${supported.size} decoders`);

  for (const r of ALL) {
    if (r.type === null) continue;
    assert.ok(supported.has(r.type), `${r.address}: type ${r.type} has no decoder (${r.label})`);
  }
});

test('a typed row occupies exactly the words its type reads', () => {
  // Two ways to get this wrong, and a mutation probe found the second one slipping through
  // an earlier "at least as many" version of this check:
  //   too few  — 47321 is documented INT32 in one register word, and reading it would ask
  //              readInt32BE for four bytes out of two and throw. The generator turns such
  //              a row into an untyped one, which is how it stays listed without being
  //              offered.
  //   too many — an I64 energy total typed INT32 would decode the top half of the number
  //              and present it as the whole, which is worse than failing: 4 of the EMMA's
  //              64-bit totals sit next to 32-bit ones and look just like them.
  for (const r of ALL) {
    if (r.type === null || !WORDS[r.type]) continue;
    assert.strictEqual(r.length, WORDS[r.type],
      `${r.address}: ${r.type} reads ${WORDS[r.type]} words but the row is ${r.length} (${r.label})`);
  }
});

test('a row the spec contradicts itself about is listed but never typed', () => {
  const conflicts = ALL.filter((r) => r.conflict);
  assert.ok(conflicts.length > 0, 'the 47321 conflict has disappeared — was the parse re-run?');
  for (const r of conflicts) {
    assert.strictEqual(r.type, null, `${r.address}: marked as a conflict yet still offered for reading`);
  }
  assert.ok(conflicts.some((r) => r.address === 47321), '47321 is no longer flagged');
});

test('a row is left untyped only where the app has no decoder for what the documentation says', () => {
  // Until 1.2.282 the EMMA's seven U64 energy totals were untyped like the I64 ones, although
  // UINT64 has a decoder and the EMMA driver polls six of them. The Registers tab offered no
  // read for them, "Read all" skipped them, and the comparison further down — which only
  // compares types where the list has one — never looked at what the app reads them as.
  const DECODER = {
    U16: 'UINT16', UINT16: 'UINT16', ENUM16: 'UINT16', Bitfield16: 'UINT16',
    I16: 'INT16',  INT16: 'INT16',
    U32: 'UINT32', UINT32: 'UINT32', Bitfield32: 'UINT32', DBitfield32: 'UINT32', EPOCHTIME: 'UINT32',
    I32: 'INT32',  INT32: 'INT32',
    U64: 'UINT64',
    STR: 'STRING', STRING: 'STRING', String: 'STRING',
  };
  // Byte blocks are not one number; I64 has no decoder (nobody polls those six).
  const UNDECODABLE = new Set(['BYTES', 'Bytes', 'MLD', 'MLD/Bytes', 'MULTIDATA', 'I64']);

  for (const r of ALL) {
    if (r.conflict) continue;              // untyped on purpose, see the test above
    const where = `${r.address} (${r.label}, documented ${r.specType})`;
    if (UNDECODABLE.has(r.specType)) {
      assert.strictEqual(r.type, null, `${where}: typed although nothing can decode it`);
      continue;
    }
    assert.ok(r.specType in DECODER, `${where}: a documented type this test does not know — decide which decoder reads it`);
    assert.strictEqual(r.type, DECODER[r.specType], `${where}: should be read as ${DECODER[r.specType]}`);
  }
});

// ── the names survived the reconstruction ───────────────────────────────────

test('no name carries the wreckage of the column it was wrapped in', () => {
  for (const r of ALL) {
    const where = `${r.address} ${JSON.stringify(r.label)}`;
    assert.strictEqual(r.label, r.label.trim(), `${where}: padded`);
    assert.doesNotMatch(r.label, /\s{2}/, `${where}: double space`);
    // A word of one lowercase letter is what a cut looks like when it was read as a space:
    // "discharging period s", "Sw itch", "Featu re". Uppercase ones are real — "A phase
    // active power".
    assert.doesNotMatch(r.label, /(^|\s)[a-z](\s|$)/, `${where}: stray letter`);
    assert.doesNotMatch(r.label, /\*/, `${where}: footnote marker left in`);
  }
});

test('every bracketed prefix is closed and followed by a space', () => {
  for (const r of ALL) {
    const opens = (r.label.match(/\[/g) || []).length;
    const shuts = (r.label.match(/\]/g) || []).length;
    assert.strictEqual(opens, shuts, `${r.address}: unbalanced brackets in ${JSON.stringify(r.label)}`);
    assert.doesNotMatch(r.label, /\][A-Za-z0-9]/,
      `${r.address}: ${JSON.stringify(r.label)} lost the space after its prefix`);
  }
});

// ── it covers the devices it claims to, and no others ───────────────────────

test('each list is attached to a driver that exists', () => {
  for (const driverId of Object.keys(SPEC.DRIVER_SPEC_REGISTERS)) {
    assert.ok(fs.existsSync(path.join('drivers', driverId, 'device.js')),
      `DRIVER_SPEC_REGISTERS names ${driverId}, which is not a driver`);
  }
  // Every Modbus driver now has one. Reading the drivers off disk rather than repeating
  // them means a ninth driver arrives here as a failure instead of quietly going uncovered.
  const drivers = fs.readdirSync('drivers')
    .filter((d) => d.endsWith('_modbus') && fs.existsSync(path.join('drivers', d, 'device.js')));
  assert.ok(drivers.length >= 8, `only ${drivers.length} Modbus drivers found`);
  assert.deepStrictEqual(Object.keys(SPEC.DRIVER_SPEC_REGISTERS).sort(), drivers.sort(),
    'a Modbus driver has no reference list, or a list names a driver that does not exist');
});

// Three Homey devices, one EMMA, one register map. They must share the very same list, not
// three copies that could drift apart.
test('the three EMMA drivers are handed one and the same list', () => {
  const { sun2000_emma_modbus: a, luna2000_emma_modbus: b,
          powermeter_emma_modbus: c } = SPEC.DRIVER_SPEC_REGISTERS;
  assert.strictEqual(a, SPEC.EMMA_SPEC_REGISTERS);
  assert.strictEqual(b, SPEC.EMMA_SPEC_REGISTERS);
  assert.strictEqual(c, SPEC.EMMA_SPEC_REGISTERS);
});

test('the charger keeps its own meanings for the addresses the EMMA also uses', () => {
  // The charger sits behind the same EMMA but answers on its own unit id, and 30500 is its
  // phase A voltage. On the EMMA's own smart meter that address is a running status. Giving
  // the charger the EMMA's list would not be an approximation, it would be wrong.
  assert.strictEqual(SPEC.DRIVER_SPEC_REGISTERS.smartcharger_emma_modbus,
    SPEC.CHARGER_SPEC_REGISTERS);
  assert.notStrictEqual(SPEC.CHARGER_SPEC_REGISTERS, SPEC.EMMA_SPEC_REGISTERS);

  const charger = new Map(SPEC.CHARGER_SPEC_REGISTERS.map((r) => [r.address, r.label]));
  assert.strictEqual(charger.get(30500), 'Phase A voltage');
  assert.strictEqual(charger.get(30076), 'Rated power');

  // and every register the driver actually polls is in its own list, none borrowed
  for (const [key, def] of Object.entries(REG.SMARTCHARGER_REGISTERS)) {
    assert.ok(charger.has(def[0]),
      `the charger polls ${key} at ${def[0]}, which its own list does not describe`);
  }
});

// The SDongle reuses addresses the inverter also defines, which is exactly why these are
// four lists and not one pool. Some of the shared ones genuinely mean the same thing on
// both devices — 30015 is a serial number either way — so what has to hold is that the
// lists stay separate and that the ones which differ still differ.
test('the SDongle keeps its own meaning for the addresses it shares with the inverter', () => {
  const inverter = new Map(SPEC.INVERTER_SPEC_REGISTERS.map((r) => [r.address, r.label]));
  const shared = SPEC.SDONGLE_SPEC_REGISTERS.filter((r) => inverter.has(r.address));
  assert.ok(shared.length >= 2, `only ${shared.length} shared addresses — did a list change?`);

  assert.notStrictEqual(SPEC.SDONGLE_SPEC_REGISTERS, SPEC.INVERTER_SPEC_REGISTERS);
  // 31200 is the inverter's REGKEY and the dongle's Registration Key: same address, two
  // devices, two names. If this ever reads alike, one list has been written over the other.
  assert.strictEqual(inverter.get(31200), 'REGKEY');
  assert.strictEqual(SPEC.SDONGLE_SPEC_REGISTERS.find((r) => r.address === 31200).label,
    'Registration Key');
});

// ── and it agrees with the registers the app has been using all along ───────

// Two registers where the app deliberately reads a different sign from the one the
// document states. Neither can misread anything a device actually reports — a grid never
// runs at 327 Hz and a derating is never above 100% — and 40125 was already put to the
// owner in 1.2.226 and left as it was. They are named here so the check below still
// guards every other register instead of being weakened for all of them.
const KNOWN_DIVERGENCES = {
  32085: { app: 'INT16',  spec: 'UINT16', why: 'grid frequency, pinned by modbus-pv-strings.test.js' },
  40125: { app: 'UINT16', spec: 'INT16',  why: 'active power percentage derating, raised in 1.2.226 and not taken up' },
};

test('the known divergences are still exactly the two that were signed off', () => {
  // If one of them is ever brought into line, this test is what says so out loud rather
  // than letting the allowance quietly cover a third register later.
  for (const [address, expected] of Object.entries(KNOWN_DIVERGENCES)) {
    const spec = ALL.find((r) => r.address === Number(address));
    assert.ok(spec, `${address} is no longer in the specification list`);
    assert.strictEqual(spec.type, expected.spec, `${address}: the spec now says ${spec.type}`);
  }
});

test('where the app polls a register this spec also describes, the two agree', () => {
  const PAIRS = [
    ['inverter', SPEC.INVERTER_SPEC_REGISTERS, ['REGISTERS', 'CONTROL_REGISTERS']],
    ['battery',  SPEC.BATTERY_SPEC_REGISTERS,
      ['BATTERY_REGISTERS', 'BATTERY_MODULE_REGISTERS', 'CONTROL_REGISTERS']],
    ['meter',    SPEC.METER_SPEC_REGISTERS, ['POWER_METER_REGISTERS']],
    ['sdongle',  SPEC.SDONGLE_SPEC_REGISTERS, ['SDONGLE_A_REGISTERS']],
    ['charger',  SPEC.CHARGER_SPEC_REGISTERS, ['SMARTCHARGER_REGISTERS']],
    ['emma',     SPEC.EMMA_SPEC_REGISTERS,
      ['EMMA_REGISTERS', 'POWERMETER_EMMA_DATA_REGISTERS', 'SUN2000_EMMA_DATA_REGISTERS',
       'LUNA2000_EMMA_DATA_REGISTERS', 'LUNA2000_EMMA_CONTROL_REGISTERS']],
  ];

  let compared = 0;
  for (const [section, rows, maps] of PAIRS) {
    const byAddress = new Map(rows.map((r) => [r.address, r]));
    for (const mapName of maps) {
      for (const [key, def] of Object.entries(REG[mapName])) {
        const spec = byAddress.get(def[0]);
        if (!spec) continue;                 // the app reads things this document omits
        compared++;
        const where = `${section}/${mapName}.${key} (${def[0]}, ${spec.label})`;
        const allowed = KNOWN_DIVERGENCES[def[0]];
        if (spec.type !== null && !allowed) {
          assert.strictEqual(def[2], spec.type, `${where}: type`);
        } else if (allowed) {
          assert.strictEqual(def[2], allowed.app,
            `${where}: this register is listed as a known divergence reading ${allowed.app}, `
            + `but the app now reads ${def[2]} — update or drop the entry`);
        }
        assert.strictEqual(def[1], spec.length, `${where}: word count`);
      }
    }
  }
  assert.ok(compared > 60, `only ${compared} registers overlapped — did a map get renamed?`);
});


// ── and it still says what the documentation's own tables say ───────────────

test('every name matches the reference table it was checked against', () => {
  const reference = require('./fixtures/spec-register-reference.json');
  const BY_SECTION = {
    inverter: SPEC.INVERTER_SPEC_REGISTERS,
    battery:  SPEC.BATTERY_SPEC_REGISTERS,
    meter:    SPEC.METER_SPEC_REGISTERS,
    sdongle:  SPEC.SDONGLE_SPEC_REGISTERS,
    emma:     SPEC.EMMA_SPEC_REGISTERS,
    charger:  SPEC.CHARGER_SPEC_REGISTERS,
  };

  let checked = 0;
  for (const [section, rows] of Object.entries(BY_SECTION)) {
    const want = reference[section];
    assert.ok(want, `the fixture has no ${section} section`);
    const shipped = new Map(rows.map((r) => [String(r.address), r.label]));

    for (const [address, name] of Object.entries(want)) {
      assert.ok(shipped.has(address), `${section}/${address} is in the reference but not shipped`);
      const exception = reference._EXCEPTIONS[address];
      const expected = exception ? exception.shipped : name;
      assert.strictEqual(shipped.get(address), expected,
        `${section}/${address}: shipped name no longer matches the reference table`);
      checked++;
    }
  }
  assert.ok(checked > 450, `only ${checked} names were checked — has the fixture shrunk?`);
});

// An exception is a place where the shipped list knowingly departs from the reference. It
// must stay small and it must stay argued for, or the fixture above quietly stops meaning
// anything.
test('every departure from the reference is recorded with its reason', () => {
  const reference = require('./fixtures/spec-register-reference.json');
  const exceptions = Object.entries(reference._EXCEPTIONS);
  assert.ok(exceptions.length <= 3, `${exceptions.length} exceptions is too many to call the list checked`);
  for (const [address, e] of exceptions) {
    assert.ok(e.reference && e.shipped && e.why, `${address}: an exception without all three fields`);
    assert.notStrictEqual(e.reference, e.shipped, `${address}: recorded as a departure but identical`);
  }
  // the one that exists: a footnote marker the document sets inside a signal name
  assert.deepStrictEqual(Object.keys(reference._EXCEPTIONS), ['37000']);
});
