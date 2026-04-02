'use strict';

const { Driver } = require('homey');
const { BATTERY_REGISTERS, isBatteryDataValid } = require('../../lib/modbus-registers');
const { readModbusRegisters } = require('../../lib/modbus-client');

class LUNA2000ModbusDriver extends Driver {

  async onInit() {
    this.log('LUNA2000 Modbus driver initialised');
  }

  async onPair(session) {
    session.setHandler('connect', async ({ address, port, modbusId, name }) => {
      address  = (address || '').trim();
      port     = parseInt(port, 10) || 502;
      modbusId = parseInt(modbusId, 10) || 1;

      if (!address) {
        throw new Error(this.homey.__('modbus.pair.errors.noAddress'));
      }

      const probeRegisters = {
        storageSOC:               BATTERY_REGISTERS.storageSOC,
        storageChargeDischarge:   BATTERY_REGISTERS.storageChargeDischarge,
        storageMaxChargePower:    BATTERY_REGISTERS.storageMaxChargePower,
        storageMaxDischargePower: BATTERY_REGISTERS.storageMaxDischargePower,
        storageDayCharge:         BATTERY_REGISTERS.storageDayCharge,
        storageDayDischarge:      BATTERY_REGISTERS.storageDayDischarge,
      };

      const data = await readModbusRegisters(address, port, modbusId, probeRegisters);

      if (!isBatteryDataValid(data)) {
        throw new Error(this.homey.__('modbus.pair.errors.batteryNotDetected'));
      }

      this.log(`Pairing LUNA2000 at ${address}:${port} id=${modbusId}, SOC=${data.storageSOC}%`);

      return {
        success: true,
        kpi: {
          storageSOC:               data.storageSOC,
          storageChargeDischarge:   data.storageChargeDischarge,
          storageMaxChargePower:    data.storageMaxChargePower,
          storageMaxDischargePower: data.storageMaxDischargePower,
        },
      };
    });
  }

}

module.exports = LUNA2000ModbusDriver;
