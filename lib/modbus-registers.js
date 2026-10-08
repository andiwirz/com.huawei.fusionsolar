'use strict';

// Huawei Modbus TCP register maps.
//
// ⚠ THREE SEPARATE ADDRESS SPACES LIVE IN THIS FILE. The same address means different
// things depending on which device you are talking to — e.g. 30508 is the charger
// temperature on a SmartCharger but the external meter's A-B line voltage on an EMMA.
// Copying an entry from one block to another silently produces plausible-looking
// nonsense (that exact mistake made an EMMA report "4000 °C"). Always confirm a new
// entry against the document listed for ITS block, not against another block here.
//
//   SUN2000 inverter / battery / meter (30xxx, 32xxx, 37xxx, 47xxx)
//     → "SUN2000MA V100R001C00SPC177 Modbus Interface Definitions", Issue 10 (2026-06-23),
//       sections 3.1 Inverter / 3.2 Battery / 3.3 Meter Equipment Register
//   EMMA (30300–30400, 31600–31999, 40xxx)
//     → "SmartHEMS V100R024C00 MODBUS Interface Definitions", Issue 01 (2024-07-15),
//       section 3.1 Register Definitions for the EMMA
//   SmartCharger (30000–30508)
//     → same SmartHEMS document, section 3.3 Register Definitions for a Charger
//   SDongle A (37410–37516)
//     → "Huawei SDongle A Modbus Interface Definitions"
//
// Format: [address, length (16-bit words), dataType, label, decimalPower]
// decimalPower: value *= Math.pow(10, n)  →  -2 = divide by 100
// The specs express scaling as a Gain (a divisor), so decimalPower = -log10(gain).
// Exception, used deliberately throughout: where the spec's unit is kW/kWh with gain
// 1000, the raw value is already W/Wh and we keep it as such (decimalPower 0).

const REGISTERS = {
  // ── Identification ────────────────────────────────────────────────────────
  modelName:              [30000, 15, 'STRING',  'Model Name',                0],
  softwareVersion:        [30050, 15, 'STRING',  'Software Version',          0],
  ratedPower:             [30073,  2, 'UINT32',  'Rated Power (W)',           0],  // gain 1000, kW → raw=W (e.g. 4000 = 4 kW)
  pvStringCount:          [30071,  1, 'UINT16',  'Number of PV Strings',      0],

  // ── PV string inputs ──────────────────────────────────────────────────────
  // The first two are read on every inverter. Strings 3 and up are added at run time from
  // pvStringCount — see pvStringRegisters() below.
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
  gridFrequency:          [32085,  1, 'INT16',   'Grid Frequency (Hz)',      -2],
  internalTemperature:    [32087,  1, 'INT16',   'Internal Temperature (°C)',-1],
  deviceStatus:           [32089,  1, 'UINT16',  'Device Status',             0],
  accumulatedYieldEnergy: [32106,  2, 'UINT32',  'Accumulated Yield (kWh)',  -2],
  // Read, not published — on purpose, for now.
  //
  // 32106 is what the inverter DELIVERED on the AC side. On a hybrid that is not the same
  // as what the panels GENERATED: energy on its way into the battery never crosses it, and
  // energy coming back out crosses it a second time. Measured on this plant on 2026-09-08,
  // AC yield 13.29 kWh against 6.53 kWh of actual generation reported by the cloud — and it
  // is 32106 that Homey Energy currently files under "solar".
  //
  // wlcrs/huawei-solar-lib declares this address as a lifetime energy counter for the DC
  // side, which would be the generation figure:
  //
  //     rn.TOTAL_DC_INPUT_POWER: U32Register("kWh", 100, 32108)
  //
  // Its name says power and its unit says kWh, and their Home Assistant integration files
  // it as device_class ENERGY / state_class TOTAL. One of the two is misleading, so this
  // sits in the table to be read from real hardware before anything is hung on it: it shows
  // up in the register list on the Modbus settings tab, where a click reads it live.
  //
  // What confirms it: a value ABOVE 32106 (DC in exceeds AC out by the conversion losses)
  // whose daily growth matches the generation figure rather than the AC yield.
  //
  // Costs nothing to carry: 32106 spans 32106-32107, so this joins the request that is
  // already being made rather than adding one.
  totalDcInputEnergy:     [32108,  2, 'UINT32',  'Total DC Input Energy (kWh)', -2],

  // The rest of the yield block, likewise read but not published. All four are AC figures
  // from the same family as 32106 and 32114 — hour, month and year of what the inverter
  // DELIVERED. Do not mistake the monthly or yearly one for generation: that distinction is
  // the whole reason 32108 above is here.
  //
  // 32110 is a Unix timestamp. This decoder has no timestamp type, so it is read as the raw
  // epoch seconds it is; naming it in the label is more use in a diagnostic list than a
  // formatted date would be.
  //
  // Addresses taken from wlcrs/huawei-solar-lib, which reads all of them across a far wider
  // range of hardware than we see. Not in the SUN2000MA register tables checked here, so
  // whether a given firmware answers them is a question the register list itself settles:
  // a row that shows an error while 32106 beside it shows a value means this inverter does
  // not have it, and it comes back out.
  generationStatsTime:    [32110,  2, 'UINT32',  'Generation Statistics Time (epoch s)', 0],
  hourlyYieldEnergy:      [32112,  2, 'UINT32',  'Hourly Yield (kWh)',       -2],
  dailyYieldEnergy:       [32114,  2, 'UINT32',  'Daily Yield (kWh)',        -2],
  monthlyYieldEnergy:     [32116,  2, 'UINT32',  'Monthly Yield (kWh)',      -2],
  yearlyYieldEnergy:      [32118,  2, 'UINT32',  'Yearly Yield (kWh)',       -2],

  // ── Optimizer ─────────────────────────────────────────────────────────────
  totalOptimizers:        [37200,  1, 'UINT16',  'Total Optimizers',          0],
  onlineOptimizers:       [37201,  1, 'UINT16',  'Online Optimizers',         0],
};

