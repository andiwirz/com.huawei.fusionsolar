'use strict';

const { getDevice, lang } = require('../../lib/widget-data');

// Charger lookup: OCPP first (full session data), then EMMA Modbus
// (telemetry-only — getWidgetStatus degrades gracefully). Uses the driver
// registry rather than OcppServer.getInstance() so merely opening the
// widget never boots the OCPP WebSocket server.
function getChargerDevice(homey) {
  return getDevice(homey, 'smartcharger_ocpp')
    || getDevice(homey, 'smartcharger_emma_modbus');
}

module.exports = {
  async getStatus({ homey }) {
    const device = getChargerDevice(homey);
    if (!device || typeof device.getWidgetStatus !== 'function') {
      // A code the widget translates, not an English sentence on a German dashboard.
      return { error: 'no_charger', lang: lang(homey) };
    }
    return { ...device.getWidgetStatus(), lang: lang(homey) };
  },
};
