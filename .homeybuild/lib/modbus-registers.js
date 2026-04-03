'use strict';

// Huawei SUN2000 Modbus TCP register map
// Source: Huawei SUN2000 Modbus Interface Definitions (A-E series)
//
// Format: [address, length (16-bit words), dataType, label, decimalPower]
// decimalPower: value *= Math.pow(10, n)  →  -2 = divide by 100

const REGISTERS = {
  // ── Identification ────────────────────────────────────────────────────────
  modelName:              [30000, 15, 'STRING',  'Model Name',                0],

  // ── PV string inputs ──────────────────────────────────────────────────────
  pv1Voltage:             [32016,  1, 'INT16',   'PV1 Voltage (V)',          -1],
  pv1Current:             [32017,  1, 'INT16',   'PV1 Current (A)',          -2],
  pv2Voltage:             [32018,  1, 'INT16',   'PV2 Voltage (V)',          -1],
  pv2Current:             [32019,  1, 'INT16',   'PV2 Current (A)',          -2],

  // ── Grid output ───────────────────────────────────────────────────────────
  inputPower:             [32064,  2, 'INT32',   'Input Power (W)',           0],
  gridVoltage:            [32066,  1, 'UINT16',  'Grid Voltage (V)',         -1],
  phaseAVoltage:          [32069,  1, 'UINT16',  'Phase A Voltage (V)',      -1],
  phaseBVoltage:          [32070,  1, 'UINT16',  'Phase B Voltage (V)',      -1],
  phaseCVoltage:          [32071,  1, 'UINT16',  'Phase C Voltage (V)',      -1],
  phaseACurrent:          [32072,  2, 'INT32',   'Phase A Current (A)',      -3],
  phaseBCurrent:          [32074,  2, 'INT32',   'Phase B Current (A)',      -3],
  phaseCCurrent:          [32076,  2, 'INT32',   'Phase C Current (A)',      -3],
  activePower:            [32080,  2, 'INT32',   'Active Power (W)',          0],
  internalTemperature:    [32087,  1, 'INT16',   'Internal Temperature (°C)',-1],
  deviceStatus:           [32089,  1, 'UINT16',  'Device Status',             0],
  accumulatedYieldEnergy: [32106,  2, 'UINT32',  'Accumulated Yield (kWh)',  -2],
  dailyYieldEnergy:       [32114,  2, 'UINT32',  'Daily Yield (kWh)',        -2],
};

// Human-readable status codes (Huawei Modbus spec, Table 4-2)
const DEVICE_STATUS_MAP = {
  0x0000: 'Standby: initialising',
  0x0001: 'Standby: insulation resistance detecting',
  0x0002: 'Standby: irradiation detecting',
  0x0003: 'Standby: grid detecting',
  0x0100: 'Starting',
  0x0200: 'On-grid',
  0x0201: 'On-grid: power limited',
  0x0202: 'On-grid: self-derating',
  0x0203: 'Off-grid operation',
  0x0300: 'Shutdown: fault',
  0x0301: 'Shutdown: command',
  0x0302: 'Shutdown: OVGR',
  0x0303: 'Shutdown: communication interrupted',
  0x0304: 'Shutdown: limited power',
  0x0305: 'Shutdown: manual startup required',
  0x0307: 'Shutdown: rapid shutdown',
  0x030A: 'Shutdown: commanded rapid shutdown',
  0x030B: 'Shutdown: backup power system abnormal',
  0x0401: 'Grid scheduling: cosφ-P curve',
  0x0402: 'Grid scheduling: Q-U curve',
  0x0403: 'Grid scheduling: PF-U curve',
  0x0405: 'Grid scheduling: Q-P curve',
  0x0600: 'Inspecting',
  0x0700: 'AFCI check',
  0x0800: 'I-V scanning',
  0x0A00: 'Running: off-grid charging',
  0x0A01: 'Standby: backup power system abnormal',
  0xA000: 'Standby: no irradiation',
};

