const Homey = require('homey');

class SpotPriceAPI {
  constructor(homey) {
    this.homey = homey;
    this.baseUrl = 'https://spotovaelektrina.cz/api/v1/price';
  }

  // Pomocná funkce pro logování requestu a response
  async logRequestAndResponse(url, response) {
    const responseBody = await response.clone().text();
    this.homey.log(`Request URL: ${url}`);
    this.homey.log(`Response Status: ${response.status}`);
    this.homey.log(`Response Body: ${responseBody}`);
  }

  // Funkce pro získání aktuální ceny v CZK
  async getCurrentPriceCZK(device) {
    const url = `${this.baseUrl}/get-actual-price-czk`;
    try {
      const response = await this.fetchUrl(url);
      await this.logRequestAndResponse(url, response);

      const responseText = await response.text();
      const basePrice = parseFloat(responseText); // Převedeme text na číslo

      // Získání cen za distribuci
      const lowTariffPrice = device.getSetting('low_tariff_price') || 0;
      const highTariffPrice = device.getSetting('high_tariff_price') || 0;

      // Zjištění, zda je aktuální hodina v nízkém tarifu
      const currentHour = new Date().getHours();
      const isLowTariff = this.isLowTariff(currentHour, this.getTariffHours(device));

      // Připočítání příslušného poplatku
      const finalPrice = basePrice + (isLowTariff ? lowTariffPrice : highTariffPrice);
      this.homey.log(`Calculated final price for current hour (${currentHour}):`, finalPrice);
      return finalPrice;
    } catch (error) {
      this.homey.error('Error fetching current spot price in CZK:', error);
      throw error;
    }
  }

  // Funkce pro získání cen a indexů pro jednotlivé hodiny dne
  async getDailyPrices(device) {
    const url = `${this.baseUrl}/get-prices-json`;
    try {
      const response = await this.fetchUrl(url);
      await this.logRequestAndResponse(url, response);

      const responseText = await response.text();
      const hoursToday = JSON.parse(responseText).hoursToday;

      const lowTariffPrice = device.getSetting('low_tariff_price') || 0;
      const highTariffPrice = device.getSetting('high_tariff_price') || 0;
      const tariffHours = this.getTariffHours(device);

      // Připočítání příslušného poplatku k cenám pro jednotlivé hodiny
      hoursToday.forEach(hourData => {
        const tariffPrice = this.isLowTariff(hourData.hour, tariffHours) ? lowTariffPrice : highTariffPrice;
        hourData.priceCZK += tariffPrice;
        this.homey.log(`Updated price for hour ${hourData.hour}:`, hourData.priceCZK);
      });

      // Seřazení hodin podle ceny pro nastavení indexů
      const sortedPrices = [...hoursToday].sort((a, b) => a.priceCZK - b.priceCZK);

      // Nastavení indexů cen podle seřazených cen
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

      return hoursToday;
    } catch (error) {
      this.homey.error('Error fetching daily prices:', error);
      throw error;
    }
  }

  // Funkce pro získání aktuálního cenového indexu pro danou hodinu
  async getCurrentPriceIndex(device) {
    try {
      // Získání aktuální hodiny
      const currentHour = new Date().getHours();

      // Získání cen a indexů pro celý den
      const hoursToday = await this.getDailyPrices(device);

      // Najít index pro aktuální hodinu
      const currentHourData = hoursToday.find(hourData => hourData.hour === currentHour);

      if (currentHourData) {
        return currentHourData.level;
      } else {
        this.homey.log(`No data found for current hour (${currentHour})`);
        return 'unknown'; // Pokud není nalezena aktuální hodina, vrátíme 'unknown'
      }
    } catch (error) {
      this.homey.error('Error fetching current price index:', error);
      throw error;
    }
  }

  // Funkce pro aktualizaci capability s připočítáním distribuce
  async updateCapabilities(device) {
    try {
      const hoursToday = await this.getDailyPrices(device);
      
      hoursToday.forEach(hourData => {
        // Nastavení capability hodnot pro každou hodinu
        this.setCapability(device, `hour_price_CZK_${hourData.hour}`, hourData.priceCZK);
        this.setCapability(device, `hour_price_index_${hourData.hour}`, hourData.level);
      });

      // Aktualizace průměrné denní ceny
      await this.updateDailyAverageCapability(device);
    } catch (error) {
      this.homey.error('Error updating capabilities:', error);
    }
  }

  // Funkce pro výpočet a aktualizaci průměrné denní ceny
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
      this.homey.error('Error updating daily average price capability:', error);
    }
  }

  // Pomocná funkce pro kontrolu, zda je daná hodina v nízkém tarifu
  isLowTariff(hour, tariffHours) {
    return tariffHours.includes(hour);
  }

  // Pomocná funkce pro získání hodin nízkého tarifu z nastavení zařízení
  getTariffHours(device) {
    const tariffHours = [];
    for (let i = 0; i < 24; i++) {
      if (device.getSetting(`hour_${i}`)) {
        tariffHours.push(i);
      }
    }
    return tariffHours;
  }

  // Funkce pro aktualizaci aktuálních hodnot
  async updateCurrentValues(device) {
    try {
      const currentPriceCZK = await this.getCurrentPriceCZK(device);
      const currentPriceIndex = await this.getCurrentPriceIndex(device);

      this.setCapability(device, 'measure_current_spot_price_CZK', currentPriceCZK);
      this.setCapability(device, 'measure_current_spot_index', currentPriceIndex);
    } catch (error) {
      this.homey.error('Error updating current values:', error);
    }
  }

  // Pomocná funkce pro nastavení capability hodnoty s kontrolou
  setCapability(device, capability, value) {
    if (value !== undefined && value !== null) {
      device.setCapabilityValue(capability, value).catch(err => {
        this.homey.error(`Error setting capability ${capability}:`, err);
      });
    } else {
      this.homey.error(`Capability ${capability} value is invalid:`, value);
    }
  }

  // Pomocná funkce pro fetch s podporou ESM
  async fetchUrl(url) {
    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
    return fetch(url);
  }
}

module.exports = SpotPriceAPI;