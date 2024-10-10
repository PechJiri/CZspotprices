'use strict';

module.exports = {
  async getSpotPrice({ homey }) {
    try {
      const device = await homey.drivers.getDriver('cz-spot-prices').getDevice();
      const currentSpotPrice = await device.getCapabilityValue('measure_current_spot_price_CZK');
      const currentSpotIndex = await device.getCapabilityValue('measure_current_spot_index');

      return {
        currentSpotPrice,
        currentSpotIndex
      };
    } catch (error) {
      console.error('Error fetching spot price data:', error);
      throw error;
    }
  }
};