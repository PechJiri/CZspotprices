'use strict';

const Logger = require('./Logger');
const PriceCalculationEngine = require('./pricecalculation/PriceCalculationEngine');

/**
 * IntervalManager - správa časových intervalů pro 15minutový device
 * 
 * HYBRID CACHE STRATEGIE:
 * - Midnight: API fetch → Zpracování → Cache (dateKey) → Platnost do půlnoci
 * - 15min update: Read cache → Update 4 capabilities → Lazy eval triggers
 * - Tarify: Kontrola změny (hodinová - tarify jsou vždy hodinové!)
 * 
 * LAZY EVALUATION:
 * - První trigger daného intervalu → Compute → Cache (dateKey, platnost do půlnoci)
 * - Další triggery → Cache HIT (až do půlnoci)
 * - Automatická invalidace po půlnoci (nový dateKey)
 * 
 * @class IntervalManager
 * @singleton
 */
class IntervalManager {
    static instance = null;
    static CONTEXT = 'IntervalManager';

    static getInstance(homey) {
        if (!IntervalManager.instance) {
            IntervalManager.instance = new IntervalManager(homey);
        }
        return IntervalManager.instance;
    }

    constructor(homey) {
        if (IntervalManager.instance) {
            throw new Error('IntervalManager je singleton. Použijte IntervalManager.getInstance()');
        }
        
        this.homey = homey;
        this.tasks = new Map();
        this.masterIntervalId = null;
        this.logger = Logger.getInstance();
        this.PriceCalculationEngine = PriceCalculationEngine.getInstance(homey);
        
        this.startMasterClock();
        
        this.logger.debug('IntervalManager inicializován s JEDNÍM master timerem (HYBRID cache strategy)');
    }

    static setHomeyInstance(homey) {
        if (!homey) {
            throw new Error('Homey instance je vyžadována pro IntervalManager');
        }
        IntervalManager.homeyInstance = homey;
    }

    // ==================== ZÁKLADNÍ INTERVAL METODY ====================

    /**
     * Naplánuje více intervalů najednou
     * 
     * @param {Array} tasks - pole úloh { key, callback, interval, offset }
     * @param {number} [baseDelay=0] - základní zpoždění pro všechny úlohy
     * @returns {boolean} true pokud úspěšné
     * 
     * @example
     * scheduleMultipleIntervals([
     *   { key: 'update', callback: updateFn, interval: 900000, offset: 0 },
     *   { key: 'check', callback: checkFn, interval: 900000, offset: 5000 }
     * ]);
     */
    scheduleMultipleIntervals(tasks, baseDelay = 0) {
        try {
            if (!Array.isArray(tasks)) {
                throw new Error('Tasks musí být pole');
            }

            tasks.forEach((task, index) => {
                const { key, callback, interval, offset = 0 } = task;
                const totalDelay = baseDelay + offset;

                this.logger.debug('Plánuji interval', {
                    key,
                    offset,
                    totalDelay,
                    index
                });

                this.setScheduledInterval(key, callback, interval, totalDelay);
            });

            return true;
        } catch (error) {
            this.logger.error('Chyba při plánování více intervalů', error);
            throw error;
        }
    }

    /**
     * Nastaví naplánovaný interval s volitelným zpožděním
     * 
     * @param {string} key - jedinečný klíč intervalu
     * @param {Function} callback - funkce k provedení
     * @param {number} interval - interval v ms
     * @param {number} [initialDelay=0] - počáteční zpoždění v ms
     * @returns {boolean} true pokud úspěšné
     */
    setScheduledInterval(key, callback, interval, initialDelay = 0) {
        try {
            this.validateIntervalParams(key, callback, interval);
            this.clearScheduledInterval(key);
            
            const nextRun = Date.now() + initialDelay;
            this.tasks.set(key, {
                callback,
                interval,
                nextRun
            });
            
            const timeInfo = this.calculateTimeInfo(initialDelay, interval);
            this.logIntervalSetup(key, timeInfo);

            return true;
        } catch (error) {
            this.logger.error('Chyba při nastavování intervalu', error);
            throw error;
        }
    }

    validateIntervalParams(key, callback, interval) {
        if (!key || typeof key !== 'string') {
            throw new Error('Neplatný klíč intervalu');
        }
        if (typeof callback !== 'function') {
            throw new Error('Callback musí být funkce');
        }
        if (typeof interval !== 'number' || interval <= 0) {
            throw new Error('Interval musí být kladné číslo');
        }
    }

