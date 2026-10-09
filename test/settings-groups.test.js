'use strict';

// Device settings in groups.
//
// Homey lists a setting outside any group at the top of the page with no heading. The battery
// drivers had thirteen and six of those above their two groups, so limits, grid charging and
// the connection ran together in one unlabelled list. Since 1.2.270 they are grouped the way
// the inverter's are: Connection first, Notifications last, the same labels.
//
// Run: node --test

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');

const app = require(path.join(__dirname, '..', 'app.json'));
const driver = (id) => app.drivers.find((d) => d.id === id);
const groups = (id) => driver(id).settings.filter((s) => s.type === 'group');
const flat = (list, out = []) => {
  for (const s of list || []) (s.type === 'group' ? flat(s.children, out) : out.push(s));
  return out;
};

test('a driver that groups its settings puts every one in a group', () => {
  for (const d of app.drivers) {
    const top = d.settings || [];
    if (!top.some((s) => s.type === 'group')) continue;
    const loose = top.filter((s) => s.type !== 'group').map((s) => s.id);
    assert.deepStrictEqual(loose, [], `${d.id}: settings outside any group show up unlabelled at the top`);
  }
});

test('the LUNA2000 settings come in these groups, in this order', () => {
  assert.deepStrictEqual(groups('luna2000_modbus').map((g) => [g.label.en, g.children.map((c) => c.id)]), [
    ['Connection', ['address', 'port', 'modbus_id', 'poll_interval']],
    // tou_periods since 1.2.307: the Time of Use windows, next to the other Time of Use setting
    ['Change battery mode', ['mode_storage_working', 'mode_excess_pv_tou', 'tou_periods', 'mode_remote_dispatch', 'info_ems_battery']],
    ['Charge and discharge power', ['max_charge_power', 'max_discharge_power']],
    ['Charging from the grid', ['charge_from_grid', 'max_grid_charge_power', 'max_grid_charge_ceiling', 'grid_charge_cutoff_soc']],
    ['State of charge limits', ['charging_cutoff_capacity', 'discharge_cutoff_capacity', 'backup_power_soc']],
    ['Peak shaving', ['mode_capacity_control', 'capacity_control_soc']],
    ['Notifications', ['enable_timeline_notifications']],
  ]);
});

test('the EMMA battery settings come in these groups, in this order', () => {
  assert.deepStrictEqual(groups('luna2000_emma_modbus').map((g) => [g.label.en, g.children.map((c) => c.id)]), [
    ['Connection', ['address', 'port', 'modbus_id', 'poll_interval']],
    ['Change battery mode', ['mode_storage_working', 'mode_excess_pv_tou', 'info_ems_battery']],
    ['Charging from the grid', ['max_grid_charge_power']],
    ['Notifications', ['enable_timeline_notifications']],
  ]);
});

test('the OCPP charger settings come in these groups, in this order', () => {
  // Grouped in 1.2.271, the third driver after the inverter and the battery.
  assert.deepStrictEqual(groups('smartcharger_ocpp').map((g) => [g.label.en, g.children.map((c) => c.id)]), [
    ['Connection', ['station_id', 'ocpp_port', 'ocpp_username', 'ocpp_password']],
    ['Charger', ['charger_vendor', 'charger_model', 'number_of_phases']],
    ['Charging', ['auto_start_charging', 'default_charging_amps']],
    ['Display', ['show_vehicle_soc']],
    ['Notifications', ['enable_timeline_notifications']],
  ]);
});

test('the groups a driver shares with the inverter carry the same names', () => {
  const sun = Object.fromEntries(groups('sun2000_modbus').map((g) => [g.label.en, g.label]));
  for (const id of ['luna2000_modbus', 'luna2000_emma_modbus', 'smartcharger_ocpp']) {
    for (const g of groups(id)) {
      if (sun[g.label.en]) assert.deepStrictEqual(g.label, sun[g.label.en], `${id}: ${g.label.en}`);
    }
  }
});

test('every group is named in all three languages, and no setting sits in two', () => {
  for (const id of ['luna2000_modbus', 'luna2000_emma_modbus', 'smartcharger_ocpp']) {
    for (const g of groups(id)) for (const lang of ['en', 'de', 'nl']) assert.ok(g.label[lang], `${id}: ${g.label.en} (${lang})`);
    const ids = flat(driver(id).settings).map((s) => s.id);
    assert.strictEqual(new Set(ids).size, ids.length, `${id}: a setting appears twice`);
  }
});

test('every driver puts every setting in a group, Connection first, named like the inverter\'s', () => {
  // 1.2.277: the drivers that were still a plain list (DTSU666, SDongle, the EMMA devices, the
  // cloud drivers, the kiosk, energy management) follow the inverter too.
  const named = Object.fromEntries(groups('sun2000_modbus').map((g) => [g.label.en, g.label]));
  const CONNECTS = ['address', 'base_url', 'kiosk_url', 'station_id', 'homey_api_key'];
  let checked = 0;
  for (const d of app.drivers) {
    const top = d.settings || [];
    if (!top.length) continue;
    checked++;
    assert.deepStrictEqual(top.filter((s) => s.type !== 'group').map((s) => s.id), [], `${d.id}: settings outside any group`);
    if (flat(top).some((s) => CONNECTS.includes(s.id))) {
      assert.strictEqual(top[0].label.en, 'Connection', `${d.id}: Connection is not the first group`);
      assert.deepStrictEqual(top[0].label, named.Connection, `${d.id}: Connection is named differently from the inverter's`);
    }
    if (flat(top).some((s) => s.id === 'enable_timeline_notifications')) {
      const n = top.find((g) => g.label.en === 'Notifications');
      assert.ok(n && n.children.some((c) => c.id === 'enable_timeline_notifications'), `${d.id}: the notification switch is not under Notifications`);
      assert.deepStrictEqual(n.label, named.Notifications, `${d.id}: Notifications is named differently`);
    }
  }
  assert.ok(checked >= 18, `only ${checked} drivers with settings found`);
});