// PV strings beyond the first two.
//
// "A maximum of 24 PV strings are supported. The number of PV strings read by the host is
// defined by the Number of PV strings signal. PVn voltage: 32014 + 2n. PVn current:
// 32015 + 2n. n ranges from 1 to 24." — section 3.1, rows 30–37.
//
// Read from register 30071 rather than assumed, and only the strings the inverter says it
// has are asked for. Asking a two-string inverter for all 24 is not merely wasteful: the
// unimplemented addresses sit inside the same span as PV1 and PV2, and _readSpan writes off
// a whole batch when a reply comes back desynchronised — so a refused read of PV24 can take
// PV1 with it. The strings are asked for only once the inverter has said it has them.
//
// The production figure was never at stake either way: 32064 is the total DC input across
// all strings, whatever their number. What this adds is the per-string detail.
const MAX_PV_STRINGS = 24;

function pvStringRegisters(count) {
  const table = {};
  const n = Math.min(Math.max(Math.trunc(count) || 0, 0), MAX_PV_STRINGS);
  for (let i = 3; i <= n; i++) {
    table[`pv${i}Voltage`] = [32014 + 2 * i, 1, 'INT16', `PV${i} Voltage (V)`, -1];
    table[`pv${i}Current`] = [32015 + 2 * i, 1, 'INT16', `PV${i} Current (A)`, -2];
  }
  return table;
}

// Human-readable status codes for register 32089. Two specs, neither complete: SUN2000MA
// SPC177 (Issue 10, 2026) and SUN2000 V300R001 (Issue 01, 2025) — the second adds 0x0306,
// 0x0308, 0x0404, 0x0500, 0x0501 and 0x0900.
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
  0x0306: 'Shutdown: DC switches disconnected',
  0x0307: 'Shutdown: rapid shutdown',
  0x0308: 'Shutdown: input underpower',
  0x030A: 'Shutdown: commanded rapid shutdown',
  0x030B: 'Shutdown: backup power system abnormal',
  // In neither spec. Seen on a hybrid inverter at night with the battery at its discharge
  // cutoff and no PV: FusionSolar shows "Standby" in its overview and "Shutdown: end of ESS
  // discharge" in the detail. Named for what it means to the owner — nothing is wrong, the
  // inverter starts again with the sun — not by its shutdown range.
  0x030C: 'Standby: battery empty',
  0x0401: 'Grid scheduling: cosφ-P curve',
  0x0402: 'Grid scheduling: Q-U curve',
  0x0403: 'Grid scheduling: PF-U curve',
  0x0404: 'Grid scheduling: dry contact',
  0x0405: 'Grid scheduling: Q-P curve',
  0x0500: 'Spot-check ready',
  0x0501: 'Spot-checking',
  0x0600: 'Inspecting',
  0x0700: 'AFCI check',
  0x0800: 'I-V scanning',
  0x0900: 'DC input detection',
  0x0A00: 'Running: off-grid charging',
  0x0A01: 'Standby: backup power system abnormal',
  0xA000: 'Standby: no irradiation',
};

