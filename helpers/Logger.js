'use strict';

class Logger {
    static instance = null;
    static CONTEXT = 'Logger';
    static enabled = true;
    static LOG_LEVELS = {
        ERROR: 0,
        WARN: 1,
        INFO: 2,
        DEBUG: 3,
    };

    constructor(homeyInstance = null) {
        if (Logger.instance) {
            return Logger.instance;
        }

        // Instance Homey musí být předána nebo získána z kontextu
        this.homey = homeyInstance;
        
        // Nastavení pro rotaci logů
        this.maxLogSize = 200;
        this.logHistory = [];
        this.rotationInterval = 60 * 60 * 1000; // 1 hodina
        this.lastRotation = Date.now();

        // Formátování času
        this.timeFormat = 'iso';
        this.timeZone = 'Europe/Prague';

        // Error monitoring
        this.criticalErrors = new Set(['FATAL', 'CRITICAL', 'EMERGENCY']);
        this.errorCount = {};
        this.errorThreshold = 5;

        try {
            this.setupAutoRotation();
            this.log({
                type: 'info',
                message: 'Logger inicializován',
                timestamp: new Date().toISOString(),
                context: Logger.CONTEXT
            });
        } catch (error) {
            console.error('Chyba při inicializaci loggeru:', {
                error: error.message,
                stack: error.stack,
                context: Logger.CONTEXT
            });
            throw error;
        }

        Logger.instance = this;
    }

    static getInstance(homeyInstance = null) {
        if (!Logger.instance) {
            Logger.instance = new Logger(homeyInstance);
        }
        return Logger.instance;
    }

    static setEnabled(enabled) {
        Logger.enabled = enabled;
        if (Logger.instance) {
            Logger.instance.log(`Logování ${enabled ? 'zapnuto' : 'vypnuto'}`);
        }
    }

    setTimeFormat(format) {
        this.timeFormat = format;
        return this;
    }

    formatTime(date = new Date()) {
        try {
            switch (this.timeFormat) {
                case 'iso':
                    return date.toISOString();
                case 'local':
                    return date.toLocaleString('cs-CZ', {
                        timeZone: this.timeZone,
                        dateStyle: 'medium',
                        timeStyle: 'medium'
                    });
                case 'timestamp':
                    return date.getTime().toString();
                default:
                    return date.toISOString();
            }
        } catch (error) {
            return date.toISOString();
        }
    }

    setupAutoRotation() {
        setInterval(() => {
            this.rotateLogsIfNeeded();
        }, 5 * 60 * 1000);
    }

    rotateLogsIfNeeded() {
        const now = Date.now();
        if (now - this.lastRotation >= this.rotationInterval) {
            this.rotateLogs();
            this.lastRotation = now;
        }
    }

    rotateLogs() {
        try {
            if (this.logHistory.length > this.maxLogSize) {
                const oldestLog = this.logHistory[0];
                const newestLog = this.logHistory[this.logHistory.length - 1];

                this.logHistory = this.logHistory.slice(-Math.floor(this.maxLogSize / 2));

                this.debug('Provedena rotace logů', {
                    puvodniPocet: this.logHistory.length,
                    novyPocet: Math.floor(this.maxLogSize / 2),
                    nejstarsiLog: oldestLog?.timestamp,
                    nejnovejsiLog: newestLog?.timestamp,
                    casRotace: this.formatTime()
                });
            }
        } catch (error) {
            this.error('Chyba při rotaci logů', error);
        }
    }

    shouldAlert(error) {
        if (!error) return false;

        const errorKey = error.code || 'UNKNOWN';
        this.errorCount[errorKey] = (this.errorCount[errorKey] || 0) + 1;

        return (
            this.criticalErrors.has(error.code) ||
            this.errorCount[errorKey] >= this.errorThreshold
        );
    }

    async sendAlert(error) {
        try {
            await this.homey.notifications.createNotification({
                excerpt: `Kritická chyba: ${error.message}`,
                priority: 'high'
            });
        } catch (alertError) {
            this.error('Chyba při odesílání alertu', alertError);
        }
    }

    createLogEntry(type, message, data = {}) {
        return {
            timestamp: this.formatTime(),
            type,
            message,
            data
        };
    }

    addToHistory(type, message, data = {}) {
        const logEntry = this.createLogEntry(type, message, data);
        this.logHistory.push(logEntry);
        this.rotateLogsIfNeeded();
        return logEntry;
    }

    log(message, data = {}) {
        if (!Logger.enabled) return;

        const logEntry = this.addToHistory('info', message, data);
        this.homey.log({
            type: 'info',
            message,
            ...data,
            timestamp: logEntry.timestamp
        });
    }

    error(message, error, data = {}) {
        const logEntry = this.addToHistory('error', message, {
            error: error?.message,
            stack: error?.stack,
            ...data
        });

        this.homey.error({
            context: Logger.CONTEXT,
            type: 'error',
            message,
            error: error?.message,
            stack: error?.stack,
            ...data,
            timestamp: logEntry.timestamp
        });
    }

    debug(message, data = {}) {
        if (!Logger.enabled) return;

        const logEntry = this.addToHistory('debug', message, data);
        this.homey.log({
            type: 'debug',
            message,
            ...data,
            timestamp: logEntry.timestamp
        });
    }

    warn(message, data = {}) {
        if (!Logger.enabled) return;

        const logEntry = this.addToHistory('warning', message, data);
        this.homey.log({
            type: 'warning',
            message,
            ...data,
            timestamp: logEntry.timestamp
        });
    }

    getLogHistory() {
        return [...this.logHistory];
    }

    clearHistory() {
        const count = this.logHistory.length;
        this.logHistory = [];
        this.debug('Historie logů vyčištěna', { smazanychZaznamu: count });
    }
}

module.exports = Logger;