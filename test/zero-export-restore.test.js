'use strict';

// "Disable zero export" puts back what "Enable zero export" replaced (sun2000_modbus).
//
// Until 1.2.264 the pair went like this on an installation with a standing 5 kW limit — the
// situation in issue #35, and the pair the EMS fires around negative prices:
//
//     Enable zero export    47415 = 6, 47416 = 0 W     the 5000 W limit is overwritten
//     Disable zero export   47415 = 0                  Unlimited — no limit at all
//
// "Zero export off" meant "protection off". These run both cards against a recorded Modbus
// client. Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

const writes = [];
let failU32 = false;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  if (request === '../../lib/modbus-client') {
    const real = origLoad.call(this, request, parent, isMain);
    return {
      ...real,
      writeModbusRegister: async (h, p, u, reg, value) => { writes.push({ reg, value }); },
      writeModbusU32: async (h, p, u, reg, value) => {
        if (failU32) throw new Error('Req timed out');
        writes.push({ reg, value });
      },
    };
  }
  return origLoad.call(this, request, parent, isMain);
};
const InverterDevice = require(path.join('..', 'drivers', 'sun2000_modbus', 'device.js'));
Module._load = origLoad;

const app = require(path.join('..', 'app.json'));
const en  = require(path.join('..', 'locales', 'en.json'));
const KEY = 'zero_export_restore';

// A device in a given feed-in state, with the flow cards registered and their listeners kept.
function makeDevice({ mode = '6', maxFeedInW = 5000, store = {} } = {}) {
  const d = Object.create(InverterDevice.prototype);
  d.values   = { activepower_controlmode: mode };
  d.settings = { address: '192.0.2.1', port: 502, modbus_id: 1, max_feed_in_power: maxFeedInW };
  d.store    = store;
  d.logs     = [];
  d.cards    = {};
  const card = (id) => ({
    registerRunListener(fn) { d.cards[id] = fn; return this; },
    registerArgumentAutocompleteListener() { return this; },
    trigger: async () => {},
  });
  d.notes    = [];
  d.homey = {
    flow: { getActionCard: card, getConditionCard: card, getDeviceTriggerCard: card, getTriggerCard: card },
    __: (key) => key.split('.').reduce((o, k) => (o ? o[k] : undefined), en) ?? key,
    notifications: { createNotification: async (n) => { d.notes.push(n.excerpt); } },
  };
  d.getName = () => 'Inverter';
  d.getCapabilityValue = (c) => (c in d.values ? d.values[c] : null);
  d._set = async (c, v) => { d.values[c] = v; };
  d.getSetting = (k) => d.settings[k];
  d.setSettings = async (o) => { Object.assign(d.settings, o); };
  d.getStoreValue = (k) => d.store[k];
  d.setStoreValue = async (k, v) => { d.store[k] = v; };
  d.registerCapabilityListener = () => {};
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = (...a) => d.logs.push('ERROR ' + a.join(' '));
  d._registerFlowActions();
  return d;
}

// The cards are fire-and-forget; wait until the write they started has finished.
async function run(d, cardId) {
  await d.cards[cardId]({});
  for (let i = 0; i < 50 && d._writeInProgress; i++) await new Promise((r) => setImmediate(r));
}

const regs = () => writes.map((w) => `${w.reg}=${w.value}`);

// ── the reported situation ──────────────────────────────────────────────────────

test('a standing 5 kW limit comes back when zero export is switched off', async () => {
  writes.length = 0;
  const d = makeDevice({ mode: '6', maxFeedInW: 5000 });

  await run(d, 'sun2000_enable_zero_export');
  assert.deepStrictEqual(regs(), ['47415=6', '47416=0']);
  assert.deepStrictEqual({ mode: d.store[KEY].mode, w: d.store[KEY].maxFeedInW }, { mode: '6', w: 5000 });

  writes.length = 0;
  await run(d, 'sun2000_disable_zero_export');

  assert.deepStrictEqual(regs(), ['47416=5000', '47415=6'],
    'zero export off still switched the protection off');
  assert.strictEqual(d.values.activepower_controlmode, '6');
  assert.strictEqual(d.settings.max_feed_in_power, 5000, 'the setting still says 0 W');
  assert.strictEqual(d.store[KEY], null, 'the remembered state was not cleared after use');
});

test('the limit is written before the mode, so a failure leaves the restrictive side', async () => {
  // Mode first would briefly be "limited, at whatever 47416 holds" — fine here, but the rule
  // that matters is the failure case below: if the limit cannot be restored, the mode is not
  // touched at all.
  writes.length = 0;
  const d = makeDevice({ mode: '0', maxFeedInW: 5000 });
  await run(d, 'sun2000_enable_zero_export');
  writes.length = 0;
  await run(d, 'sun2000_disable_zero_export');

  const i16 = regs().indexOf('47416=5000');
  const i15 = regs().indexOf('47415=0');
  assert.ok(i16 >= 0 && i15 > i16, `order was ${regs().join(', ')}`);
});

