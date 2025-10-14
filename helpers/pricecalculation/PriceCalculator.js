'use strict';

const Logger = require('../Logger');
const DataValidator = require('../DataValidator');
const PriceCalculationEngine = require('./PriceCalculationEngine');

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

    // ==================== LAZY-LOAD KOMPONENTY ====================

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

    // ==================== VÝPOČET CENY ====================

    /**
     * Hlavní metoda pro výpočet ceny se všemi příplatky
     * Funguje univerzálně - přidává distribuční tarif podle hodiny
     * 
     * @param {Array} data - Cenová data (pole slotů)
     * @param {Object} settings - Nastavení device
     * @param {number} hour - Hodina (0-23) pro určení distribučního tarifu
     * @returns {number|null} - Vypočtená cena nebo null
     */
    async calculatePrice(data, settings, hour) {
        try {
            const cacheKey = `calculate_price_${JSON.stringify(data)}_${JSON.stringify(settings)}_${hour}`;
            
            // Pokus o získání z cache
            const cachedPrice = this.getCacheManager().get(cacheKey);
            if (cachedPrice !== null) {
                this.logger?.debug('Cena načtena z cache', { 
                    hour, 
                    cachedPrice
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
            const finalPrice = priceEngine.addDistributionPrice(
                hourlyValidation.price, 
                settings, 
                hour
            );
            
            // Uložení do cache
            if (finalPrice !== null) {
                this.getCacheManager().set(cacheKey, finalPrice, 'PRICE');
                this.logger?.debug('Cena uložena do cache', { 
                    hour, 
                    finalPrice
                });
            }
            
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

    /**
     * Najde nejlevnější N po sobě jdoucích slotů (sliding window)
     * 
     * @param {Array} data - Cenová data (sloty)
     * @param {number} count - Počet po sobě jdoucích slotů
     * @returns {Object|null} - {startIndex, items, avgPrice, totalPrice} nebo null
     */
    findCheapestConsecutive(data, count) {
        if (!Array.isArray(data) || data.length < count) {
            this.logger?.warn('Nedostatečná data pro findCheapestConsecutive', {
                dataLength: data?.length,
                požadovanýCount: count
            });
            return null;
        }

        let minSum = Infinity;
        let minIndex = 0;

        // Sliding window přes všechna data
        for (let i = 0; i <= data.length - count; i++) {
            const sum = data.slice(i, i + count)
                .reduce((s, item) => s + item.priceCZK, 0);
            
            if (sum < minSum) {
                minSum = sum;
                minIndex = i;
            }
        }

        const items = data.slice(minIndex, minIndex + count);

        this.logger?.debug('Nejlevnější po sobě jdoucí sloty nalezeny', {
            startIndex: minIndex,
            count: count,
            avgPrice: (minSum / count).toFixed(2),
            startTime: `${items[0].hour}:${String(items[0].minute).padStart(2, '0')}`
        });

        return {
            startIndex: minIndex,
            items: items,
            avgPrice: minSum / count,
            totalPrice: minSum
        };
    }

    /**
     * Najde nejdražší N po sobě jdoucích slotů (sliding window)
     * 
     * @param {Array} data - Cenová data (sloty)
     * @param {number} count - Počet po sobě jdoucích slotů
     * @returns {Object|null} - {startIndex, items, avgPrice, totalPrice} nebo null
     */
    findMostExpensiveConsecutive(data, count) {
        if (!Array.isArray(data) || data.length < count) {
            this.logger?.warn('Nedostatečná data pro findMostExpensiveConsecutive', {
                dataLength: data?.length,
                požadovanýCount: count
            });
            return null;
        }

        let maxSum = -Infinity;
        let maxIndex = 0;

        // Sliding window přes všechna data
        for (let i = 0; i <= data.length - count; i++) {
            const sum = data.slice(i, i + count)
                .reduce((s, item) => s + item.priceCZK, 0);
            
            if (sum > maxSum) {
                maxSum = sum;
                maxIndex = i;
            }
        }

        const items = data.slice(maxIndex, maxIndex + count);

        this.logger?.debug('Nejdražší po sobě jdoucí sloty nalezeny', {
            startIndex: maxIndex,
            count: count,
            avgPrice: (maxSum / count).toFixed(2),
            startTime: `${items[0].hour}:${String(items[0].minute).padStart(2, '0')}`
        });

        return {
            startIndex: maxIndex,
            items: items,
            avgPrice: maxSum / count,
            totalPrice: maxSum
        };
    }

    /**
     * Zjistí, zda je aktuální čas v low index slotu
     * 
     * @param {Array} slotsWithIndexes - Sloty s level indexy
     * @param {number} hour - Aktuální hodina
     * @param {number} minute - Aktuální minuta
     * @returns {boolean} - True pokud je low index
     */
    isCurrentTimeLowIndex(slotsWithIndexes, hour, minute) {
        if (!Array.isArray(slotsWithIndexes)) {
            return false;
        }

        const currentSlot = slotsWithIndexes.find(
            s => s.hour === hour && s.minute === minute
        );

        return currentSlot?.level === 'low';
    }

    /**
     * Zjistí, zda je aktuální čas v high index slotu
     * 
     * @param {Array} slotsWithIndexes - Sloty s level indexy
     * @param {number} hour - Aktuální hodina
     * @param {number} minute - Aktuální minuta
     * @returns {boolean} - True pokud je high index
     */
    isCurrentTimeHighIndex(slotsWithIndexes, hour, minute) {
        if (!Array.isArray(slotsWithIndexes)) {
            return false;
        }

        const currentSlot = slotsWithIndexes.find(
            s => s.hour === hour && s.minute === minute
        );

        return currentSlot?.level === 'high';
    }

    /**
     * Získá level index pro konkrétní čas
     * 
     * @param {Array} slotsWithIndexes - Sloty s level indexy
     * @param {number} hour - Hodina
     * @param {number} minute - Minuta
     * @returns {string} - 'low', 'medium', 'high', nebo 'unknown'
     */
    getIndexLevelForTime(slotsWithIndexes, hour, minute) {
        if (!Array.isArray(slotsWithIndexes)) {
            return 'unknown';
        }

        const slot = slotsWithIndexes.find(
            s => s.hour === hour && s.minute === minute
        );

        return slot?.level || 'unknown';
    }
}

module.exports = PriceCalculator;