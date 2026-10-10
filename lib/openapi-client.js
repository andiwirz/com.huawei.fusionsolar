'use strict';

const https = require('https');

const REQUEST_TIMEOUT_MS = 15000;

/**
 * Sends a POST request to the FusionSolar Northbound API.
 * Token is sent as xsrf-token header (official API account mode).
 */
function post(baseUrl, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url     = new URL(path, baseUrl);

    const options = {
      hostname: url.hostname,
      port:     url.port || 443,
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Accept:           'application/json',
        'User-Agent':     'Homey/FusionSolarOpenAPI',
        ...(token ? { 'xsrf-token': token } : {}),
      },
      timeout: REQUEST_TIMEOUT_MS,
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ data: JSON.parse(raw), headers: res.headers });
        } catch (err) {
          const preview = raw.slice(0, 120).replace(/\s+/g, ' ').trim();
          reject(new Error(`Failed to parse response: ${err.message}. Server returned: ${preview || '(empty)'}`));
        }
      });
    });

    req.on('error',   (err) => reject(new Error(`Network error: ${err.message}`)));
    req.on('timeout', ()    => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(payload);
    req.end();
  });
}

// Huawei's own error-code list, from the northbound API reference, plus the two traffic
// codes its traffic-limiting policy names separately (403 and 429, which the list omits).
//
// Only the codes that can reach a user through the calls this app makes — login,
// getStationList, getStationRealKpi, getDevList, getDevRealKpi. The reference runs to 150-odd
// entries covering plant creation, I-V curve diagnosis and firmware upgrades, none of which
// this app touches; copying those in would be a table nobody can check against reality.
//
// Two of these were wrong before, invented from the number rather than read from the list:
// 20001 was shown as "Permission denied" when it means the third-party account does not
// exist at all, and 20400 was shown as a bad password when it also covers a locked account,
// an expired password and too many open sessions. Both sent a user looking in the wrong
// place — the first at plant permissions, the second at the keyboard.
const FAIL_MESSAGES = {
  // Session and account
  305:   'Session expired',
  306:   'Session expired',
  401:   'No permission for this data interface',
  20001: 'This Northbound API account does not exist',
  20002: 'This Northbound API account is blocked',
  20003: 'This Northbound API account has expired',
  20400: 'Sign-in refused — wrong username or system code, or the account is locked, its '
       + 'password has expired, or too many sessions are open',
  20403: 'Sign-in for this Northbound API account is restricted',

  // Traffic. 407 is this account calling one interface too often; 403 and 429 are the
  // service as a whole being busy and ask only for a minute's wait. Neither of those two is
  // in the error-code list — they come from the traffic-limiting policy, which names them.
  403:   'System-wide rate limit exceeded — wait 1 minute and retry',
  407:   'Rate limit exceeded — too many API calls, please reduce poll frequency',
  429:   'System-wide rate limit exceeded — wait 1 minute and retry',
  20200: 'FusionSolar is busy — try again shortly',
  20618: 'This account has used up its API calls for today',

  // What was asked for
  20005: 'The request carried no device ID',
  20006: 'Some devices do not match the device type asked for',
  20010: 'The request carried no plant',
  20011: 'The request carried no device',
  // Seen in the field on a SDongle (devTypeId 62): getDevRealKpi returns device readings,
  // and a communication dongle has none to give.
  20013: 'This interface does not support that device type',
  20016: 'At most 100 devices can be queried at a time',
  20017: 'At most 100 devices can be queried at a time',

  // What the account can see
  20007: 'This account has no access to the requested plant',
  20008: 'This account has no access to the requested device',
  20009: 'The requested readings are not configured in FusionSolar for this plant',

  20004: 'FusionSolar reported a server error',

  // Not in the published list. Field-reported 2026-09-02 (issue #26): every reading froze
  // for hours and the log said only "failCode=20056". The plant owner had switched API
  // access off, which is a setting the user can put right in seconds once they know where to
  // look — so the message says where, rather than making them search for the number.
  20056: 'API access is disabled for this plant — enable it under Plant Owner → Configure permissions → Access to API',
};

/** Returns true when the API indicates a session-expired condition. */
function isSessionExpired(failCode) {
  return failCode === 305 || failCode === 306;
}

