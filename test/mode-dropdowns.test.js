'use strict';

// Battery and feed-in modes are changed from dropdowns in the device settings (1.2.266).
//
// Issue #35, gsommer: the device tiles drew each mode as a scroll wheel that wrote whatever it
// landed on, the moment it landed. On the inverter that switched off a 5 kW feed-in limit his
// house connection depends on; on the battery he found the remote dispatch mode on Local
// Control after reopening the tile. 1.2.263 took the wheel off the inverter. Here the battery
// tiles lose theirs too, and all of them get what he asked for instead: a dropdown in the
// device settings that lists every value and writes only on Save.
//
// A dropdown has a trap of its own — Homey shows a stored value it does not list as its first
// entry, and saving would then write that entry — so a dropdown is filled only with listed
// values from the device, and written only once the device's real value has been read.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const app  = require(path.join(ROOT, 'app.json'));
const locales = Object.fromEntries(['en', 'de', 'nl'].map((l) => [l, require(path.join(ROOT, 'locales', `${l}.json`))]));

const modes = require(path.join(ROOT, 'lib', 'mode-settings'));

// Load the three drivers with Homey stubbed and every Modbus write recorded instead of sent.
// A register in `refuse` fails its write, as a dongle that does not answer would.
const writes = [];
const refuse = new Set();
let release = null; // when set, a write waits for it — to watch one write finish before the next
const record = async (host, port, unit, reg, value) => {
  writes.push({ host, port, unit, reg, value });
  if (release) await release;
  if (refuse.has(reg)) {
    await new Promise((r) => setImmediate(r)); // a refusal arrives over the network, after Homey has stored the page
    throw new Error('Timed out');
  }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return { Device: class {} };
  if (request === '../../lib/modbus-client') {
    const real = origLoad.call(this, request, parent, isMain);
    return { ...real, writeModbusRegister: record, writeModbusU32: record };
  }
  return origLoad.call(this, request, parent, isMain);
};
const LunaDevice    = require(path.join(ROOT, 'drivers', 'luna2000_modbus', 'device.js'));
const EmmaDevice    = require(path.join(ROOT, 'drivers', 'luna2000_emma_modbus', 'device.js'));
const InverterDevice = require(path.join(ROOT, 'drivers', 'sun2000_modbus', 'device.js'));
Module._load = origLoad;

const source = (driver) => fs.readFileSync(path.join(ROOT, 'drivers', driver, 'device.js'), 'utf8');

const t = (key, lang = 'en') => key.split('.').reduce((o, k) => o[k], locales[lang]);

// A device with settings that behave like Homey's: getSetting reads the stored values, and
// setSettings stores — and is recorded, so a test can see what the poll or a revert put there.
function makeDevice(Proto, settings = {}) {
  const d = Object.create(Proto.prototype);
  d.settings = { address: '192.0.2.10', port: 502, modbus_id: 1, enable_timeline_notifications: false, ...settings };
  d.settingWrites = [];
  d.caps = {};
  d.capabilityListeners = [];
  d.logs = [];
  d.notes = [];
  const card = () => ({ registerRunListener() { return this; }, registerArgumentAutocompleteListener() { return this; }, trigger: async () => {} });
  d.homey = {
    __: (k) => t(k),
    manifest: app,
    i18n: { getLanguage: () => 'en' },
    notifications: { createNotification: async () => {} },
    flow: { getActionCard: card, getConditionCard: card, getDeviceTriggerCard: card, getTriggerCard: card },
    setTimeout: () => null, clearTimeout: () => {}, setInterval: () => null, clearInterval: () => {},
  };
  d.getName = () => 'Battery';
  d.getSetting = (k) => d.settings[k];
  d.setSettings = async (o) => { d.settingWrites.push({ ...o }); Object.assign(d.settings, o); };
  d.registerCapabilityListener = (cap) => { d.capabilityListeners.push(cap); };
  d.getCapabilityValue = (c) => d.caps[c] ?? null;
  d.hasCapability = () => true;
  d._set = async (c, v) => { d.caps[c] = v; };
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = (...a) => d.logs.push(a.join(' '));
  if (d._noteWrite) {
    const real = d._noteWrite;
    d._noteWrite = function (...a) { d.notes.push(a); return real.apply(this, a); };
  }
  return d;
}

// What Homey hands onSettings: the stored values before, the page as saved, the keys that differ.
const save = (d, changes) => {
  const oldSettings = { ...d.settings };
  const newSettings = { ...d.settings, ...changes };
  return d.onSettings({ oldSettings, newSettings, changedKeys: Object.keys(changes) })
    .then(() => Object.assign(d.settings, changes)); // Homey stores the page once onSettings returns
};

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const reset = () => { writes.length = 0; refuse.clear(); release = null; };

