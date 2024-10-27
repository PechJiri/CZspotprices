'use strict';

const Homey = require('homey');
const crypto = require('crypto');

class CZSpotPricesDriver extends Homey.Driver {

  async onInit() {
    this.tariffIntervals = this.homey.settings.get('tariff_intervals') || [];
    this.homey.log('Driver initialized with tariff intervals:', this.tariffIntervals);
  
    this.registerFlowCards();
  
    // Pravidelná kontrola změn tarifu každou hodinu
    this.tariffCheckInterval = this.homey.setInterval(() => {
      this.checkTariffChange();
    }, 60 * 60 * 1000); // Kontrola jednou za hodinu
    this.homey.log('Tariff change check interval set to 1 hour.');
  }
  

  registerFlowCards() {
    this.homey.log('Registering flow cards...');
    this._registerTriggerFlowCards();
    this._registerConditionFlowCards();
    this._registerActionFlowCards();
  }

  _registerTriggerFlowCards() {
    try {
      // Základní triggery pro cenu a index
      ['current-price-lower-than-trigger', 'current-price-higher-than-trigger', 'current-price-index-trigger'].forEach(cardId => {
        this.homey.flow.getDeviceTriggerCard(cardId);
      });
      this.homey.log('Basic price and index trigger cards registered.');

      // Trigger pro průměrnou cenu
      this.homey.flow.getDeviceTriggerCard('average-price-trigger')
        .registerRunListener(this._handleAveragePriceTrigger.bind(this));
      this.homey.log('Average price trigger card registered.');

      // Upravený trigger pro API chyby s rozlišením typu
      this.homey.flow.getDeviceTriggerCard('when-api-call-fails-trigger')
        .registerRunListener(async (args, state) => {
          this.homey.log(`API call fail trigger invoked with type: ${args.type}`);
          return args.type === state.type;
        });

      // Trigger pro změnu aktuální ceny
      this.homey.flow.getDeviceTriggerCard('when-current-price-changes')
        .registerRunListener(async (args, state) => {
          this.homey.log('Current price change trigger invoked.');
          return true;
        });

      // Trigger pro změnu distribučního tarifu
      this.tariffChangeTrigger = this.homey.flow.getDeviceTriggerCard('when-distribution-tariff-changes');
      this.homey.log('Distribution tariff change trigger registered.');

    } catch (error) {
      this.error('Error registering trigger Flow cards:', error);
    }
  }

  async _handleAveragePriceTrigger(args, state) {
    const { hours, condition } = args;
    const device = state.device;
    const currentHour = new Date(new Date().toLocaleString('en-US', { timeZone: this.homey.clock.getTimezone() })).getHours();

    this.homey.log(`Handling average price trigger for next ${hours} hours with condition: ${condition}`);
  
    const allCombinations = await this._calculateAveragePrices(device, hours);
    const targetCombination = this._findTargetCombination(allCombinations, condition);
  
    return currentHour >= targetCombination.startHour && currentHour < (targetCombination.startHour + hours);
  }

  _registerConditionFlowCards() {
    try {
      this.homey.log('Registering condition flow cards...');

      this._registerConditionCard('price-lower-than-condition', 'measure_current_spot_price_CZK', '<');
      this._registerConditionCard('price-higher-than-condition', 'measure_current_spot_price_CZK', '>');
      this._registerConditionCard('price-index-is-condition', 'measure_current_spot_index', '=');
      this._registerAveragePriceConditionCard();

      // Podmínka pro distribuční tarif
      this.homey.flow.getConditionCard('distribution-tariff-is')
        .registerRunListener(async (args, state) => {
          const currentHour = new Date(new Date().toLocaleString('en-US', { timeZone: this.homey.clock.getTimezone() })).getHours();
          const device = args.device;
          const isLowTariff = this.isLowTariff(currentHour, device);
          const result = args.tariff === (isLowTariff ? 'low' : 'high');
          this.homey.log(`Distribution tariff condition checked: expected ${args.tariff}, actual ${isLowTariff ? 'low' : 'high'}`);
          return result;
        });
    } catch (error) {
      this.error('Error registering condition Flow cards:', error);
    }
  }

  _registerConditionCard(cardId, capability, operator) {
    this.homey.flow.getConditionCard(cardId)
      .registerRunListener(async (args, state) => {
        const device = args.device;
        const currentValue = await device.getCapabilityValue(capability);
        this.homey.log(`Condition card ${cardId} invoked with current value: ${currentValue} and target: ${args.value}`);

        if (currentValue === null || currentValue === undefined) {
          throw new Error(`Capability value for ${capability} is not available`);
        }
        
        switch(operator) {
          case '>': return currentValue > args.value;
          case '<': return currentValue < args.value;
          case '=': return currentValue === args.value;
          default: return false;
        }
      });
  }

  _registerAveragePriceConditionCard() {
    this.homey.flow.getConditionCard('average-price-condition')
      .registerRunListener(async (args, state) => {
        const { hours, condition } = args;
        const device = args.device;
        const currentHour = new Date(new Date().toLocaleString('en-US', { timeZone: this.homey.clock.getTimezone() })).getHours();

        this.homey.log(`Average price condition card invoked for ${hours} hours with condition: ${condition}`);

        try {
          const allCombinations = await this._calculateAveragePrices(device, hours);
          const targetCombination = this._findTargetCombination(allCombinations, condition);
          const result = currentHour >= targetCombination.startHour && currentHour < (targetCombination.startHour + hours);
          this.homey.log(`Average price condition evaluated to ${result}`);
          return result;
        } catch (error) {
          this.error('Error processing average price condition:', error);
          return false;
        }
      });
  }