test('if the limit cannot be written, zero export stays on and the state is kept for next time', async () => {
  writes.length = 0;
  const d = makeDevice({ mode: '6', maxFeedInW: 5000 });
  await run(d, 'sun2000_enable_zero_export');
  writes.length = 0;

  failU32 = true;
  try { await run(d, 'sun2000_disable_zero_export'); } finally { failU32 = false; }

  assert.ok(!regs().some((r) => r.startsWith('47415=')), 'the mode was changed although the limit was not restored');
  assert.strictEqual(d.store[KEY].maxFeedInW, 5000, 'the remembered limit was thrown away on a failed attempt');

  writes.length = 0;
  await run(d, 'sun2000_disable_zero_export');                    // the retry
  assert.deepStrictEqual(regs(), ['47416=5000', '47415=6']);
});

// ── other standing modes ────────────────────────────────────────────────────────

test('Unlimited before means Unlimited after — and the stored watt figure is put back too', async () => {
  writes.length = 0;
  const d = makeDevice({ mode: '0', maxFeedInW: 4200 });
  await run(d, 'sun2000_enable_zero_export');
  writes.length = 0;
  await run(d, 'sun2000_disable_zero_export');

  assert.deepStrictEqual(regs(), ['47416=4200', '47415=0']);
  assert.strictEqual(d.settings.max_feed_in_power, 4200,
    'the next switch to "limited (kW)" would find 0 W waiting');
});

test('a percentage limit before comes back as a percentage limit', async () => {
  // 47418 is never touched by "Enable zero export", so restoring the mode is enough.
  writes.length = 0;
  const d = makeDevice({ mode: '7', maxFeedInW: 3000 });
  await run(d, 'sun2000_enable_zero_export');
  writes.length = 0;
  await run(d, 'sun2000_disable_zero_export');

  assert.deepStrictEqual(regs(), ['47416=3000', '47415=7']);
});

// ── what not to remember ────────────────────────────────────────────────────────

test('enabling zero export twice does not remember zero export as the state to return to', async () => {
  writes.length = 0;
  const d = makeDevice({ mode: '6', maxFeedInW: 5000 });
  await run(d, 'sun2000_enable_zero_export');
  await run(d, 'sun2000_enable_zero_export');                     // now at 6 / 0 W

  assert.strictEqual(d.store[KEY].maxFeedInW, 5000, 'the second enable saved 0 W as "before"');
});

test('a feed-in state not known yet is not half-remembered', async () => {
  writes.length = 0;
  const d = makeDevice({ mode: null, maxFeedInW: 5000 });
  await run(d, 'sun2000_enable_zero_export');

  assert.strictEqual(d.store[KEY], undefined);
  assert.ok(d.logs.some((l) => l.includes('not known yet')));
});

// ── without a remembered state: nothing is written (1.2.312) ─────────────────────
//
// Until 1.2.312 this fell back to Unlimited whatever the inverter was doing. The state is
// cleared after every restore, so the SECOND "Disable" of an evening took a standing 5 kW
// limit off (review of 2026-10-10, Gerhard's situation in issue #35).

const outcome = async (d, cardId) => {
  try { await run(d, cardId); return null; } catch (err) { return err; }
};

test('a second "Disable" keeps the standing limit — the reported bug', async () => {
  writes.length = 0;
  const d = makeDevice({ mode: '6', maxFeedInW: 5000 });
  await run(d, 'sun2000_enable_zero_export');
  await run(d, 'sun2000_disable_zero_export');                     // restores 5000 W, clears the memory
  writes.length = 0;
  const err = await outcome(d, 'sun2000_disable_zero_export');      // again, an hour later

  assert.strictEqual(err, null, 'nothing to disable is not a failure');
  assert.deepStrictEqual(regs(), [], 'the 5 kW limit was taken off');
  assert.ok(d.logs.some((l) => l.includes('zero export is not on (mode 6, 5000 W) — nothing to disable')));
});

test('with zero export off and nothing remembered, nothing is written — limited or unlimited', async () => {
  for (const [mode, w] of [['6', 5000], ['0', 0], ['7', 3000], ['1', 0]]) {
    writes.length = 0;
    const d = makeDevice({ mode, maxFeedInW: w });
    assert.strictEqual(await outcome(d, 'sun2000_disable_zero_export'), null, `mode ${mode}`);
    assert.deepStrictEqual(regs(), [], `mode ${mode}: something was written`);
    assert.deepStrictEqual(d.notes, []);
  }
});

