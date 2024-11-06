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
    }

    // Nastavení intervalu s počátečním zpožděním
    setScheduledInterval(key, callback, interval, initialDelay = 0) {
        // Vyčistíme existující interval a timeout pro daný klíč
        this.clearScheduledInterval(key);

        // Pokud je initialDelay, nejprve naplánujeme timeout
        if (initialDelay > 0) {
            this.timeouts[key] = this.homey.setTimeout(() => {
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
        }
        if (this.timeouts[key]) {
            this.homey.clearTimeout(this.timeouts[key]);
            this.timeouts[key] = null;
        }
    }

    // Vyčištění všech intervalů a timeoutů
    clearAll() {
        Object.keys(this.intervals).forEach(key => {
            this.clearScheduledInterval(key);
        });
    }

    // Helper pro výpočet zpoždění do další celé hodiny
    calculateDelayToNextHour() {
        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
        return nextHour.getTime() - now.getTime();
    }
}

module.exports = IntervalManager;