// What the high byte says about a code neither spec lists — both group their codes this way.
// 0x0A is left out on purpose: it holds a running state and a standby state.
const DEVICE_STATUS_RANGE = {
  0x00: 'Standby',
  0x01: 'Starting',
  0x02: 'On-grid',
  0x03: 'Shutdown',
  0x04: 'Grid scheduling',
  0x05: 'Spot-check',
  0x06: 'Inspecting',
  0x07: 'AFCI check',
  0x08: 'I-V scanning',
  0x09: 'DC input detection',
  0xA0: 'Standby',
};

// External power meter registers (e.g. DTSU666-H)
// Only present when a smart meter is connected to the SUN2000.
// Source: SUN2000MA SPC177 Issue 10, section 3.3 "Meter Equipment Register".
// Sign convention (spec): 37113 > 0 = feeding TO the grid, < 0 = drawing FROM it —
// the drivers negate it so Homey sees the app-wide convention (+ = import).
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
// Only present when a battery is connected to the SUN2000.
// Source: SUN2000MA SPC177 Issue 10, section 3.2 "Battery Equipment Register".
// Note 37799 = storage unit 2, 37814 = unit 1 — the lower address is unit 2, per spec.
const BATTERY_REGISTERS = {
  // Huawei names these "[Energy storage] Maximum charge / discharge power" — one "-ing"
  // away from the SETTINGS at 47075/47077, "[Energy storage] Maximum charging / discharging
  // power". These two are read-only and reported by the battery; those two are what the
  // user sets. Issue #31: the capability titled "Max Discharge Power" was fed from here and
  // stayed at 5000 W while the setting was 0. The keys now say which is which, and the
  // labels carry the two words the spec leaves out.
  essMaxChargePower:        [37046, 2, 'UINT32', '[Energy storage] Maximum charge power (W) — reported by the battery, read-only',    0],
  essMaxDischargePower:     [37048, 2, 'UINT32', '[Energy storage] Maximum discharge power (W) — reported by the battery, read-only', 0],
  storageUnit1Status:       [37762, 1, 'UINT16', 'Energy Storage Running Status',       0],
  // The nameplate capacity of the whole stack, in Wh on the wire (15000 = 15 kWh on a
  // three-module LUNA2000), so -3 rather than the -2 the neighbouring kWh counters use.
  //
  // Deliberately NOT in STATIC_REGISTER_ADDRESSES, although a nameplate looks like the
  // perfect candidate. Measured with buildReadPlan: 37758-37759 merges into the same
  // request as the SoC at 37760, so the battery block costs three requests with it and
  // three without — caching would save nothing and would only freeze the value for a day.
  // Add a module and the new capacity should show up on the next poll, not tomorrow.
  ratedCapacity:            [37758, 2, 'UINT32', 'Rated Capacity (kWh)',             -3],
  storageSOC:               [37760, 1, 'UINT16', 'State of Charge (%)',              -1],
  storageChargeDischarge:   [37765, 2, 'INT32',  'Charge/Discharge Power (W)',        0],
  storageDayCharge:         [37784, 2, 'UINT32', 'Today Charged (kWh)',              -2],
  storageDayDischarge:      [37786, 2, 'UINT32', 'Today Discharged (kWh)',           -2],
  storageTotalCharge:       [37780, 2, 'UINT32', 'Total Charged (kWh)',              -2],
  storageTotalDischarge:    [37782, 2, 'UINT32', 'Total Discharged (kWh)',           -2],
  storageUnit1SoftwareVer:  [37814, 15, 'STRING', 'Energy Storage Unit 1 Software Version', 0],
  storageUnit2SoftwareVer:  [37799, 15, 'STRING', 'Energy Storage Unit 2 Software Version', 0],
};