    calculateTimeInfo(initialDelay, interval) {
        const now = new Date();
        const nextRun = new Date(now.getTime() + initialDelay);
        
        return {
            current: {
                time: now,
                formatted: this.formatDateTime(now)
            },
            next: {
                time: nextRun,
                formatted: this.formatDateTime(nextRun)
            },
            delay: this.formatDuration(initialDelay),
            interval: this.formatDuration(interval)
        };
    }

    clearScheduledInterval(key) {
        if (this.tasks.has(key)) {
            this.tasks.delete(key);
            this.logger.debug('Naplánovaný task vyčištěn', { key });
        }
    }

    clearAll() {
        this.logger.debug('Vyčišťuji všechny naplánované tasky', { count: this.tasks.size });
        this.tasks.clear();
        this.logger.debug('Všechny tasky vyčištěny');
    }

    startMasterClock() {
        if (this.masterIntervalId) return;

        this.logger.debug('Spouštím Master Timer (každých 30 vteřin) pro všechna naplánovaná volání');
        
        // Cca každých 30 sekund
        this.masterIntervalId = this.homey.setInterval(() => this.tick(), 30000);
    }
    
    tick() {
        const now = Date.now();
        for (const [key, task] of this.tasks.entries()) {
            if (now >= task.nextRun) {
                // Přepočet dalšího spuštění
                task.nextRun += task.interval;
                if (now >= task.nextRun) {
                    task.nextRun = now + task.interval; // ochrana proti masivnímu driftu
                }
                
                // Spuštění neblokujícím způsobem, aby jedno nezdržovalo druhé v tomtéž ticku
                this.homey.setTimeout(() => {
                    try {
                        task.callback();
                    } catch(error) {
                        this.logger?.error('Chyba v master tasku', error, { key });
                    }
                }, 0);
            }
        }
    }

    // ==================== ČASOVÉ VÝPOČTY ====================

    /**
     * Vypočítá zpoždění do dalšího 15min slotu
     * 
     * 15min sloty: XX:00, XX:15, XX:30, XX:45
     * 
     * @returns {number} zpoždění v ms
     * 
     * @example
     * // Pokud je 14:37:42
     * const delay = calculateDelayToNextSlot(); // → ~2:18 do 14:45
     */
    calculateDelayToNextSlot() {
        const now = new Date();
        const minutes = now.getMinutes();

        // Další 15min slot
        const nextSlotMinute = Math.ceil((minutes + 1) / 15) * 15;
        
        const nextSlot = new Date(now);
        if (nextSlotMinute >= 60) {
            nextSlot.setHours(nextSlot.getHours() + 1, 0, 0, 0);
        } else {
            nextSlot.setMinutes(nextSlotMinute, 0, 0);
        }

        const delay = nextSlot.getTime() - now.getTime();

        this.logger.debug('Zpoždění do dalšího 15min slotu', {
            currentTime: this.formatDateTime(now),
            nextSlot: this.formatDateTime(nextSlot),
            delay: this.formatDuration(delay)
        });

        return delay;
    }

    /**
     * Vypočítá zpoždění do další hodiny (XX:00:00)
     * 
     * POUŽITÍ: Pro kontrolu tarifu (tarify jsou vždy hodinové!)
     * 
     * @returns {number} zpoždění v ms
     * 
     * @example
     * // Pokud je 14:37:42
     * const delay = calculateDelayToNextHour(); // → ~22:18 do 15:00
     */
    calculateDelayToNextHour() {
        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
        const delay = nextHour.getTime() - now.getTime();

        this.logger.debug('Zpoždění do další hodiny', {
            currentTime: this.formatDateTime(now),
            nextHour: this.formatDateTime(nextHour),
            delay: this.formatDuration(delay)
        });

        return delay;
    }

    /**
     * Vypočítá zpoždění do půlnoci (23:00:01)
     * 
     * POUŽITÍ: Pro midnight update - načtení nových dat z API
     * 
     * @returns {number} zpoždění v ms
     */
    getDelayToNextMidnight() {
        const now = new Date();
        const target = new Date(now);
        target.setHours(23, 0, 1, 0);
        
        let delay = target - now;
        if (delay < 0) {
            delay += 24 * 60 * 60 * 1000;
        }
        
        this.logger?.debug('Čas do půlnoci', {
            currentTime: now.toISOString(),
            nextUpdate: new Date(now.getTime() + delay).toISOString(),
            delayMinutes: Math.floor(delay / 60000)
        });
        
        return delay;
    }

