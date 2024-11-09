'use strict';

class Logger {
    constructor(homey, context) {
        this.homey = homey;
        this.context = context;
        this.enabled = false; // Výchozí stav logování
        
        // Nastavení pro rotaci logů
        this.maxLogSize = 1000; // Maximální počet záznamů
        this.logHistory = [];
        this.rotationInterval = 60 * 60 * 1000; // 1 hodina
        this.lastRotation = Date.now();
        
        // Nastavení automatické rotace
        this.setupAutoRotation();
    }

    // Nastavení rotace logů
    setupAutoRotation() {
        setInterval(() => {
            this.rotateLogsIfNeeded();
        }, 5 * 60 * 1000); // Kontrola každých 5 minut
    }

    // Kontrola a provedení rotace logů
    rotateLogsIfNeeded() {
        const now = Date.now();
        if (now - this.lastRotation >= this.rotationInterval) {
            this.rotateLogs();
            this.lastRotation = now;
        }
    }

    // Rotace logů
    rotateLogs() {
        try {
            if (this.logHistory.length > this.maxLogSize) {
                const timestamp = new Date().toISOString();
                const oldestLog = this.logHistory[0];
                const newestLog = this.logHistory[this.logHistory.length - 1];

                // Ponecháme pouze nejnovější logy
                this.logHistory = this.logHistory.slice(-Math.floor(this.maxLogSize / 2));

                this.debug('Provedena rotace logů', {
                    původníPočet: this.logHistory.length,
                    novýPočet: Math.floor(this.maxLogSize / 2),
                    nejstaršíLog: oldestLog?.timestamp,
                    nejnovějšíLog: newestLog?.timestamp,
                    časRotace: timestamp
                });
            }
        } catch (error) {
            this.error('Chyba při rotaci logů', error);
        }
    }

    // Přidání záznamu do historie
    addToHistory(type, message, data = {}) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            type,
            context: this.context,
            message,
            data
        };

        this.logHistory.push(logEntry);
        this.rotateLogsIfNeeded();

        return logEntry;
    }

    // Nastavení stavu logování
    setEnabled(enabled) {
        this.enabled = enabled;
        this.log(`Logování ${enabled ? 'zapnuto' : 'vypnuto'}`);
    }

    // Standardní log
    log(message, data = {}) {
        if (!this.enabled) return;
        
        const logEntry = this.addToHistory('info', message, data);
        
        this.homey.log(JSON.stringify({
            context: this.context,
            type: 'info',
            message,
            ...data,
            timestamp: logEntry.timestamp
        }));
    }

    // Error log - vždy se loguje bez ohledu na enabled
    error(message, error, data = {}) {
        const logEntry = this.addToHistory('error', message, {
            error: error?.message,
            stack: error?.stack,
            ...data
        });

        this.homey.error(JSON.stringify({
            context: this.context,
            type: 'error',
            message,
            error: error?.message,
            stack: error?.stack,
            ...data,
            timestamp: logEntry.timestamp
        }));
    }

    // Debug log
    debug(message, data = {}) {
        if (!this.enabled) return;
        
        const logEntry = this.addToHistory('debug', message, data);
        
        this.homey.log(JSON.stringify({
            context: this.context,
            type: 'debug',
            message,
            ...data,
            timestamp: logEntry.timestamp
        }));
    }

    // Warning log
    warn(message, data = {}) {
        if (!this.enabled) return;
        
        const logEntry = this.addToHistory('warning', message, data);
        
        this.homey.log(JSON.stringify({
            context: this.context,
            type: 'warning',
            message,
            ...data,
            timestamp: logEntry.timestamp
        }));
    }

    // Získání historie logů
    getLogHistory() {
        return [...this.logHistory];
    }

    // Vyčištění historie logů
    clearHistory() {
        const count = this.logHistory.length;
        this.logHistory = [];
        this.debug('Historie logů vyčištěna', { smazanýchZáznamů: count });
    }

    // Získání statistik logů
    getLogStats() {
        const stats = {
            total: this.logHistory.length,
            byType: {},
            oldestLog: this.logHistory[0]?.timestamp,
            newestLog: this.logHistory[this.logHistory.length - 1]?.timestamp,
            lastRotation: new Date(this.lastRotation).toISOString()
        };

        // Počítání logů podle typu
        this.logHistory.forEach(log => {
            stats.byType[log.type] = (stats.byType[log.type] || 0) + 1;
        });

        return stats;
    }
}

module.exports = Logger;