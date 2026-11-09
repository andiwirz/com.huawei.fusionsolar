'use strict';

// The card "Set Time of Use windows" (1.3.15).
//
// Asked for in the forum: a user plans charging and discharging with a script of their own (use
// at home, solar, the next day's spot prices) and wanted to hand the result to the battery. The
// windows were only a device setting (1.2.307, test/tou-periods.test.js), and Homey does not
// let a script change one — it answers "Missing scopes". A card can be handed a text tag.
//
// The card takes the field's text. Its windows share one line, so `;` and `,` separate them as
// line breaks do, and an error names the window by its place on the card. It waits for the
// write and fails the flow when the battery refuses it; it does not write what the battery
// already holds; and it never writes before the windows were read once.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const app  = require(path.join(ROOT, 'app.json'));
const tou  = require(path.join(ROOT, 'lib', 'tou-periods.js'));
const LANGS = ['en', 'de', 'nl'];
const locale = Object.fromEntries(LANGS.map((l) => [l, require(path.join(ROOT, 'locales', `${l}.json`))]));
const homeyIn = (l) => ({ __: (key) => key.split('.').reduce((o, k) => o[k], locale[l]) });

let written = [];
let writeFails = false;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  if (request === '../../lib/modbus-client') {
    const real = origLoad.call(this, request, parent, isMain);
    return {
      ...real,
      writeModbusRegisters: async (host, port, unit, address, values) => {
        await new Promise((r) => setImmediate(r));
        if (writeFails) throw new Error('timeout');
        written.push([host, unit, address, values]);
      },
    };
  }
  return origLoad.call(this, request, parent, isMain);
};
const LunaDevice = require(path.join(ROOT, 'drivers', 'luna2000_modbus', 'device.js'));
Module._load = origLoad;

const CARD = 'luna2000_set_tou_periods';

function makeDevice({ lang = 'de', address = '192.0.2.10', modbus_id = 1, seen = true, held = '' } = {}) {
  const d = Object.create(LunaDevice.prototype);
  d.settings = { address, port: 502, modbus_id, enable_timeline_notifications: true, tou_periods: held };
  d.notes = [];
  d.logs = [];
  d.listeners = {};
  const card = (id) => ({
    registerRunListener(fn) { d.listeners[id] = fn; return this; },
    registerArgumentAutocompleteListener() { return this; },
  });
  d.homey = {
    __: homeyIn(lang).__,
    flow: { getActionCard: card },
    notifications: { createNotification: async (n) => { d.notes.push(n.excerpt); } },
    manifest: app,
  };
  d.getName = () => 'Batterie';
  d.getSetting = (k) => d.settings[k];
  d.setSettings = async (o) => { Object.assign(d.settings, o); };
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = (...a) => d.logs.push(a.join(' '));
  d._updatingSettingFromModbus = false;
  d._writeInProgress = false;
  d._touSeen = seen;
  d._controlPollCounter = 0;
  return d;
}
// The card as Homey runs it: the listener registered by `registrar`, for `device`.
async function runCard(device, periods, registrar = device) {
  registrar._registerFlowActions();
  return registrar.listeners[CARD]({ device, periods }, {});
}
const words = (text) => tou.encode(tou.parse(text));

// ── the card ──────────────────────────────────────────────────────────────────

test('the card writes its windows to 47255 in one block, and the field shows them', async () => {
  const d = makeDevice();
  written = [];
  await runCard(d, '00:00-06:00/12345/+; 17:00-23:59/12345/-');
  assert.deepStrictEqual(written, [['192.0.2.10', 1, 47255, words('00:00-06:00/12345/+\n17:00-23:59/12345/-')]]);
  assert.strictEqual(d.settings.tou_periods, '00:00-06:00/12345/+\n17:00-23:59/12345/-');
  assert.strictEqual(d._controlPollCounter, 4, 'not read back with the next poll');
  assert.strictEqual(d._writeInProgress, false);
  assert.deepStrictEqual(d.notes, []);
});