/** Returns a human-readable message for a failCode. */
function failMessage(failCode, apiMessage) {
  return FAIL_MESSAGES[failCode] ?? apiMessage ?? `Error ${failCode}`;
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

/**
 * Authenticates and returns the xsrf-token.
 * Per official docs (section 3.2.2.1): token is in the response header XSRF-TOKEN.
 * Response body data is null on success.
 */
async function login(baseUrl, userName, systemCode) {
  const { data, headers } = await post(baseUrl, '/thirdData/login', { userName, systemCode });

  if (!data.success) {
    throw new Error(`Login failed (${data.failCode ?? 'unknown'}): ${failMessage(data.failCode, data.message)}`);
  }

  // Token is always in the response header (data.data is null on success)
  const token = headers['xsrf-token'];
  if (!token) throw new Error('Login succeeded but no xsrf-token in response header');
  return token;
}

/**
 * The two plant-list interfaces, normalised into one answer.
 *
 * /thirdData/stations is the current one. /thirdData/getStationList is what it replaced, and
 * the reference says plainly: "iMaster NetEco V600R023C00SPC210 and later versions do not
 * support this interface." An account on a newer server calling the old one gets nothing
 * back, and nothing back during pairing reads as "this account has no plants" — a dead end
 * with no hint of where to look.
 *
 * The new interface names its fields plantCode and plantName where the old one used
 * stationCode and stationName. Both are returned under both names so the pairing pages,
 * which read stationCode, keep working whichever interface answered.
 */
const normaliseStations = (list) => list.map((s) => ({
  ...s,
  stationCode: s.stationCode ?? s.plantCode ?? null,
  stationName: s.stationName ?? s.plantName ?? null,
  plantCode:   s.plantCode   ?? s.stationCode ?? null,
  plantName:   s.plantName   ?? s.stationName ?? null,
}));

async function fetchStationsVia(baseUrl, token, path, body) {
  const { data } = await post(baseUrl, path, body, token);
  if (!data.success) {
    return {
      ok: false,
      expired: isSessionExpired(data.failCode),
      failCode: data.failCode ?? null,
      failMessage: failMessage(data.failCode, data.message),
    };
  }
  let list = [];
  if (Array.isArray(data.data))                        list = data.data;
  else if (data.data && Array.isArray(data.data.list)) list = data.data.list;
  return { ok: true, expired: false, stations: normaliseStations(list) };
}

/**
 * Returns the list of plants for this account, from whichever interface answers.
 *
 * The current one is tried first. The retired one is only reached when the current one
 * refuses or comes back empty, which is what an older server does — so an account that
 * predates the change keeps working without anyone choosing an endpoint by hand.
 */
async function getStationList(baseUrl, token) {
  let firstFailure = null;

  try {
    const r = await fetchStationsVia(baseUrl, token, '/thirdData/stations', { pageNo: 1 });
    if (r.expired) return { expired: true, stations: [] };
    if (r.ok && r.stations.length) return { expired: false, stations: r.stations, endpoint: 'stations' };
    firstFailure = r.ok ? null : r;
  } catch (err) {
    // A server that has never heard of the path answers with something that is not JSON,
    // and post() rejects rather than returning a failCode. That is a reason to try the old
    // interface, not a reason to give up.
    firstFailure = { failMessage: err.message };
  }

  try {
    const r = await fetchStationsVia(baseUrl, token, '/thirdData/getStationList', { pageNo: 1, pageSize: 100 });
    if (r.ok) return { expired: false, stations: r.stations, endpoint: 'getStationList' };
    return {
      expired: r.expired,
      stations: [],
      failCode: r.failCode,
      failMessage: r.failMessage ?? firstFailure?.failMessage ?? null,
    };
  } catch (err) {
    return {
      expired: false,
      stations: [],
      failCode: firstFailure?.failCode ?? null,
      failMessage: firstFailure?.failMessage ?? err.message,
    };
  }
}

/**
 * Returns real-time station-level KPI.
 * stationCodes: comma-separated string of plant IDs from plantCode in getStationList.
 *
 * dataItemMap fields (no real_time_power in this API):
 *   day_power, month_power, total_power (kWh)
 *   day_income, total_income
 *   day_on_grid_energy, day_use_energy (kWh)
 *   real_health_state (1=disconnected, 2=faulty, 3=healthy)
 */
async function getStationRealKpi(baseUrl, token, stationCode, log = () => {}) {
  const { data } = await post(baseUrl, '/thirdData/getStationRealKpi', { stationCodes: stationCode }, token);

  if (!data.success) {
    log(`[openapi] getStationRealKpi failed: failCode=${data.failCode} msg=${data.message}`);
    // The code travels with the result, not only into the log. The caller has to tell a
    // transient blip from a permanent, user-fixable condition, and it cannot do that from
    // a null KPI alone.
    return {
      expired: isSessionExpired(data.failCode),
      kpi: null,
      failCode: data.failCode ?? null,
      failMessage: failMessage(data.failCode, data.message),
    };
  }

  const list  = Array.isArray(data.data) ? data.data : [];
  const entry = list.find((d) => d.stationCode === stationCode) ?? list[0];

  if (!entry?.dataItemMap) {
    log(`[openapi] getStationRealKpi: no dataItemMap (stationCode=${stationCode}, entries=${list.length}, raw=${JSON.stringify(data.data)})`);
    return { expired: false, kpi: null };
  }

  const m = entry.dataItemMap;

  return {
    expired: false,
    kpi: {
      dailyEnergy:     num(m.day_power),
      monthEnergy:     num(m.month_power),
      totalEnergy:     num(m.total_power),
      dayIncome:       num(m.day_income),
      totalIncome:     num(m.total_income),
      dayOnGridEnergy: num(m.day_on_grid_energy),
      dayUseEnergy:    num(m.day_use_energy),
      healthState:     num(m.real_health_state),   // 1=disconnected, 2=faulty, 3=healthy
    },
  };
}

/**
 * Returns yearly energy for a station.
 * collectTime: any timestamp (ms) within the desired year (defaults to now).
 * dataItemMap field: inverter_power (kWh, may also be ongrid_power or power).
 */
async function getStationYearKpi(baseUrl, token, stationCode, collectTime = Date.now()) {
  const { data } = await post(
    baseUrl,
    '/thirdData/getKpiStationYear',
    { stationCodes: stationCode, collectTime },
    token,
  );

  if (!data.success) return { expired: isSessionExpired(data.failCode), yearEnergy: null };

  const list  = Array.isArray(data.data) ? data.data : [];
  const entry = list.find((d) => d.stationCode === stationCode) ?? list[0];
  if (!entry?.dataItemMap) return { expired: false, yearEnergy: null };

  const m          = entry.dataItemMap;
  const yearEnergy = num(m.inverter_power ?? m.power ?? m.ongrid_power);

  return { expired: false, yearEnergy };
}

/**
 * Returns the list of devices for a station.
 * stationCodes: comma-separated string.
 *
 * Each device in response has:
 *   id (Long)       — device ID used in getDevRealKpi
 *   esnCode         — device serial number
 *   devName         — device name
 *   devTypeId       — device type (1=inverter, 17=meter, 39=battery, ...)
 *   stationCode     — plant ID
 */
async function getDevList(baseUrl, token, stationCode) {
  const { data } = await post(baseUrl, '/thirdData/getDevList', { stationCodes: stationCode }, token);

  // The reason travels with the empty answer, as it does for getDevRealKpi. A refused list
  // (a 407, a permission problem) used to come back as `devices: []` and nothing else, which
  // is exactly what a plant without devices looks like — and the coordinator took it for one
  // (review 2026-10-10).
  if (!data.success) {
    return {
      expired: isSessionExpired(data.failCode),
      devices: [],
      failCode: data.failCode ?? null,
      failMessage: failMessage(data.failCode, data.message),
    };
  }

  const devices = Array.isArray(data.data) ? data.data : [];
  return { expired: false, devices };
}

/**
 * Returns real-time KPI for devices of the same type.
 * devIds:     comma-separated string of device IDs (from id field in getDevList)
 * devTypeId:  device type ID (mandatory)
 *
 * devTypeId 1  (Inverter):  active_power (kW), elec_freq (Hz), efficiency (%), temperature (°C)
 * devTypeId 17 (Grid meter): active_power (W, positive=import / negative=export)
 * devTypeId 39 (Battery):   battery_soc (%), ch_discharge_power (W), charge_cap / discharge_cap (kWh)
 */
// The traffic refusals of Huawei's policy — the same three lib/openapi-coordinator.js tells
// apart as RATE_LIMIT_USER (407) and RATE_LIMIT_SYSTEM (403, 429).
const RATE_LIMITED = new Set([407, 403, 429]);

async function getDevRealKpi(baseUrl, token, devIds, devTypeId) {
  const idStr = devIds.join(',');

  // Try numeric devTypeId first; some FusionSolar servers (e.g. intl) only
  // accept the string variant — retry with string if numeric returns empty.
  const { data } = await post(
    baseUrl,
    '/thirdData/getDevRealKpi',
    { devIds: idStr, devTypeId: Number(devTypeId) },
    token,
  );

  if (data.success && Array.isArray(data.data) && data.data.length > 0) {
    return { expired: false, devices: data.data, failCode: null, failMessage: null };
  }

  if (isSessionExpired(data.failCode)) {
    return {
      expired: true,
      devices: [],
      failCode: data.failCode ?? null,
      failMessage: failMessage(data.failCode, data.message),
    };
  }

  // A refusal for frequency (407) or for load (403, 429) is not the string-type quirk the retry
  // below exists for. Asking again at once spent a second call of exactly the allowance the
  // refusal was about — two per refused type and cycle, against one per type and five minutes
  // (review 2026-10-10).
  if (RATE_LIMITED.has(data.failCode)) {
    return {
      expired: false,
      devices: [],
      failCode: data.failCode,
      failMessage: failMessage(data.failCode, data.message),
    };
  }

  // Retry with string devTypeId
  const { data: data2 } = await post(
    baseUrl,
    '/thirdData/getDevRealKpi',
    { devIds: idStr, devTypeId: String(devTypeId) },
    token,
  );

  // The reason travels with the empty answer instead of being dropped here.
  //
  // A type that comes back with no devices looks the same whether Huawei is refusing it,
  // has never heard of the id, or simply has nothing to say this minute — and the caller
  // could only report "0 device(s)". On the plant in #28 that is a LUNA2000 which
  // FusionSolar shows with a live state of charge at the same moment this call returns
  // nothing at all, and there was no way to tell a permission problem from an outage.
  //
  // The retry's code wins when the retry failed; otherwise the first attempt's, which is
  // what explains why a retry happened at all. Both succeeding with an empty list leaves
  // no code, and that is worth saying too rather than inventing one.
  const devices = data2.success && Array.isArray(data2.data) ? data2.data : [];
  const failed = devices.length
    ? null   // a reading that arrived is not labelled with the failure that preceded it
    : (!data2.success ? data2 : (!data.success ? data : null));

  return {
    expired: !data2.success && isSessionExpired(data2.failCode),
    devices,
    failCode:    failed ? (failed.failCode ?? null) : null,
    failMessage: failed ? failMessage(failed.failCode, failed.message) : null,
  };
}

/**
 * Returns daily aggregated device data (one entry per day in the queried month).
 * devIds:      comma-separated string of device IDs
 * devTypeId:   device type ID (mandatory)
 * collectTime: any timestamp (ms) within the desired month
 */
async function getDevKpiDaily(baseUrl, token, devIds, devTypeId, collectTime) {
  const { data } = await post(
    baseUrl,
    '/thirdData/getDevKpiDay',
    { devIds: devIds.join(','), devTypeId, collectTime },
    token,
  );

  if (!data.success) return { expired: isSessionExpired(data.failCode), records: [] };

  const records = Array.isArray(data.data) ? data.data : [];
  return { expired: false, records };
}

/**
 * Returns monthly aggregated device data (one entry per month in the queried year).
 * devIds:      comma-separated string of device IDs
 * devTypeId:   device type ID (mandatory)
 * collectTime: any timestamp (ms) within the desired year
 */
async function getDevKpiMonth(baseUrl, token, devIds, devTypeId, collectTime) {
  const { data } = await post(
    baseUrl,
    '/thirdData/getDevKpiMonth',
    { devIds: devIds.join(','), devTypeId, collectTime },
    token,
  );

  if (!data.success) return { expired: isSessionExpired(data.failCode), records: [] };

  const records = Array.isArray(data.data) ? data.data : [];
  return { expired: false, records };
}

async function getStationRealKpiRaw(baseUrl, token, stationCode) {
  const { data } = await post(baseUrl, '/thirdData/getStationRealKpi', { stationCodes: stationCode }, token);
  // The reason travels with a null reading, for the same cause as in getDevRealKpi: this
  // interface allows Roundup(plants/100) calls every five minutes — one, for a single-plant
  // account — and the poller already spends it. A diagnostic run inside that window is
  // refused, and the report used to say "no data", which reads as a plant with nothing to
  // report rather than a call that was turned away.
  if (!data.success) {
    return {
      expired: isSessionExpired(data.failCode),
      raw: null,
      failCode: data.failCode ?? null,
      failMessage: failMessage(data.failCode, data.message),
    };
  }
  const list  = Array.isArray(data.data) ? data.data : [];
  const entry = list.find((d) => d.stationCode === stationCode) ?? list[0];
  return { expired: false, raw: entry?.dataItemMap ?? null, failCode: null, failMessage: null };
}

// The device types getDevRealKpi serves, from section 3.2.6 of the reference: string
// inverter, EMI, grid meter, residential inverter, battery, ESS, power sensor.
//
// 23070 is not in that list. An EMMA answers it anyway — measured on a plant in issue #28 —
// so it is included, marked as what it is: behaviour the reference does not promise.
//
// What the list settles is the other direction. A dongle (62) is not served, and asking for
// one returns failCode 20013, "the interface does not support operations on some devices",
// every time. Spending a call to learn that again is a call the plant's allowance could have
// spent on a device that has readings.
const DEV_KPI_TYPES = new Set([1, 10, 17, 38, 39, 41, 47, 23070]);

module.exports = {
  login,
  DEV_KPI_TYPES,
  getStationList,
  getStationRealKpi,
  getStationRealKpiRaw,
  getStationYearKpi,
  getDevList,
  getDevRealKpi,
  getDevKpiDaily,
  getDevKpiMonth,
};
