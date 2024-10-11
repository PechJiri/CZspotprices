'use strict';

module.exports = {
  async getHourlyPrices({ homey }) {
    console.log('API: Received request for hourly prices');
    try {
      const driver = homey.drivers.getDriver('cz-spot-prices');
      const devices = await driver.getDevices();
      console.log('API: Retrieved devices:', devices.length);

      if (devices.length === 0) {
        throw new Error('No devices found');
      }

      const device = devices[0];  // Use the first device
      console.log('API: Using device:', device.getName());

      const hourlyPrices = [];
      
      for (let i = 0; i < 24; i++) {
        const price = await device.getCapabilityValue(`hour_price_CZK_${i}`);
        const isHighTariff = !(await device.getSetting(`hour_${i}`));
        hourlyPrices.push({ hour: i, price, isHighTariff });
      }

      console.log('API: Retrieved hourly prices:', hourlyPrices);

      const averagePrice = await device.getCapabilityValue('daily_average_price');
      console.log('API: Retrieved average price:', averagePrice);

      const response = {
        hourlyPrices,
        averagePrice
      };

      console.log('API: Sending response:', response);
      return response;
    } catch (error) {
      console.error('API Error in getHourlyPrices:', error);
      throw error;
    }
  }
};