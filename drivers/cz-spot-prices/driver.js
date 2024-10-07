'use strict';

const Homey = require('homey');
const crypto = require('crypto'); // Importujeme knihovnu crypto

class CZSpotPricesDriver extends Homey.Driver {

  async onInit() {
    this.log('CZSpotPricesDriver has been initialized');
    this.tariffIntervals = this.homey.settings.get('tariff_intervals') || [];

    // Registrace Flow karet
    this.registerFlowCards();
  }

  registerFlowCards() {
    this._registerTriggerFlowCards();
    this._registerConditionFlowCards();
    this._registerActionFlowCards(); // Registrace THEN karet
  }

  _registerTriggerFlowCards() {
    this.log('Registering trigger Flow cards...');
    try {
      this.homey.flow.getTriggerCard('current-price-lower-than-trigger');
      this.homey.flow.getTriggerCard('current-price-higher-than-trigger');
      this.homey.flow.getTriggerCard('current-price-index-trigger');
      this.homey.flow.getTriggerCard('average-price-trigger').registerRunListener(async (args, state) => {
        const { hours, condition } = args;
        const currentHour = new Date().getHours();
        const device = state.device;
        const allCombinations = [];

        // Calculate average prices for each possible time period
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

        // Determine highest or lowest average based on the user's condition
        const sortedCombinations = allCombinations.sort((a, b) => a.avg - b.avg);
        const targetCombination = condition === 'lowest' ? sortedCombinations[0] : sortedCombinations[sortedCombinations.length - 1];

        // Check if current hour is within the best combination
        return currentHour >= targetCombination.startHour && currentHour < (targetCombination.startHour + hours);
      });
      this.log('Trigger Flow cards registered successfully.');
    } catch (error) {
      this.error('Error registering trigger Flow cards:', error);
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
      this.log(`Running condition card ${cardId} with capability ${capability}. Current value: ${currentValue}, Args value: ${args.value}, Operator: ${operator}`);
      
      switch(operator) {
        case '>':
          return currentValue > args.value;
        case '<':
          return currentValue < args.value;
        case '=':
        default:
          return currentValue === args.value;
      }
    });
  }

  _registerAveragePriceConditionCard() {
    this.log('Registering average price condition card...');
    this.homey.flow.getConditionCard('average-price-condition').registerRunListener(async (args, state) => {
      const { hours, condition } = args;
      const device = state.device;
      const allCombinations = [];

      // Calculate average prices for each possible time period
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

      // Determine highest or lowest average based on the user's condition
      const sortedCombinations = allCombinations.sort((a, b) => a.avg - b.avg);
      const targetCombination = condition === 'lowest' ? sortedCombinations[0] : sortedCombinations[sortedCombinations.length - 1];

      // Check if current hour is within the best combination
      const currentHour = new Date().getHours();
      return currentHour >= targetCombination.startHour && currentHour < (targetCombination.startHour + hours);
    });
  }

  _registerActionFlowCards() {
    this.log('Registering action Flow cards...');
    try {
      this.homey.flow.getActionCard('update_data_via_api')
        .registerRunListener(async (args, state) => {
          this.log('Running action: Update data via API');
          const devices = this.getDevices();
          const promises = Object.values(devices).map(async device => {
            try {
              await device.fetchAndUpdateSpotPrices();
            } catch (error) {
              this.error(`Error updating spot prices for device ${device.getName()}:`, error);
            }
          });
          await Promise.all(promises);
          this.log('Data successfully updated via API.');
          return true; // Vše proběhlo úspěšně
        });
      this.log('Action Flow cards registered successfully.');
    } catch (error) {
      this.error('Error registering action Flow cards:', error);
    }
  }

  async onPairListDevices() {
    this.log("onPairListDevices called");
    try {
      // Generujeme unikátní ID pomocí crypto.randomUUID()
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

    // Logování hodnot před uložením
    this.log("Saving settings:");
    this.log("Low Tariff Price:", data.low_tariff_price);
    this.log("High Tariff Price:", data.high_tariff_price);

    for (let i = 0; i < 24; i++) {
      this.log(`Hour ${i} Low Tariff:`, data[`hour_${i}`]);
    }

    // Uložení nastavení zařízení
    try {
      this.homey.settings.set('low_tariff_price', data.low_tariff_price);
      this.homey.settings.set('high_tariff_price', data.high_tariff_price);
      for (let i = 0; i < 24; i++) {
        this.homey.settings.set(`hour_${i}`, data[`hour_${i}`]);
      }

      this.tariffIntervals = data.tariff_intervals || [];
      this.log("Updated tariffIntervals:", this.tariffIntervals);

      this.log("Settings successfully saved.");
    } catch (error) {
      this.error("Error saving settings:", error);
    }
  }
}

module.exports = CZSpotPricesDriver;