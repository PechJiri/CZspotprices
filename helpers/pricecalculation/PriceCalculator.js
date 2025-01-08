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
        if (!this.components.cacheManager) {
            const CacheManager = require('../CacheManager');
            this.components.cacheManager = CacheManager.getInstance(this.homey);
        }
        return this.components.cacheManager;
    }

    // Hlavní metoda pro výpočet ceny
    calculatePrice(data, settings, hour) {
        const validator = this.getDataValidator();
        
        if (!validator.validatePrice(data)) {
            this.logger?.error('Neplatná vstupní data');
            return null;
        }

        const hourlyValidation = validator.validateHourlyPrice(data, hour);
        if (!hourlyValidation.isValid) {
            return null;
        }

        const priceEngine = this.getPriceCalculationEngine();
        const finalPrice = priceEngine.addDistributionPrice(hourlyValidation.price, settings, hour);
        
        this.logger?.debug('Výsledná cena', { hour, finalPrice });
        return finalPrice;
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