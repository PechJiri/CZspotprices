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
      this.log('Trigger Flow cards registered successfully.');
    } catch (error) {
      this.log('Error registering trigger Flow cards:', error);
    }
  }

  _registerConditionFlowCards() {
    this.log('Registering condition Flow cards...');
    try {
      this._registerConditionCard('price-lower-than-condition', 'measure_current_spot_price_CZK', '<');
      this._registerConditionCard('price-higher-than-condition', 'measure_current_spot_price_CZK', '>');
      this._registerConditionCard('price-index-is-condition', 'measure_current_spot_index', '=');
      this.log('Condition Flow cards registered successfully.');
    } catch (error) {
      this.log('Error registering condition Flow cards:', error);
    }
  }

  _registerConditionCard(cardId, capability, operator) {
    this.log(`Registering condition card ${cardId} with operator ${operator}...`);
    this.homey.flow.getConditionCard(cardId).registerRunListener(async (args, state) => {
      const device = state.device;
      const currentValue = await device.getCapabilityValue(capability);
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

  _registerActionFlowCards() {
    this.log('Registering action Flow cards...');
    try {
      this.homey.flow.getActionCard('update_data_via_api')
        .registerRunListener(async (args, state) => {
          this.log('Running action: Update data via API');
          const devices = this.getDevices();
          const promises = Object.values(devices).map(device => device.fetchAndUpdateSpotPrices());
          await Promise.all(promises);
          this.log('Data successfully updated via API.');
          return true; // Vše proběhlo úspěšně
        });
      this.log('Action Flow cards registered successfully.');
    } catch (error) {
      this.log('Error registering action Flow cards:', error);
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
      this.log("Error during pairing:", error);
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