    // ==================== HLAVNÍ PLÁNOVACÍ METODY ====================

    /**
     * Naplánuje všechny updaty pro device
     * 
     * HYBRID ARCHITEKTURA:
     * - 15min update: Read cache → Update 4 capabilities → Lazy eval triggers
     * - Tariff check: Kontrola změny tarifu (hodinová)
     * 
     * LAZY EVALUATION FLOW TRIGGERŮ:
     * - device.updateSlotData() volá checkAveragePrices()
     * - checkAveragePrices() volá priceCalculationEngine.checkAverageSlotPriceAndTrigger()
     * - První trigger intervalu → Cache MISS → Compute → Cache (dateKey)
     * - Další triggery → Cache HIT (až do půlnoci)
     * 
     * @param {Device} device - instance device
     * @param {boolean} [runImmediately=false] - spustit okamžitě před naplánováním
     * @returns {Promise<boolean>} true pokud úspěšné
     */
    async scheduleUpdates(device, runImmediately = false) {
        try {
            this.logger?.debug('📅 Plánování 15minutových updatů (HYBRID)', {
                deviceId: device.getData().id,
                runImmediately,
                strategie: 'Lazy evaluation pro flow triggery'
            });
            
            const slotDelay = this.calculateDelayToNextSlot();
            const hourDelay = this.calculateDelayToNextHour();
            
            // ✅ 1. 15minutové updaty (každých 15 min)
            // Obsahuje:
            // - Read cache → Update 4 capabilities
            // - checkAveragePrices() → Lazy eval (první trigger = compute, další = cache hit)
            await this.scheduleDeviceUpdate(device, slotDelay);
            
            // ✅ 2. Kontrola tarifu (každou hodinu - tarify jsou vždy hodinovÃ©!)
            await this.scheduleTariffCheck(device, hourDelay);
            
            // ✅ 3. Okamžité spuštění pokud požadováno
            if (runImmediately) {
                await this.executeImmediateUpdates(device);
            }
            
            this.logger?.debug('✅ Updaty naplánovány (HYBRID)', {
                deviceId: device.getData().id,
                nextSlotUpdateIn: Math.round(slotDelay / 60000) + ' min',
                nextTariffCheckIn: Math.round(hourDelay / 60000) + ' min'
            });
            
            return true;
        } catch (error) {
            this.logger?.error('Chyba při plánování updatů', error);
            throw error;
        }
    }

    /**
     * Naplánuje 15minutový update device
     * 
     * HYBRID FLOW:
     * 1. Read cache ('lastProcessedPrices')
     * 2. Update 4 capabilities (current, next)
     * 3. checkAveragePrices() → Lazy eval flow triggerů
     * 
     * @param {Device} device - instance device
     * @param {number} initialDelay - počáteční zpoždění v ms
     */
    async scheduleDeviceUpdate(device, initialDelay) {
        const updateCallback = async () => {
            try {
                // ✅ HYBRID: updateSlotData() dělá vše:
                // - Read cache
                // - Update capabilities
                // - checkAveragePrices() (lazy eval)
                await device.updateSlotData();
                await device.setStoreValue('lastSlotUpdate', Date.now());
                
                this.logger?.debug('✅ 15minutový update dokončen', {
                    deviceId: device.getData().id
                });
            } catch (error) {
                this.logger?.error('❌ 15minutový update selhal', error, {
                    deviceId: device.getData().id
                });
            }
        };
    
        this.setScheduledInterval(
            `slot_${device.getData().id}`,
            updateCallback,
            15 * 60 * 1000, // 15 minut
            initialDelay
        );
    }

    /**
     * Naplánuje kontrolu tarifu
     * 
     * DŮLEŽITÉ: Tarify jsou VŽDY hodinové, i pro 15min device!
     * Distribuční tarify se účtují podle hodiny, ne podle 15min slotu.
     * 
     * @param {Device} device - instance device
     * @param {number} initialDelay - počáteční zpoždění v ms (do další hodiny)
     */
    async scheduleTariffCheck(device, initialDelay) {
        const tariffCallback = async () => {
            try {
                const { hour } = device.spotPriceApi.getCurrentTimeInfo();
                await device.tariffCalculator.checkTariffChange(device, hour);
                
                this.logger?.debug('✅ Kontrola tarifu dokončena', {
                    deviceId: device.getData().id,
                    hour
                });
            } catch (error) {
                this.logger?.error('❌ Kontrola tarifu selhala', error, {
                    deviceId: device.getData().id
                });
            }
        };
    
        this.setScheduledInterval(
            `tariff_${device.getData().id}`,
            tariffCallback,
            60 * 60 * 1000, // 1 hodina (tarif se mění po hodinách!)
            initialDelay
        );
    }