// External power meter registers (e.g. DTSU666-H)
// Only present when a smart meter is connected to the SUN2000
const POWER_METER_REGISTERS = {
  gridPhaseAVoltage:     [37101, 2, 'INT32', 'Grid Phase A Voltage (V)',      -1],
  gridPhaseBVoltage:     [37103, 2, 'INT32', 'Grid Phase B Voltage (V)',      -1],
  gridPhaseCVoltage:     [37105, 2, 'INT32', 'Grid Phase C Voltage (V)',      -1],
  gridPhaseACurrent:     [37107, 2, 'INT32', 'Grid Phase A Current (A)',      -2],
  gridPhaseBCurrent:     [37109, 2, 'INT32', 'Grid Phase B Current (A)',      -2],
  gridPhaseCCurrent:     [37111, 2, 'INT32', 'Grid Phase C Current (A)',      -2],
  powerMeterActivePower: [37113, 2, 'INT32', 'Power Meter Active Power (W)',   0],
  gridExportedEnergy:    [37119, 2, 'INT32', 'Grid Exported Energy (kWh)',    -2],
  gridAccumulatedEnergy: [37121, 2, 'INT32', 'Grid Accumulated Energy (kWh)', -2],
  gridPhaseAPower:       [37132, 2, 'INT32', 'Grid Phase A Power (W)',         0],
  gridPhaseBPower:       [37134, 2, 'INT32', 'Grid Phase B Power (W)',         0],
  gridPhaseCPower:       [37136, 2, 'INT32', 'Grid Phase C Power (W)',         0],
};

// Luna2000 battery storage registers
// Only present when a battery is connected to the SUN2000
const BATTERY_REGISTERS = {
  storageMaxChargePower:    [37046, 2, 'UINT32', 'Max Charge Power (W)',              0],
  storageMaxDischargePower: [37048, 2, 'UINT32', 'Max Discharge Power (W)',           0],
  storageUnit1Status:       [37762, 1, 'UINT16', 'Energy Storage Running Status',       0],
  storageSOC:               [37760, 1, 'UINT16', 'State of Charge (%)',              -1],
  storageChargeDischarge:   [37765, 2, 'INT32',  'Charge/Discharge Power (W)',        0],
  storageDayCharge:         [37784, 2, 'UINT32', 'Today Charged (kWh)',              -2],
  storageDayDischarge:      [37786, 2, 'UINT32', 'Today Discharged (kWh)',           -2],
  storageTotalCharge:       [37780, 2, 'UINT32', 'Total Charged (kWh)',              -2],
  storageTotalDischarge:    [37782, 2, 'UINT32', 'Total Discharged (kWh)',           -2],
};

// Writable control registers (47xxx address range)
// These can be both read and written via Modbus
const CONTROL_REGISTERS = {
  storageWorkingMode:               [47086, 1, 'UINT16', 'Storage Working Mode',                     0],
  storageForceChargeDischarge:      [47100, 1, 'UINT16', 'Storage Force Charge/Discharge',            0],
  storageExcessPvEnergyUseInTou:    [47299, 1, 'UINT16', 'Storage Excess PV Energy Use in TOU',      0],
  activePowerControlMode:           [47415, 1, 'UINT16', 'Active Power Control Mode',                 0],
  remoteChargeDischargeControlMode: [47589, 1, 'UINT16', 'Remote Charge/Discharge Control Mode',      0],
};

// Huawei sentinel values indicating "no data / not applicable"
const INVALID_INT32  = -2147483648; // 0x80000000
const INVALID_UINT16 =       65535; // 0xFFFF

function isBatteryDataValid(data) {
  if (data.storageSOC === null || data.storageSOC === undefined) return false;
  if (data.storageSOC >= INVALID_UINT16 / 10) return false; // 0xFFFF scaled
  return data.storageSOC >= 0 && data.storageSOC <= 100;
}

function isPowerMeterDataValid(data) {
  if (data.powerMeterActivePower === null || data.powerMeterActivePower === undefined) return false;
  if (data.powerMeterActivePower === INVALID_INT32) return false;
  return true;
}

function statusLabel(code) {
  return DEVICE_STATUS_MAP[code] ?? `Unknown (0x${code.toString(16).padStart(4, '0')})`;
}

module.exports = {
  REGISTERS,
  POWER_METER_REGISTERS,
  BATTERY_REGISTERS,
  CONTROL_REGISTERS,
  isBatteryDataValid,
  isPowerMeterDataValid,
  statusLabel,
};
