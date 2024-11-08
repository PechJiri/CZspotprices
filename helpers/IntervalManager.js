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
        this.logger = null; // Přidáme property pro logger
    }

    // Přidáme metodu pro nastavení loggeru
    setLogger(logger) {
        this.logger = logger;
        if (this.logger) {
            this.logger.debug('IntervalManager: Logger inicializován');
        }
    }

    // Getter pro logger instance pro možnost kontroly
    getLogger() {
        return this.logger;
    }

    // Nastavení intervalu s počátečním zpožděním
    setScheduledInterval(key, callback, interval, initialDelay = 0) {
        // Vyčistíme existující interval a timeout pro daný klíč
        this.clearScheduledInterval(key);

        if (this.logger) {
            this.logger.debug('Nastavuji nový interval', {
                key,
                interval,
                initialDelay
            });
        }

        // Pokud je initialDelay, nejprve naplánujeme timeout
        if (initialDelay > 0) {
            this.timeouts[key] = this.homey.setTimeout(() => {
                if (this.logger) {
                    this.logger.debug('Spouštím callback po initial delay', { key });
                }
                callback(); // Spustíme callback okamžitě po uplynutí delay
                // Nastavíme pravidelný interval
                this.intervals[key] = this.homey.setInterval(callback, interval);
            }, initialDelay);
        } else {
            // Bez zpoždění nastavíme rovnou interval
            this.intervals[key] = this.homey.setInterval(callback, interval);
        }
    }

    // Vyčištění konkrétního intervalu a timeoutu
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

    // Vyčištění všech intervalů a timeoutů
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

    // Helper pro výpočet zpoždění do další celé hodiny
    calculateDelayToNextHour() {
        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
        const delay = nextHour.getTime() - now.getTime();

        if (this.logger) {
            this.logger.debug('Vypočítáno zpoždění do další hodiny', { 
                currentTime: now.toISOString(),
                nextHour: nextHour.toISOString(),
                delayMs: delay 
            });
        }

        return delay;
    }
}

module.exports = IntervalManager;