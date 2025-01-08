'use strict';

const Logger = require('./Logger');
const LockManager = require('./LockManager');
const DeviceStateManager = require('./DeviceStateManager')

class CapabilityManager {
   static instance = null;
   static CONTEXT = 'CapabilityManager';

   static getInstance(homey) {
       if (!CapabilityManager.instance) {
           CapabilityManager.instance = new CapabilityManager(homey);
       }
       return CapabilityManager.instance;
   }

   constructor(homeyInstance) {
       if (CapabilityManager.instance) {
           throw new Error('Použijte CapabilityManager.getInstance()');
       }
       this.homey = homeyInstance;
       this.logger = Logger.getInstance();
       this.LockManager = LockManager.getInstance()
       this.deviceStateManager = DeviceStateManager.getInstance();
    }

   static setHomeyInstance(homey) {
       if (!homey) {
           throw new Error('Homey instance je vyžadována pro CapabilityManager');
       }
       CapabilityManager.homeyInstance = homey;
   }

   async updateHourlyCapabilities(device, pricesWithIndexes) {
       const currentPriceInKWh = device.priceInKWh;

       const updatePromises = pricesWithIndexes.map(async priceData => {
           const convertedPrice = device.priceCalculationEngine.convertPrice(
               priceData.priceCZK,
               currentPriceInKWh
           );

           this.logger?.debug('Aktualizuji capability', {
               hour: priceData.hour,
               price: convertedPrice,
               level: priceData.level
           });

           return Promise.all([
               device.setCapabilityValue(`hour_price_CZK_${priceData.hour}`, convertedPrice),
               device.setCapabilityValue(`hour_price_index_${priceData.hour}`, priceData.level)
           ]).catch(err => {
               this.logger?.error('Chyba při aktualizaci hodinových capabilities', err);
               throw err;
           });
       });

       return Promise.all(updatePromises);
   }

   async updateCurrentAndNextHourPrices(device, pricesWithIndexes) {
       try {
           if (!device.spotPriceApi) {
               throw new Error('SpotPriceApi není inicializován');
           }

           const { hour: currentHour } = device.spotPriceApi.getCurrentTimeInfo();
           const nextHour = (currentHour + 1) % 24;
           const currentPriceInKWh = device.priceInKWh;

           this.logger?.debug('Začátek aktualizace current a next hour price', {
               currentHour,
               nextHour,
               priceInKWh: currentPriceInKWh
           });

           if (!Array.isArray(pricesWithIndexes)) {
               throw new Error('Neplatná vstupní data - není pole');
           }

           const currentHourData = pricesWithIndexes.find(price => price.hour === currentHour);
           const nextHourData = pricesWithIndexes.find(price => price.hour === nextHour);

           if (!currentHourData) {
               this.logger?.error('Nenalezena data pro aktuální hodinu', {
                   hour: currentHour,
                   availableHours: pricesWithIndexes.map(p => p.hour).join(', ')
               });
               throw new Error(`Nenalezena data pro aktuální hodinu ${currentHour}`);
           }

           const validIndexes = ['low', 'medium', 'high', 'unknown'];
           const currentIndex = currentHourData.level && validIndexes.includes(currentHourData.level) 
               ? currentHourData.level 
               : 'unknown';

           const convertedCurrentPrice = device.priceCalculationEngine.convertPrice(
               currentHourData.priceCZK,
               currentPriceInKWh
           );

           const convertedNextPrice = nextHourData ? 
               device.priceCalculationEngine.convertPrice(nextHourData.priceCZK, currentPriceInKWh) : 
               null;

           this.logger?.debug('Zpracování dat před aktualizací', {
               currentHour,
               currentPrice: convertedCurrentPrice,
               normalizedIndex: currentIndex,
               nextHour,
               nextPrice: convertedNextPrice,
               priceInKWh: currentPriceInKWh
           });

           const updatePromises = [
               device.setCapabilityValue('measure_current_spot_price_CZK', convertedCurrentPrice),
               device.setCapabilityValue('measure_current_spot_index', currentIndex)
           ];

           if (convertedNextPrice !== null) {
               updatePromises.push(
                   device.setCapabilityValue('measure_next_hour_price', convertedNextPrice)
               );
           }

           await Promise.all(updatePromises).catch(err => {
               this.logger?.error('Chyba při aktualizaci capabilities', err);
               throw err;
           });

           this.logger?.debug('Aktuální a následující ceny aktualizovány', {
               currentHour,
               currentPrice: convertedCurrentPrice,
               currentIndex,
               nextHour,
               nextPrice: convertedNextPrice
           });

           return { currentPrice: convertedCurrentPrice, currentIndex, nextPrice: convertedNextPrice };

       } catch (error) {
           this.logger?.error('Chyba při aktualizaci aktuální a následující ceny', error);
           throw error;
       }
   }

