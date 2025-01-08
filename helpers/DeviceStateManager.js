'use strict';

const Logger = require('./Logger');

class DeviceStateManager {
    static instance = null;
    static CONTEXT = 'DeviceStateManager';

    static getInstance(homey) {
        if (!DeviceStateManager.instance) {
            DeviceStateManager.instance = new DeviceStateManager(homey);
        }
        return DeviceStateManager.instance;
    }

    constructor(homey) {
        if (DeviceStateManager.instance) {
            throw new Error('Použijte DeviceStateManager.getInstance()');
        }
        
        this.homey = homey;
        this.logger = Logger.getInstance();
    }

    static setHomeyInstance(homey) {
        if (!homey) {
            throw new Error('Homey instance je vyžadována pro DeviceStateManager');
        }
        DeviceStateManager.homeyInstance = homey;
    }

    getCapabilityManager() {
        if (!this._capabilityManager) {
            const CapabilityManager = require('./CapabilityManager');
            this._capabilityManager = CapabilityManager.getInstance(this.homey);
        }
        return this._capabilityManager;
    }

    async initializeDeviceState(device) {
        try {
            await this.initializeBasicSettings(device);
            await this.loadInitialData(device);
            await device.setupScheduledTasks(false);
            
            device.isInitialized = true;
            this.logger.log('Inicializace zařízení dokončena', {
                deviceId: device.getData().id,
                name: device.getName()
            });
        } catch (error) {
            device.isInitialized = false;
            this.logger.error('Selhání inicializace zařízení', error);
            await device.setUnavailable(`Initialization failed: ${error.message}`);
            throw error;
        }
    }

    async initializeBasicSettings(device) {
        try {
            await this.initializeDeviceId(device);
            await this.loadAndApplySettings(device);
            await this.setInitialTariff(device);
        } catch (error) {
            this.logger.error('Chyba při inicializaci základních nastavení', error);
            throw error;
        }
    }

    async initializeDeviceId(device) {
        const deviceId = device.getData().id || await device.getStoreValue('device_id');
        
        if (!deviceId) {
            const newDeviceId = device.homey.util.generateUniqueId();
            await device.setStoreValue('device_id', newDeviceId);
            this.logger.log('Vygenerováno nové ID zařízení', { newDeviceId });
        }
    }

    async loadAndApplySettings(device) {
        try {
            device.lowIndexHours = device.getSetting('low_index_hours') || 8;
            device.highIndexHours = device.getSetting('high_index_hours') || 8;
            device.priceInKWh = device.getSetting('price_in_kwh') || false;

            this.logger.debug('Nastavení zařízení načtena', {
                lowIndexHours: device.lowIndexHours,
                highIndexHours: device.highIndexHours,
                priceInKWh: device.priceInKWh
            });
        } catch (error) {
            this.logger.error('Chyba při načítání nastavení', error);
            throw error;
        }
    }

    async setInitialTariff(device) {
        try {
            await device.tariffCalculator.initializeInitialTariff(device);
            this.logger.log('Počáteční tarif nastaven');
        } catch (error) {
            this.logger.error('Chyba při nastavení počátečního tarifu', error);
            throw error;
        }
    }

    async loadInitialData(device) {
        const lastUpdate = await device.getStoreValue('lastDataUpdate');
        const now = Date.now();

        if (!lastUpdate || (now - lastUpdate > 15 * 60 * 1000)) {
            return await this.performInitialDataFetch(device);
        }

        this.logger.log('Použití cached dat');
        return true;
    }

    async performInitialDataFetch(device, maxRetries = 3) {
        let retryCount = 0;

        while (retryCount < maxRetries) {
            try {
                await device.initialDataFetch();
                await device.setStoreValue('lastDataUpdate', Date.now());
                return true;
            } catch (error) {
                retryCount++;
                this.logger.error(`Pokus ${retryCount} selhal`, error);
                
                if (retryCount === maxRetries) {
                    throw new Error('Max retries reached for initial data fetch');
                }
                
                await new Promise(resolve => setTimeout(resolve, 5000 * retryCount));
            }
        }
    }

