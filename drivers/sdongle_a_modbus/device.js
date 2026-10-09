'use strict';

const { Device } = require('homey');
const { withSettingsLog } = require('../../lib/change-log');
const {
  SDONGLE_A_REGISTERS,
  isSdonglaADataValid,
} = require('../../lib/modbus-registers');
const { readModbusRegisters, parseIntSafe, unavailableMessage } = require('../../lib/modbus-client');
const { logPollOk, logPollError } = require('../../lib/poll-log');
const { applyEnergyWarning } = require('../../lib/energy-warning');
const modbusPolling = require('../../lib/modbus-polling');

const DEFAULT_INTERVAL_S = 60;
const MIN_INTERVAL_S     = 10;

// The reference table lists 0, 2, 3 and 5, with 5 as WLAN-FE — but Andi's own SDongle-A,
// which is the Ethernet variant, reports 4. Both are mapped rather than picking a side: the
// 4 is what the hardware in the field says, the 5 is what the documentation says, and an
// unknown value still falls through to "Type n" rather than borrowing a neighbour's name.
const CONNECTION_TYPE_MAP = {
  0: 'N/A',
  2: 'WLAN',
  3: '4G',
  4: 'WLAN-FE',
  5: 'WLAN-FE',
};

const REQUIRED_CAPABILITIES = [
  'measure_power',                   // house consumption / load power (W)
  'measure_power.solar',             // total PV input power (W)
  'measure_power.grid_active_power', // grid power (W): positive = import, negative = export
  'measure_power.battery',           // battery power (W): positive = charging, negative = discharging
  'measure_power.active_power',      // total system active power (W)
  'sdongle_type',                    // connection type: N/A, WLAN, 4G, WLAN-FE
  'sdongle_software_version',        // the dongle's own OS version, register 30050
];

class SdonglaAModbusDevice extends Device {

  async onInit() {
    this.log(`Device initialised: ${this.getName()}`);
    this._failureCount  = 0;
    this._lastPollStart = 0;
    await this._ensureCapabilities();
    await this._updateEnergyWarning();
    await this._startPolling();

    this._fetchAndUpdate().catch((err) => {
      this.error('Initial fetch failed:', err.message);
    });
  }

  async onSettings({ newSettings, changedKeys }) {
    // newSettings, not getSettings(): Homey stores them only after this method resolves.
    if (changedKeys.some((k) => k === 'excluded_from_energy' || k === 'energy_exclude')) {
      await this._updateEnergyWarning({ ...this.getSettings(), ...newSettings });
    }
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

  // ─── Homey Energy ──────────────────────────────────────────────────────────
  //
  // measure_power here is the whole house's consumption (loadPower), and the driver has no
  // energy block: Homey Energy counts it as one more consumer on top of everything else,
  // whatever else is paired. A device warning until the owner excludes it from Energy
  // (lib/energy-warning.js); the pairing view says the same before the device is added.

  async _updateEnergyWarning(settings = this.getSettings()) {
    return applyEnergyWarning(this, {
      conflict: true,
      message:  this.homey.__('sdongle.energyWarning'),
      settings,
      detail:   'its power is the house consumption',
    });
  }

  // ─── Capabilities ──────────────────────────────────────────────────────────

  async _ensureCapabilities() {
    for (const cap of REQUIRED_CAPABILITIES) {
      if (!this.hasCapability(cap)) {
        try {
          await this.addCapability(cap);
        } catch (err) {
          this.error("addCapability(" + cap + ") failed:", err.message);
        }
      }
    }
  }

  // ─── Polling ───────────────────────────────────────────────────────────────

  // Poll timing for the shared mixin (lib/modbus-polling). Declared per driver, not
  // in the mixin, because the interval genuinely differs between device families.
  get pollDefaultS() { return DEFAULT_INTERVAL_S; }
  get pollMinS()     { return MIN_INTERVAL_S; }

  // ─── Data fetch ────────────────────────────────────────────────────────────

  async _fetchAndUpdate() {
    // An exclusion Homey shows the app only through the settings is noticed here too.
    await this._updateEnergyWarning().catch((err) => this.error('Energy warning check failed:', err.message));
    if (this._fetchInProgress) return;
    this._fetchInProgress = true;
    this._lastPollStart = Date.now();

    const address = this.getSetting('address');

    if (!address) {
      this._fetchInProgress = false;
      await this.setUnavailable(this.homey.__('modbus.errors.noAddress'));
      return;
    }

    const port     = parseInt(this.getSetting('port'), 10) || 502;
    const modbusId = parseIntSafe(this.getSetting('modbus_id'), 100);

    try {
      const data = await readModbusRegisters(address, port, modbusId, SDONGLE_A_REGISTERS);

      if (!isSdonglaADataValid(data)) {
        this._failureCount += 1;
        if (this._failureCount >= 3) {
          await this.setUnavailable(this.homey.__('modbus.errors.sdongleANotDetected'));
        }
        this._fetchInProgress = false;
        return;
      }

      // gridPower: spec sign convention already matches Homey (+import, -export)
      await this._set('measure_power',                   data.loadPower        ?? null);
      await this._set('measure_power.solar',             data.totalInputPower  ?? null);
      await this._set('measure_power.grid_active_power', data.gridPower        ?? null);
      await this._set('measure_power.battery',           data.batteryPower     ?? null);
      await this._set('measure_power.active_power',      data.totalActivePower ?? null);

      if (data.connectionType !== null && data.connectionType !== undefined) {
        const typeLabel = CONNECTION_TYPE_MAP[data.connectionType] ?? `Type ${data.connectionType}`;
        await this._set('sdongle_type', typeLabel);
      }

      // Guarded on truthiness, not on null: a dongle that answers with an empty string must
      // not wipe a version that was read correctly a moment ago.
      if (data.softwareVersion) {
        await this._set('sdongle_software_version', data.softwareVersion);
      }


      this._failureCount = 0;
      if (!this.getAvailable()) await this.setAvailable();
      logPollOk(this, 'Poll OK: Solar=' + Math.round(data.totalInputPower ?? 0) + 'W Grid=' + Math.round(data.gridPower ?? 0) + 'W');

    } catch (err) {
      this._failureCount += 1;
      logPollError(this, `Fetch error (${this._failureCount}): ${err.message}`, err.message);
      if (this._failureCount >= 3) {
        await this.setUnavailable(
          unavailableMessage(this.homey, err, this.getSetting('address')),
        );
      }
    } finally {
      this._fetchInProgress = false;
    }
  }

}

Object.assign(SdonglaAModbusDevice.prototype, modbusPolling);

// Every saved settings page in the log and the change log — see lib/change-log.js.
withSettingsLog(SdonglaAModbusDevice);

module.exports = SdonglaAModbusDevice;
