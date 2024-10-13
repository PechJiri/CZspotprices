'use strict';

let updateCallback = null;

module.exports = {
  async getHourlyPrices({ homey }) {
    console.log('API: Received request for hourly prices');
    try {
      const driver = homey.drivers.getDriver('cz-spot-prices');
      const devices = driver.getDevices();
      console.log('API: Retrieved devices:', devices.length);

      if (devices.length === 0) {
        throw new Error('No devices found');
      }

      const device = devices[0];  // Use the first device
      console.log('API: Using device:', device.getName());

      const hourlyPrices = [];
      
      for (let i = 0; i < 24; i++) {
        const price = await device.getCapabilityValue(`hour_price_CZK_${i}`);
        const index = await device.getCapabilityValue(`hour_price_index_${i}`);
        const isHighTariff = !(await device.getSetting(`hour_${i}`));
        hourlyPrices.push({ hour: i, price, index, isHighTariff });
      }

      console.log('API: Retrieved hourly prices:', hourlyPrices);

      const averagePrice = await device.getCapabilityValue('daily_average_price');
      console.log('API: Retrieved average price:', averagePrice);

      const currentPrice = await device.getCapabilityValue('measure_current_spot_price_CZK');
      const currentIndex = await device.getCapabilityValue('measure_current_spot_index');
      console.log('API: Retrieved current price:', currentPrice, 'and index:', currentIndex);

      const response = {
        hourlyPrices,
        averagePrice,
        currentPrice,
        currentIndex
      };

      console.log('API: Sending response:', response);
      return response;
    } catch (error) {
      console.error('API Error in getHourlyPrices:', error);
      throw error;
    }
  },

  async getSpotPrice({ homey }) {
    console.log('API: Received request for current spot price');
    try {
      const driver = homey.drivers.getDriver('cz-spot-prices');
      const devices = driver.getDevices();

      if (devices.length === 0) {
        throw new Error('No devices found');
      }

      const device = devices[0];  // Use the first device

      const currentPrice = await device.getCapabilityValue('measure_current_spot_price_CZK');
      const currentIndex = await device.getCapabilityValue('measure_current_spot_index');

      const response = {
        currentPrice,
        currentIndex
      };

      console.log('API: Sending response:', response);
      return response;
    } catch (error) {
      console.error('API Error in getSpotPrice:', error);
      throw error;
    }
  },

  // Nová metoda pro registraci callback funkce
  registerUpdateCallback({ homey }, callback) {
    console.log('API: Registering update callback');
    updateCallback = callback;
    
    // Registrujeme posluchač události
    homey.on('spot_prices_updated', () => {
      console.log('API: Received spot_prices_updated event');
      if (updateCallback) {
        console.log('API: Calling update callback');
        updateCallback();
      }
    });
  }
};