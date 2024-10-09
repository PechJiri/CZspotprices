const Homey = require('homey');

class SpotPriceAPI {
  constructor(homey) {
    this.homey = homey;
    this.baseUrl = 'https://spotovalektrina.cz/api/v1/price';
    this.apiCallFailTrigger = this.homey.flow.getDeviceTriggerCard('when-api-call-fails-trigger');
  }

  async logRequestAndResponse(url, response) {
    try {
      const responseBody = await response.clone().text();
      this.homey.log(`API Request URL: ${url}`);
      this.homey.log(`API Response Status: ${response.status}`);
      this.homey.log(`API Response Body: ${responseBody}`);
      return responseBody;
    } catch (error) {
      this.homey.error('Error logging request and response:', this.getErrorMessage(error));
      return null;
    }
  }

  async getCurrentPriceCZK(device) {
    const url = `${this.baseUrl}/get-actual-price-czk`;
    try {
      this.homey.log('Fetching current price from API');
      this.homey.log(`API Request URL: ${url}`);
      const response = await this.fetchUrl(url);
      const responseBody = await this.logRequestAndResponse(url, response);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}, body: ${responseBody}`);
      }

      const basePrice = parseFloat(responseBody);

      if (isNaN(basePrice)) {
        throw new Error('Invalid price data received from API');
      }

      const lowTariffPrice = device.getSetting('low_tariff_price') || 0;
      const highTariffPrice = device.getSetting('high_tariff_price') || 0;

      const currentHour = new Date().getHours();
      const isLowTariff = this.isLowTariff(currentHour, this.getTariffHours(device));

      const finalPrice = basePrice + (isLowTariff ? lowTariffPrice : highTariffPrice);
      this.homey.log(`Calculated final price for current hour (${currentHour}):`, finalPrice);
      return finalPrice;
    } catch (error) {
      this.homey.error('Detailed error in getCurrentPriceCZK:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
      this.handleApiError('Error fetching current spot price in CZK', error, device);
      throw error;
    }
  }

  async getDailyPrices(device) {
    const url = `${this.baseUrl}/get-prices-json`;
    try {
      this.homey.log('Fetching daily prices from API');
      this.homey.log(`API Request URL: ${url}`);
      const response = await this.fetchUrl(url);
      const responseBody = await this.logRequestAndResponse(url, response);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}, body: ${responseBody}`);
      }

      const hoursToday = JSON.parse(responseBody).hoursToday;

      if (!Array.isArray(hoursToday) || hoursToday.length !== 24) {
        throw new Error('Invalid daily prices data received from API');
      }

      const lowTariffPrice = device.getSetting('low_tariff_price') || 0;
      const highTariffPrice = device.getSetting('high_tariff_price') || 0;
      const tariffHours = this.getTariffHours(device);

      hoursToday.forEach(hourData => {
        const tariffPrice = this.isLowTariff(hourData.hour, tariffHours) ? lowTariffPrice : highTariffPrice;
        hourData.priceCZK += tariffPrice;
        this.homey.log(`Updated price for hour ${hourData.hour}:`, hourData.priceCZK);
      });

      this.setPriceIndexes(hoursToday);

      return hoursToday;
    } catch (error) {
      this.homey.error('Detailed error in getDailyPrices:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
      this.handleApiError('Error fetching daily prices', error, device);
      throw error;
    }
  }

  setPriceIndexes(hoursToday) {
    const sortedPrices = [...hoursToday].sort((a, b) => a.priceCZK - b.priceCZK);
    sortedPrices.forEach((hourData, index) => {
      if (index < 8) {
        hourData.level = 'low';
      } else if (index < 16) {
        hourData.level = 'medium';
      } else {
        hourData.level = 'high';
      }
      this.homey.log(`Set price index for hour ${hourData.hour}:`, hourData.level);
    });
  }

  async getCurrentPriceIndex(device) {
    try {
      const currentHour = new Date().getHours();
      const hoursToday = await this.getDailyPrices(device);
      const currentHourData = hoursToday.find(hourData => hourData.hour === currentHour);

      if (currentHourData) {
        this.homey.log(`Current price index for hour ${currentHour}:`, currentHourData.level);
        return currentHourData.level;
      } else {
        this.homey.warn(`No data found for current hour (${currentHour})`);
        return 'unknown';
      }
    } catch (error) {
      this.homey.error('Detailed error in getCurrentPriceIndex:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
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
      this.homey.error('Detailed error in updateCapabilities:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
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
      this.homey.log('Average daily price calculated:', averagePrice);
      await device.setCapabilityValue('daily_average_price', averagePrice);
    } catch (error) {
      this.homey.error('Detailed error in updateDailyAverageCapability:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
      this.handleApiError('Error updating daily average price capability', error, device);
    }
  }

  isLowTariff(hour, tariffHours) {
    return tariffHours.includes(hour);
  }

  getTariffHours(device) {
    const tariffHours = [];
    for (let i = 0; i < 24; i++) {
      if (device.getSetting(`hour_${i}`)) {
        tariffHours.push(i);
      }
    }
    return tariffHours;
  }

  async updateCurrentValues(device) {
    try {
      const currentPriceCZK = await this.getCurrentPriceCZK(device);
      const currentPriceIndex = await this.getCurrentPriceIndex(device);

      this.setCapability(device, 'measure_current_spot_price_CZK', currentPriceCZK);
      this.setCapability(device, 'measure_current_spot_index', currentPriceIndex);
    } catch (error) {
      this.homey.error('Detailed error in updateCurrentValues:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
      this.handleApiError('Error updating current values', error, device);
    }
  }

  setCapability(device, capability, value) {
    if (value !== undefined && value !== null) {
      device.setCapabilityValue(capability, value).catch(err => {
        this.homey.error(`Error setting capability ${capability}:`, this.getErrorMessage(err));
      });
    } else {
      this.homey.warn(`Capability ${capability} value is invalid:`, value);
    }
  }

  async fetchUrl(url) {
    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
    return fetch(url);
  }

  getErrorMessage(error) {
    if (typeof error === 'string') {
      return error;
    }
    if (error instanceof Error) {
      return `${error.name}: ${error.message}`;
    }
    if (typeof error === 'object' && error !== null) {
      return JSON.stringify(error);
    }
    return 'Unknown error';
  }

  handleApiError(context, error, device) {
    let errorMessage = this.getErrorMessage(error);
    if (error.message && error.message.includes('body:')) {
      errorMessage = error.message.split('body:')[1].trim();
    }

    // Kontrola, zda errorMessage je string, pokud ne, převede ho na string
    if (typeof errorMessage !== 'string') {
      errorMessage = JSON.stringify(errorMessage);
    }

    this.homey.error(`${context}:`, errorMessage);
    this.homey.error('Detailed error object:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
    this.triggerApiCallFail(errorMessage, device);
  }

  triggerApiCallFail(errorMessage, device) {
    this.homey.log('Triggering API call fail with error message:', errorMessage);
    
    if (!device) {
      this.homey.error('Device is undefined in triggerApiCallFail');
      return;
    }

    // Kontrola, zda errorMessage je string, pokud ne, převede ho na string
    if (typeof errorMessage !== 'string') {
      errorMessage = JSON.stringify(errorMessage);
    }

    const tokens = { error_message: errorMessage };
    this.homey.log('Trigger tokens:', tokens);

    this.apiCallFailTrigger.trigger(tokens)
      .then(() => this.homey.log('API call fail trigger successful'))
      .catch(err => {
        this.homey.error('Error triggering API call fail flow:', this.getErrorMessage(err));
        this.homey.error('Trigger details:', {
          device: device ? device.getName() : 'undefined',
          errorMessage: errorMessage,
          tokens: tokens
        });
      });
  }
}

module.exports = SpotPriceAPI;
