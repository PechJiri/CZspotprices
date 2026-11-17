'use strict';

const Logger = require('../Logger');
const DataValidator = require('../DataValidator');
const TariffCalculator = require('./TariffCalculator');
const CacheManager = require('../CacheManager');
const SettingsManager = require('../SettingsManager');
const SpotPriceAPI = require('../api');
const LockManager = require('../LockManager');

/**
 * PriceCalculationEngine - výpočty cen pro 15minutové sloty
 * Podporuje sliding window průměry přes 15min intervaly
 */
class PriceCalculationEngine {
    static instance = null;
    static CONTEXT = 'PriceCalculationEngine';

    static getInstance(homey, deviceContext = 'PriceCalculatorEngine') {
        if (!PriceCalculationEngine.instance) {
            PriceCalculationEngine.instance = new PriceCalculationEngine(homey, deviceContext);
        }
        return PriceCalculationEngine.instance;
    }

    constructor(homeyInstance, deviceContext) {
        if (PriceCalculationEngine.instance) {
            throw new Error('Použijte PriceCalculationEngine.getInstance() místo volání new.');
        }
        
        this.logger = Logger.getInstance();
        this.validator = DataValidator.getInstance(homeyInstance);
        this.tariffCalculator = TariffCalculator.getInstance(homeyInstance);
        this.SettingsManager = SettingsManager.getInstance(homeyInstance);
        
        if (!this.SettingsManager) {
            throw new Error('SettingsManager není inicializován');
        }

        this.homey = homeyInstance;
        this.deviceContext = deviceContext;
        this.cacheManager = CacheManager.getInstance(homeyInstance);
        
        // ✅ POUŽIJ existující LockManager místo vlastní Map
        this.lockManager = LockManager.getInstance(homeyInstance);
    }

    static setHomeyInstance(homey) {
        if (!homey) {
            throw new Error('Homey instance je vyžadována pro PriceCalculationEngine');
        }
        PriceCalculationEngine.homeyInstance = homey;
    }

    getSpotPriceAPI() {
        if (!this._spotPriceApi) {
            this._spotPriceApi = SpotPriceAPI.getInstance(this.homey);
        }
        return this._spotPriceApi;
    }

    // ==================== UNIVERZÁLNÍ METODY ====================

    /**
     * Přidání distribučního tarifu a případného DPH k základní ceně
     * OPTIMALIZOVÁNO: Přijímá tariffMap místo settings
     * 
     * @param {number} basePrice - Základní cena komodity
     * @param {Object} settings - Nastavení zařízení
     * @param {number} hour - Aktuální hodina (0-23)
     * @param {Map<number, boolean>} [tariffMap] - Předpočítaná mapa tarifů (optional)
     * @returns {number} - Konečná cena včetně distribuce a případného DPH
     */
    addDistributionPrice(basePrice, settings, hour, tariffMap = null) {
        try {
            const cacheKey = `distribution_${basePrice}_${hour}_${settings.low_tariff_price}_${settings.high_tariff_price}_${settings.commodity_price_with_vat}`;
            const cachedPrice = this.cacheManager.get(cacheKey);
            if (cachedPrice !== null) {
                return cachedPrice;
            }

            if (!this.validator.validatePrice(basePrice, 'základní cena pro distribuci')) {
                return basePrice;
            }

            // Přidání DPH
            const addVAT = (price) => {
                if (!settings.commodity_price_with_vat) {
                    return price;
                }
                return price * 1.21;
            };

            const priceWithVAT = addVAT(basePrice);

            const lowTariffPrice = parseFloat(settings.low_tariff_price) || 0;
            const highTariffPrice = parseFloat(settings.high_tariff_price) || 0;

            // ✅ VYŽADUJEME tariffMap - žádný fallback
            if (!tariffMap) {
                this.logger?.error('tariffMap je povinný parametr!', {
                    hour,
                    basePrice
                });
                // Fallback: HIGH tarif (bezpečnější než LOW)
                return priceWithVAT + highTariffPrice;
            }

            // O(1) lookup - ŽÁDNÝ LOG
            const isLowTariff = tariffMap.get(hour) || false;
            const finalPrice = priceWithVAT + (isLowTariff ? lowTariffPrice : highTariffPrice);

            this.cacheManager.set(cacheKey, finalPrice, 'PRICE');

            return finalPrice;
        } catch (error) {
            this.logger?.error('Chyba v addDistributionPrice', error);
            return basePrice;
        }
    }