    async resetDeviceState(device) {
        try {
            this.logger.log('Začátek resetu stavu zařízení');

            // Vyčištění cache
            device.cacheManager.clearAll();

            // Reset capabilities na null
            await this.resetAllCapabilities(device);

            // Reset stavových flagů
            await Promise.all([
                device.setCapabilityValue('spot_price_update_status', false),
                device.setCapabilityValue('primary_api_fail', true)
            ]);

            // Nová aktualizace dat
            await device.fetchAndUpdateSpotPrices();

            this.logger.log('Reset stavu zařízení dokončen');
            return true;
        } catch (error) {
            this.logger.error('Chyba při resetu stavu zařízení', error);
            return false;
        }
    }

    async resetAllCapabilities(device) {
        const capabilities = device.getCapabilities();
        await Promise.all(
            capabilities.map(capability => 
                device.setCapabilityValue(capability, null)
                    .catch(error => this.logger.error(`Chyba při resetu capability ${capability}`, error))
            )
        );
    }

    async cleanupDeviceState(device) {
        try {
            device.isInitialized = false;
            
            await this.cleanupComponents(device);
            await this.cleanupStoreValues(device);
            if (this.getCapabilityManager()) {
                await this.getCapabilityManager().resetDeviceCapabilities(device);
            }
            this.cleanupEventListeners(device);
            this.cleanupReferences(device);
    
            this.logger.log('Úklid zařízení dokončen', {
                deviceId: device.getData().id
            });
        } catch (error) {
            this.logger.error('Chyba při úklidu zařízení', error);
        }
    }

    async cleanupComponents(device) {
        const components = {
            // Základní helpery
            spotPriceApi: () => {
                if (device.spotPriceApi) {
                    // Specifický cleanup pro SpotPriceAPI
                    device.spotPriceApi = null;
                }
            },
            intervalManager: () => {
                if (device.intervalManager) {
                    device.intervalManager.clearAll();
                    device.intervalManager = null;
                }
            },
            priceCalculator: () => {
                if (device.priceCalculator) {
                    // Případný cleanup specifický pro PriceCalculator
                    device.priceCalculator = null;
                }
            },
            lockManager: () => {
                if (device.lockManager) {
                    device.lockManager.clearAllLocks();
                    device.lockManager = null;
                }
            },
            tariffCalculator: () => {
                if (device.tariffCalculator) {
                    // Případný cleanup specifický pro TariffCalculator
                    device.tariffCalculator = null;
                }
            },
            priceCalculationEngine: () => {
                if (device.priceCalculationEngine) {
                    // Případný cleanup specifický pro PriceCalculationEngine
                    device.priceCalculationEngine = null;
                }
            },
            dataValidator: () => {
                if (device.dataValidator) {
                    // Případný cleanup specifický pro DataValidator
                    device.dataValidator = null;
                }
            },
            cacheManager: () => {
                if (device.cacheManager) {
                    device.cacheManager.clearAll();
                    device.cacheManager = null;
                }
            },
            capabilityManager: () => {
                if (device.capabilityManager) {
                    // Případný cleanup specifický pro CapabilityManager
                    device.capabilityManager = null;
                }
            },
    
            // Flow manažery
            actionsManager: () => {
                if (device.actionsManager) {
                    device.actionsManager.destroy();
                    device.actionsManager = null;
                }
            },
            conditionsManager: () => {
                if (device.conditionsManager) {
                    device.conditionsManager.destroy();
                    device.conditionsManager = null;
                }
            },
            triggersManager: () => {
                if (device.triggersManager) {
                    device.triggersManager.destroy();
                    device.triggersManager = null;
                }
            },
    
            // Logger - jako poslední, aby mohl logovat cleanup ostatních komponent
            logger: () => {
                if (device.logger) {
                    device.logger.debug('Logger cleanup starting');
                    // Případný cleanup specifický pro Logger
                    device.logger = null;
                }
            }
        };
    
        // Postupné čištění všech komponent
        for (const [name, cleanup] of Object.entries(components)) {
            try {
                await cleanup();
                // Použijeme this.logger místo device.logger, protože device.logger může být už vyčištěn
                this.logger?.debug(`Komponenta ${name} vyčištěna`);
            } catch (error) {
                this.logger?.error(`Chyba při čištění komponenty ${name}`, error);
            }
        }
    }