// The dropdowns, by driver: [setting id, capability, register, ids].
const DROPDOWNS = {
  luna2000_modbus: [
    ['mode_storage_working', 'storage_working_mode_settings',        47086, ['0', '1', '2', '3', '4', '5', '6']],
    ['mode_excess_pv_tou',   'storage_excess_pv_energy_use_in_tou',  47299, ['0', '1']],
    ['mode_remote_dispatch', 'remote_charge_discharge_control_mode', 47589, ['0', '1', '2', '3', '4', '5']],
  ],
  luna2000_emma_modbus: [
    ['mode_storage_working', 'storage_working_mode_settings',       40000, ['2', '4', '5', '6']],
    ['mode_excess_pv_tou',   'storage_excess_pv_energy_use_in_tou', 40001, ['0', '1']],
  ],
  sun2000_modbus: [
    ['mode_active_power_control', 'activepower_controlmode', 47415, ['0', '1', '5', '6', '7']],
  ],
};
const PROTO = { luna2000_modbus: LunaDevice, luna2000_emma_modbus: EmmaDevice, sun2000_modbus: InverterDevice };

function flatSettings(list, out = []) {
  for (const s of list || []) {
    if (s.type === 'group') flatSettings(s.children, out);
    else out.push(s);
  }
  return out;
}
const driver = (id) => app.drivers.find((d) => d.id === id);
const setting = (driverId, id) => flatSettings(driver(driverId).settings).find((s) => s.id === id);

// ── the tiles ────────────────────────────────────────────────────────────────────

test('the battery tiles show their modes and do not offer to change them', () => {
  for (const cap of ['storage_working_mode_settings', 'storage_force_charge_discharge',
    'storage_excess_pv_energy_use_in_tou', 'remote_charge_discharge_control_mode', 'activepower_controlmode']) {
    assert.strictEqual(app.capabilities[cap].setable, false, `${cap}: the tile can write to the device again`);
    assert.strictEqual(app.capabilities[cap].uiComponent, 'sensor', `${cap}: still drawn as a scroll wheel`);
  }
});

