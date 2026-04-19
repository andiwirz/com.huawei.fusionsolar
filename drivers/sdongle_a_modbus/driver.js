'use strict';

const { Driver } = require('homey');
const { SDONGLE_A_REGISTERS, isSdonglaADataValid } = require('../../lib/modbus-registers');
const { readModbusRegisters } = require('../../lib/modbus-client');

class SdonglaAModbusDriver extends Driver {

  async onInit() {
    this.log('SDongle A Modbus driver initialised');
  }

  async onPair(session) {
    session.setHandler('connect', async ({ address, port, modbusId, name }) => {
      address  = (address || '').trim();
      port     = parseInt(port, 10) || 502;
      modbusId = parseInt(modbusId, 10) || 100;

      if (!address) {
        throw new Error(this.homey.__('modbus.pair.errors.noAddress'));
      }

      const probeRegisters = {
        totalInputPower: SDONGLE_A_REGISTERS.totalInputPower,
        gridPower:       SDONGLE_A_REGISTERS.gridPower,
        loadPower:       SDONGLE_A_REGISTERS.loadPower,
      };

      const data = await readModbusRegisters(address, port, modbusId, probeRegisters);

      if (!isSdonglaADataValid(data)) {
        throw new Error(this.homey.__('modbus.pair.errors.sdonglaNotDetected'));
      }

      this.log(`Pairing SDongle A at ${address}:${port} id=${modbusId}, gridPower=${data.gridPower}W, solar=${data.totalInputPower}W`);

      return {
        success: true,
        kpi: {
          totalInputPower: data.totalInputPower,
          gridPower:       data.gridPower,
          loadPower:       data.loadPower,
        },
      };
    });
  }

}

module.exports = SdonglaAModbusDriver;
