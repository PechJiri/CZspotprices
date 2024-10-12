'use strict';

module.exports = {
  async getSpotPrice({ homey }) {
    console.log('API: Received request for spot price');
    try {
      const driver = homey.drivers.getDriver('cz-spot-prices');
      const devices = driver.getDevices();
      console.log('API: Retrieved devices:', devices.length);

      if (devices.length === 0) {
        throw new Error('No devices found');
      }

      const device = devices[0];  // Use the first device
      console.log('API: Using device:', device.getName());

      const currentSpotPrice = await device.getCapabilityValue('measure_current_spot_price_CZK');
      const currentSpotIndex = await device.getCapabilityValue('measure_current_spot_index');

      console.log('API: Retrieved capability values:', { currentSpotPrice, currentSpotIndex });

      const response = {
        currentSpotPrice,
        currentSpotIndex
      };

      console.log('API: Sending response:', response);
      return response;
    } catch (error) {
      console.error('API Error in getSpotPrice:', error);
      throw error;
    }
  }
};