test('no driver registers a capability listener that could write a mode', () => {
  // setable: false stops Homey offering the wheel; this is the second lock, for a Homey app
  // that still draws the old wheel from a cached definition.
  for (const id of Object.keys(PROTO)) {
    const src = source(id);
    assert.ok(!/registerCapabilityListener\s*\(/.test(src), `${id}: a capability listener is back`);
    assert.ok(!/this\._registerControlListeners\s*\(\s*\)/.test(src), `${id}: onInit registers the tile listeners again`);
    assert.strictEqual(typeof PROTO[id].prototype._registerControlListeners, 'undefined', `${id}: the listener method is back`);
  }
});

test('the flow cards still register, and register no capability listener on the side', () => {
  for (const Proto of [LunaDevice, EmmaDevice]) {
    const d = makeDevice(Proto);
    d._registerFlowActions();
    assert.deepStrictEqual(d.capabilityListeners, []);
  }
});

// ── the dropdowns in the manifest ────────────────────────────────────────────────

// A mode with no tile has no capability to compare against; peak shaving (1.2.274) is covered
// in test/grid-ceiling-peak-shaving.test.js.
const TILELESS = { luna2000_modbus: ['mode_capacity_control'] };

test('each driver has its dropdowns, and nothing else is offered as one', () => {
  for (const [driverId, list] of Object.entries(DROPDOWNS)) {
    const found = flatSettings(driver(driverId).settings).filter((s) => /^mode_/.test(s.id)).map((s) => s.id);
    assert.deepStrictEqual(found, [...list.map(([key]) => key), ...(TILELESS[driverId] || [])], driverId);
    for (const [key] of list) assert.strictEqual(setting(driverId, key).type, 'dropdown', `${driverId}/${key}`);
  }
});

test('force charge/discharge has no dropdown — it is a command, not a setting', () => {
  for (const s of flatSettings(driver('luna2000_modbus').settings)) {
    assert.ok(!(s.values || []).some((v) => /^(Stop|Charge|Discharge)$/.test(v.label && v.label.en)),
      `${s.id} offers force charge/discharge`);
  }
});

test('a dropdown lists exactly the values the driver writes', () => {
  for (const [driverId, list] of Object.entries(DROPDOWNS)) {
    for (const [key, , , ids] of list) {
      assert.deepStrictEqual(setting(driverId, key).values.map((v) => v.id), ids, `${driverId}/${key}`);
    }
  }
});

test('a dropdown uses the words the tile uses, in every language', () => {
  for (const [driverId, list] of Object.entries(DROPDOWNS)) {
    for (const [key, cap] of list) {
      for (const v of setting(driverId, key).values) {
        const title = app.capabilities[cap].values.find((c) => c.id === v.id).title;
        for (const lang of ['en', 'de', 'nl']) {
          assert.strictEqual(v.label[lang], title[lang], `${driverId}/${key}/${v.id} (${lang})`);
        }
      }
    }
  }
});

test('every dropdown starts on the harmless value, and the value is one it lists', () => {
  const expected = {
    'luna2000_modbus/mode_storage_working': '2', 'luna2000_modbus/mode_excess_pv_tou': '0',
    'luna2000_modbus/mode_remote_dispatch': '0', 'luna2000_emma_modbus/mode_storage_working': '2',
    'luna2000_emma_modbus/mode_excess_pv_tou': '0', 'sun2000_modbus/mode_active_power_control': '0',
  };
  for (const [driverId, list] of Object.entries(DROPDOWNS)) {
    for (const [key, , , ids] of list) {
      const s = setting(driverId, key);
      assert.strictEqual(s.value, expected[`${driverId}/${key}`], `${driverId}/${key}`);
      assert.ok(ids.includes(s.value), `${driverId}/${key}: the default is not in the list`);
    }
  }
});

test('every dropdown says in all three languages that it writes on Save', () => {
  for (const [driverId, list] of Object.entries(DROPDOWNS)) {
    for (const [key] of list) {
      const s = setting(driverId, key);
      for (const lang of ['en', 'de', 'nl']) {
        assert.ok(s.label[lang] && s.hint[lang], `${driverId}/${key}: no ${lang} text`);
      }
      assert.match(s.hint.en, /only when you press Save/);
      assert.match(s.hint.de, /erst beim Speichern/);
      assert.match(s.hint.nl, /pas .* als je op Opslaan drukt/);
    }
  }
});

test('the battery dropdowns end with the advice on charging by price or forecast', () => {
  // Since 1.2.272 the group carries the one note the modes are the wrong tool for.
  for (const driverId of ['luna2000_modbus', 'luna2000_emma_modbus']) {
    const top = driver(driverId).settings;
    const i = top.findIndex((s) => s.type === 'group' && s.label.en === 'Change battery mode');
    assert.ok(i >= 0, `${driverId}: no "Change battery mode" group`);
    const kids = top[i].children;
    assert.strictEqual(kids[kids.length - 1].id, 'info_ems_battery', driverId);
    assert.strictEqual(top[i].label.de, 'Batteriemodus ändern');
    assert.strictEqual(top[i].label.nl, 'Batterijmodus wijzigen');
  }
});

test('the feed-in mode dropdown comes first among the feed-in settings it governs', () => {
  const group = driver('sun2000_modbus').settings.find((s) => s.type === 'group' && s.label.en === 'Feed-in Power Control');
  assert.strictEqual(group.children[0].id, 'mode_active_power_control');
});

test('the refusals exist in all three languages', () => {
  for (const lang of ['en', 'de', 'nl']) {
    assert.ok(t('modbus.modes.notReadYet', lang), `${lang}: notReadYet`);
    assert.ok(t('modbus.modes.invalid', lang), `${lang}: invalid`);
  }
});

// ── lib/mode-settings: which saves may write ─────────────────────────────────────

const SPEC = {
  a: { cap: 'cap_a', reg: 100, ids: ['0', '1', '2'] },
  b: { cap: 'cap_b', reg: 200, ids: ['0', '1'] },
};
const libDevice = (seen = { a: true, b: true }) => ({ homey: { __: (k) => `msg:${k}` }, _modeSeen: seen });

test('a save that changes no dropdown writes no mode', () => {
  assert.deepStrictEqual(modes.pendingModeWrites(libDevice(), SPEC, { a: '1', b: '0' }, ['poll_interval']), []);
});

test('a changed dropdown is written, as the string the capability uses', () => {
  assert.deepStrictEqual(modes.pendingModeWrites(libDevice(), SPEC, { a: 2, b: '0' }, ['a']),
    [{ key: 'a', cap: 'cap_a', reg: 100, value: '2' }]);
});

test('before the device has been read, the save is refused — the dropdown only shows its default', () => {
  assert.throws(() => modes.pendingModeWrites(libDevice({ b: true }), SPEC, { a: '1' }, ['a']), { message: 'msg:modbus.modes.notReadYet' });
  assert.throws(() => modes.pendingModeWrites(libDevice(null), SPEC, { a: '1' }, ['a']), { message: 'msg:modbus.modes.notReadYet' });
});

test('a value the register does not take is refused, whatever put it there', () => {
  assert.throws(() => modes.pendingModeWrites(libDevice(), SPEC, { b: '2' }, ['b']), { message: 'msg:modbus.modes.invalid' });
  assert.throws(() => modes.pendingModeWrites(libDevice(), SPEC, { b: null }, ['b']), { message: 'msg:modbus.modes.invalid' });
});

test('one bad dropdown refuses the whole save, even when another one in it is fine', () => {
  assert.throws(() => modes.pendingModeWrites(libDevice({ a: true }), SPEC, { a: '1', b: '1' }, ['a', 'b']));
});

test('the poll filling the dropdowns writes nothing back', () => {
  const d = libDevice();
  d._updatingSettingFromModbus = true;
  assert.deepStrictEqual(modes.pendingModeWrites(d, SPEC, { a: '1' }, ['a']), []);
});

// ── lib/mode-settings: filling the dropdowns from the device ─────────────────────

function syncDevice(stored = {}) {
  const d = { settings: { ...stored }, calls: [], logs: [] };
  d.getSetting = (k) => d.settings[k];
  d.setSettings = async (o) => { d.calls.push({ o: { ...o }, flag: d._updatingSettingFromModbus }); Object.assign(d.settings, o); };
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = (...a) => d.logs.push(a.join(' '));
  return d;
}

test('the poll puts the device\'s mode into the dropdown, flagged as its own update', async () => {
  const d = syncDevice({ a: '2', b: '0' });
  await modes.syncModeSettings(d, SPEC, { a: 1, b: 0 });
  assert.deepStrictEqual(d.calls, [{ o: { a: '1' }, flag: true }]);
  assert.strictEqual(d._updatingSettingFromModbus, false);
  assert.deepStrictEqual(d._modeSeen, { a: true, b: true });
});

test('a mode that matches already is not written again, but counts as read', async () => {
  const d = syncDevice({ a: '1' });
  await modes.syncModeSettings(d, SPEC, { a: 1 });
  assert.deepStrictEqual(d.calls, []);
  assert.deepStrictEqual(d._modeSeen, { a: true });
});

test('a mode missing from this read is left alone, and does not count as read', async () => {
  // The battery's modes come in different halves of a split read.
  const d = syncDevice({ a: '2', b: '1' });
  await modes.syncModeSettings(d, SPEC, { a: null, b: undefined });
  assert.deepStrictEqual(d.calls, []);
  assert.deepStrictEqual(d._modeSeen, undefined);
});

test('a value the dropdown does not list never reaches it — Homey would show the first entry instead', async () => {
  const d = syncDevice({ b: '1' });
  await modes.syncModeSettings(d, SPEC, { b: 7 });
  assert.deepStrictEqual(d.calls, []);
  assert.ok(!(d._modeSeen && d._modeSeen.b), 'an unlisted value unlocks the dropdown for saving');
});

test('a failing setSettings is logged and does not leave the poll flag up', async () => {
  const d = syncDevice({ a: '0' });
  d.setSettings = async () => { throw new Error('busy'); };
  await modes.syncModeSettings(d, SPEC, { a: 2 });
  assert.strictEqual(d._updatingSettingFromModbus, false);
  assert.ok(d.logs.some((l) => /mode dropdowns failed: busy/.test(l)));
});

// ── lib/mode-settings: what the log says about the modes (1.2.267) ───────────────
//
// "When did my mode change, and what changed it" was the question issue #35 could not answer
// from a log: a mode read back different from before fired a flow trigger and left no line.

const LUNA_SPEC = {
  mode_storage_working: { cap: 'storage_working_mode_settings',        reg: 47086, ids: ['0', '1', '2', '3', '4', '5', '6'] },
  mode_remote_dispatch: { cap: 'remote_charge_discharge_control_mode', reg: 47589, ids: ['0', '1', '2', '3', '4', '5'] },
};
const logDevice = (stored) => Object.assign(syncDevice(stored), { homey: { manifest: app } });
const modeLines = (d) => d.logs.filter((l) => /^Mode dropdown/.test(l));

test('the first read after a start logs every mode once, with the name the tile shows', async () => {
  const d = logDevice({ mode_storage_working: '2', mode_remote_dispatch: '0' });
  await modes.syncModeSettings(d, LUNA_SPEC, { mode_storage_working: 2, mode_remote_dispatch: 0 });
  assert.deepStrictEqual(modeLines(d), [
    'Mode dropdown filled [mode_storage_working]: 2 = Maximise Self-Consumption',
    'Mode dropdown filled [mode_remote_dispatch]: 0 = Local Control',
  ]);
  assert.deepStrictEqual(d.calls, [], 'nothing to store, nothing stored');
});

test('a mode that changed while the app was not running says what the dropdown held', async () => {
  const d = logDevice({ mode_storage_working: '2' });
  await modes.syncModeSettings(d, LUNA_SPEC, { mode_storage_working: 5 });
  assert.deepStrictEqual(modeLines(d), ['Mode dropdown filled [mode_storage_working]: 5 = Time of Use (LUNA2000), setting held 2']);
});

test('a dropdown that never held a value is filled without a "held" remark', async () => {
  const d = logDevice({});
  await modes.syncModeSettings(d, LUNA_SPEC, { mode_remote_dispatch: 0 });
  assert.deepStrictEqual(modeLines(d), ['Mode dropdown filled [mode_remote_dispatch]: 0 = Local Control']);
});

test('after that, an unchanged mode logs nothing, poll after poll', async () => {
  const d = logDevice({ mode_storage_working: '2' });
  await modes.syncModeSettings(d, LUNA_SPEC, { mode_storage_working: 2 });
  d.logs.length = 0;
  for (let i = 0; i < 3; i++) await modes.syncModeSettings(d, LUNA_SPEC, { mode_storage_working: 2 });
  assert.deepStrictEqual(d.logs, []);
});

test('a mode changed elsewhere is logged once, from what to what', async () => {
  const d = logDevice({ mode_remote_dispatch: '1' });
  await modes.syncModeSettings(d, LUNA_SPEC, { mode_remote_dispatch: 1 });
  d.logs.length = 0;
  await modes.syncModeSettings(d, LUNA_SPEC, { mode_remote_dispatch: 0 });
  await modes.syncModeSettings(d, LUNA_SPEC, { mode_remote_dispatch: 0 });
  assert.deepStrictEqual(d.logs, ['Mode dropdown follows the device [mode_remote_dispatch]: 1 → 0 = Local Control']);
});

test('a save from the dropdown leaves no "follows" line — the dropdown already holds the value', async () => {
  const d = logDevice({ mode_storage_working: '2' });
  await modes.syncModeSettings(d, LUNA_SPEC, { mode_storage_working: 2 });
  d.logs.length = 0;
  d.settings.mode_storage_working = '5'; // what Homey stores when the page is saved
  await modes.syncModeSettings(d, LUNA_SPEC, { mode_storage_working: 5 });
  assert.deepStrictEqual(d.logs, []);
});

test('a dropdown that could not take the new value does not claim it did', async () => {
  const d = logDevice({ mode_storage_working: '2', mode_remote_dispatch: '0' });
  const store = d.setSettings;
  d.setSettings = async () => { throw new Error('busy'); };
  await modes.syncModeSettings(d, LUNA_SPEC, { mode_storage_working: 5, mode_remote_dispatch: 0 });
  assert.deepStrictEqual(modeLines(d), ['Mode dropdown filled [mode_remote_dispatch]: 0 = Local Control'],
    'the unchanged mode is still logged, the one that failed is not');
  d.logs.length = 0;
  d.setSettings = store;
  await modes.syncModeSettings(d, LUNA_SPEC, { mode_storage_working: 5, mode_remote_dispatch: 0 });
  assert.deepStrictEqual(d.logs, ['Mode dropdown follows the device [mode_storage_working]: 2 → 5 = Time of Use (LUNA2000)']);
});

test('a later change that could not be stored is not logged as followed either', async () => {
  const d = logDevice({ mode_remote_dispatch: '1' });
  await modes.syncModeSettings(d, LUNA_SPEC, { mode_remote_dispatch: 1 });
  d.logs.length = 0;
  d.setSettings = async () => { throw new Error('busy'); };
  await modes.syncModeSettings(d, LUNA_SPEC, { mode_remote_dispatch: 0 });
  assert.deepStrictEqual(modeLines(d), []);
  assert.ok(d.logs.some((l) => /mode dropdowns failed: busy/.test(l)));
});

test('a mode missing from this read, or not on the list, logs nothing', async () => {
  const d = logDevice({ mode_storage_working: '2' });
  await modes.syncModeSettings(d, LUNA_SPEC, { mode_storage_working: null, mode_remote_dispatch: 9 });
  assert.deepStrictEqual(d.logs, []);
});

test('without a manifest to hand, the line still carries the number', async () => {
  const d = syncDevice({ a: '0' });
  await modes.syncModeSettings(d, SPEC, { a: 2 });
  assert.deepStrictEqual(modeLines(d), ['Mode dropdown filled [a]: 2, setting held 0']);
});

test('the inverter\'s feed-in mode is logged by name as well — the 47415 read-change line', async () => {
  const d = logDevice({ mode_active_power_control: '6' });
  const spec = { mode_active_power_control: { cap: 'activepower_controlmode', reg: 47415, ids: ['0', '1', '5', '6', '7'] } };
  await modes.syncModeSettings(d, spec, { mode_active_power_control: 6 });
  await modes.syncModeSettings(d, spec, { mode_active_power_control: 0 });
  assert.deepStrictEqual(modeLines(d), [
    'Mode dropdown filled [mode_active_power_control]: 6 = Limited by Power (kW)',
    'Mode dropdown follows the device [mode_active_power_control]: 6 → 0 = Unlimited',
  ]);
});

// ── lib/mode-settings: writing ───────────────────────────────────────────────────

function writeDevice() {
  const d = { caps: {}, logs: [], flags: [] };
  d.log = (...a) => d.logs.push(a.join(' '));
  d.error = (...a) => d.logs.push(a.join(' '));
  d._set = async (c, v) => { d.caps[c] = v; };
  return d;
}

test('writes go out one after the other, with the poll paused throughout', async () => {
  const d = writeDevice();
  const order = [];
  const write = async (w) => {
    d.flags.push(d._writeInProgress);
    order.push(`start ${w.reg}`);
    await new Promise((r) => setImmediate(r));
    order.push(`end ${w.reg}`);
  };
  await modes.applyModeWrites(d, [
    { key: 'a', cap: 'cap_a', reg: 100, value: '1' },
    { key: 'b', cap: 'cap_b', reg: 200, value: '0' },
  ], write, async () => {});
  assert.deepStrictEqual(order, ['start 100', 'end 100', 'start 200', 'end 200']);
  assert.deepStrictEqual(d.flags, [true, true]);
  assert.strictEqual(d._writeInProgress, false);
  assert.deepStrictEqual(d.caps, { cap_a: '1', cap_b: '0' });
});

test('a refused write is put back, leaves the tile alone, and the next write still goes out', async () => {
  const d = writeDevice();
  const reverted = [];
  await modes.applyModeWrites(d, [
    { key: 'a', cap: 'cap_a', reg: 100, value: '1' },
    { key: 'b', cap: 'cap_b', reg: 200, value: '0' },
  ], async (w) => { if (w.reg === 100) throw new Error('Timed out'); },
  async (w, err) => { reverted.push([w.key, err.message, d._writeInProgress]); });
  assert.deepStrictEqual(reverted, [['a', 'Timed out', true]]);
  assert.deepStrictEqual(d.caps, { cap_b: '0' });
  assert.strictEqual(d._writeInProgress, false);
});

test('the poll is resumed even when putting a dropdown back fails', async () => {
  const d = writeDevice();
  await assert.rejects(modes.applyModeWrites(d, [{ key: 'a', cap: 'cap_a', reg: 100, value: '1' }],
    async () => { throw new Error('Timed out'); }, async () => { throw new Error('revert broke'); }));
  assert.strictEqual(d._writeInProgress, false);
});

test('no writes, no pause', async () => {
  const d = writeDevice();
  d._writeInProgress = 'untouched';
  await modes.applyModeWrites(d, [], async () => { throw new Error('called'); }, async () => {});
  assert.strictEqual(d._writeInProgress, 'untouched');
});

test('putting a dropdown back stores the old value, flagged so it is not written again', async () => {
  const d = syncDevice({ a: '2' });
  await modes.revertModeSetting(d, 'a', '0', new Error('Timed out'));
  assert.deepStrictEqual(d.calls, [{ o: { a: '0' }, flag: true }]);
  assert.strictEqual(d._updatingSettingFromModbus, false);
  assert.ok(d.logs.some((l) => /Write failed \[a\], setting taken back: Timed out/.test(l)));
});

test('with no old value to go back to, nothing is stored', async () => {
  const d = syncDevice({ a: '2' });
  await modes.revertModeSetting(d, 'a', undefined, new Error('x'));
  assert.deepStrictEqual(d.calls, []);
});

// ── the drivers ──────────────────────────────────────────────────────────────────

const seenAll = (d, driverId) => { d._modeSeen = Object.fromEntries(DROPDOWNS[driverId].map(([k]) => [k, true])); };

test('LUNA2000: a saved working mode is written to 47086, and the tile follows', async () => {
  reset();
  const d = makeDevice(LunaDevice, { mode_storage_working: '2' });
  seenAll(d, 'luna2000_modbus');
  await save(d, { mode_storage_working: '5' });
  await settle();
  assert.deepStrictEqual(writes, [{ host: '192.0.2.10', port: 502, unit: 1, reg: 47086, value: 5 }]);
  assert.strictEqual(d.caps.storage_working_mode_settings, '5');
  assert.strictEqual(d._writeInProgress, false);
});

test('LUNA2000: every mode goes to its own register, one after the other', async () => {
  reset();
  const d = makeDevice(LunaDevice, { mode_storage_working: '2', mode_excess_pv_tou: '0', mode_remote_dispatch: '1' });
  seenAll(d, 'luna2000_modbus');
  let open;
  release = new Promise((r) => { open = r; });
  await save(d, { mode_storage_working: '5', mode_excess_pv_tou: '1', mode_remote_dispatch: '0' });
  await settle();
  assert.strictEqual(writes.length, 1, 'the second write did not wait for the first');
  open();
  await settle();
  assert.deepStrictEqual(writes.map((w) => [w.reg, w.value]), [[47086, 5], [47299, 1], [47589, 0]]);
});

test('LUNA2000: a save changing the address writes the mode to the new address', async () => {
  reset();
  const d = makeDevice(LunaDevice, { mode_remote_dispatch: '1' });
  seenAll(d, 'luna2000_modbus');
  d._stopPolling = async () => {};
  d._startPolling = async () => {};
  d._fetchAndUpdate = async () => {};
  await save(d, { address: '192.0.2.99', port: '6607', modbus_id: '3', mode_remote_dispatch: '0' });
  await settle();
  assert.deepStrictEqual(writes, [{ host: '192.0.2.99', port: 6607, unit: 3, reg: 47589, value: 0 }]);
});

test('LUNA2000: before the battery has been read, the save is refused and nothing at all is written', async () => {
  reset();
  const d = makeDevice(LunaDevice, { mode_storage_working: '2', charge_from_grid: false });
  d._settingsInitialized = true; // the other settings would be written — they must not be, either
  await assert.rejects(save(d, { mode_storage_working: '0', charge_from_grid: true }), { message: t('modbus.modes.notReadYet') });
  await settle();
  assert.deepStrictEqual(writes, []);
});

test('LUNA2000: a refused write puts the dropdown back and leaves the tile alone', async () => {
  reset();
  refuse.add(47589);
  const d = makeDevice(LunaDevice, { mode_remote_dispatch: '0' });
  d.caps.remote_charge_discharge_control_mode = '0';
  seenAll(d, 'luna2000_modbus');
  await save(d, { mode_remote_dispatch: '3' });
  await settle();
  assert.deepStrictEqual(d.settingWrites, [{ mode_remote_dispatch: '0' }]);
  assert.strictEqual(d.settings.mode_remote_dispatch, '0');
  assert.strictEqual(d.caps.remote_charge_discharge_control_mode, '0');
  assert.strictEqual(d._writeInProgress, false);
});

test('LUNA2000: the timeline names the mode it went back to, not its register value', async () => {
  reset();
  refuse.add(47086);
  const d = makeDevice(LunaDevice, { mode_storage_working: '2', enable_timeline_notifications: true });
  const notes = [];
  d.homey.notifications.createNotification = async (n) => { notes.push(n.excerpt); };
  seenAll(d, 'luna2000_modbus');
  await save(d, { mode_storage_working: '4' });
  await settle();
  assert.strictEqual(notes.length, 1);
  assert.match(notes[0], /Storage working mode could not be written \(Timed out\) — put back to Maximise Self-Consumption\./);
});

test('EMMA: a saved working mode is written to 40000 on unit 0, and noted for the conflict check', async () => {
  reset();
  const d = makeDevice(EmmaDevice, { modbus_id: undefined, mode_storage_working: '2' });
  seenAll(d, 'luna2000_emma_modbus');
  await save(d, { mode_storage_working: '6' });
  await settle();
  assert.deepStrictEqual(writes, [{ host: '192.0.2.10', port: 502, unit: 0, reg: 40000, value: 6 }]);
  assert.strictEqual(d.caps.storage_working_mode_settings, '6');
  assert.deepStrictEqual(d.notes, [['storage_working_mode_settings', 40000, 6, 'settings']]);
});

test('EMMA: a mode the EMMA does not take is refused, even though the LUNA2000 would', async () => {
  reset();
  const d = makeDevice(EmmaDevice, { mode_storage_working: '2' });
  seenAll(d, 'luna2000_emma_modbus');
  await assert.rejects(save(d, { mode_storage_working: '1' }), { message: t('modbus.modes.invalid') });
  await settle();
  assert.deepStrictEqual(writes, []);
});

test('EMMA: a refused write puts the dropdown back', async () => {
  reset();
  refuse.add(40001);
  const d = makeDevice(EmmaDevice, { mode_excess_pv_tou: '0' });
  seenAll(d, 'luna2000_emma_modbus');
  await save(d, { mode_excess_pv_tou: '1' });
  await settle();
  assert.deepStrictEqual(d.settingWrites, [{ mode_excess_pv_tou: '0' }]);
  assert.strictEqual(d.caps.storage_excess_pv_energy_use_in_tou, undefined);
});

test('SUN2000: a saved feed-in mode is written to 47415, and the tile follows', async () => {
  reset();
  const d = makeDevice(InverterDevice, { mode_active_power_control: '0' });
  seenAll(d, 'sun2000_modbus');
  await save(d, { mode_active_power_control: '6' });
  await settle();
  assert.deepStrictEqual(writes, [{ host: '192.0.2.10', port: 502, unit: 1, reg: 47415, value: 6 }]);
  assert.strictEqual(d.caps.activepower_controlmode, '6');
});

test('SUN2000: before the inverter has been read, the feed-in mode cannot be saved', async () => {
  // The dropdown would show Unlimited — the very write that took gsommer's limit away.
  reset();
  const d = makeDevice(InverterDevice, { mode_active_power_control: '0' });
  await assert.rejects(save(d, { mode_active_power_control: '0' }), { message: t('modbus.modes.notReadYet') });
  await settle();
  assert.deepStrictEqual(writes, []);
});

test('SUN2000: a refused write puts the dropdown back', async () => {
  reset();
  refuse.add(47415);
  const d = makeDevice(InverterDevice, { mode_active_power_control: '6' });
  d.caps.activepower_controlmode = '6';
  seenAll(d, 'sun2000_modbus');
  await save(d, { mode_active_power_control: '0' });
  await settle();
  assert.deepStrictEqual(d.settingWrites, [{ mode_active_power_control: '6' }]);
  assert.strictEqual(d.caps.activepower_controlmode, '6');
});

test('every value a dropdown offers is one its driver will write', async () => {
  // The other direction of "lists exactly the values": a value on the list that the driver
  // refuses would be a dropdown entry that can never be saved.
  for (const [driverId, list] of Object.entries(DROPDOWNS)) {
    for (const [key, , reg] of list) {
      for (const { id } of setting(driverId, key).values) {
        reset();
        const d = makeDevice(PROTO[driverId], { [key]: id === '2' ? '0' : '2' });
        seenAll(d, driverId);
        await save(d, { [key]: id });
        await settle();
        assert.deepStrictEqual(writes.map((w) => [w.reg, w.value]), [[reg, Number(id)]], `${driverId}/${key}=${id}`);
      }
    }
  }
});

test('the poll fills each dropdown from the register behind it', () => {
  const luna = source('luna2000_modbus');
  assert.match(luna, /mode_storage_working: ctrl\.storageWorkingMode,/);
  assert.match(luna, /mode_excess_pv_tou: +ctrl\.storageExcessPvEnergyUseInTou,/);
  assert.match(luna, /mode_remote_dispatch: ctrl\.remoteChargeDischargeControlMode,/);
  const emma = source('luna2000_emma_modbus');
  assert.match(emma, /mode_storage_working: ctrl\.essControlMode,/);
  assert.match(emma, /mode_excess_pv_tou: +ctrl\.preferredUseSurplusPv,/);
  assert.match(source('sun2000_modbus'), /syncModeSettings\(this, MODE_SETTINGS, \{ mode_active_power_control: ctrl\.activePowerControlMode \}\)/);
});

test('the registers behind the dropdowns are the ones the flow cards write', () => {
  // Two ways to change the same mode must reach the same register.
  const luna = source('luna2000_modbus');
  for (const [, cap, reg] of DROPDOWNS.luna2000_modbus) {
    assert.match(luna, new RegExp(`${cap}: +${reg},`), `${cap} → ${reg}`);
  }
  const emma = source('luna2000_emma_modbus');
  for (const [, cap, reg] of DROPDOWNS.luna2000_emma_modbus) {
    assert.match(emma, new RegExp(`${cap}: +${reg}`), `${cap} → ${reg}`);
  }
});
