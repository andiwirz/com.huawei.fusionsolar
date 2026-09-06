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

const FAIL_MESSAGES = {
  305:   'Session expired',
  306:   'Session expired',
  407:   'Rate limit exceeded — too many API calls, please reduce poll frequency',
  429:   'System-wide rate limit exceeded — wait 1 minute and retry',
  20001: 'Permission denied',
  20009: 'No data available',
  // Field-reported 2026-09-02 (issue #26): every reading froze for hours and the log said
  // only "failCode=20056". The plant owner had switched API access off, which is a setting
  // the user can put right in seconds once they know where to look — so the message says
  // where, rather than making them search for the number.
  20056: 'API access is disabled for this plant — enable it under Plant Owner → Configure permissions → Access to API',
  20400: 'Invalid username or password',
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
 * Returns the list of stations for this account.
 * Response: data.data.list[] with plantCode, plantName, capacity, etc.
 */
async function getStationList(baseUrl, token) {
  const { data } = await post(baseUrl, '/thirdData/getStationList', { pageNo: 1, pageSize: 100 }, token);

  if (!data.success) return { expired: isSessionExpired(data.failCode), stations: [] };

  let stations = [];
  if (Array.isArray(data.data))                        stations = data.data;
  else if (data.data && Array.isArray(data.data.list)) stations = data.data.list;

  return { expired: false, stations };
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

  if (!data.success) return { expired: isSessionExpired(data.failCode), devices: [] };

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
  if (!data.success) return { expired: isSessionExpired(data.failCode), raw: null };
  const list  = Array.isArray(data.data) ? data.data : [];
  const entry = list.find((d) => d.stationCode === stationCode) ?? list[0];
  return { expired: false, raw: entry?.dataItemMap ?? null };
}

module.exports = {
  login,
  getStationList,
  getStationRealKpi,
  getStationRealKpiRaw,
  getStationYearKpi,
  getDevList,
  getDevRealKpi,
  getDevKpiDaily,
  getDevKpiMonth,
};
