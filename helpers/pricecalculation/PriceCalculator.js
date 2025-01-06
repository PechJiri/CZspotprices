'use strict';

const Logger = require('../Logger');

class PriceCalculator {
    static instance = null;
    static CONTEXT = 'PriceCalculator';

    constructor(homey) {
        if (PriceCalculator.instance) {
            throw new Error('Použijte PriceCalculator.getInstance() místo volání new.');
        }

        this.logger = Logger.getInstance()
        this.homey = homey;
        this.components = {}; // Lazy-loaded komponenty

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
            throw new Error('Homey instance je vyžadována pro PriceCalculator');
        }
        PriceCalculator.homeyInstance = homey;
    }

    /**
     * Lazy-load TariffCalculator
     * @returns {TariffCalculator}
     */
    getTariffCalculator() {
        if (!this.components.tariffCalculator) {
            const TariffCalculator = require('./TariffCalculator');
            this.components.tariffCalculator = TariffCalculator.getInstance(this.homey);
        }
        return this.components.tariffCalculator;
    }

    /**
     * Lazy-load PriceCalculationEngine
     * @returns {PriceCalculationEngine}
     */
    getPriceCalculationEngine() {
        if (!this.components.priceCalculationEngine) {
            const PriceCalculationEngine = require('./PriceCalculationEngine');
            this.components.priceCalculationEngine = PriceCalculationEngine.getInstance(this.homey);
        }
        return this.components.priceCalculationEngine;
    }

    /**
     * Lazy-load DataValidator
     * @returns {DataValidator}
     */
    getDataValidator() {
        if (!this.components.dataValidator) {
            const DataValidator = require('../DataValidator');
            this.components.dataValidator = DataValidator.getInstance(this.homey);
        }
        return this.components.dataValidator;
    }

    /**
     * Lazy-load CacheManager
     * @returns {CacheManager}
     */
    getCacheManager() {
        if (!this.components.cacheManager) {
            const CacheManager = require('../CacheManager');
            this.components.cacheManager = CacheManager.getInstance(this.homey);
        }
        return this.components.cacheManager;
    }

    /**
     * Hlavní orchestrátor pro výpočet ceny
     * @param {Array} data - Cenová data
     * @param {Object} settings - Nastavení pro výpočty
     * @param {number} hour - Aktuální hodina
     * @returns {number|null} - Výsledná cena nebo null při chybě
     */
    calculatePrice(data, settings, hour) {
        try {
            const validator = this.getDataValidator();
            
            // Základní validace vstupních dat
            if (!validator.validatePrice(data)) {
                this.logger?.error('Neplatná vstupní data, výpočet přerušen');
                return null;
            }
    
            // Validace existence a platnosti ceny pro danou hodinu
            const hourlyValidation = validator.validateHourlyPrice(data, hour);
            if (!hourlyValidation.isValid) {
                return null;
            }
    
            const priceEngine = this.getPriceCalculationEngine();
    
            const finalPrice = priceEngine.addDistributionPrice(hourlyValidation.price, settings, hour);
            this.logger?.debug('Výsledná cena vypočtena', { hour, finalPrice });
    
            return finalPrice;
            
        } catch (error) {
            this.logger?.error('Chyba při výpočtu ceny:', error);
            return null;
        }
    }

    /**
     * Nastavení cenových indexů s cachováním
     */
    setPriceIndexes(hoursToday, lowIndexHours, highIndexHours) {
        try {
            const validator = this.getDataValidator();
            const cacheManager = this.getCacheManager();
    
            // Vytvoření cache klíče
            const cacheKey = `${hoursToday.map(h => h.priceCZK).join('-')}-${lowIndexHours}-${highIndexHours}`;
        
            // Kontrola cache
            const cachedData = cacheManager.getCache(cacheKey);
            if (cachedData) {
                this.logger?.debug('Použití dat z cache', { cacheKey });
                return cachedData;
            }
        
            // Validace vstupních dat
            const validation = validator.validatePriceIndexData(hoursToday, lowIndexHours, highIndexHours);
            if (!validation.isValid) {
                throw new Error(`Neplatná vstupní data: ${validation.errors.join(', ')}`);
            }
        
            // Logování vstupních dat
            this.logger?.debug('Začátek výpočtu cenových indexů', {
                požadovanéIndexy: {
                    low: lowIndexHours,
                    high: highIndexHours,
                    medium: 24 - lowIndexHours - highIndexHours
                },
                počet_hodin: hoursToday.length
            });
        
            // Seřazení hodin podle ceny
            const serazeneCeny = [...hoursToday].sort((a, b) => a.priceCZK - b.priceCZK);
        
            // Vytvoření mapy indexů
            const indexMap = new Map();
                
            // Přiřazení "low" indexů
            const lowPrices = serazeneCeny.slice(0, lowIndexHours);
            lowPrices.forEach(data => indexMap.set(data.hour, 'low'));
        
            // Přiřazení "high" indexů
            const highPrices = serazeneCeny.slice(-highIndexHours);
            highPrices.forEach(data => indexMap.set(data.hour, 'high'));
        
            // Sestavení výsledku
            const vysledek = hoursToday.map(hodinoveData => ({
                ...hodinoveData,
                level: indexMap.get(hodinoveData.hour) || 'medium'
            }));
        
            // Uložení do cache
            cacheManager.setCache(cacheKey, vysledek, cacheManager.PRICE_CACHE_TTL);
        
            return vysledek;
        
        } catch (error) {
            this.logger?.error('Chyba při nastavování cenových indexů:', error);
            // V případě chyby vrátíme data s 'unknown' hodnotou
            return hoursToday.map(hodinoveData => ({
                ...hodinoveData,
                level: 'unknown'
            }));
        }
    }

    /**
     * Vyčištění cache přes orchestrátor
     */
    clearCache() {
        const cacheManager = this.getCacheManager();
        cacheManager.clearAll();
        this.logger?.debug('Cache vyčištěna přes PriceCalculator');
    }
}

module.exports = PriceCalculator;
