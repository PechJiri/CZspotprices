'use strict';

const Logger = require('../Logger');
const DataValidator = require('../DataValidator');
const PriceCalculationEngine = require('./PriceCalculationEngine');

class PriceCalculator {
    static instance = null;
    static CONTEXT = 'PriceCalculator';

    constructor(homey) {
        if (PriceCalculator.instance) {
            throw new Error('Použijte PriceCalculator.getInstance()');
        }
        
        this.logger = Logger.getInstance();
        this.homey = homey;
        
        // Automaticky získáme instanci engine jako singleton
        this.priceCalculationEngine = PriceCalculationEngine.getInstance(homey);
        this.dataValidator = DataValidator.getInstance(homey);
            this.components = {}; // Pro lazy-load komponenty
        
        this.logger?.debug('PriceCalculator inicializován');
    }

    static getInstance(homey) {
        if (!PriceCalculator.instance) {
            PriceCalculator.instance = new PriceCalculator(homey);
        }
        return PriceCalculator.instance;
    }

    static setHomeyInstance(homey) {
        if (!homey) {
            throw new Error('Homey instance je vyžadována');
        }
        PriceCalculator.homeyInstance = homey;
    }

    // Lazy-load komponenty
    getTariffCalculator() {
        if (!this.components.tariffCalculator) {
            const TariffCalculator = require('./TariffCalculator');
            this.components.tariffCalculator = TariffCalculator.getInstance(this.homey);
        }
        return this.components.tariffCalculator;
    }

    getPriceCalculationEngine() {
        if (!this.components.priceCalculationEngine) {
            const PriceCalculationEngine = require('./PriceCalculationEngine');
            this.components.priceCalculationEngine = PriceCalculationEngine.getInstance(this.homey);
        }
        return this.components.priceCalculationEngine;
    }

    getDataValidator() {
        if (!this.components.dataValidator) {
            const DataValidator = require('../DataValidator');
            this.components.dataValidator = DataValidator.getInstance(this.homey);
        }
        return this.components.dataValidator;
    }

    getCacheManager() {
        if (!this._cacheManager) {
            const CacheManager = require('../CacheManager');
            this._cacheManager = CacheManager.getInstance(this.homey);
        }
        return this._cacheManager;
    }

    // Hlavní metoda pro výpočet ceny
    async calculatePrice(data, settings, hour) {
        try {
            const cacheKey = `calculate_price_${JSON.stringify(data)}_${JSON.stringify(settings)}_${hour}`;
            
            // Pokus o získání z cache
            const cachedPrice = this.getCacheManager().get(cacheKey);
            if (cachedPrice !== null) {
                this.logger?.debug('Cena načtena z cache', { 
                    hour, 
                    cachedPrice,
                    cacheKey 
                });
                return cachedPrice;
            }
    
            const validator = this.getDataValidator();
            
            if (!validator.validatePrice(data)) {
                this.logger?.error('Neplatná vstupní data', {
                    data,
                    hour,
                    settings
                });
                return null;
            }
    
            const hourlyValidation = validator.validateHourlyPrice(data, hour);
            if (!hourlyValidation.isValid) {
                this.logger?.warn('Neplatná hodinová cena', {
                    hour,
                    price: hourlyValidation.price
                });
                return null;
            }
    
            const priceEngine = this.getPriceCalculationEngine();
            const finalPrice = priceEngine.addDistributionPrice(hourlyValidation.price, settings, hour);
            
            // Uložení do cache s existujícím TTL pro PRICE
            if (finalPrice !== null) {
                this.getCacheManager().set(cacheKey, finalPrice, 'PRICE');
                this.logger?.debug('Cena uložena do cache', { 
                    hour, 
                    finalPrice,
                    cacheKey 
                });
            }
            
            this.logger?.debug('Výsledná cena vypočtena', { 
                hour, 
                finalPrice,
                inputPrice: hourlyValidation.price,
                settings
            });
            
            return finalPrice;
    
        } catch (error) {
            this.logger?.error('Chyba při výpočtu ceny', error, {
                hour,
                data,
                settings
            });
            return null;
        }
    }

    // Optimalizovaná metoda pro cenové indexy
    setPriceIndexes(hoursToday, lowIndexHours, highIndexHours) {
        const validator = this.getDataValidator();
        const cacheManager = this.getCacheManager();
        const cacheKey = `${hoursToday.map(h => h.priceCZK).join('-')}-${lowIndexHours}-${highIndexHours}`;
        
        const cachedData = cacheManager.get(cacheKey);
        if (cachedData) return cachedData;

        if (!validator.validatePriceIndexData(hoursToday, lowIndexHours, highIndexHours).isValid) {
            return hoursToday.map(data => ({ ...data, level: 'unknown' }));
        }

        const serazeneCeny = [...hoursToday].sort((a, b) => a.priceCZK - b.priceCZK);
        const indexMap = new Map();
        
        serazeneCeny.slice(0, lowIndexHours).forEach(data => indexMap.set(data.hour, 'low'));
        serazeneCeny.slice(-highIndexHours).forEach(data => indexMap.set(data.hour, 'high'));

        const vysledek = hoursToday.map(data => ({
            ...data,
            level: indexMap.get(data.hour) || 'medium'
        }));

        cacheManager.set(cacheKey, vysledek);
        return vysledek;
    }
}

module.exports = PriceCalculator;