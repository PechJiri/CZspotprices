'use strict';

class Logger {
   static instance = null;
   static CONTEXT = 'Logger';
   static enabled = true;

   constructor(homeyInstance = null) {
       if (Logger.instance) {
           return Logger.instance;
       }

       if (!homeyInstance) {
           throw new Error('Homey instance je vyžadována pro Logger');
       }

       this.homey = homeyInstance;

       // Základní log při inicializaci
       this.homey.log({
           type: 'info',
           message: 'Logger inicializován',
           timestamp: new Date().toISOString(),
           context: Logger.CONTEXT
       });

       Logger.instance = this;
   }

   static getInstance(homeyInstance = null) {
       if (!Logger.instance) {
           Logger.instance = new Logger(homeyInstance);
       }
       return Logger.instance;
   }

   static setEnabled(enabled) {
       const previousState = Logger.enabled;
       Logger.enabled = enabled;
       
       if (Logger.instance && previousState !== enabled) {
           // Toto logujeme přímo, bez ohledu na stav enabled
           Logger.instance.homey.log(`Logování ${enabled ? 'zapnuto' : 'vypnuto'}`);
       }
   }

   formatLog(type, message, data = {}) {
       return {
           type,
           message,
           ...data
       };
   }

   log(message, data = {}) {
       if (Logger.enabled) {
           this.homey.log(this.formatLog('info', message, data));
       }
   }

   error(message, error, data = {}) {
       // Error logy jdou vždy
       this.homey.error(this.formatLog('error', message, {
           error: error?.message,
           stack: error?.stack,
           ...data
       }));
   }

   debug(message, data = {}) {
       if (Logger.enabled) {
           this.homey.log(this.formatLog('debug', message, data));
       }
   }

    warn(message, data = {}) {
        if (Logger.enabled) {
            this.homey.log(this.formatLog('warn', message, data));
        }
    }
}

module.exports = Logger;