// EMMA (Energy Management Assistant) registers
// Source: SmartHEMS V100R024C00 MODBUS Interface Definitions, Issue 01 (2024-07-15),
//         section 3.1 "Register Definitions for the EMMA".
// All 35 addresses used below were verified against that document (type, length, gain).
//
// This block previously cited "SUN2000MA … Table 3-1", which is the SUN2000 *inverter*
// document — none of the addresses below appear in it. Citing the wrong device's spec is
// how the 30508 mix-up happened; see the warning at the top of this file.
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
  feedInPower:           [30358, 2, 'INT32',  'Feed-in Power (W)',                  0],  // + import, − export (empirically; used directly as measure_power)
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
  // NOTE: there is deliberately no inverter-temperature entry here. EMMA exposes no
  // temperature register at all. Address 30508 used to be listed as one, copied from
  // SMARTCHARGER_REGISTERS.chargerTemperature below (identical [30508, 2, 'INT32', …, -1]) —
  // but in the EMMA address space 30508 is EMMA_EXTERNAL_METER_LINE_VOLTAGE_A_B (U32,
  // gain 100, V). Reading it as a temperature turned a ~400 V line voltage into "4000 °C".
  // Verified against wlcrs/huawei-solar-lib registers.py (EMMA_REGISTERS block).
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

// SDongle A power overview registers
// Source: Huawei SDongle A Modbus Interface Definitions
//
// Gain column = 1000 (kW, gain 1000) → raw value = Watts directly → decimalPower 0
// Sign conventions (from spec):
//   gridPower        (+) = import from grid, (−) = export to grid (Homey convention, no negation)
//   batteryPower     (+) = charging,         (−) = discharging
const SDONGLE_A_REGISTERS = {
  // The dongle's own OS version. 30050 is in STATIC_REGISTER_ADDRESSES, so it is read once
  // and then served from cache for a day: the string cannot change, and it lies far enough
  // from the power block at 37498 that asking for it every poll would buy a whole extra
  // request for nothing.
  softwareVersion:  [30050, 15, 'STRING', 'OS Version',             0],
  connectionType:   [37410, 1, 'UINT16', 'Connection Type',        0],  // 0=N/A, 2=WLAN, 3=4G, 5=WLAN-FE
  totalInputPower:  [37498, 2, 'UINT32', 'Total Input Power (W)',  0],  // PV solar input power
  loadPower:        [37500, 2, 'UINT32', 'Load Power (W)',         0],  // House consumption
  gridPower:        [37502, 2, 'INT32',  'Grid Power (W)',         0],  // +import, -export
  batteryPower:     [37504, 2, 'INT32',  'Battery Power (W)',      0],  // +charge, -discharge
  totalActivePower: [37516, 2, 'INT32',  'Total Active Power (W)', 0],  // Net system active power
};

function isSdonglaADataValid(data) {
  if (data.gridPower === null || data.gridPower === undefined) return false;
  return true;
}

// Huawei SmartHEMS Smart Charger registers
// Source: SmartHEMS MODBUS Interface Definitions V100R024C10SPC112 (2025-06-10),
//         section 3.3 "Register Definitions for a Charger".
// Cross-checked against the same section of Issue 01 / V100R024C00 (2024-07-15): identical.
// NOTE: 30508 is the charger temperature *here only* — on an EMMA the same address is a
//       line voltage. See the warning at the top of this file.
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
  // No inverter temperature: EMMA does not expose one — see EMMA_REGISTERS above.
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
// Source: SmartHEMS V100R024C00 Issue 01, section 3.1 ("Battery control" rows).
//   40000 ESS control mode  — 2 = max self-consumption, 4 = fully fed to grid,
//                             5 = time of use, 6 = third-party dispatch (1/3 reserved)
//   40001 Preferred use of surplus PV — 0 = fed to grid, 1 = charge
//   40002 Max grid charging power    — spec gain 1000 / kW, range [0, 50.000], default 5
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

// Battery module slot registers (47750–47755)
// Source: SUN2000MA SPC177 Issue 10, section 3.2 ("[0,65534] Default: 0 — no equipment").
// Each register holds the pack-ID of the installed module (0 = empty slot).
// Unit 1 has 3 slots (47750–47752), Unit 2 has 3 slots (47753–47755).
// Count non-zero values to get the total number of installed modules (0–6).
const BATTERY_MODULE_REGISTERS = {
  unit1Pack1: [47750, 1, 'UINT16', 'Battery Unit1 Pack1 No.', 0],
  unit1Pack2: [47751, 1, 'UINT16', 'Battery Unit1 Pack2 No.', 0],
  unit1Pack3: [47752, 1, 'UINT16', 'Battery Unit1 Pack3 No.', 0],
  unit2Pack1: [47753, 1, 'UINT16', 'Battery Unit2 Pack1 No.', 0],
  unit2Pack2: [47754, 1, 'UINT16', 'Battery Unit2 Pack2 No.', 0],
  unit2Pack3: [47755, 1, 'UINT16', 'Battery Unit2 Pack3 No.', 0],
};

