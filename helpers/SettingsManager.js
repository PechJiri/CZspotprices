'use strict';

const Logger = require('./Logger');

class SettingsManager {
    static instance = null;
    static CONTEXT = 'SettingsManager';

    static getInstance(homey) {
        if (!SettingsManager.instance) {
            SettingsManager.instance = new SettingsManager(homey);
        }
        return SettingsManager.instance;
    }

    constructor(homey) {
        if (SettingsManager.instance) {
            throw new Error('Použijte SettingsManager.getInstance()');
        }
        
        this.homey = homey;
        this.logger = Logger.getInstance();

        if (!this.homey) {
            throw new Error('Homey instance je vyžadována pro SettingsManager');
        }
    }

    static setHomeyInstance(homey) {
        if (!homey) {
            throw new Error('Homey instance je vyžadována pro SettingsManager');
        }
        SettingsManager.homeyInstance = homey;
    }

    async handleSettingsUpdate(device, { oldSettings, newSettings, changedKeys }) {
        try {
            // Kontrola změny stavu logování včetně ověření skutečné změny hodnoty
            if (changedKeys.includes('enable_logging') && 
                oldSettings.enable_logging !== newSettings.enable_logging) {
                Logger.setEnabled(newSettings.enable_logging);
            }
    
            // Logujeme změny pouze pokud je logging zapnutý
            if (Logger.enabled) {
                this.logSettingsChange(changedKeys, oldSettings, newSettings);
            }
    
            // Kontrola potřeby přepočtu cen
            if (this.needsRecalculation(changedKeys)) {
                await this.handlePriceRecalculation(device, oldSettings, newSettings, changedKeys);
            }
    
            // Emitujeme událost o změně nastavení
            await this.homey.emit('settings_changed');
    
            // Logujeme dokončení pouze pokud je logging zapnutý
            if (Logger.enabled) {
                this.logger.debug('Aktualizace nastavení dokončena', {
                    changedSettings: changedKeys.join(', ')
                });
            }
    
            return true;
    
        } catch (error) {
            // Error logy jdou vždy, bez ohledu na stav loggingu
            this.logger.error('Chyba při aktualizaci nastavení', error, {
                changedKeys,
                deviceId: device.getData().id
            });
            throw error;
        }
    }

    logSettingsChange(changedKeys, oldSettings, newSettings) {
        const changedValues = changedKeys.reduce((acc, key) => {
            acc[key] = {
                oldValue: oldSettings[key],
                newValue: newSettings[key]
            };
            return acc;
        }, {});

        this.logger.debug('Změna nastavení', { changedKeys, changes: changedValues });
    }

    needsRecalculation(changedKeys) {
        return changedKeys.some(key => 
            key === 'low_index_hours' || 
            key === 'high_index_hours' ||
            key.startsWith('hour_') || 
            key === 'high_tariff_price' || 
            key === 'low_tariff_price' ||
            key === 'price_in_kwh' ||
            key === 'commodity_price_with_vat'
        );
    }

    async handlePriceRecalculation(device, oldSettings, newSettings, changedKeys) {
        this.logger.debug('Zahájení přepočtu cen a indexů', {
            changedSettings: changedKeys.filter(key => 
                key === 'low_index_hours' || 
                key === 'high_index_hours' ||
                key.startsWith('hour_') || 
                key === 'high_tariff_price' || 
                key === 'low_tariff_price'
            ),
            priceInKWhChanged: changedKeys.includes('price_in_kwh')
        });

        device.cacheManager.clearAll();
        this.logger.debug('Cache vyčištěna');
        
        await this.updateDeviceSettings(device, oldSettings, newSettings, changedKeys);
        const prices = await this.recalculatePrices(device, newSettings);
        
        await this.updateDeviceCapabilities(device, prices);

        const indexStats = prices.reduce((acc, curr) => {
            acc[curr.level] = (acc[curr.level] || 0) + 1;
            return acc;
        }, {});

        this.logger.log('Přepočet cen a indexů dokončen', {
            processedPrices: prices.length,
            indexStats,
            priceInKWh: device.priceInKWh
        });
    }

