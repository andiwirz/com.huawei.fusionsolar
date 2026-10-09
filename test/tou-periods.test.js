'use strict';

// The Time of Use windows in the LUNA2000 settings (1.2.307).
//
// Until now the windows "Time of Use (LUNA2000)" follows could only be set in the FusionSolar
// app; the app said so, and a battery switched to Time of Use followed whatever schedule was
// stored (issue #30). Andi asked for them in the device settings, the way the Home Assistant
// integration offers them (wiki "Time-of-Use control", service set_tou_periods): one line per
// window, start-end/days/+ or -.
//
// The register layout below is wlcrs/huawei-solar-lib's HUAWEI_LUNA2000_TimeOfUseRegisters:
// 47255, 43 words — the count, then 14 slots of start, end (minutes since midnight) and one
// word with the flag in the high byte (0 charge, 1 discharge) and the days in the low byte,
// bit 0 = Sunday. HA's text says Monday 1 … Sunday 7 and maps 7 to bit 0 (int(day) % 7).
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const fs     = require('fs');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const tou  = require(path.join(ROOT, 'lib', 'tou-periods.js'));
const LANGS = ['en', 'de', 'nl'];
const locale = Object.fromEntries(LANGS.map((l) => [l, require(path.join(ROOT, 'locales', `${l}.json`))]));
const homeyIn = (l) => ({ __: (key) => key.split('.').reduce((o, k) => o[k], locale[l]) });

// The wiki's own example.
const HA_EXAMPLE = '00:00-03:00/1234567/-\n05:00-06:00/1234567/+\n06:00-14:00/1234567/-\n17:00-23:59/1234567/-';

// ── the register ─────────────────────────────────────────────────────────────

test('the words are the ones huawei-solar-lib writes', () => {
  const words = tou.encode(tou.parse('05:00-06:00/1234567/+\n00:00-03:00/12345/-\n10:00-11:00/7/+'));
  assert.strictEqual(words.length, 43);
  assert.deepStrictEqual(words.slice(0, 10), [
    3,
    300, 360, 0x007F,          // every day, charge: flag 0, days 0b1111111
    0, 180, 0x013E,            // Monday–Friday = bits 1–5, discharge: flag 1 in the high byte
    600, 660, 0x0001,          // Sunday alone is bit 0
  ]);
  assert.ok(words.slice(10).every((w) => w === 0), 'unused slots are zero');
});

test('read back, the windows come out as HA writes them', () => {
  const words = tou.encode(tou.parse(HA_EXAMPLE));
  assert.strictEqual(tou.format(tou.decode(words)), HA_EXAMPLE);
  // days are listed Monday first and Sunday last, whatever order they were typed in
  assert.strictEqual(tou.normalize('7:00-8:00/7531/+'), '07:00-08:00/1357/+');
  // no windows: an empty field, and a count of zero
  assert.strictEqual(tou.format(tou.decode(tou.encode([]))), '');
  assert.deepStrictEqual(tou.encode(tou.parse('  \n\n')), Array(43).fill(0));
});

test('a block no battery can hold is not decoded', () => {
  const words = Array(43).fill(0);
  words[0] = 15;
  assert.throws(() => tou.decode(words), { code: 'count' });
  assert.throws(() => tou.decode(words.slice(0, 42)), { code: 'length' });
});

// ── what a save refuses ──────────────────────────────────────────────────────

test('a save is refused with the line and the reason', () => {
  const cases = [
    ['00:00-06:00/12345', 'format', 1],
    ['00:00-06:00/12345/+\n06:00 to 08:00/12345/-', 'format', 2],
    ['00:00-06:00/12348/+', 'format', 1],          // there is no day 8
    ['25:00-26:00/1/+', 'time', 1],
    ['10:60-11:00/1/+', 'time', 1],
    ['08:00-09:00/113/+', 'days', 1],
    ['22:00-00:00/1234567/+', 'order', 1],         // over midnight is two windows
    ['09:00-09:00/1/+', 'order', 1],
  ];
  for (const [text, code, line] of cases) {
    assert.throws(() => tou.parse(text), (err) => err.code === code && err.line === line, `${JSON.stringify(text)} → ${code}`);
  }
});