test('zero export switched on outside this app: nothing written, the card fails and the timeline says so', async () => {
  // Andi's call: the mode before it is unknown, so the inverter stays on the restrictive side.
  // Both kinds — the app's own (limited by power at 0 W) and Huawei's "Zero power grid
  // connection" mode, set in the SUN2000 app or by the installer.
  for (const [mode, w] of [['6', 0], ['5', 0], ['5', 5000]]) {
    writes.length = 0;
    const d = makeDevice({ mode, maxFeedInW: w });
    const err = await outcome(d, 'sun2000_disable_zero_export');

    assert.ok(err, `mode ${mode}/${w} W: the card succeeded although it did nothing`);
    assert.strictEqual(err.message, en.modbus.zeroExport.noEarlierState);
    assert.deepStrictEqual(regs(), [], `mode ${mode}: something was written`);
    assert.strictEqual(d.notes.length, 1);
    assert.match(d.notes[0], /zero export stays on/);
  }
});

test('a feed-in mode not read yet: nothing written, the card fails and asks to try again', async () => {
  writes.length = 0;
  const d = makeDevice({ mode: null, maxFeedInW: 5000 });
  const err = await outcome(d, 'sun2000_disable_zero_export');
  assert.ok(err);
  assert.strictEqual(err.message, en.modbus.zeroExport.notReadYet);
  assert.deepStrictEqual(regs(), []);
});

test('a remembered state that makes no sense is not written to the inverter', async () => {
  writes.length = 0;
  const d = makeDevice({ store: { [KEY]: { mode: '42', maxFeedInW: 'lots' } } });
  assert.strictEqual(await outcome(d, 'sun2000_disable_zero_export'), null);
  assert.deepStrictEqual(regs(), []);
});

test('the error texts exist in all three languages and point to the device settings', () => {
  const group = app.drivers.find((x) => x.id === 'sun2000_modbus').settings
    .find((g) => (g.children || []).some((c) => c.id === 'mode_active_power_control')).label;
  for (const l of ['en', 'de', 'nl']) {
    const loc = require(path.join('..', 'locales', `${l}.json`)).modbus.zeroExport;
    assert.ok(loc.notReadYet && loc.noEarlierState, l);
    assert.ok(loc.noEarlierState.includes(group[l]), `${l}: does not name "${group[l]}"`);
  }
});

// ── across a restart, and when someone changed things in between ────────────────

test('an app restart between the two cards does not lose the state to restore', async () => {
  writes.length = 0;
  const store = {};
  const d1 = makeDevice({ mode: '6', maxFeedInW: 5000, store });
  await run(d1, 'sun2000_enable_zero_export');

  const d2 = makeDevice({ mode: '6', maxFeedInW: 0, store });       // restarted, mid zero export
  writes.length = 0;
  await run(d2, 'sun2000_disable_zero_export');

  assert.deepStrictEqual(regs(), ['47416=5000', '47415=6']);
});

test('if zero export was ended elsewhere in the meantime, the earlier state still comes back, noted', async () => {
  writes.length = 0;
  const d = makeDevice({ mode: '6', maxFeedInW: 5000 });
  await run(d, 'sun2000_enable_zero_export');
  d.values.activepower_controlmode = '6';
  d.settings.max_feed_in_power = 6000;                               // changed in the SUN2000 app
  writes.length = 0;
  await run(d, 'sun2000_disable_zero_export');

  assert.deepStrictEqual(regs(), ['47416=5000', '47415=6']);
  assert.ok(d.logs.some((l) => l.includes('no longer active')));
});

// ── the cards say what they do ──────────────────────────────────────────────────

test('both cards tell the user that the earlier state is remembered and restored', () => {
  const card = (id) => app.flow.actions.find((c) => c.id === id);
  const on  = card('sun2000_enable_zero_export').hint;
  const off = card('sun2000_disable_zero_export').hint;
  for (const lang of ['en', 'de', 'nl']) {
    assert.ok(/remember|gemerkt|onthouden/.test(on[lang]), `enable hint (${lang}) does not mention it`);
    // "stellt … wieder her" is two words in German — the first version of this test looked for
    // one and failed against a correct hint.
    assert.ok(/put(s)? (them|back)|wieder ?her|terug/.test(off[lang]), `disable hint (${lang}) does not mention it`);
    assert.ok(!/unbegrenzt ins Netz|export surplus solar power to the grid freely|weer onbeperkt/.test(off[lang]),
      `disable hint (${lang}) still promises unlimited export`);
  }
});
