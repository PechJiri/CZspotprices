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

    this.homey.log(
      `Current time info: hour: ${hour}, systemHour: ${new Date().getHours()}, timezone: ${this.homeyTimezone}`
    );

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
    this.homey.error(`${context}:`, errorMessage);
    
    // Použití nové metody z device
    if (device && typeof device.triggerAPIFailure === 'function') {
        device.triggerAPIFailure({
            primaryAPI: errorMessage,
            backupAPI: '',
            willRetry: false,
            maxRetriesReached: true
        });
    }
}

  // Nové metody využívající PriceCalculator
  async getDailyPrices(device) {
    if (!device || typeof device.triggerAPIFailure !== 'function') {
        throw new Error('Neplatná device instance pro getDailyPrices');
    }

    const timeoutMs = 10000;
    let spotElektrinaError = null;
    let oteError = null;

    try {
        // Nastavení příznaku pokusu o primární API
        await device.setCapabilityValue('primary_api_fail', true);
        
        this.homey.log('Pokus o získání dat z primárního API (spotovaelektrina.cz)');
        
        // Pokus o získání dat z primárního API
        const data = await this._fetchFromPrimaryAPI(timeoutMs);
        
        // Validace dat z primárního API
        if (!this.priceCalculator.validatePriceData(data.hoursToday)) {
            throw new Error('Neplatný formát dat z primárního API');
        }

        // Úspěch - resetujeme příznak selhání
        await device.setCapabilityValue('primary_api_fail', false);
        this.homey.log('Data úspěšně získána z primárního API');
        
        return data.hoursToday;

    } catch (error) {
        // Zaznamenání chyby primárního API
        spotElektrinaError = error;
        this.homey.error('Chyba primárního API:', this.getErrorMessage(error));
        
        // Nastavení příznaku selhání primárního API
        await device.setCapabilityValue('primary_api_fail', false);

        try {
            // Pokus o získání záložních dat
            this.homey.log('Pokus o získání dat ze záložního API (ote.cr)');
            const backupData = await this.getBackupDailyPrices(device);

            // Validace záložních dat
            if (!this.priceCalculator.validatePriceData(backupData)) {
                throw new Error('Neplatný formát dat ze záložního API');
            }

            // Úspěšné získání záložních dat - spustíme trigger s informací o záloze
            await device.triggerAPIFailure({
                primaryAPI: this.getErrorMessage(spotElektrinaError),
                backupAPI: 'Záložní API úspěšné',
                willRetry: true,
                retryCount: 0,
                nextRetryIn: '60'
            });

            this.homey.log('Data úspěšně získána ze záložního API');
            return backupData;

        } catch (backupError) {
            // Selhání obou API
            oteError = backupError;
            this.homey.error('Selhání záložního API:', this.getErrorMessage(backupError));

            // Spuštění triggeru pro selhání obou API
            await device.triggerAPIFailure({
                primaryAPI: this.getErrorMessage(spotElektrinaError),
                backupAPI: this.getErrorMessage(oteError),
                willRetry: false,
                maxRetriesReached: true
            });

            throw new Error(`Selhání obou API: spotovaelektrina.cz: ${this.getErrorMessage(spotElektrinaError)}, ote.cr: ${this.getErrorMessage(oteError)}`);
        }
    }
}

// Pomocná metoda pro volání primárního API
async _fetchFromPrimaryAPI(timeoutMs) {
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
            throw new Error('Neplatná struktura dat z API');
        }

        return data;

    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error('Timeout při volání API');
        }
        throw error;
    } finally {
        clearTimeout(timeout);
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