test('windows overlap only on a day they share — the check HA makes', () => {
  assert.throws(() => tou.parse('00:00-06:00/12345/+\n05:00-07:00/5/-'), { code: 'overlap' });
  assert.doesNotThrow(() => tou.parse('00:00-06:00/12345/+\n05:00-07:00/67/-'));
  // touching is not overlapping
  assert.doesNotThrow(() => tou.parse('00:00-06:00/1234567/+\n06:00-14:00/1234567/-'));
  // a short window inside a long one, after another one that does not touch either
  assert.throws(() => tou.parse('00:00-12:00/1/+\n13:00-14:00/1/-\n03:00-04:00/1/-'), { code: 'overlap' });
});

test('fourteen windows fit, fifteen do not', () => {
  const lines = (n) => Array.from({ length: n }, (_, i) => `${String(i).padStart(2, '0')}:00-${String(i).padStart(2, '0')}:30/1/+`).join('\n');
  assert.strictEqual(tou.parse(lines(14)).length, 14);
  assert.throws(() => tou.parse(lines(15)), { code: 'tooMany', count: 15 });
});

test('blank lines and spaces around the separators are forgiven', () => {
  assert.strictEqual(tou.normalize('\n 0:00 - 6:00 / 12345 / + \n\n'), '00:00-06:00/12345/+');
});

