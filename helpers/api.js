'use strict';

const Logger = require('./Logger');

/**
 * API client pro získávání spotových cen elektřiny
 * - 15minutové sloty (96/den)
 * - Lock mechanismus (1 API volání/den pro všechny devices)
 * - Cache-first přístup
 * - Nativní fetch() místo axios (Node.js 18+)
 * @class SpotPriceAPI
 * @singleton
 */
class SpotPriceAPI {
    static instance = null;
    static CONTEXT = 'SpotPriceAPI';

    static getInstance(homey) {
        if (!SpotPriceAPI.instance) {
            SpotPriceAPI.instance = new SpotPriceAPI(homey);
        }
        return SpotPriceAPI.instance;
    }

    constructor(homeyInstance) {
        if (SpotPriceAPI.instance) {
            throw new Error('Použijte SpotPriceAPI.getInstance()');
        }
        
        this.homey = homeyInstance;
        if (!this.homey) {
            throw new Error('Homey instance není dostupná');
        }
    
        this.logger = Logger.getInstance();
        if (!this.logger) {
            throw new Error('Logger inicializace selhala');
        }
    
        this.baseUrl = 'https://spotovaelektrina.cz/api/v1/price';
        this.homeyTimezone = this.homey.clock.getTimezone();

        // Lock mechanismus: Key = dateKey (např. '20251005'), Value = Promise
        this._fetchLocks = new Map();

        this.logger.debug('SpotPriceAPI inicializován (nativní fetch)', {
            timezone: this.homeyTimezone,
            baseUrl: this.baseUrl,
            nodeVersion: process.version
        });
    }

    // ==================== LAZY DEPENDENCIES ====================
    
    getCacheManager() {
        if (!this._cacheManager) {
            const CacheManager = require('../helpers/CacheManager');
            this._cacheManager = CacheManager.getInstance(this.homey);
        }
        return this._cacheManager;
    }

    getDataValidator() {
        if (!this._dataValidator) {
            const DataValidator = require('../helpers/DataValidator');
            this._dataValidator = DataValidator.getInstance(this.homey);
        }
        return this._dataValidator;
    }

    // ==================== TIME UTILS ====================

    /**
     * Získá aktuální časové info (hodina zaokrouhlená na 15min interval)
     * @returns {Object} { hour, minute, rawMinutes, dateKey, timestamp }
     */
    getCurrentTimeInfo() {
        const now = new Date();
        const options = { timeZone: this.homeyTimezone };
        
        let hour = parseInt(now.toLocaleString('en-US', { 
            ...options, 
            hour: 'numeric', 
            hour12: false 
        }));

        // Edge case fix
        if (hour === 24) hour = 0;
        if (hour < 0 || hour > 23) {
            this.logger.error('Neplatná hodina', { hour });
            hour = new Date().getHours();
        }

        // Zaokrouhlení na 15min (0, 15, 30, 45)
        const rawMinutes = now.getMinutes();
        const minute = Math.floor(rawMinutes / 15) * 15;

        // Datum jako klíč (YYYYMMDD)
        const dateKey = now.toLocaleString('en-US', { 
            ...options, 
            year: 'numeric', 
            month: '2-digit', 
            day: '2-digit' 
        }).split('/').reverse().join('');

        return { hour, minute, rawMinutes, dateKey, timestamp: now.getTime() };
    }

    // ==================== HTTP REQUEST ====================

