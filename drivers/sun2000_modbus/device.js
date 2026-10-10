'use strict';

const { Device } = require('homey');
const { withSettingsLog, applySettingSync, record } = require('../../lib/change-log');
const {
  REGISTERS,
  POWER_METER_REGISTERS,
  CONTROL_REGISTERS,
  isPowerMeterDataValid,
  statusLabel,
  pvStringRegisters,
  MAX_PV_STRINGS,
} = require('../../lib/modbus-registers');
const { notRead, readModbusRegisters, writeModbusRegister, writeModbusU32, parseIntSafe, unavailableMessage } = require('../../lib/modbus-client');
const { pendingModeWrites, syncModeSettings, applyModeWrites, revertModeSetting } = require('../../lib/mode-settings');
const { logPollOk, logPollError } = require('../../lib/poll-log');
const { keepLast } = require('../../lib/capability-order');
const modbusPolling = require('../../lib/modbus-polling');

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
  'measure_frequency',
  'huawei_status',
  'activepower_controlmode',
  'sun2000_software_version',
];

// Shown last on the tile, below everything added later (lib/capability-order.js).
const VERSION_CAPABILITIES = ['sun2000_software_version'];

// Dynamic capabilities – added when optimizers are registered (register 37200 > 0)
const OPTIMIZER_CAPABILITIES = [
  'optimizer_total_count',
  'optimizer_online_count',
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
  'sun2000_firmware_version', // renamed to sun2000_software_version in 1.1.29
];

// Only the inverter control register addresses (47xxx + 40125/40126)
const INVERTER_CONTROL_REGISTERS = {
  activePowerControlMode:        CONTROL_REGISTERS.activePowerControlMode,
  activePowerMaxFeedIn:          CONTROL_REGISTERS.activePowerMaxFeedIn,
  activePowerMaxFeedInPct:       CONTROL_REGISTERS.activePowerMaxFeedInPct,
  activePowerFixedValueDerating: CONTROL_REGISTERS.activePowerFixedValueDerating,
  activePowerPercentageDerating: CONTROL_REGISTERS.activePowerPercentageDerating,
  mpptMultimodal:                CONTROL_REGISTERS.mpptMultimodal,
  mpptScanInterval:              CONTROL_REGISTERS.mpptScanInterval,
};

// Maps writable enum capability → Modbus register address (47xxx)
// What "Enable zero export" replaced, so "Disable zero export" can put it back. In the device
// store, so an app restart between the two does not lose it.
const ZERO_EXPORT_RESTORE_KEY = 'zero_export_restore';
const FEED_IN_MODES = new Set(['0', '1', '5', '6', '7']);

// The state "Enable zero export" itself leaves behind: limited by power, at 0 W. Never worth
// remembering — a second "enable" would otherwise save zero export as the thing to return to.
const isOwnZeroExport = (state) => !!state && state.mode === '6' && state.maxFeedInW === 0;
// Zero export by any means: the app's own (above), or the inverter's "Zero power grid
// connection" mode set in the SUN2000 app or by the installer.
const isZeroExport = (state) => isOwnZeroExport(state) || (!!state && state.mode === '5');

// Setting id → the name a person would recognise, for the timeline note when the inverter
// refuses a write from the settings page.
const SETTING_LABEL = {
  max_feed_in_power:     'Max feed-in power',
  max_feed_in_power_pct: 'Max feed-in power (%)',
  output_limit_w:        'Inverter output limit (W)',
  output_limit_pct:      'Inverter output limit (%)',
  mppt_multimodal:       'MPPT multimodal scanning',
  mppt_scan_interval:    'MPPT scanning interval',
};

// The feed-in mode, changed from a dropdown in the device settings — see lib/mode-settings.js
// and the comment where _registerControlListeners used to be.
const MODE_SETTINGS = {
  mode_active_power_control: { cap: 'activepower_controlmode', reg: 47415, ids: ['0', '1', '5', '6', '7'] },
};

const CONTROL_WRITE_MAP = {
  activepower_controlmode: 47415,
};

class SUN2000ModbusDevice extends Device {

  async onInit() {
    this.log(`Device initialised: ${this.getName()}`);
    this._failureCount              = 0;
    this._prevDeviceStatus          = null;
    this._updatingFromModbus        = false;
    this._updatingSettingFromModbus = false;
    this._writeInProgress           = false;
    this._settingsInitialized       = false; // true after first successful _fetchControl
    this._controlPollCounter        = 4; // start at 4 so first poll immediately reads control registers
    this._powerHistory              = [];
    this._ratedPowerW               = null; // populated by first poll, used to compute output_limit_w "no-cap" default
    this._pvStringCount              = null; // populated by first poll from register 30071
    this._lastPollStart             = 0;
    await this._ensureCapabilities();
    // No capability listener for activepower_controlmode, deliberately — see the comment
    // where _registerControlListeners used to be.
    this._registerFlowActions();
    this._registerPowerThresholdListeners();
    await this._startPolling();

    this._fetchAndUpdate().catch((err) => {
      this.error('Initial fetch failed:', err.message);
    });
  }

