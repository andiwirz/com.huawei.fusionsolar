'use strict';

const net = require('net');
const os  = require('os');

const {
  login:               openapiLogin,
  getStationList:      openapiGetStationList,
  getStationRealKpiRaw: openapiGetStationRealKpiRaw,
  getDevList:          openapiGetDevList,
  getDevRealKpi:       openapiGetDevRealKpi,
} = require('./lib/openapi-client');

const {
  REGISTERS,
  POWER_METER_REGISTERS,
  BATTERY_REGISTERS,
  BATTERY_MODULE_REGISTERS,
  CONTROL_REGISTERS,
  EMMA_REGISTERS,
  POWERMETER_EMMA_DATA_REGISTERS,
  SUN2000_EMMA_DATA_REGISTERS,
  LUNA2000_EMMA_DATA_REGISTERS,
  LUNA2000_EMMA_CONTROL_REGISTERS,
  SMARTCHARGER_REGISTERS,
  SDONGLE_A_REGISTERS,
} = require('./lib/modbus-registers');
const { probeModbusUnit, withHostLock } = require('./lib/modbus-client');
const { version: APP_VERSION, flow: APP_FLOW } = require('./app.json');

// Which trigger cards does the EMS never fire? Not a list kept here — a list here would
// drift the moment a card starts or stops being driven. Each such card already says so in
// its own hint ("Placeholder trigger created by EMS Setup Flows"), and that hint is what
// Homey shows the user in its flow editor, so the manifest is the single place the answer
// lives. test/flow-card-wiring.test.js holds the other end of the same rule.
const PLACEHOLDER_TRIGGERS = new Set(
  ((APP_FLOW && APP_FLOW.triggers) || [])
    .filter((t) => t.hint && typeof t.hint.en === 'string' && /placeholder/i.test(t.hint.en))
    .map((t) => t.id),
);
// A stored card id is either the bare id or "<uri>:<id>", depending on how the flow was
// created — the same two shapes getEmsTriggerUsage already copes with.
const shortCardId = (raw) => {
  const s = typeof raw === 'string' ? raw : '';
  return s.indexOf(':') !== -1 ? s.slice(s.lastIndexOf(':') + 1) : s;
};

/**
 * The EMS device's Homey local-API client, or null when no EMS device is paired or the
 * paired one has no API key.
 *
 * Every route that talks to the local API used to inline this lookup — 24 copies. The
 * lookup is shared; each route keeps its own "no API key" return shape, because the
 * settings page branches on those (test/api.test.js pins all nine of them).
 */
function _emsApi(homey) {
  let apiKey = '', emsDeviceId = '';
  try {
    const devices = homey.drivers.getDriver('energy_management').getDevices();
    if (devices.length > 0) {
      apiKey      = devices[0].getSetting('homey_api_key') || '';
      emsDeviceId = devices[0].getData().id || '';
    }
  } catch { /* driver not yet paired */ }
  if (!apiKey) return null;
  const HomeyLocalApi = require('./lib/homey-local-api');
  return { api: new HomeyLocalApi({ homey, apiKey }), apiKey, emsDeviceId };
}

// Name of the folder every "set up flows" route drops its flows into, so a user can find
// and remove them as a group.
const EMS_FLOW_FOLDER = '_Huawei EMS';

/**
 * Id of that folder, creating it if it does not exist yet.
 *
 * Returns null on any failure — including a Homey that refuses folder creation — because
 * every caller treats the folder as a nicety: without it the flows land at the top level,
 * which is untidy but works. This was written out at all seven call sites, in two
 * spellings that did the same thing.
 */
async function _emsFlowFolderId(api) {
  try {
    const folders  = await api.getFlowFolders();
    const existing = Object.values(folders || {}).find((f) => f.name === EMS_FLOW_FOLDER);
    if (existing) return existing.id;
    const created = await api.createFlowFolder({ name: EMS_FLOW_FOLDER });
    return (created && created.id) || null;
  } catch (_) {
    return null;
  }
}


// ─── Register sets per driver ─────────────────────────────────────────────────
// Each entry maps a human-readable group name → register map.
// Used by the debug settings page to do live register reads.

// Display-only register sets for the Settings → Registers tab.
// Mirror the polling subsets used by each driver, plus the flow-writable registers.
const _pick = (keys) => Object.fromEntries(keys.map(k => [k, CONTROL_REGISTERS[k]]));

const INVERTER_CONTROL_DISPLAY = _pick([
  'activePowerControlMode',
  'activePowerMaxFeedIn',
  'activePowerMaxFeedInPct',
  'activePowerPercentageDerating',
  'activePowerFixedValueDerating',
  'mpptMultimodal',
  'mpptScanInterval',
]);

const BATTERY_CONTROL_DISPLAY = _pick([
  'storageWorkingMode',
  'storageMaxChargePower',
  'storageMaxDischargePower',
  'storageChargingCutoffCapacity',
  'storageDischargeCutoffCapacity',
  'storageChargeFromGrid',
  'storageGridChargeCutoffSoc',
  'storageGridChargePower',
  'storageMaxGridChargePower',
  'storageBackupPowerSoc',
  'storageUnit1No',
  'storageUnit2No',
  'remoteChargeDischargeControlMode',
  'storageExcessPvEnergyUseInTou',
  'storageForceChargeDischarge',
  'storageForceTargetSoc',
  'storageForceChargePower',
  'storageForceDisChargePower',
  'storageForceChargeDischargeDuration',
]);

const DRIVER_REGISTER_SETS = {
  sun2000_modbus: {
    'Inverter Data':       REGISTERS,
    'Power Meter Data':    POWER_METER_REGISTERS,
    'Inverter Control':    INVERTER_CONTROL_DISPLAY,
  },
  luna2000_modbus: {
    'Battery Data':        BATTERY_REGISTERS,
    'Battery Modules':     BATTERY_MODULE_REGISTERS,
    'Battery Control':     BATTERY_CONTROL_DISPLAY,
  },
  dtsu666_modbus: {
    'Power Meter Data':    POWER_METER_REGISTERS,
  },
  sdongle_a_modbus: {
    'SDongle Registers':   SDONGLE_A_REGISTERS,
  },
  sun2000_emma_modbus: {
    'EMMA Inverter Data':  SUN2000_EMMA_DATA_REGISTERS,
  },
  luna2000_emma_modbus: {
    'EMMA Battery Data':   LUNA2000_EMMA_DATA_REGISTERS,
    'EMMA Control':        LUNA2000_EMMA_CONTROL_REGISTERS,
  },
  powermeter_emma_modbus: {
    'EMMA Meter Data':     POWERMETER_EMMA_DATA_REGISTERS,
  },
  smartcharger_emma_modbus: {
    'Smart Charger Data':  SMARTCHARGER_REGISTERS,
  },
};

const MODBUS_DRIVER_IDS = Object.keys(DRIVER_REGISTER_SETS);

// ─── API handlers ─────────────────────────────────────────────────────────────

async function _getEmsSimpleDeviceFlows({ homey, startCardId, stopCardId, startTokenName }) {
  const _ems = _emsApi(homey);
  if (!_ems) return { matched: [], error: 'No API key' };
  const { api, apiKey, emsDeviceId } = _ems;
  try {
    const flows = await api.getFlows().catch(() => ({}));
    const matched = [];
    for (const [id, f] of Object.entries(flows || {})) {
      const tid = f.trigger && f.trigger.id || '';
      const APP = 'homey:app:com.huawei.fusionsolar';
      if (tid === startCardId || tid === stopCardId || tid === `${APP}:${startCardId}` || tid === `${APP}:${stopCardId}`) {
        const firstAction = (f.actions || [])[0];
        let cardId = null, cardUri = null;
        if (firstAction) {
          const rawId = firstAction.id || '';
          if (rawId.startsWith('homey:')) { const lc = rawId.lastIndexOf(':'); cardId = rawId.slice(lc + 1); cardUri = rawId.slice(0, lc); }
          else { cardId = rawId; cardUri = firstAction.uri || ''; }
        }
        matched.push({ id, name: f.name || id, type: 'flow',
          triggerType: (tid === startCardId || tid === `${APP}:${startCardId}`) ? 'start' : 'stop',
          triggerDeviceId: (f.trigger && f.trigger.args && f.trigger.args[startTokenName]) || '',
          // Short card id + the flow's own filter args — lets the settings page
          // fire this exact trigger as a test ("Run").
          triggerCardId: tid.indexOf(':') !== -1 ? tid.slice(tid.lastIndexOf(':') + 1) : tid,
          triggerArgs: (f.trigger && f.trigger.args) || {},
          actionCardId: cardId, actionCardUri: cardUri });
      }
    }
    return { emsDeviceId, matched: matched.sort((a, b) => a.name.localeCompare(b.name)) };
  } catch (e) { return { matched: [], error: e.message }; }
}

async function _postEmsSimpleDeviceSetupFlows({ homey, body, startCardId, stopCardId, tokenName, labelSuffix }) {
  const { emsDeviceId, deviceId, deviceName, startCardId: startActId, startCardUri, stopCardId: stopActId, stopCardUri } = body || {};
  if (!emsDeviceId || !deviceId || !startActId || !startCardUri || !stopActId || !stopCardUri)
    return { error: 'Missing required fields' };
  const _ems = _emsApi(homey);
  if (!_ems) return { error: 'No API key' };
  const { api, apiKey } = _ems;
  const APP_URI = 'homey:app:com.huawei.fusionsolar';
  const folderId = await _emsFlowFolderId(api);
  const baseName  = `EMS: ${deviceName || deviceId}`;
  const startName = `${baseName} → ${labelSuffix} Start`;
  const stopName  = `${baseName} → ${labelSuffix} Stop`;
  const allFlows  = await api.getFlows().catch(() => ({}));
  await Promise.all(Object.values(allFlows || {}).filter((f) => f.name === startName || f.name === stopName).map((f) => api.deleteFlow(f.id).catch(() => {})));
  const makeAction = (cId, cUri) => ({ id: cId, uri: cUri, group: 'then', delay: null, duration: null, args: {} });
  const results = {};
  try {
    const sf = await api.createFlow({ name: startName, folder: folderId, trigger: { id: `${APP_URI}:${startCardId}`, args: { [tokenName]: deviceId } }, conditions: [], actions: [makeAction(startActId, startCardUri)] });
    results.startFlowId = sf && sf.id;
  } catch (e) { return { folderId, startFlowError: e.message }; }
  try {
    const ef = await api.createFlow({ name: stopName, folder: folderId, trigger: { id: `${APP_URI}:${stopCardId}`, args: { [tokenName]: deviceId } }, conditions: [], actions: [makeAction(stopActId, stopCardUri)] });
    results.stopFlowId = ef && ef.id;
  } catch (e) { return { folderId, startFlowId: results.startFlowId, stopFlowError: e.message }; }
  return { folderId, ...results };
}

