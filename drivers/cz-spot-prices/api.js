'use strict';

const Homey = require('homey');
const axios = require('axios');

class SpotPriceAPI {
  constructor(homey) {
    this.homey = homey;
    this.baseUrl = 'https://spotovaelektrina.cz/api/v1/price';
    this.backupUrl = 'https://www.ote-cr.cz/cs/kratkodobe-trhy/elektrina/denni-trh/@@chart-data';
    this.exchangeRateUrl = 'https://data.kurzy.cz/json/meny/b[6].json';
    this.exchangeRate = 25.25; // Výchozí kurz EUR/CZK, aktualizuje se při inicializaci
    this.homeyTimezone = this.homey.clock.getTimezone();
    this.apiCallFailTrigger = this.homey.flow.getDeviceTriggerCard('when-api-call-fails-trigger');

    // Inicializace kurzu při startu
    this.updateExchangeRate().catch(err => {
      this.homey.error('Failed to initialize exchange rate:', err);
    });
  }

  async updateExchangeRate() {
    try {
      this.homey.log('Fetching exchange rate from:', this.exchangeRateUrl);
      const response = await axios.get(this.exchangeRateUrl);

      const data = response.data;
      if (data && data.kurzy && data.kurzy.EUR) {
        this.exchangeRate = data.kurzy.EUR.dev_stred;
        this.homey.log(`Exchange rate updated to: ${this.exchangeRate}`);
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
      this.homey.log('Fetching backup daily prices from:', this.backupUrl);
      await this.updateExchangeRate();

      const timeInfo = this.getCurrentTimeInfo();
      const response = await axios.get(this.backupUrl, {
        params: { report_date: timeInfo.date }
      });
      this.homey.log('Backup daily prices raw response:', response.data);

      const data = response.data;
      const dataLine = data?.data?.dataLine.find(line => line.title === "Cena (EUR/MWh)");

      if (!dataLine || !Array.isArray(dataLine.point)) {
        throw new Error('Invalid data structure from backup API');
      }

      const hoursToday = dataLine.point.slice(0, 24).map((point, index) => {
        let priceCZK = point.y * this.exchangeRate;
        return { hour: index, priceCZK: parseFloat(priceCZK.toFixed(2)) };
      });

      this.homey.log('Formatted hourly prices in CZK:', hoursToday);
      return hoursToday;

    } catch (error) {
      this.homey.error('Error fetching backup daily prices:', error);
      throw error;
    }
  }

  async getDailyPrices(device) {
    let spotElektrinaError = null;
    let oteError = null;
    const timeoutMs = 10000;  // Timeout pro API volání v milisekundách (5 vteřin)
  
    try {
      const url = `${this.baseUrl}/get-prices-json`;
      this.homey.log('Calling getDailyPrices API with timeout:', url, `Timeout: ${timeoutMs}ms`);
  
      // Nastavení timeoutu pro fetch volání
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
  
      try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
  
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
  
        const data = await response.json();
        this.homey.log('Received daily prices data:', data);
  
        if (!Array.isArray(data.hoursToday) || data.hoursToday.length !== 24) {
          throw new Error('Invalid data structure');
        }
  
        this.homey.log('Daily prices:', data.hoursToday);
        return data.hoursToday;
  
      } catch (error) {
        if (error.name === 'AbortError') {
          this.homey.log(`API call to ${url} timed out after ${timeoutMs}ms`);
        }
        throw error; // Přeposlání chyby k ošetření vnější catch
      }
    } catch (error) {
      spotElektrinaError = error;
      try {
        this.homey.log('Calling backup API due to primary API failure');
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
    const price = basePrice + (isLowTariff ? lowTariffPrice : highTariffPrice);
    this.homey.log(`Calculated distribution price for hour ${timeInfo.hour}:`, price);
    return price;
  }

  isLowTariff(hour, tariffHours) {
    return tariffHours.includes(hour);
  }

  getTariffHours(device) {
    return Array.from({ length: 24 }, (_, i) => i).filter(i => device.getSetting(`hour_${i}`));
  }

  async fetchUrl(url) {
    this.homey.log('Fetching URL:', url);
    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
    const response = await fetch(url);
    this.homey.log('Fetched URL response:', response.status);
    return response;
  }

  getErrorMessage(error) {
    if (typeof error === 'string') return error;
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    if (typeof error === 'object' && error !== null) return JSON.stringify(error);
    return 'Unknown error';
  }

  handleApiError(context, error, device, type) {
    let errorMessage = this.getErrorMessage(error);
    if (error.message && error.message.includes('body:')) {
      errorMessage = error.message.split('body:')[1].trim();
    }
    errorMessage = typeof errorMessage === 'string' ? errorMessage : JSON.stringify(errorMessage);

    this.homey.error(`${context}:`, errorMessage);
    this.triggerApiCallFail(errorMessage, device, type);
  }

  triggerApiCallFail(errorMessage, device, type) {
    if (!device) {
      this.homey.error('Device is undefined in triggerApiCallFail');
      return;
    }

    errorMessage = typeof errorMessage === 'string' ? errorMessage : JSON.stringify(errorMessage);
    const tokens = { error_message: errorMessage, type: type };

    this.apiCallFailTrigger.trigger(device, tokens)
      .catch(err => {
        this.homey.error('Error triggering API call fail flow:', this.getErrorMessage(err));
      });
  }

  async updateCurrentValues(device) {
    try {
      // Získání aktuálního času včetně časové zóny
      const timeInfo = this.getCurrentTimeInfo();
      this.homey.log(`updateCurrentValues: Získaná aktuální hodina je ${timeInfo.hour}`);
      
      let dailyPrices = [];
  
      // Pokus o načtení aktuálních cen z primárního API
      try {
        const response = await axios.get(`${this.baseUrl}/get-daily-prices`, { timeout: 5000 });
        if (response.data && Array.isArray(response.data.hoursToday)) {
          dailyPrices = response.data.hoursToday.map((priceData, hour) => ({
            hour,
            priceCZK: this.addDistributionPrice(device, priceData.price), // Přidání distribuce
          }));
          this.homey.log(`Primary API daily prices loaded:`, dailyPrices);
        } else {
          throw new Error('Invalid data from primary API');
        }
      } catch (primaryError) {
        this.homey.log('Primary API call failed, trying backup API:', primaryError.message);
        
        // Záložní API
        try {
          const backupPrices = await this.getBackupDailyPrices(device);
          dailyPrices = backupPrices.map(priceData => ({
            hour: priceData.hour,
            priceCZK: this.addDistributionPrice(device, priceData.priceCZK), // Přidání distribuce
          }));
          this.homey.log(`Backup API daily prices loaded:`, dailyPrices);
        } catch (backupError) {
          throw new Error(`Backup API also failed: ${backupError.message}`);
        }
      }
  
      // Přepočítání indexů pomocí metody `setPriceIndexes` na `device`
      const pricesWithIndexes = device.setPriceIndexes(dailyPrices);
      for (const { hour, priceCZK, level } of pricesWithIndexes) {
        await device.setCapabilityValue(`hour_price_CZK_${hour}`, priceCZK);
        await device.setCapabilityValue(`hour_price_index_${hour}`, level);
      }
  
      // Aktualizace aktuální ceny a indexu
      const currentHourData = pricesWithIndexes.find(price => price.hour === timeInfo.hour);
      if (currentHourData) {
        await device.setCapabilityValue('measure_current_spot_price_CZK', currentHourData.priceCZK);
        await device.setCapabilityValue('measure_current_spot_index', currentHourData.level);
      }
  
      // Aktualizace denní průměrné ceny
      await device.updateDailyAverageCapability();
  
      this.homey.log(`Updated daily prices and indexes with current price: ${currentHourData.priceCZK} CZK and index: ${currentHourData.level}`);
      await this.homey.emit('spot_prices_updated');
    } catch (error) {
      this.handleApiError('Error updating current values', error, device, 'current');
    }
  }  
}

module.exports = SpotPriceAPI;