   async updateDailyAverage(device, pricesWithIndexes) {
       try {
           const currentPriceInKWh = device.priceInKWh;
           const totalPrice = pricesWithIndexes.reduce((sum, price) => sum + price.priceCZK, 0);
           const averagePrice = device.priceCalculationEngine.convertPrice(
               totalPrice / pricesWithIndexes.length,
               currentPriceInKWh
           );

           this.logger?.debug('Vypočítaná průměrná cena', {
               totalPrice,
               averagePrice,
               priceInKWh: currentPriceInKWh
           });

           await device.setCapabilityValue('daily_average_price', averagePrice)
               .catch(err => {
                   this.logger?.error('Chyba při aktualizaci průměrné ceny', err);
                   throw err;
               });

           this.logger?.log('Denní průměrná cena aktualizována', { averagePrice });

           return averagePrice;
       } catch (error) {
           this.logger?.error('Chyba při aktualizaci denního průměru', error);
           throw error;
       }
   }

   async updateMinMaxPrices(device, pricesWithIndexes) {
       try {
           const currentPriceInKWh = device.priceInKWh;

           this.logger?.debug('Začátek aktualizace min/max cen', {
               priceInKWh: currentPriceInKWh,
               počet_cen: pricesWithIndexes.length
           });

           const prices = pricesWithIndexes.map(p => p.priceCZK);
           const minRawPrice = Math.min(...prices);
           const maxRawPrice = Math.max(...prices);

           const convertedMinPrice = device.priceCalculationEngine.convertPrice(minRawPrice, currentPriceInKWh);
           const convertedMaxPrice = device.priceCalculationEngine.convertPrice(maxRawPrice, currentPriceInKWh);

           await Promise.all([
               device.setCapabilityValue('measure_today_min_price', convertedMinPrice),
               device.setCapabilityValue('measure_today_max_price', convertedMaxPrice)
           ]).catch(err => {
               this.logger?.error('Chyba při aktualizaci min/max capabilities', err);
               throw err;
           });

           this.logger?.debug('Min/max ceny aktualizovány', {
               min: convertedMinPrice,
               max: convertedMaxPrice,
               rawMin: minRawPrice,
               rawMax: maxRawPrice
           });

           return { minPrice: convertedMinPrice, maxPrice: convertedMaxPrice };

       } catch (error) {
           this.logger?.error('Chyba při aktualizaci min/max cen', error);
           throw error;
       }
   }

   async registerDeviceCapabilities(device) {
    const capabilities = [
        'measure_current_spot_price_CZK',
        'measure_current_spot_index',
        'measure_today_min_price',
        'measure_today_max_price',
        'measure_next_hour_price',
        'daily_average_price',
        'primary_api_fail',
        'spot_price_update_status',
        ...Array.from({ length: 24 }, (_, i) => [
            `hour_price_CZK_${i}`, 
            `hour_price_index_${i}`
        ]).flat()
        ];

        for (const capability of capabilities) {
            if (!device.hasCapability(capability)) {
            try {
                await device.addCapability(capability);
                this.logger?.log(`Capability ${capability} added successfully.`);
            } catch (error) {
                this.logger?.error(`Failed to add capability ${capability}`, error);
            }
            }
        }
    }

    async resetDeviceCapabilities(device) {
        try {
            const capabilities = device.getCapabilities();
            await Promise.all(capabilities.map(capability => 
                device.setCapabilityValue(capability, null)
            ));
            await device.setCapabilityValue('spot_price_update_status', false);
            await device.setCapabilityValue('primary_api_fail', true);
            
            return true;
        } catch (error) {
            this.logger?.error('Error resetting capabilities', error);
            return false;
        }
    }

