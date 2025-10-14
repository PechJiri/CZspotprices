'use strict';

const axios = require('axios');
const Logger = require('./Logger');

/**
 * API client pro získávání spotových cen elektřiny
 * 
 * KLÍČOVÉ VLASTNOSTI:
 * - Pracuje POUZE s 15minutovými sloty (96 slotů/den)
 * - Lock mechanismus: zajišťuje jen jedno API volání pro stejný den
 * - Cache-first přístup: nejdřív cache, pak API
 * - Neřídí retry logiku - to má na starosti Device/IntervalManager
 * 
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
    
        // API konfigurace
        this.baseUrl = 'https://spotovaelektrina.cz/api/v1/price';
        this.homeyTimezone = this.homey.clock.getTimezone();

        // LOCK MECHANISMUS
        // Zajišťuje, že pro stejný den (dateKey) proběhne jen jedno API volání,
        // i když se inicializuje více devices současně
        // Key: dateKey (např. '20251005')
        // Value: Promise z probíhajícího fetch
        this._fetchLocks = new Map();

        this.logger.debug('SpotPriceAPI inicializován', {
            timezone: this.homeyTimezone,
            baseUrl: this.baseUrl
        });
    }

    // ==================== LAZY DEPENDENCIES ====================
    
    /**
     * Lazy loading CacheManager
     * @returns {CacheManager}
     */
    getCacheManager() {
        if (!this._cacheManager) {
            const CacheManager = require('../helpers/CacheManager');
            this._cacheManager = CacheManager.getInstance(this.homey);
        }
        return this._cacheManager;
    }

    /**
     * Lazy loading DataValidator
     * @returns {DataValidator}
     */
    getDataValidator() {
        if (!this._dataValidator) {
            const DataValidator = require('../helpers/DataValidator');
            this._dataValidator = DataValidator.getInstance(this.homey);
        }
        return this._dataValidator;
    }

    // ==================== CORE METODY ====================

    /**
     * Získá aktuální časové informace
     * 
     * Vrací hodinu a minutu zaokrouhlenou na 15min interval (0, 15, 30, 45)
     * Plus dateKey pro cache/API volání
     * 
     * @returns {Object} { hour, minute, rawMinutes, dateKey, timestamp }
     * @example
     * // Pokud je 14:37
     * { hour: 14, minute: 30, rawMinutes: 37, dateKey: '20251005', timestamp: 1728136620000 }
     */
    getCurrentTimeInfo() {
        const now = new Date();
        const options = { timeZone: this.homeyTimezone };
        
        // Získej hodinu (0-23)
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

        // Zaokrouhlení na 15min interval (0, 15, 30, 45)
        const rawMinutes = now.getMinutes();
        const minute = Math.floor(rawMinutes / 15) * 15;

        // Datum jako klíč (YYYYMMDD)
        const dateKey = now.toLocaleString('en-US', { 
            ...options, 
            year: 'numeric', 
            month: '2-digit', 
            day: '2-digit' 
        }).split('/').reverse().join('');

        return {
            hour,              // 0-23
            minute,            // 0, 15, 30, 45
            rawMinutes,        // Skutečná minuta (pro debug)
            dateKey,           // např. '20251005'
            timestamp: now.getTime()
        };
    }

    /**
     * Získá cenová data (15minutové sloty)
     * 
     * STRATEGIE:
     * 1. Nejdřív zkusí cache
     * 2. Pokud není v cache:
     *    a) Kontroluje, jestli už neprobíhá fetch pro tento den (lock)
     *    b) Pokud ano → počká na výsledek
     *    c) Pokud ne → zahájí nový fetch
     * 3. Uloží do cache (sdílená mezi všemi devices)
     * 
     * NEŘÍDÍ RETRY - pouze vrací data nebo hodí chybu
     * Retry logiku má na starosti Device nebo IntervalManager
     * 
     * @returns {Promise<Object>} { today: Array<96>, tomorrow: Array<96|0>, fetchedAt, dateKey }
     * @throws {Error} Pokud fetch selže nebo data nejsou validní
     * 
     * @example
     * const data = await api.getPrices();
     * // {
     * //   today: [
     * //     { hour: 0, minute: 0, priceCZK: 1.23, priceEur: 0.05 },
     * //     { hour: 0, minute: 15, priceCZK: 1.25, priceEur: 0.05 },
     * //     ...96 slotů
     * //   ],
     * //   tomorrow: [...],
     * //   fetchedAt: '2025-10-05T12:30:00.000Z',
     * //   dateKey: '20251005'
     * // }
     */
    async getPrices() {
        const timeInfo = this.getCurrentTimeInfo();
        const cacheManager = this.getCacheManager();
        const cacheKey = `prices_${timeInfo.dateKey}`;

        try {
            // 1. NEJDŘÍV ZKUS CACHE
            const cachedData = cacheManager.get(cacheKey);
            if (cachedData) {
                this.logger.debug('✓ Data načtena z cache', { 
                    cacheKey,
                    todaySlots: cachedData.today?.length,
                    tomorrowSlots: cachedData.tomorrow?.length
                });
                return cachedData;
            }

            // 2. ZKONTROLUJ LOCK - probíhá už fetch pro tento den?
            if (this._fetchLocks.has(timeInfo.dateKey)) {
                this.logger.debug('⏳ Čekám na probíhající API fetch', { 
                    dateKey: timeInfo.dateKey 
                });
                
                // Počkej na výsledek z prvního device
                await this._fetchLocks.get(timeInfo.dateKey);
                
                // Zkus znovu načíst z cache (mělo by tam být)
                const cachedAfterWait = cacheManager.get(cacheKey);
                if (cachedAfterWait) {
                    this.logger.debug('✓ Data načtena z cache po čekání na lock', { 
                        cacheKey 
                    });
                    return cachedAfterWait;
                }
                
                // Pokud stále není v cache, něco se pokazilo
                throw new Error('Data nejsou v cache ani po dokončení prvního fetchování');
            }

            // 3. ZAHAJ NOVÉ FETCHOVÁNÍ
            this.logger.debug('🔄 Zahajuji nové API volání', { 
                dateKey: timeInfo.dateKey 
            });
            
            const fetchPromise = this._performFetch(timeInfo, cacheKey);
            this._fetchLocks.set(timeInfo.dateKey, fetchPromise);

            try {
                // Počkej na výsledek
                const result = await fetchPromise;
                return result;
            } finally {
                // Vyčisti lock po dokončení (úspěch i chyba)
                this._fetchLocks.delete(timeInfo.dateKey);
            }

        } catch (error) {
            this.logger.error('❌ Chyba při získávání dat', {
                error: error.message,
                dateKey: timeInfo.dateKey
            });
            // Jen propaguj chybu - retry řeší device/IntervalManager
            throw error;
        }
    }

    /**
     * INTERNÍ METODA: Provede skutečné API volání a zpracování
     * 
     * Volána pouze když:
     * - Není data v cache
     * - Neprobíhá jiné fetchování (lock)
     * 
     * @private
     * @param {Object} timeInfo - časové info z getCurrentTimeInfo()
     * @param {string} cacheKey - klíč pro cache
     * @returns {Promise<Object>} zpracovaná data
     * @throws {Error} pokud API vrátí chybu nebo nevalidní data
     */
    async _performFetch(timeInfo, cacheKey) {
        const cacheManager = this.getCacheManager();

        // 1. FETCH Z API
        this.logger.debug('📡 Volám API endpoint', { 
            dateKey: timeInfo.dateKey,
            url: `${this.baseUrl}/get-prices-json-qh`
        });
        
        const rawData = await this.fetchAPI(`${this.baseUrl}/get-prices-json-qh`);

        // 2. ZÁKLADNÍ VALIDACE STRUKTURY
        if (!rawData?.hoursToday || !Array.isArray(rawData.hoursToday)) {
            throw new Error('Neplatná struktura dat z API - chybí hoursToday');
        }

        // 3. VALIDACE POČTU SLOTŮ
        if (rawData.hoursToday.length !== 96) {
            this.logger.warn('⚠️ Neočekávaný počet slotů', {
                expected: 96,
                received: rawData.hoursToday.length
            });
            
            // Pokud je méně než 96, je to problém
            if (rawData.hoursToday.length < 96) {
                throw new Error(`Neúplná data - pouze ${rawData.hoursToday.length}/96 slotů`);
            }
        }

        // 4. ZPRACOVÁNÍ - pouze potřebné atributy
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

        // 5. ULOŽ DO CACHE (sdílené mezi všemi devices)
        cacheManager.set(cacheKey, processedData, 'PRICE_DAILY');

        this.logger.debug('✅ Data úspěšně načtena z API a uložena do cache', {
            dateKey: timeInfo.dateKey,
            todaySlots: processedData.today.length,
            tomorrowSlots: processedData.tomorrow.length,
            fetchedAt: processedData.fetchedAt
        });

        return processedData;
    }

    // ==================== POMOCNÉ METODY PRO PRÁCI SE SLOTY ====================

    /**
     * Najde aktuální slot v datech
     * 
     * Používá timeInfo.hour a timeInfo.minute (zaokrouhlené na 15min)
     * 
     * @param {Array} slots - pole slotů z getPrices().today
     * @param {Object} [timeInfo] - časové info (optional, vytvoří se nové)
     * @returns {Object|null} aktuální slot nebo null
     * 
     * @example
     * const slots = await api.getPrices();
     * const currentSlot = api.findCurrentSlot(slots.today);
     * // { hour: 14, minute: 30, priceCZK: 1.23, priceEur: 0.05 }
     */
    findCurrentSlot(slots, timeInfo = null) {
        if (!Array.isArray(slots) || slots.length === 0) {
            this.logger.warn('findCurrentSlot: prázdné nebo nevalidní sloty');
            return null;
        }

        if (!timeInfo) {
            timeInfo = this.getCurrentTimeInfo();
        }

        const currentSlot = slots.find(s => 
            s.hour === timeInfo.hour && s.minute === timeInfo.minute
        );

        if (!currentSlot) {
            this.logger.debug('Aktuální slot nenalezen', { 
                searchFor: `${timeInfo.hour}:${String(timeInfo.minute).padStart(2, '0')}`,
                availableSlots: slots.length
            });
        }

        return currentSlot || null;
    }

    /**
     * Najde následující slot po daném slotu
     * 
     * @param {Array} slots - pole slotů
     * @param {Object} currentSlot - aktuální slot
     * @returns {Object|null} následující slot nebo null (pokud je to poslední slot dne)
     * 
     * @example
     * const nextSlot = api.findNextSlot(slots.today, currentSlot);
     * // { hour: 14, minute: 45, priceCZK: 1.30, priceEur: 0.05 }
     */
    findNextSlot(slots, currentSlot) {
        if (!Array.isArray(slots) || !currentSlot) {
            this.logger.warn('findNextSlot: nevalidní parametry');
            return null;
        }

        const currentIndex = slots.findIndex(s => 
            s.hour === currentSlot.hour && s.minute === currentSlot.minute
        );

        if (currentIndex === -1) {
            this.logger.warn('Aktuální slot nenalezen v poli', {
                currentSlot: `${currentSlot.hour}:${currentSlot.minute}`
            });
            return null;
        }

        if (currentIndex === slots.length - 1) {
            // Poslední slot dne - další je první slot zítřka
            this.logger.debug('Poslední slot dne - příští slot je zítra');
            return null;
        }

        return slots[currentIndex + 1];
    }

    /**
     * Najde N po sobě jdoucích nejlevnějších slotů
     * 
     * Používá sliding window algoritmus
     * 
     * @param {Array} slots - pole slotů
     * @param {number} count - počet po sobě jdoucích slotů (např. 4 = 1 hodina)
     * @returns {Object|null} { startHour, startMinute, avgPrice, totalPrice, slots }
     * 
     * @example
     * // Najdi nejlevnější 1 hodinu (4 sloty)
     * const cheapest = api.findCheapestConsecutive(slots.today, 4);
     * // {
     * //   startHour: 3,
     * //   startMinute: 0,
     * //   avgPrice: 1.15,
     * //   totalPrice: 4.60,
     * //   slots: [...]
     * // }
     */
    findCheapestConsecutive(slots, count) {
        if (!Array.isArray(slots) || slots.length < count) {
            this.logger.warn('findCheapestConsecutive: nedostatek slotů', {
                available: slots?.length,
                required: count
            });
            return null;
        }

        let minSum = Infinity;
        let minIndex = 0;

        // Sliding window přes všechny možné pozice
        for (let i = 0; i <= slots.length - count; i++) {
            const sum = slots.slice(i, i + count)
                .reduce((s, slot) => s + slot.priceCZK, 0);
            
            if (sum < minSum) {
                minSum = sum;
                minIndex = i;
            }
        }

        const cheapestSlots = slots.slice(minIndex, minIndex + count);

        return {
            startHour: cheapestSlots[0].hour,
            startMinute: cheapestSlots[0].minute,
            avgPrice: Math.round(minSum / count * 100) / 100,
            totalPrice: Math.round(minSum * 100) / 100,
            slots: cheapestSlots
        };
    }

    /**
     * Vypočítá percentil z pole cen
     * 
     * Používá lineární interpolaci mezi hodnotami
     * 
     * @param {Array<number>} prices - pole cen
     * @param {number} percentile - percentil (0-100)
     * @returns {number} hodnota na daném percentilu
     * 
     * @example
     * const prices = slots.map(s => s.priceCZK);
     * const p25 = api.calculatePercentile(prices, 25); // 1. kvartil
     * const median = api.calculatePercentile(prices, 50); // medián
     * const p75 = api.calculatePercentile(prices, 75); // 3. kvartil
     */
    calculatePercentile(prices, percentile) {
        if (!Array.isArray(prices) || prices.length === 0) {
            this.logger.warn('calculatePercentile: prázdné pole cen');
            return 0;
        }

        const sorted = [...prices].sort((a, b) => a - b);
        const index = (percentile / 100) * (sorted.length - 1);
        const lower = Math.floor(index);
        const upper = Math.ceil(index);
        const weight = index % 1;

        if (lower === upper) {
            return sorted[lower];
        }

        // Lineární interpolace
        return sorted[lower] * (1 - weight) + sorted[upper] * weight;
    }

    // ==================== HTTP REQUEST ====================

    /**
     * Fetch data z API s timeoutem
     * 
     * Používá axios s cancel tokenem pro timeout handling
     * 
     * @param {string} url - URL endpointu
     * @param {number} [timeoutMs=10000] - timeout v ms
     * @returns {Promise<Object>} data z API
     * @throws {Error} pokud request selže nebo timeout
     */
    async fetchAPI(url, timeoutMs = 10000) {
        let timeout;
        
        try {
            const source = axios.CancelToken.source();
            timeout = setTimeout(() => {
                source.cancel(`Timeout po ${timeoutMs}ms`);
            }, timeoutMs);

            const { data } = await axios.get(url, {
                cancelToken: source.token,
                validateStatus: status => status === 200,
                timeout: timeoutMs
            });

            this.logger.debug('✓ API odpověď OK', { 
                url,
                hasHoursToday: !!data.hoursToday,
                todayCount: data.hoursToday?.length,
                hasHoursTomorrow: !!data.hoursTomorrow,
                tomorrowCount: data.hoursTomorrow?.length
            });

            return data;

        } catch (error) {
            const errorMessage = axios.isCancel(error)
                ? `Timeout (${timeoutMs}ms)`
                : error.response
                    ? `HTTP ${error.response.status}: ${error.response.statusText}`
                    : error.message;

            this.logger.error('❌ API request selhala', { 
                url, 
                error: errorMessage 
            });
            
            throw new Error(`API error: ${errorMessage}`);
            
        } finally {
            if (timeout) clearTimeout(timeout);
        }
    }

    // ==================== CACHE MANAGEMENT ====================

    /**
     * Vyčistí cache pro dané datum
     * 
     * @param {string} dateKey - datum ve formátu YYYYMMDD
     * @returns {boolean} true pokud cache existovala a byla smazána
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
     * Vyčistí všechny aktivní locky
     * 
     * Pro debugging - běžně by se nemělo používat
     */
    clearAllLocks() {
        const lockCount = this._fetchLocks.size;
        this._fetchLocks.clear();
        this.logger.debug('🔓 Všechny fetch locky vyčištěny', { 
            clearedLocks: lockCount 
        });
    }

    /**
     * Vrátí stav aktivních locků (pro debugging)
     * @returns {Array<string>} pole aktivních dateKeys
     */
    getActiveLocks() {
        return Array.from(this._fetchLocks.keys());
    }

    // ==================== CLEANUP ====================

    /**
     * Ukončí API instanci a vyčistí zdroje
     */
    destroy() {
        this.clearAllLocks();
        this.logger.debug('SpotPriceAPI instance ukončena');
        SpotPriceAPI.instance = null;
    }
}

module.exports = SpotPriceAPI;