test('; , and line breaks all separate windows, and spaces and empty pieces are forgiven', async () => {
  const want = words('00:00-06:00/12345/+\n10:00-12:00/67/+\n17:00-23:59/12345/-');
  for (const text of [
    '00:00-06:00/12345/+;10:00-12:00/67/+;17:00-23:59/12345/-',
    '00:00-06:00/12345/+, 10:00-12:00/67/+, 17:00-23:59/12345/-',
    '00:00-06:00/12345/+\n10:00-12:00/67/+\r\n17:00-23:59/12345/-',
    ' ;00:00-06:00/12345/+ ;; 10:00-12:00/67/+ ,\n 17:00-23:59/12345/- ; ',
  ]) {
    const d = makeDevice();
    written = [];
    await runCard(d, text);
    assert.deepStrictEqual(written.map((w) => w[3]), [want], JSON.stringify(text));
  }
});

test('a mistake fails the flow, names the window by its place on the card, and writes nothing', async () => {
  for (const [lang, word] of [['en', 'Window'], ['de', 'Fenster'], ['nl', 'Venster']]) {
    const d = makeDevice({ lang, held: '00:00-06:00/12345/+' });
    written = [];
    // the empty piece between the two ; does not count: the wrong window is the second, not the third
    await assert.rejects(runCard(d, '00:00-06:00/12345/+; ; 22:00-00:00/12345/+'),
      (err) => err.message.startsWith(`${word} 2: `) && err.message.includes('22:00-00:00/12345/+'));
    await assert.rejects(runCard(d, '00:00-06:00/12345/+; 25:00-26:00/1/+'), (err) => err.message.startsWith(`${word} 2: `));
    await assert.rejects(runCard(d, 'tomorrow'), (err) => err.message.startsWith(`${word} 1: `));
    assert.deepStrictEqual(written, [], lang);
    assert.strictEqual(d.settings.tou_periods, '00:00-06:00/12345/+');
  }
});

test('the settings field still says line, the card window — in every language', () => {
  let err;
  try { tou.parse('00:00-06:00/1/+\n05:00-07:00/1/-'); } catch (e) { err = e; }
  for (const [lang, line, win] of [['en', 'Line', 'Window'], ['de', 'Zeile', 'Fenster'], ['nl', 'Regel', 'Venster']]) {
    assert.ok(tou.message(homeyIn(lang), err).startsWith(`${line} 2: `), lang);
    assert.ok(tou.message(homeyIn(lang), err, 'line').startsWith(`${line} 2: `), lang);
    assert.ok(tou.message(homeyIn(lang), err, 'window').startsWith(`${win} 2: `), lang);
    // a window over midnight is no longer "two lines" — on the card it is not a line at all
    assert.doesNotMatch(locale[lang].modbus.tou.order, /\b(lines|Zeilen|regels)\b/, lang);
  }
});

test('nothing is written over windows the app has not read yet', async () => {
  const d = makeDevice({ seen: false });
  written = [];
  await assert.rejects(runCard(d, '00:00-06:00/12345/+'), { message: locale.de.modbus.tou.notReadYet });
  assert.deepStrictEqual(written, []);
});

test('windows the battery already holds are not written again, however they are spelled', async () => {
  const d = makeDevice({ held: '00:00-06:00/12345/+\n17:00-23:59/12345/-' });
  written = [];
  await runCard(d, '0:00-6:00/54321/+ ; 17:00 - 23:59 / 12345 / -');
  assert.deepStrictEqual(written, []);
  assert.ok(d.logs.some((l) => l.startsWith('TOU windows already set, nothing written: 00:00-06:00/12345/+ · 17:00-23:59/12345/-')), d.logs.join('\n'));
  // one window more is a change
  await runCard(d, '0:00-6:00/54321/+ ; 17:00 - 23:59 / 12345 / -; 10:00-11:00/6/+');
  assert.strictEqual(written.length, 1);
});

test('an empty card clears the windows, as an empty field does — and does nothing when there are none', async () => {
  for (const text of ['', ' ; ', undefined]) {
    const d = makeDevice({ held: '00:00-06:00/12345/+' });
    written = [];
    await runCard(d, text);
    assert.deepStrictEqual(written, [['192.0.2.10', 1, 47255, Array(43).fill(0)]], JSON.stringify(text));
    assert.strictEqual(d.settings.tou_periods, '');
  }
  const none = makeDevice({ held: '' });
  written = [];
  await runCard(none, '');
  assert.deepStrictEqual(written, []);
});

