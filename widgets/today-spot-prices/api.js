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

      // Získání všech potřebných hodnot
      const hourlyPrices = [];
      const priceInKWh = device.getSetting('price_in_kwh') || false;
      
      for (let i = 0; i < 24; i++) {
        const price = await device.getCapabilityValue(`hour_price_CZK_${i}`);
        const index = await device.getCapabilityValue(`hour_price_index_${i}`);
        const isHighTariff = !(await device.getSetting(`hour_${i}`));
        hourlyPrices.push({ hour: i, price, index, isHighTariff });
      }

      // Získání všech dodatečných hodnot včetně nových max/min
      const [averagePrice, currentPrice, currentIndex, maxPrice, minPrice] = await Promise.all([
        device.getCapabilityValue('daily_average_price'),
        device.getCapabilityValue('measure_current_spot_price_CZK'),
        device.getCapabilityValue('measure_current_spot_index'),
        device.getCapabilityValue('measure_today_max_price'),
        device.getCapabilityValue('measure_today_min_price')
      ]);

      return {
        hourlyPrices,
        averagePrice,
        currentPrice,
        currentIndex,
        maxPrice,     // Nová hodnota
        minPrice,     // Nová hodnota
        priceInKWh
      };
    } catch (error) {
      console.error('API Error in getHourlyPrices:', error);
      throw error;
    }
  },

  // Zbytek kódu zůstává stejný
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