  async onSettings({ oldSettings = {}, newSettings, changedKeys }) {
    // Before anything else is written — see lib/mode-settings.js.
    const modeWrites = pendingModeWrites(this, MODE_SETTINGS, newSettings, changedKeys);

    if (['address', 'port', 'modbus_id', 'poll_interval'].some((k) => changedKeys.includes(k))) {
      await this._restartPolling(newSettings);
    }

    if (!this._updatingSettingFromModbus && this._settingsInitialized) {
      // From the page being saved: a new address entered together with a new value used to
      // send the value to the old one, getSetting() not having it yet.
      const address  = newSettings.address ?? this.getSetting('address');
      const port     = parseInt(newSettings.port ?? this.getSetting('port'), 10) || 502;
      const modbusId = parseIntSafe(newSettings.modbus_id ?? this.getSetting('modbus_id'), 1);

      // One shape for every write from this page: start, OK, or failed — and a failure puts
      // the setting back, so the page never shows a value the inverter does not have.
      const write = (key, reg, raw, writeFn) => {
        writeFn(address, port, modbusId, reg, raw)
          .then(() => this.log(`Write OK     [${key} → reg ${reg}]`))
          .catch((err) => {
            this.error(`${key} write failed:`, err.message);
            record(this, 'failed', key, `Write failed [${key} → reg ${reg}]: ${err.message} — setting taken back`);
            return this._revertSetting(key, oldSettings, err);
          });
      };

      if (changedKeys.includes('max_feed_in_power')) {
        const raw = Math.round(parseFloat(newSettings.max_feed_in_power) || 0);
        this.log(`Write max_feed_in_power: ${raw} W → reg 47416`);
        write('max_feed_in_power', 47416, raw, writeModbusU32);
      }

      if (changedKeys.includes('max_feed_in_power_pct')) {
        const raw = Math.round((parseFloat(newSettings.max_feed_in_power_pct) || 0) * 10);
        this.log(`Write max_feed_in_power_pct: ${newSettings.max_feed_in_power_pct} % → reg 47418 raw=${raw}`);
        write('max_feed_in_power_pct', 47418, raw, writeModbusRegister);
      }

      if (changedKeys.includes('output_limit_w')) {
        const raw = Math.round(Math.max(0, parseFloat(newSettings.output_limit_w) || 0));
        this.log(`Write output_limit_w: ${raw} W → reg 40126`);
        write('output_limit_w', 40126, raw, writeModbusU32);
      }

      if (changedKeys.includes('output_limit_pct')) {
        const pct = Math.min(100, Math.max(0, parseFloat(newSettings.output_limit_pct) || 0));
        const raw = Math.round(pct * 10);
        this.log(`Write output_limit_pct: ${pct} % → reg 40125 raw=${raw}`);
        write('output_limit_pct', 40125, raw, writeModbusRegister);
      }

      if (changedKeys.includes('mppt_multimodal')) {
        const raw = newSettings.mppt_multimodal ? 1 : 0;
        this.log(`Write mppt_multimodal: ${newSettings.mppt_multimodal} → reg 42054 raw=${raw}`);
        write('mppt_multimodal', 42054, raw, writeModbusRegister);
      }

      if (changedKeys.includes('mppt_scan_interval')) {
        const raw = Math.round(Math.max(1, Math.min(60, parseFloat(newSettings.mppt_scan_interval) || 5)));
        this.log(`Write mppt_scan_interval: ${raw} min → reg 42055`);
        write('mppt_scan_interval', 42055, raw, writeModbusRegister);
      }
    }

    // Not awaited, like every other write here: Homey stores the settings when this returns.
    applyModeWrites(this, modeWrites, (w) => {
      return writeModbusRegister(newSettings.address, parseInt(newSettings.port, 10) || 502,
        parseIntSafe(newSettings.modbus_id, 1), w.reg, parseInt(w.value, 10));
    }, (w, err) => revertModeSetting(this, w.key, oldSettings[w.key], err))
      .catch((err) => this.error('Mode write failed:', err.message));
  }

  // Puts a setting back after the inverter refused it — the same as on the battery, where this
  // came first. Homey has stored the page by the time a refusal arrives over the network.
  async _revertSetting(settingId, oldSettings, err) {
    const previous = oldSettings ? oldSettings[settingId] : undefined;
    if (previous === undefined || previous === null) return;
    if (this.getSetting(settingId) === previous) return;  // nothing drifted
    this._updatingSettingFromModbus = true;
    try {
      await this.setSettings({ [settingId]: previous });
    } catch (e) {
      this.log(`setSettings(${settingId}) revert failed:`, e.message);
      return;
    } finally {
      this._updatingSettingFromModbus = false;
    }
    if (this.getSetting('enable_timeline_notifications') === false) return;
    const label = SETTING_LABEL[settingId] || settingId;
    this.homey.notifications.createNotification({
      excerpt: `${this.getName()}: ${label} could not be written (${err.message}) — put back to ${previous}.`,
    }).catch((e) => this.log('Timeline notification failed:', e.message));
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
    await keepLast(this, VERSION_CAPABILITIES).catch((err) => this.error('Capability order:', err.message));
  }

  /**
   * The feed-in state as the last poll left it: the mode on 47415 (the capability) and the
   * watt limit on 47416 (the setting the poll keeps in step with it). null while either is
   * unknown — remembering half a state would restore the wrong half.
   */
  // "Disable zero export" found zero export on and nothing to go back to — see the card. A flow
  // fired by the EMS around negative prices is watched by nobody, so the card's own error alone
  // would go unseen while the inverter keeps feeding in nothing.
  _notifyZeroExportKept() {
    if (this.getSetting('enable_timeline_notifications') === false) return;
    this.homey.notifications.createNotification({
      excerpt: `${this.getName()}: zero export stays on — it was not switched on by this app, so the feed-in mode before it is unknown. Set the feed-in mode in the device settings.`,
    }).catch((e) => this.log('Timeline notification failed:', e.message));
  }

