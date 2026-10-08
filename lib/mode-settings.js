'use strict';

/**
 * Battery and inverter modes changed from a dropdown in the device settings, not from a
 * scroll wheel on the device tile.
 *
 * Reported in issue #35 by gsommer. The tile's picker is a wheel that shows a few entries at
 * a time and writes whatever it lands on the moment it lands, with no confirmation — and in
 * his log, opening the inverter was enough for it to write the top entry: Unlimited, over a
 * 5 kW feed-in limit his house connection depends on. The battery tile had the same wheels,
 * with Adaptive, Stop, Feed to Grid and Local Control on top, and his remote dispatch mode
 * had been found on Local Control after reopening the tile.
 *
 * What he asked for is what device settings already offer: a dropdown that shows the
 * current value, lists every value at once, and writes nothing until Save is pressed. The
 * tile keeps showing each mode as plain text.
 *
 * A dropdown has a trap of its own, and both rules below exist for it. Homey shows a
 * dropdown whose stored value is not in its list as its first entry — and saving the page
 * would then store, and here write, that entry. So:
 *   · only values from the list ever reach a dropdown from the device;
 *   · a dropdown is written only after the poll has filled it with the device's real value
 *     once — until then it shows its manifest default, and writing a default into a battery
 *     is the very mistake the wheel made.
 *
 * Each mode is described as { cap, reg, ids }: the capability the tile shows, the register
 * to write, and the values the register takes, as strings — the same ids as the capability.
 */

// "5 = Time of Use (LUNA2000)": the register value, as the write lines show it, and the name
// the tile shows — in English, like the rest of the log.
function describeMode(device, cap, id) {
  try {
    const hit = device.homey.manifest.capabilities[cap].values.find((v) => v.id === id);
    if (hit && hit.title && hit.title.en) return `${id} = ${hit.title.en}`;
  } catch (_) {
    // No manifest to hand — the number alone still says what was read.
  }
  return id;
}

module.exports = {

  /**
   * The mode dropdowns this save changes, checked before anything is written. Throws when
   * one cannot be written: Homey then rejects the whole save, keeps the old values and shows
   * the message, so nothing is half-applied and nothing displays a mode the device never got.
   */
  pendingModeWrites(device, modes, newSettings, changedKeys) {
    if (device._updatingSettingFromModbus) return [];
    const out = [];
    for (const [key, spec] of Object.entries(modes)) {
      if (!changedKeys.includes(key)) continue;
      const value = String(newSettings[key]);
      if (!spec.ids.includes(value)) {
        throw new Error(device.homey.__('modbus.modes.invalid'));
      }
      if (!device._modeSeen || !device._modeSeen[key]) {
        throw new Error(device.homey.__('modbus.modes.notReadYet'));
      }
      out.push({ key, cap: spec.cap, reg: spec.reg, value });
    }
    return out;
  },

  /**
   * Fill the dropdowns from what the device reports. A value that did not arrive in this
   * read is left alone — battery modes come in different halves of a split read — and a
   * value the list does not hold is never stored, for the reason above.
   *
   * It also writes to the log, because "when did my mode change, and what changed it" is the
   * first question once a mode is found wrong (issue #35). Once per mode after every app
   * start, so a submitted log always says what the modes were; and again whenever the device
   * reports a mode other than the dropdown holds — changed in the FusionSolar app, by a flow
   * card, by anything else talking to the device. A save from the dropdown itself leaves no
   * such line: by the time the device is read again, the dropdown already holds the value.
   * A line saying a dropdown changed waits until the dropdown really has.
   */
  async syncModeSettings(device, modes, readValues) {
    const updates = {};
    const lines = []; // [text, true when it waits for the save]
    for (const [key, spec] of Object.entries(modes)) {
      const v = readValues[key];
      // The list check below would catch these as well — 'null' is no id — but this is the
      // case the comment above means, so it is said here.
      if (v === null || v === undefined) continue;
      const id = String(v);
      if (!spec.ids.includes(id)) continue;
      if (!device._modeSeen) device._modeSeen = {};
      const first = !device._modeSeen[key];
      device._modeSeen[key] = true;
      const held = device.getSetting(key);
      const differs = held !== id;
      if (differs) updates[key] = id;
      if (first) {
        const before = differs && held !== null && held !== undefined ? `, setting held ${held}` : '';
        lines.push([`Mode dropdown filled [${key}]: ${describeMode(device, spec.cap, id)}${before}`, differs]);
      } else if (differs) {
        lines.push([`Mode dropdown follows the device [${key}]: ${held} → ${describeMode(device, spec.cap, id)}`, true]);
      }
    }
    let saved = true;
    if (Object.keys(updates).length) {
      device._updatingSettingFromModbus = true;
      try {
        await device.setSettings(updates);
      } catch (err) {
        saved = false;
        device.log('setSettings mode dropdowns failed:', err.message);
      } finally {
        device._updatingSettingFromModbus = false;
      }
    }
    for (const [text, waits] of lines) if (saved || !waits) device.log(text);
  },

  /**
   * Write what pendingModeWrites returned, one register after the other — a dongle answers
   * one connection at a time. The poll is paused for as long as this runs, the way every
   * flow-card write pauses it: a poll reading the old mode mid-write would put the dropdown
   * straight back. After each write the tile shows the new mode; a refused write calls
   * revert(w, err), which puts the dropdown back, and the remaining writes still go out.
   */
  async applyModeWrites(device, writes, write, revert) {
    if (!writes.length) return;
    device._writeInProgress = true;
    try {
      for (const w of writes) {
        device.log(`Write start  [${w.key} → reg ${w.reg}] value=${w.value}`);
        try {
          await write(w);
        } catch (err) {
          await revert(w, err);
          continue;
        }
        device.log(`Write OK     [${w.key} → reg ${w.reg}]`);
        await device._set(w.cap, w.value).catch(() => {});
      }
    } finally {
      device._writeInProgress = false;
    }
  },

  /** Put a dropdown back after the device refused the write, so it never shows a mode it does not have. */
  async revertModeSetting(device, key, oldValue, err) {
    device.error(`Write failed [${key}], setting taken back:`, err.message);
    if (oldValue === undefined) return;
    device._updatingSettingFromModbus = true;
    try {
      await device.setSettings({ [key]: oldValue });
    } catch (_) {
      // The next poll puts the real value back anyway.
    } finally {
      device._updatingSettingFromModbus = false;
    }
  },

};
