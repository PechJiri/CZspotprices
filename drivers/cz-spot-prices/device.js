'use strict';

const Homey = require('homey');
const SpotPriceAPI = require('./api');

class CZSpotPricesDevice extends Homey.Device {

  async onInit() {
    this.log('CZ Spot Prices device has been initialized');

    const deviceId = this.getData().id || this.getStoreValue('device_id');
    if (!deviceId) {
      const newDeviceId = this.generateDeviceId();
      await this.setStoreValue('device_id', newDeviceId);
      this.log('Generated new device ID:', newDeviceId);
    } else {
      this.log('Using existing device ID:', deviceId);
    }

    this.spotPriceApi = new SpotPriceAPI(this.homey);

    const lowTariffPrice = this.getSetting('low_tariff_price') || 0;
    const highTariffPrice = this.getSetting('high_tariff_price') || 0;
    const updateInterval = this.getSetting('update_interval') || 1;

    this.log('Settings loaded:', { lowTariffPrice, highTariffPrice, updateInterval });

    for (let i = 0; i < 24; i++) {
      const hourTariff = this.getSetting(`hour_${i}`) || false;
      this.log(`Hour ${i} Low Tariff:`, hourTariff);
    }

    const capabilities = [
      'measure_current_spot_price_CZK',
      'measure_current_spot_index',
      'daily_average_price',
      ...Array.from({ length: 24 }, (_, i) => [`hour_price_CZK_${i}`, `hour_price_index_${i}`]).flat()
    ];

    for (const capability of capabilities) {
      if (!this.hasCapability(capability)) {
        try {
          await this.addCapability(capability);
          this.log(`Added capability: ${capability}`);
        } catch (error) {
          this.error(`Failed to add capability ${capability}:`, error);
        }
      }
    }

    this.setupFlowCards();
    this.registerUpdateDataViaApiFlowAction();
    this.startDataFetchInterval(updateInterval);

    try {
      await this.fetchAndUpdateSpotPrices();
      this.setAvailable();
    } catch (error) {
      this.error('Failed to fetch initial spot prices:', error);
      this.setUnavailable('Failed to fetch initial data');
    }
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('CZ Spot Prices device settings were changed');
    this.log('Old Settings:', oldSettings);
    this.log('New Settings:', newSettings);
    this.log('Changed Keys:', changedKeys);
  
    changedKeys.forEach((key) => {
      this.setSetting(key, newSettings[key]);
      this.log(`Setting ${key} updated to:`, newSettings[key]);
    });
  
    if (changedKeys.includes('update_interval')) {
      this.startDataFetchInterval(newSettings.update_interval);
      this.log('Data fetch interval updated to:', newSettings.update_interval);
    }
  
    try {
      await this.fetchAndUpdateSpotPrices();
      this.setAvailable();
      this.log('Device is now available after settings update');
    } catch (error) {
      this.error('Failed to update spot prices after settings change:', error);
      // I když selže aktualizace, pokusíme se nastavit zařízení jako dostupné
      this.setAvailable();
      this.log('Device set to available despite update failure');
    }
  }

  async fetchAndUpdateSpotPrices() {
    this.log('Starting fetchAndUpdateSpotPrices');
    try {
      this.log('Fetching and updating spot prices...');
      const currentPrice = await this.spotPriceApi.getCurrentPriceCZK(this);
      this.log('Fetched current price:', currentPrice);
      const currentIndex = await this.spotPriceApi.getCurrentPriceIndex(this);
      this.log('Fetched current index:', currentIndex);
      const dailyPrices = await this.spotPriceApi.getDailyPrices(this);
      this.log('Fetched daily prices:', dailyPrices);
  
      await this.setCapabilityValue('measure_current_spot_price_CZK', currentPrice);
      await this.setCapabilityValue('measure_current_spot_index', currentIndex);
  
      for (const priceData of dailyPrices) {
        await this.setCapabilityValue(`hour_price_CZK_${priceData.hour}`, priceData.priceCZK);
        await this.setCapabilityValue(`hour_price_index_${priceData.hour}`, priceData.level);
      }
  
      await this.spotPriceApi.updateDailyAverageCapability(this);
  
      this.log('Spot prices updated successfully.');
      this.setAvailable(); // Zařízení zůstává dostupné
    } catch (error) {
      const errorMessage = this.spotPriceApi.getErrorMessage(error);
      this.error(`Error fetching spot prices: ${errorMessage}`);
  
      // Zachováme poslední data a zařízení neznačíme jako nedostupné
      this.homey.notifications.createNotification({
        excerpt: `Error fetching spot prices: ${errorMessage}`,
      });
  
      // Voláme triggerApiCallFail přímo z Device
      this.spotPriceApi.triggerApiCallFail(errorMessage, this);
      return false; // Funkce vrátí false, aby bylo jasné, že došlo k chybě
    }
  }
  

  async onDeleted() {
    this.log('CZ Spot Prices device deleted');
    if (this.dataFetchInterval) {
      this.homey.clearInterval(this.dataFetchInterval);
    }
  }

  setupFlowCards() {
    this.registerConditionCard('price-lower-than-condition', 'measure_current_spot_price_CZK', (current, target) => current < target);
    this.registerConditionCard('price-higher-than-condition', 'measure_current_spot_price_CZK', (current, target) => current > target);
    this.registerConditionCard('price-index-is-condition', 'measure_current_spot_index', (current, target) => current === target);
    this.registerAveragePriceCondition();

    this.registerTriggerCard('current-price-lower-than-trigger', 'measure_current_spot_price_CZK', (current, target) => current < target);
    this.registerTriggerCard('current-price-higher-than-trigger', 'measure_current_spot_price_CZK', (current, target) => current > target);
    this.registerTriggerCard('current-price-index-trigger', 'measure_current_spot_index', (current, target) => current === target);

    const apiCallFailTrigger = this.homey.flow.getDeviceTriggerCard('when-api-call-fails-trigger');
    apiCallFailTrigger.registerRunListener(async (args, state) => {
      this.log('API call fail trigger run listener called with args:', args, 'and state:', state);
      return true; // Always run when triggered
    });
  }

