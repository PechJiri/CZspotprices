'use strict';

const Logger = require('./Logger');
const PriceCalculationEngine = require('./pricecalculation/PriceCalculationEngine');


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
        this.intervals = new Map();
        this.timeouts = new Map();
        this.logger = Logger.getInstance()
        this.PriceCalculationEngine = PriceCalculationEngine.getInstance()
        this.logger.debug('IntervalManager: Logger inicializován');
    }

    static setHomeyInstance(homey) {
        if (!homey) {
            throw new Error('Homey instance je vyžadována pro IntervalManager');
        }
        IntervalManager.homeyInstance = homey;
    }

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

    setScheduledInterval(key, callback, interval, initialDelay = 0) {
        try {
            this.validateIntervalParams(key, callback, interval);
            this.clearExistingInterval(key);
            
            const timeInfo = this.calculateTimeInfo(initialDelay, interval);
            this.logIntervalSetup(key, timeInfo);

            if (initialDelay > 0) {
                this.setupDelayedInterval(key, callback, interval, initialDelay);
            } else {
                this.setupImmediateInterval(key, callback, interval);
            }

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

    clearExistingInterval(key) {
        if (this.intervals.has(key) || this.timeouts.has(key)) {
            this.logger.debug('Čištění existujícího intervalu/timeoutu', { key });
            this.clearScheduledInterval(key);
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

    setupDelayedInterval(key, callback, interval, initialDelay) {
        const timeoutId = this.homey.setTimeout(() => {
            try {
                callback();
                const intervalId = this.homey.setInterval(callback, interval);
                this.intervals.set(key, intervalId);
                this.logIntervalStart(key, interval);
            } catch (error) {
                this.logger.error('Chyba při spuštění callbacku', error);
            }
        }, initialDelay);

        this.timeouts.set(key, timeoutId);
    }

    setupImmediateInterval(key, callback, interval) {
        const intervalId = this.homey.setInterval(callback, interval);
        this.intervals.set(key, intervalId);
        this.logIntervalStart(key, interval);
    }

    clearScheduledInterval(key) {
        if (this.intervals.has(key)) {
            this.homey.clearInterval(this.intervals.get(key));
            this.intervals.delete(key);
            this.logger.debug('Interval vyčištěn', { key });
        }
        if (this.timeouts.has(key)) {
            this.homey.clearTimeout(this.timeouts.get(key));
            this.timeouts.delete(key);
            this.logger.debug('Timeout vyčištěn', { key });
        }
    }

    clearAll() {
        this.logger.debug('Vyčišťuji všechny intervaly a timeouty');
        
        for (const key of this.intervals.keys()) {
            this.clearScheduledInterval(key);
        }
        
        this.logger.debug('Všechny intervaly a timeouty vyčištěny');
    }

    calculateDelayToNextHour() {
        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
        const delay = nextHour.getTime() - now.getTime();

        this.logger.debug('Vypočítáno zpoždění do další hodiny', {
            currentTime: this.formatDateTime(now),
            nextHour: this.formatDateTime(nextHour),
            delay: this.formatDuration(delay)
        });

        return delay;
    }

    formatDateTime(date) {
        return date.toLocaleString('cs-CZ', { 
            timeZone: 'Europe/Prague',
            dateStyle: 'medium',
            timeStyle: 'medium'
        });
    }

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

    logIntervalSetup(key, timeInfo) {
        this.logger.debug('Nastavení intervalu', {
            key,
            currentTime: timeInfo.current.formatted,
            nextRun: timeInfo.next.formatted,
            delay: timeInfo.delay.formatted,
            interval: timeInfo.interval.formatted
        });
    }

    logIntervalStart(key, interval) {
        this.logger.debug('Interval spuštěn', {
            key,
            nextRun: this.formatDateTime(new Date(Date.now() + interval))
        });
    }

    async scheduleDeviceUpdates(device, runImmediately = false) {
        try {
            this.logger?.debug('Začátek nastavení plánovaných úloh pro zařízení');
            
            const initialDelay = this.calculateDelayToNextHour();
            
            // Plánování hodinových updatů
            await this.scheduleHourlyDeviceUpdate(device, initialDelay);
            
            // Plánování kontroly průměrných cen
            await this.scheduleAveragePriceCheck(device, initialDelay);
            
            // Plánování kontroly tarifu
            await this.scheduleTariffCheck(device, initialDelay);
            
            // Okamžité spuštění pokud požadováno
            if (runImmediately) {
                await this.executeImmediateUpdates(device);
            }
            
            this.logger?.log('Plánované úlohy nastaveny', {
                deviceId: device.getData().id,
                nextUpdateIn: Math.round(initialDelay / 60000)
            });
            
            return true;
        } catch (error) {
            this.logger?.error('Chyba při nastavování plánovaných úloh', error);
            throw error;
        }
    }

    async scheduleHourlyDeviceUpdate(device, initialDelay) {
        const hourlyCallback = async () => {
            try {
                await device.updateHourlyData();
                await device.setStoreValue('lastHourlyUpdate', Date.now());
                this.logger?.debug('Hourly update completed', {
                    deviceId: device.getData().id
                });
            } catch (error) {
                this.logger?.error('Hourly update failed', error);
            }
        };
    
        this.setScheduledInterval(
            `hourly_${device.getData().id}`, // Unikátní ID pro každé zařízení
            hourlyCallback,
            60 * 60 * 1000,
            initialDelay
        );
    }
    
    async scheduleAveragePriceCheck(device, initialDelay) {
        const averagePriceCallback = async () => {
            try {
                const triggerCard = device.homey.flow.getDeviceTriggerCard('average-price-trigger');
                const timeInfo = device.spotPriceApi.getCurrentTimeInfo();
                await device.priceCalculationEngine.checkAveragePriceAndTrigger(device, triggerCard, timeInfo);
                await device.setStoreValue('lastAverageUpdate', Date.now());
            } catch (error) {
                this.logger?.error('Average price check failed', error);
            }
        };
    
        this.setScheduledInterval(
            `average_${device.getData().id}`,
            averagePriceCallback,
            60 * 60 * 1000,
            initialDelay
        );
    }
    
    async scheduleTariffCheck(device, initialDelay) {
        const tariffCallback = async () => {
            try {
                const { hour } = device.spotPriceApi.getCurrentTimeInfo();
                await device.tariffCalculator.checkTariffChange(device, hour);
            } catch (error) {
                this.logger?.error('Tariff check failed', error);
            }
        };
    
        this.setScheduledInterval(
            `tariff_${device.getData().id}`,
            tariffCallback,
            60 * 60 * 1000,
            initialDelay
        );
    }
    
    async executeImmediateUpdates(device) {
        try {
            const now = new Date();
            const currentHour = now.setMinutes(0, 0, 0);
            const [lastHourlyUpdate, lastAverageUpdate] = await Promise.all([
                device.getStoreValue('lastHourlyUpdate'),
                device.getStoreValue('lastAverageUpdate')
            ]);
    
            const tasks = [];
    
            if (!lastHourlyUpdate || new Date(lastHourlyUpdate).getTime() < currentHour) {
                tasks.push(device.updateHourlyData());
            } else {
                this.logger?.debug('Skipping immediate hourly update - already done this hour', {
                    deviceId: device.getData().id
                });
            }
    
            if (!lastAverageUpdate || new Date(lastAverageUpdate).getTime() < currentHour) {
                tasks.push(PriceCalculationEngine.checkAveragePriceAndTrigger());
            } else {
                this.logger?.debug('Skipping immediate average price check - already done this hour', {
                    deviceId: device.getData().id
                });
            }
    
            if (tasks.length > 0) {
                await Promise.all(tasks);
            }
        } catch (error) {
            this.logger?.error('Error executing immediate updates', error);
        }
    }

    getDelayToNextMidnight() {
        const now = new Date();
        const target = new Date(now);
        target.setHours(23, 0, 1, 0);
        
        let delay = target - now;
        if (delay < 0) {
            delay += 24 * 60 * 60 * 1000;
        }
        
        this.logger?.debug('Vypočten čas do příštího midnight update', {
            currentTime: now.toISOString(),
            nextUpdate: new Date(now.getTime() + delay).toISOString(),
            delayMinutes: Math.floor(delay / 60000)
        });
        
        return delay;
    }
}

module.exports = IntervalManager;