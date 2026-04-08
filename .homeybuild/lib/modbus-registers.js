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

  // ── Optimizer ─────────────────────────────────────────────────────────────
  totalOptimizers:        [37200,  1, 'UINT16',  'Total Optimizers',          0],
  onlineOptimizers:       [37201,  1, 'UINT16',  'Online Optimizers',         0],
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
  meterStatus:           [37100, 1, 'UINT16', 'Meter Status',                  0],
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

// EMMA (SUN2000MA Energy Management Module) registers
// Source: SUN2000MA V100R001C00SPC172 Modbus Interface Definitions, Table 3-1
//
// Gain column in the spec = divisor → actual_value = register_value / gain
// Power (kW, gain 1000): raw value = Watts  → decimalPower 0
// Energy (kWh, gain 100):                   → decimalPower -2
// SOC (%, gain 100):                        → decimalPower -2
//
// Sign conventions (from spec):
//   feedInPower     (+) = feed-in to grid (Einspeisung), (−) = supply from grid (Bezug)
//   batteryPower    (+) = charging,                      (−) = discharging
// → negate feedInPower in device.js so Homey uses (+) = import, (−) = export
const EMMA_REGISTERS = {
  // ── Built-in meter phase data ─────────────────────────────────────────────
  phaseAVoltage:         [31639, 2, 'UINT32', 'Phase A Voltage (V)',               -2],
  phaseBVoltage:         [31641, 2, 'UINT32', 'Phase B Voltage (V)',               -2],
  phaseCVoltage:         [31643, 2, 'UINT32', 'Phase C Voltage (V)',               -2],
  phaseACurrent:         [31651, 2, 'INT32',  'Phase A Current (A)',               -1],
  phaseBCurrent:         [31653, 2, 'INT32',  'Phase B Current (A)',               -1],
  phaseCCurrent:         [31655, 2, 'INT32',  'Phase C Current (A)',               -1],
  phaseAPower:           [31665, 2, 'INT32',  'Phase A Active Power (W)',           0],
  phaseBPower:           [31667, 2, 'INT32',  'Phase B Active Power (W)',           0],
  phaseCPower:           [31669, 2, 'INT32',  'Phase C Active Power (W)',           0],

  // ── Instantaneous power (W) ───────────────────────────────────────────────
  pvOutputPower:         [30354, 2, 'UINT32', 'PV Output Power (W)',                0],
  loadPower:             [30356, 2, 'UINT32', 'Load Power / House Consumption (W)', 0],
  feedInPower:           [30358, 2, 'INT32',  'Feed-in Power (W)',                  0],  // + export, − import
  batteryPower:          [30360, 2, 'INT32',  'Battery Charge/Discharge Power (W)', 0],  // + charge, − discharge
  inverterActivePower:   [30364, 2, 'INT32',  'Inverter Active Power (W)',          0],

  // ── State of charge (%) ───────────────────────────────────────────────────
  soc:                   [30368, 1, 'UINT16', 'State of Charge (%)',               -2],
  essChargeableCapacity: [30369, 2, 'UINT32', 'ESS Chargeable Capacity (kWh)',     -3],
  essDischargableCapacity:[30371, 2, 'UINT32', 'ESS Dischargeable Capacity (kWh)', -3],
  backupSoc:             [30373, 1, 'UINT16', 'Backup Power SOC (%)',               -2],

  // ── Cumulative energy totals (kWh) ────────────────────────────────────────
  totalSupplyFromGrid:   [30338, 4, 'UINT64', 'Total Supply from Grid (kWh)',      -2],  // Netzbezug gesamt
  totalFeedInToGrid:     [30332, 4, 'UINT64', 'Total Feed-in to Grid (kWh)',       -2],  // Netzeinspeisung gesamt
  totalEnergyConsumption:[30326, 4, 'UINT64', 'Total Energy Consumption (kWh)',    -2],  // Hausverbrauch gesamt
  inverterTemperature:   [30508, 2, 'INT32',  'Inverter Temperature (°C)',          -1],
  totalPvEnergyYield:    [30348, 4, 'UINT64', 'Total PV Energy Yield (kWh)',       -2],
  inverterTotalYield:    [30344, 2, 'UINT32', 'Inverter Total Energy Yield (kWh)', -2],
  totalChargedEnergy:    [30308, 4, 'UINT64', 'Total Charged Energy (kWh)',        -2],
  totalDischargedEnergy: [30314, 4, 'UINT64', 'Total Discharged Energy (kWh)',     -2],

  // ── Daily energy (kWh) ────────────────────────────────────────────────────
  pvYieldToday:          [30346, 2, 'UINT32', 'PV Yield Today (kWh)',              -2],
  inverterYieldToday:    [30342, 2, 'UINT32', 'Inverter Energy Yield Today (kWh)', -2],
  supplyFromGridToday:   [30336, 2, 'UINT32', 'Supply from Grid Today (kWh)',      -2],
  feedInToGridToday:     [30330, 2, 'UINT32', 'Feed-in to Grid Today (kWh)',       -2],
  consumptionToday:      [30324, 2, 'UINT32', 'Consumption Today (kWh)',           -2],
  chargedToday:          [30306, 2, 'UINT32', 'Energy Charged Today (kWh)',        -2],
  dischargedToday:       [30312, 2, 'UINT32', 'Energy Discharged Today (kWh)',     -2],
};

