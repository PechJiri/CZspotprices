'use strict';

const Homey = require('homey');
const axios = require('axios');
const PriceCalculator = require('../../helpers/PriceCalculator');

class SpotPriceAPI {
  constructor(homey) {
    this.homey = homey;
    this.baseUrl = 'https://spotovaelektrina.cz/api/v1/price';
    this.backupUrl = 'https://www.ote-cr.cz/cs/kratkodobe-trhy/elektrina/denni-trh/@@chart-data';
    this.exchangeRateUrl = 'https://data.kurzy.cz/json/meny/b[6].json';
    this.exchangeRate = 25.25;
    this.homeyTimezone = this.homey.clock.getTimezone();
    this.apiCallFailTrigger = this.homey.flow.getDeviceTriggerCard('when-api-call-fails-trigger');
    this.priceCalculator = new PriceCalculator(this.homey);
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
    
    // Získání hodiny v dané časové zóně
    let hour = parseInt(now.toLocaleString('en-US', { 
        ...options, 
        hour: 'numeric', 
        hour12: false 
    }));

    // Konverze 24 na 0
    if (hour === 24) hour = 0;
    
    // Validace pro jistotu
    if (hour < 0 || hour > 23) {
        this.homey.error('Neplatná hodina v getCurrentTimeInfo:', hour);
        // V případě chyby vrátíme současnou hodinu
        hour = new Date().getHours();
    }

    this.homey.log('Current time info:', {
        hour,
        timezone: this.homeyTimezone,
        originalDate: now.toLocaleString('en-US', options)
    });

    return {
        hour,
        date: now.toLocaleString('en-US', { 
            ...options, 
            year: 'numeric', 
            month: '2-digit', 
            day: '2-digit' 
        }).split('/').reverse().join('')
    };
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

  // Nové metody využívající PriceCalculator
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

        // Validace dat pomocí PriceCalculatoru
        if (!this.priceCalculator.validatePriceData(data.hoursToday)) {
          throw new Error('Invalid price data format');
        }

        return data.hoursToday;

      } catch (error) {
        throw error;
      }
    } catch (error) {
      await device.setCapabilityValue('primary_api_fail', false);
      spotElektrinaError = error;
      try {
        const backupData = await this.getBackupDailyPrices(device);
        // Validace záložních dat
        if (!this.priceCalculator.validatePriceData(backupData)) {
          throw new Error('Invalid backup price data format');
        }
        return backupData;
      } catch (backupError) {
        oteError = backupError;
        const combinedError = `spotovaelektrina: ${this.getErrorMessage(spotElektrinaError)}, ote.cr: ${this.getErrorMessage(oteError)}`;
        this.handleApiError('Error fetching daily prices from both APIs', new Error(combinedError), device, 'hourly');
        throw new Error(combinedError);
      }
    }
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

      // Validace dat pomocí PriceCalculatoru
      if (!this.priceCalculator.validatePriceData(hoursToday)) {
        throw new Error('Invalid backup price data format');
      }

      return hoursToday;
    } catch (error) {
      this.homey.error('Error fetching backup daily prices:', error);
      throw error;
    }
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

      // Příprava dat pro výpočet cen
      const settings = device.getSettings();
      const processedPrices = dailyPrices.map(priceData => ({
        hour: priceData.hour,
        priceCZK: this.priceCalculator.addDistributionPrice(
          priceData.priceCZK,
          settings,
          priceData.hour
        )
      }));
  
      // Výpočet indexů pomocí PriceCalculatoru
      const pricesWithIndexes = this.priceCalculator.setPriceIndexes(
        processedPrices,
        device.getLowIndexHours(),
        device.getHighIndexHours()
      );
  
      const timeInfo = this.getCurrentTimeInfo();
      let currentHour = timeInfo.hour === 24 ? 0 : timeInfo.hour;
  
      // Aktualizace hodnot v zařízení
      for (const { hour, priceCZK, level } of pricesWithIndexes) {
        const convertedPrice = this.priceCalculator.convertPrice(
          priceCZK,
          device.getPriceInKWh()
        );
        await device.setCapabilityValue(`hour_price_CZK_${hour}`, convertedPrice);
        await device.setCapabilityValue(`hour_price_index_${hour}`, level);
      }
  
      const currentHourData = pricesWithIndexes.find(price => price.hour === currentHour);
      if (currentHourData) {
        const convertedCurrentPrice = this.priceCalculator.convertPrice(
          currentHourData.priceCZK,
          device.getPriceInKWh()
        );
        await device.setCapabilityValue('measure_current_spot_price_CZK', convertedCurrentPrice);
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