  _feedInState() {
    const mode = this.getCapabilityValue('activepower_controlmode');
    const w    = parseFloat(this.getSetting('max_feed_in_power'));
    if (mode === null || mode === undefined || !FEED_IN_MODES.has(String(mode))) return null;
    if (!Number.isFinite(w)) return null;
    return { mode: String(mode), maxFeedInW: Math.round(w) };
  }

  // ─── Why the feed-in mode cannot be changed from the device tile ─────────────
  //
  // Until 1.2.263 activepower_controlmode was a picker, and this file registered a capability
  // listener that wrote whatever the picker held straight into register 47415. Reported as
  // issue #35 by gsommer, whose house connection depends on a 5 kW feed-in limit: opening the
  // inverter in the Homey app was enough to reset it to Unlimited. His log, from 1.2.262:
  //
  //     11:53:41  Write start  [activepower_controlmode → reg 47415] value=0
  //     11:53:48  Write OK     [activepower_controlmode → reg 47415]
  //
  // No flow, no EMS — the tile. The picker is a scroll wheel with Unlimited at the top, on a
  // screen people scroll through to read their readings, and every movement of it was a
  // command to the inverter with no confirmation.
  //
  // A register that keeps a house's main fuse from tripping must change only when someone
  // means it to. So the tile only shows the mode (setable: false, uiComponent: sensor in the
  // manifest), and no listener is registered here at all: even a Homey app still rendering
  // the old picker from a cached definition has nothing to write through. Changing the mode
  // stays possible, deliberately: from a dropdown in the device settings, written only on
  // Save (since 1.2.266, see lib/mode-settings.js), and through the flow cards below — "Set active power mode",
  // the export-limit and zero-export cards, "Set max feed-in power (%)" — which all name what
  // they do and are run on purpose.
  //
  // CONTROL_WRITE_MAP stays: those flow cards take the register address from it.

  // ─── Flow actions ──────────────────────────────────────────────────────────

