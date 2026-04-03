'use strict';

const { Device } = require('homey');
const {
  BATTERY_REGISTERS,
  CONTROL_REGISTERS,
  isBatteryDataValid,
} = require('../../lib/modbus-registers');
const { readModbusRegisters, writeModbusRegister } = require('../../lib/modbus-client');

const DEFAULT_INTERVAL_S = 60;
const MIN_INTERVAL_S = 10;

// Capabilities removed in previous versions — cleaned up on init
const DEPRECATED_CAPABILITIES = [
  'luna2000_unit1_status', // renamed to luna2000_battery_status
];

const UNIT1_STATUS_MAP = {
  0: 'Offline',
  1: 'Standby',
  2: 'Running',
  3: 'Fault',
  4: 'Sleep mode',
};

// All battery capabilities are always present (device IS a LUNA2000)
const REQUIRED_CAPABILITIES = [
  'measure_power',           // combined W: positive = charging, negative = discharging
  'measure_battery',         // SoC 0-100 %
  'meter_power.charged',     // lifetime total charged (kWh) – used by Homey energy dashboard
  'meter_power.discharged',  // lifetime total discharged (kWh) – used by Homey energy dashboard
  'measure_power.batt_charge',
  'measure_power.batt_discharge',
  'measure_power.chargesetting',
  'measure_power.dischargesetting',
  'meter_power.today_batt_input',
  'meter_power.today_batt_output',
  'luna2000_battery_status',
  'storage_working_mode_settings',
  'storage_force_charge_discharge',
  'storage_excess_pv_energy_use_in_tou',
  'remote_charge_discharge_control_mode',
];

// Only the battery-related control registers
const STORAGE_CONTROL_REGISTERS = {
  storageWorkingMode:               CONTROL_REGISTERS.storageWorkingMode,
  storageForceChargeDischarge:      CONTROL_REGISTERS.storageForceChargeDischarge,
  storageExcessPvEnergyUseInTou:    CONTROL_REGISTERS.storageExcessPvEnergyUseInTou,
  remoteChargeDischargeControlMode: CONTROL_REGISTERS.remoteChargeDischargeControlMode,
};

// Maps writable enum capability → Modbus register address (47xxx)
const CONTROL_WRITE_MAP = {
  storage_working_mode_settings:        47086,
  storage_force_charge_discharge:       47100,
  storage_excess_pv_energy_use_in_tou:  47299,
  remote_charge_discharge_control_mode: 47589,
};

class LUNA2000ModbusDevice extends Device {

  async onInit() {
    this.log(`Device initialised: ${this.getName()}`);
    this._prevChargingState = null;
    this._failureCount      = 0;
    await this._ensureCapabilities();
    this._registerControlListeners();
    await this._startPolling();

    this._fetchAndUpdate().catch((err) => {
      this.error('Initial fetch failed:', err.message);
    });
  }

  async onSettings({ changedKeys }) {
    if (['address', 'port', 'modbus_id', 'poll_interval'].some((k) => changedKeys.includes(k))) {
      await this._stopPolling();
      await this._startPolling();
      this._fetchAndUpdate().catch((err) => {
        this.error('Fetch after settings change failed:', err.message);
      });
    }
  }

  async onUninit() {
    await this._stopPolling();
  }

  async onDeleted() {
    await this._stopPolling();
  }

  // ─── Capabilities ──────────────────────────────────────────────────────────

