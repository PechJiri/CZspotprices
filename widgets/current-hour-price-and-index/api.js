'use strict';

module.exports = {
  async getSpotPrice({ homey }) {
    const price = await homey.devices.getCapabilityValue('measure_current_spot_price_CZK');
    const index = await homey.devices.getCapabilityValue('measure_current_spot_price_index');

    return { price, index };
  }
};
