'use strict';

const { Device } = require('homey');
const {
  BATTERY_REGISTERS,
  CONTROL_REGISTERS,
  isBatteryDataValid,
} = require('../../lib/modbus-registers');
const { readModbusRegisters, writeModbusRegister, writeModbusU32 } = require('../../lib/modbus-client');

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
  storageMaxChargePower:            CONTROL_REGISTERS.storageMaxChargePower,
  storageMaxDischargePower:         CONTROL_REGISTERS.storageMaxDischargePower,
  storageChargingCutoffCapacity:    CONTROL_REGISTERS.storageChargingCutoffCapacity,
  storageDischargeCutoffCapacity:   CONTROL_REGISTERS.storageDischargeCutoffCapacity,
  storageChargeFromGrid:            CONTROL_REGISTERS.storageChargeFromGrid,
  storageGridChargeCutoffSoc:       CONTROL_REGISTERS.storageGridChargeCutoffSoc,
  storageGridChargePower:           CONTROL_REGISTERS.storageGridChargePower,
  storageBackupPowerSoc:            CONTROL_REGISTERS.storageBackupPowerSoc,
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
    this._prevChargingState         = null;
    this._prevBatteryStatus         = null;
    this._failureCount              = 0;
    this._updatingFromModbus        = false;
    this._updatingSettingFromModbus = false;
    this._writeInProgress           = false;
    this._settingsInitialized       = false; // true after first successful _fetchControl
    this._controlPollCounter        = 4;     // start at 4 so first poll immediately reads control registers
    this._forceTimer                = null;  // pending auto-stop timer for timed force charge/discharge
    await this._ensureCapabilities();
    this._registerControlListeners();
    this._registerFlowActions();
    this._registerConditions();
    await this._startPolling();

    this._fetchAndUpdate().catch((err) => {
      this.error('Initial fetch failed:', err.message);
    });
  }

  async onSettings({ newSettings, changedKeys }) {
    if (['address', 'port', 'modbus_id', 'poll_interval'].some((k) => changedKeys.includes(k))) {
      await this._stopPolling();
      await this._startPolling();
      this._fetchAndUpdate().catch((err) => {
        this.error('Fetch after settings change failed:', err.message);
      });
    }

    if (!this._updatingSettingFromModbus && this._settingsInitialized) {
      const address  = this.getSetting('address');
      const port     = parseInt(this.getSetting('port'), 10) || 502;
      const modbusId = parseInt(this.getSetting('modbus_id'), 10) || 1;

      if (changedKeys.includes('charge_from_grid')) {
        const raw = newSettings.charge_from_grid ? 1 : 0;
        this.log(`Write charge_from_grid: ${raw} → reg 47087`);
        writeModbusRegister(address, port, modbusId, 47087, raw)
          .catch((err) => this.error('charge_from_grid write failed:', err.message));
      }

      const socSettings = {
        grid_charge_cutoff_soc:   { reg: 47088, scale: 10, u32: false },
        charging_cutoff_capacity: { reg: 47081, scale: 10, u32: false },
        discharge_cutoff_capacity:{ reg: 47082, scale: 10, u32: false },
        backup_power_soc:         { reg: 47102, scale: 10, u32: false },
      };
      for (const [key, { reg, scale, u32 }] of Object.entries(socSettings)) {
        if (changedKeys.includes(key)) {
          const raw = Math.round(parseFloat(newSettings[key]) * scale);
          this.log(`Write ${key}: ${newSettings[key]} → reg ${reg} raw=${raw}`);
          (u32 ? writeModbusU32 : writeModbusRegister)(address, port, modbusId, reg, raw)
            .catch((err) => this.error(`${key} write failed:`, err.message));
        }
      }

      const wattSettings = {
        max_charge_power:     { reg: 47075 },
        max_discharge_power:  { reg: 47077 },
      };
      for (const [key, { reg }] of Object.entries(wattSettings)) {
        if (changedKeys.includes(key)) {
          const raw = Math.round(parseFloat(newSettings[key]) || 0);
          this.log(`Write ${key}: ${raw} W → reg ${reg}`);
          writeModbusU32(address, port, modbusId, reg, raw)
            .catch((err) => this.error(`${key} write failed:`, err.message));
        }
      }

      // Register 47242 (active grid charge power set point) requires Charge from Grid
      // (47087) to be enabled — otherwise the inverter ignores the write.
      if (changedKeys.includes('max_grid_charge_power')) {
        const raw = Math.round(parseFloat(newSettings.max_grid_charge_power) || 0);
        this.log(`Write max_grid_charge_power: ${raw} W → reg 47242 (ensuring charge_from_grid enabled first)`);
        const ensureEnabled = !this.getSetting('charge_from_grid')
          ? writeModbusRegister(address, port, modbusId, 47087, 1)
              .then(() => {
                this._updatingSettingFromModbus = true;
                return this.setSettings({ charge_from_grid: true })
                  .catch(() => {})
                  .finally(() => { this._updatingSettingFromModbus = false; });
              })
          : Promise.resolve();
        ensureEnabled
          .then(() => writeModbusU32(address, port, modbusId, 47242, raw))
          .catch((err) => this.error('max_grid_charge_power write failed:', err.message));
      }
    }
  }

  async onUninit() {
    if (this._forceTimer) { this.homey.clearTimeout(this._forceTimer); this._forceTimer = null; }
    await this._stopPolling();
  }

  async onDeleted() {
    if (this._forceTimer) { this.homey.clearTimeout(this._forceTimer); this._forceTimer = null; }
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
      this.registerCapabilityListener(cap, (value) => {
        if (this._updatingFromModbus) return; // ignore updates triggered by poll reads

        const previousValue = this.getCapabilityValue(cap);
        this.log(`Write start  [${cap} → reg ${regAddress}] value=${value}`);
        this._writeInProgress = true;

        // Fire-and-forget: return immediately so Homey never shows a UI timeout.
        // On failure the capability is reverted to its previous value.
        writeModbusRegister(host(), port(), unitId(), regAddress, parseInt(value, 10))
          .then(() => {
            this.log(`Write OK     [${cap} → reg ${regAddress}]`);
          })
          .catch(async (err) => {
            this.error(`Write failed [${cap} → reg ${regAddress}]:`, err.message);
            this._updatingFromModbus = true;
            await this._set(cap, previousValue).catch(() => {});
            this._updatingFromModbus = false;
          })
          .finally(() => {
            this._writeInProgress = false;
          });
      });
    }
  }

  // ─── Flow actions ──────────────────────────────────────────────────────────

  _registerFlowActions() {
    const host   = () => this.getSetting('address');
    const port   = () => parseInt(this.getSetting('port'), 10) || 502;
    const unitId = () => parseInt(this.getSetting('modbus_id'), 10) || 1;

    const writeEnum = async (cardId, capabilityId, mode) => {
      const reg   = CONTROL_WRITE_MAP[capabilityId];
      const value = parseInt(mode, 10);
      this.log(`Write start  [${cardId} → reg ${reg}] value=${value}`);
      this._writeInProgress = true;
      try {
        await writeModbusRegister(host(), port(), unitId(), reg, value);
        this.log(`Write OK     [${cardId} → reg ${reg}]`);
        this._updatingFromModbus = true;
        await this._set(capabilityId, mode).catch(() => {});
      } catch (err) {
        this.error(`Write failed [${cardId} → reg ${reg}]:`, err.message);
        throw err;
      } finally {
        this._updatingFromModbus = false;
        this._writeInProgress   = false;
      }
    };

    this.homey.flow
      .getActionCard('luna2000_set_working_mode')
      .registerRunListener(async ({ mode }) =>
        writeEnum('luna2000_set_working_mode', 'storage_working_mode_settings', mode));

    this.homey.flow
      .getActionCard('luna2000_set_excess_pv')
      .registerRunListener(async ({ mode }) =>
        writeEnum('luna2000_set_excess_pv', 'storage_excess_pv_energy_use_in_tou', mode));

    this.homey.flow
      .getActionCard('luna2000_set_remote_mode')
      .registerRunListener(async ({ mode }) =>
        writeEnum('luna2000_set_remote_mode', 'remote_charge_discharge_control_mode', mode));

    this.homey.flow
      .getActionCard('luna2000_set_force_charge_discharge')
      .registerRunListener(async ({ mode }) =>
        writeEnum('luna2000_set_force_charge_discharge', 'storage_force_charge_discharge', mode));

    this.homey.flow
      .getActionCard('luna2000_start_force_charge')
      .registerRunListener(async ({ device, power, target_soc }) => {
        const h = host(), p = port(), u = unitId();
        const powerW  = Math.round(Math.max(0, power));
        const socRaw  = Math.round(Math.max(0, Math.min(100, target_soc)) * 10);
        const already = this.getCapabilityValue('storage_force_charge_discharge') === '1';
        this.log(`Force charge: power=${powerW} W, target SoC=${target_soc}% (raw ${socRaw})${already ? ' [already charging — skipping command]' : ''}`);
        this._writeInProgress = true;
        try {
          await writeModbusU32(h, p, u, 47247, powerW);
          await writeModbusRegister(h, p, u, 47101, socRaw);
          if (!already) await writeModbusRegister(h, p, u, 47100, 1);
          this.log('Force charge command sent');
        } catch (err) {
          this.error('Force charge failed:', err.message);
          throw err;
        } finally {
          this._writeInProgress = false;
        }
      });

    this.homey.flow
      .getActionCard('luna2000_start_force_discharge')
      .registerRunListener(async ({ device, power, target_soc }) => {
        const h = host(), p = port(), u = unitId();
        const powerW  = Math.round(Math.max(0, power));
        const socRaw  = Math.round(Math.max(0, Math.min(100, target_soc)) * 10);
        const already = this.getCapabilityValue('storage_force_charge_discharge') === '2';
        this.log(`Force discharge: power=${powerW} W, stop at SoC=${target_soc}% (raw ${socRaw})${already ? ' [already discharging — skipping command]' : ''}`);
        this._writeInProgress = true;
        try {
          await writeModbusU32(h, p, u, 47247, powerW);
          await writeModbusRegister(h, p, u, 47101, socRaw);
          if (!already) await writeModbusRegister(h, p, u, 47100, 2);
          this.log('Force discharge command sent');
        } catch (err) {
          this.error('Force discharge failed:', err.message);
          throw err;
        } finally {
          this._writeInProgress = false;
        }
      });

    this.homey.flow
      .getActionCard('luna2000_start_force_charge_duration')
      .registerRunListener(async ({ device, power, duration }) => {
        const h = host(), p = port(), u = unitId();
        const powerW     = Math.round(Math.max(0, power));
        const durationMs = Math.round(Math.max(1, duration) * 60 * 1000);
        const already    = this.getCapabilityValue('storage_force_charge_discharge') === '1';
        this.log(`Force charge for ${duration} min: power=${powerW} W${already ? ' [already charging — skipping command]' : ''}`);
        if (this._forceTimer) { this.homey.clearTimeout(this._forceTimer); this._forceTimer = null; }
        this._writeInProgress = true;
        try {
          await writeModbusU32(h, p, u, 47247, powerW);
          if (!already) await writeModbusRegister(h, p, u, 47100, 1);
          this.log('Force charge (timed) command sent');
          this._forceTimer = this.homey.setTimeout(async () => {
            this._forceTimer = null;
            try {
              await writeModbusRegister(h, p, u, 47100, 0);
              this.log(`Force charge auto-stopped after ${duration} min`);
            } catch (err) {
              this.error('Force charge auto-stop failed:', err.message);
            }
          }, durationMs);
        } catch (err) {
          this.error('Force charge (timed) failed:', err.message);
          throw err;
        } finally {
          this._writeInProgress = false;
        }
      });

    this.homey.flow
      .getActionCard('luna2000_start_force_discharge_duration')
      .registerRunListener(async ({ device, power, duration }) => {
        const h = host(), p = port(), u = unitId();
        const powerW     = Math.round(Math.max(0, power));
        const durationMs = Math.round(Math.max(1, duration) * 60 * 1000);
        const already    = this.getCapabilityValue('storage_force_charge_discharge') === '2';
        this.log(`Force discharge for ${duration} min: power=${powerW} W${already ? ' [already discharging — skipping command]' : ''}`);
        if (this._forceTimer) { this.homey.clearTimeout(this._forceTimer); this._forceTimer = null; }
        this._writeInProgress = true;
        try {
          await writeModbusU32(h, p, u, 47247, powerW);
          if (!already) await writeModbusRegister(h, p, u, 47100, 2);
          this.log('Force discharge (timed) command sent');
          this._forceTimer = this.homey.setTimeout(async () => {
            this._forceTimer = null;
            try {
              await writeModbusRegister(h, p, u, 47100, 0);
              this.log(`Force discharge auto-stopped after ${duration} min`);
            } catch (err) {
              this.error('Force discharge auto-stop failed:', err.message);
            }
          }, durationMs);
        } catch (err) {
          this.error('Force discharge (timed) failed:', err.message);
          throw err;
        } finally {
          this._writeInProgress = false;
        }
      });

    this.homey.flow
      .getActionCard('luna2000_set_force_charge_power')
      .registerRunListener(async ({ device, power }) => {
        const powerW = Math.round(Math.max(0, power));
        this.log(`Set force charge power: ${powerW} W`);
        this._writeInProgress = true;
        try {
          await writeModbusU32(host(), port(), unitId(), 47247, powerW); // UINT32, raw=W
          this.log('Force charge power written');
        } catch (err) {
          this.error('Set force charge power failed:', err.message);
          throw err;
        } finally {
          this._writeInProgress = false;
        }
      });

    this.homey.flow
      .getActionCard('luna2000_set_charge_from_grid')
      .registerRunListener(async ({ device, mode }) => {
        const value = parseInt(mode, 10);
        this.log(`Set charge from grid: ${value === 1 ? 'Enable' : 'Disable'} (reg 47087)`);
        this._writeInProgress = true;
        try {
          await writeModbusRegister(host(), port(), unitId(), 47087, value);
          this.log('Charge from grid written');
        } catch (err) {
          this.error('Set charge from grid failed:', err.message);
          throw err;
        } finally {
          this._writeInProgress = false;
        }
      });

    this.homey.flow
      .getActionCard('luna2000_set_grid_charge_cutoff_soc')
      .registerRunListener(async ({ device, target_soc }) => {
        const socRaw = Math.round(Math.max(20, Math.min(100, target_soc)) * 10);
        this.log(`Set grid charge cutoff SoC: ${target_soc}% (raw ${socRaw}, reg 47088)`);
        this._writeInProgress = true;
        try {
          await writeModbusRegister(host(), port(), unitId(), 47088, socRaw);
          this.log('Grid charge cutoff SoC written');
        } catch (err) {
          this.error('Set grid charge cutoff SoC failed:', err.message);
          throw err;
        } finally {
          this._writeInProgress = false;
        }
      });

    this.homey.flow
      .getActionCard('luna2000_set_max_charge_power')
      .registerRunListener(async ({ device, power }) => {
        const powerW = Math.round(Math.max(0, power));
        this.log(`Set max charge power: ${powerW} W → reg 47075`);
        this._writeInProgress = true;
        try {
          await writeModbusU32(host(), port(), unitId(), 47075, powerW);
          this.log('Max charge power written');
          // Reflect immediately in settings so UI is in sync
          this._updatingSettingFromModbus = true;
          await this.setSettings({ max_charge_power: powerW }).catch(() => {});
          this._updatingSettingFromModbus = false;
        } catch (err) {
          this.error('Set max charge power failed:', err.message);
          throw err;
        } finally {
          this._writeInProgress = false;
        }
      });

    this.homey.flow
      .getActionCard('luna2000_set_max_discharge_power')
      .registerRunListener(async ({ device, power }) => {
        const powerW = Math.round(Math.max(0, power));
        this.log(`Set max discharge power: ${powerW} W → reg 47077`);
        this._writeInProgress = true;
        try {
          await writeModbusU32(host(), port(), unitId(), 47077, powerW);
          this.log('Max discharge power written');
          // Reflect immediately in settings so UI is in sync
          this._updatingSettingFromModbus = true;
          await this.setSettings({ max_discharge_power: powerW }).catch(() => {});
          this._updatingSettingFromModbus = false;
        } catch (err) {
          this.error('Set max discharge power failed:', err.message);
          throw err;
        } finally {
          this._writeInProgress = false;
        }
      });

    this.homey.flow
      .getActionCard('luna2000_set_force_charge_soc')
      .registerRunListener(async ({ device, target_soc }) => {
        const socRaw = Math.round(Math.max(0, Math.min(100, target_soc)) * 10);
        this.log(`Set force charge target SoC: ${target_soc}% (raw ${socRaw})`);
        this._writeInProgress = true;
        try {
          await writeModbusRegister(host(), port(), unitId(), 47101, socRaw); // UINT16, raw = % × 10
          this.log('Force charge target SoC written');
        } catch (err) {
          this.error('Set force charge SoC failed:', err.message);
          throw err;
        } finally {
          this._writeInProgress = false;
        }
      });
  }

  // ─── Conditions ────────────────────────────────────────────────────────────

  _registerConditions() {
    this.homey.flow
      .getConditionCard('luna2000_is_charging')
      .registerRunListener((args) => args.device._prevChargingState === 'charging');

    this.homey.flow
      .getConditionCard('luna2000_is_discharging')
      .registerRunListener((args) => args.device._prevChargingState === 'discharging');

    this.homey.flow
      .getDeviceTriggerCard('luna2000_battery_status_changed')
      .registerRunListener((args, state) => args.status === state.status);

    this.homey.flow
      .getConditionCard('luna2000_battery_status_is')
      .registerRunListener((args) => this.getCapabilityValue('luna2000_battery_status') === args.status);
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
    if (this._writeInProgress) return; // pause poll while a write is queued/running
    this._fetchInProgress = true;

    const address = this.getSetting('address');

    if (!address) {
      this._fetchInProgress = false;
      await this.setUnavailable(this.homey.__('modbus.errors.noAddress'));
      return;
    }

    const port     = parseInt(this.getSetting('port'), 10) || 502;
    const modbusId = parseInt(this.getSetting('modbus_id'), 10) || 1;

    const abort = () => this._writeInProgress;

    try {
      const batt = await readModbusRegisters(address, port, modbusId, BATTERY_REGISTERS, abort);

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
        const statusLabel = UNIT1_STATUS_MAP[batt.storageUnit1Status] ?? `Status ${batt.storageUnit1Status}`;
        await this._set('luna2000_battery_status', statusLabel);
        if (this._prevBatteryStatus !== null && statusLabel !== this._prevBatteryStatus) {
          this.homey.flow.getDeviceTriggerCard('luna2000_battery_status_changed')
            .trigger(this, { status: statusLabel }, { status: statusLabel }).catch(() => {});
        }
        this._prevBatteryStatus = statusLabel;
      }
      await this._set('meter_power.today_batt_input',  batt.storageDayCharge ?? null);
      await this._set('meter_power.today_batt_output', batt.storageDayDischarge ?? null);

      // Read control registers every 5th poll — they change rarely and the read
      // adds ~1 s of connection time that delays pending writes.
      this._controlPollCounter = (this._controlPollCounter + 1) % 5;
      if (this._controlPollCounter === 0) {
        await this._fetchControl(address, port, modbusId);
      }

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
        if (chargingState === 'charging') {
          this.homey.flow.getDeviceTriggerCard('luna2000_charging_started')
            .trigger(this, {}).catch(() => {});
        } else if (chargingState === 'discharging') {
          this.homey.flow.getDeviceTriggerCard('luna2000_discharging_started')
            .trigger(this, {}).catch(() => {});
        }
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
      const ctrl = await readModbusRegisters(address, port, modbusId, STORAGE_CONTROL_REGISTERS, () => this._writeInProgress);

      const toEnum = (v) => (v !== null && v !== undefined) ? String(v) : null;

      this._updatingFromModbus = true;
      await this._set('storage_working_mode_settings',        toEnum(ctrl.storageWorkingMode));
      await this._set('storage_force_charge_discharge',       toEnum(ctrl.storageForceChargeDischarge));
      await this._set('storage_excess_pv_energy_use_in_tou',  toEnum(ctrl.storageExcessPvEnergyUseInTou));
      await this._set('remote_charge_discharge_control_mode', toEnum(ctrl.remoteChargeDischargeControlMode));
      this._updatingFromModbus = false;

      // Sync settings from modbus if they differ
      const settingUpdates = {};

      if (ctrl.storageChargeFromGrid !== null && ctrl.storageChargeFromGrid !== undefined) {
        const enabled    = ctrl.storageChargeFromGrid === 1;
        const currentVal = this.getSetting('charge_from_grid');
        if (currentVal === null || currentVal === undefined || enabled !== currentVal)
          settingUpdates.charge_from_grid = enabled;
      }
      const numericSync = [
        ['storageGridChargeCutoffSoc',     'grid_charge_cutoff_soc'],
        ['storageChargingCutoffCapacity',  'charging_cutoff_capacity'],
        ['storageDischargeCutoffCapacity', 'discharge_cutoff_capacity'],
        ['storageMaxChargePower',          'max_charge_power'],
        ['storageMaxDischargePower',       'max_discharge_power'],
        ['storageBackupPowerSoc',          'backup_power_soc'],
      ];
      for (const [key, settingId] of numericSync) {
        const v = ctrl[key];
        if (v !== null && v !== undefined) {
          const current = parseFloat(this.getSetting(settingId));
          if (!Number.isFinite(current) || Math.abs(v - current) > 0.5) settingUpdates[settingId] = v;
        }
      }

      // Register 47242 (active grid charge power set point) only reflects a meaningful
      // value when charge_from_grid is enabled — skip sync when it is disabled.
      if (ctrl.storageChargeFromGrid === 1 && ctrl.storageGridChargePower !== null && ctrl.storageGridChargePower !== undefined) {
        const v       = ctrl.storageGridChargePower;
        const current = parseFloat(this.getSetting('max_grid_charge_power'));
        if (!Number.isFinite(current) || Math.abs(v - current) > 0.5) settingUpdates.max_grid_charge_power = v;
      }
      if (Object.keys(settingUpdates).length > 0) {
        this._updatingSettingFromModbus = true;
        await this.setSettings(settingUpdates)
          .catch((err) => this.log('setSettings sync failed:', err.message));
        this._updatingSettingFromModbus = false;
      }

      // Mark settings as initialised — onSettings writes are now safe
      this._settingsInitialized = true;

    } catch (err) {
      this.log('Control register read skipped:', err.message);
    } finally {
      this._updatingFromModbus         = false;
      this._updatingSettingFromModbus  = false;
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