  _registerFlowActions() {
    this.homey.flow
      .getDeviceTriggerCard('sun2000_status_changed')
      .registerRunListener((args, state) => args.status === state.status);

    this.homey.flow
      .getConditionCard('sun2000_status_is')
      .registerRunListener((args) => args.device.getCapabilityValue('huawei_status') === args.status);

    // Homey keeps one run listener per action card for the whole app, and the last device to
    // register it wins. Until 1.2.291 these listeners closed over `this` — that device — for
    // the address they wrote to, the limits they checked and the state they updated, so with
    // two devices of this driver a card set for the second acted on the first. They are now
    // built for the device each run names: `self` is args.device. With one device per driver
    // self and this are the same device, and test/flow-action-routing.test.js holds every card
    // to what it did before. A run that names no device — none of these cards can, each has a
    // device argument — falls back to the registering device, which is what it always did.
    const build = (self) => {
      const cards = {};
      const host   = () => self.getSetting('address');
      const port   = () => parseInt(self.getSetting('port'), 10) || 502;
      const unitId = () => parseIntSafe(self.getSetting('modbus_id'), 1);

      cards['sun2000_set_active_power_mode'] = ({ mode }) => {
        const reg   = CONTROL_WRITE_MAP.activepower_controlmode;
        const value = parseInt(mode, 10);
        self.log(`Write start  [sun2000_set_active_power_mode → reg ${reg}] value=${value}`);
        self._writeInProgress = true;
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit
        (async () => {
          try {
            await writeModbusRegister(host(), port(), unitId(), reg, value);
            self.log(`Write OK     [sun2000_set_active_power_mode → reg ${reg}]`);
            self._updatingFromModbus = true;
            await self._set('activepower_controlmode', mode).catch(() => {});
          } catch (err) {
            self.error(`Write failed [sun2000_set_active_power_mode → reg ${reg}]:`, err.message);
          } finally {
            self._updatingFromModbus = false;
            self._writeInProgress   = false;
          }
        })();
      };

      cards['sun2000_set_max_feed_in_power'] = ({ power }) => {
        const raw = Math.round(Math.max(0, parseFloat(power) || 0));
        self.log(`Write start  [sun2000_set_max_feed_in_power → reg 47416] value=${raw}W`);
        self._writeInProgress = true;
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit
        (async () => {
          try {
            await writeModbusU32(host(), port(), unitId(), 47416, raw);
            self.log(`Write OK     [sun2000_set_max_feed_in_power → reg 47416]`);
            self._updatingSettingFromModbus = true;
            await self.setSettings({ max_feed_in_power: raw }).catch(() => {});
          } catch (err) {
            self.error(`Write failed [sun2000_set_max_feed_in_power → reg 47416]:`, err.message);
          } finally {
            self._updatingSettingFromModbus = false;
            self._writeInProgress           = false;
          }
        })();
      };

      cards['sun2000_set_max_feed_in_power_pct'] = ({ percentage }) => {
        const pct = Math.min(100, Math.max(0, parseFloat(percentage) || 0));
        const raw = Math.round(pct * 10);
        self.log(`Write start  [sun2000_set_max_feed_in_power_pct] reg 47415=7, reg 47418=${pct}%`);
        self._writeInProgress = true;
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit.
        // Must set mode 7 (Power-limited %) on reg 47415 before writing the % limit to 47418;
        // otherwise the firmware ignores the 47418 value.
        (async () => {
          try {
            await writeModbusRegister(host(), port(), unitId(), 47415, 7);
            await writeModbusRegister(host(), port(), unitId(), 47418, raw);
            self.log(`Write OK     [sun2000_set_max_feed_in_power_pct]`);
            self._updatingFromModbus = true;
            await self._set('activepower_controlmode', '7').catch(() => {});
            self._updatingSettingFromModbus = true;
            await self.setSettings({ max_feed_in_power_pct: pct }).catch(() => {});
          } catch (err) {
            self.error(`Write failed [sun2000_set_max_feed_in_power_pct]:`, err.message);
          } finally {
            self._updatingFromModbus        = false;
            self._updatingSettingFromModbus = false;
            self._writeInProgress           = false;
          }
        })();
      };

      // Direct derating cards (40125/40126) — work standalone without a Smart Power
      // Sensor. Reference: ioBroker.sun2000 issue #176, confirmed by Huawei.
      cards['sun2000_set_active_power_derating_w'] = ({ power }) => {
        const raw = Math.round(Math.max(0, parseFloat(power) || 0));
        self.log(`Write start  [sun2000_set_active_power_derating_w → reg 40126] value=${raw}W`);
        self._writeInProgress = true;
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit
        (async () => {
          try {
            await writeModbusU32(host(), port(), unitId(), 40126, raw);
            self.log(`Write OK     [sun2000_set_active_power_derating_w → reg 40126]`);
            self._updatingSettingFromModbus = true;
            await self.setSettings({ output_limit_w: raw }).catch(() => {});
          } catch (err) {
            self.error(`Write failed [sun2000_set_active_power_derating_w → reg 40126]:`, err.message);
          } finally {
            self._updatingSettingFromModbus = false;
            self._writeInProgress           = false;
          }
        })();
      };

      cards['sun2000_set_active_power_derating_pct'] = ({ percentage }) => {
        const pct = Math.min(100, Math.max(0, parseFloat(percentage) || 0));
        const raw = Math.round(pct * 10);
        self.log(`Write start  [sun2000_set_active_power_derating_pct → reg 40125] value=${pct}%`);
        self._writeInProgress = true;
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit
        (async () => {
          try {
            await writeModbusRegister(host(), port(), unitId(), 40125, raw);
            self.log(`Write OK     [sun2000_set_active_power_derating_pct → reg 40125]`);
            self._updatingSettingFromModbus = true;
            await self.setSettings({ output_limit_pct: pct }).catch(() => {});
          } catch (err) {
            self.error(`Write failed [sun2000_set_active_power_derating_pct → reg 40125]:`, err.message);
          } finally {
            self._updatingSettingFromModbus = false;
            self._writeInProgress           = false;
          }
        })();
      };

      cards['sun2000_set_export_limit_enabled'] = ({ onoff }) => {
        const value = onoff === 'enable' ? 6 : 0;
        const reg   = CONTROL_WRITE_MAP.activepower_controlmode;
        self.log(`Write start  [sun2000_set_export_limit_enabled → reg ${reg}] value=${value} (${onoff})`);
        self._writeInProgress = true;
        (async () => {
          try {
            await writeModbusRegister(host(), port(), unitId(), reg, value);
            self.log(`Write OK     [sun2000_set_export_limit_enabled → reg ${reg}]`);
            self._updatingFromModbus = true;
            await self._set('activepower_controlmode', String(value)).catch(() => {});
          } catch (err) {
            self.error(`Write failed [sun2000_set_export_limit_enabled → reg ${reg}]:`, err.message);
          } finally {
            self._updatingFromModbus = false;
            self._writeInProgress   = false;
          }
        })();
      };

      cards['sun2000_enable_zero_export'] = () => {
        const reg = CONTROL_WRITE_MAP.activepower_controlmode;
        // Taken before the first write: once 47416 is 0, the limit it held is gone from the
        // inverter. See "Disable zero export" for why it has to be kept.
        const before = self._feedInState();
        self.log('Write start  [sun2000_enable_zero_export] reg 47415=6, reg 47416=0');
        self._writeInProgress = true;
        (async () => {
          try {
            if (before && !isOwnZeroExport(before)) {
              await self.setStoreValue(ZERO_EXPORT_RESTORE_KEY, { ...before, savedAt: Date.now() });
              self.log(`[sun2000_enable_zero_export] remembered mode ${before.mode} with `
                + `${before.maxFeedInW} W — "Disable zero export" will put it back`);
            } else if (!before) {
              self.log('[sun2000_enable_zero_export] the current feed-in mode is not known yet — '
                + '"Disable zero export" can only return to Unlimited');
            }
            await writeModbusRegister(host(), port(), unitId(), reg, 6);
            await writeModbusU32(host(), port(), unitId(), 47416, 0);
            self.log('Write OK     [sun2000_enable_zero_export]');
            self._updatingFromModbus = true;
            await self._set('activepower_controlmode', '6').catch(() => {});
            self._updatingSettingFromModbus = true;
            await self.setSettings({ max_feed_in_power: 0 }).catch(() => {});
          } catch (err) {
            self.error('Write failed [sun2000_enable_zero_export]:', err.message);
          } finally {
            self._updatingFromModbus        = false;
            self._updatingSettingFromModbus = false;
            self._writeInProgress           = false;
          }
        })();
      };

      cards['sun2000_disable_zero_export'] = () => {
        // Until 1.2.264 this wrote 47415 = 0, Unlimited, whatever had been in force before.
        // For an installation with a standing feed-in limit — a main fuse, as in issue #35, or
        // a grid operator's 60/70 % rule — that turned "zero export off" into "protection off".
        // And "Enable zero export" had already overwritten the watt limit on 47416 with 0, so
        // even switching the mode back by hand left the house at zero export instead of at its
        // limit. The EMS fires exactly this pair around negative prices.
        //
        // So the state "Enable zero export" replaced is put back: the watt limit first, then
        // the mode. If the limit write fails the mode is not touched, the inverter stays at
        // zero export — the restrictive side — and the remembered state is kept for the next
        // attempt.
        //
        // With nothing remembered, nothing is written (1.2.312). Until then this fell back to
        // Unlimited whatever the inverter was doing — and the state is cleared after every
        // restore, so a SECOND "Disable" took a standing 5 kW limit off (review 2026-10-10,
        // Gerhard's situation in issue #35). Now:
        //   · zero export is not on      → nothing to disable; the card succeeds, the log says so
        //   · it is on, set outside the app → the mode before it is unknown; Andi's call: the
        //                                    card fails and says so, the inverter stays at zero
        //                                    export — the restrictive side, as above
        //   · the mode was not read yet  → the card fails; try again in a minute
        const reg   = CONTROL_WRITE_MAP.activepower_controlmode;
        const saved = self.getStoreValue(ZERO_EXPORT_RESTORE_KEY);
        const valid = !!saved && FEED_IN_MODES.has(saved.mode) && Number.isFinite(saved.maxFeedInW);
        const now   = self._feedInState();
        if (!valid) {
          if (!now) {
            self.log('[sun2000_disable_zero_export] the feed-in mode has not been read yet — nothing written');
            throw new Error(self.homey.__('modbus.zeroExport.notReadYet'));
          }
          if (!isZeroExport(now)) {
            self.log(`[sun2000_disable_zero_export] zero export is not on (mode ${now.mode}, ${now.maxFeedInW} W) — nothing to disable, nothing written`);
            return;
          }
          self.log(`[sun2000_disable_zero_export] zero export is on (mode ${now.mode}) but was not switched on by this app — `
            + 'the feed-in mode before it is unknown, nothing written');
          self._notifyZeroExportKept();
          throw new Error(self.homey.__('modbus.zeroExport.noEarlierState'));
        }
        self._writeInProgress = true;
        (async () => {
          try {
            self.log(`Write start  [sun2000_disable_zero_export] restoring mode ${saved.mode} with `
              + `${saved.maxFeedInW} W — reg 47416=${saved.maxFeedInW}, reg 47415=${saved.mode}`);
            if (now && !isOwnZeroExport(now)) {
              self.log('[sun2000_disable_zero_export] zero export was no longer active — '
                + 'putting back the state from before it anyway');
            }
            await writeModbusU32(host(), port(), unitId(), 47416, saved.maxFeedInW);
            await writeModbusRegister(host(), port(), unitId(), reg, parseInt(saved.mode, 10));
            await self.setStoreValue(ZERO_EXPORT_RESTORE_KEY, null);
            self.log('Write OK     [sun2000_disable_zero_export]');
            self._updatingFromModbus = true;
            await self._set('activepower_controlmode', saved.mode).catch(() => {});
            self._updatingSettingFromModbus = true;
            await self.setSettings({ max_feed_in_power: saved.maxFeedInW }).catch(() => {});
          } catch (err) {
            self.error('Write failed [sun2000_disable_zero_export]:', err.message);
          } finally {
            self._updatingFromModbus        = false;
            self._updatingSettingFromModbus = false;
            self._writeInProgress           = false;
          }
        })();
      };

      // Resets both derating registers to "no limit": rated power × 1.1 (W) + 100 (%).
      // Falls back to 100000 W if rated power has not been polled yet (the inverter
      // will clamp it to its own ceiling on the next read).
      cards['sun2000_reset_output_limit'] = () => {
        const ceilingW = self._ratedPowerW
          ? Math.round(self._ratedPowerW * 1.1)
          : 100000;
        self.log(`Write start  [sun2000_reset_output_limit] reg 40126=${ceilingW}W (rated×1.1), reg 40125=1000 (100%)`);
        self._writeInProgress = true;
        // Fire-and-forget — return immediately so Homey's 10 s flow timeout is never hit
        (async () => {
          try {
            await writeModbusU32(host(), port(), unitId(), 40126, ceilingW);
            await writeModbusRegister(host(), port(), unitId(), 40125, 1000);
            self.log(`Write OK     [sun2000_reset_output_limit] inverter back to no cap`);
            self._updatingSettingFromModbus = true;
            await self.setSettings({ output_limit_w: ceilingW, output_limit_pct: 100 }).catch(() => {});
          } catch (err) {
            self.error(`Write failed [sun2000_reset_output_limit]:`, err.message);
          } finally {
            self._updatingSettingFromModbus = false;
            self._writeInProgress           = false;
          }
        })();
      };

      // Registers 40200 (Startup) / 40201 (Shutdown) are command registers:
      // writing 0 triggers the action (field-verified; the register value itself
      // carries no state).
      cards['sun2000_startup'] = () => {
        self.log('Write start  [sun2000_startup → reg 40200] value=0');
        self._writeInProgress = true;
        (async () => {
          try {
            await writeModbusRegister(host(), port(), unitId(), 40200, 0);
            self.log('Write OK     [sun2000_startup]');
          } catch (err) {
            self.error('Write failed [sun2000_startup]:', err.message);
          } finally {
            self._writeInProgress = false;
          }
        })();
      };

      cards['sun2000_shutdown'] = () => {
        self.log('Write start  [sun2000_shutdown → reg 40201] value=0');
        self._writeInProgress = true;
        (async () => {
          try {
            await writeModbusRegister(host(), port(), unitId(), 40201, 0);
            self.log('Write OK     [sun2000_shutdown]');
          } catch (err) {
            self.error('Write failed [sun2000_shutdown]:', err.message);
          } finally {
            self._writeInProgress = false;
          }
        })();
      };

      cards['sun2000_set_mppt_multimodal'] = ({ mode }) => {
        const value = parseInt(mode, 10);
        self.log(`Write start  [sun2000_set_mppt_multimodal → reg 42054] value=${value}`);
        self._writeInProgress = true;
        (async () => {
          try {
            await writeModbusRegister(host(), port(), unitId(), 42054, value);
            self.log(`Write OK     [sun2000_set_mppt_multimodal]`);
          } catch (err) {
            self.error(`Write failed [sun2000_set_mppt_multimodal]:`, err.message);
          } finally {
            self._writeInProgress = false;
          }
        })();
      };

      cards['sun2000_set_mppt_interval'] = ({ interval }) => {
        const raw = Math.round(Math.max(1, Math.min(60, parseInt(interval, 10) || 5)));
        self.log(`Write start  [sun2000_set_mppt_interval → reg 42055] value=${raw}min`);
        self._writeInProgress = true;
        (async () => {
          try {
            await writeModbusRegister(host(), port(), unitId(), 42055, raw);
            self.log(`Write OK     [sun2000_set_mppt_interval]`);
          } catch (err) {
            self.error(`Write failed [sun2000_set_mppt_interval]:`, err.message);
          } finally {
            self._writeInProgress = false;
          }
        })();
      };
      return cards;
    };
    for (const id of Object.keys(build(this))) {
      this.homey.flow.getActionCard(id).registerRunListener((args, state) => build((args && args.device) || this)[id](args, state));
    }
  }

