'use strict';

const Homey = require('homey');
const crypto = require('crypto');

class CZSpotPricesDriver extends Homey.Driver {

  async onInit() {
    this.tariffIntervals = this.homey.settings.get('tariff_intervals') || [];
    this.registerFlowCards();
    this.startPeriodicCheck();

    this.tariffCheckInterval = this.homey.setInterval(() => {
      this.checkTariffChange();
    }, 60000);
  }

  registerFlowCards() {
    this._registerTriggerFlowCards();
    this._registerConditionFlowCards();
    this._registerActionFlowCards();
  }

  _registerTriggerFlowCards() {
    try {
      ['current-price-lower-than-trigger', 'current-price-higher-than-trigger', 'current-price-index-trigger'].forEach(cardId => {
        this.homey.flow.getDeviceTriggerCard(cardId);
      });

      this.homey.flow.getDeviceTriggerCard('average-price-trigger')
        .registerRunListener(this._handleAveragePriceTrigger.bind(this));

      this.homey.flow.getDeviceTriggerCard('when-api-call-fails-trigger');

      this.homey.flow.getDeviceTriggerCard('when-current-price-changes')
        .registerRunListener(async (args, state) => true);

      this.tariffChangeTrigger = this.homey.flow.getDeviceTriggerCard('when-distribution-tariff-changes');

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

      this.homey.flow.getConditionCard('distribution-tariff-is')
        .registerRunListener(async (args, state) => {
          const currentHour = new Date().getHours();
          const device = args.device;
          const isLowTariff = this.isLowTariff(currentHour, device);
          return args.tariff === (isLowTariff ? 'low' : 'high');
        });
    } catch (error) {
      this.error('Error registering condition Flow cards:', error);
    }
  }

  _registerConditionCard(cardId, capability, operator) {
    this.homey.flow.getConditionCard(cardId).registerRunListener(async (args, state) => {
      const device = args.device;
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
        const device = args.device;
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
            await device.setAvailable();
            return true;
          } catch (error) {
            const errorMessage = this.getErrorMessage(error);
            this.error(`Error updating spot prices for device ${device.getName()}:`, errorMessage);
            await device.setAvailable();
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
      const hours = 1;
      const conditions = ['lowest', 'highest'];
      
      for (const condition of conditions) {
        const allCombinations = await this._calculateAveragePrices(device, hours);
        const currentHour = new Date().getHours();
        const targetCombination = this._findTargetCombination(allCombinations, condition);
        
        if (targetCombination.startHour === currentHour) {
          const triggerCard = this.homey.flow.getDeviceTriggerCard('average-price-trigger');
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
    this.homey.setInterval(this._checkAndTriggerAveragePrice.bind(this), 60 * 60 * 1000);
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
      const devices = this.getDevices();
      for (const device of Object.values(devices)) {
        await device.spotPriceApi.fetchAndUpdateSpotPrices(device);
      }
    } catch (error) {
      this.error("Error updating prices after settings change:", error);
    }
  }

  getErrorMessage(error) {
    if (typeof error === 'string') return error;
    if (error instanceof Error) return error.message;
    return JSON.stringify(error);
  }

  isLowTariff(hour, device) {
    const tariffHours = Array.from({ length: 24 }, (_, i) => i)
      .filter(i => device.getSetting(`hour_${i}`));
    const currentDate = new Date();
    const homeyTimezone = this.homey.clock.getTimezone();
    const options = { timeZone: homeyTimezone };
    const currentHour = parseInt(currentDate.toLocaleString('en-US', { ...options, hour: 'numeric', hour12: false }));
    return tariffHours.includes(currentHour);
  }

  checkTariffChange() {
    const devices = this.getDevices();
    const currentHour = new Date().getHours();

    for (const device of Object.values(devices)) {
      const previousTariff = device.getStoreValue('previousTariff');
      const currentTariff = this.isLowTariff(currentHour, device) ? 'low' : 'high';

      if (previousTariff !== currentTariff) {
        device.setStoreValue('previousTariff', currentTariff);
        this.tariffChangeTrigger.trigger(device, { tariff: currentTariff })
          .catch(this.error);
      }
    }
  }
}

module.exports = CZSpotPricesDriver;
