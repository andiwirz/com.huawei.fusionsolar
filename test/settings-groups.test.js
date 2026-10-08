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
    ['Change battery mode', ['mode_storage_working', 'mode_excess_pv_tou', 'mode_remote_dispatch']],
    ['What the battery modes do', ['info_working_mode', 'info_remote_mode', 'info_ems_battery']],
    ['Charge and discharge power', ['max_charge_power', 'max_discharge_power']],
    ['Charging from the grid', ['charge_from_grid', 'max_grid_charge_power', 'grid_charge_cutoff_soc']],
    ['State of charge limits', ['charging_cutoff_capacity', 'discharge_cutoff_capacity', 'backup_power_soc']],
    ['Notifications', ['enable_timeline_notifications']],
  ]);
});

test('the EMMA battery settings come in these groups, in this order', () => {
  assert.deepStrictEqual(groups('luna2000_emma_modbus').map((g) => [g.label.en, g.children.map((c) => c.id)]), [
    ['Connection', ['address', 'port', 'modbus_id', 'poll_interval']],
    ['Change battery mode', ['mode_storage_working', 'mode_excess_pv_tou']],
    ['What the battery modes do', ['info_working_mode', 'info_ems_battery']],
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