  async _ensureCapabilities() {
    for (const cap of DEPRECATED_CAPABILITIES) {
      if (this.hasCapability(cap)) {
        try { await this.removeCapability(cap); } catch (_) {}
      }
    }
    for (const cap of REQUIRED_CAPABILITIES) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap);
      }
    }
  }

  _registerControlListeners() {
    const host   = () => this.getSetting('address');
    const port   = () => parseInt(this.getSetting('port'), 10) || 502;
    const unitId = () => parseInt(this.getSetting('modbus_id'), 10) || 1;

    for (const [cap, regAddress] of Object.entries(CONTROL_WRITE_MAP)) {
      this.registerCapabilityListener(cap, async (value) => {
        await writeModbusRegister(host(), port(), unitId(), regAddress, parseInt(value, 10));
      });
    }
  }

  // ─── Polling ───────────────────────────────────────────────────────────────

  _intervalMs() {
    let s = parseInt(this.getSetting('poll_interval'), 10);
    if (!Number.isFinite(s) || s < MIN_INTERVAL_S) s = DEFAULT_INTERVAL_S;
    return s * 1000;
  }

  async _startPolling() {
    this._timer = this.homey.setInterval(() => {
      this._fetchAndUpdate().catch((err) => {
        this.error('Poll failed:', err.message);
      });
    }, this._intervalMs());
  }

  async _stopPolling() {
    if (this._timer) {
      this.homey.clearInterval(this._timer);
      this._timer = null;
    }
  }

  // ─── Data fetch ────────────────────────────────────────────────────────────

  async _fetchAndUpdate() {
    if (this._fetchInProgress) return;
    this._fetchInProgress = true;

    const address = this.getSetting('address');

    if (!address) {
      this._fetchInProgress = false;
      await this.setUnavailable(this.homey.__('modbus.errors.noAddress'));
      return;
    }

    const port     = parseInt(this.getSetting('port'), 10) || 502;
    const modbusId = parseInt(this.getSetting('modbus_id'), 10) || 1;

    try {
      const batt = await readModbusRegisters(address, port, modbusId, BATTERY_REGISTERS);

      if (!isBatteryDataValid(batt)) {
        this._failureCount += 1;
        if (this._failureCount >= 3) {
          await this.setUnavailable(this.homey.__('modbus.errors.batteryNotDetected'));
        }
        this._fetchInProgress = false;
        return;
      }

      const prevSoc = this.getCapabilityValue('measure_battery');
      const soc     = batt.storageSOC ?? 0;
      const power   = batt.storageChargeDischarge ?? 0; // positive = charging, negative = discharging

      const IDLE_THRESHOLD_W = 50;
      const chargingState = power > IDLE_THRESHOLD_W ? 'charging'
        : power < -IDLE_THRESHOLD_W ? 'discharging'
        : 'idle';

      await this._set('measure_power',                power);  // Homey home battery convention
      await this._set('measure_battery',              soc);
      await this._set('meter_power.charged',          batt.storageTotalCharge ?? null);
      await this._set('meter_power.discharged',       batt.storageTotalDischarge ?? null);
      await this._set('measure_power.batt_charge',    Math.max(0,  power));
      await this._set('measure_power.batt_discharge',  Math.max(0, -power));
      await this._set('measure_power.chargesetting',   batt.storageMaxChargePower ?? null);
      await this._set('measure_power.dischargesetting', batt.storageMaxDischargePower ?? null);
      if (batt.storageUnit1Status !== null && batt.storageUnit1Status !== undefined) {
        await this._set('luna2000_battery_status', UNIT1_STATUS_MAP[batt.storageUnit1Status] ?? `Status ${batt.storageUnit1Status}`);
      }
      await this._set('meter_power.today_batt_input',  batt.storageDayCharge ?? null);
      await this._set('meter_power.today_batt_output', batt.storageDayDischarge ?? null);

      await this._fetchControl(address, port, modbusId);

      if (prevSoc !== soc) {
        await this.homey.flow
          .getDeviceTriggerCard('luna2000_soc_changed')
          .trigger(this, { soc })
          .catch(() => {});
      }

      if (this._prevChargingState !== null && chargingState !== this._prevChargingState) {
        this.homey.flow
          .getDeviceTriggerCard('luna2000_charging_state_changed')
          .trigger(this, { state: chargingState })
          .catch(() => {});
      }
      this._prevChargingState = chargingState;

      this._failureCount = 0;
      if (!this.getAvailable()) await this.setAvailable();

    } catch (err) {
      this._failureCount += 1;
      this.error(`Fetch error (${this._failureCount}):`, err.message);
      if (this._failureCount >= 3) {
        await this.setUnavailable(
          `${this.homey.__('modbus.errors.fetchFailed')}: ${err.message}`,
        );
      }
    } finally {
      this._fetchInProgress = false;
    }
  }

  async _fetchControl(address, port, modbusId) {
    try {
      const ctrl = await readModbusRegisters(address, port, modbusId, STORAGE_CONTROL_REGISTERS);

      const toEnum = (v) => (v !== null && v !== undefined) ? String(v) : null;

      await this._set('storage_working_mode_settings',        toEnum(ctrl.storageWorkingMode));
      await this._set('storage_force_charge_discharge',       toEnum(ctrl.storageForceChargeDischarge));
      await this._set('storage_excess_pv_energy_use_in_tou',  toEnum(ctrl.storageExcessPvEnergyUseInTou));
      await this._set('remote_charge_discharge_control_mode', toEnum(ctrl.remoteChargeDischargeControlMode));

    } catch (err) {
      this.log('Control register read skipped:', err.message);
    }
  }

  async _set(capability, value) {
    if (value === null || value === undefined) return;
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    try {
      await this.setCapabilityValue(capability, value);
    } catch (err) {
      this.log(`_set(${capability}, ${value}) failed:`, err.message);
    }
  }

}

module.exports = LUNA2000ModbusDevice;