module.exports = {

  /**
   * GET /debug/devices
   * Returns all Modbus devices with their current capability values and settings.
   */
  async getDebugDevices({ homey }) {
    const result = [];

    for (const driverId of MODBUS_DRIVER_IDS) {
      let driver;
      try {
        driver = homey.drivers.getDriver(driverId);
      } catch {
        continue; // driver not installed or no devices
      }

      const devices = driver.getDevices();
      for (const device of devices) {
        const capabilities = {};
        for (const capId of device.getCapabilities()) {
          capabilities[capId] = device.getCapabilityValue(capId);
        }

        // Build static register definitions (address, type, label) sorted by address
        const registerDefs = {};
        for (const [groupName, registers] of Object.entries(DRIVER_REGISTER_SETS[driverId] || {})) {
          registerDefs[groupName] = Object.entries(registers)
            .map(([key, def]) => ({ key, address: def[0], length: def[1], type: def[2], label: def[3], decimalPower: def[4] ?? 0 }))
            .sort((a, b) => a.address - b.address);
        }

        result.push({
          driverId,
          deviceId:     device.getId(),
          name:         device.getName(),
          available:    device.getAvailable(),
          settings:     device.getSettings(),
          capabilities,
          registerDefs,
        });
      }
    }

    result.sort((a, b) => a.name.localeCompare(b.name));
    return { timestamp: new Date().toISOString(), version: APP_VERSION, devices: result };
  },

  /**
   * POST /debug/registers
   * Body: { driverId, deviceId }
   * Reads all raw register values for the given device over Modbus TCP.
   *
   * All register groups are merged into a single TCP connection so the total
   * round-trip fits well within Homey's API timeout.  Polling is paused first
   * so the connection slot is guaranteed to be free (Huawei devices only allow
   * one concurrent TCP session on port 502/6607).
   */
  async readDebugRegisters({ homey, body }) {
    const log = (...a) => { try { homey.app.log('[ReadLive]', ...a); } catch { /* no-op */ } };
    try {
      const { driverId, deviceId } = body || {};
      log(`request: driverId=${driverId} deviceId=${deviceId}`);

      if (!driverId || !deviceId) {
        return { error: 'Missing driverId or deviceId' };
      }

      let driver;
      try {
        driver = homey.drivers.getDriver(driverId);
      } catch {
        return { error: `Driver not found: ${driverId}` };
      }

      const devices = driver.getDevices();
      const device  = devices.find(d => d.getId() === deviceId);
      if (!device) return { error: 'Device not found' };

      const settings  = device.getSettings();
      const address   = settings.address;
      const port      = parseInt(settings.port,      10) || 502;
      const modbusId  = parseInt(settings.modbus_id, 10);
      const unitId    = Number.isFinite(modbusId) ? modbusId : 1;
      log(`target: ${address}:${port} unit=${unitId}`);

      if (!address) return { error: 'No IP address configured for this device' };

      const registerSets = DRIVER_REGISTER_SETS[driverId];
      if (!registerSets) return { error: `No register map defined for driver: ${driverId}` };

      // ── 1. Pause polling on all devices sharing this host ────────────────────
      const pausedDevices = [];
      for (const dId of MODBUS_DRIVER_IDS) {
        let drv;
        try { drv = homey.drivers.getDriver(dId); } catch { continue; }
        for (const dev of drv.getDevices()) {
          try {
            if ((dev.getSetting('address') || '').trim() !== address) continue;
            if (typeof dev._stopPolling === 'function') {
              await dev._stopPolling();
              pausedDevices.push(dev);
            }
          } catch { /* ignore */ }
        }
      }

      // Wait for any in-flight fetch to finish (max 2 s)
      const deadline = Date.now() + 2000;
      for (const dev of pausedDevices) {
        while (dev._fetchInProgress && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 100)); // eslint-disable-line no-promise-executor-return
        }
      }

      // ── 2. Merge all register groups into a single flat map ──────────────────
      // Use group name + NUL byte as separator so keys are unique across groups.
      // This lets us open ONE TCP connection instead of one per group.
      const merged = {};
      for (const [groupName, registers] of Object.entries(registerSets)) {
        for (const [key, def] of Object.entries(registers)) {
          merged[`${groupName}\x00${key}`] = def;
        }
      }

      // ── 3. Single probe — bypasses queue lock (safe because polling is paused) ─
      const PROBE_TIMEOUT_MS = 12000;
      log(`probing ${Object.keys(merged).length} registers…`);
      const raw = await probeModbusUnit(address, port, unitId, merged, PROBE_TIMEOUT_MS);
      log(`probe done: ${raw === null ? 'null (connection failed)' : `${Object.keys(raw).length} values`}`);

      // ── 4. Resume polling ────────────────────────────────────────────────────
      for (const dev of pausedDevices) {
        try { if (typeof dev._startPolling === 'function') await dev._startPolling(); } catch { /* ignore */ }
      }

      // ── 5. Reassemble per-group results ──────────────────────────────────────
      const result = {};
      for (const [groupName, registers] of Object.entries(registerSets)) {
        if (raw === null) {
          result[groupName] = { ok: false, error: 'Connection failed or timed out' };
          continue;
        }
        const rows = {};
        for (const [key, regDef] of Object.entries(registers)) {
          rows[key] = {
            address: regDef[0],
            length:  regDef[1],
            type:    regDef[2],
            label:   regDef[3],
            value:   raw[`${groupName}\x00${key}`] ?? null,
          };
        }
        result[groupName] = { ok: true, registers: rows };
      }

      return {
        timestamp: new Date().toISOString(),
        device:    device.getName(),
        address,
        port,
        unitId,
        groups:    result,
      };
    } catch (err) {
      return { error: `Unexpected error: ${err.message}` };
    }
  },

  /**
   * POST /debug/register-single
   * Body: { driverId, deviceId, address, length, type }
   * Reads a single Modbus register without touching any other registers.
   * Pauses polling on the device first so the TCP slot is free.
   */
  async postDebugRegisterSingle({ homey, body }) {
    const log = (...a) => homey.log('[API /debug/register-single]', ...a);
    try {
      const { driverId, deviceId, address, length, type, decimalPower } = body;
      if (!driverId || !deviceId || address == null || !length || !type) {
        return { error: 'Missing required fields: driverId, deviceId, address, length, type' };
      }

      let driver;
      try { driver = homey.drivers.getDriver(driverId); } catch {
        return { error: `Driver not found: ${driverId}` };
      }
      const device = driver.getDevices().find(d => d.getId() === deviceId);
      if (!device) return { error: 'Device not found' };

      const settings = device.getSettings();
      const host     = settings.address;
      const port     = parseInt(settings.port,      10) || 502;
      const unitId   = parseInt(settings.modbus_id, 10) || 1;
      if (!host) return { error: 'No IP address configured for this device' };

      // Pause polling so the TCP slot is free
      const pausedDevices = [];
      for (const dId of MODBUS_DRIVER_IDS) {
        let drv;
        try { drv = homey.drivers.getDriver(dId); } catch { continue; }
        for (const dev of drv.getDevices()) {
          try {
            if ((dev.getSetting('address') || '').trim() !== host) continue;
            if (typeof dev._stopPolling === 'function') {
              await dev._stopPolling();
              pausedDevices.push(dev);
            }
          } catch { /* ignore */ }
        }
      }
      const deadline = Date.now() + 2000;
      for (const dev of pausedDevices) {
        while (dev._fetchInProgress && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 100)); // eslint-disable-line no-promise-executor-return
        }
      }

      log(`reading register ${address} (len=${length} type=${type}) from ${host}:${port} unit=${unitId}`);
      const raw = await probeModbusUnit(host, port, unitId, { r: [address, length, type, '', decimalPower ?? 0] }, 8000);

      for (const dev of pausedDevices) {
        try { if (typeof dev._startPolling === 'function') await dev._startPolling(); } catch { /* ignore */ }
      }

      if (raw === null) return { error: 'Connection failed or timed out' };
      return { value: raw.r ?? null };
    } catch (err) {
      return { error: `Unexpected error: ${err.message}` };
    }
  },

  // ─── Connection Tool ──────────────────────────────────────────────────────────

  /**
   * GET /scan/network
   * Returns all non-loopback IPv4 interfaces on the Homey host.
   */
  async getNetworkInfo() {
    const ifaces = os.networkInterfaces();
    const nets   = [];
    for (const [name, addrs] of Object.entries(ifaces)) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          nets.push({ iface: name, address: addr.address, netmask: addr.netmask, cidr: addr.cidr });
        }
      }
    }
    return { networks: nets };
  },

  /**
   * POST /scan/ports
   * Body: { baseIp }   e.g. "192.168.1"
   * Scans 192.168.1.1–254 on ports 502 and 6607, returns hosts that answered.
   */
  async scanPorts({ homey, body }) {
    const { baseIp } = body || {};
    if (!baseIp) return { error: 'Missing baseIp' };

    const PORTS      = [502, 6607];
    const TIMEOUT_MS = 400;
    const CONCURRENCY = 50;

    // Hosts we poll ourselves. Huawei devices accept exactly one connection, so a bare
    // TCP connect on port 502 is enough to kill an in-flight read. Strangers on the subnet
    // cannot disturb our polling, so only our own hosts pay for the lock — that also keeps
    // the lock map from collecting an entry for all 254 addresses on every scan.
    const ownHosts = new Set();
    for (const dId of MODBUS_DRIVER_IDS) {
      let drv;
      try { drv = homey.drivers.getDriver(dId); } catch { continue; }
      for (const dev of drv.getDevices()) {
        try {
          const addr = (dev.getSetting('address') || '').trim();
          if (addr) ownHosts.add(`${addr}:${parseInt(dev.getSetting('port'), 10) || 502}`);
        } catch { /* ignore */ }
      }
    }

    // TCP connect probe
    function tcpCheck(host, port) {
      return new Promise((resolve) => {
        const sock = new net.Socket();
        let done   = false;
        const finish = (ok) => { if (!done) { done = true; sock.destroy(); resolve(ok); } };
        sock.setTimeout(TIMEOUT_MS);
        sock.once('connect', () => finish(true));
        sock.once('timeout', () => finish(false));
        sock.once('error',   () => finish(false));
        sock.connect(port, host);
      });
    }

    // No priority here: unlike the register check, a port scan is not urgent. It should
    // wait its turn behind a running poll rather than interrupt it.
    const probe = (host, port) => (ownHosts.has(`${host}:${port}`)
      ? withHostLock(host, port, () => tcpCheck(host, port))
      : tcpCheck(host, port));

    // Build task list: all IPs × all ports
    const tasks = [];
    for (let i = 1; i <= 254; i++) {
      for (const port of PORTS) {
        tasks.push({ host: `${baseIp}.${i}`, port });
      }
    }

    // Run with limited concurrency
    const found = [];
    let idx     = 0;

    async function worker() {
      while (idx < tasks.length) {
        const { host, port } = tasks[idx++];
        const ok = await probe(host, port);
        if (ok) found.push({ host, port });
      }
    }

    const workers = Array.from({ length: CONCURRENCY }, worker);
    await Promise.all(workers);

    // Group by host
    const byHost = {};
    for (const { host, port } of found) {
      if (!byHost[host]) byHost[host] = [];
      byHost[host].push(port);
    }
    const hosts = Object.entries(byHost)
      .map(([host, ports]) => ({ host, ports }))
      .sort((a, b) => {
        const ai = parseInt(a.host.split('.')[3], 10);
        const bi = parseInt(b.host.split('.')[3], 10);
        return ai - bi;
      });

    return { hosts };
  },

  /**
   * POST /scan/confirm
   * Body: { host, port, unitId, driver }
   * Re-reads only the confirmation registers for a specific driver.
   * Used by the Device Tester retry button on unconfirmed compatible drivers.
   */
  async confirmDriver({ homey, body }) {
    try {
      const { host, port, unitId, driver } = body || {};
      if (!host || port === undefined || unitId === undefined || !driver) {
        return { error: 'Missing host, port, unitId or driver' };
      }

      // An EMMA answers its own addresses with real values. An SDongle answers them too —
      // measured 2026-09-02 at unit 100, with a plain 0 for every one of them rather than
      // an exception. Asking only whether a number came back made those zeroes proof, and
      // an installation with no EMMA was told it had three EMMA devices.
      //
      // So the group has to show life somewhere, which is why the three EMMA drivers below
      // read all four addresses rather than the one that names them. Not free of risk: an
      // EMMA at night, with no battery, no charger and exactly 0 W crossing the meter would
      // read as unconfirmed. That is the direction to be wrong in — an unconfirmed driver
      // offers a retry, a wrong green sends someone off to add hardware they do not own.
      const emmaLive = (d) => [d.emmaPvPower, d.emmaFeedInPower, d.emmaBatteryCapacity,
        d.emmaChargerRatedPow].some((v) => typeof v === 'number' && Number.isFinite(v) && v !== 0);

      // Map base driver name → the specific registers that confirm it
      const CONN_TYPE_LABEL_C = { 0: 'N/A', 2: 'WLAN', 3: '4G', 4: 'WLAN-FE', 5: 'WLAN-FE' };
      const DRIVER_CONFIRM = {
        sun2000_modbus: {
          registers: { modelName: [30000, 15, 'STRING', 'Model Name (SUN2000)', 0] },
          check:  d => typeof d.modelName === 'string' && d.modelName.replace(/\x00/g, '').trim().length > 0,
          detail: d => `Register 30000 (model name) = "${(d.modelName || '').replace(/\x00/g, '').trim()}"`,
        },
        luna2000_modbus: {
          registers: { luna2000Modules: [47750, 1, 'UINT16', 'Battery modules unit 1', 0] },
          check:  d => typeof d.luna2000Modules === 'number' && d.luna2000Modules > 0,
          detail: d => `Register 47750 (battery modules unit 1) = ${d.luna2000Modules}`,
        },
        dtsu666_modbus: {
          registers: { dtsuMeterStatus: [37100, 1, 'UINT16', 'DTSU666 Meter Status', 0] },
          check:  d => d.dtsuMeterStatus === 1,
          detail: d => `Register 37100 (meter status) = ${d.dtsuMeterStatus}`,
        },
        sdongle_a_modbus: {
          registers: {
            sdongleConnType:  [37410, 1, 'UINT16', 'SDongle Connection Type', 0],
            sdongleLoadPower: [37500, 2, 'UINT32', 'SDongle Load Power (W)', 0],
          },
          // ct >= 2 = active connection (WLAN/4G/WLAN-FE). ct = 0 (N/A) is returned by SUN2000 — excluded.
          // loadPower > 0: SUN2000 returns 0 for register 37500; a real SDongle always has house consumption.
          check:  d => d.sdongleConnType !== null && d.sdongleConnType !== undefined
                    && d.sdongleConnType >= 2 && d.sdongleConnType <= 5
                    && d.sdongleLoadPower !== null && d.sdongleLoadPower !== undefined
                    && d.sdongleLoadPower > 0 && d.sdongleLoadPower < 1e9,
          detail: d => `Register 37410 (connection type) = ${CONN_TYPE_LABEL_C[d.sdongleConnType] ?? d.sdongleConnType}, Register 37500 (load power) = ${d.sdongleLoadPower} W`,
        },
        sun2000_emma_modbus: {
          registers: {
            emmaPvPower:         [30354, 2, 'UINT32', 'EMMA PV Power (W)', 0],
            emmaFeedInPower:     [30358, 2, 'INT32',  'EMMA Feed-in Power (W)', 0],
            emmaBatteryCapacity: [30369, 2, 'UINT32', 'EMMA ESS Chargeable Capacity (kWh)', -3],
            emmaChargerRatedPow: [30076, 2, 'UINT32', 'Smart Charger Rated Power (W)', -1],
          },
          check:  d => emmaLive(d) && typeof d.emmaPvPower === 'number' && d.emmaPvPower < 1e9,
          detail: d => `Register 30354 (PV power) = ${d.emmaPvPower} W`,
        },
        luna2000_emma_modbus: {
          registers: {
            emmaPvPower:         [30354, 2, 'UINT32', 'EMMA PV Power (W)', 0],
            emmaFeedInPower:     [30358, 2, 'INT32',  'EMMA Feed-in Power (W)', 0],
            emmaBatteryCapacity: [30369, 2, 'UINT32', 'EMMA ESS Chargeable Capacity (kWh)', -3],
            emmaChargerRatedPow: [30076, 2, 'UINT32', 'Smart Charger Rated Power (W)', -1],
          },
          check:  d => emmaLive(d) && typeof d.emmaBatteryCapacity === 'number' && Number.isFinite(d.emmaBatteryCapacity),
          detail: d => `Register 30369 (ESS chargeable capacity) = ${d.emmaBatteryCapacity} kWh`,
        },
        powermeter_emma_modbus: {
          registers: {
            emmaPvPower:         [30354, 2, 'UINT32', 'EMMA PV Power (W)', 0],
            emmaFeedInPower:     [30358, 2, 'INT32',  'EMMA Feed-in Power (W)', 0],
            emmaBatteryCapacity: [30369, 2, 'UINT32', 'EMMA ESS Chargeable Capacity (kWh)', -3],
            emmaChargerRatedPow: [30076, 2, 'UINT32', 'Smart Charger Rated Power (W)', -1],
          },
          check:  d => emmaLive(d) && typeof d.emmaFeedInPower === 'number' && Math.abs(d.emmaFeedInPower) < 1e9,
          detail: d => `Register 30358 (feed-in power) = ${d.emmaFeedInPower} W`,
        },
        smartcharger_emma_modbus: {
          registers: { emmaChargerRatedPow: [30076, 2, 'UINT32', 'Smart Charger Rated Power (W)', -1] },
          check:  d => typeof d.emmaChargerRatedPow === 'number' && d.emmaChargerRatedPow > 0 && d.emmaChargerRatedPow < 100000,
          detail: d => `Register 30076 (charger rated power) = ${d.emmaChargerRatedPow} W`,
        },
      };

      // Strip the "(Unit ID X)" suffix the frontend appends to driver names
      const baseDriver = driver.replace(/\s*\(Unit ID[^)]*\)/, '').trim();
      const conf = DRIVER_CONFIRM[baseDriver];
      if (!conf) return { error: `No confirmation logic for driver: ${baseDriver}` };

      // Pause devices on this host only
      const pausedDevices = [];
      for (const driverId of MODBUS_DRIVER_IDS) {
        let drv;
        try { drv = homey.drivers.getDriver(driverId); } catch { continue; }
        for (const device of drv.getDevices()) {
          try {
            if ((device.getSetting('address') || '').trim() !== host) continue;
            if (typeof device._stopPolling === 'function') {
              await device._stopPolling();
              pausedDevices.push(device);
            }
          } catch { /* ignore */ }
        }
      }

      let data;
      try {
        data = await probeModbusUnit(host, parseInt(port, 10), parseInt(unitId, 10), conf.registers, 4000);
      } finally {
        for (const device of pausedDevices) {
          try { if (typeof device._startPolling === 'function') await device._startPolling(); } catch { /* ignore */ }
        }
      }

      if (data === null) return { confirmed: false, detail: 'Connection failed or timed out' };

      const confirmed = conf.check(data);
      const detail    = conf.detail(data);
      return { confirmed, detail };
    } catch (err) {
      return { error: `Confirm failed: ${err.message}` };
    }
  },

  // ─── OpenAPI Debugger ──────────────────────────────────────────────────────

  async getOpenapiCredentials({ homey }) {
    const OPENAPI_DRIVER_IDS = [
      'sun2000_openapi_fusionsolar',
      'luna2000_openapi_fusionsolar',
      'powermeter_openapi_fusionsolar',
    ];
    for (const driverId of OPENAPI_DRIVER_IDS) {
      let driver;
      try { driver = homey.drivers.getDriver(driverId); } catch { continue; }
      for (const device of driver.getDevices()) {
        const s = device.getSettings();
        if (s.username && s.system_code) {
          return {
            baseUrl:     s.base_url || 'https://eu5.fusionsolar.huawei.com',
            username:    s.username,
            systemCode:  s.system_code,
            stationCode: s.station_code || '',
          };
        }
      }
    }
    return { baseUrl: 'https://eu5.fusionsolar.huawei.com', username: '', systemCode: '', stationCode: '' };
  },

  // ─── EMS settings API ─────────────────────────────────────────────────────────

  /** GET /ems/devices — returns all Homey devices for dropdown selection */
  async getEmsDevices({ homey }) {
      // Keeps its own lookup rather than using _emsApi: this route reports WHY the key is
      // missing (driver present? how many devices? key set but empty?), which the shared
      // helper deliberately does not carry — it answers only "usable client or not".
    let apiKey = '';
    let diagInfo = '';
    try {
      const driver  = homey.drivers.getDriver('energy_management');
      const devices = driver.getDevices();
      diagInfo = `driver found, ${devices.length} device(s)`;
      if (devices.length > 0) {
        const key = devices[0].getSetting('homey_api_key');
        diagInfo += `, key=${key ? 'set(' + key.length + ' chars)' : 'empty/null'}`;
        apiKey = key || '';
      }
    } catch (e) {
      diagInfo = `exception: ${e.message}`;
    }
    if (!apiKey) return { error: `No EMS device or API key found. Add an EMS device first. [${diagInfo}]` };
      const HomeyLocalApi = require('./lib/homey-local-api');
      const api  = new HomeyLocalApi({ homey, apiKey });

    const data = await api.getDevices();
    return Object.values(data).map((d) => ({
      id:              d.id,
      name:            d.name || '(unnamed)',
      driverId:        d.driverId || '',
      deviceClass:     d.class || '',
      capabilities:    Array.isArray(d.capabilities) ? d.capabilities : Object.keys(d.capabilities || {}),
      energyEvCharger:    !!(d.energy && d.energy.evCharger),
      energyHomeBattery:  !!(d.energy && d.energy.homeBattery),
      energyCumulative:   !!(d.energy && d.energy.cumulative),
    }));
  },

  /** GET /ems/debug — returns raw REST API fields for first 5 devices (for debugging) */
  async getEmsDebug({ homey }) {
    const _ems = _emsApi(homey);
    if (!_ems) return { error: 'No API key' };
    const { api, apiKey } = _ems;

    const data = await api.getDevices();
    return Object.values(data).slice(0, 5).map((d) => ({
      name:         d.name,
      // Raw fields from the Homey local REST API:
      raw_class:    d.class,
      raw_driverId: d.driverId,
      raw_energy:   d.energy,
      raw_caps_type: Array.isArray(d.capabilities) ? 'array' : (d.capabilities ? 'object' : 'null/undefined'),
      raw_caps_sample: Array.isArray(d.capabilities)
        ? d.capabilities.slice(0, 4)
        : Object.keys(d.capabilities || {}).slice(0, 4),
      // All top-level keys of the raw device object:
      raw_keys: Object.keys(d).join(', '),
    }));
  },

  /** POST /ems/capability { deviceId, cap } — reads a single capability value */
  async postEmsCapabilityValue({ homey, body }) {
    const { deviceId, cap } = body || {};
    if (!deviceId || !cap) return { value: null, error: 'Missing deviceId or cap' };
    const _ems = _emsApi(homey);
    if (!_ems) return { value: null, error: 'No API key' };
    const { api, apiKey } = _ems;
    const device = await api.getDevice(deviceId);
    if (!device) return { value: null, error: 'Device not found' };
    // capabilitiesObj is an object keyed by capability ID containing { value, ... }
    const capObj = device.capabilitiesObj || device.capabilities || {};
    const entry  = typeof capObj === 'object' && !Array.isArray(capObj) ? capObj[cap] : null;
    const value  = entry !== null && entry !== undefined
      ? (typeof entry === 'object' ? (entry.value ?? null) : entry)
      : null;
    return { value };
  },

  /** GET /ems/trigger-cards — returns all trigger cards from Homey to find the correct ID format */
  async getEmsTriggerCards({ homey }) {
    const _ems = _emsApi(homey);
    if (!_ems) return { error: 'No API key' };
    const { api, apiKey } = _ems;

    try {
      const raw = await api._req('GET', '/manager/flow/flowcardtrigger');
      const all = Object.values(raw || {});

      // Find cards from our app
      const ours = all.filter((c) => {
        const u = c.ownerUri || c.uri || '';
        return u.includes('fusionsolar') || (c.id || '').includes('ems_');
      });

      // Find the specific card we use for flow creation
      const targetUri = 'homey:app:com.huawei.fusionsolar';
      const found = all.find((c) =>
        (c.id === 'ems_set_charger_current' || c.id === `${targetUri}:ems_set_charger_current`) &&
        (c.ownerUri || c.uri || '') === targetUri
      );

      // Sample to understand field structure
      const sample = all.slice(0, 2);

      return {
        total:      all.length,
        ours,
        targetCard: found || null,
        targetFound: !!found,
        sample,
      };
    } catch (e) {
      return { error: e.message };
    }
  },

  /** GET /ems/debug/flow?flowId=xxx — returns the raw stored flow JSON from Homey */
  async getEmsDebugFlow({ homey, query }) {
    const flowId = query && query.flowId;

    const _ems = _emsApi(homey);
    if (!_ems) return { error: 'No API key' };
    const { api, apiKey } = _ems;

    try {
      if (flowId) {
        return await api._req('GET', `/manager/flow/flow/${flowId}`);
      }
      // No flowId → return compact list of all flows for browsing
      const all = await api.getFlows();
      return Object.values(all || {}).map((f) => ({
        id:      f.id,
        name:    f.name,
        folder:  f.folder,
        broken:  f.broken,
        trigger: f.trigger ? { id: f.trigger.id, uri: f.trigger.uri } : null,
        actions: (f.actions || []).map((a) => ({ id: a.id, uri: a.uri, args: a.args, droptoken: a.droptoken })),
      })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } catch (e) {
      return { error: e.message };
    }
  },

  /** GET /ems/flows — returns flows that use the ems_set_charger_current trigger */
  async getEmsFlows({ homey }) {
    const _ems = _emsApi(homey);
    if (!_ems) return { matched: [], all: [], emsDeviceId: '', error: 'No API key' };
    const { api, apiKey, emsDeviceId } = _ems;

    try {
      const [flows, advFlows] = await Promise.all([
        api.getFlows().catch(() => ({})),
        api.getAdvancedFlows().catch(() => ({})),
      ]);

      function parseActionCard(a) {
        if (!a) return { cardId: null, cardUri: null };
        const rawId = a.id || '';
        if (rawId.startsWith('homey:')) {
          const lastColon = rawId.lastIndexOf(':');
          return { cardId: rawId.slice(lastColon + 1), cardUri: rawId.slice(0, lastColon) };
        }
        return { cardId: rawId, cardUri: a.uri || '' };
      }

      // Index start-charger flows by name so we can join them to the set-current flow
      const startByName = {};
      for (const [, f] of Object.entries(flows || {})) {
        const tid = f.trigger && f.trigger.id || '';
        if (tid === 'ems_start_charger' || tid.endsWith(':ems_start_charger')) {
          const { cardId, cardUri } = parseActionCard((f.actions || [])[0]);
          startByName[f.name || ''] = { startCardId: cardId, startCardUri: cardUri };
        }
      }

      const matched = [];
      for (const [id, f] of Object.entries(flows || {})) {
        const tid = f.trigger && f.trigger.id || '';
        if (tid === 'ems_set_charger_current' || tid.endsWith(':ems_set_charger_current')) {
          const { cardId, cardUri } = parseActionCard((f.actions || [])[0]);
          const startName = `${f.name || ''} → Start`;
          const startInfo = startByName[startName] || {};
          matched.push({
            id,
            name:          f.name || id,
            type:          'flow',
            actionCardId:  cardId,
            actionCardUri: cardUri,
            startCardId:   startInfo.startCardId  || null,
            startCardUri:  startInfo.startCardUri || null,
            // For the settings-page "Run" test button
            triggerCardId: 'ems_set_charger_current',
            triggerArgs:   (f.trigger && f.trigger.args) || {},
          });
        }
      }
      const advList = Object.entries(advFlows || {}).map(([id, f]) => ({
        id, name: f.name || id, type: 'advanced',
      }));

      return {
        emsDeviceId,
        matched: matched.sort((a, b) => a.name.localeCompare(b.name)),
        all:     [...matched, ...advList].sort((a, b) => a.name.localeCompare(b.name)),
      };
    } catch (e) {
      return { matched: [], all: [], error: e.message };
    }
  },

  /**
   * GET /ems/trigger-usage?ids=a,b — how many existing flows react to each of the given
   * EMS trigger cards. The settings page uses this to gate options whose entire effect
   * depends on the user having created the matching flow first.
   *
   * Fails OPEN (`known: false`): without the local API key the flows cannot be enumerated,
   * and blocking every option would be worse than offering one that does nothing.
   */
  async getEmsTriggerUsage({ homey, query }) {
    const ids = String((query && query.ids) || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const counts = {};
    for (const id of ids) counts[id] = 0;
    const names = {};      // trigger id -> flow names, so the caller can show WHICH flows run
    for (const id of ids) names[id] = [];
    if (!ids.length) return { counts, names, known: true };

    const _ems = _emsApi(homey);
    if (!_ems) return { counts, names, known: false };
    const { api, apiKey } = _ems;

    try {
      const [flows, advFlows] = await Promise.all([
        api.getFlows().catch(() => ({})),
        api.getAdvancedFlows().catch(() => ({})),
      ]);
      // Stored card ids are either the bare id or "<uri>:<id>" depending on how the flow
      // was created — the same two shapes getEmsFlows already has to cope with.
      const matches = (raw, id) => typeof raw === 'string' && (raw === id || raw.endsWith(`:${id}`));

      for (const f of Object.values(flows || {})) {
        const tid = (f.trigger && f.trigger.id) || '';
        for (const id of ids) if (matches(tid, id)) { counts[id]++; if (f.name) names[id].push(f.name); }
      }
      // Advanced flows keep their trigger inside the card graph. Count each flow once per
      // trigger even if it holds several cards for the same one.
      for (const f of Object.values(advFlows || {})) {
        const seen = new Set();
        for (const card of Object.values(f.cards || {})) {
          if (!card) continue;
          for (const id of ids) {
            if (!seen.has(id) && matches(card.id, id)) { counts[id]++; seen.add(id); if (f.name) names[id].push(f.name); }
          }
        }
      }
      return { counts, names, known: true };
    } catch (e) {
      return { counts, names, known: false, error: e.message };
    }
  },

  /** GET /ems/scheduler/flows — flows in the _Huawei EMS folder available to the scheduler */
  async getEmsSchedulerFlows({ homey }) {
    const _ems = _emsApi(homey);
    if (!_ems) return { flows: [], error: 'No API key' };
    const { api, apiKey } = _ems;
    try {
      const [allFlows, folders] = await Promise.all([
        api.getFlows().catch(() => ({})),
        api.getFlowFolders().catch(() => ({})),
      ]);
      const emsFolder   = Object.values(folders || {}).find((f) => f.name === EMS_FLOW_FOLDER);
      const emsFolderId = emsFolder ? emsFolder.id : null;
      const flows = [];
      for (const [id, f] of Object.entries(allFlows || {})) {
        if (emsFolderId && f.folder !== emsFolderId) continue;
        flows.push({ id, name: f.name || id });
      }
      flows.sort((a, b) => a.name.localeCompare(b.name));
      return { flows };
    } catch (e) {
      return { flows: [], error: e.message };
    }
  },

  /** GET /ems/config — returns current EMS config from homey.settings */
  async getEmsConfig({ homey }) {
    return homey.settings.get('ems_config') || {};
  },

  /** GET /ems/history — returns EMS event log for the history widget */
  async getEmsHistory({ homey }) {
    try {
      const driver  = homey.drivers.getDriver('energy_management');
      const devices = driver.getDevices();
      if (!devices.length) return { events: [], error: 'No EMS device found' };
      const events = devices[0].getEmsHistory();
      return { events };
    } catch (e) {
      return { events: [], error: e.message };
    }
  },

  /** GET /ems/diag — tick-health + last decision snapshot (B7/E3) */
  async getEmsDiag({ homey }) {
    try {
      const driver  = homey.drivers.getDriver('energy_management');
      const devices = driver.getDevices();
      if (!devices.length) return { error: 'No EMS device found' };
      return devices[0].getEmsDiag();
    } catch (e) {
      return { error: e.message };
    }
  },

  async getEmsPvForecast({ homey }) {
    try {
      const driver  = homey.drivers.getDriver('energy_management');
      const devices = driver.getDevices();
      if (!devices.length) return { error: 'No EMS device found' };
      return devices[0].getPvForecast();
    } catch (e) {
      return { error: e.message };
    }
  },

  async getEmsPriceForecast({ homey }) {
    try {
      const driver  = homey.drivers.getDriver('energy_management');
      const devices = driver.getDevices();
      if (!devices.length) return { error: 'No EMS device found' };
      return devices[0].getPriceForecast();
    } catch (e) {
      return { error: e.message };
    }
  },

  /** GET /ems/battery-price-plans — live "what would each price-enabled battery do now" preview */
  async getEmsBatteryPricePlans({ homey }) {
    try {
      const driver  = homey.drivers.getDriver('energy_management');
      const devices = driver.getDevices();
      if (!devices.length) return { error: 'No EMS device found' };
      return { plans: await devices[0].getEmsBatteryPricePlans() };
    } catch (e) {
      return { error: e.message };
    }
  },

  /** GET /ems/charge-sessions — completed charging sessions (energy + cost), newest first */
  async getEmsChargeSessions({ homey }) {
    try {
      const driver  = homey.drivers.getDriver('energy_management');
      const devices = driver.getDevices();
      if (!devices.length) return { error: 'No EMS device found' };
      return { sessions: devices[0].getEmsChargeSessions() };
    } catch (e) {
      return { error: e.message };
    }
  },

  /** GET /ems/charger-price-plans — live "what would each price-aware charger do now" preview */
  async getEmsChargerPricePlans({ homey }) {
    try {
      const driver  = homey.drivers.getDriver('energy_management');
      const devices = driver.getDevices();
      if (!devices.length) return { error: 'No EMS device found' };
      return { plans: await devices[0].getEmsChargerPricePlans() };
    } catch (e) {
      return { error: e.message };
    }
  },

  /**
   * GET /ems/price-forecast/trigger-cards?deviceId=xxx — lists trigger cards available for
   * a device (e.g. "Power by the Hour"'s "New prices received"), for the D10 price-forecast
   * flow setup. Mirrors getEmsChargerActionCards but for TRIGGER cards — the direction is
   * reversed for this feature: an external app's trigger feeds our ems_set_price_forecast
   * action, instead of our trigger feeding an external action.
   */
  async getEmsPriceForecastTriggerCards({ homey, query }) {
    const { deviceId } = query || {};
    if (!deviceId) return { error: 'Missing deviceId' };

    const _ems = _emsApi(homey);
    if (!_ems) return { error: 'No API key' };
    const { api, apiKey } = _ems;

    const allDevices = await api.getDevices();
    const device      = allDevices[deviceId];
    if (!device) return { error: 'Device not found' };

    let allCardList = [];
    try { allCardList = Object.values(await api.getFlowTriggerCards() || {}); } catch { /* ignore */ }

    const resolveTitle = (t) => {
      if (!t) return '';
      if (typeof t === 'string') return t;
      return t.en || t.de || Object.values(t)[0] || '';
    };

    const deviceUri = `homey:device:${deviceId}`;
    const allCards = allCardList.map((c) => {
      const cUri = c.ownerUri || c.uri || '';
      return {
        id:        c.id,
        uri:       cUri,
        title:     resolveTitle(c.title) || c.id,
        hint:      resolveTitle(c.hint) || '',
        suggested: cUri === deviceUri,
        args:      (c.args || []).map((a) => ({
          name:   a.name,
          type:   a.type,
          title:  resolveTitle(a.title) || a.name,
          values: Array.isArray(a.values) ? a.values.map((v) => ({ id: v.id, title: resolveTitle(v.title) || v.id })) : undefined,
        })),
        // Tokens tell the settings UI which token to tell the user to drag into our
        // action's "prices" field (e.g. "Prices" from Power by the Hour's new_prices card).
        // hint (when the source app provides one) is the most reliable way to know what
        // the token's array actually represents (today from midnight vs. a rolling
        // window) — straight from the source app's own card definition.
        tokens: (c.tokens || []).map((t) => ({ name: t.name, type: t.type, title: resolveTitle(t.title) || t.name, hint: resolveTitle(t.hint) || '' })),
      };
    });

    const grouped = new Map();
    for (const c of allCards) {
      const group = grouped.get(c.uri) || [];
      group.push(c);
      grouped.set(c.uri, group);
    }
    const groups = [...grouped.entries()]
      .sort(([a], [b]) => {
        const aS = a === deviceUri ? 0 : 1;
        const bS = b === deviceUri ? 0 : 1;
        if (aS !== bS) return aS - bS;
        return a.localeCompare(b);
      })
      .map(([uri, cards]) => ({
        uri,
        label:     uri === deviceUri ? `★ ${device.name || deviceId}` : uri.replace('homey:app:', '').replace('homey:manager:', '').replace('homey:zone:', 'Zone '),
        suggested: uri === deviceUri,
        cards,
      }));

    return { deviceName: device.name, driverId: device.driverId, deviceUri, totalCards: allCardList.length, groups };
  },

  /**
   * POST /ems/price-forecast/setup-flows — creates one flow per requested period
   * (e.g. "this_day" + "next_hours"), each linking the chosen external trigger card to
   * our own ems_set_price_forecast action. The action's `prices` argument is deliberately
   * left EMPTY: Homey's token-drop encoding for a foreign trigger's token isn't something
   * this app can safely reconstruct, so dragging the price token into the action is the
   * one manual step left for the user — everything else (folder, trigger device/period
   * args, our own device/period args) is pre-filled.
   */
  async postEmsPriceForecastSetupFlows({ homey, body }) {
    const { emsDeviceId, deviceId, deviceName, triggerCardId, triggerCardUri, periods } = body || {};
    const periodList = Array.isArray(periods) && periods.length ? periods : [null];
    if (!emsDeviceId || !deviceId || !triggerCardId || !triggerCardUri) {
      return { error: 'Missing required fields (emsDeviceId, deviceId, triggerCardId, triggerCardUri)' };
    }

    const _ems = _emsApi(homey);
    if (!_ems) return { error: 'No API key — configure EMS device first' };
    const { api, apiKey } = _ems;

    const APP_URI = 'homey:app:com.huawei.fusionsolar';

    // Look up the trigger card's own arg definitions once, so we know which of its
    // args are the device picker vs. a period-style dropdown we can pre-fill.
    let triggerArgDefs = [];
    try {
      const raw = await api.getFlowTriggerCards();
      const card = Object.values(raw || {}).find((c) => c.id === triggerCardId && (c.ownerUri || c.uri) === triggerCardUri);
      triggerArgDefs = (card && card.args) || [];
    } catch { /* ignore */ }

    // Our own cards (both trigger and action) are referenced as a single compound
    // "appUri:cardId" string, exactly like every other own-trigger flow built in this
    // app (e.g. ems_start_charger / ems_start_heat_pump) — never looked up via the
    // flow-card database, which doesn't list the calling app's own cards back to it.

    const folderId = await _emsFlowFolderId(api);

    const baseName = `EMS: ${deviceName || deviceId} → Price forecast`;
    const allFlows = await api.getFlows().catch(() => ({}));
    const results  = [];

    for (const period of periodList) {
      const flowName = period ? `${baseName} (${period})` : baseName;
      await Promise.all(Object.values(allFlows || {}).filter((f) => f.name === flowName).map((f) => api.deleteFlow(f.id).catch(() => {})));

      const triggerArgs = {};
      for (const a of triggerArgDefs) {
        if (a.type === 'device') triggerArgs[a.name] = { id: deviceId };
        else if (period && a.name === 'period') triggerArgs[a.name] = period;
      }
      const trigger = { id: triggerCardId, uri: triggerCardUri, args: triggerArgs };
      const actionArgs = { device: { id: emsDeviceId }, period: period || 'next_hours' }; // 'prices' intentionally left unset

      // Try a few id/uri shapes for referencing our OWN action card — the flow-card
      // database doesn't list an app's own cards back to it, so we can't look the
      // right shape up; probe short-id-only, then id+uri, then compound id.
      const actionVariants = [
        { id: 'ems_set_price_forecast', group: 'then', delay: null, duration: null, args: actionArgs },
        { id: 'ems_set_price_forecast', uri: APP_URI, group: 'then', delay: null, duration: null, args: actionArgs },
        { id: `${APP_URI}:ems_set_price_forecast`, group: 'then', delay: null, duration: null, args: actionArgs },
      ];

      let created = null; let err = null; let variantUsed = null;
      for (let i = 0; i < actionVariants.length; i++) {
        try {
          created = await api.createFlow({ name: flowName, folder: folderId, trigger, conditions: [], actions: [actionVariants[i]] });
          if (created && created.id) { variantUsed = i; break; }
        } catch (e) { err = e.message; }
      }
      // If referencing our own action card is blocked in every shape, fall back to a
      // trigger-only skeleton — still saves the user from building the trigger by hand.
      let actionMissing = false;
      if (!created) {
        try {
          created = await api.createFlow({ name: flowName, folder: folderId, trigger, conditions: [], actions: [] });
          if (created && created.id) actionMissing = true;
        } catch (e) { err = e.message; }
      }
      results.push({ name: flowName, flowId: created && created.id, ok: !!(created && created.id), error: err, variantUsed, actionMissing });
    }

    const ok = results.filter((r) => r.ok).length;
    if (ok === 0) return { error: `Flow creation failed: ${results[0] && results[0].error || 'rejected by Homey'}`, results };
    const anyActionMissing = results.some((r) => r.actionMissing);
    return { created: ok, results, needsToken: true, actionMissing: anyActionMissing };
  },

  /** GET /ems/price-forecast/flows — flows whose action targets ems_set_price_forecast (read-back) */
  async getEmsPriceForecastFlows({ homey }) {
    const _ems = _emsApi(homey);
    if (!_ems) return { matched: [], error: 'No API key' };
    const { api, apiKey, emsDeviceId } = _ems;

    try {
      const flows = await api.getFlows().catch(() => ({}));
      const matched = [];
      for (const [id, f] of Object.entries(flows || {})) {
        const action = (f.actions || [])[0];
        const aid = action && action.id || '';
        // Substring match, not exact — Homey stores the id differently depending on
        // whether WE created the flow (short id) or the user built it by hand in the
        // Flow editor (observed to differ; exact format isn't documented).
        const isOwnAction = aid.indexOf('ems_set_price_forecast') !== -1;
        // Trigger-only skeletons (created when Homey blocked pre-wiring our own action)
        // have no action at all — recognise them by the flow name we generate.
        const isSkeleton = !action && /→ Price forecast/.test(f.name || '');
        if (!isOwnAction && !isSkeleton) continue;
        const tid = (f.trigger && f.trigger.id) || '';
        const tUri = (f.trigger && f.trigger.uri) || '';
        // Recover which source device the trigger was wired to, so the settings page
        // can re-select it in the Flow-setup dropdowns after a page reload. For a
        // device-owned trigger card (the normal case here — e.g. "Power by the Hour"),
        // the device is encoded in the trigger's own `uri` ("homey:device:<id>"), not
        // as one of its `args` — there usually isn't a separate "device" arg at all.
        // Fall back to scanning args only for app/manager-owned cards that do pass the
        // device explicitly as an arg.
        let triggerDeviceId = null;
        if (tUri.startsWith('homey:device:')) {
          triggerDeviceId = tUri.slice('homey:device:'.length);
        } else {
          const triggerArgs = (f.trigger && f.trigger.args) || {};
          const deviceArg = Object.values(triggerArgs).find((v) => v && typeof v === 'object' && v.id);
          triggerDeviceId = deviceArg ? deviceArg.id : null;
        }
        matched.push({
          id, name: f.name || id,
          period:        (action && action.args && action.args.period) || null,
          triggerCardId: tid.indexOf(':') !== -1 ? tid.slice(tid.lastIndexOf(':') + 1) : tid,
          triggerCardUri: tUri,
          triggerDeviceId,
          hasPricesArg:  !!(action && action.args && action.args.prices),
          actionMissing: isSkeleton,
        });
      }
      return { emsDeviceId, matched: matched.sort((a, b) => a.name.localeCompare(b.name)) };
    } catch (e) {
      return { matched: [], error: e.message };
    }
  },

  /** GET /ems/charger/action-cards?deviceId=xxx — lists action cards available for a device */
  async getEmsChargerActionCards({ homey, query }) {
    const { deviceId } = query || {};
    if (!deviceId) return { error: 'Missing deviceId' };

    const _ems = _emsApi(homey);
    if (!_ems) return { error: 'No API key' };
    const { api, apiKey } = _ems;

    const allDevices = await api.getDevices();
    const device     = allDevices[deviceId];
    if (!device) return { error: 'Device not found' };

    // Extract app URI: "homey:app:no.easee:charger" → "homey:app:no.easee"
    const appUri = device.ownerUri
      || (device.driverId ? device.driverId.replace(/:[^:]+$/, '') : '');

    // Load all action cards and return them grouped by ownerUri
    // so the user can identify and pick the right card for their device
    let allCardList = [];
    try {
      const raw = await api._req('GET', '/manager/flow/flowcardaction');
      allCardList = Object.values(raw || {});
    } catch (_) {}

    function resolveTitle(t) {
      if (!t) return '';
      if (typeof t === 'string') return t;
      return t.en || t.de || Object.values(t)[0] || '';
    }

    // Device URI — cards for this specific device appear under this key
    const deviceUri = `homey:device:${deviceId}`;

    // Map all cards; mark those belonging to this charger device as "suggested"
    const allCards = allCardList.map((c) => {
      const cUri  = c.ownerUri || c.uri || '';
      return {
        id:        c.id,
        uri:       cUri,
        title:     resolveTitle(c.title) || c.id,
        suggested: cUri === deviceUri,
        args:      (c.args || []).map((a) => ({
          name:  a.name,
          type:  a.type,
          title: resolveTitle(a.title) || a.name,
        })),
      };
    });

    // Group all cards by URI for display
    const grouped = new Map();
    for (const c of allCards) {
      const group = grouped.get(c.uri) || [];
      group.push(c);
      grouped.set(c.uri, group);
    }

    // Build groups sorted: charger device first, then alphabetical
    const groups = [...grouped.entries()]
      .sort(([a], [b]) => {
        const aS = a === deviceUri ? 0 : 1;
        const bS = b === deviceUri ? 0 : 1;
        if (aS !== bS) return aS - bS;
        return a.localeCompare(b);
      })
      .map(([uri, cards]) => ({
        uri,
        label:     uri === deviceUri
          ? `★ ${device.name || deviceId}`
          : uri.replace('homey:app:', '').replace('homey:manager:', '').replace('homey:zone:', 'Zone '),
        suggested: uri === deviceUri,
        cards:     cards.map((c) => ({
          id:        c.id,
          uri:       c.uri,
          title:     c.title,
          suggested: c.suggested || false,
          _isCap:    c._isCap || false,
          args:      c.args,
        })),
      }));

    return {
      deviceName: device.name,
      driverId:   device.driverId,
      deviceUri,
      totalCards: allCardList.length,
      groups,
    };
  },

  /** GET /ems/charger/condition-cards?deviceId=xxx — condition cards for the charger device */
  async getEmsChargerConditionCards({ homey, query }) {
    const { deviceId } = query || {};
    if (!deviceId) return { error: 'Missing deviceId' };

    const _ems = _emsApi(homey);
    if (!_ems) return { error: 'No API key' };
    const { api, apiKey } = _ems;


    const resolveTitle = (t) => (t && typeof t === 'object') ? (t.de || t.en || Object.values(t)[0] || '') : (t || '');

    try {
      const [allRaw, device] = await Promise.all([
        api._req('GET', '/manager/flow/flowcardcondition'),
        api.getDevice(deviceId).catch(() => null),
      ]);

      const deviceUri  = `homey:device:${deviceId}`;
      const allCards   = Object.values(allRaw || {});
      const deviceCards = allCards
        .filter((c) => (c.ownerUri || c.uri || '') === deviceUri)
        .map((c) => ({
          id:       c.id,
          uri:      deviceUri,
          title:    resolveTitle(c.title) || c.id,
          args:     (c.args || []).map((a) => ({ name: a.name, type: a.type, title: resolveTitle(a.title) || a.name })),
        }));

      return { deviceName: device && device.name, cards: deviceCards };
    } catch (e) {
      return { error: e.message };
    }
  },

  /** POST /ems/charger/setup-flows — creates "Huawei EMS" folder + ONE advanced flow per charger */
  async postEmsChargerSetupFlows({ homey, body }) {
    // emsDeviceId: the paired EMS device (owner of the trigger card)
    // deviceId / deviceName: the EV charger to control
    // actionCardId / actionCardUri: the charger's set-current action card
    // actionArgName: the arg name for current/amps (default: "current")
    const { emsDeviceId, deviceId, deviceName, actionCardId, actionCardUri, actionCardTitle, actionArgName,
            startCardId, startCardUri } = body || {};
    if (!emsDeviceId || !deviceId || !actionCardId || !actionCardUri) {
      return { error: 'Missing emsDeviceId, deviceId, actionCardId, or actionCardUri' };
    }

    const _ems = _emsApi(homey);
    if (!_ems) return { error: 'No API key' };
    const { api, apiKey } = _ems;


    const folderId = await _emsFlowFolderId(api);

    // 2. Remove any existing EMS flow for this charger (avoid duplicates)
    const cardLabel = actionCardTitle ? ` → ${actionCardTitle}` : '';
    const flowName  = `EMS: ${deviceName || deviceId}${cardLabel}`;
    try {
      const allFlows = await api.getFlows();
      await Promise.all(
        Object.values(allFlows || {})
          .filter((f) => f.name === flowName)
          .map((f) => api.deleteFlow(f.id).catch(() => {}))
      );
    } catch (_) { /* ignore — delete is best-effort */ }

    // 3. Create ONE standard flow:
    //    [ems_set_charger_current | phase1, phase2, phase3] ──► [charger action]
    const APP_URI = 'homey:app:com.huawei.fusionsolar';

    // Cards with homey:device: URI: no "device" arg (URI already identifies the device).
    // Cards with homey:app: URI: need a "device" arg to route to the correct device.
    const isDeviceUri = actionCardUri.startsWith('homey:device:');
    const argNames    = Array.isArray(actionArgName)
      ? actionArgName
      : [actionArgName || 'value'];

    // Standard flows: number args use droptoken (single token dropped onto the card),
    // text/string args use [[tokenName]] inside the arg value.
    const baseActionArgs = isDeviceUri ? {} : { device: { id: deviceId, name: deviceName || deviceId } };

    // Build per-arg values — number args get their default 0 value; droptoken handles the binding.
    // If multiple phase args: map each to their own token via [[phaseN]] (text field workaround).
    const phaseTokenNames = ['phase1', 'phase2', 'phase3'];
    let droptoken = null;

    if (argNames.length === 1) {
      // Single arg → use droptoken for the token binding (standard Homey pattern for number fields)
      droptoken = 'amps';
    } else {
      // Multiple args (per-phase) → embed token names directly
      argNames.forEach((name, i) => {
        if (name) baseActionArgs[name] = `[[${phaseTokenNames[i] || 'amps'}]]`;
      });
    }

    const flowAction = {
      id:       actionCardId,
      uri:      actionCardUri,
      group:    'then',
      delay:    null,
      duration: null,
      args:     baseActionArgs,
    };
    if (droptoken) flowAction.droptoken = droptoken;

    const trigger = { id: `${APP_URI}:ems_set_charger_current`, args: { charger_device_id: deviceId } };

    // Flow A: always fires → SET current
    const flowPayload = {
      name:       flowName,
      folder:     folderId,
      trigger,
      conditions: [],
      actions:    [flowAction],
    };

    let createdFlow;
    try {
      createdFlow = await api.createFlow(flowPayload);
    } catch (err) {
      return { error: `Flow creation failed: ${err.message}`, payload: flowPayload };
    }

    // Flow B (optional): condition "not charging" → START charging
    let startFlowId = null;
    if (startCardId && startCardUri) {
      const startFlowName = `${flowName} → Start`;
      // Delete existing start flow
      try {
        const allFlows = await api.getFlows();
        await Promise.all(
          Object.values(allFlows || {})
            .filter((f) => f.name === startFlowName)
            .map((f) => api.deleteFlow(f.id).catch(() => {}))
        );
      } catch (_) { }

      const startPayload = {
        name:       startFlowName,
        folder:     folderId,
        trigger:    { id: `${APP_URI}:ems_start_charger`, args: { charger_device_id: deviceId } },
        conditions: [],
        actions: [{
          id:       startCardId,
          uri:      startCardUri,
          group:    'then',
          delay:    null,
          duration: null,
          args:     {},
        }],
      };

      try {
        const startFlow = await api.createFlow(startPayload);
        startFlowId = startFlow && startFlow.id;
      } catch (err) {
        return { folderId, flowId: createdFlow && createdFlow.id, startFlowError: err.message };
      }
    }

    return { folderId, flowId: createdFlow && createdFlow.id, startFlowId };
  },

  /** GET /ems/heatpump/action-cards?deviceId=xxx — action cards for a heat pump device */
  async getEmsHeatPumpActionCards({ homey, query }) {
    return this.getEmsChargerActionCards({ homey, query });
  },

  /** GET /ems/heatpump/flows — flows using ems_start/stop_heat_pump triggers */
  async getEmsHeatPumpFlows({ homey }) {
    const _ems = _emsApi(homey);
    if (!_ems) return { matched: [], error: 'No API key' };
    const { api, apiKey, emsDeviceId } = _ems;

    try {
      const flows = await api.getFlows().catch(() => ({}));
      const matched = [];
      for (const [id, f] of Object.entries(flows || {})) {
        const tid = f.trigger && f.trigger.id || '';
        if (tid.endsWith(':ems_start_heat_pump') || tid.endsWith(':ems_stop_heat_pump')
            || tid === 'ems_start_heat_pump' || tid === 'ems_stop_heat_pump') {
          const firstAction = (f.actions || [])[0];
          let cardId = null, cardUri = null;
          if (firstAction) {
            const rawId = firstAction.id || '';
            if (rawId.startsWith('homey:')) {
              const lastColon = rawId.lastIndexOf(':');
              cardId  = rawId.slice(lastColon + 1);
              cardUri = rawId.slice(0, lastColon);
            } else {
              cardId  = rawId;
              cardUri = firstAction.uri || '';
            }
          }
          matched.push({
            id, name: f.name || id, type: 'flow',
            triggerType:   (tid.endsWith(':ems_start_heat_pump') || tid === 'ems_start_heat_pump') ? 'start' : 'stop',
            actionCardId:  cardId,
            actionCardUri: cardUri,
            // Short card id + the flow's own filter args — powers the "Run" test
            // button and the "filter mismatch" warning.
            triggerCardId:   tid.indexOf(':') !== -1 ? tid.slice(tid.lastIndexOf(':') + 1) : tid,
            triggerArgs:     (f.trigger && f.trigger.args) || {},
            triggerDeviceId: (f.trigger && f.trigger.args && f.trigger.args.heat_pump_device_id) || '',
          });
        }
      }
      return { emsDeviceId, matched: matched.sort((a, b) => a.name.localeCompare(b.name)) };
    } catch (e) {
      return { matched: [], error: e.message };
    }
  },

  /** POST /ems/heatpump/setup-flows — creates start + stop flows for a heat pump */
  async postEmsHeatPumpSetupFlows({ homey, body }) {
    const { emsDeviceId, deviceId, deviceName, startCardId, startCardUri, stopCardId, stopCardUri } = body || {};
    if (!emsDeviceId || !deviceId || !startCardId || !startCardUri || !stopCardId || !stopCardUri) {
      return { error: 'Missing required fields (emsDeviceId, deviceId, startCardId, startCardUri, stopCardId, stopCardUri)' };
    }

    const _ems = _emsApi(homey);
    if (!_ems) return { error: 'No API key' };
    const { api, apiKey } = _ems;

    const APP_URI = 'homey:app:com.huawei.fusionsolar';

    const folderId = await _emsFlowFolderId(api);

    const baseName  = `EMS: ${deviceName || deviceId}`;
    const startName = `${baseName} → Heat Pump Start`;
    const stopName  = `${baseName} → Heat Pump Stop`;

    // Delete existing flows with same names
    const allFlows = await api.getFlows().catch(() => ({}));
    await Promise.all(
      Object.values(allFlows || {})
        .filter((f) => f.name === startName || f.name === stopName)
        .map((f) => api.deleteFlow(f.id).catch(() => {})),
    );

    const makeAction = (cardId, cardUri) => ({
      id: cardId, uri: cardUri, group: 'then', delay: null, duration: null, args: {},
    });

    const results = {};
    try {
      const sf = await api.createFlow({
        name: startName, folder: folderId,
        trigger: { id: `${APP_URI}:ems_start_heat_pump`, args: { heat_pump_device_id: deviceId } },
        conditions: [],
        actions: [makeAction(startCardId, startCardUri)],
      });
      results.startFlowId = sf && sf.id;
    } catch (e) { return { folderId, startFlowError: e.message }; }

    try {
      const ef = await api.createFlow({
        name: stopName, folder: folderId,
        trigger: { id: `${APP_URI}:ems_stop_heat_pump`, args: { heat_pump_device_id: deviceId } },
        conditions: [],
        actions: [makeAction(stopCardId, stopCardUri)],
      });
      results.stopFlowId = ef && ef.id;
    } catch (e) { return { folderId, startFlowId: results.startFlowId, stopFlowError: e.message }; }

    return { folderId, ...results };
  },

  /** GET /ems/battery/action-cards — marks luna2000 battery cards as suggested */
  async getEmsBatteryActionCards({ homey, query }) {
    const base = await this.getEmsChargerActionCards({ homey, query });
    if (base.error) return base;
    const SUGGESTED = new Set([
      'luna2000_start_force_charge',
      'luna2000_start_force_discharge',
      'luna2000_set_working_mode',
      'luna2000_set_max_charge_power',
      'luna2000_set_max_discharge_power',
    ]);
    (base.groups || []).forEach((g) => {
      (g.cards || []).forEach((c) => { if (SUGGESTED.has(c.id)) c.suggested = true; });
    });
    return base;
  },

  /** GET /ems/battery/flows?deviceId=xxx */
  async getEmsBatteryFlows({ homey, query }) {
    const { deviceId } = query || {};
    if (!deviceId) return { matched: [], error: 'Missing deviceId' };
    const _ems = _emsApi(homey);
    if (!_ems) return { matched: [], error: 'No API key — configure EMS device first' };
    const { api, apiKey } = _ems;
    const APP_URI = 'homey:app:com.huawei.fusionsolar';
    function parseAction(a) {
      const rawId = a.id || '';
      if (rawId.startsWith('homey:')) { const lc = rawId.lastIndexOf(':'); return { cardId: rawId.slice(lc + 1), cardUri: rawId.slice(0, lc) }; }
      return { cardId: rawId, cardUri: a.uri || '' };
    }
    try {
      const allFlows = await api.getFlows();
      let deviceName = deviceId;
      try { const d = await api.getDevices(); deviceName = d[deviceId]?.name || deviceId; } catch { }
      const namePrefix = `EMS: ${deviceName} → `;
      const matched = [];
      for (const flow of Object.values(allFlows || {})) {
        if (!flow.name || !flow.name.startsWith(namePrefix)) continue;
        const firstAction = (flow.actions || []).find((a) => { const { cardUri } = parseAction(a); return !cardUri || cardUri === APP_URI; });
        const { cardId, cardUri } = firstAction ? parseAction(firstAction) : { cardId: '', cardUri: '' };
        const { device: _d, ...restArgs } = firstAction?.args || {};
        const tid = (flow.trigger && flow.trigger.id) || '';
        const shortTid = shortCardId(tid);
        matched.push({ id: flow.id, name: flow.name, actionCardId: cardId || null, actionCardUri: cardUri || null, cardArgs: restArgs,
          triggerCardId: shortTid,
          // The flow exists and its action is right, which is all the green tick used to
          // check. Whether it can ever RUN depends on its trigger, so say that too.
          triggerIsPlaceholder: PLACEHOLDER_TRIGGERS.has(shortTid),
          triggerArgs: (flow.trigger && flow.trigger.args) || {} });
      }
      return { matched };
    } catch (e) { return { matched: [], error: e.message }; }
  },

  /** POST /ems/battery/setup-flows — creates one flow per entry, same pattern as postInverterSetupFlow */
  async postEmsBatterySetupFlows({ homey, body }) {
    const { deviceId, flows } = body || {};
    if (!deviceId || !Array.isArray(flows) || !flows.length) return { error: 'Missing deviceId or flows array' };
    const _ems = _emsApi(homey);
    if (!_ems) return { error: 'No API key — configure EMS device first' };
    const { api, apiKey } = _ems;
    const APP_URI = 'homey:app:com.huawei.fusionsolar';
    const folderId = await _emsFlowFolderId(api);
    let deviceName = deviceId;
    try { const d = await api.getDevices(); deviceName = d[deviceId]?.name || deviceId; } catch { }
    const allFlows = await api.getFlows().catch(() => ({}));
    const names = new Set(flows.map((f) => `EMS: ${deviceName} → ${f.name}`));
    await Promise.all(Object.values(allFlows || {}).filter((f) => names.has(f.name)).map((f) => api.deleteFlow(f.id).catch(() => {})));
    const results = [];
    for (const def of flows) {
      const flowName = `EMS: ${deviceName} → ${def.name}`;
      const action = { id: def.cardId, uri: def.cardUri, group: 'then', delay: null, duration: null, args: { device: { id: deviceId }, ...(def.cardArgs || {}) } };
      const trigger = def.triggerId
        ? { id: `${APP_URI}:${def.triggerId}`, args: { battery_device_id: deviceId } }
        : { id: 'homey:manager:flow:start', args: {} };
      let created = null; let lastErr = null;
      try { created = await api.createFlow({ name: flowName, folder: folderId, trigger, conditions: [], actions: [action] }); } catch (err) { lastErr = err.message; }
      results.push({ name: flowName, flowId: created?.id, ok: !!created?.id, error: lastErr });
    }
    const ok = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    if (ok === 0) return { error: `All flows failed: ${results[0]?.error || 'rejected by Homey API'}`, results };
    return { folderId, results, created: ok, note: failed.length ? `${failed.length} flow(s) failed` : 'Add a trigger to each flow in Homey' };
  },

  /** GET /ems/boiler/action-cards */
  async getEmsBoilerActionCards({ homey, query }) { return this.getEmsChargerActionCards({ homey, query }); },
  /** GET /ems/boiler/flows */
  async getEmsBoilerFlows({ homey }) {
    return _getEmsSimpleDeviceFlows({ homey, startCardId: 'ems_start_boiler', stopCardId: 'ems_stop_boiler', startTokenName: 'boiler_device_id' });
  },
  /** POST /ems/boiler/setup-flows */
  async postEmsBoilerSetupFlows({ homey, body }) {
    return _postEmsSimpleDeviceSetupFlows({ homey, body, startCardId: 'ems_start_boiler', stopCardId: 'ems_stop_boiler', tokenName: 'boiler_device_id', labelSuffix: 'Boiler' });
  },

  /** GET /ems/pool/action-cards */
  async getEmsPoolActionCards({ homey, query }) { return this.getEmsChargerActionCards({ homey, query }); },
  /** GET /ems/pool/flows */
  async getEmsPoolFlows({ homey }) {
    return _getEmsSimpleDeviceFlows({ homey, startCardId: 'ems_start_pool', stopCardId: 'ems_stop_pool', startTokenName: 'pool_device_id' });
  },
  /** POST /ems/pool/setup-flows */
  async postEmsPoolSetupFlows({ homey, body }) {
    return _postEmsSimpleDeviceSetupFlows({ homey, body, startCardId: 'ems_start_pool', stopCardId: 'ems_stop_pool', tokenName: 'pool_device_id', labelSuffix: 'Pool' });
  },

  /** GET /ems/dehumidifier/action-cards */
  async getEmsDehumidifierActionCards({ homey, query }) { return this.getEmsChargerActionCards({ homey, query }); },
  /** GET /ems/dehumidifier/flows */
  async getEmsDehumidifierFlows({ homey }) {
    return _getEmsSimpleDeviceFlows({ homey, startCardId: 'ems_start_dehumidifier', stopCardId: 'ems_stop_dehumidifier', startTokenName: 'dehumidifier_device_id' });
  },
  /** POST /ems/dehumidifier/setup-flows */
  async postEmsDehumidifierSetupFlows({ homey, body }) {
    return _postEmsSimpleDeviceSetupFlows({ homey, body, startCardId: 'ems_start_dehumidifier', stopCardId: 'ems_stop_dehumidifier', tokenName: 'dehumidifier_device_id', labelSuffix: 'Dehumidifier' });
  },
  /** GET /ems/aircon/action-cards */
  async getEmsAirconActionCards({ homey, query }) { return this.getEmsChargerActionCards({ homey, query }); },
  /** GET /ems/aircon/flows */
  async getEmsAirconFlows({ homey }) {
    return _getEmsSimpleDeviceFlows({ homey, startCardId: 'ems_start_aircon', stopCardId: 'ems_stop_aircon', startTokenName: 'aircon_device_id' });
  },
  /** POST /ems/aircon/setup-flows */
  async postEmsAirconSetupFlows({ homey, body }) {
    return _postEmsSimpleDeviceSetupFlows({ homey, body, startCardId: 'ems_start_aircon', stopCardId: 'ems_stop_aircon', tokenName: 'aircon_device_id', labelSuffix: 'Air conditioner' })
  },

  /**
   * POST /ems/test-trigger
   * Fires an EMS trigger card exactly the way the EMS itself would, so a
   * configured flow can be verified end-to-end (trigger → filter → action).
   * body: { cardId, tokens?, state? }
   */
  async postEmsTestTrigger({ homey, body }) {
    const { cardId, tokens, state } = body || {};
    if (!cardId) return { error: 'Missing cardId' };
    // Only the card's DECLARED tokens may be passed — anything else (e.g. the
    // flow's filter args) makes Homey reject the trigger. Missing ones get a
    // type-correct empty default so the test never fails on token validation.
    let safeTokens = {};
    try {
      const manifest = require('./app.json');
      const card = (manifest.flow.triggers || []).find((t) => t.id === cardId);
      for (const t of (card && card.tokens) || []) {
        const given = tokens && tokens[t.name];
        safeTokens[t.name] = given !== undefined && given !== null
          ? given
          : (t.type === 'number' ? 0 : t.type === 'boolean' ? false : '');
      }
    } catch (_) { safeTokens = {}; }
    try {
      await homey.flow.getTriggerCard(cardId).trigger(safeTokens, state || {});
      // `trigger()` resolves whether or not a single flow was listening, so "it resolved"
      // is not the same as "something ran" — and reporting the first as the second is how
      // three dead price-control cards passed for working from 1.2.38 until 1.2.192. Count
      // the flows actually built on this card and hand that number back, so the button can
      // say "fired, and nobody listened" instead of a bare tick.
      let listeners = null; // null = could not be determined, which is not the same as 0
      try {
        const _ems = _emsApi(homey);
        if (_ems) {
          const [flows, advFlows] = await Promise.all([
            _ems.api.getFlows().catch(() => ({})),
            _ems.api.getAdvancedFlows().catch(() => ({})),
          ]);
          listeners = 0;
          for (const f of Object.values(flows || {})) {
            if (f.enabled !== false && shortCardId(f.trigger && f.trigger.id) === cardId) listeners++;
          }
          for (const f of Object.values(advFlows || {})) {
            if (f.enabled === false) continue;
            if (Object.values(f.cards || {}).some((c) => c && shortCardId(c.id) === cardId)) listeners++;
          }
        }
      } catch (_) { listeners = null; }
      return { ok: true, cardId, listeners, state: state || {}, tokens: safeTokens };
    } catch (e) {
      return { error: e.message || String(e) };
    }
  },

  /** GET /ems/car/action-cards?deviceId=xxx — flat list of the vehicle's action cards,
   *  each with the name of its first numeric argument (for the Target charge token). */
  async getEmsCarActionCards({ homey, query }) {
    const res = await this.getEmsChargerActionCards({ homey, query });
    if (res.error) return res;
    const cards = [];
    for (const g of res.groups || []) {
      for (const c of g.cards || []) {
        const numArg = (c.args || []).find((a) => a.type === 'number' || a.type === 'range');
        cards.push({ id: c.id, uri: c.uri, title: c.title, groupLabel: g.label, suggested: !!c.suggested, numberArg: numArg ? numArg.name : null });
      }
    }
    // Cards with a numeric field first, then suggested (device-owned) first
    cards.sort((a, b) => (a.numberArg ? 0 : 1) - (b.numberArg ? 0 : 1) || (a.suggested ? 0 : 1) - (b.suggested ? 0 : 1));
    return { cards };
  },

  /** GET /ems/car/flows?deviceId=xxx — flows in _Huawei EMS whose first action targets this vehicle */
  async getEmsCarFlows({ homey, query }) {
    const { deviceId } = query || {};
    const _ems = _emsApi(homey);
    if (!_ems) return { matched: [], error: 'No API key' };
    const { api, apiKey } = _ems;
    try {
      const all = await api.getFlows();
      const matched = Object.values(all || {})
        .filter((f) => {
          if (!f.name || !f.name.startsWith('EMS: ')) return false;
          const act = (f.actions || [])[0];
          const argDev = act && act.args && act.args.device && act.args.device.id;
          return deviceId ? argDev === deviceId : true;
        })
        .filter((f) => /Set charge/i.test(f.name))
        .map((f) => {
          const tid = (f.trigger && f.trigger.id) || '';
          return {
            id: f.id, name: f.name, type: 'flow',
            triggerCardId: tid.indexOf(':') !== -1 ? tid.slice(tid.lastIndexOf(':') + 1) : tid,
            triggerArgs: (f.trigger && f.trigger.args) || {},
          };
        });
      return { matched };
    } catch (e) { return { matched: [], error: e.message }; }
  },

  /** POST /ems/car/setup-flows — creates one flow per target value:
   *  THEN <vehicle action> with the fixed charge target filled in. The WHEN
   *  trigger is a placeholder ("this flow started") for the user to replace. */
  async postEmsCarSetupFlows({ homey, body }) {
    const { carId, deviceId, deviceName, flows } = body || {};
    const flowDefs = (Array.isArray(flows) ? flows : [])
      .filter((f) => f && Number.isFinite(Number(f.pct)) && f.actionCard && f.actionUri);
    if (!carId || !deviceId || !flowDefs.length) return { error: 'Missing required fields' };
    const _ems = _emsApi(homey);
    if (!_ems) return { error: 'No API key — configure EMS device first' };
    const { api, apiKey } = _ems;

    // Robust numeric-argument detection per action card: prefer number/range
    // types, then an arg whose name looks like a charge target, then the sole
    // non-device argument.
    let rawCards = [];
    try { rawCards = Object.values(await api._req('GET', '/manager/flow/flowcardaction') || {}); } catch { }
    const detectNumArg = (actionCard, actionUri) => {
      const card = rawCards.find((c) => c.id === actionCard && (c.ownerUri || c.uri) === actionUri) || rawCards.find((c) => c.id === actionCard);
      const args = (card && card.args || []).filter((a) => a.name !== 'device' && a.name !== 'droptoken');
      const a = args.find((x) => x.type === 'number' || x.type === 'range')
        || args.find((x) => /soc|charge|limit|percent|prozent|target|level|ziel|value/i.test(x.name || ''))
        || (args.length === 1 ? args[0] : null);
      return a ? a.name : null;
    };

    const folderId = await _emsFlowFolderId(api);

    const APP_URI  = 'homey:app:com.huawei.fusionsolar';
    const baseName = `EMS: ${deviceName || deviceId}`;
    const allFlows = await api.getFlows().catch(() => ({}));
    const results  = [];
    let anyArgFilled = false;
    for (const def of flowDefs) {
      const val = Number(def.pct);
      const numberArg = detectNumArg(def.actionCard, def.actionUri);
      if (numberArg) anyArgFilled = true;
      const flowName = `${baseName} → Set charge ${val}%`;
      await Promise.all(Object.values(allFlows || {}).filter((f) => f.name === flowName).map((f) => api.deleteFlow(f.id).catch(() => {})));
      const args = { device: { id: deviceId } };
      if (numberArg) args[numberArg] = val;
      const action  = { id: def.actionCard, uri: def.actionUri, group: 'then', delay: null, duration: null, args };
      // WHEN comes from the app: the EMS fires "set car target charge" filtered by
      // the vehicle's device id + this target %, so only the matching flow fires.
      const trigger = { id: `${APP_URI}:ems_set_car_target`, args: { car_device_id: deviceId, target_pct: String(val) } };
      let created = null; let err = null;
      try { created = await api.createFlow({ name: flowName, folder: folderId, trigger, conditions: [], actions: [action] }); } catch (e) { err = e.message; }
      results.push({ name: flowName, flowId: created && created.id, ok: !!(created && created.id), error: err, argFilled: !!numberArg });
    }
    const ok = results.filter((r) => r.ok).length;
    if (ok === 0) return { error: `Flow creation failed: ${results[0] && results[0].error || 'rejected by Homey'}`, results };
    return {
      created: ok,
      results,
      argFilled: anyArgFilled,
      argNote: anyArgFilled
        ? 'charge value filled into the action'
        : 'no numeric field detected — set the charge % manually in each flow',
    };
  },

  /**
   * GET /inverter/action-cards?deviceId=xxx
   * Like getEmsChargerActionCards but marks sun2000 export-limit cards as suggested.
   */
  async getInverterActionCards({ homey, query }) {
    const base = await this.getEmsChargerActionCards({ homey, query });
    if (base.error) return base;

    const APP_URI = 'homey:app:com.huawei.fusionsolar';
    const SUN2000_SUGGESTED = new Set([
      'sun2000_set_export_limit_enabled',
      'sun2000_set_max_feed_in_power',
      'sun2000_set_max_feed_in_power_pct',
      'sun2000_set_active_power_derating_w',
      'sun2000_set_active_power_derating_pct',
      'sun2000_reset_output_limit',
    ]);

    base.groups = base.groups.map((g) => {
      const isAppGroup = g.uri === APP_URI;
      return {
        ...g,
        label:     isAppGroup ? `★ FusionSolar (${base.deviceName || 'Inverter'})` : g.label,
        suggested: isAppGroup || g.suggested,
        cards: g.cards.map((c) => ({
          ...c,
          suggested: (isAppGroup && SUN2000_SUGGESTED.has(c.id)) || c.suggested,
        })),
      };
    });

    // Sort so FusionSolar group appears first
    base.groups.sort((a, b) => {
      if (a.uri === APP_URI) return -1;
      if (b.uri === APP_URI) return 1;
      return 0;
    });

    return base;
  },

  /** GET /inverter/flows?deviceId=xxx — finds EMS inverter flows by name prefix */
  async getInverterFlows({ homey, query }) {
    const { deviceId } = query || {};
    if (!deviceId) return { matched: [], error: 'Missing deviceId' };

    const _ems = _emsApi(homey);
    if (!_ems) return { matched: [], error: 'No API key — configure EMS device first' };
    const { api, apiKey } = _ems;

    const APP_URI = 'homey:app:com.huawei.fusionsolar';

    // Normalize full-URI action id ("homey:app:...:card_id") to short form.
    function parseAction(a) {
      const rawId = a.id || '';
      if (rawId.startsWith('homey:')) {
        const lastColon = rawId.lastIndexOf(':');
        return { cardId: rawId.slice(lastColon + 1), cardUri: rawId.slice(0, lastColon) };
      }
      return { cardId: rawId, cardUri: a.uri || '' };
    }

    try {
      const allFlows = await api.getFlows();

      // Resolve device name for name-based matching (same prefix used when creating flows)
      let deviceName = deviceId;
      try {
        const allDevices = await api.getDevices();
        deviceName = allDevices[deviceId]?.name || deviceId;
      } catch { }
      const namePrefix = `EMS: ${deviceName} → `;

      const matched = [];
      for (const flow of Object.values(allFlows || {})) {
        if (!flow.name || !flow.name.startsWith(namePrefix)) continue;
        // Extract action card info so _tryInvPrefill can pre-select dropdowns
        const firstAction = (flow.actions || []).find((a) => {
          const { cardUri } = parseAction(a);
          return !cardUri || cardUri === APP_URI;
        });
        const { cardId, cardUri } = firstAction ? parseAction(firstAction) : { cardId: '', cardUri: '' };
        const { device: _d, ...restArgs } = firstAction?.args || {};
        const tid = (flow.trigger && flow.trigger.id) || '';
        matched.push({
          id: flow.id, name: flow.name,
          actionCardId:  cardId || null,
          actionCardUri: cardUri || null,
          cardArgs:      restArgs,
          triggerCardId: shortCardId(tid),
          triggerIsPlaceholder: PLACEHOLDER_TRIGGERS.has(shortCardId(tid)),
          triggerArgs:   (flow.trigger && flow.trigger.args) || {},
        });
      }
      return { matched };
    } catch (e) {
      return { matched: [], error: e.message };
    }
  },

  /**
   * POST /inverter/setup-flow
   * body.flows = [{ name, cardId, cardUri, cardArgs }]
   * Creates one flow per entry in "_Huawei EMS". Re-running overwrites by name.
   */
  async postInverterSetupFlow({ homey, body }) {
    const { deviceId, flows } = body || {};
    if (!deviceId || !Array.isArray(flows) || !flows.length) {
      return { error: 'Missing deviceId or flows array' };
    }

    const _ems = _emsApi(homey);
    if (!_ems) return { error: 'No API key — configure EMS device first' };
    const { api, apiKey, emsDeviceId } = _ems;

    const APP_URI = 'homey:app:com.huawei.fusionsolar';

    const folderId = await _emsFlowFolderId(api);

    // Resolve inverter device name for flow name prefix (must happen before delete)
    let deviceName = deviceId;
    try {
      const allDevices = await api.getDevices();
      deviceName = allDevices[deviceId]?.name || deviceId;
    } catch { }

    const allFlows = await api.getFlows().catch(() => ({}));
    const names    = new Set(flows.map((f) => `EMS: ${deviceName} → ${f.name}`));
    await Promise.all(
      Object.values(allFlows || {}).filter((f) => names.has(f.name))
        .map((f) => api.deleteFlow(f.id).catch(() => {})),
    );

    const results = [];
    for (const def of flows) {
      const flowName = `EMS: ${deviceName} → ${def.name}`;
      const action = {
        id: def.cardId, uri: def.cardUri, group: 'then', delay: null, duration: null,
        args: { device: { id: deviceId }, ...(def.cardArgs || {}) },
      };
      let created = null;
      let lastErr  = null;
      const trigger = def.triggerId
        ? { id: `${APP_URI}:${def.triggerId}`, args: { inverter_device_id: deviceId } }
        : (def.trigger || { id: 'homey:manager:flow:start', args: {} });
      try {
        created = await api.createFlow({
          name: flowName, folder: folderId, trigger, conditions: [], actions: [action],
        });
      } catch (err) { lastErr = err.message; }
      results.push({ name: flowName, flowId: created?.id, ok: !!created?.id, error: lastErr });
    }

    const ok     = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    if (ok === 0) {
      const firstErr = results[0]?.error || 'Flow creation rejected by Homey API';
      return { error: `All flows failed: ${firstErr}`, results };
    }
    return {
      folderId,
      results,
      created: ok,
      note: failed.length
        ? `${failed.length} flow(s) failed — add manually in Homey`
        : 'Add a trigger (e.g. price app) to each flow in Homey',
    };
  },

  /**
   * PUT /ems/config — saves EMS config and notifies the device to reload.
   *
   * The body REPLACES the stored config rather than merging into it, so any key the
   * settings page does not send is gone. `offpeak_enabled` is not the settings page's to
   * send: it belongs to the device tile's toggle, whose capability listener writes it
   * here. Carrying it forward is what stops a visit to the settings page from silently
   * resetting the low-tariff switch — which only surfaces later, when the capability is
   * re-initialised (a migration, a re-pair) and is restored from exactly this value.
   */
  async putEmsConfig({ homey, body }) {
    const stored = homey.settings.get('ems_config') || {};
    homey.settings.set('ems_config', { ...body, offpeak_enabled: stored.offpeak_enabled === true });
    try {
      const driver  = homey.drivers.getDriver('energy_management');
      for (const device of driver.getDevices()) {
        if (typeof device.onConfigChanged === 'function') device.onConfigChanged();
      }
    } catch { /* device not ready */ }
    return { ok: true };
  },

  async fetchOpenapiDebug({ body }) {
    const { baseUrl, username, systemCode } = body || {};
    if (!baseUrl || !username || !systemCode) {
      return { error: 'Missing baseUrl, username or systemCode' };
    }

    const result = { timestamp: new Date().toISOString(), baseUrl, steps: [] };

    try {
      const token = await openapiLogin(baseUrl, username, systemCode);
      result.steps.push({ step: 'login', ok: true });

      const { stations } = await openapiGetStationList(baseUrl, token);
      result.steps.push({ step: 'getStationList', ok: true, data: stations });
      result.stations = stations;

      if (!stations.length) {
        result.steps.push({ step: 'note', ok: true, data: 'No stations found — cannot fetch devices.' });
        return result;
      }

      result.stationDetails = [];

      for (const station of stations) {
        const code = station.plantCode ?? station.stationCode;
        if (!code) continue;

        const stationResult = { stationCode: code, stationName: station.plantName ?? station.stationName ?? code };

        try {
          const { raw } = await openapiGetStationRealKpiRaw(baseUrl, token, code);
          stationResult.stationKpi = raw;
          result.steps.push({ step: `getStationRealKpi(${code})`, ok: true, data: raw ? 'data received' : 'no data' });
        } catch (err) {
          stationResult.stationKpi = null;
          result.steps.push({ step: `getStationRealKpi(${code})`, ok: false, data: err.message });
        }

        const { devices } = await openapiGetDevList(baseUrl, token, code);
        stationResult.devices = devices;
        result.steps.push({ step: `getDevList(${code})`, ok: true, data: `${devices.length} device(s)` });

        const byType = {};
        for (const d of devices) {
          const t = Number(d.devTypeId);
          if (!byType[t]) byType[t] = [];
          byType[t].push(String(d.id));
        }

        stationResult.kpiByType = {};
        const kpiEntries = Object.entries(byType);
        const kpiResults = await Promise.allSettled(
          kpiEntries.map(([typeId, ids]) =>
            openapiGetDevRealKpi(baseUrl, token, ids, Number(typeId))
              .then(({ devices: kpiDevices, failCode, failMessage }) => ({ typeId, kpiDevices, failCode, failMessage, ok: true }))
              .catch((err) => ({ typeId, error: err.message, ok: false })),
          ),
        );
        for (const settled of kpiResults) {
          const r = settled.status === 'fulfilled' ? settled.value : { typeId: '?', ok: false, error: settled.reason?.message };
          if (r.ok) {
            stationResult.kpiByType[r.typeId] = r.kpiDevices;
            // An empty answer carries its reason into the report. "0 device(s)" on its own
            // cannot distinguish a refusal from an outage, which cost issue #28 several
            // rounds of guessing about a battery FusionSolar was showing at the same moment.
            const why = r.kpiDevices.length === 0
              ? (r.failCode
                ? ` — failCode ${r.failCode}: ${r.failMessage}`
                : ' — no failure code returned; the API answered successfully with an empty list')
              : '';
            result.steps.push({ step: `getDevRealKpi(type=${r.typeId})`, ok: true, data: `${r.kpiDevices.length} device(s)${why}` });
          } else {
            stationResult.kpiByType[r.typeId] = { error: r.error };
            result.steps.push({ step: `getDevRealKpi(type=${r.typeId})`, ok: false, data: r.error });
          }
        }

        result.stationDetails.push(stationResult);
      }
    } catch (err) {
      result.steps.push({ step: 'error', ok: false, data: err.message });
      result.error = err.message;
    }

    return result;
  },

  /**
   * GET /log
   * Returns the app-wide log ring buffer (all drivers/devices, ~1500 lines)
   * as [{ line, level }] — captured from stdout/stderr in app.js.
   */
  async getAppLog({ homey }) {
    return homey.app.getAppLog();
  },

  /**
   * POST /log/clear
   * Empties the log ring buffer.
   */
  async clearAppLog({ homey }) {
    homey.app.clearAppLog();
    return { ok: true };
  },

};
