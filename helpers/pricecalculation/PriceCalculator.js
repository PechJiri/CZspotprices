'use strict';

const Logger = require('../Logger');
const DataValidator = require('../DataValidator');

/**
 * PriceCalculator - výpočty cen a indexů pro 15minutové sloty
 * Podporuje indexování 96 slotů s cenami
 */
class PriceCalculator {
    static instance = null;
    static CONTEXT = 'PriceCalculator';

    constructor(homey) {
        if (PriceCalculator.instance) {
            throw new Error('Použijte PriceCalculator.getInstance()');
        }
        
        this.logger = Logger.getInstance();
        this.homey = homey;

        // Automaticky získáme instances jako singleton
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

    // ==================== LAZY-LOAD KOMPONENTY ====================

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

    // ==================== INDEXY PRO 15MINUTOVÉ SLOTY (96) ====================

    /**
     * Nastaví cenové indexy pro 15minutová data (96 slotů)
     * Rozdělí sloty na low/medium/high podle jejich cen
     * 
     * @param {Array} slotsToday - Pole 15min slotů (96 položek)
     * @param {number} lowIndexSlots - Počet slotů s nízkým indexem (nejlevnější)
     * @param {number} highIndexSlots - Počet slotů s vysokým indexem (nejdražší)
     * @returns {Array} - Data s přidanými level indexy
     */
    setIndexes(slotsToday, lowIndexSlots, highIndexSlots) {
        try {
            const validator = this.getDataValidator();
            const cacheManager = this.getCacheManager();
            
            // Cache klíč (kompaktnější kvůli 96 položkám)
            const priceHash = this.hashPrices(slotsToday);
            const cacheKey = `indexes_${priceHash}_${lowIndexSlots}_${highIndexSlots}`;
            
            // Kontrola cache
            const cachedData = cacheManager.get(cacheKey);
            if (cachedData) {
                this.logger?.debug('15minutové indexy načteny z cache', {
                    hash: priceHash
                });
                return cachedData;
            }

            // ✅ OPRAVENO: Použij validateIndexData místo validateQuarterHourlyIndexData
            const validation = validator.validateIndexData(
                slotsToday,
                lowIndexSlots,
                highIndexSlots
            );
            
            if (!validation.isValid) {
                this.logger?.error('Validace 15min indexů selhala', {
                    errors: validation.errors,
                    dataLength: slotsToday?.length
                });
                return slotsToday.map(data => ({ ...data, level: 'unknown' }));
            }

            // Seřazení podle ceny (vzestupně)
            const serazeneCeny = [...slotsToday].sort((a, b) => a.priceCZK - b.priceCZK);
            
            // Vytvoření mapy indexů (klíč: "hour-minute")
            const indexMap = new Map();
            
            // Low indexy (nejlevnější sloty)
            serazeneCeny
                .slice(0, lowIndexSlots)
                .forEach(data => {
                    const key = `${data.hour}-${data.minute}`;
                    indexMap.set(key, 'low');
                });
            
            // High indexy (nejdražší sloty)
            serazeneCeny
                .slice(-highIndexSlots)
                .forEach(data => {
                    const key = `${data.hour}-${data.minute}`;
                    indexMap.set(key, 'high');
                });

            // Přidání level k původním datům (zachování pořadí)
            const vysledek = slotsToday.map(data => {
                const key = `${data.hour}-${data.minute}`;
                return {
                    ...data,
                    level: indexMap.get(key) || 'medium'
                };
            });

            // Uložení do cache
            cacheManager.set(cacheKey, vysledek, 'PRICE');

            // Statistiky pro log
            const stats = this.getIndexStats(vysledek);

            this.logger?.debug('15minutové indexy vypočteny', {
                požadovanéLow: lowIndexSlots,
                požadovanéHigh: highIndexSlots,
                total: vysledek.length,
                skutečnéStats: stats
            });

            return vysledek;
            
        } catch (error) {
            this.logger?.error('Chyba při výpočtu 15min indexů', error);
            return slotsToday.map(data => ({ ...data, level: 'unknown' }));
        }
    }

    // ==================== POMOCNÉ METODY ====================

    /**
     * Vytvoří kompaktní hash z cen pro cache klíč
     * Místo ukládání všech 96 cen použije min/max/sum jako fingerprint
     * 
     * @param {Array} slots - Pole slotů s cenami
     * @returns {string} - Hash string ve formátu "min_max_sum"
     */
    hashPrices(slots) {
        try {
            if (!Array.isArray(slots) || slots.length === 0) {
                return 'empty';
            }

            const prices = slots.map(s => s.priceCZK);
            const min = Math.min(...prices);
            const max = Math.max(...prices);
            const sum = prices.reduce((a, b) => a + b, 0);
            
            return `${min.toFixed(2)}_${max.toFixed(2)}_${sum.toFixed(2)}`;
        } catch (error) {
            this.logger?.error('Chyba při vytváření hash z cen', error);
            return 'error';
        }
    }

    /**
     * Vrátí statistiky rozdělení indexů v datech
     * 
     * @param {Array} data - Data s indexy (level property)
     * @returns {Object} - {total, low, medium, high, unknown}
     */
    getIndexStats(data) {
        if (!Array.isArray(data)) {
            return { total: 0, low: 0, medium: 0, high: 0, unknown: 0 };
        }

        return {
            total: data.length,
            low: data.filter(d => d.level === 'low').length,
            medium: data.filter(d => d.level === 'medium').length,
            high: data.filter(d => d.level === 'high').length,
            unknown: data.filter(d => d.level === 'unknown').length
        };
    }

}

module.exports = PriceCalculator;