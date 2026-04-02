'use strict';

const { Driver } = require('homey');
const { REGISTERS } = require('../../lib/modbus-registers');
const { readModbusRegisters } = require('../../lib/modbus-client');

class SUN2000ModbusDriver extends Driver {

  async onInit() {
    this.log('SUN2000 Modbus driver initialised');
  }

  async onPair(session) {
    session.setHandler('connect', async ({ address, port, modbusId, name }) => {
      address = (address || '').trim();
      port = parseInt(port, 10) || 502;
      modbusId = parseInt(modbusId, 10) || 1;

      if (!address) {
        throw new Error(this.homey.__('modbus.pair.errors.noAddress'));
      }

      // Read identification + basic power registers to validate connection
      const probeRegisters = {
        modelName:           REGISTERS.modelName,
        activePower:         REGISTERS.activePower,
        dailyYieldEnergy:    REGISTERS.dailyYieldEnergy,
        accumulatedYieldEnergy: REGISTERS.accumulatedYieldEnergy,
        internalTemperature: REGISTERS.internalTemperature,
        deviceStatus:        REGISTERS.deviceStatus,
      };

      const data = await readModbusRegisters(address, port, modbusId, probeRegisters);

      this.log(`Pairing SUN2000 at ${address}:${port} id=${modbusId}, model="${data.modelName}", power=${data.activePower}W`);

      return {
        success: true,
        modelName: data.modelName || 'SUN2000',
        kpi: {
          activePower:         data.activePower,
          dailyYieldEnergy:    data.dailyYieldEnergy,
          accumulatedYieldEnergy: data.accumulatedYieldEnergy,
          internalTemperature: data.internalTemperature,
        },
      };
    });
  }

}

module.exports = SUN2000ModbusDriver;
