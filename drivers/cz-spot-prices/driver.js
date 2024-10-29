'use strict';

const Homey = require('homey');
const crypto = require('crypto');
const SpotPriceAPI = require('./api');

class CZSpotPricesDriver extends Homey.Driver {

  async onInit() {
    this.spotPriceApi = new SpotPriceAPI(this.homey);
    this.tariffIntervals = this.homey.settings.get('tariff_intervals') || [];
    this.registerFlowCards();
    this.setupTariffCheck();
    this.setupMidnightUpdate();
  }

  setupMidnightUpdate() {
    const scheduleNextMidnight = () => {
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 5);

      const delay = tomorrow.getTime() - now.getTime();

      if (this.midnightTimeout) {
        this.homey.clearTimeout(this.midnightTimeout);
      }

      this.midnightTimeout = this.homey.setTimeout(() => {
        this.executeMidnightUpdate();
        scheduleNextMidnight();
      }, delay);
    };

    scheduleNextMidnight();
  }

  async executeMidnightUpdate(retryCount = 0) {
    const MAX_RETRIES = 5;
    const BASE_DELAY = 5 * 60 * 1000;
    
    const devices = this.getDevices();
    let success = true;

    for (const device of Object.values(devices)) {
      try {
        const updateResult = await this.tryUpdateDevice(device);
        if (!updateResult) {
          success = false;
        }
      } catch (error) {
        success = false;
        this.error(`Error updating device ${device.getName()}:`, error);
      }
    }

    if (!success && retryCount < MAX_RETRIES) {
      const delay = BASE_DELAY * Math.pow(2, retryCount);
      
      for (const device of Object.values(devices)) {
        await this.triggerAPIFailure(device, {
          primaryAPI: 'Update failed',
          backupAPI: 'Update failed',
          willRetry: true,
          retryCount: retryCount + 1,
          nextRetryIn: Math.round(delay / 60000)
        });
      }

      this.homey.setTimeout(() => {
        this.executeMidnightUpdate(retryCount + 1);
      }, delay);
    } else if (!success) {
      for (const device of Object.values(devices)) {
        await this.triggerAPIFailure(device, {
          primaryAPI: 'Update failed',
          backupAPI: 'Update failed',
          willRetry: false,
          maxRetriesReached: true
        });
      }
    }
  }

  async tryUpdateDevice(device) {
    let primaryError;
    try {
      try {
        await device.spotPriceApi.getDailyPrices(device);
        const valid = await this.validatePriceData(device);
        if (valid) {
          return true;
        }
        primaryError = new Error('Data validation failed');
      } catch (error) {
        primaryError = error;
      }

      try {
        await device.spotPriceApi.getBackupDailyPrices(device);
        const valid = await this.validatePriceData(device);
        if (valid) {
          return true;
        }
        throw new Error('Backup API data validation failed');
      } catch (backupError) {
        await this.triggerAPIFailure(device, {
          primaryAPI: primaryError?.message || 'Unknown error',
          backupAPI: backupError.message,
          willRetry: true
        });
        return false;
      }
    } catch (error) {
      this.error('Error in tryUpdateDevice:', error);
      return false;
    }
  }

  async validatePriceData(device) {
    try {
      for (let hour = 0; hour < 24; hour++) {
        const price = await device.getCapabilityValue(`hour_price_CZK_${hour}`);
        if (price === null || price === undefined || typeof price !== 'number' || !isFinite(price)) {
          return false;
        }
      }
      return true;
    } catch (error) {
      this.error('Error validating price data:', error);
      return false;
    }
  }

  async triggerAPIFailure(device, errorInfo) {
    try {
      const apiFailTrigger = this.homey.flow.getDeviceTriggerCard('when-api-call-fails-trigger');
      const tokens = {
        error_message: `Primary API: ${errorInfo.primaryAPI}, Backup API: ${errorInfo.backupAPI}`,
        will_retry: errorInfo.willRetry || false,
        retry_count: errorInfo.retryCount || 0,
        next_retry: errorInfo.nextRetryIn ? `${errorInfo.nextRetryIn} minutes` : 'No retry scheduled',
        max_retries_reached: errorInfo.maxRetriesReached || false
      };
  
      await apiFailTrigger.trigger(device, tokens)
        .catch(err => {
          this.error('Error triggering API failure:', err);
        });
    } catch (error) {
      this.error('Error in triggerAPIFailure:', error);
    }
  }

  setupTariffCheck() {
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
    const timeToNextHour = nextHour.getTime() - now.getTime();

    this.checkTariffChange();

    this.homey.setTimeout(() => {
      this.checkTariffChange();
      this.tariffCheckInterval = this.homey.setInterval(() => {
        this.checkTariffChange();
      }, 60 * 60 * 1000);
    }, timeToNextHour);
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

      this.homey.flow.getDeviceTriggerCard('when-api-call-fails-trigger')
        .registerRunListener(async (args, state) => args.type === state.type);

      this.homey.flow.getDeviceTriggerCard('when-current-price-changes')
        .registerRunListener(async () => true);

      this.tariffChangeTrigger = this.homey.flow.getDeviceTriggerCard('when-distribution-tariff-changes');
    } catch (error) {
      this.error('Error registering trigger Flow cards:', error);
    }
  }

  checkTariffChange() {
    const devices = this.getDevices();
    const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
    const currentHour = timeInfo.hour;

    for (const device of Object.values(devices)) {
      const previousTariff = device.getStoreValue('previousTariff');
      const currentTariff = this.isLowTariff(currentHour, device) ? 'low' : 'high';

      if (previousTariff !== currentTariff) {
        device.setStoreValue('previousTariff', currentTariff)
          .then(() => {
            return this.tariffChangeTrigger.trigger(device, { tariff: currentTariff });
          })
          .catch(error => {
            this.error('Error in tariff change process:', error);
          });
      }
    }
  }

  async _handleAveragePriceTrigger(args, state) {
    try {
      const { hours, condition } = args;
      const device = state.device;
      const timeInfo = device.spotPriceApi.getCurrentTimeInfo();
      const currentHour = timeInfo.hour;
      
      const allCombinations = await this._calculateAveragePrices(device, hours);
      const targetCombination = this._findTargetCombination(allCombinations, condition);
      
      return currentHour >= targetCombination.startHour && currentHour < (targetCombination.startHour + hours);
    } catch (error) {
      this.error('Error in average price trigger:', error);
      return false;
    }
  }

  _registerConditionFlowCards() {
    try {
      this._registerConditionCard('price-lower-than-condition', 'measure_current_spot_price_CZK', '<');
      this._registerConditionCard('price-higher-than-condition', 'measure_current_spot_price_CZK', '>');
      this._registerConditionCard('price-index-is-condition', 'measure_current_spot_index', '=');
      this._registerAveragePriceConditionCard();

      this.homey.flow.getConditionCard('distribution-tariff-is')
        .registerRunListener(async (args, state) => {
          const currentHour = new Date(new Date().toLocaleString('en-US', { timeZone: this.homey.clock.getTimezone() })).getHours();
          const device = args.device;
          const isLowTariff = this.isLowTariff(currentHour, device);
          return args.tariff === (isLowTariff ? 'low' : 'high');
        });
    } catch (error) {
      this.error('Error registering condition Flow cards:', error);
    }
  }

  _registerAveragePriceConditionCard() {
    this.homey.flow.getConditionCard('average-price-condition')
      .registerRunListener(async (args, state) => {
        try {
          const { hours, condition } = args;
          const device = args.device;
          const currentHour = new Date(new Date().toLocaleString('en-US', { timeZone: this.homey.clock.getTimezone() })).getHours();
  
          const allCombinations = await this._calculateAveragePrices(device, hours);
          const targetCombination = this._findTargetCombination(allCombinations, condition);
          return currentHour >= targetCombination.startHour && currentHour < (targetCombination.startHour + hours);
        } catch (error) {
          this.error('Error processing average price condition:', error);
          return false;
        }
      });
  }

  _registerConditionCard(cardId, capability, operator) {
    this.homey.flow.getConditionCard(cardId)
      .registerRunListener(async (args, state) => {
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

  _registerActionFlowCards() {
    try {
      this.homey.flow.getActionCard('update_data_via_api')
        .registerRunListener(async (args) => {
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
            const errorMessage = device.spotPriceApi.getErrorMessage(error);
            this.error(`Error updating daily prices for device ${device.getName()}:`, errorMessage);
            await device.setAvailable();
            device.spotPriceApi.triggerApiCallFail(errorMessage, device);
            return false;
          }
        });
    } catch (error) {
      this.error('Error registering action Flow cards:', error);
    }
  }

  async onPairListDevices() {
    try {
      const deviceId = crypto.randomUUID();
      return [{ name: 'CZ Spot Prices Device', data: { id: deviceId } }];
    } catch (error) {
      this.error("Error during pairing:", error);
      throw error;
    }
  }

  async settingsChanged(data) {
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
    const tariffSettings = [];
    for (let i = 0; i < 24; i++) {
      const isLowTariffHour = device.getSetting(`hour_${i}`);
      tariffSettings.push({ hour: i, isLowTariff: isLowTariffHour });
    }
  
    const tariffHours = tariffSettings
      .filter(setting => setting.isLowTariff)
      .map(setting => setting.hour);
  
    return tariffHours.includes(hour);
  }

  async triggerCurrentPriceChangedFlow(device, tokens) {
    const triggerCard = this.homey.flow.getDeviceTriggerCard('when-current-price-changes');
    try {
      await triggerCard.trigger(device, tokens);
    } catch (error) {
      this.error('Error triggering current price changed flow:', error);
    }
  }

  async onUninit() {
    if (this.tariffCheckInterval) {
      this.homey.clearInterval(this.tariffCheckInterval);
    }
    if (this.midnightTimeout) {
      this.homey.clearTimeout(this.midnightTimeout);
    }
  }
}

module.exports = CZSpotPricesDriver;