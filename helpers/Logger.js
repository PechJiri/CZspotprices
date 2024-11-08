'use strict';

class Logger {
    constructor(homey, context) {
        this.homey = homey;
        this.context = context;
        this.enabled = false; // Výchozí stav logování
    }

    // Nastavení stavu logování
    setEnabled(enabled) {
        this.enabled = enabled;
        this.log(`Logování ${enabled ? 'zapnuto' : 'vypnuto'}`);
    }

    // Standardní log
    log(message, data = {}) {
        if (!this.enabled) return;
        
        this.homey.log(JSON.stringify({
            context: this.context,
            type: 'info',
            message,
            ...data
        }));
    }

    // Error log - vždy se loguje bez ohledu na enabled
    error(message, error, data = {}) {
        this.homey.error(JSON.stringify({
            context: this.context,
            type: 'error',
            message,
            error: error.message,
            stack: error.stack,
            ...data
        }));
    }

    // Debug log
    debug(message, data = {}) {
        if (!this.enabled) return;
        
        this.homey.log(JSON.stringify({
            context: this.context,
            type: 'debug',
            message,
            ...data
        }));
    }

    // Warning log
    warn(message, data = {}) {
        if (!this.enabled) return;
        
        this.homey.log(JSON.stringify({
            timestamp: new Date().toISOString(),
            context: this.context,
            type: 'warning',
            message,
            ...data
        }));
    }
}

// Opravený export
module.exports = Logger;