'use strict';

const { getDevice, lang } = require('../../lib/widget-data');

// The widget shows five or ten rows; twenty is the most any setting asks for. The EMS keeps
// up to 200 sessions and all of them used to go out every ten seconds (1.2.300).
const MAX_ROWS = 20;


/**
 * One EMS charge session in the shape this widget already renders.
 *
 * The widget was written for the OCPP charger's own history, which records amps and
 * phases per session; the EMS does not, so phaseTag() renders nothing for these rows —
 * it returns '' when amps is missing, which is why no layout change is needed.
 *
 * `reason` is the widget's small bottom-right slot. For an OCPP row it holds the stop
 * reason; here it carries what the EMS knows and the charger does not — which car, and
 * how much of the energy came from the roof.
 */
function emsRow(s) {
  const parts = [];
  if (s.carName) parts.push(s.carName);
  if (s.pvShare != null) parts.push(`${s.pvShare}% PV`);
  return {
    startTime:  s.startedAt,
    stopTime:   s.endedAt,
    durationMs: Math.max(0, (s.endedAt || Date.now()) - s.startedAt),
    energyWh:   Math.round((s.energyKwh || 0) * 1000),
    reason:     parts.join(' · '),
  };
}

module.exports = {
  async getSessions({ homey }) {
    // The OCPP charger keeps its own per-session history, richer than the EMS's (amps,
    // phases, stop reason), so it stays the first choice where one is paired.
    // Driver-registry lookup so opening the widget never boots the OCPP WebSocket server
    // as a side effect.
    const device = getDevice(homey, 'smartcharger_ocpp');
    if (device && device.getSessionHistory) {
      const history = (await device.getSessionHistory()).slice(0, MAX_ROWS);
      const current = device.getCurrentSessionInfo();
      return { history, current, currents: current ? [current] : [], lang: lang(homey) };
    }

    // Otherwise the EMS's own sessions, which cover every charger it steers whatever the
    // brand. Without this the widget was empty for anyone on an Easee, a go-e or a Zaptec
    // — that is to say, for most installations.
    const ems = getDevice(homey, 'energy_management');
    if (!ems || typeof ems.getEmsChargeSessions !== 'function') {
      return { error: 'no_charger', lang: lang(homey) };
    }
    const rows = ems.getEmsChargeSessions();
    // Every session in progress — two chargers can run at once, and the second one used to
    // vanish (only the first was sent). `current` stays for an older widget build.
    // `paused` is the widget's word for "plugged in but not drawing", which for an
    // EMS-steered charger is a normal state between two solar windows.
    const currents = rows.filter((s) => s.running).map((s) => ({ ...emsRow(s), paused: s.charging === false }));
    return {
      history: rows.filter((s) => !s.running).slice(0, MAX_ROWS).map(emsRow),
      current: currents[0] || null,
      currents,
      lang: lang(homey),
    };
  },
};