// Writable control registers (47xxx address range)
// These can be both read and written via Modbus.
// Source: SUN2000MA SPC177 Issue 10, sections 3.1/3.2. Every entry below (address,
// type, gain, and the documented ranges/defaults in the trailing comments) was verified
// against that issue.
const CONTROL_REGISTERS = {
  storageWorkingMode:               [47086, 1, 'UINT16', 'Storage Working Mode',                     0],
  storageMaxChargePower:            [47075, 2, 'UINT32', '[Energy storage] Maximum charging power (W) — setting',    0],  // gain 1, W, default 3500; read-only counterpart: essMaxChargePower (37046)
  storageMaxDischargePower:         [47077, 2, 'UINT32', '[Energy storage] Maximum discharging power (W) — setting', 0],  // gain 1, W, default 3500; read-only counterpart: essMaxDischargePower (37048)
  storageChargingCutoffCapacity:    [47081, 1, 'UINT16', 'Charging Cutoff Capacity (%)',            -1],  // gain 10, range [90,100], default 100
  storageDischargeCutoffCapacity:   [47082, 1, 'UINT16', 'Discharge Cutoff Capacity (%)',            -1],  // gain 10, range [12,20], default 15
  storageChargeFromGrid:            [47087, 1, 'UINT16', 'Charge from Grid Function',                0],  // 0=Disable, 1=Enable
  storageGridChargeCutoffSoc:       [47088, 1, 'UINT16', 'Grid Charge Cutoff SOC (%)',               -1],  // gain 10, range [20,100], default 50
  storageGridChargePower:           [47242, 2, 'UINT32', 'Power of Charge from Grid (W)',           0],  // gain 1000, kW → raw=W; active set point, range [0, reg47244]
  storageMaxGridChargePower:        [47244, 2, 'UINT32', 'Max Power of Charge from Grid (W)',        0],  // gain 1000, kW → raw=W; hardware ceiling, default 2000
  activePowerMaxFeedIn:             [47416, 2, 'INT32',  'Max Feed-in Power (W)',                    0],  // gain 1000, kW → raw=W
  activePowerMaxFeedInPct:          [47418, 1, 'INT16',  'Max Feed-in Power (%)',                   -1],  // gain 10, range [0,100]
  storageBackupPowerSoc:            [47102, 1, 'UINT16', 'Backup Power SOC (%)',                     -1],  // gain 10 → raw = % × 10, range [0,100], default 0
  storageForceChargeDischarge:      [47100, 1, 'UINT16', 'Storage Force Charge/Discharge',            0],  // 0=Stop, 1=Charge, 2=Discharge
  storageForceTargetSoc:            [47101, 1, 'UINT16', 'Force Charge Target SOC (%)',              -1],  // gain 10 → raw = % × 10
  storageForceChargePower:          [47247, 2, 'UINT32', 'Force Charge Power (W)',                    0],  // gain 1000, kW → raw = W
  storageForceDisChargePower:       [47249, 2, 'UINT32', 'Force Discharge Power (W)',                  0],  // gain 1000, kW → raw = W
  storageForceChargeDischargeDuration: [47083, 1, 'UINT16', 'Force Charge/Discharge Duration (min)',   0],  // hardware timer; 0 = no timer
  storageExcessPvEnergyUseInTou:    [47299, 1, 'UINT16', 'Storage Excess PV Energy Use in TOU',      0],
  activePowerControlMode:           [47415, 1, 'UINT16', 'Active Power Control Mode',                 0],
  remoteChargeDischargeControlMode: [47589, 1, 'UINT16', 'Remote Charge/Discharge Control Mode',      0],
  storageUnit1No:                   [47107, 1, 'UINT16', 'Energy Storage Unit 1 No.',                  0],  // 0 = no equipment installed
  storageUnit2No:                   [47108, 1, 'UINT16', 'Energy Storage Unit 2 No.',                  0],  // 0 = no equipment installed
  // Direct derating registers — work standalone WITHOUT a Smart Power Sensor.
  // Modes 5/6/7 on register 47415 (with 47416/47418) require a power meter and
  // are silently ignored without one (confirmed by Huawei, ioBroker.sun2000 #176).
  // 40125/40126 are the SmartLogger remote-derating interface and apply directly
  // to inverter AC output regardless of meter presence.
  activePowerPercentageDerating:    [40125, 1, 'UINT16', 'Active Power Percentage Derating (%)',     -1],  // gain 10, range [0,100]
  activePowerFixedValueDerating:    [40126, 2, 'UINT32', 'Active Power Fixed Derating (W)',           0],  // gain 1, range [0, ratedPower × 1.1]
  mpptMultimodal:                   [42054, 1, 'UINT16', 'MPPT Multimodal Scanning',                  0],  // 0=Disable, 1=Enable
  mpptScanInterval:                 [42055, 1, 'UINT16', 'MPPT Scanning Interval (min)',               0],  // gain 1, min 1
};