  // ─── Power threshold triggers ──────────────────────────────────────────────

  _registerPowerThresholdListeners() {
    const makeListener = (above) => (args) => {
      const durationMs = (args.duration || 1) * 60000;
      const cutoff     = Date.now() - durationMs;
      const history    = args.device._powerHistory || [];
      const recent     = history.filter((e) => e.t >= cutoff);
      const hasOlder   = history.some((e) => e.t < cutoff);
      if (!hasOlder || recent.length === 0) return false;
      return above ? recent.every((e) => e.p > args.power)
                   : recent.every((e) => e.p < args.power);
    };
    this.homey.flow.getConditionCard('sun2000_power_above_for').registerRunListener(makeListener(true));
    this.homey.flow.getConditionCard('sun2000_power_below_for').registerRunListener(makeListener(false));
  }

  _trackPower(power) {
    const now = Date.now();
    this._powerHistory.push({ t: now, p: power });
    const cutoff = now - 7200000; // keep 2 hours
    this._powerHistory = this._powerHistory.filter((e) => e.t >= cutoff);
  }

  // ─── Polling ───────────────────────────────────────────────────────────────

  // Poll timing for the shared mixin (lib/modbus-polling). Declared per driver, not
  // in the mixin, because the interval genuinely differs between device families.
  get pollDefaultS() { return DEFAULT_INTERVAL_S; }
  get pollMinS()     { return MIN_INTERVAL_S; }

