'use strict';

const Homey = require('homey');
const crypto = require('crypto');

class CZSpotPricesDriver extends Homey.Driver {

  async onInit() {
    this.log('CZSpotPricesDriver has been initialized');
    this.tariffIntervals = this.homey.settings.get('tariff_intervals') || [];
    this.registerFlowCards();
  }

  registerFlowCards() {
    this._registerTriggerFlowCards();
    this._registerConditionFlowCards();
    this._registerActionFlowCards();
  }

  _registerTriggerFlowCards() {
    this.log('Registering trigger Flow cards...');
    try {
      ['current-price-lower-than-trigger', 'current-price-higher-than-trigger', 'current-price-index-trigger'].forEach(cardId => {
        this.homey.flow.getTriggerCard(cardId);
      });

      this.homey.flow.getTriggerCard('average-price-trigger')
        .registerRunListener(this._handleAveragePriceTrigger.bind(this));

      this.homey.flow.getTriggerCard('when-api-call-fails-trigger');
      this.log('Trigger Flow cards registered successfully.');
    } catch (error) {
      this.error('Error registering trigger Flow cards:', error);
    }
  }

  async _handleAveragePriceTrigger(args, state) {
    const { hours, condition } = args;
    const device = state.device;
    try {
      const allCombinations = await this._calculateAveragePrices(device, hours);
      const targetCombination = this._findTargetCombination(allCombinations, condition);
      const currentHour = new Date().getHours();
      return currentHour >= targetCombination.startHour && currentHour < (targetCombination.startHour + hours);
    } catch (error) {
      this.error('Error in average price trigger:', error);
      return false;
    }
  }

  _registerConditionFlowCards() {
    this.log('Registering condition Flow cards...');
    try {
      this._registerConditionCard('price-lower-than-condition', 'measure_current_spot_price_CZK', '<');
      this._registerConditionCard('price-higher-than-condition', 'measure_current_spot_price_CZK', '>');
      this._registerConditionCard('price-index-is-condition', 'measure_current_spot_index', '=');
      this._registerAveragePriceConditionCard();
      this.log('Condition Flow cards registered successfully.');
    } catch (error) {
      this.error('Error registering condition Flow cards:', error);
    }
  }

  _registerConditionCard(cardId, capability, operator) {
    this.log(`Registering condition card ${cardId} with operator ${operator}...`);
    this.homey.flow.getConditionCard(cardId).registerRunListener(async (args, state) => {
      const device = state.device;
      const currentValue = await device.getCapabilityValue(capability);
      if (currentValue === null || currentValue === undefined) {
        throw new Error(`Capability value for ${capability} is not available`);
      }
      this.log(`Running condition card ${cardId}. Current value: ${currentValue}, Args value: ${args.value}, Operator: ${operator}`);
      
      switch(operator) {
        case '>': return currentValue > args.value;
        case '<': return currentValue < args.value;
        case '=': return currentValue === args.value;
        default: return false;
      }
    });
  }

  _registerAveragePriceConditionCard() {
    this.log('Registering average price condition card...');
    this.homey.flow.getConditionCard('average-price-condition')
      .registerRunListener(this._handleAveragePriceTrigger.bind(this));
  }

  _registerActionFlowCards() {
    this.log('Registering action Flow cards...');
    try {
      this.homey.flow.getActionCard('update_data_via_api')
        .registerRunListener(async (args, state) => {
          this.log('Running action: Update data via API');
          const device = args.device;
          if (!device) {
            this.error('No device provided for update_data_via_api action');
            return false;
          }
          this.log(`Updating data for device: ${device.getName()}`);
          try {
            await device.fetchAndUpdateSpotPrices();
            device.setAvailable();
            this.log(`Data successfully updated for device: ${device.getName()}`);
            return true;
          } catch (error) {
            const errorMessage = this.getErrorMessage(error);
            this.error(`Error updating spot prices for device ${device.getName()}: ${errorMessage}`);
            this.error('Detailed error object:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
            // I když selže aktualizace, pokusíme se nastavit zařízení jako dostupné
            device.setAvailable();
            this.log('Device set to available despite update failure');
            // Trigger the WHEN card when API call fails
            device.spotPriceApi.triggerApiCallFail(errorMessage, device);
            return false;
          }
        });
      this.log('Action Flow cards registered successfully.');
    } catch (error) {
      this.error('Error registering action Flow cards:', error);
    }
  }

  async _handleUpdateDataViaApi(args, state) {
    this.log('Running action: Update data via API');
    const devices = this.getDevices();
    const promises = Object.values(devices).map(async device => {
      try {
        this.log(`Updating data for device: ${device.getName()}`);
        await device.fetchAndUpdateSpotPrices();
        this.log(`Data successfully updated for device: ${device.getName()}`);
      } catch (error) {
        const errorMessage = this.getErrorMessage(error);
        this.error(`Error updating spot prices for device ${device.getName()}: ${errorMessage}`);
        this.error('Detailed error object:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
        // Trigger the WHEN card when API call fails
        device.spotPriceApi.triggerApiCallFail(errorMessage, device);
      }
    });
    await Promise.all(promises);
    this.log('Data successfully updated for all devices via API.');
    return true;
  }

  async _calculateAveragePrices(device, hours) {
    const allCombinations = [];
    for (let startHour = 0; startHour <= 24 - hours; startHour++) {
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

  async onPairListDevices() {
    this.log("onPairListDevices called");
    try {
      const deviceId = crypto.randomUUID();
      const deviceName = 'CZ Spot Prices Device';
      this.log(`Device found: Name - ${deviceName}, ID - ${deviceId}`);
      return [{ name: deviceName, data: { id: deviceId } }];
    } catch (error) {
      this.error("Error during pairing:", error);
      throw error;
    }
  }

  async settingsChanged(data) {
    this.log("settingsChanged handler called with data:", data);
    try {
      this._logSettings(data);
      this._saveSettings(data);
      this.log("Settings successfully saved.");
    } catch (error) {
      this.error("Error saving settings:", error);
    }
  }

  _logSettings(data) {
    this.log("Saving settings:");
    this.log("Low Tariff Price:", data.low_tariff_price);
    this.log("High Tariff Price:", data.high_tariff_price);
    for (let i = 0; i < 24; i++) {
      this.log(`Hour ${i} Low Tariff:`, data[`hour_${i}`]);
    }
  }

  _saveSettings(data) {
    this.homey.settings.set('low_tariff_price', data.low_tariff_price);
    this.homey.settings.set('high_tariff_price', data.high_tariff_price);
    for (let i = 0; i < 24; i++) {
      this.homey.settings.set(`hour_${i}`, data[`hour_${i}`]);
    }
    this.tariffIntervals = data.tariff_intervals || [];
    this.log("Updated tariffIntervals:", this.tariffIntervals);
  }
}

module.exports = CZSpotPricesDriver;
