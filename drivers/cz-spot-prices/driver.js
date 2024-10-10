'use strict';

const Homey = require('homey');
const crypto = require('crypto');

class CZSpotPricesDriver extends Homey.Driver {

  async onInit() {
    console.log('CZSpotPricesDriver has been initialized');
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
    console.log('Registering trigger Flow cards...');
    try {
      ['current-price-lower-than-trigger', 'current-price-higher-than-trigger', 'current-price-index-trigger'].forEach(cardId => {
        this.homey.flow.getTriggerCard(cardId);
      });

      this.homey.flow.getTriggerCard('average-price-trigger')
        .registerRunListener(this._handleAveragePriceTrigger.bind(this));

      this.homey.flow.getTriggerCard('when-api-call-fails-trigger');
      console.log('Trigger Flow cards registered successfully.');
    } catch (error) {
      console.error('Error registering trigger Flow cards:', error);
    }
  }

  async _handleAveragePriceTrigger(args, state) {
    const { hours, condition } = args;
    const device = state.device;
    const currentHour = new Date().getHours();
  
    console.log(`Výpočet spuštěn s aktuální hodinou: ${currentHour}, interval: ${hours} hodin a podmínka: ${condition}`);
  
    const allCombinations = await this._calculateAveragePrices(device, hours);
    console.log('Vypočítané průměry pro všechny kombinace:', allCombinations.map(c => `Interval: ${c.startHour}-${c.startHour + hours}, Průměr: ${c.avg}, Startovní hodina: ${c.startHour}`).join(', '));

    const targetCombination = this._findTargetCombination(allCombinations, condition);
    console.log(`Zvolená kombinace pro '${condition}' podmínku: Interval ${targetCombination.startHour}-${targetCombination.startHour + hours}, Průměr: ${targetCombination.avg}`);
  
    const result = currentHour >= targetCombination.startHour && currentHour < (targetCombination.startHour + hours);
    console.log(`Výsledek: ${result ? 'true' : 'false'}, Startovní hodina pro výpočet: ${currentHour}`);
  
    return result;
  }

  _registerConditionFlowCards() {
    console.log('Registering condition Flow cards...');
    try {
      this._registerConditionCard('price-lower-than-condition', 'measure_current_spot_price_CZK', '<');
      this._registerConditionCard('price-higher-than-condition', 'measure_current_spot_price_CZK', '>');
      this._registerConditionCard('price-index-is-condition', 'measure_current_spot_index', '=');
      this._registerAveragePriceConditionCard();
      console.log('Condition Flow cards registered successfully.');
    } catch (error) {
      console.error('Error registering condition Flow cards:', error);
    }
  }

  _registerConditionCard(cardId, capability, operator) {
    console.log(`Registering condition card ${cardId} with operator ${operator}...`);
    this.homey.flow.getConditionCard(cardId).registerRunListener(async (args, state) => {
      const device = state.device;
      const currentValue = await device.getCapabilityValue(capability);
      if (currentValue === null || currentValue === undefined) {
        throw new Error(`Capability value for ${capability} is not available`);
      }
      console.log(`Running condition card ${cardId}. Current value: ${currentValue}, Args value: ${args.value}, Operator: ${operator}`);
      
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
    
        console.log(`Podmínka spuštěna od hodiny: ${currentHour}, interval hodin: ${hours}, podmínka: ${condition}`);
    
        try {
          const allCombinations = await this._calculateAveragePrices(device, hours);
    
          allCombinations.forEach(c => {
            console.log(`Kombinace: Interval ${c.startHour}-${(c.startHour + hours) % 24}, Průměr: ${c.avg}`);
          });
    
          const targetCombination = this._findTargetCombination(allCombinations, condition);
          console.log(`Zvolená kombinace pro '${condition}': Interval ${targetCombination.startHour}-${(targetCombination.startHour + hours) % 24}, Průměr: ${targetCombination.avg}`);
    
          let total = 0;
          for (let i = 0; i < hours; i++) {
            const hourIndex = (currentHour + i) % 24;
            const price = await device.getCapabilityValue(`hour_price_CZK_${hourIndex}`);
            if (price === null || price === undefined) {
              console.log(`Chybějící data pro hodinu ${hourIndex}`);
              throw new Error(`Missing price data for hour ${hourIndex}`);
            }
            total += price;
          }
          const currentAvg = total / hours;
          console.log(`Průměrná cena pro interval od hodiny ${currentHour} (${currentHour}-${(currentHour + hours) % 24}): ${currentAvg}`);
    
          const result = currentHour >= targetCombination.startHour && currentHour < (targetCombination.startHour + hours);
          console.log(`Výsledek podmínky: ${result ? 'true' : 'false'}, Startovní hodina: ${currentHour}, Interval hodin: ${hours}`);
    
          return result;
        } catch (error) {
          console.error('Chyba při zpracování podmínky průměrné ceny:', error);
          return false;
        }
      });
  }

