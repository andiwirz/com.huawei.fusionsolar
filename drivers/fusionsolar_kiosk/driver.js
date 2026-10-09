'use strict';

const { Driver } = require('homey');
const { parseKioskUrl, buildApiUrl, fetchKioskData, extractKpiValues } = require('../../lib/kiosk-api');
const { sun2000Names } = require('../../lib/sun2000-presence');

class FusionSolarKioskDriver extends Driver {

  async onInit() {
    this.log('FusionSolar Kiosk Driver initialised');
  }

  async onPair(session) {
    // The pairing view asks this as it opens: a SUN2000 already paired means the kiosk
    // device has to be excluded from Homey Energy, and the view says so before it is added.
    session.setHandler('sun2000_present', async () => ({ names: sun2000Names(this.homey) }));

    // set_kiosk_url: validate URL, fetch live data, return kpi + kk
    session.setHandler('set_kiosk_url', async ({ url, name }) => {
      const kioskUrl = (url || '').trim();

      if (!kioskUrl) {
        throw new Error(this.homey.__('pair.errors.noUrl'));
      }

      const { baseUrl, kk } = parseKioskUrl(kioskUrl);
      const raw = await fetchKioskData(buildApiUrl(baseUrl, kk));
      const kpi = extractKpiValues(raw);

      this.log(`Pairing: validated kk=${kk}, power=${kpi.realTimePower}W`);

      // Return kk so the front-end can pass it to Homey.createDevice()
      return { success: true, kk, kpi };
    });
  }

}

module.exports = FusionSolarKioskDriver;