  // ─── Data fetch ────────────────────────────────────────────────────────────

  async _fetchAndUpdate() {
    if (this._fetchInProgress) return;
    if (this._writeInProgress) return; // pause poll while a write is queued/running
    this._fetchInProgress = true;
    this._lastPollStart = Date.now();

    const address = this.getSetting('address');

    if (!address) {
      this._fetchInProgress = false;
      await this.setUnavailable(this.homey.__('modbus.errors.noAddress'));
      return;
    }

    const port     = parseInt(this.getSetting('port'), 10) || 502;
    const modbusId = parseIntSafe(this.getSetting('modbus_id'), 1);

    const abort = () => this._writeInProgress;

    try {
      // Built per poll rather than fixed: the strings past PV2 are only asked for once the
      // inverter has said it has them, so they arrive from the second poll on. Guessing at
      // the number instead would put unimplemented addresses in the same batch as PV1 and
      // PV2 — see pvStringRegisters() for why that is not a harmless waste.
      const data = await readModbusRegisters(
        address, port, modbusId,
        { ...REGISTERS, ...pvStringRegisters(this._pvStringCount ?? 0) },
        abort,
      );

      await this._updatePvStringCapabilities(data.pvStringCount);

      if (typeof data.ratedPower === 'number' && data.ratedPower > 0) {
        this._ratedPowerW = data.ratedPower;
      }

      // PV input power not read this poll is not 0 W. It used to be published as 0, as a
      // successful poll: "power changed" fired with 0, the 0 went into the history behind
      // "power above … for N minutes", and the tile dipped — whenever a flow card's write cut
      // the poll short (review 2026-10-10). Now the last value stands until the next read.
      const prevPower = this.getCapabilityValue('measure_power');
      const powerRead = data.inputPower !== null && data.inputPower !== undefined;
      const newPower  = powerRead ? data.inputPower : prevPower;

      if (powerRead) await this._set('measure_power', newPower);
      await this._set('measure_power.active_power', data.activePower ?? null);
      await this._set('measure_temperature.invertor', data.internalTemperature ?? null);
      await this._set('meter_power',                data.accumulatedYieldEnergy ?? null);
      await this._set('meter_power.daily',          data.dailyYieldEnergy ?? null);
      await this._set('measure_voltage.pv1',        data.pv1Voltage ?? null);
      await this._set('measure_voltage.pv2',        data.pv2Voltage ?? null);
      await this._set('measure_current.pv1',        data.pv1Current ?? null);
      await this._set('measure_current.pv2',        data.pv2Current ?? null);
      await this._set('measure_frequency',          data.gridFrequency ?? null);
      for (let i = 3; i <= (this._pvStringCount ?? 0); i++) {
        await this._set(`measure_voltage.pv${i}`, data[`pv${i}Voltage`] ?? null);
        await this._set(`measure_current.pv${i}`, data[`pv${i}Current`] ?? null);
      }
      await this._updateOptimizerCapabilities(data.totalOptimizers, data.onlineOptimizers, notRead(data, 'totalOptimizers'));

      if (data.deviceStatus !== null && data.deviceStatus !== undefined) {
        const label = statusLabel(data.deviceStatus);
        await this._set('huawei_status', label);
        if (this._prevDeviceStatus !== null && label !== this._prevDeviceStatus) {
          this.homey.flow.getDeviceTriggerCard('sun2000_status_changed')
            .trigger(this, { status: label }, { status: label }).catch((err) => this.log('Flow trigger sun2000_status_changed failed:', err.message));
          if (this.getSetting('enable_timeline_notifications') !== false) {
            this.homey.notifications.createNotification({ excerpt: `${this.getName()}: ${label}` })
              .catch((err) => this.log('Timeline notification failed:', err.message));
          }
        }
        this._prevDeviceStatus = label;
      }

      if (data.softwareVersion) {
        await this._set('sun2000_software_version', data.softwareVersion);
      }

      await this._fetchPowerMeter(address, port, modbusId, abort);

      // Read control registers every 5th poll — they change rarely and the read
      // adds ~1 s of connection time that delays pending writes.
      this._controlPollCounter = (this._controlPollCounter + 1) % 5;
      if (this._controlPollCounter === 0) {
        await this._fetchControl(address, port, modbusId);
      }

      if (powerRead && prevPower !== newPower) {
        await this.homey.flow
          .getDeviceTriggerCard('modbus_power_changed')
          .trigger(this, { power: newPower })
          .catch((err) => this.log('Flow trigger modbus_power_changed failed:', err.message));
      }
      if (powerRead) this._trackPower(newPower);

      this._failureCount = 0;
      // The version strings end the tile, after whatever this poll may have added (1.2.301).
      await keepLast(this, VERSION_CAPABILITIES).catch((err) => this.error('Capability order:', err.message));
      if (!this.getAvailable()) await this.setAvailable();
      logPollOk(this, powerRead ? 'Poll OK: PV=' + Math.round(newPower) + 'W' : 'Poll OK: PV not read this time, last value kept');

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

  /**
   * Adds a row per PV string the inverter reports, beyond the two every model has.
   *
   * Register 30071 holds the count, and the spec is explicit that the host is meant to read
   * that many strings. This driver read PV1 and PV2 and stopped, so a four-string inverter
   * showed half its strings — not a wrong number, a missing one. Production was never
   * affected: 32064 is the total DC input across all strings whatever their number.
   *
   * Read once and then left alone, unlike the optimizer count next door. Two reasons, and
   * only the second is about caution: the count decides which registers the next poll asks
   * for, so re-deciding it every poll would make the read table flap; and 30071 is the kind
   * of register that answers 0 while the inverter is restarting, which taken at face value
   * would strip the rows off a working four-string install. A string count changes when
   * somebody rewires the roof, and that is what re-pairing the device is for.
   */
  async _updatePvStringCapabilities(count) {
    if (this._pvStringCount !== null) return;
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 1) return;

    this._pvStringCount = Math.min(count, MAX_PV_STRINGS);
    if (count > MAX_PV_STRINGS) {
      this.log(`Inverter reports ${count} PV strings, the spec defines ${MAX_PV_STRINGS} — reading that many`);
    }
    this.log(`PV strings reported: ${this._pvStringCount}`);

    for (let i = 3; i <= this._pvStringCount; i++) {
      for (const cap of [`measure_voltage.pv${i}`, `measure_current.pv${i}`]) {
        if (!this.hasCapability(cap)) {
          try {
            await this.addCapability(cap);
          } catch (err) {
            this.error(`addCapability(${cap}) failed:`, err.message);
          }
        }
      }
    }
  }

  async _updateOptimizerCapabilities(total, online, unread = false) {
    const hasOptimizers = typeof total === 'number' && Number.isFinite(total) && total > 0;
    // Not read is not "no optimizers" — see notRead() in lib/modbus-client.js.
    if (!hasOptimizers && unread) return;

    if (hasOptimizers) {
      for (const cap of OPTIMIZER_CAPABILITIES) {
        if (!this.hasCapability(cap)) {
        try {
          await this.addCapability(cap);
        } catch (err) {
          this.error("addCapability(" + cap + ") failed:", err.message);
        }
      }
      }
      await this._set('optimizer_total_count',  total);
      await this._set('optimizer_online_count', online ?? null);
    } else {
      for (const cap of OPTIMIZER_CAPABILITIES) {
        if (this.hasCapability(cap)) await this.removeCapability(cap);
      }
    }
  }

  async _fetchPowerMeter(address, port, modbusId, shouldAbort) {
    try {
      const meter = await readModbusRegisters(address, port, modbusId, POWER_METER_REGISTERS, shouldAbort);

      if (!isPowerMeterDataValid(meter)) {
        // A meter not read this poll keeps its capabilities and values; only one the
        // inverter says it does not have loses them. Until 1.2.316 a flow card's write that
        // cut this read short removed measure_power.grid_active_power — the grid figure the
        // energy management reads by default — and the import/export meters, to add them
        // back on the next poll (review 2026-10-10).
        if (notRead(meter, 'powerMeterActivePower')) return;
        for (const cap of POWER_METER_CAPABILITIES) {
          if (this.hasCapability(cap)) await this.removeCapability(cap);
        }
        return;
      }

      for (const cap of POWER_METER_CAPABILITIES) {
        if (!this.hasCapability(cap)) {
        try {
          await this.addCapability(cap);
        } catch (err) {
          this.error("addCapability(" + cap + ") failed:", err.message);
        }
      }
      }

      const negate = (v) => (v !== null && v !== undefined) ? -v : null;
      await this._set('measure_power.grid_active_power', negate(meter.powerMeterActivePower));
      await this._set('meter_power.grid_export',      meter.gridExportedEnergy ?? null);
      await this._set('meter_power.grid_import',      meter.gridAccumulatedEnergy ?? null);

    } catch (err) {
      this.log('Power meter read skipped:', err.message);
    }
  }

  async _fetchControl(address, port, modbusId) {
    try {
      const ctrl = await readModbusRegisters(address, port, modbusId, INVERTER_CONTROL_REGISTERS, () => this._writeInProgress);

      const toEnum = (v) => (v !== null && v !== undefined) ? String(v) : null;

      this._updatingFromModbus = true;
      await this._set('activepower_controlmode', toEnum(ctrl.activePowerControlMode));
      this._updatingFromModbus = false;

      // Sync feed-in power settings if they differ
      const settingUpdates = {};
      // The min/max mirror app.json; SETTING_RANGES_MATCH_MANIFEST in test/ems.test.js
      // fails if the two ever drift apart.
      const numericSync = [
        ['activePowerMaxFeedIn',          'max_feed_in_power',     1,   0, 100000],
        ['activePowerMaxFeedInPct',       'max_feed_in_power_pct', 0.5, 0, 100   ],
        ['activePowerFixedValueDerating', 'output_limit_w',        1,   0, 100000],
        ['activePowerPercentageDerating', 'output_limit_pct',      0.5, 0, 100   ],
        ['mpptScanInterval',              'mppt_scan_interval',    0.5, 1, 60    ],
      ];
      for (const [key, settingId, tolerance, min, max] of numericSync) {
        const v = ctrl[key];
        if (v === null || v === undefined) continue;
        // A value the setting cannot even hold did not come from the inverter's mind — it
        // came from a reply that belonged to a different request. Field log 2026-08-14
        // 00:29: a read plan desynced, and max_feed_in_power arrived outside 0..100000;
        // Homey's own range check refused it, which is the only reason it was noticed.
        // A wrong value INSIDE the range would have been stored silently, so implausible
        // ones are dropped here rather than offered to setSettings.
        if (v < min || v > max) {
          this.log(`ignoring out-of-range ${settingId}=${v} (expected ${min}..${max}) — bad read`);
          continue;
        }
        const current = parseFloat(this.getSetting(settingId));
        if (!Number.isFinite(current) || Math.abs(v - current) > tolerance) settingUpdates[settingId] = v;
      }

      // MPPT multimodal: raw 0 → false (disabled), raw 1 → true (enabled) — checkbox setting
      if (ctrl.mpptMultimodal !== null && ctrl.mpptMultimodal !== undefined) {
        const mpptBool = ctrl.mpptMultimodal === 1;
        if (this.getSetting('mppt_multimodal') !== mpptBool) settingUpdates['mppt_multimodal'] = mpptBool;
      }
      // Stored under the guard, and every value that moved on the device is logged.
      await applySettingSync(this, settingUpdates);

      // The feed-in mode dropdown — see lib/mode-settings.js.
      await syncModeSettings(this, MODE_SETTINGS, { mode_active_power_control: ctrl.activePowerControlMode });

      // Mark settings as initialised — onSettings writes are now safe
      this._settingsInitialized = true;

    } catch (err) {
      this.log('Control register read skipped:', err.message);
    } finally {
      this._updatingFromModbus        = false;
      this._updatingSettingFromModbus = false;
    }
  }

}

Object.assign(SUN2000ModbusDevice.prototype, modbusPolling);

// Every saved settings page in the log and the change log — see lib/change-log.js.
withSettingsLog(SUN2000ModbusDevice);

module.exports = SUN2000ModbusDevice;