  _registerActionFlowCards() {
    console.log('Registering action Flow cards...');
    try {
      this.homey.flow.getActionCard('update_data_via_api')
        .registerRunListener(async (args, state) => {
          console.log('Running action: Update data via API');
          const device = args.device;
          if (!device) {
            console.error('No device provided for update_data_via_api action');
            return false;
          }
          console.log(`Updating data for device: ${device.getName()}`);
          try {
            await device.fetchAndUpdateSpotPrices();
            device.setAvailable();
            console.log(`Data successfully updated for device: ${device.getName()}`);
            return true;
          } catch (error) {
            const errorMessage = this.getErrorMessage(error);
            console.error(`Error updating spot prices for device ${device.getName()}: ${errorMessage}`);
            console.error('Detailed error object:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
            device.setAvailable();
            console.log('Device set to available despite update failure');
            device.spotPriceApi.triggerApiCallFail(errorMessage, device);
            return false;
          }
        });
      console.log('Action Flow cards registered successfully.');
    } catch (error) {
      console.error('Error registering action Flow cards:', error);
    }
  }

  async _calculateAveragePrices(device, hours) {
    const currentHour = new Date().getHours();
    const allCombinations = [];
    
    console.log(`Začínáme výpočet od aktuální hodiny: ${currentHour} s intervalem: ${hours} hodin`);
  
    for (let startHour = currentHour; startHour <= 24 - hours; startHour++) {
      let total = 0;
  
      for (let i = startHour; i < startHour + hours; i++) {
        const price = await device.getCapabilityValue(`hour_price_CZK_${i}`);
        if (price === null || price === undefined) {
          console.log(`Chybějící data pro hodinu ${i}`);
          throw new Error(`Missing price data for hour ${i}`);
        }
        total += price;
      }
  
      const avg = total / hours;
      console.log(`Interval ${startHour}-${startHour + hours}, Průměr: ${avg}`);
      allCombinations.push({ startHour, avg });
    }
  
    return allCombinations;
  }
  
  _findTargetCombination(combinations, condition) {
    const sortedCombinations = combinations.sort((a, b) => a.avg - b.avg);
    const target = condition === 'lowest' ? sortedCombinations[0] : sortedCombinations[sortedCombinations.length - 1];
    
    console.log(`Vybraná kombinace pro '${condition}': Interval ${target.startHour}-${target.startHour + sortedCombinations.length}, Průměr: ${target.avg}`);
    
    return target;
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
          console.log(`Spouštím trigger pro ${condition} průměrnou cenu`);
          const triggerCard = this.homey.flow.getTriggerCard('average-price-trigger');
          try {
            await triggerCard.trigger(device, { hours: hours, condition: condition });
            console.log('Average price trigger fired successfully');
          } catch (err) {
            console.error('Error triggering average price:', err);
          }
        }
      }
    }
  }

  startPeriodicCheck() {
    this.homey.setInterval(this._checkAndTriggerAveragePrice.bind(this), 60 * 60 * 1000); // každou hodinu
  }

  async onPairListDevices() {
    console.log("onPairListDevices called");
    try {
      const deviceId = crypto.randomUUID();
      const deviceName = 'CZ Spot Prices Device';
      console.log(`Device found: Name - ${deviceName}, ID - ${deviceId}`);
      return [{ name: deviceName, data: { id: deviceId } }];
    } catch (error) {
      console.error("Error during pairing:", error);
      throw error;
    }
  }

  async settingsChanged(data) {
    console.log("settingsChanged handler called with data:", data);
    try {
      this._logSettings(data);
      this._saveSettings(data);
      console.log("Settings successfully saved.");
    } catch (error) {
      console.error("Error saving settings:", error);
    }
  }

  _logSettings(data) {
    console.log("Saving settings:");
    console.log("Low Tariff Price:", data.low_tariff_price);
    console.log("High Tariff Price:", data.high_tariff_price);
    for (let i = 0; i < 24; i++) {
      console.log(`Hour ${i} Low Tariff:`, data[`hour_${i}`]);
    }
  }

  _saveSettings(data) {
    this.homey.settings.set('low_tariff_price', data.low_tariff_price);
    this.homey.settings.set('high_tariff_price', data.high_tariff_price);
    for (let i = 0; i < 24; i++) {
      this.homey.settings.set(`hour_${i}`, data[`hour_${i}`]);
    }
    this.tariffIntervals = data.tariff_intervals || [];
    console.log("Updated tariffIntervals:", this.tariffIntervals);
  }
}

module.exports = CZSpotPricesDriver;