test('every refusal reads in all three languages, with its line and text filled in', () => {
  const keys = Object.keys(locale.en.modbus.tou);
  for (const l of LANGS) assert.deepStrictEqual(Object.keys(locale[l].modbus.tou), keys, l);
  const errors = {};
  for (const [code, text] of [['format', 'x'], ['time', '25:00-26:00/1/+'], ['days', '01:00-02:00/11/+'],
    ['order', '22:00-00:00/1/+'], ['overlap', '00:00-06:00/1/+\n05:00-07:00/1/-'], ['tooMany', Array(15).fill(0).map((_, i) => `${String(i).padStart(2, '0')}:00-${String(i).padStart(2, '0')}:30/1/+`).join('\n')]]) {
    try { tou.parse(text); } catch (err) { errors[code] = err; }
    assert.ok(errors[code] && errors[code].code === code, code);
  }
  for (const l of LANGS) {
    for (const [code, err] of Object.entries(errors)) {
      const msg = tou.message(homeyIn(l), err);
      assert.doesNotMatch(msg, /\{\{/, `${l}/${code} left a placeholder: ${msg}`);
      if (err.line) assert.ok(msg.includes(String(err.line)), `${l}/${code} does not name the line`);
      if (code !== 'tooMany') assert.ok(msg.includes(err.text), `${l}/${code} does not quote the window`);
    }
    assert.match(tou.message(homeyIn(l), errors.tooMany), /15.*14/);
  }
});

// ── the device ───────────────────────────────────────────────────────────────

let written = [];
let writeFails = false;
let reads = {};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  if (request === '../../lib/modbus-client') {
    const real = origLoad.call(this, request, parent, isMain);
    return {
      ...real,
      writeModbusRegisters: async (host, port, unit, address, values) => {
        await new Promise((r) => setImmediate(r)); // a write takes a round trip; onSettings has returned by then
        if (writeFails) throw new Error('timeout');
        written.push([address, values]);
      },
      readModbusRegisters: async (host, port, unit, map) => {
        const out = {};
        for (const k of Object.keys(map)) out[k] = k in reads ? reads[k] : null;
        return out;
      },
    };
  }
  return origLoad.call(this, request, parent, isMain);
};
const LunaDevice = require(path.join(ROOT, 'drivers', 'luna2000_modbus', 'device.js'));
Module._load = origLoad;

function makeDevice(settings = {}) {
  const d = Object.create(LunaDevice.prototype);
  d.settings = { address: '192.0.2.10', port: 502, modbus_id: 1, enable_timeline_notifications: true, tou_periods: '', ...settings };
  d.notes = [];
  d.logs = [];
  d.homey = {
    __: homeyIn('de').__,
    notifications: { createNotification: async (n) => { d.notes.push(n.excerpt); } },
    manifest: require('../app.json'),
  };
  d.driver = { id: 'luna2000_modbus' };
  d.getName = () => 'Batterie';
  d.getSetting = (k) => d.settings[k];
  d.setSettings = async (o) => { Object.assign(d.settings, o); };
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = (...a) => d.logs.push(a.join(' '));
  d._updatingSettingFromModbus = false;
  d._settingsInitialized = false;
  d._touSeen = false;
  d._controlPollCounter = 0;
  return d;
}
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
const save = (d, text) => d.onSettings({ oldSettings: { ...d.settings }, newSettings: { ...d.settings, tou_periods: text }, changedKeys: ['tou_periods'] });

test('the field shows what the battery holds, read with the rare control registers', async () => {
  const d = makeDevice();
  d._applyControl = async () => {};
  d._batteryModulesInitialized = true;
  reads = { storageTouPeriods: tou.encode(tou.parse(HA_EXAMPLE)) };
  await d._fetchControl('192.0.2.10', 502, 1);
  assert.strictEqual(d.settings.tou_periods, HA_EXAMPLE);
  assert.strictEqual(d._touSeen, true);
  assert.ok(d.logs.some((l) => l.startsWith('TOU windows read: 00:00-03:00/1234567/-')), d.logs.join('\n'));

  // a block that did not arrive, or that makes no sense, leaves the field as it is
  reads = { storageTouPeriods: null };
  await d._fetchControl('192.0.2.10', 502, 1);
  const garbage = Array(43).fill(0); garbage[0] = 99;
  reads = { storageTouPeriods: garbage };
  await d._fetchControl('192.0.2.10', 502, 1);
  assert.strictEqual(d.settings.tou_periods, HA_EXAMPLE);
  reads = {};
});

test('nothing is written over windows the app has not read yet', async () => {
  const d = makeDevice();
  written = [];
  await assert.rejects(save(d, '00:00-06:00/12345/+'), { message: locale.de.modbus.tou.notReadYet });
  await settle();
  assert.deepStrictEqual(written, []);
});

test('a typo rejects the save, in the user\'s language, and writes nothing', async () => {
  const d = makeDevice();
  await d._applyTou(tou.encode([]));
  written = [];
  await assert.rejects(save(d, '00:00-06:00/12345/+\n22:00-00:00/12345/+'), (err) => /^Zeile 2: „22:00-00:00\/12345\/\+“/.test(err.message));
  await settle();
  assert.deepStrictEqual(written, []);
});

test('a save writes all 43 words to 47255 in one request, and the field shows them as read back', async () => {
  const d = makeDevice();
  await d._applyTou(tou.encode([]));
  written = [];
  await save(d, '0:00-6:00/54321/+');
  d.settings.tou_periods = '0:00-6:00/54321/+'; // what Homey stores when onSettings returns
  await settle();
  assert.strictEqual(written.length, 1);
  assert.strictEqual(written[0][0], 47255);
  assert.deepStrictEqual(written[0][1], tou.encode(tou.parse('00:00-06:00/12345/+')));
  assert.strictEqual(d.settings.tou_periods, '00:00-06:00/12345/+');
  assert.strictEqual(d._controlPollCounter, 4, 'not read back with the next poll');
  assert.strictEqual(d._writeInProgress, false);
});

test('an empty field is a save too: no windows', async () => {
  const d = makeDevice();
  await d._applyTou(tou.encode(tou.parse(HA_EXAMPLE)));
  written = [];
  await save(d, '');
  await settle();
  assert.deepStrictEqual(written, [[47255, Array(43).fill(0)]]);
});

test('a write the battery refuses puts the old windows back and says so', async () => {
  const d = makeDevice();
  await d._applyTou(tou.encode(tou.parse(HA_EXAMPLE)));
  writeFails = true;
  try {
    await save(d, '00:00-06:00/12345/+');
    d.settings.tou_periods = '00:00-06:00/12345/+';
    await settle();
  } finally {
    writeFails = false;
  }
  assert.strictEqual(d.settings.tou_periods, HA_EXAMPLE);
  assert.strictEqual(d.notes.length, 1);
  assert.match(d.notes[0], /Time of Use windows could not be written \(timeout\)/);
  assert.strictEqual(d._writeInProgress, false);
});

// ── the settings page ────────────────────────────────────────────────────────

test('the field sits with the Time of Use settings and says how to write it', () => {
  const app = require('../app.json');
  const flat = (l) => (l || []).flatMap((x) => (x.type === 'group' ? flat(x.children) : [x]));
  const all = flat(app.drivers.find((x) => x.id === 'luna2000_modbus').settings);
  const field = all.find((s) => s.id === 'tou_periods');
  assert.strictEqual(field.type, 'textarea');
  assert.strictEqual(field.value, '');
  const touLabel = all.find((s) => s.id === 'mode_storage_working').values.find((v) => v.id === '5').label;
  const Q = { en: ['"', '"'], de: ['„', '“'], nl: ['„', '”'] };
  for (const l of LANGS) {
    const h = field.hint[l];
    assert.ok(h.includes(Q[l][0] + touLabel[l] + Q[l][1]), `${l}: does not name the working mode it is for`);
    for (const must of ['47255', '00:00-06:00/12345/+', '14', '23:59', 'FusionSolar']) assert.ok(h.includes(must), `${l}: ${must}`);
    // the example in the tooltip is one the field accepts
    assert.strictEqual(tou.normalize(h.match(/\d\d:\d\d-\d\d:\d\d\/\d+\/[+-]/)[0]), '00:00-06:00/12345/+');
  }
  // the working mode no longer says this app cannot set the windows — on the LUNA2000
  const lunaMode = all.find((s) => s.id === 'mode_storage_working').hint;
  const card = app.flow.actions.find((c) => c.id === 'luna2000_set_working_mode').hint;
  for (const h of [lunaMode, card]) {
    assert.doesNotMatch(h.de, /schreibt sie nicht/);
    assert.doesNotMatch(h.en, /does not write them/);
    assert.doesNotMatch(h.nl, /schrijft ze niet/);
  }
  // …while the EMMA battery, which has no such field, still does
  const emma = flat(app.drivers.find((x) => x.id === 'luna2000_emma_modbus').settings);
  assert.ok(!emma.some((s) => s.id === 'tou_periods'));
  assert.match(emma.find((s) => s.id === 'mode_storage_working').hint.de, /schreibt sie nicht/);
});

test('the block is read on its own, never inside the Settings → Registers map', () => {
  const R = require('../lib/modbus-registers.js');
  assert.deepStrictEqual(R.LUNA2000_TOU_REGISTERS.storageTouPeriods.slice(0, 3), [47255, 43, 'WORDS']);
  assert.ok(!Object.values(R.CONTROL_REGISTERS).some((d) => d[0] === 47255));
  const { parseBuffer } = require('../lib/modbus-client.js');
  const buf = Buffer.from([0x00, 0x02, 0x01, 0x3E, 0xFF, 0xFF]);
  assert.deepStrictEqual(parseBuffer(buf, 'WORDS'), [2, 0x013E, 0xFFFF]);
  const src = fs.readFileSync(path.join(ROOT, 'drivers', 'luna2000_modbus', 'device.js'), 'utf8');
  assert.match(src, /readModbusRegisters\(address, port, modbusId, LUNA2000_TOU_REGISTERS, \(\) => this\._writeInProgress\)/);
});
