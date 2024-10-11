'use strict';

const Homey = require('homey');
const crypto = require('crypto');

class CZSpotPricesDriver extends Homey.Driver {

  async onInit() {
    this.tariffIntervals = this.homey.settings.get('tariff_intervals') || [];
    this.registerFlowCards();
    this.startPeriodicCheck();
  }

  registerFlowCards() {
    this._registerTriggerFlowCards();
    this._registerConditionFlowCards();
    this._registerActionFlowCards();
  }

  _registerTriggerFlowCards() {
    try {
      ['current-price-lower-than-trigger', 'current-price-higher-than-trigger', 'current-price-index-trigger'].forEach(cardId => {
        this.homey.flow.getTriggerCard(cardId);
      });

      this.homey.flow.getTriggerCard('average-price-trigger')
        .registerRunListener(this._handleAveragePriceTrigger.bind(this));

      this.homey.flow.getTriggerCard('when-api-call-fails-trigger');

      // Nový trigger pro změnu aktuální ceny
      this.homey.flow.getTriggerCard('when-current-price-changes')
        .registerRunListener(async (args, state) => {
          return true; // Tento trigger se vždy spustí, když je zavolán
        });

    } catch (error) {
      this.error('Error registering trigger Flow cards:', error);
    }
  }

  async _handleAveragePriceTrigger(args, state) {
    const { hours, condition } = args;
    const device = state.device;
    const currentHour = new Date().getHours();
  
    const allCombinations = await this._calculateAveragePrices(device, hours);
    const targetCombination = this._findTargetCombination(allCombinations, condition);
  
    return currentHour >= targetCombination.startHour && currentHour < (targetCombination.startHour + hours);
  }

  _registerConditionFlowCards() {
    try {
      this._registerConditionCard('price-lower-than-condition', 'measure_current_spot_price_CZK', '<');
      this._registerConditionCard('price-higher-than-condition', 'measure_current_spot_price_CZK', '>');
      this._registerConditionCard('price-index-is-condition', 'measure_current_spot_index', '=');
      this._registerAveragePriceConditionCard();
    } catch (error) {
      this.error('Error registering condition Flow cards:', error);
    }
  }

  _registerConditionCard(cardId, capability, operator) {
    this.homey.flow.getConditionCard(cardId).registerRunListener(async (args, state) => {
      const device = state.device;
      const currentValue = await device.getCapabilityValue(capability);
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
        const device = state.device;
        const currentHour = new Date().getHours();
    
        try {
          const allCombinations = await this._calculateAveragePrices(device, hours);
          const targetCombination = this._findTargetCombination(allCombinations, condition);
    
          return currentHour >= targetCombination.startHour && currentHour < (targetCombination.startHour + hours);
        } catch (error) {
          this.error('Error processing average price condition:', error);
          return false;
        }
      });
  }

  _registerActionFlowCards() {
    try {
      this.homey.flow.getActionCard('update_data_via_api')
        .registerRunListener(async (args, state) => {
          const device = args.device;
          if (!device) {
            this.error('No device provided for update_data_via_api action');
            return false;
          }
          try {
            await device.fetchAndUpdateSpotPrices();
            device.setAvailable();
            return true;
          } catch (error) {
            const errorMessage = this.getErrorMessage(error);
            this.error(`Error updating spot prices for device ${device.getName()}:`, errorMessage);
            device.setAvailable();
            device.spotPriceApi.triggerApiCallFail(errorMessage, device);
            return false;
          }
        });
    } catch (error) {
      this.error('Error registering action Flow cards:', error);
    }
  }

  async _calculateAveragePrices(device, hours) {
    const currentHour = new Date().getHours();
    const allCombinations = [];
  
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
    }
  
    return allCombinations;
  }
  
  _findTargetCombination(combinations, condition) {
    const sortedCombinations = combinations.sort((a, b) => a.avg - b.avg);
    return condition === 'lowest' ? sortedCombinations[0] : sortedCombinations[sortedCombinations.length - 1];
  }
  
  async _checkAndTriggerAveragePrice() {
    const devices = this.getDevices();
    for (const device of Object.values(devices)) {
      const hours = 1; // Výchozí hodnota, můžete ji upravit podle potřeby
      const conditions = ['lowest', 'highest'];
      
      for (const condition of conditions) {
        const allCombinations = await this._calculateAveragePrices(device, hours);
        const currentHour = new Date().getHours();
        const targetCombination = this._findTargetCombination(allCombinations, condition);
        
        if (targetCombination.startHour === currentHour) {
          const triggerCard = this.homey.flow.getTriggerCard('average-price-trigger');
          try {
            await triggerCard.trigger(device, { hours: hours, condition: condition });
          } catch (err) {
            this.error('Error triggering average price:', err);
          }
        }
      }
    }
  }

  startPeriodicCheck() {
    this.homey.setInterval(this._checkAndTriggerAveragePrice.bind(this), 60 * 60 * 1000); // každou hodinu
  }

  async onPairListDevices() {
    try {
      const deviceId = crypto.randomUUID();
      const deviceName = 'CZ Spot Prices Device';
      return [{ name: deviceName, data: { id: deviceId } }];
    } catch (error) {
      this.error("Error during pairing:", error);
      throw error;
    }
  }

  async settingsChanged(data) {
    try {
      this._saveSettings(data);
    } catch (error) {
      this.error("Error saving settings:", error);
    }
  }

  _saveSettings(data) {
    this.homey.settings.set('low_tariff_price', data.low_tariff_price);
    this.homey.settings.set('high_tariff_price', data.high_tariff_price);
    for (let i = 0; i < 24; i++) {
      this.homey.settings.set(`hour_${i}`, data[`hour_${i}`]);
    }
    this.tariffIntervals = data.tariff_intervals || [];
  }

  // Nová metoda pro spuštění triggeru při změně aktuální ceny
  async triggerCurrentPriceChangedFlow(device, tokens) {
    const trigger = this.homey.flow.getTriggerCard('when-current-price-changes');
    await trigger.trigger(device, tokens);
  }
}

module.exports = CZSpotPricesDriver;