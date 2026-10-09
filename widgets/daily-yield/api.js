'use strict';

const { getDevice, cap, dailyDelta, lang } = require('../../lib/widget-data');


module.exports = {
  async getData({ homey }) {

    // Try sun2000_modbus → sun2000_emma_modbus → fusionsolar_kiosk
    // The OpenAPI inverter names its yield differently, and the difference matters: its
    // plain meter_power holds the GRID IMPORT total, not production. Read here the way the
    // others are read, it would have drawn a house's grid consumption as its solar yield.
    // The inverter's own figures are meter_power.inv_daily and meter_power.inv_total.
    const sun2000     = getDevice(homey, 'sun2000_modbus');
    const sun2000emma = getDevice(homey, 'sun2000_emma_modbus');
    const sunOa       = getDevice(homey, 'sun2000_openapi_fusionsolar');
    const kiosk       = getDevice(homey, 'fusionsolar_kiosk');
    // iSitePower reports only a lifetime total; today is its delta against the baseline
    // app.js takes at midnight (1.2.300 — the widget used to have nothing for it).
    const ispSolar    = getDevice(homey, 'isitepower_solar_openapi_fusionsolar');
    const ispTotal    = cap(ispSolar, 'meter_power', null);

    // meter_power.pv_daily is the station's PV production; inv_daily is the inverter's AC
    // output, which on a hybrid excludes everything that went into the battery. See #28 and
    // the arithmetic in the OpenAPI inverter driver. inv_daily remains the fallback.
    const dailyKwh        = cap(sun2000,     'meter_power.daily', null)
                         ?? cap(sun2000emma, 'meter_power.pv_daily', null)
                         ?? cap(sun2000emma, 'meter_power.daily', null)
                         ?? cap(sunOa,       'meter_power.pv_daily', null)
                         ?? cap(sunOa,       'meter_power.inv_daily', null)
                         ?? cap(kiosk,       'meter_power.daily', null)
                         ?? dailyDelta(homey, ispTotal, 'eb_pv_baseline');
    // Total from the same source as today's figure above, wherever there is one. The
    // OpenAPI pair used to mix periods — a station daily figure beside the inverter's own
    // lifetime counter — and the EMMA pair mixed quantities the same way, since its
    // meter_power is the inverter yield and meter_power.pv_total the PV production. Both
    // inverters' own counters stay as fallbacks and stay on their devices.
    const totalKwh        = cap(sun2000,     'meter_power', null)
                         ?? cap(sun2000emma, 'meter_power.pv_total', null)
                         ?? cap(sun2000emma, 'meter_power', null)
                         ?? cap(sunOa,       'meter_power.pv_total', null)
                         ?? cap(sunOa,       'meter_power.inv_total', null)
                         ?? cap(kiosk,       'meter_power', null)
                         ?? ispTotal;
    const optimizerTotal  = cap(sun2000, 'optimizer_total_count', null);
    const optimizerOnline = cap(sun2000, 'optimizer_online_count', null);

    // CO₂ is worked out in the widget from dailyKwh and the factor in its settings.
    return { dailyKwh, totalKwh, optimizerTotal, optimizerOnline, lang: lang(homey) };
  },
};