    /**
     * HTTP request s timeoutem (nativní fetch)
     * @param {string} url - URL endpointu
     * @param {number} [timeoutMs=10000] - timeout v ms
     * @returns {Promise<Object>} JSON data z API
     * @throws {Error} při selhání nebo timeoutu
     */
    async fetchAPI(url, timeoutMs = 10000) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        
        try {
            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Homey-CZ-Spot-Prices/1.0'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();

            this.logger.debug('✓ API odpověď OK', { 
                url,
                status: response.status,
                hasHoursToday: !!data.hoursToday,
                todayCount: data.hoursToday?.length,
                hasHoursTomorrow: !!data.hoursTomorrow,
                tomorrowCount: data.hoursTomorrow?.length
            });

            return data;

        } catch (error) {
            let errorMessage;
            
            if (error.name === 'AbortError') {
                errorMessage = `Timeout (${timeoutMs}ms)`;
            } else if (error.message.startsWith('HTTP')) {
                errorMessage = error.message;
            } else {
                errorMessage = error.message;
            }

            this.logger.error('❌ API request selhala', { 
                url, 
                error: errorMessage,
                errorType: error.name,
                code: error.code
            });
            
            throw new Error(`API error: ${errorMessage}`);
            
        } finally {
            clearTimeout(timeoutId);
        }
    }

    // ==================== PRICE DATA FETCHING ====================

    /**
     * Získá cenová data (15minutové sloty)
     * 
     * Strategie:
     * 1. Cache hit → vrať
     * 2. Lock existuje → počkej na výsledek
     * 3. Jinak → fetch z API
     * 
     * @returns {Promise<Object>} { today: Array<96>, tomorrow: Array<96|0>, fetchedAt, dateKey }
     * @throws {Error} při selhání API nebo nevalidních datech
     */
    async getPrices() {
        const timeInfo = this.getCurrentTimeInfo();
        const cacheManager = this.getCacheManager();
        const cacheKey = `prices_${timeInfo.dateKey}`;

        try {
            // 1. CACHE HIT
            const cachedData = cacheManager.get(cacheKey);
            if (cachedData) {
                this.logger.debug('✓ Data načtena z cache', { 
                    cacheKey,
                    todaySlots: cachedData.today?.length,
                    tomorrowSlots: cachedData.tomorrow?.length
                });
                return cachedData;
            }

            // 2. LOCK EXISTUJE - čekej na probíhající fetch
            if (this._fetchLocks.has(timeInfo.dateKey)) {
                this.logger.debug('⏳ Čekám na probíhající API fetch', { 
                    dateKey: timeInfo.dateKey 
                });
                
                await this._fetchLocks.get(timeInfo.dateKey);
                
                // Po čekání zkus cache znovu
                const cachedAfterWait = cacheManager.get(cacheKey);
                if (cachedAfterWait) {
                    this.logger.debug('✓ Data načtena z cache po čekání', { cacheKey });
                    return cachedAfterWait;
                }
                
                throw new Error('Data nejsou v cache ani po dokončení prvního fetchování');
            }

            // 3. NOVÝ FETCH
            this.logger.debug('🔄 Zahajuji nové API volání', { 
                dateKey: timeInfo.dateKey 
            });
            
            const fetchPromise = this._performFetch(timeInfo, cacheKey);
            this._fetchLocks.set(timeInfo.dateKey, fetchPromise);

            try {
                const result = await fetchPromise;
                return result;
            } finally {
                this._fetchLocks.delete(timeInfo.dateKey);
            }

        } catch (error) {
            this.logger.error('❌ Chyba při získávání dat', {
                error: error.message,
                dateKey: timeInfo.dateKey
            });
            throw error;
        }
    }

    /**
     * Interní metoda: Skutečné API volání + zpracování
     * @private
     */
    async _performFetch(timeInfo, cacheKey) {
        const cacheManager = this.getCacheManager();

        // 1. FETCH
        this.logger.debug('📡 Volám API endpoint', { 
            dateKey: timeInfo.dateKey,
            url: `${this.baseUrl}/get-prices-json-qh`
        });
        
        const rawData = await this.fetchAPI(`${this.baseUrl}/get-prices-json-qh`);

        // 2. VALIDACE STRUKTURY
        if (!rawData?.hoursToday || !Array.isArray(rawData.hoursToday)) {
            throw new Error('Neplatná struktura dat z API - chybí hoursToday');
        }

        // 3. VALIDACE POČTU SLOTŮ
        if (rawData.hoursToday.length !== 96) {
            this.logger.warn('⚠️ Neočekávaný počet slotů', {
                expected: 96,
                received: rawData.hoursToday.length
            });
            
            if (rawData.hoursToday.length < 96) {
                throw new Error(`Neúplná data - pouze ${rawData.hoursToday.length}/96 slotů`);
            }
        }

        // 4. ZPRACOVÁNÍ - transformace do interního formátu
        const processedData = {
            today: rawData.hoursToday.map(slot => ({
                hour: slot.hour,
                minute: slot.minute,
                priceCZK: slot.priceCZK,
                priceEur: slot.priceEur || 0
            })),
            tomorrow: (rawData.hoursTomorrow || []).map(slot => ({
                hour: slot.hour,
                minute: slot.minute,
                priceCZK: slot.priceCZK,
                priceEur: slot.priceEur || 0
            })),
            fetchedAt: new Date().toISOString(),
            dateKey: timeInfo.dateKey
        };

        // 5. VALIDACE ZPRACOVANÝCH DAT
        if (!processedData?.today || processedData.today.length !== 96) {
            throw new Error('Chyba při zpracování dat - neplatný počet slotů');
        }

        // 6. CACHE (platnost do půlnoci)
        cacheManager.set(cacheKey, processedData, 'MIDNIGHT');

        this.logger.debug('✓ Data zpracována a uložena do cache', {
            cacheKey,
            todaySlots: processedData.today.length,
            tomorrowSlots: processedData.tomorrow.length,
            fetchedAt: processedData.fetchedAt
        });

        return processedData;
    }

    // ==================== STATISTICS (pro flow cards) ====================

    /**
     * Spočítá průměr z pole čísel
     * @param {number[]} values - pole hodnot
     * @returns {number} průměr
     */
    calculateAverage(values) {
        if (!Array.isArray(values) || values.length === 0) return 0;
        const sum = values.reduce((acc, val) => acc + val, 0);
        return sum / values.length;
    }

    /**
     * Spočítá medián z pole čísel
     * @param {number[]} values - pole hodnot
     * @returns {number} medián
     */
    calculateMedian(values) {
        if (!Array.isArray(values) || values.length === 0) return 0;
        
        const sorted = [...values].sort((a, b) => a - b);
        const mid = sorted.length / 2;

        if (sorted.length % 2 === 0) {
            return (sorted[mid - 1] + sorted[mid]) / 2;
        }
        return sorted[Math.floor(mid)];
    }

    /**
     * Najde min/max hodnotu
     * @param {number[]} values - pole hodnot
     * @param {string} type - 'min' nebo 'max'
     * @returns {number} min nebo max hodnota
     */
    findMinMax(values, type = 'min') {
        if (!Array.isArray(values) || values.length === 0) return 0;
        return type === 'min' ? Math.min(...values) : Math.max(...values);
    }

    /**
     * Spočítá percentil
     * @param {number[]} values - pole hodnot
     * @param {number} percentile - percentil (0-100)
     * @returns {number} hodnota na daném percentilu
     */
    calculatePercentile(values, percentile) {
        if (!Array.isArray(values) || values.length === 0) return 0;
        if (percentile < 0 || percentile > 100) {
            throw new Error('Percentil musí být mezi 0-100');
        }

        const sorted = [...values].sort((a, b) => a - b);
        const index = (percentile / 100) * (sorted.length - 1);
        const lower = Math.floor(index);
        const upper = Math.ceil(index);
        const weight = index % 1;

        if (lower === upper) return sorted[lower];
        
        // Lineární interpolace
        return sorted[lower] * (1 - weight) + sorted[upper] * weight;
    }

    // ==================== CACHE MANAGEMENT ====================

    /**
     * Vyčistí cache pro datum
     * @param {string} dateKey - datum (YYYYMMDD)
     * @returns {boolean} true pokud cache existovala
     */
    clearCacheForDate(dateKey) {
        const cacheManager = this.getCacheManager();
        const cacheKey = `prices_${dateKey}`;
        const deleted = cacheManager.deleteCache(cacheKey);
        
        if (deleted) {
            this.logger.debug('🗑️ Cache vyčištěna pro datum', { dateKey, cacheKey });
        } else {
            this.logger.debug('Cache pro datum neexistovala', { dateKey, cacheKey });
        }
        
        return deleted;
    }

    /**
     * Vyčistí veškerou cache
     */
    clearAllCache() {
        const cacheManager = this.getCacheManager();
        cacheManager.clearAll();
        this.logger.debug('🗑️ Veškerá cache vyčištěna');
    }

    /**
     * Vyčistí všechny aktivní locky (pro debugging)
     */
    clearAllLocks() {
        const lockCount = this._fetchLocks.size;
        this._fetchLocks.clear();
        this.logger.debug('🔓 Všechny fetch locky vyčištěny', { 
            clearedLocks: lockCount 
        });
    }

    /**
     * Vrátí aktivní locky (pro debugging)
     * @returns {string[]} pole dateKeys
     */
    getActiveLocks() {
        return Array.from(this._fetchLocks.keys());
    }

    // ==================== CLEANUP ====================

    /**
     * Ukončí API instanci
     * Poznámka: Nativní fetch() automaticky spravuje sockety
     */
    destroy() {
        this.clearAllLocks();
        this.logger.debug('SpotPriceAPI instance ukončena');
        SpotPriceAPI.instance = null;
    }
}

module.exports = SpotPriceAPI;