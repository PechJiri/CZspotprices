'use strict';

const Logger = require('../Logger');
const DataValidator = require('../DataValidator');
const SpotPriceAPI = require('../api');
const CacheManager = require('../CacheManager');

class TariffCalculator {
    static instance = null;
    static homeyInstance = null;
    static CONTEXT = 'TariffCalculator';

    static setHomeyInstance(homey) {
        TariffCalculator.homeyInstance = homey;
    }

    constructor(homeyInstance) {
        if (TariffCalculator.instance) {
            throw new Error('Použijte TariffCalculator.getInstance() místo volání new.');
        }
        
        const instanceToUse = homeyInstance || TariffCalculator.homeyInstance;
        
        if (!instanceToUse) {
            throw new Error('HomeyInstance musí být poskytnut');
        }

        this.logger = Logger.getInstance()
        this.homey = instanceToUse;
        this.validator = DataValidator.getInstance(instanceToUse);
        this.cacheManager = CacheManager.getInstance(instanceToUse);
    }

    getSpotPriceAPI() {
        if (!this._spotPriceApi) {
            this._spotPriceApi = SpotPriceAPI.getInstance(this.homey);
        }
        return this._spotPriceApi;
    }

    static getInstance(homeyInstance) {
        if (!TariffCalculator.instance) {
            TariffCalculator.instance = new TariffCalculator(homeyInstance);
        }
        return TariffCalculator.instance;
    }

    /**
     * ✅ OPTIMALIZOVÁNO: Získá hodiny s nízkým tarifem
     * ZMĚNY:
     * - Odstraněno duplicitní logování z cache
     * - Log jen při reálném výpočtu (cache miss)
     * 
     * @param {Object} settings - Nastavení tarifu
     * @returns {Array<number>} - Pole hodin s nízkým tarifem
     */
    getTariffHours(settings) {
        try {
            // Stabilní cache klíč obsahující JEN relevantní hour_0..hour_23 pole
            const tariffKey = Array.from({ length: 24 }, (_, i) =>
                settings[`hour_${i}`] ? '1' : '0').join('');
            const cacheKey = `tariff_hours_${tariffKey}`;

            // Pokus o získání z cache
            const cachedHours = this.cacheManager.get(cacheKey);
            if (cachedHours !== null) {
                return cachedHours;
            }

            //Přímý filter bez validace
            const tarifniHodiny = Array.from({ length: 24 }, (_, i) => i)
                .filter(i => settings[`hour_${i}`]);

            // Uložení do cache s neomezenou platností
            this.cacheManager.set(cacheKey, tarifniHodiny, 'DEFAULT');

            // Log jen při prvním výpočtu
            this.logger?.debug('🔢 Tarif vypočten a uložen do cache', {
                tarifniHodiny,
                počet: tarifniHodiny.length
            });

            return tarifniHodiny;
        } catch (error) {
            this.logger?.error('Chyba při získávání hodin tarifu:', error);
            // ✅ FALLBACK: Vrať prázdné pole místo vyhození chyby
            return [];
        }
    }

    /**
     * 
     * BUSINESS LOGIKA SETTINGS:
     * - hour_X = TRUE  → hodina JE v LOW tarifu (levnější) ✅
     * - hour_X = FALSE → hodina NENÍ v LOW tarifu (dražší HIGH tariff) ❌
     * 
     * @param {Object} settings - Nastavení tarifu
     * @returns {Map<number, boolean>} Mapa hour → isLowTariff
     */
    getTariffMap(settings) {
        try {
            // ✅ Cache klíč obsahuje JEN tarify (hour_0 až hour_23)
            const tariffKeys = Array.from({ length: 24 }, (_, i) => `hour_${i}`)
                .map(key => `${key}:${settings[key] ? '1' : '0'}`)
                .join('|');
            
            const cacheKey = `tariff_map_${tariffKeys}`;
            
            // Kontrola cache
            const cachedMap = this.cacheManager.get(cacheKey);
            if (cachedMap) {
                return cachedMap;
            }

            // Vytvoření mapy pro všechny hodiny
            const tariffMap = new Map();
            for (let hour = 0; hour < 24; hour++) {
                const key = `hour_${hour}`;
                
                // ✅ OPRAVENO: Přímá logika bez inverze
                // hour_X = true  → LOW tariff (levný)
                // hour_X = false → HIGH tariff (drahý)
                const isLowTariff = settings[key] === true;
                
                tariffMap.set(hour, isLowTariff);
            }

            // Uložení do cache
            this.cacheManager.set(cacheKey, tariffMap, 'DEFAULT');

            // ✅ UPRAVENÝ LOG: Ukáže low i high hodiny pro kontrolu
            const lowTariffHours = [];
            const highTariffHours = [];
            
            for (let hour = 0; hour < 24; hour++) {
                if (tariffMap.get(hour)) {
                    lowTariffHours.push(hour);
                } else {
                    highTariffHours.push(hour);
                }
            }

            this.logger?.debug('Tariff mapa vytvořena', {
                mapSize: tariffMap.size,
                lowTariffHours,   // ✅ Hodiny s LOW tarifem
                highTariffHours   // ✅ Hodiny s HIGH tarifem (pro kontrolu)
            });

            return tariffMap;

        } catch (error) {
            this.logger?.error('Chyba při vytváření tariff mapy', error);
            return new Map();
        }
    }