    /**
     * Provede okamžité updaty při startu device
     * 
     * HYBRID STRATEGIE:
     * - Kontroluje jestli už nebyl update v aktuálním slotu
     * - Pokud ne → spustí device.updateSlotData() (který obsahuje checkAveragePrices)
     * - Důvod: Zajistí lazy eval i při restartu zařízení
     * 
     * @param {Device} device - instance device
     */
    async executeImmediateUpdates(device) {
        try {
            const now = new Date();
            const currentSlot = new Date(now);
            currentSlot.setMinutes(Math.floor(now.getMinutes() / 15) * 15, 0, 0);
            
            const lastSlotUpdate = await device.getStoreValue('lastSlotUpdate');

            // ✅ HYBRID: Kontrola zda už nebyl update v tomto slotu
            if (!lastSlotUpdate || new Date(lastSlotUpdate).getTime() < currentSlot.getTime()) {
                this.logger?.debug('🚀 Okamžitý update při startu', {
                    deviceId: device.getData().id,
                    currentSlot: currentSlot.toISOString(),
                    lastUpdate: lastSlotUpdate ? new Date(lastSlotUpdate).toISOString() : 'nikdy'
                });
                
                // ✅ updateSlotData() už obsahuje:
                // - Read cache
                // - Update capabilities
                // - checkAveragePrices() (lazy eval flow triggerů)
                await device.updateSlotData();
                
                this.logger?.debug('✅ Okamžitý update dokončen', {
                    deviceId: device.getData().id
                });
            } else {
                this.logger?.debug('⏭️ Přeskakuji okamžitý update (již proběhl)', {
                    deviceId: device.getData().id,
                    lastUpdate: new Date(lastSlotUpdate).toISOString()
                });
            }
        } catch (error) {
            this.logger?.error('❌ Chyba při okamžitém updatu', error, {
                deviceId: device.getData().id
            });
        }
    }

    // ==================== UTILITY ====================

    /**
     * Formátuje datum a čas pro logging
     * 
     * @param {Date} date - datum k formátování
     * @returns {string} formátované datum
     */
    formatDateTime(date) {
        return date.toLocaleString('cs-CZ', { 
            timeZone: 'Europe/Prague',
            dateStyle: 'medium',
            timeStyle: 'medium'
        });
    }

    /**
     * Formátuje délku trvání (ms) pro logging
     * 
     * @param {number} ms - milisekundy
     * @returns {Object} { ms, hours, minutes, seconds, formatted }
     */
    formatDuration(ms) {
        const hours = Math.floor(ms / (1000 * 60 * 60));
        const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((ms % (1000 * 60)) / 1000);
        
        return {
            ms,
            hours,
            minutes,
            seconds,
            formatted: `${hours}h ${minutes}m ${seconds}s`
        };
    }

    /**
     * Loguje nastavení intervalu
     * @private
     */
    logIntervalSetup(key, timeInfo) {
        this.logger.debug('Nastavení intervalu', {
            key,
            currentTime: timeInfo.current.formatted,
            nextRun: timeInfo.next.formatted,
            delay: timeInfo.delay.formatted,
            interval: timeInfo.interval.formatted
        });
    }

    /**
     * Loguje spuštění intervalu
     * @private
     */
    logIntervalStart(key, interval) {
        this.logger.debug('Interval spuštěn', {
            key,
            nextRun: this.formatDateTime(new Date(Date.now() + interval))
        });
    }

    // ==================== CLEANUP ====================

    /**
     * Ukončí IntervalManager instanci
     */
    destroy() {
        this.clearAll();
        if (this.masterIntervalId) {
            this.homey.clearInterval(this.masterIntervalId);
            this.masterIntervalId = null;
        }
        this.logger?.debug('IntervalManager instance ukončena');
        IntervalManager.instance = null;
    }
}

module.exports = IntervalManager;