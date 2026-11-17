'use strict';

const Logger = require('./Logger');

/**
 * SettingsManager
 * Spravuje nastavení device - POUZE 15minutové sloty (96 intervalů)
 * 
 * BREAKING CHANGE: Odstraněna podpora hodinových devices
 * - Všechny metody pracují s 15minutovými sloty (0-95)
 * - Tarify zůstávají HODINOVÉ (distribuční tarify hour_0 až hour_23)
 */
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

    /**
     * Zpracuje změnu nastavení device
     * @param {Device} device - Instance zařízení
     * @param {Object} params - Parametry změny
     * @param {Object} params.oldSettings - Staré nastavení
     * @param {Object} params.newSettings - Nové nastavení
     * @param {Array<string>} params.changedKeys - Změněné klíče
     */
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

    /**
     * Loguje změny nastavení
     * @private
     */
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

    /**
     * Kontroluje, zda změna nastavení vyžaduje přepočet cen
     * @param {Array<string>} changedKeys - Pole změněných klíčů nastavení
     * @returns {boolean} True pokud je potřeba přepočítat ceny
     */
    needsRecalculation(changedKeys) {
        return changedKeys.some(key => 
            // Počet slotů pro indexy
            key === 'low_index_intervals' ||
            key === 'high_index_intervals' ||
            // Hodinové tarify (stále používáme)
            key.startsWith('hour_') || 
            key === 'high_tariff_price' || 
            key === 'low_tariff_price' ||
            // Cenové parametry
            key === 'price_in_kwh' ||
            key === 'commodity_price_with_vat'
        );
    }

    /**
     * Zpracuje přepočet cen po změně nastavení
     * @private
     */
    async handlePriceRecalculation(device, oldSettings, newSettings, changedKeys) {
        this.logger.debug('Zahájení přepočtu cen a indexů', {
            changedSettings: changedKeys.filter(key => 
                key === 'low_index_intervals' ||
                key === 'high_index_intervals' ||
                key.startsWith('hour_') || 
                key === 'high_tariff_price' || 
                key === 'low_tariff_price'
            ),
            priceInKWhChanged: changedKeys.includes('price_in_kwh')
        });

        // Vyčistíme cache před přepočtem
        device.cacheManager.clearAll();
        this.logger.debug('Cache vyčištěna');
        
        // Aktualizujeme device properties
        await this.updateDeviceSettings(device, oldSettings, newSettings, changedKeys);
        
        // Přepočítáme ceny s novými nastaveními
        const prices = await this.recalculatePrices(device, newSettings);
        
        // Aktualizujeme capabilities
        await this.updateDeviceCapabilities(device, prices, newSettings);

        // Statistika pro log
        const indexStats = prices.reduce((acc, curr) => {
            acc[curr.level] = (acc[curr.level] || 0) + 1;
            return acc;
        }, {});

        this.logger.debug('Přepočet cen a indexů dokončen', {
            processedSlots: prices.length,
            indexStats,
            priceInKWh: device.priceInKWh
        });
    }

    /**
     * Aktualizuje device properties podle nového nastavení
     * @private
     */
    async updateDeviceSettings(device, oldSettings, newSettings, changedKeys) {
        if (changedKeys.includes('low_index_intervals')) {
            device.lowIndexIntervals = newSettings.low_index_intervals;
            this.logger.debug('Aktualizován lowIndexIntervals', {
                newValue: device.lowIndexIntervals,
                oldValue: oldSettings.low_index_intervals
            });
        }
        
        if (changedKeys.includes('high_index_intervals')) {
            device.highIndexIntervals = newSettings.high_index_intervals;
            this.logger.debug('Aktualizován highIndexIntervals', {
                newValue: device.highIndexIntervals,
                oldValue: oldSettings.high_index_intervals
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

    /**
     * Přepočítá ceny s novými nastaveními
     * Používá 15minutové sloty (96 intervalů)
     * @private
     */
    async recalculatePrices(device, newSettings) {
        // Získáme aktuální data (96 slotů)
        const slotPrices = await device.spotPriceApi.getPrices();
        
        this.logger.debug('Získána denní data', {
            slotsCount: slotPrices.today.length
        });

        // ✅ OPTIMALIZACE: Vytvoř tariffMap JEDNOU
        const tariffMap = device.tariffCalculator.getTariffMap(newSettings);

        this.logger?.debug('🗺️ TariffMap vytvořena pro settings recalc', {
            mapSize: tariffMap.size
        });
        
        // Přidáme distribuční tarify s předanou mapou
        const processedPrices = slotPrices.today.map(price => ({
            hour: price.hour,
            minute: price.minute,
            priceCZK: device.priceCalculationEngine.addDistributionPrice(
                price.priceCZK,
                newSettings,
                price.hour,
                tariffMap  // ✅ Předej tariffMap!
            )
        }));

        // Nastavíme indexy podle nového nastavení
        return device.priceCalculator.setIndexes(
            processedPrices,
            newSettings.low_index_intervals || 8,
            newSettings.high_index_intervals || 8
        );
    }

    /**
     * Aktualizace capabilities device po přepočtu cen
     * @private
     */
    async updateDeviceCapabilities(device, pricesWithIndexes, newSettings) {
        try {
            // ✅ SPRÁVNĚ: Volej master metodu z CapabilityManager
            await device.capabilityManager.updateDeviceCapabilities(
                device, 
                pricesWithIndexes,
                newSettings.price_in_kwh || false  // ✅ Předej priceInKWh
            );
        } catch (error) {
            this.logger?.error('Chyba při aktualizaci capabilities', error, {
                deviceId: device.getData().id
            });
            throw error;
        }
    }
    
    /**
     * Získá počet slotů pro nízký index z nastavení zařízení
     * @param {Device} device - Instance zařízení
     * @returns {number} Počet slotů pro nízký index (0-96), výchozí hodnota 8
     */
    getLowIndexSlots(device) {
        return device.getSetting('low_index_intervals') || 8;
    }
    
    /**
     * Získá počet slotů pro vysoký index z nastavení zařízení
     * @param {Device} device - Instance zařízení
     * @returns {number} Počet slotů pro vysoký index (0-96), výchozí hodnota 8
     */
    getHighIndexSlots(device) {
        return device.getSetting('high_index_intervals') || 8;
    }
    
    /**
     * Získá nastavení pro cenu v kWh
     * @param {Device} device - Instance zařízení
     * @returns {boolean} Zda je cena v kWh (true) nebo MWh (false)
     */
    getPriceInKWh(device) {
        const currentValue = device.getSetting('price_in_kwh');
        
        // Pokud hodnota neexistuje, nastav výchozí
        if (currentValue === undefined || currentValue === null) {
            device.setSettings({ price_in_kwh: false }).catch(err => {
                this.logger?.error('Chyba při nastavení výchozí hodnoty', err);
            });
            return false;
        }
        
        return currentValue;
    }

    /**
     * Získá všechna nastavení zařízení
     * Vrací kompletní konfiguraci pro 15minutový device s hodinovými tarify
     * 
     * @param {Device} device - Instance zařízení
     * @returns {Object} Objekt s nastavením:
     *   - low_index_intervals: Počet slotů pro nízký index (0-96)
     *   - high_index_intervals: Počet slotů pro vysoký index (0-96)
     *   - hour_0 až hour_23: Hodinové tarify (true = vysoký tarif, false = nízký)
     *   - priceInKWh: Boolean - cena v kWh (true) nebo MWh (false)
     *   - low_tariff_price: Cena nízkého tarifu
     *   - high_tariff_price: Cena vysokého tarifu
     *   - commodity_price_with_vat: Boolean - komodita s DPH
     *   - enable_logging: Boolean - zapnuté logování
     */
    getDeviceSettings(device) {
        const settings = device.getSettings();
        
        this.logger.debug('Načtené nastavení zařízení', { 
            settings 
        });
    
        // Přidání výchozích hodnot pro všechny hodiny
        // Tarify jsou STÁLE HODINOVÉ i pro 15minutový device
        const hourSettings = {};
        for (let i = 0; i < 24; i++) {
            const key = `hour_${i}`;
            hourSettings[key] = settings[key] !== undefined ? settings[key] : true; // Výchozí hodnota `true`
        }
    
        // Vracíme kompletní nastavení
        return {
            ...hourSettings,
            // Počty slotů pro indexy (15min)
            lowIndexIntervals: this.getLowIndexSlots(device),
            highIndexIntervals: this.getHighIndexSlots(device),
            // Aliasy pro kompatibilitu s API
            low_index_intervals: this.getLowIndexSlots(device),
            high_index_intervals: this.getHighIndexSlots(device),
            // Cenové parametry
            priceInKWh: this.getPriceInKWh(device),
            low_tariff_price: settings.low_tariff_price || 0,
            high_tariff_price: settings.high_tariff_price || 0,
            commodity_price_with_vat: settings.commodity_price_with_vat || false,
            enable_logging: settings.enable_logging || false
        };
    }    
}

module.exports = SettingsManager;