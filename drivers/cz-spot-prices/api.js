const Homey = require('homey');

class SpotPriceAPI {
  constructor(homey) {
    this.homey = homey;
    this.baseUrl = 'https://spotovaelektrina.cz/api/v1/price';
    this.apiCallFailTrigger = this.homey.flow.getDeviceTriggerCard('when-api-call-fails-trigger');
  }

  async getCurrentPriceCZK(device) {
    const url = `${this.baseUrl}/get-actual-price-czk`;
    try {
      const response = await this.fetchUrl(url);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const basePrice = parseFloat(await response.text());
      if (isNaN(basePrice)) {
        throw new Error('Invalid price data received from API');
      }

      const lowTariffPrice = device.getSetting('low_tariff_price') || 0;
      const highTariffPrice = device.getSetting('high_tariff_price') || 0;
      const currentHour = new Date().getHours();
      const isLowTariff = this.isLowTariff(currentHour, this.getTariffHours(device));
      const finalPrice = basePrice + (isLowTariff ? lowTariffPrice : highTariffPrice);

      return finalPrice;
    } catch (error) {
      this.handleApiError('Error fetching current spot price in CZK', error, device);
      throw error;
    }
  }

  async getDailyPrices(device) {
    const url = `${this.baseUrl}/get-prices-json`;
    try {
      const response = await this.fetchUrl(url);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const hoursToday = JSON.parse(await response.text()).hoursToday;
      if (!Array.isArray(hoursToday) || hoursToday.length !== 24) {
        throw new Error('Invalid daily prices data received from API');
      }

      const lowTariffPrice = device.getSetting('low_tariff_price') || 0;
      const highTariffPrice = device.getSetting('high_tariff_price') || 0;
      const tariffHours = this.getTariffHours(device);

      hoursToday.forEach(hourData => {
        const tariffPrice = this.isLowTariff(hourData.hour, tariffHours) ? lowTariffPrice : highTariffPrice;
        hourData.priceCZK += tariffPrice;
      });

      this.setPriceIndexes(hoursToday);
      return hoursToday;
    } catch (error) {
      this.handleApiError('Error fetching daily prices', error, device);
      throw error;
    }
  }

  setPriceIndexes(hoursToday) {
    const sortedPrices = [...hoursToday].sort((a, b) => a.priceCZK - b.priceCZK);
    sortedPrices.forEach((hourData, index) => {
      if (index < 8) hourData.level = 'low';
      else if (index < 16) hourData.level = 'medium';
      else hourData.level = 'high';
    });
  }

  async getCurrentPriceIndex(device) {
    try {
      const currentHour = new Date().getHours();
      const hoursToday = await this.getDailyPrices(device);
      const currentHourData = hoursToday.find(hourData => hourData.hour === currentHour);

      return currentHourData ? currentHourData.level : 'unknown';
    } catch (error) {
      this.handleApiError('Error fetching current price index', error, device);
      throw error;
    }
  }

  async updateCapabilities(device) {
    try {
      const hoursToday = await this.getDailyPrices(device);
      
      hoursToday.forEach(hourData => {
        this.setCapability(device, `hour_price_CZK_${hourData.hour}`, hourData.priceCZK);
        this.setCapability(device, `hour_price_index_${hourData.hour}`, hourData.level);
      });

      await this.updateDailyAverageCapability(device);
    } catch (error) {
      this.handleApiError('Error updating capabilities', error, device);
    }
  }

  async updateDailyAverageCapability(device) {
    try {
      let totalPrice = 0;
      let count = 0;

      for (let i = 0; i < 24; i++) {
        const price = await device.getCapabilityValue(`hour_price_CZK_${i}`);
        if (price !== null && price !== undefined) {
          totalPrice += price;
          count++;
        }
      }

      if (count === 0) {
        throw new Error('No valid hourly prices available to calculate the average.');
      }

      const averagePrice = totalPrice / count;
      await device.setCapabilityValue('daily_average_price', averagePrice);
    } catch (error) {
      this.handleApiError('Error updating daily average price capability', error, device);
    }
  }

  isLowTariff(hour, tariffHours) {
    return tariffHours.includes(hour);
  }

  getTariffHours(device) {
    return Array.from({ length: 24 }, (_, i) => i).filter(i => device.getSetting(`hour_${i}`));
  }

  async updateCurrentValues(device) {
    try {
      const currentPriceCZK = await this.getCurrentPriceCZK(device);
      const currentPriceIndex = await this.getCurrentPriceIndex(device);

      this.setCapability(device, 'measure_current_spot_price_CZK', currentPriceCZK);
      this.setCapability(device, 'measure_current_spot_index', currentPriceIndex);
    } catch (error) {
      this.handleApiError('Error updating current values', error, device);
    }
  }

  setCapability(device, capability, value) {
    if (value !== undefined && value !== null) {
      device.setCapabilityValue(capability, value).catch(err => {
        this.homey.error(`Error setting capability ${capability}:`, this.getErrorMessage(err));
      });
    }
  }

  async fetchUrl(url) {
    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
    return fetch(url);
  }

  getErrorMessage(error) {
    if (typeof error === 'string') return error;
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    if (typeof error === 'object' && error !== null) return JSON.stringify(error);
    return 'Unknown error';
  }

  handleApiError(context, error, device) {
    let errorMessage = this.getErrorMessage(error);
    if (error.message && error.message.includes('body:')) {
      errorMessage = error.message.split('body:')[1].trim();
    }
    errorMessage = typeof errorMessage === 'string' ? errorMessage : JSON.stringify(errorMessage);

    this.homey.error(`${context}:`, errorMessage);
    this.triggerApiCallFail(errorMessage, device);
  }

  triggerApiCallFail(errorMessage, device) {
    if (!device) {
      this.homey.error('Device is undefined in triggerApiCallFail');
      return;
    }

    errorMessage = typeof errorMessage === 'string' ? errorMessage : JSON.stringify(errorMessage);
    const tokens = { error_message: errorMessage };

    this.apiCallFailTrigger.trigger(tokens)
      .catch(err => {
        this.homey.error('Error triggering API call fail flow:', this.getErrorMessage(err));
      });
  }
}

module.exports = SpotPriceAPI;