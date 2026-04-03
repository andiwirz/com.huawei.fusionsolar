'use strict';

const { Device } = require('homey');
const {
  REGISTERS,
  POWER_METER_REGISTERS,
  CONTROL_REGISTERS,
  isPowerMeterDataValid,
  statusLabel,
} = require('../../lib/modbus-registers');
const { readModbusRegisters, writeModbusRegister } = require('../../lib/modbus-client');

const DEFAULT_INTERVAL_S = 60;
const MIN_INTERVAL_S = 10;

// Always-present capabilities (core inverter + inverter control register)
const REQUIRED_CAPABILITIES = [
  'measure_power',
  'measure_power.active_power',
  'measure_temperature.invertor',
  'meter_power',
  'meter_power.daily',
  'measure_voltage.pv1',
  'measure_voltage.pv2',
  'measure_current.pv1',
  'measure_current.pv2',
  'huawei_status',
  'activepower_controlmode',
];

// Dynamic capabilities – added when external power meter (DTSU666) is detected
const POWER_METER_CAPABILITIES = [
  'measure_power.grid_active_power',
  'meter_power.grid_export',
  'meter_power.grid_import',
];

// Old capability names from previous app versions – removed during migration
const DEPRECATED_CAPABILITIES = [
  'measure_voltage.grid_phase1',
  'measure_voltage.grid_phase2',
  'measure_voltage.grid_phase3',
  'measure_current.grid_phase1',
  'measure_current.grid_phase2',
  'measure_current.grid_phase3',
  'measure_power.grid_phase1',
  'measure_power.grid_phase2',
  'measure_power.grid_phase3',
  'meter_power_daily',
  'meter_power_cumulative',
  'meter_power_monthly',
  'meter_power_yearly',
  'huawei_device_status',
  'measure_battery_power',
  'meter_battery_charge_today',
  'meter_battery_discharge_today',
  'measure_power_meter',
  'meter_power_exported',
  'meter_power_grid_accumulated',
  // Battery capabilities moved to luna2000_modbus driver
  'storage_working_mode_settings',
  'storage_force_charge_discharge',
  'storage_excess_pv_energy_use_in_tou',
  'remote_charge_discharge_control_mode',
  'measure_battery',
  'measure_power.batt_charge',
  'measure_power.batt_discharge',
  'measure_power.chargesetting',
  'measure_power.dischargesetting',
  'meter_power.today_batt_input',
  'meter_power.today_batt_output',
];

// Only the inverter control register address (47xxx)
const INVERTER_CONTROL_REGISTERS = {
  activePowerControlMode: CONTROL_REGISTERS.activePowerControlMode,
};

// Maps writable enum capability → Modbus register address (47xxx)
const CONTROL_WRITE_MAP = {
  activepower_controlmode: 47415,
};

class SUN2000ModbusDevice extends Device {

  async onInit() {
    this.log(`Device initialised: ${this.getName()}`);
    this._failureCount = 0;
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
    // Remove stale capabilities from previous app versions.
    // Wrapped in try-catch: removeCapability also validates against app.json,
    // so deprecated names that are no longer defined would otherwise throw.
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
    const host    = () => this.getSetting('address');
    const port    = () => parseInt(this.getSetting('port'), 10) || 502;
    const unitId  = () => parseInt(this.getSetting('modbus_id'), 10) || 1;

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
      const data = await readModbusRegisters(address, port, modbusId, REGISTERS);

      const prevPower = this.getCapabilityValue('measure_power');
      const newPower  = data.inputPower ?? 0;

      await this._set('measure_power',              newPower);
      await this._set('measure_power.active_power', data.activePower ?? null);
      await this._set('measure_temperature.invertor', data.internalTemperature ?? null);
      await this._set('meter_power',                data.accumulatedYieldEnergy ?? null);
      await this._set('meter_power.daily',          data.dailyYieldEnergy ?? null);
      await this._set('measure_voltage.pv1',        data.pv1Voltage ?? null);
      await this._set('measure_voltage.pv2',        data.pv2Voltage ?? null);
      await this._set('measure_current.pv1',        data.pv1Current ?? null);
      await this._set('measure_current.pv2',        data.pv2Current ?? null);

      if (data.deviceStatus !== null && data.deviceStatus !== undefined) {
        await this._set('huawei_status', statusLabel(data.deviceStatus));
      }

      await this._fetchPowerMeter(address, port, modbusId);
      await this._fetchControl(address, port, modbusId);

      if (prevPower !== newPower) {
        await this.homey.flow
          .getDeviceTriggerCard('modbus_power_changed')
          .trigger(this, { power: newPower })
          .catch(() => {});
      }

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

  async _fetchPowerMeter(address, port, modbusId) {
    try {
      const meter = await readModbusRegisters(address, port, modbusId, POWER_METER_REGISTERS);

      if (!isPowerMeterDataValid(meter)) {
        for (const cap of POWER_METER_CAPABILITIES) {
          if (this.hasCapability(cap)) await this.removeCapability(cap);
        }
        return;
      }

      for (const cap of POWER_METER_CAPABILITIES) {
        if (!this.hasCapability(cap)) await this.addCapability(cap);
      }

      await this._set('measure_voltage.grid_phase1',  meter.gridPhaseAVoltage ?? null);
      await this._set('measure_voltage.grid_phase2',  meter.gridPhaseBVoltage ?? null);
      await this._set('measure_voltage.grid_phase3',  meter.gridPhaseCVoltage ?? null);
      await this._set('measure_current.grid_phase1',  meter.gridPhaseACurrent ?? null);
      await this._set('measure_current.grid_phase2',  meter.gridPhaseBCurrent ?? null);
      await this._set('measure_current.grid_phase3',  meter.gridPhaseCCurrent ?? null);
      const negate = (v) => (v !== null && v !== undefined) ? -v : null;
      await this._set('measure_power.grid_active_power', negate(meter.powerMeterActivePower));
      await this._set('measure_power.grid_phase1',    negate(meter.gridPhaseAPower));
      await this._set('measure_power.grid_phase2',    negate(meter.gridPhaseBPower));
      await this._set('measure_power.grid_phase3',    negate(meter.gridPhaseCPower));
      await this._set('meter_power.grid_export',      meter.gridExportedEnergy ?? null);
      await this._set('meter_power.grid_import',      meter.gridAccumulatedEnergy ?? null);

    } catch (err) {
      this.log('Power meter read skipped:', err.message);
    }
  }

  async _fetchControl(address, port, modbusId) {
    try {
      const ctrl = await readModbusRegisters(address, port, modbusId, INVERTER_CONTROL_REGISTERS);

      const toEnum = (v) => (v !== null && v !== undefined) ? String(v) : null;

      await this._set('activepower_controlmode', toEnum(ctrl.activePowerControlMode));

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

module.exports = SUN2000ModbusDevice;