function isEmmaDataValid(data) {
  // feedInPower must be present and not suspiciously large (> 1 GW)
  if (data.feedInPower === null || data.feedInPower === undefined) return false;
  if (Math.abs(data.feedInPower) > 1_000_000_000) return false;
  return true;
}

// Huawei SmartHEMS Smart Charger registers
// Source: SmartHEMS MODBUS Interface Definitions V100R024C10SPC112 (2025-06-10), Table 3-3
//
// Gain column = divisor: actual_value = register_value / gain
// U32 / kW / gain 10  → decimalPower -1
// U32 / V  / gain 10  → decimalPower -1
// U32 / kWh/ gain 1000→ decimalPower -3
// I32 / °C / gain 10  → decimalPower -1
const SMARTCHARGER_REGISTERS = {
  offeringName:       [30000, 15, 'STRING', 'Offering Name',              0],
  ratedPower:         [30076,  2, 'UINT32', 'Rated Power (kW)',           -1], // raw/10 = kW
  phaseAVoltage:      [30500,  2, 'UINT32', 'Phase A Voltage (V)',        -1], // raw/10 = V
  phaseBVoltage:      [30502,  2, 'UINT32', 'Phase B Voltage (V)',        -1],
  phaseCVoltage:      [30504,  2, 'UINT32', 'Phase C Voltage (V)',        -1],
  totalEnergyCharged: [30506,  2, 'UINT32', 'Total Energy Charged (kWh)', -3], // raw/1000 = kWh
  chargerTemperature: [30508,  2, 'INT32',  'Charger Temperature (°C)',   -1], // raw/10 = °C
};

function isSmartChargerDataValid(data) {
  // offeringName must be a non-empty string
  if (!data.offeringName || typeof data.offeringName !== 'string') return false;
  return true;
}

// EMMA-routed power meter data register subset
// Maps EMMA aggregate grid registers to the capabilities of the powermeter_emma_modbus driver.
const POWERMETER_EMMA_DATA_REGISTERS = {
  feedInPower:         EMMA_REGISTERS.feedInPower,         // 30358, INT32,  W   (+ export, − import)
  totalFeedInToGrid:   EMMA_REGISTERS.totalFeedInToGrid,   // 30332, UINT64, kWh
  totalSupplyFromGrid: EMMA_REGISTERS.totalSupplyFromGrid, // 30338, UINT64, kWh
  feedInToGridToday:   EMMA_REGISTERS.feedInToGridToday,   // 30330, UINT32, kWh
  supplyFromGridToday: EMMA_REGISTERS.supplyFromGridToday, // 30336, UINT32, kWh
  loadPower:           EMMA_REGISTERS.loadPower,           // 30356, UINT32, W
  consumptionToday:    EMMA_REGISTERS.consumptionToday,    // 30324, UINT32, kWh
  phaseAVoltage:       EMMA_REGISTERS.phaseAVoltage,       // 31639, UINT32, V
  phaseBVoltage:       EMMA_REGISTERS.phaseBVoltage,       // 31641, UINT32, V
  phaseCVoltage:       EMMA_REGISTERS.phaseCVoltage,       // 31643, UINT32, V
  phaseACurrent:       EMMA_REGISTERS.phaseACurrent,       // 31651, INT32,  A
  phaseBCurrent:       EMMA_REGISTERS.phaseBCurrent,       // 31653, INT32,  A
  phaseCCurrent:       EMMA_REGISTERS.phaseCCurrent,       // 31655, INT32,  A
  phaseAPower:         EMMA_REGISTERS.phaseAPower,         // 31665, INT32,  W  (+ export, − import)
  phaseBPower:         EMMA_REGISTERS.phaseBPower,         // 31667, INT32,  W  (+ export, − import)
  phaseCPower:         EMMA_REGISTERS.phaseCPower,         // 31669, INT32,  W  (+ export, − import)
};