  registerConditionCard(cardId, capability, comparison) {
    this.homey.flow.getConditionCard(cardId)
      .registerRunListener(async (args, state) => {
        const currentValue = await this.getCapabilityValue(capability);
        this.log(`Condition card ${cardId} run with current value: ${currentValue} and target value: ${args.value}`);
        return comparison(currentValue, args.value);
      });
  }

  registerTriggerCard(cardId, capability, comparison) {
    this.homey.flow.getDeviceTriggerCard(cardId)
      .registerRunListener(async (args, state) => {
        const currentValue = await this.getCapabilityValue(capability);
        this.log(`Trigger card ${cardId} run with current value: ${currentValue} and target value: ${args.value}`);
        return comparison(currentValue, args.value);
      });
  }

  registerAveragePriceCondition() {
    this.homey.flow.getConditionCard('average-price-condition')
        .registerRunListener(async (args, state) => {
            const { hours, condition } = args;
            this.log(`Average price condition run with hours: ${hours} and condition: ${condition}`);
            
            // Získání všech kombinací
            const allCombinations = await this.calculateAveragePrices(hours);
            this.log(`Všechny kombinace průměrných cen: ${allCombinations.map(c => `Start: ${c.startHour}, Průměr: ${c.avg} CZK`).join('; ')}`);
            
            // Vyhledání cílové kombinace
            const targetCombination = this.findTargetCombination(allCombinations, condition);
            const currentHour = new Date().getHours();
            
            // Porovnání výsledku
            const result = currentHour >= targetCombination.startHour && currentHour < (targetCombination.startHour + hours);
            this.log(`Výsledek podmínky: ${result ? 'true' : 'false'}, Aktuální hodina: ${currentHour}, Vybraný interval: ${targetCombination.startHour}-${targetCombination.startHour + hours}, Průměrná cena: ${targetCombination.avg} CZK`);
            
            return result;
        });
}

  async calculateAveragePrices(hours) {
    const allCombinations = [];
    for (let startHour = 0; startHour <= 24 - hours; startHour++) {
        let total = 0;
        for (let i = startHour; i < startHour + hours; i++) {
            const price = await this.getCapabilityValue(`hour_price_CZK_${i}`);
            if (price === null || price === undefined) {
                this.log(`Chybí data pro hodinu ${i}`);
                throw new Error(`Chybí cenová data pro hodinu ${i}`);
            }
            this.log(`Hodina ${i}: cena ${price} CZK`);
            total += price;
        }
        const avg = total / hours;
        this.log(`Interval ${startHour}-${startHour + hours}: průměrná cena ${avg} CZK`);
        allCombinations.push({ startHour, avg });
    }
    return allCombinations;
}


findTargetCombination(combinations, condition) {
  const sortedCombinations = combinations.sort((a, b) => a.avg - b.avg);
  const target = condition === 'lowest' ? sortedCombinations[0] : sortedCombinations[sortedCombinations.length - 1];
  
  // Přidáme logování, abychom viděli vybraný interval a jeho průměr
  this.log(`Vybraná kombinace pro '${condition}': Interval ${target.startHour}-${target.startHour + combinations.length}, Průměr: ${target.avg} CZK`);
  
  return target;
}


  registerUpdateDataViaApiFlowAction() {
    this.homey.flow.getActionCard('update_data_via_api')
      .registerRunListener(async (args, state) => {
        this.log('Running action: Update data via API'); // Log, že došlo ke spuštění akce
        try {
          this.log('Fetching and updating spot prices via API...'); // Log, že začínáme stahovat data
          await this.fetchAndUpdateSpotPrices(); // Volání API pro aktualizaci dat
          this.log('Data successfully updated via API.'); // Log, že aktualizace proběhla úspěšně
          return true;
        } catch (error) {
          const errorMessage = this.spotPriceApi.getErrorMessage(error);
          this.error('Failed to update data via API:', errorMessage); // Log chyby
          this.spotPriceApi.triggerApiCallFail(errorMessage, this); // Trigger pro chybu API
          return false;
        } finally {
          this.log('Finished running action: Update data via API.'); // Log, že celá akce byla dokončena
        }
      });
  }

  startDataFetchInterval(interval) {
    if (this.dataFetchInterval) {
      this.homey.clearInterval(this.dataFetchInterval);
    }

    const now = new Date();
    const currentHour = now.getHours();
    const nextIntervalHour = Math.ceil(currentHour / interval) * interval;
    let msUntilNextInterval = ((nextIntervalHour - currentHour) * 60 * 60 - now.getMinutes() * 60 - now.getSeconds()) * 1000 + 1000;

    if (msUntilNextInterval <= 0) {
      msUntilNextInterval += interval * 60 * 60 * 1000;
    }

    this.log(`Next data fetch scheduled in ${msUntilNextInterval / 1000} seconds`);

    this.homey.setTimeout(async () => {
      await this.fetchAndUpdateSpotPrices();
      this.dataFetchInterval = this.homey.setInterval(async () => {
        await this.fetchAndUpdateSpotPrices();
      }, interval * 60 * 60 * 1000);
    }, msUntilNextInterval);
  }

  generateDeviceId() {
    const deviceId = this.homey.util.generateUniqueId();
    this.log('Generated new device ID:', deviceId);
    return deviceId;
  }
}

module.exports = CZSpotPricesDevice;