    /**
     * ✅ OPTIMALIZOVÁNO: Kontroluje, zda je v danou hodinu nízký tarif
     * ZMĚNY:
     * - Odstraněno VEŠKERÉ duplicitní logování
     * - Žádné logy v běžném běhu (data z cache)
     * 
     * @param {number} hour - Hodina ke kontrole
     * @param {Object} settings - Nastavení tarifu
     * @returns {boolean} - Zda je v danou hodinu nízký tarif
     */
    isLowTariff(hour, settings) {
        try {
            if (!this.validator.validateTariffHour(hour)) {
                this.logger?.warn('Neplatná hodina pro kontrolu tarifu', { hour });
                return false;
            }

            // Stabilní cache klíč obsahující JEN relevantní hour_0..hour_23 pole
            const tariffKey = Array.from({ length: 24 }, (_, i) =>
                settings[`hour_${i}`] ? '1' : '0').join('');
            const cacheKey = `low_tariff_${hour}_${tariffKey}`;

            // Pokus o získání z cache
            const cachedResult = this.cacheManager.get(cacheKey);
            if (cachedResult !== null) {
                return cachedResult;
            }

            // Normalizace hodiny pro případ hodnoty 24
            const normalizedHour = hour === 24 ? 0 : hour;

            const tarifniHodiny = this.getTariffHours(settings);
            const jeNizkyTarif = tarifniHodiny.includes(normalizedHour);

            // Uložení do cache (tarif se mění jen při úpravě settings - DEFAULT TTL stačí)
            this.cacheManager.set(cacheKey, jeNizkyTarif, 'DEFAULT');

            return jeNizkyTarif;
        } catch (error) {
            this.logger?.error('Chyba při kontrole nízkého tarifu:', error);
            // ✅ FALLBACK: Předpokládej vysoký tarif (bezpečnější)
            return false;
        }
    }

    /**
     * ✅ OPRAVA: Správná inicializace tarifu při startu
     * Voláno z device.onInit() → initializeHelpers()
     */
    async initializeInitialTariff(device) {
        try {
            const { hour: currentHour } = this.getSpotPriceAPI().getCurrentTimeInfo();
            const settings = device.getSettings();
            
            // ✅ Použij getTariffMap místo isLowTariff (pro konzistenci)
            const tariffMap = this.getTariffMap(settings);
            const isLowTariff = tariffMap.get(currentHour) || false;
            
            const initialTariff = isLowTariff ? 'low' : 'high';
            await device.setStoreValue('previousTariff', initialTariff);
            
            this.logger?.debug('🎬 Inicializován počáteční tarif', {
                currentHour,
                hourSetting: settings[`hour_${currentHour}`],
                isLowTariff,
                initialTariff,
                deviceId: device.getData().id
            });
            
            return initialTariff;
        } catch (error) {
            this.logger?.error('❌ Chyba při inicializaci počátečního tarifu', error);
            throw error;
        }
    }

    async checkTariffChange(device, currentHour) {
        try {
            const settings = device.getSettings();
            const isLowTariff = this.isLowTariff(currentHour, settings);
            
            const previousTariff = await device.getStoreValue('previousTariff');
            const currentTariff = isLowTariff ? 'low' : 'high';
    
            if (previousTariff !== currentTariff) {
                // ✅ ZACHOVÁNO: Důležitý log o změně tarifu
                this.logger?.debug('🔄 Změna tarifu detekována', {
                    previousTariff,
                    currentTariff,
                    currentHour
                });
    
                await device.setStoreValue('previousTariff', currentTariff);
                const triggerData = { previousTariff, currentTariff };
    
                // Spustit příslušné triggery (app-level: trigger(tokens, state))
                // Pozn.: when-distribution-tariff-changes se spouští z CapabilityManager
                // při skutečné změně capability low_tariff (reakce na change capability).
                if (currentTariff === 'high') {
                    const trigger = device.triggersManager.getTrigger('when-high-tariff-starts');
                    if (trigger) {
                        await trigger.trigger({}, triggerData);
                    }
                } else {
                    const trigger = device.triggersManager.getTrigger('when-low-tariff-starts');
                    if (trigger) {
                        await trigger.trigger({}, triggerData);
                    }
                }
            }
            // ✅ ODSTRANĚNO: Log při žádné změně
        } catch (error) {
            this.logger?.error('Chyba při kontrole změny tarifu', error);
        }
    }
}

module.exports = TariffCalculator;