    async cleanupStoreValues(device) {
        const storeKeys = [
            // Základní identifikace
            'device_id',
            
            // Tarifní informace
            'previousTariff',
            
            // Časové značky aktualizací
            'lastDataUpdate',
            'lastMidnightUpdate',
            'lastHourlyUpdate',
            'lastAverageUpdate',
            
            // Stavové příznaky
            'firstInit',
            'updatingLock',
            
            // Cached hodnoty
            'lastPrices',      // Cache posledních cen
            'lastIndexes',     // Cache posledních indexů
            'lastSettings',    // Cache posledních nastavení
            
            // Flow hodnoty
            'lastTriggerState' // Stav posledního triggeru
        ];
    
        for (const key of storeKeys) {
            try {
                await device.unsetStoreValue(key);
                this.logger.debug(`Store hodnota ${key} vymazána`, {
                    deviceId: device.getData().id,
                    key
                });
            } catch (error) {
                if (error.code === 404) {
                    this.logger.debug(`Store hodnota ${key} již neexistuje`, {
                        deviceId: device.getData().id,
                        key
                    });
                } else {
                    this.logger.error(`Chyba při mazání store hodnoty ${key}`, error, {
                        deviceId: device.getData().id,
                        key
                    });
                }
            }
        }
    
        this.logger.log('Všechny store hodnoty vyčištěny', {
            deviceId: device.getData().id,
            keyCount: storeKeys.length
        });
    }

    cleanupEventListeners(device) {
        device.homey.removeAllListeners('spot_prices_updated');
        device.homey.removeAllListeners('settings_changed');
        this.logger.debug('Event listenery odstraněny');
    }

    cleanupReferences(device) {
        const references = [
            // Základní helpery
            'spotPriceApi',
            'intervalManager', 
            'priceCalculator',
            'lockManager',
            'tariffCalculator',
            'priceCalculationEngine',
            'dataValidator',
            'cacheManager',
            'capabilityManager',
            'deviceStateManager',
            
            // Flow manažery
            'actionsManager',
            'conditionsManager',
            'triggersManager',
            
            // Logger
            'logger',
    
            // Interní proměnné
            'lowIndexHours',
            'highIndexHours',
            'priceInKWh',
            'isInitialized',
            'lastCalculationHour',
            'homeyTimezone',
            'baseUrl',
            'exchangeRate',
            'lastRateUpdate'
        ];
    
        for (const ref of references) {
            try {
                if (device[ref] !== undefined) {
                    // Logujeme stav před vyčištěním pro debugging
                    this.logger.debug(`Čištění reference: ${ref}`, {
                        deviceId: device.getData().id,
                        hadValue: device[ref] !== null,
                        type: typeof device[ref]
                    });
                    
                    device[ref] = null;
                }
            } catch (error) {
                this.logger.error(`Chyba při čištění reference ${ref}`, error, {
                    deviceId: device.getData().id
                });
            }
        }
    
        // Kontrola po vyčištění
        const remainingRefs = references.filter(ref => device[ref] !== null);
        if (remainingRefs.length > 0) {
            this.logger.warn('Některé reference nebyly vyčištěny', {
                deviceId: device.getData().id,
                remainingRefs
            });
        } else {
            this.logger.log('Všechny reference úspěšně vyčištěny', {
                deviceId: device.getData().id,
                referencesCount: references.length
            });
        }
    }

    /**
     * Emituje událost aktualizace cen
     * @param {Device} device - Instance zařízení
     * @param {Object} updateData - Data k emitování
     */
    async emitPriceUpdate(device, updateData) {
        try {
            await device.homey.emit('spot_prices_updated', {
                ...updateData,
                timestamp: Date.now()
            });

            this.logger?.debug('Price update událost emitována', {
                deviceId: device.getData().id,
                data: updateData
            });
        } catch (error) {
            this.logger?.error('Chyba při emitování price update události', error, {
                deviceId: device.getData().id
            });
            // Nechceme zde házet error, protože selhání emitu události
            // by nemělo ovlivnit hlavní funkcionalitu
        }
    }
}

module.exports = DeviceStateManager;