// Huawei sentinel values indicating "no data / not applicable"
const INVALID_INT32  = -2147483648; // 0x80000000
const INVALID_UINT16 =       65535; // 0xFFFF

function isBatteryDataValid(data) {
  if (data.storageSOC === null || data.storageSOC === undefined) return false;
  if (data.storageSOC >= INVALID_UINT16 / 10) return false; // 0xFFFF scaled
  return data.storageSOC >= 0 && data.storageSOC <= 100;
}

/**
 * Returns true when the SUN2000 was reachable via Modbus but register 37760
 * returned 0xFFFF — meaning the inverter itself reports no battery on its
 * RS485 bus.  Distinguishes a physical wiring problem from a wrong
 * IP/port/unit-ID configuration.
 */
function isBatteryAbsent(data) {
  if (data.storageSOC === null || data.storageSOC === undefined) return false;
  return data.storageSOC >= INVALID_UINT16 / 10;
}

function isPowerMeterDataValid(data) {
  if (data.powerMeterActivePower === null || data.powerMeterActivePower === undefined) return false;
  if (data.powerMeterActivePower === INVALID_INT32) return false;
  return true;
}

// A code neither spec lists still says which range it is in: "Shutdown (0x030D)" tells the
// owner more than "Unknown", and the number stays, so the code can be looked up and added.
function statusLabel(code) {
  if (DEVICE_STATUS_MAP[code] !== undefined) return DEVICE_STATUS_MAP[code];
  const hex = `0x${code.toString(16).toUpperCase().padStart(4, '0')}`;
  return `${DEVICE_STATUS_RANGE[code >> 8] ?? 'Unknown'} (${hex})`;
}

// Nameplate data: identical on every poll for the life of the device. Re-reading it each
// cycle costs 74 registers across the inverter, battery and charger blocks — the STRING
// entries alone are 15 registers each. readModbusRegisters serves these from a cache that
// refreshes once a day, so a restart or a firmware update still picks up a change.
//
// Keyed by address rather than by name because 30000 is modelName on a SUN2000 and
// offeringName on a SmartCharger; the cache key includes host, port and unit id, so the
// same address on different devices never collides.
//
// Only add an address here if its value cannot change while the app is running. ratedPower
// qualifies: it is nameplate data, and an installer changing it is covered by the daily
// refresh.
const STATIC_REGISTER_ADDRESSES = new Set([
  30000, // modelName (SUN2000) / offeringName (SmartCharger)
  30050, // softwareVersion (SUN2000 inverter, and the SDongle's own OS version)
  30073, // ratedPower (SUN2000)
  30076, // ratedPower (SmartCharger)
  37799, // storageUnit2SoftwareVer
  37814, // storageUnit1SoftwareVer
]);

module.exports = {
  pvStringRegisters,
  MAX_PV_STRINGS,
  STATIC_REGISTER_ADDRESSES,
  REGISTERS,
  POWER_METER_REGISTERS,
  BATTERY_REGISTERS,
  isBatteryAbsent,
  BATTERY_MODULE_REGISTERS,
  CONTROL_REGISTERS,
  EMMA_REGISTERS,
  POWERMETER_EMMA_DATA_REGISTERS,
  SUN2000_EMMA_DATA_REGISTERS,
  LUNA2000_EMMA_DATA_REGISTERS,
  LUNA2000_EMMA_CONTROL_REGISTERS,
  SMARTCHARGER_REGISTERS,
  SDONGLE_A_REGISTERS,
  isBatteryDataValid,
  isPowerMeterDataValid,
  isEmmaDataValid,
  isPowerMeterEmmaDataValid,
  isSun2000EmmaDataValid,
  isLuna2000EmmaDataValid,
  isSmartChargerDataValid,
  isSdonglaADataValid,
  statusLabel,
};