test('a write the battery refuses fails the flow in the user\'s language, keeps the field, and says so', async () => {
  for (const lang of LANGS) {
    const d = makeDevice({ lang, held: '00:00-06:00/12345/+' });
    writeFails = true;
    try {
      await assert.rejects(runCard(d, '01:00-05:00/12345/+'),
        { message: locale[lang].modbus.tou.writeFailed.replace('{{error}}', 'timeout') });
    } finally {
      writeFails = false;
    }
    assert.strictEqual(d.settings.tou_periods, '00:00-06:00/12345/+', lang);
    assert.strictEqual(d._writeInProgress, false, lang);
    assert.strictEqual(d.notes.length, 1, lang);
    assert.match(d.notes[0], /Time of Use windows could not be written \(timeout\)/);
  }
});

test('a save of the field still only reverts and never throws at the page', async () => {
  // rethrow is the card's alone: onSettings does not wait for the write, and an error thrown
  // there would surface as an unhandled rejection rather than at the page.
  const d = makeDevice({ held: '00:00-06:00/12345/+' });
  writeFails = true;
  let caught = null;
  try {
    await d._writeTou(d._pendingTouWrite('01:00-05:00/12345/+'), '00:00-06:00/12345/+', d.settings);
  } catch (err) {
    caught = err;
  } finally {
    writeFails = false;
  }
  assert.strictEqual(caught, null);
  assert.strictEqual(d.notes.length, 1);
});

test('registered by one battery, run for another, the card writes to the one it names', async () => {
  const a = makeDevice({ address: '192.0.2.1', modbus_id: 1, held: '' });
  const b = makeDevice({ address: '192.0.2.2', modbus_id: 2, held: '' });
  a._touSeen = false; // A could not write at all: the run must not consult it
  written = [];
  await runCard(b, '00:00-06:00/12345/+', a);
  assert.deepStrictEqual(written, [['192.0.2.2', 2, 47255, words('00:00-06:00/12345/+')]]);
  assert.strictEqual(b.settings.tou_periods, '00:00-06:00/12345/+');
  assert.strictEqual(a.settings.tou_periods, '');
});

// ── the manifest ──────────────────────────────────────────────────────────────

test('the card is offered for the Modbus battery, next to the other Time of Use card', () => {
  const ids = app.flow.actions.map((c) => c.id);
  const c = app.flow.actions.find((x) => x.id === CARD);
  assert.ok(c, 'card missing');
  assert.ok(!c.deprecated);
  assert.strictEqual(ids.indexOf(CARD), ids.indexOf('luna2000_set_excess_pv') + 1);
  assert.deepStrictEqual(c.args.map((a) => [a.type, a.name]), [['device', 'device'], ['text', 'periods']]);
  assert.strictEqual(c.args[0].filter, 'driver_id=luna2000_modbus');
  for (const l of LANGS) {
    assert.ok(c.titleFormatted[l].includes('[[periods]]'), l);
    assert.ok(c.hint[l].includes('47255'), l);
    // the example in the tooltip and the placeholder is one the card accepts
    const example = c.args[1].placeholder[l];
    assert.ok(c.hint[l].includes(example), l);
    assert.doesNotThrow(() => tou.parse(tou.fromCard(example)), l);
  }
});

test('the release: version 1.3.15 or later, with the card in the changelog', () => {
  const [ma, mi, pa] = app.version.split('.').map(Number);
  assert.ok(ma * 1e6 + mi * 1e3 + pa >= 1003015, app.version);
  const log = require(path.join(ROOT, '.homeychangelog.json'))['1.3.15'];
  assert.ok(log, 'no changelog entry for 1.3.15');
  const c = app.flow.actions.find((x) => x.id === CARD);
  for (const l of LANGS) assert.ok(log[l].includes(c.title[l]), `${l}: ${log[l]}`);
});
