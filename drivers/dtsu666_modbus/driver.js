'use strict';

const { Driver } = require('homey');
const { POWER_METER_REGISTERS, isPowerMeterDataValid } = require('../../lib/modbus-registers');
const { readModbusRegisters } = require('../../lib/modbus-client');

class DTSU666ModbusDriver extends Driver {

  async onInit() {
    this.log('DTSU666 Modbus driver initialised');
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
        powerMeterActivePower: POWER_METER_REGISTERS.powerMeterActivePower,
        gridExportedEnergy:    POWER_METER_REGISTERS.gridExportedEnergy,
        gridAccumulatedEnergy: POWER_METER_REGISTERS.gridAccumulatedEnergy,
      };

      const data = await readModbusRegisters(address, port, modbusId, probeRegisters);

      if (!isPowerMeterDataValid(data)) {
        throw new Error(this.homey.__('modbus.pair.errors.meterNotDetected'));
      }

      this.log(`Pairing DTSU666 at ${address}:${port} id=${modbusId}, activePower=${data.powerMeterActivePower}W`);

      return {
        success: true,
        kpi: {
          powerMeterActivePower: data.powerMeterActivePower,
          gridExportedEnergy:    data.gridExportedEnergy,
          gridAccumulatedEnergy: data.gridAccumulatedEnergy,
        },
      };
    });
  }

}

module.exports = DTSU666ModbusDriver;
