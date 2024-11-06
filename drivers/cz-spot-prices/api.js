'use strict';

const Homey = require('homey');
const axios = require('axios');

class SpotPriceAPI {
  constructor(homey) {
    this.homey = homey;
    this.baseUrl = 'https://spotovaelektrina.cz/api/v1/price';
    this.backupUrl = 'https://www.ote-cr.cz/cs/kratkodobe-trhy/elektrina/denni-trh/@@chart-data';
    this.exchangeRateUrl = 'https://data.kurzy.cz/json/meny/b[6].json';
    this.exchangeRate = 25.25;
    this.homeyTimezone = this.homey.clock.getTimezone();
    this.apiCallFailTrigger = this.homey.flow.getDeviceTriggerCard('when-api-call-fails-trigger');
  }

  async updateExchangeRate() {
    try {
      const response = await axios.get(this.exchangeRateUrl);
      const data = response.data;
      if (data && data.kurzy && data.kurzy.EUR) {
        this.exchangeRate = data.kurzy.EUR.dev_stred;
      }
    } catch (error) {
      this.homey.error('Failed to update exchange rate:', error);
    }
  }

  getCurrentTimeInfo() {
    const now = new Date();
    const options = { timeZone: this.homeyTimezone };
    return {
      hour: parseInt(now.toLocaleString('en-US', { ...options, hour: 'numeric', hour12: false })),
      date: now.toLocaleString('en-US', { ...options, year: 'numeric', month: '2-digit', day: '2-digit' }).split('/').reverse().join('')
    };
  }

  async getBackupDailyPrices(device) {
    try {
      await this.updateExchangeRate();
      const timeInfo = this.getCurrentTimeInfo();
      const response = await axios.get(this.backupUrl, {
        params: { report_date: timeInfo.date }
      });

      const data = response.data;
      const dataLine = data?.data?.dataLine.find(line => line.title === "Cena (EUR/MWh)");

      if (!dataLine || !Array.isArray(dataLine.point)) {
        throw new Error('Invalid data structure from backup API');
      }

      const hoursToday = dataLine.point.slice(0, 24).map((point, index) => {
        let priceCZK = point.y * this.exchangeRate;
        return { hour: index, priceCZK: parseFloat(priceCZK.toFixed(2)) };
      });

      return hoursToday;
    } catch (error) {
      this.homey.error('Error fetching backup daily prices:', error);
      throw error;
    }
  }

  async getDailyPrices(device) {
    let spotElektrinaError = null;
    let oteError = null;
    const timeoutMs = 10000;

    await device.setCapabilityValue('primary_api_fail', true);

    try {
      const url = `${this.baseUrl}/get-prices-json`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        if (!Array.isArray(data.hoursToday) || data.hoursToday.length !== 24) {
          throw new Error('Invalid data structure');
        }

        return data.hoursToday;

      } catch (error) {
        throw error;
      }
    } catch (error) {
      await device.setCapabilityValue('primary_api_fail', false);
      spotElektrinaError = error;
      try {
        return await this.getBackupDailyPrices(device);
      } catch (backupError) {
        oteError = backupError;
        const combinedError = `spotovaelektrina: ${this.getErrorMessage(spotElektrinaError)}, ote.cr: ${this.getErrorMessage(oteError)}`;
        this.handleApiError('Error fetching daily prices from both APIs', new Error(combinedError), device, 'hourly');
        throw new Error(combinedError);
      }
    }
  }

  addDistributionPrice(device, basePrice) {
    const timeInfo = this.getCurrentTimeInfo();
    const lowTariffPrice = device.getSetting('low_tariff_price') || 0;
    const highTariffPrice = device.getSetting('high_tariff_price') || 0;
    const tariffHours = this.getTariffHours(device);
    const isLowTariff = this.isLowTariff(timeInfo.hour, tariffHours);
    return basePrice + (isLowTariff ? lowTariffPrice : highTariffPrice);
  }

  isLowTariff(hour, tariffHours) {
    return tariffHours.includes(hour);
  }

  getTariffHours(device) {
    return Array.from({ length: 24 }, (_, i) => i).filter(i => device.getSetting(`hour_${i}`));
  }

  async fetchUrl(url) {
    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
    const response = await fetch(url);
    return response;
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

    const tokens = {
      error_message: errorMessage,
      will_retry: true,
      retry_count: 0,
      next_retry: 'Immediate',
      max_retries_reached: false
    };

    this.apiCallFailTrigger.trigger(device, tokens)
      .catch(err => {
        this.homey.error('Error triggering API call fail flow:', this.getErrorMessage(err));
      });
  }

  async updateCurrentValues(device) {
    try {
      this.homey.log('=== AKTUALIZACE SOUČASNÝCH HODNOT ===');
      let dailyPrices = [];
  
      try {
        this.homey.log('Pokus o získání dat z primárního API...');
        dailyPrices = await this.getDailyPrices(device);
        this.homey.log('Data úspěšně získána z primárního API');
      } catch (error) {
        this.homey.error('Chyba při získávání dat:', error);
        throw error;
      }
  
      this.homey.log('Data pro aktualizaci:', dailyPrices);
  
      const pricesWithIndexes = device.setPriceIndexes(dailyPrices.map(priceData => ({
        hour: priceData.hour,
        priceCZK: this.addDistributionPrice(device, priceData.priceCZK)
      })));
  
      const timeInfo = this.getCurrentTimeInfo();
      let currentHour = timeInfo.hour;
      currentHour = (currentHour === 24) ? 0 : currentHour;
  
      for (const { hour, priceCZK, level } of pricesWithIndexes) {
        await device.setCapabilityValue(`hour_price_CZK_${hour}`, priceCZK);
        await device.setCapabilityValue(`hour_price_index_${hour}`, level);
      }
  
      const currentHourData = pricesWithIndexes.find(price => price.hour === currentHour);
      if (currentHourData) {
        await device.setCapabilityValue('measure_current_spot_price_CZK', currentHourData.priceCZK);
        await device.setCapabilityValue('measure_current_spot_index', currentHourData.level);
      }
  
      await device.updateDailyAverageCapability();
      await this.homey.emit('spot_prices_updated');
  
    } catch (error) {
      this.handleApiError('Error updating current values', error, device);
    }
  }
}

module.exports = SpotPriceAPI;