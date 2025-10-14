'use strict';

module.exports = {
  /**
   * Získá všechny 96 15-minutové intervaly včetně statistik
   * Data se berou z cache 'lastProcessedPrices' kde jsou již zahrnuty:
   * - Distribuční tarify
   * - DPH (pokud je nastaveno)
   * - Price levely (low/medium/high)
   */
  async getIntervalPrices({ homey }) {
    console.log('=== Widget API: getIntervalPrices called ===');
    
    try {
      // Zkus oba možné názvy driverů
      let driver;
      try {
        driver = homey.drivers.getDriver('cz-spot-prices');
        console.log('Driver found: cz-spot-prices');
      } catch (e) {
        console.log('Driver cz-spot-prices not found, trying cz-spot-prices-minutes');
        driver = homey.drivers.getDriver('cz-spot-prices-minutes');
        console.log('Driver found: cz-spot-prices-minutes');
      }

      const devices = driver.getDevices();
      console.log('Devices count:', devices.length);

      if (devices.length === 0) {
        console.error('ERROR: No devices found!');
        throw new Error('No devices found');
      }

      const device = devices[0];
      console.log('Using device ID:', device.getData().id);

      // Získat nastavení pro formátování
      const priceInKWh = device.getSetting('price_in_kwh') || false;
      console.log('Price in kWh setting:', priceInKWh);

      // Získat zpracovaná data z cache (obsahuje již distribuce + DPH + levely)
      const cachedPrices = device.cacheManager.get('lastProcessedPrices');
      console.log('Cached prices found:', !!cachedPrices);
      console.log('Cached prices length:', cachedPrices?.length);

      if (!cachedPrices || cachedPrices.length !== 96) {
        console.log('Cache empty or incomplete, calling ensureCachedData()...');
        
        // Pokud nejsou v cache, zajistit jejich načtení
        await device.ensureCachedData();
        
        const retryPrices = device.cacheManager.get('lastProcessedPrices');
        console.log('After ensureCachedData - prices found:', !!retryPrices);
        console.log('After ensureCachedData - prices length:', retryPrices?.length);
        
        if (!retryPrices || retryPrices.length !== 96) {
          console.error('ERROR: Unable to load processed prices from cache after retry');
          throw new Error('Unable to load processed prices from cache');
        }
        
        const response = this._buildResponse(retryPrices, device, priceInKWh);
        console.log('=== Response built successfully (after retry) ===');
        console.log('Response slots count:', response.allSlots.length);
        console.log('Current price:', response.currentPrice);
        return response;
      }

      const response = this._buildResponse(cachedPrices, device, priceInKWh);
      console.log('=== Response built successfully ===');
      console.log('Response slots count:', response.allSlots.length);
      console.log('Current price:', response.currentPrice);
      console.log('Average price:', response.averagePrice);
      console.log('Max price:', response.maxPrice);
      console.log('Min price:', response.minPrice);
      
      return response;

    } catch (error) {
      console.error('=== API Error in getIntervalPrices ===');
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
      throw error;
    }
  },

  /**
   * Pomocná metoda pro sestavení response s konverzí cen
   * @private
   */
  _buildResponse(slots, device, priceInKWh) {
    console.log('_buildResponse: Converting', slots.length, 'slots');
    console.log('_buildResponse: priceInKWh =', priceInKWh);
    
    // Konverze cen pokud je potřeba (MWh -> kWh)
    const convertedSlots = slots.map(slot => ({
      hour: slot.hour,
      minute: slot.minute,
      priceCZK: priceInKWh ? slot.priceCZK / 1000 : slot.priceCZK,
      level: slot.level
    }));

    console.log('Sample converted slot:', convertedSlots[0]);

    // Získat aktuální cenu přímo z capability (už je konvertovaná pokud je priceInKWh)
    let currentPrice = null;
    try {
      currentPrice = device.getCapabilityValue('measure_current_price');
      console.log('Current price from capability:', currentPrice);
    } catch (error) {
      console.error('Error getting current price from capability:', error);
      // Fallback na výpočet z indexu
      const currentSlotIndex = this._getCurrentSlotIndex();
      currentPrice = convertedSlots[currentSlotIndex]?.priceCZK || null;
      console.log('Using fallback current price from slot:', currentPrice);
    }

    // Vypočítat statistiky
    const prices = convertedSlots.map(s => s.priceCZK);
    const averagePrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    const maxPrice = Math.max(...prices);
    const minPrice = Math.min(...prices);

    console.log('Statistics calculated:', {
      currentPrice,
      averagePrice,
      maxPrice,
      minPrice
    });

    return {
      allSlots: convertedSlots,
      currentPrice,
      averagePrice,
      maxPrice,
      minPrice,
      priceInKWh
    };
  },

  /**
   * Vypočítá aktuální slot index (0-95)
   * @private
   */
  _getCurrentSlotIndex() {
    const now = new Date();
    const hour = now.getHours();
    const minute = Math.floor(now.getMinutes() / 15) * 15;
    const index = hour * 4 + minute / 15;
    console.log('_getCurrentSlotIndex:', {
      hour,
      minute,
      index
    });
    return index;
  }
};