    /**
     * Konverze ceny z MWh na kWh
     * 
     * @param {number} price - Cena v MWh
     * @param {boolean} priceInKWh - Má se konvertovat na kWh?
     * @returns {number} - Cena v MWh nebo kWh
     */
    convertPrice(price, priceInKWh) {
        try {
            if (!priceInKWh) {
                return price;
            }
    
            if (!this.validator.validatePrice(price, 'cena pro konverzi')) {
                return price;
            }
    
            return price / 1000;
        } catch (error) {
            this.logger?.error('Chyba při konverzi ceny:', error);
            return price;
        }
    }

    /**
     * Výpočet minimální a maximální ceny z pole slotů
     * 
     * @param {Array} prices - Pole slotů s cenami [{priceCZK: number}, ...]
     * @returns {Object} - {minPrice, maxPrice}
     */
    async calculateMinMaxPrices(prices) {
        try {
            const cacheKey = `minmax_${prices.map(p => p.priceCZK).join('_')}`;
            
            const cachedResult = this.cacheManager.get(cacheKey);
            if (cachedResult) {
                return cachedResult;
            }
    
            const priceValues = prices.map(p => p.priceCZK);
            const minPrice = Math.min(...priceValues);
            const maxPrice = Math.max(...priceValues);
    
            const result = { minPrice, maxPrice };
            this.cacheManager.set(cacheKey, result, 'AVERAGE');
    
            return result;
        } catch (error) {
            this.logger?.error('Chyba při výpočtu min/max cen', error);
            throw error;
        }
    }

    // ==================== 15MINUTOVÉ SLOTY ====================

    /**
     * Získá data konkrétního slotu přímo z API/cache (ne z capabilities)
     * 
     * @param {Object} device - Device instance
     * @param {number} hour - Hodina (0-23)
     * @param {number} minute - Minuta (0, 15, 30, 45)
     * @returns {Object|null} - {hour, minute, price, rawPrice} nebo null
     */
    async getSlotData(device, hour, minute) {
        try {
            // Získat data z API (ta jsou v cache)
            const data = await this.getSpotPriceAPI().getPrices();
            
            const slot = data.today.find(s => s.hour === hour && s.minute === minute);
            
            if (!slot) {
                this.logger?.warn(`Chybí data pro slot ${hour}:${minute}`);
                return null;
            }

            // Přidání distribuce (tarif podle hodiny)
            const finalPrice = this.addDistributionPrice(
                slot.priceCZK,
                device.getSettings(),
                hour
            );

            // Konverze pokud je nastaveno
            const priceInKWh = device.getSetting('price_in_kwh') || false;
            const convertedPrice = this.convertPrice(finalPrice, priceInKWh);

            return {
                hour: slot.hour,
                minute: slot.minute,
                price: convertedPrice,
                rawPrice: slot.priceCZK
            };
        } catch (error) {
            this.logger?.error('Chyba při získávání dat slotu', error);
            return null;
        }
    }

