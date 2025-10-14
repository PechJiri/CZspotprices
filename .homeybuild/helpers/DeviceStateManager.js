'use strict';

const Logger = require('./Logger');

/**
 * DeviceStateManager - správa životního cyklu device
 * 
 * ZODPOVĚDNOSTI:
 * - Inicializace device při startu
 * - Načítání a ukládání nastavení
 * - Reset stavu device
 * - Cleanup při odstranění device
 * 
 * @class DeviceStateManager
 * @singleton
 */
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
        
        this.logger?.debug('DeviceStateManager inicializován');
    }

    static setHomeyInstance(homey) {
        if (!homey) {
            throw new Error('Homey instance je vyžadována pro DeviceStateManager');
        }
        DeviceStateManager.homeyInstance = homey;
    }

    // ==================== LAZY DEPENDENCIES ====================

    /**
     * Lazy loading CapabilityManager
     * @returns {CapabilityManager}
     */
    getCapabilityManager() {
        if (!this._capabilityManager) {
            const CapabilityManager = require('./CapabilityManager');
            this._capabilityManager = CapabilityManager.getInstance(this.homey);
        }
        return this._capabilityManager;
    }

    // ==================== INICIALIZACE DEVICE ====================

    /**
     * Inicializuje device při startu
     * 
     * POSTUP:
     * 1. Základní nastavení (ID, settings, tarif)
     * 2. Načtení dat (z cache nebo API)
     * 3. Naplánování úloh (15min update, midnight update)
     * 
     * @param {Device} device - instance device
     * @throws {Error} pokud inicializace selže
     */
    async initializeDeviceState(device) {
        try {
            await this.initializeBasicSettings(device);
            await this.loadInitialData(device);
            await device.setupScheduledTasks(false);
            
            device.isInitialized = true;
            this.logger.debug('Inicializace zařízení dokončena', {
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

    /**
     * Inicializuje základní nastavení device
     * 
     * @param {Device} device - instance device
     */
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

    /**
     * Inicializuje nebo načte device ID
     * 
     * PRIORITA:
     * 1. ID z device.getData() (z párování)
     * 2. ID ze store
     * 3. Nové UUID (fallback)
     * 
     * @param {Device} device - instance device
     * @returns {string} device ID
     */
    async initializeDeviceId(device) {
        try {
            // 1. Nejprve zkus ID z párování
            const deviceId = device.getData()?.id;
            
            if (deviceId) {
                await device.setStoreValue('device_id', deviceId);
                this.logger.debug('Použito existující ID zařízení z párování', { deviceId });
                return deviceId;
            }
    
            // 2. Zkus ID ze store
            const storedId = await device.getStoreValue('device_id');
            if (storedId) {
                this.logger.debug('Použito ID ze store', { deviceId: storedId });
                return storedId;
            }
    
            // 3. Fallback - vygeneruj nové UUID
            const newDeviceId = crypto.randomUUID();
            await device.setStoreValue('device_id', newDeviceId);
            this.logger.debug('Vygenerováno nové ID zařízení (záložní řešení)', { newDeviceId });
            return newDeviceId;
    
        } catch (error) {
            this.logger.error('Chyba při inicializaci ID zařízení', error);
            throw error;
        }
    }

    /**
     * Načte a aplikuje nastavení z device settings
     * 
     * NASTAVENÍ PRO 15MIN DEVICE:
     * - low_index_intervals: počet low index slotů (0-96)
     * - high_index_intervals: počet high index slotů (0-96)
     * - price_in_kwh: zobrazit cenu v Kč/kWh místo Kč/MWh
     * 
     * @param {Device} device - instance device
     */
    async loadAndApplySettings(device) {
        try {
            device.lowIndexIntervals = device.getSetting('low_index_intervals') || 8;
            device.highIndexIntervals = device.getSetting('high_index_intervals') || 8;
            device.priceInKWh = device.getSetting('price_in_kwh') || false;

            this.logger.debug('Nastavení zařízení načtena', {
                lowIndexIntervals: device.lowIndexIntervals,
                highIndexIntervals: device.highIndexIntervals,
                priceInKWh: device.priceInKWh
            });
        } catch (error) {
            this.logger.error('Chyba při načítání nastavení', error);
            throw error;
        }
    }

    /**
     * Nastaví počáteční tarif
     * 
     * @param {Device} device - instance device
     */
    async setInitialTariff(device) {
        try {
            await device.tariffCalculator.initializeInitialTariff(device);
            this.logger.debug('Počáteční tarif nastaven');
        } catch (error) {
            this.logger.error('Chyba při nastavení počátečního tarifu', error);
            throw error;
        }
    }

    /**
     * Načte iniciální data při startu
     * 
     * STRATEGIE:
     * - Pokud je cache mladší než 15 min → použije cache
     * - Jinak → fetchne nová data z API
     * 
     * @param {Device} device - instance device
     * @returns {Promise<boolean>}
     */
    async loadInitialData(device) {
        const lastUpdate = await device.getStoreValue('lastDataUpdate');
        const now = Date.now();

        if (!lastUpdate || (now - lastUpdate > 15 * 60 * 1000)) {
            return await this.performInitialDataFetch(device);
        }

        this.logger.debug('Použití cached dat');
        return true;
    }

    /**
     * Provede fetch dat s retry logikou
     * 
     * @param {Device} device - instance device
     * @param {number} maxRetries - maximální počet pokusů
     * @returns {Promise<boolean>}
     */
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
                
                // Exponenciální backoff
                await new Promise(resolve => setTimeout(resolve, 5000 * retryCount));
            }
        }
    }

    // ==================== EVENTS ====================

    /**
     * Emituje událost aktualizace cen
     * 
     * Pro flow karty a další komponenty
     * 
     * @param {Device} device - instance device
     * @param {Object} updateData - data k emitování
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
        }
    }

    // ==================== RESET ====================

    /**
     * Resetuje stav device
     * 
     * POUŽITÍ:
     * - Po změně settings
     * - Po selhání API
     * - Manuální reset
     * 
     * @param {Device} device - instance device
     * @returns {Promise<boolean>} true pokud reset úspěšný
     */
    async resetDeviceState(device) {
        try {
            this.logger.debug('Začátek resetu stavu zařízení');

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

            this.logger.debug('Reset stavu zařízení dokončen');
            return true;
        } catch (error) {
            this.logger.error('Chyba při resetu stavu zařízení', error);
            return false;
        }
    }

    /**
     * Resetuje všechny capabilities na null
     * 
     * @param {Device} device - instance device
     */
    async resetAllCapabilities(device) {
        const capabilities = device.getCapabilities();
        await Promise.all(
            capabilities.map(capability => 
                device.setCapabilityValue(capability, null)
                    .catch(error => this.logger.error(`Chyba při resetu capability ${capability}`, error))
            )
        );
    }

    // ==================== CLEANUP ====================

    /**
     * Vyčistí device při odstranění
     * 
     * POSTUP:
     * 1. Vyčištění komponent (managers, helpers)
     * 2. Vyčištění store values
     * 3. Reset capabilities
     * 4. Odstranění event listeners
     * 5. Vyčištění referencí
     * 
     * @param {Device} device - instance device
     */
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
    
            this.logger.debug('Úklid zařízení dokončen', {
                deviceId: device.getData().id
            });
        } catch (error) {
            this.logger.error('Chyba při úklidu zařízení', error);
        }
    }

    /**
     * Vyčistí všechny komponenty device
     * 
     * @param {Device} device - instance device
     */
    async cleanupComponents(device) {
        const components = {
            // Základní helpery
            spotPriceApi: () => {
                if (device.spotPriceApi) {
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
                    device.tariffCalculator = null;
                }
            },
            priceCalculationEngine: () => {
                if (device.priceCalculationEngine) {
                    device.priceCalculationEngine = null;
                }
            },
            dataValidator: () => {
                if (device.dataValidator) {
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
    
            // Logger - jako poslední
            logger: () => {
                if (device.logger) {
                    device.logger.debug('Logger cleanup starting');
                    device.logger = null;
                }
            }
        };
    
        // Postupné čištění všech komponent
        for (const [name, cleanup] of Object.entries(components)) {
            try {
                await cleanup();
                this.logger?.debug(`Komponenta ${name} vyčištěna`);
            } catch (error) {
                this.logger?.error(`Chyba při čištění komponenty ${name}`, error);
            }
        }
    }

    /**
     * Vyčistí všechny store values
     * 
     * @param {Device} device - instance device
     */
    async cleanupStoreValues(device) {
        const storeKeys = [
            // Základní identifikace
            'device_id',
            
            // Tarifní informace
            'previousTariff',
            
            // Časové značky aktualizací
            'lastDataUpdate',
            'lastMidnightUpdate',
            'lastSlotUpdate',           // 15min update
            'lastAverageSlotUpdate',    // Průměrné ceny slotů
            
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
    
        this.logger.debug('Všechny store hodnoty vyčištěny', {
            deviceId: device.getData().id,
            keyCount: storeKeys.length
        });
    }

    /**
     * Odstraní event listeners
     * 
     * @param {Device} device - instance device
     */
    cleanupEventListeners(device) {
        device.homey.removeAllListeners('spot_prices_updated');
        device.homey.removeAllListeners('settings_changed');
        this.logger.debug('Event listenery odstraněny');
    }

    /**
     * Vyčistí všechny reference na device
     * 
     * @param {Device} device - instance device
     */
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
    
            // Interní proměnné (15min device)
            'lowIndexIntervals',
            'highIndexIntervals',
            'priceInKWh',
            'isInitialized',
            'lastCalculationSlot',
            'homeyTimezone',
            'baseUrl',
            'exchangeRate',
            'lastRateUpdate'
        ];
    
        for (const ref of references) {
            try {
                if (device[ref] !== undefined) {
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
            this.logger.debug('Všechny reference úspěšně vyčištěny', {
                deviceId: device.getData().id,
                referencesCount: references.length
            });
        }
    }

    // ==================== CLEANUP ====================

    /**
     * Ukončí DeviceStateManager instanci
     */
    destroy() {
        this.logger?.debug('DeviceStateManager instance ukončena');
        DeviceStateManager.instance = null;
    }
}

module.exports = DeviceStateManager;