  _registerActionFlowCards() {
    try {
      this.homey.log('Registering action flow cards...');
  
      this.homey.flow.getActionCard('update_data_via_api')
        .registerRunListener(async (args) => {
          const device = args.device;
          if (!device) {
            this.error('No device provided for update_data_via_api action');
            return false;
          }
  
          this.homey.log('Update daily prices via API action invoked.');
          try {
            await device.fetchAndUpdateSpotPrices();
            await device.setAvailable();
            return true;
          } catch (error) {
            const errorMessage = device.spotPriceApi.getErrorMessage(error);
            this.error(`Error updating daily prices for device ${device.getName()}:`, errorMessage);
            await device.setAvailable();
            device.spotPriceApi.triggerApiCallFail(errorMessage, device, 'daily');
            return false;
          }
        });
    } catch (error) {
      this.error('Error registering action Flow cards:', error);
    }
  }  

  async _calculateAveragePrices(device, hours) {
    const currentHour = new Date(new Date().toLocaleString('en-US', { timeZone: this.homey.clock.getTimezone() })).getHours();
    const allCombinations = [];
    this.homey.log(`Calculating average prices for ${hours} hours, starting from current hour: ${currentHour}`);
  
    for (let startHour = currentHour; startHour <= 24 - hours; startHour++) {
      let total = 0;
  
      for (let i = startHour; i < startHour + hours; i++) {
        const price = await device.getCapabilityValue(`hour_price_CZK_${i}`);
        if (price === null || price === undefined) {
          throw new Error(`Missing price data for hour ${i}`);
        }
        total += price;
      }
  
      const avg = total / hours;
      allCombinations.push({ startHour, avg });
      this.homey.log(`Calculated average price from hour ${startHour} to ${startHour + hours - 1}: ${avg}`);
    }
  
    return allCombinations;
  }
  
  _findTargetCombination(combinations, condition) {
    const sortedCombinations = combinations.sort((a, b) => a.avg - b.avg);
    const target = condition === 'lowest' ? sortedCombinations[0] : sortedCombinations[sortedCombinations.length - 1];
    this.homey.log(`Target combination found for condition ${condition}:`, target);
    return target;
  }

  async onPairListDevices() {
    try {
      const deviceId = crypto.randomUUID();
      const deviceName = 'CZ Spot Prices Device';
      this.homey.log('Pairing device with ID:', deviceId);
      return [{ name: deviceName, data: { id: deviceId } }];
    } catch (error) {
      this.error("Error during pairing:", error);
      throw error;
    }
  }

  async settingsChanged(data) {
    this.homey.log('Settings have changed, updating spot prices for all devices.');
    try {
      const devices = this.getDevices();
      for (const device of Object.values(devices)) {
        await device.fetchAndUpdateSpotPrices();
      }
    } catch (error) {
      this.error("Error updating prices after settings change:", error);
    }
  }

  isLowTariff(hour, device) {
    // Logování vstupu do funkce a přijaté parametry
    this.homey.log('--- Start: Checking Low Tariff Status ---');
    this.homey.log(`Received hour: ${hour}`);
  
    // Logování pro získání nastavení tarifu pro každou hodinu
    const tariffSettings = [];
    for (let i = 0; i < 24; i++) {
      const isLowTariffHour = device.getSetting(`hour_${i}`);
      tariffSettings.push({ hour: i, isLowTariff: isLowTariffHour });
      this.homey.log(`Hour ${i} - Low tariff setting: ${isLowTariffHour}`);
    }
  
    // Filtrace hodin s nastaveným low tarifem a výpis výsledku
    const tariffHours = tariffSettings
      .filter(setting => setting.isLowTariff)
      .map(setting => setting.hour);
    this.homey.log(`Hours with low tariff enabled: ${tariffHours}`);
  
    // Výsledek kontroly, zda je aktuální hodina mezi low tarifními
    const result = tariffHours.includes(hour);
    this.homey.log(`Is hour ${hour} in low tariff hours? Result: ${result}`);
  
    // Logování ukončení funkce a výstupní hodnota
    this.homey.log('--- End: Checking Low Tariff Status ---');
    return result;
  }  

  checkTariffChange() {
    const devices = this.getDevices();
    const currentHour = new Date(new Date().toLocaleString('en-US', { timeZone: this.homey.clock.getTimezone() })).getHours();
    this.homey.log('Checking tariff change for current hour:', currentHour);

    for (const device of Object.values(devices)) {
      const previousTariff = device.getStoreValue('previousTariff');
      const currentTariff = this.isLowTariff(currentHour, device) ? 'low' : 'high';

      if (previousTariff !== currentTariff) {
        this.homey.log(`Tariff changed for device ${device.getName()} from ${previousTariff} to ${currentTariff}`);
        device.setStoreValue('previousTariff', currentTariff);
        this.tariffChangeTrigger.trigger(device, { tariff: currentTariff })
          .catch(this.error);
      }
    }
  }

  async triggerCurrentPriceChangedFlow(device, tokens) {
    const triggerCard = this.homey.flow.getDeviceTriggerCard('when-current-price-changes');
    try {
      await triggerCard.trigger(device, tokens);
      this.homey.log(`Current price changed trigger executed for device ${device.getName()}.`);
    } catch (error) {
      this.error('Error triggering current price changed flow:', error);
    }
  }
}

module.exports = CZSpotPricesDriver;