function isPowerMeterEmmaDataValid(data) {
  if (data.feedInPower === null || data.feedInPower === undefined) return false;
  if (Math.abs(data.feedInPower) > 1_000_000_000) return false;
  return true;
}

// EMMA-routed SUN2000 inverter data register subset
// Maps EMMA aggregate registers to the capabilities of the sun2000_emma_modbus driver.
const SUN2000_EMMA_DATA_REGISTERS = {
  pvOutputPower:       EMMA_REGISTERS.pvOutputPower,       // 30354, UINT32, W
  inverterActivePower: EMMA_REGISTERS.inverterActivePower, // 30364, INT32,  W
  feedInPower:         EMMA_REGISTERS.feedInPower,         // 30358, INT32,  W  (+ export, − import)
  inverterTotalYield:  EMMA_REGISTERS.inverterTotalYield,  // 30344, UINT32, kWh
  inverterYieldToday:  EMMA_REGISTERS.inverterYieldToday,  // 30342, UINT32, kWh
  totalFeedInToGrid:   EMMA_REGISTERS.totalFeedInToGrid,   // 30332, UINT64, kWh
  totalSupplyFromGrid: EMMA_REGISTERS.totalSupplyFromGrid, // 30338, UINT64, kWh
  totalPvEnergyYield:  EMMA_REGISTERS.totalPvEnergyYield,  // 30348, UINT64, kWh
  pvYieldToday:        EMMA_REGISTERS.pvYieldToday,        // 30346, UINT32, kWh
  inverterTemperature: EMMA_REGISTERS.inverterTemperature, // 30508, INT32,  °C
};

function isSun2000EmmaDataValid(data) {
  if (data.pvOutputPower === null || data.pvOutputPower === undefined) return false;
  return true;
}

// EMMA-routed LUNA2000 data register subset
// These are entries from EMMA_REGISTERS that represent battery state.
// Re-exported as a named subset so luna2000_emma_modbus driver can import them directly.
const LUNA2000_EMMA_DATA_REGISTERS = {
  batteryPower:            EMMA_REGISTERS.batteryPower,            // 30360, I32,    W,   decimalPower 0
  soc:                     EMMA_REGISTERS.soc,                     // 30368, U16,    %,   decimalPower -2
  essChargeableCapacity:   EMMA_REGISTERS.essChargeableCapacity,   // 30369, U32,    kWh, decimalPower -3
  essDischargableCapacity: EMMA_REGISTERS.essDischargableCapacity, // 30371, U32,    kWh, decimalPower -3
  backupSoc:               EMMA_REGISTERS.backupSoc,               // 30373, U16,    %,   decimalPower -2
  totalChargedEnergy:      EMMA_REGISTERS.totalChargedEnergy,      // 30308, U64,    kWh, decimalPower -2
  totalDischargedEnergy:   EMMA_REGISTERS.totalDischargedEnergy,   // 30314, U64,    kWh, decimalPower -2
  chargedToday:            EMMA_REGISTERS.chargedToday,            // 30306, U32,    kWh, decimalPower -2
  dischargedToday:         EMMA_REGISTERS.dischargedToday,         // 30312, U32,    kWh, decimalPower -2
};

// EMMA writable control registers (40xxx address range)
// These differ from the SUN2000 47xxx control registers.
const LUNA2000_EMMA_CONTROL_REGISTERS = {
  essControlMode:        [40000, 1, 'UINT16', 'ESS Control Mode',                        0],
  preferredUseSurplusPv: [40001, 1, 'UINT16', 'Preferred Use of Surplus PV Power',       0],
  maxGridChargingPower:  [40002, 2, 'UINT32', 'Max Grid Charging Power (kW)',            -3],
};

function isLuna2000EmmaDataValid(data) {
  if (data.soc === null || data.soc === undefined) return false;
  if (data.soc < 0 || data.soc > 100) return false;
  return true;
}

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
  EMMA_REGISTERS,
  POWERMETER_EMMA_DATA_REGISTERS,
  SUN2000_EMMA_DATA_REGISTERS,
  LUNA2000_EMMA_DATA_REGISTERS,
  LUNA2000_EMMA_CONTROL_REGISTERS,
  SMARTCHARGER_REGISTERS,
  isBatteryDataValid,
  isPowerMeterDataValid,
  isEmmaDataValid,
  isPowerMeterEmmaDataValid,
  isSun2000EmmaDataValid,
  isLuna2000EmmaDataValid,
  isSmartChargerDataValid,
  statusLabel,
};