    async updateAllPrices(device, processedPrices) {
        const operationId = `update-${Date.now()}`;
        
        try {
            const lockAcquired = await this.LockManager.acquireLock(device, operationId);
            if (!lockAcquired) {
                this.logger?.warn('Nelze získat zámek pro aktualizaci capabilities', {
                    deviceId: device.getData().id,
                    operationId
                });
                return false;
            }
    
            try {
                // Využití DataValidatoru pro validaci dat
                const validationResult = device.dataValidator.validatePriceIndexData(
                    processedPrices,
                    device.settingsManager.getLowIndexHours(device),
                    device.settingsManager.getHighIndexHours(device)
                );
    
                if (!validationResult.isValid) {
                    throw new Error(`Neplatná vstupní data: ${validationResult.errors.join(', ')}`);
                }
    
                // Nastavení indexů podle aktuálních nastavení
                const settings = device.settingsManager.getDeviceSettings(device);
                const pricesWithIndexes = device.priceCalculator.setPriceIndexes(
                    processedPrices,
                    settings.lowIndexHours,
                    settings.highIndexHours
                );
    
                // Aktualizace všech capabilities najednou
                await this.updatePriceCapabilities(device, pricesWithIndexes);
                
                this.logger?.debug('Capabilities aktualizovány', {
                    deviceId: device.getData().id,
                    pricesCount: processedPrices.length
                });
    
                // Nastavení status flagů
                await this.setStatusFlags(device, {
                    updateStatus: true,
                    apiFailure: false
                });
    
                // Nastavení dostupnosti zařízení
                await device.setAvailable();
    
                // Emit událostí
                if (!this.deviceStateManager) {
                    throw new Error('DeviceStateManager není inicializován');
                }

                await this.deviceStateManager.emitPriceUpdate(device, {
                    deviceId: device.getData().id,
                    currentPrice: await device.getCapabilityValue('measure_current_spot_price_CZK'),
                    currentIndex: await device.getCapabilityValue('measure_current_spot_index'),
                    averagePrice: await device.getCapabilityValue('daily_average_price')
                });
    
                return true;
    
            } finally {
                await this.LockManager.releaseLock(device, operationId);
            }
    
        } catch (error) {
            await this.handleCapabilityError(device, operationId, error);
            throw error;
        }
    }
    
    async updatePriceCapabilities(device, pricesWithIndexes) {
        try {
            // Validace cen před aktualizací capabilities
            if (!device.dataValidator.validatePriceData(pricesWithIndexes)) {
                throw new Error('Neplatná data pro aktualizaci capabilities');
            }
    
            const updateTasks = [
                this.updateHourlyCapabilities(device, pricesWithIndexes),
                this.updateCurrentAndNextHourPrices(device, pricesWithIndexes),
                this.updateMinMaxPrices(device, pricesWithIndexes),
                this.updateDailyAverage(device, pricesWithIndexes)
            ];
    
            const results = await Promise.all(updateTasks);
    
            this.logger?.debug('Cenové capabilities aktualizovány', {
                deviceId: device.getData().id,
                updates: {
                    hourly: results[0],
                    current: results[1],
                    minMax: results[2],
                    average: results[3]
                }
            });
    
            return true;
        } catch (error) {
            this.logger?.error('Chyba při aktualizaci capabilities', error, {
                deviceId: device.getData().id
            });
            throw error;
        }
    }

    /**
     * Nastaví status flagy zařízení
     * @param {Device} device - Instance zařízení
     * @param {Object} flags - Objekt s flagy ke změně
     * @param {boolean} flags.updateStatus - Status updatu
     * @param {boolean} flags.apiFailure - Status API chyby
     */
    async setStatusFlags(device, { updateStatus, apiFailure }) {
        try {
            await Promise.all([
                device.setCapabilityValue('spot_price_update_status', updateStatus),
                device.setCapabilityValue('primary_api_fail', apiFailure)
            ]);

            this.logger?.debug('Status flagy nastaveny', {
                deviceId: device.getData().id,
                updateStatus,
                apiFailure
            });
        } catch (error) {
            this.logger?.error('Chyba při nastavování status flagů', error, {
                deviceId: device.getData().id
            });
            throw error;
        }
    }

    async handleCapabilityError(device, operationId, error) {
        try {
            this.logger?.error('Chyba při aktualizaci capabilities', error, {
                deviceId: device.getData().id,
                operationId
            });
    
            // Nastavení chybových flagů
            await this.setStatusFlags(device, {
                updateStatus: false,
                apiFailure: true
            });
    
            // Pokud má device metodu triggerAPIFailure, použijeme ji
            if (device.triggerAPIFailure) {
                await device.triggerAPIFailure({
                    primaryAPI: error.message,
                    backupAPI: '',
                    willRetry: false,
                    maxRetriesReached: true
                });
            }
        } catch (handlingError) {
            this.logger?.error('Chyba při zpracování capability erroru', handlingError);
        }
    }
}

module.exports = CapabilityManager;