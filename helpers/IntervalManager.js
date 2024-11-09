'use strict';

class IntervalManager {
    constructor(homey) {
        this.homey = homey;
        this.intervals = {
            hourly: null,
            average: null,
            tariff: null,
            midnight: null
        };
        this.timeouts = {
            hourly: null,
            average: null,
            tariff: null,
            midnight: null
        };
        this.logger = null;
    }

    setLogger(logger) {
        this.logger = logger;
        if (this.logger) {
            this.logger.debug('IntervalManager: Logger inicializován');
        }
    }

    getLogger() {
        return this.logger;
    }

    setScheduledInterval(key, callback, interval, initialDelay = 0) {
        try {
            // Kontrola vstupních parametrů
            if (!key || typeof key !== 'string') {
                throw new Error('Neplatný klíč intervalu');
            }
            if (typeof callback !== 'function') {
                throw new Error('Callback musí být funkce');
            }
            if (typeof interval !== 'number' || interval <= 0) {
                throw new Error('Interval musí být kladné číslo');
            }
    
            // Kontrola existence intervalu a timeoutu
            if (this.intervals[key] || this.timeouts[key]) {
                if (this.logger) {
                    this.logger.debug('Nalezen existující interval/timeout, provádím vyčištění', {
                        key,
                        hasInterval: !!this.intervals[key],
                        hasTimeout: !!this.timeouts[key]
                    });
                }
                this.clearScheduledInterval(key);
            }
    
            if (this.logger) {
                this.logger.debug('Nastavuji nový interval', {
                    key,
                    interval,
                    initialDelay: this._formatDelay(initialDelay),
                    hasCallback: !!callback
                });
            }
    
            // Nastavení nového intervalu s initial delay
            if (initialDelay > 0) {
                this.timeouts[key] = this.homey.setTimeout(() => {
                    if (this.logger) {
                        this.logger.debug('Spouštím callback po initial delay', { key });
                    }
                    try {
                        callback();
                        // Nastavení pravidelného intervalu po uplynutí initial delay
                        this.intervals[key] = this.homey.setInterval(callback, interval);
    
                        if (this.logger) {
                            this.logger.debug('Interval nastaven po initial delay', { 
                                key,
                                nextRun: new Date(Date.now() + interval).toISOString()
                            });
                        }
                    } catch (error) {
                        if (this.logger) {
                            this.logger.error('Chyba při spuštění callbacku po initial delay', error, { key });
                        }
                    }
                }, initialDelay);
            } else {
                // Okamžité nastavení intervalu bez delay
                this.intervals[key] = this.homey.setInterval(callback, interval);
    
                if (this.logger) {
                    this.logger.debug('Interval nastaven okamžitě', { 
                        key,
                        nextRun: new Date(Date.now() + interval).toISOString()
                    });
                }
            }
    
            return true;
        } catch (error) {
            if (this.logger) {
                this.logger.error('Chyba při nastavování intervalu', error, {
                    key,
                    interval,
                    initialDelay
                });
            }
            throw error;
        }
    }

    clearScheduledInterval(key) {
        if (this.intervals[key]) {
            this.homey.clearInterval(this.intervals[key]);
            this.intervals[key] = null;
            if (this.logger) {
                this.logger.debug('Interval vyčištěn', { key });
            }
        }
        if (this.timeouts[key]) {
            this.homey.clearTimeout(this.timeouts[key]);
            this.timeouts[key] = null;
            if (this.logger) {
                this.logger.debug('Timeout vyčištěn', { key });
            }
        }
    }

    clearAll() {
        if (this.logger) {
            this.logger.debug('Vyčišťuji všechny intervaly a timeouty');
        }

        Object.keys(this.intervals).forEach(key => {
            this.clearScheduledInterval(key);
        });

        if (this.logger) {
            this.logger.debug('Všechny intervaly a timeouty vyčištěny');
        }
    }

    calculateDelayToNextHour() {
        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
        const delay = nextHour.getTime() - now.getTime();

        if (this.logger) {
            this.logger.debug('Vypočítáno zpoždění do další hodiny', {
                currentTime: now.toISOString(),
                nextHour: nextHour.toISOString(),
                delayInMs: delay,
                delayFormatted: this._formatDelay(delay)
            });
        }

        return delay;
    }

    _formatDelay(delay) {
        const hours = Math.floor(delay / (1000 * 60 * 60));
        const minutes = Math.floor((delay % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((delay % (1000 * 60)) / 1000);
        return `${hours} h ${minutes} m ${seconds} s`;
    }
}

module.exports = IntervalManager;