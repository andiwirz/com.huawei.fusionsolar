'use strict';

// A device warning while a device counts wrongly in Homey Energy — the kiosk device beside a
// SUN2000 (1.2.295), the SDongle always (1.2.297).
//
// Homey's "Exclude from Energy" is the owner's setting; the app can only point at it. Homey
// keeps it as energy_exclude among the device's settings and reports a change of it to
// onSettings, but does not hand it to the app at start: measured 2026-10-09 on a SDongle
// excluded in Homey — the warning came back after every app restart and went when the setting
// was switched off and on. So the device remembers the last value Homey reported in its store
// (1.2.298); until Homey has reported one, the warning asks an owner who excluded the device
// before to switch the setting off and on once. setWarning is persistent, so the first check
// after a start also clears one that no longer applies.

const STORE_KEY = 'energyExcludeReported';

function asBool(v) {
  return typeof v === 'boolean' ? v : null;
}

// The last value Homey reported wins over what the settings show at start.
function energyExcluded(device, settings = device.getSettings()) {
  const reported = asBool(device.getStoreValue(STORE_KEY));
  return reported !== null ? reported : asBool(settings.energy_exclude);
}

// From onSettings, the one place Homey reports its setting. True when it was among the changes.
async function rememberEnergyExclude(device, { newSettings, changedKeys }) {
  if (!changedKeys.includes('energy_exclude')) return false;
  const v = asBool(newSettings.energy_exclude);
  device.log(`Homey Energy: "Exclude from Energy" reported ${v === null ? 'without a value' : v}`);
  if (v !== null) {
    await device.setStoreValue(STORE_KEY, v).catch((err) => device.error('setStoreValue failed:', err.message));
  }
  return true;
}

async function applyEnergyWarning(device, { conflict, message, settings = device.getSettings(), detail = '' }) {
  const excluded = energyExcluded(device, settings);
  if (!device._energyExcludeLogged) {
    device._energyExcludeLogged = true;
    const fmt = (v) => (v === null ? 'none' : v);
    device.log(`Homey Energy: "Exclude from Energy" at start — settings ${fmt(asBool(settings.energy_exclude))}, last reported ${fmt(asBool(device.getStoreValue(STORE_KEY)))}`);
  }
  const show = !!conflict && excluded !== true;
  if (show === device._energyWarningShown) return show;
  device._energyWarningShown = show;
  if (show) {
    device.log(`Energy warning set${detail ? `: ${detail}` : ''}`);
    await device.setWarning(message).catch((err) => device.error('setWarning failed:', err.message));
  } else {
    await device.unsetWarning().catch((err) => device.error('unsetWarning failed:', err.message));
  }
  return show;
}

module.exports = { STORE_KEY, energyExcluded, rememberEnergyExclude, applyEnergyWarning };
