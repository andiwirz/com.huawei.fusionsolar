'use strict';

const { getEmsDevice, lang } = require('../../lib/widget-data');

module.exports = {

  // Combines the PV (Solcast) forecast and the price status into one payload so the
  // widget only needs a single request per poll. Price follows whatever tariff model
  // is actually configured under App Settings → Electricity Price (fixed/variable/dual/
  // forecast) — see lib/ems/price.js#getEmsPriceStatus — not just the D10 forecast mode.
  async getForecast({ homey }) {
    const device = getEmsDevice(homey);
    if (!device) return { error: 'no_ems_device', lang: lang(homey) };
    try {
      return {
        pv:    device.getPvForecast(),
        price: device.getEmsPriceStatus(),
        lang:  lang(homey),
      };
    } catch (e) {
      return { error: e.message, lang: lang(homey) };
    }
  },

};