    async updateDeviceSettings(device, oldSettings, newSettings, changedKeys) {
        if (changedKeys.includes('low_index_hours')) {
            device.lowIndexHours = newSettings.low_index_hours;
            this.logger.debug('Aktualizován lowIndexHours', {
                newValue: device.lowIndexHours,
                oldValue: oldSettings.low_index_hours
            });
        }
        if (changedKeys.includes('high_index_hours')) {
            device.highIndexHours = newSettings.high_index_hours;
            this.logger.debug('Aktualizován highIndexHours', {
                newValue: device.highIndexHours,
                oldValue: oldSettings.high_index_hours
            });
        }
        if (changedKeys.includes('price_in_kwh')) {
            device.priceInKWh = newSettings.price_in_kwh;
            this.logger.debug('Aktualizován priceInKWh', {
                newValue: device.priceInKWh,
                oldValue: oldSettings.price_in_kwh
            });
        }
    }

    async recalculatePrices(device, newSettings) {
        const dailyPrices = await device.spotPriceApi.getDailyPrices(device);
        this.logger.debug('Získána nová denní data', {
            pricesCount: dailyPrices.length
        });
        
        const processedPrices = dailyPrices.map(priceData => ({
            hour: priceData.hour,
            priceCZK: device.priceCalculationEngine.addDistributionPrice(
                priceData.priceCZK,
                newSettings,
                priceData.hour
            )
        }));

        return device.priceCalculator.setPriceIndexes(
            processedPrices,
            newSettings.low_index_hours,
            newSettings.high_index_hours
        );
    }

    async updateDeviceCapabilities(device, pricesWithIndexes) {
        try {
            await Promise.all([
                device.capabilityManager.updateHourlyCapabilities(device, pricesWithIndexes),
                device.capabilityManager.updateCurrentAndNextHourPrices(device, pricesWithIndexes),
                device.capabilityManager.updateMinMaxPrices(device, pricesWithIndexes),
                device.capabilityManager.updateDailyAverage(device, pricesWithIndexes)
            ]);
        } catch (error) {
            this.logger.error('Chyba při aktualizaci capabilities', error, {
                deviceId: device.getData().id
            });
            throw error;
        }
    }
    
    /**
     * Získá počet hodin pro nízký index z nastavení zařízení
     * @param {Device} device - Instance zařízení
     * @returns {number} Počet hodin pro nízký index, výchozí hodnota 8
     */
    getLowIndexHours(device) {
        return device.getSetting('low_index_hours') || 8;
    }
    
    /**
     * Získá počet hodin pro vysoký index z nastavení zařízení
     * @param {Device} device - Instance zařízení
     * @returns {number} Počet hodin pro vysoký index, výchozí hodnota 8
     */
    getHighIndexHours(device) {
        return device.getSetting('high_index_hours') || 8;
    }
    
    /**
     * Získá nastavení pro cenu v kWh
     * @param {Device} device - Instance zařízení
     * @returns {boolean} Zda je cena v kWh
     */
    getPriceInKWh(device) {
        return device.getSetting('price_in_kwh') || false;
    }

    /**
     * Získá všechna nastavení zařízení
     * @param {Device} device - Instance zařízení
     * @returns {Object} Objekt s nastaveními
     */
    getDeviceSettings(device) {
        const settings = device.getSettings();
        this.logger.debug('Načtené nastavení zařízení', { settings });
    
        // Přidání výchozích hodnot pro všechny hodiny
        const hourSettings = {};
        for (let i = 0; i < 24; i++) {
            const key = `hour_${i}`;
            hourSettings[key] = settings[key] !== undefined ? settings[key] : true; // Výchozí hodnota `true`
        }
    
        return {
            ...hourSettings,
            lowIndexHours: this.getLowIndexHours(device),
            highIndexHours: this.getHighIndexHours(device),
            priceInKWh: this.getPriceInKWh(device),
            low_tariff_price: settings.low_tariff_price || 0,
            high_tariff_price: settings.high_tariff_price || 0,
            commodity_price_with_vat: settings.commodity_price_with_vat || false,
            enable_logging: settings.enable_logging || false
        };
    }    
}

module.exports = SettingsManager;