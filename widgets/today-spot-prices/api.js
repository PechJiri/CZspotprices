'use strict';

let updateCallback = null;
let settingsChangeCallback = null;

module.exports = {
  async getHourlyPrices({ homey }) {
    try {
      const driver = homey.drivers.getDriver('cz-spot-prices');
      const devices = driver.getDevices();

      if (devices.length === 0) {
        throw new Error('No devices found');
      }

      const device = devices[0];  // Use the first device

      const hourlyPrices = [];
      const priceInKWh = device.getSetting('price_in_kwh') || false;
      
      for (let i = 0; i < 24; i++) {
        const price = await device.getCapabilityValue(`hour_price_CZK_${i}`);
        const index = await device.getCapabilityValue(`hour_price_index_${i}`);
        const isHighTariff = !(await device.getSetting(`hour_${i}`));
        hourlyPrices.push({ hour: i, price, index, isHighTariff });
      }

      const averagePrice = await device.getCapabilityValue('daily_average_price');
      const currentPrice = await device.getCapabilityValue('measure_current_spot_price_CZK');
      const currentIndex = await device.getCapabilityValue('measure_current_spot_index');

      return {
        hourlyPrices,
        averagePrice,
        currentPrice,
        currentIndex,
        priceInKWh
      };
    } catch (error) {
      console.error('API Error in getHourlyPrices:', error);
      throw error;
    }
  },

  async getSpotPrice({ homey }) {
    try {
      const driver = homey.drivers.getDriver('cz-spot-prices');
      const devices = driver.getDevices();

      if (devices.length === 0) {
        throw new Error('No devices found');
      }

      const device = devices[0];  // Use the first device

      const currentPrice = await device.getCapabilityValue('measure_current_spot_price_CZK');
      const currentIndex = await device.getCapabilityValue('measure_current_spot_index');
      const priceInKWh = device.getSetting('price_in_kwh') || false;

      return {
        currentPrice,
        currentIndex,
        priceInKWh
      };
    } catch (error) {
      console.error('API Error in getSpotPrice:', error);
      throw error;
    }
  },

  registerUpdateCallback({ homey }, callback) {
    updateCallback = callback;
    
    homey.on('spot_prices_updated', () => {
      if (updateCallback) {
        updateCallback();
      }
    });
  },

  registerSettingsChangeCallback({ homey }, callback) {
    settingsChangeCallback = callback;
    
    homey.on('settings_changed', () => {
      if (settingsChangeCallback) {
        settingsChangeCallback();
      }
    });
  }
};