    /**
     * Vypočítá průměrné ceny pro různé slotové intervaly (sliding window)
     * 
     * ✅ HYBRID PŘÍSTUP S LOCK MECHANISMEM:
     * - Cache klíč používá dateKey → platnost do půlnoci
     * - První volání pro daný interval = compute + cache
     * - Další volání = cache hit (až do půlnoci)
     * - LockManager = prevence race condition (paralelní výpočty stejných dat)
     * 
     * LOCK MECHANISMUS (přes LockManager):
     * - Pokud probíhá výpočet pro stejný cache klíč, další volání čekají
     * - Po dokončení prvního výpočtu všichni sdílí výsledek z cache
     * - Eliminuje duplicitní výpočty při paralelním vyhodnocení conditions
     * 
     * @param {Object} device - Device instance
     * @param {number} slots - Počet 15min slotů (4 = 1 hodina, 8 = 2 hodiny...)
     * @param {number} startFromSlot - Index slotu odkud začít (0-95)
     * @returns {Array} - Pole kombinací [{startSlotIndex, startHour, startMinute, averagePrice, totalPrice, slots, intervalLength}]
     */
    async calculateAverageSlotPrices(device, slots, startFromSlot = 0) {
        const operationId = `calc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        try {
            const timeInfo = this.getSpotPriceAPI().getCurrentTimeInfo();
            
            // ✅ HYBRID: Cache klíč s dateKey místo currentSlotIndex
            // → Cache platná do půlnoci, ne jen 15 minut
            const cacheKey = `slots_avg_${slots}_${startFromSlot}_${timeInfo.dateKey}_${device.getSetting('price_in_kwh')}`;
            
            // ✅ 1. CACHE CHECK (lazy evaluation)
            const cachedResult = this.cacheManager.get(cacheKey);
            if (cachedResult) {
                this.logger?.debug('✅ HYBRID Cache HIT', { 
                    interval: `${slots} slotů`,
                    dateKey: timeInfo.dateKey,
                    combinations: cachedResult.length,
                    benefit: 'Žádný recompute nutný do půlnoci'
                });
                return cachedResult;
            }

            // ✅ 2. LOCK CHECK - použij LockManager pro získání zámku
            const lockAcquired = await this.lockManager.acquireLock(cacheKey, operationId);
            
            if (!lockAcquired) {
                // Lock se nepodařilo získat = jiná operace už počítá stejná data
                this.logger?.debug('⏳ Čekám na probíhající výpočet (lock nepodařilo získat)', {
                    interval: `${slots} slotů`,
                    startFrom: startFromSlot,
                    cacheKey: cacheKey.substring(0, 50) + '...',
                    operationId
                });
                
                // Počkej chvilku a zkus znovu načíst z cache
                // (První výpočet by měl mezitím dokončit)
                await new Promise(resolve => setTimeout(resolve, 100));
                
                // Zkus max 50x (= 5 sekund celkem)
                for (let i = 0; i < 50; i++) {
                    const cachedAfterWait = this.cacheManager.get(cacheKey);
                    if (cachedAfterWait) {
                        this.logger?.debug('✅ Cache HIT po čekání na lock', {
                            interval: `${slots} slotů`,
                            combinations: cachedAfterWait.length,
                            waitedMs: (i + 1) * 100,
                            benefit: 'Ušetřen duplicitní výpočet'
                        });
                        return cachedAfterWait;
                    }
                    
                    // Počkej dalších 100ms
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                
                // Po 5 sekundách čekání stále nic - něco se pokazilo
                this.logger?.error('❌ Timeout čekání na lock', {
                    cacheKey: cacheKey.substring(0, 50) + '...',
                    waitedSeconds: 5
                });
                
                throw new Error('Timeout při čekání na dokončení výpočtu');
            }

            // ✅ 3. CACHE MISS - první použití tohoto intervalu dnes
            // Lock byl úspěšně získán, můžeme počítat
            this.logger?.debug('❌ HYBRID Cache MISS - lazy compute', {
                interval: `${slots} slotů`,
                startFrom: startFromSlot,
                dateKey: timeInfo.dateKey,
                operationId,
                důvod: 'První použití tohoto intervalu dnes'
            });

            try {
                // ✅ 4. PROVEĎ VÝPOČET
                const result = await this._performCalculation(
                    device, 
                    slots, 
                    startFromSlot, 
                    timeInfo, 
                    cacheKey
                );
                
                return result;
                
            } finally {
                // ✅ 5. VŽDY UVOLNI LOCK (úspěch i chyba)
                this.lockManager.releaseLock(cacheKey, operationId);
                
                this.logger?.debug('🔓 Lock uvolněn', {
                    cacheKey: cacheKey.substring(0, 50) + '...',
                    operationId
                });
            }

        } catch (error) {
            this.logger?.error('❌ Chyba při výpočtu průměrných cen slotů', error, {
                operationId
            });
            return [];
        }
    }

    /**
     * Provede samotný výpočet průměrných cen (extrahováno kvůli lock mechanismu)
     * 
     * Tato metoda obsahuje původní business logiku z calculateAverageSlotPrices():
     * 1. Získá data z API/cache
     * 2. Vytvoří tariffMap JEDNOU pro celý batch
     * 3. Sliding window přes sloty
     * 4. Počítá průměrné ceny pro každou kombinaci
     * 5. Uloží do cache
     * 
     * @private
     * @param {Object} device - Device instance
     * @param {number} slots - Počet slotů v intervalu
     * @param {number} startFromSlot - Index odkud začít
     * @param {Object} timeInfo - Časové info z getCurrentTimeInfo()
     * @param {string} cacheKey - Klíč pro cache
     * @returns {Promise<Array>} Pole kombinací
     */
    async _performCalculation(device, slots, startFromSlot, timeInfo, cacheKey) {
        try {
            // ✅ 1. Získat data z API/cache
            const data = await this.getSpotPriceAPI().getPrices();
            const allSlots = data.today;

            if (!allSlots || allSlots.length === 0) {
                this.logger?.warn('⚠️ Žádná data slotů k dispozici');
                return [];
            }

            // ✅ 2. Vytvoř tariffMap JEDNOU na začátku (batch optimalizace)
            const settings = device.getSettings();
            const tariffMap = device.tariffCalculator.getTariffMap(settings);
            
            this.logger?.debug('🚀 Batch zpracování kombinací', {
                totalSlots: allSlots.length,
                intervalSize: slots,
                startFrom: startFromSlot,
                willProcess: allSlots.length - slots - startFromSlot + 1
            });

            const combinations = [];

            // ✅ 3. Sliding window přes sloty
            for (let i = startFromSlot; i <= allSlots.length - slots; i++) {
                const windowSlots = allSlots.slice(i, i + slots);
                
                let totalPrice = 0;
                const processedSlots = [];

                for (const slot of windowSlots) {
                    // Přidání distribučního tarifu (podle hodiny)
                    const finalPrice = this.addDistributionPrice(
                        slot.priceCZK,
                        settings,
                        slot.hour,
                        tariffMap  // ✅ Použij předvytvořenou mapu
                    );
                    
                    // Konverze na kWh pokud je nastaveno
                    const convertedPrice = this.convertPrice(
                        finalPrice,
                        device.getSetting('price_in_kwh')
                    );
                    
                    totalPrice += convertedPrice;
                    processedSlots.push({
                        hour: slot.hour,
                        minute: slot.minute,
                        price: convertedPrice
                    });
                }

                combinations.push({
                    startSlotIndex: i,
                    startHour: windowSlots[0].hour,
                    startMinute: windowSlots[0].minute,
                    averagePrice: totalPrice / slots,
                    totalPrice: totalPrice,
                    slots: processedSlots,
                    intervalLength: slots
                });
            }

            // ✅ 4. Uložit do cache (platné do půlnoci)
            this.cacheManager.set(cacheKey, combinations, 'AVERAGE');

            this.logger?.debug('✅ HYBRID: Kombinace uloženy do cache', {
                počet: combinations.length,
                interval: `${slots} slotů`,
                startFrom: startFromSlot,
                dateKey: timeInfo.dateKey,
                platnostDo: 'půlnoc',
                dalšíVolání: 'cache hit až do půlnoci'
            });

            return combinations;

        } catch (error) {
            this.logger?.error('❌ Chyba při výpočtu kombinací', error);
            throw error;
        }
    }

    /**
     * Vypočítá zbývající slotové kombinace od aktuálního času do konce dne
     * 
     * @param {Object} device - Device instance
     * @param {number} slots - Počet 15min slotů v intervalu
     * @param {number} startFromSlot - Volitelný index slotu odkud začít (jinak aktuální)
     * @returns {Array} - Pole kombinací od aktuálního času
     */
    async calculateRemainingSlotPrices(device, slots, startFromSlot = null) {
        try {
            const timeInfo = this.getSpotPriceAPI().getCurrentTimeInfo();
            const currentSlotIndex = startFromSlot !== null 
                ? startFromSlot 
                : (timeInfo.hour * 4) + Math.floor(timeInfo.minute / 15);

            this.logger?.debug('Výpočet zbývajících slotů', {
                slots,
                currentSlotIndex,
                startFromSlot
            });

            return await this.calculateAverageSlotPrices(device, slots, currentSlotIndex);
        } catch (error) {
            this.logger?.error('Chyba při výpočtu zbývajících slotů', error);
            return [];
        }
    }

    /**
     * Najde nejlevnější N po sobě jdoucích slotů v celém dni
     * 
     * @param {Object} device - Device instance
     * @param {number} slotCount - Počet slotů
     * @returns {Object|null} - Nejlevnější kombinace nebo null
     */
    async findCheapestSlots(device, slotCount) {
        try {
            const combinations = await this.calculateAverageSlotPrices(device, slotCount, 0);
            
            if (combinations.length === 0) {
                this.logger?.warn('Žádné kombinace k dispozici pro hledání nejlevnějších slotů');
                return null;
            }

            const cheapest = combinations.sort((a, b) => a.averagePrice - b.averagePrice)[0];

            this.logger?.debug('Nejlevnější sloty nalezeny', {
                start: `${cheapest.startHour}:${String(cheapest.startMinute).padStart(2, '0')}`,
                avgPrice: cheapest.averagePrice.toFixed(2),
                slotCount
            });

            return cheapest;
        } catch (error) {
            this.logger?.error('Chyba při hledání nejlevnějších slotů', error);
            return null;
        }
    }

    /**
     * Najde nejdražší N po sobě jdoucích slotů v celém dni
     * 
     * @param {Object} device - Device instance
     * @param {number} slotCount - Počet slotů
     * @returns {Object|null} - Nejdražší kombinace nebo null
     */
    async findMostExpensiveSlots(device, slotCount) {
        try {
            const combinations = await this.calculateAverageSlotPrices(device, slotCount, 0);
            
            if (combinations.length === 0) {
                this.logger?.warn('Žádné kombinace k dispozici pro hledání nejdražších slotů');
                return null;
            }

            const expensive = combinations.sort((a, b) => b.averagePrice - a.averagePrice)[0];

            this.logger?.debug('Nejdražší sloty nalezeny', {
                start: `${expensive.startHour}:${String(expensive.startMinute).padStart(2, '0')}`,
                avgPrice: expensive.averagePrice.toFixed(2),
                slotCount
            });

            return expensive;
        } catch (error) {
            this.logger?.error('Chyba při hledání nejdražších slotů', error);
            return null;
        }
    }

    /**
     * Kontrola a trigger pro průměrné ceny slotů
     * Volá se každých 15 minut z IntervalManageru
     * 
     * @param {Object} device - Device instance
     * @param {Object} triggerCard - Flow trigger karta
     * @param {Object} timeInfo - Aktuální čas {hour, minute, ...}
     * @returns {boolean} - Úspěch operace
     */
    async checkAverageSlotPriceAndTrigger(device, triggerCard, timeInfo) {
        try {
            const currentSlotIndex = (timeInfo.hour * 4) + Math.floor(timeInfo.minute / 15);
            
            this.logger?.debug('🔔 checkAverageSlotPriceAndTrigger ZAHÁJEN', {
                currentSlotIndex,
                currentTime: `${timeInfo.hour}:${String(timeInfo.minute).padStart(2, '0')}`
            });
            
            const flows = await triggerCard.getArgumentValues();

            this.logger?.debug('📋 Nalezené flows', {
                flowCount: flows.length,
                flows: flows.map(f => ({ 
                    count: f.count, 
                    interval_type: f.interval_type, 
                    condition: f.condition 
                }))
            });

            for (const flow of flows) {
                const { count, condition, interval_type } = flow;
                
                // ✅ VOLÁNÍ centrální metody
                const actualSlotCount = this.convertToSlotCount(count, interval_type);
                
                this.logger?.debug('🔍 Zpracovávám flow', {
                    count,
                    interval_type,
                    actualSlotCount,
                    condition
                });
                
                if (currentSlotIndex + actualSlotCount > 96) {
                    this.logger?.debug('⚠️ Nedostatek slotů', {
                        currentSlotIndex,
                        požadovanéSloty: actualSlotCount
                    });
                    continue;
                }

                const combinations = await this.calculateAverageSlotPrices(
                    device, 
                    actualSlotCount, 
                    0
                );
                
                if (combinations.length === 0) {
                    continue;
                }

                const targetCombination = this.getTargetCombination(combinations, condition);

                if (this.isCurrentSlotMatch(targetCombination, currentSlotIndex)) {
                    // App-level trigger: trigger(tokens, state)
                    await triggerCard.trigger({
                        average_price: parseFloat(targetCombination.averagePrice.toFixed(2))
                    });

                    this.logger?.info('✅ Average slot price trigger AKTIVOVÁN', {
                        originalCount: count,
                        interval_type,
                        actualSlots: actualSlotCount,
                        condition,
                        averagePrice: targetCombination.averagePrice.toFixed(2)
                    });
                }
            }

            return true;
        } catch (error) {
            this.logger?.error('❌ Chyba v checkAverageSlotPriceAndTrigger', error);
            return false;
        }
    }

    /**
     * ✅ UNIVERZÁLNÍ METODA: Přepočet hodin/intervalů na počet 15min slotů
     * 
     * Používá se v:
     * - TriggersManager
     * - ConditionsManager
     * - Interním volání v PriceCalculationEngine
     * 
     * @param {number} count - Zadaný počet (např. 4)
     * @param {string} interval_type - Typ intervalu ('hours' nebo 'intervals')
     * @returns {number} Počet 15min slotů
     * 
     * @example
     * convertToSlotCount(4, 'hours') // → 16 (4 hodiny = 16 slotů)
     * convertToSlotCount(4, 'intervals') // → 4 (4 sloty = 4 sloty)
     * convertToSlotCount(4, null) // → 4 (fallback: intervals)
     */
    convertToSlotCount(count, interval_type) {
        // Validace count
        if (!count || count <= 0) {
            this.logger?.warn('⚠️ Neplatný count, používám 1', { count });
            return 1;
        }

        // Pokud chybí interval_type, předpokládej 'intervals' (zpětná kompatibilita)
        if (!interval_type) {
            this.logger?.debug('ℹ️ Chybí interval_type, předpokládám "intervals"', { count });
            return count;
        }

        // Přepočet podle typu
        switch (interval_type) {
            case 'hours':
                const slots = count * 4;
                return slots;

            case 'intervals':
                this.logger?.debug('✅ Použití intervalů přímo', {
                    intervals: count
                });
                return count;

            default:
                // Neznámý typ - fallback na intervals
                this.logger?.error('❌ Neznámý interval_type, používám jako intervals', { 
                    interval_type, 
                    count 
                });
                return count;
        }
    }

    // ==================== UTILITY METODY ====================

    /**
     * Najde target kombinaci podle podmínky (lowest/highest)
     * 
     * @param {Array} combinations - Pole kombinací
     * @param {string} condition - 'lowest' nebo 'highest'
     * @returns {Object} - Nalezená kombinace
     */
    getTargetCombination(combinations, condition) {
        if (!combinations || combinations.length === 0) {
            return null;
        }

        const sortedCombinations = combinations.sort((a, b) =>
            condition === 'lowest' 
                ? a.averagePrice - b.averagePrice 
                : b.averagePrice - a.averagePrice
        );
        
        return sortedCombinations[0];
    }

    /**
     * Kontrola zda aktuální slot odpovídá začátku kombinace
     * 
     * @param {Object} combination - Kombinace s startSlotIndex
     * @param {number} currentSlotIndex - Aktuální index slotu (0-95)
     * @returns {boolean} - True pokud se shoduje
     */
    isCurrentSlotMatch(combination, currentSlotIndex) {
        if (!combination || typeof combination !== 'object') {
            return false;
        }
        return combination.startSlotIndex === currentSlotIndex;
    }

    /**
     * Kontrola validity cache podle timestamp
     * 
     * @param {number} timestamp - Timestamp z cache
     * @returns {boolean} - True pokud je cache stále platná
     */
    isCacheValid(timestamp) {
        const now = Date.now();
        const maxAge = this.cacheManager?.TTL.AVERAGE || 15 * 60 * 1000; // 15 minut default
        return now - timestamp < maxAge;
    }

    /**
     * Logování chyby s kontextem metody
     * 
     * @param {string} methodName - Název metody kde došlo k chybě
     * @param {Error} error - Error objekt
     */
    logCalculationError(methodName, error) {
        if (this.logger) {
            this.logger.error(`Chyba v metodě ${methodName}:`, {
                message: error.message,
                stack: error.stack
            });
        }
    }

    /**
     * Logování vypočtených kombinací
     * 
     * @param {Array} combinations - Pole kombinací
     * @param {number} slots - Počet slotů v intervalu
     */
    logCombinationsCalculated(combinations, slots) {
        if (this.logger) {
            this.logger.debug('Vypočtené kombinace průměrných cen', {
                počet: combinations.length,
                slotůVIntervalu: slots,
                prvníKombinace: combinations[0] ? {
                    start: `${combinations[0].startHour}:${String(combinations[0].startMinute).padStart(2, '0')}`,
                    avg: combinations[0].averagePrice.toFixed(2)
                } : null
            });
        }
    }
}

module.exports = PriceCalculationEngine;