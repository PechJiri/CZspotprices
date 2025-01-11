'use strict';

const Homey = require('homey');
const crypto = require('crypto');
const SpotPriceAPI = require('./api');
const IntervalManager = require('../../helpers/IntervalManager');
const PriceCalculator = require('../../helpers/pricecalculation/PriceCalculator');
const TariffCalculator = require('../../helpers/pricecalculation/TariffCalculator');
const PriceCalculationEngine = require('../../helpers/pricecalculation/PriceCalculationEngine');
const DataValidator = require('../../helpers/DataValidator');
const CacheManager = require('../../helpers/CacheManager');
const SettingsManager = require('../../helpers/SettingsManager');
const DeviceStateManager = require('../../helpers/DeviceStateManager');
const Logger = require('../../helpers/Logger');

class CZSpotPricesDriver extends Homey.Driver {
    static CONTEXT = 'CZSpotPricesDriver';

    async onInit() {
        try {
            // 1. Nejdříve Logger
            this.logger = Logger.getInstance(this.homey)
    
            if (!this.homey) {
                throw new Error('Homey instance není dostupná při inicializaci driveru.');
            }
    
            this.logger.log('Inicializace CZSpotPricesDriver');
    
            // 2. Základní pomocné třídy
            this.cacheManager = CacheManager.getInstance(this.homey);
            this.deviceStateManager = DeviceStateManager.getInstance(this.homey);
            this.dataValidator = DataValidator.getInstance(this.homey);
            this.settingsManager = SettingsManager.getInstance(this.homey);
    
            // 3. Hlavní business logika
            this.tariffCalculator = TariffCalculator.getInstance(this.homey);
            this.priceCalculationEngine = PriceCalculationEngine.getInstance(this.homey);
            this.priceCalculator = PriceCalculator.getInstance(this.homey);
    
            // 4. API a správa intervalů
            this.spotPriceApi = SpotPriceAPI.getInstance(this.homey);
            this.intervalManager = IntervalManager.getInstance(this.homey);
    
            // Inicializace
            await this.scheduleMidnightUpdate();
    
            this.logger.log('Driver úspěšně inicializován');
    
        } catch (error) {
            this.logger?.error('Chyba při inicializaci driveru', error, {
                driverId: this.id
            });
            throw error;
        }
    }

    static setHomeyInstance(homey) {
        if (!homey) {
            throw new Error('Homey instance je vyžadována pro Driver');
        }
        CZSpotPricesDriver.homeyInstance = homey;
    }

  async scheduleMidnightUpdate() {
    try {
        if (this.logger) {
            this.logger.log('Plánování midnight update');
        }

        // Callback pro půlnoční aktualizaci
        const midnightCallback = async () => {
            try {
                const devices = this.getDevices();
                const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
                
                if (this.logger) {
                    this.logger.debug('Spouštím midnight callback', {
                        hour: timeInfo.hour,
                        date: timeInfo.date,
                        timezone: this.homey.clock.getTimezone(),
                        currentTime: new Date().toISOString()
                    });
                }

                // Spustíme update pro všechna zařízení
                for (const device of Object.values(devices)) {
                    try {
                        const lastUpdate = await device.getStoreValue('lastMidnightUpdate');
                        const now = Date.now();

                        // Pokud už byl update v poslední hodině, přeskočíme
                        if (lastUpdate && (now - lastUpdate < 60 * 60 * 1000)) {
                            this.logger.debug('Přeskakuji update - již proběhl v poslední hodině', {
                                deviceId: device.getData().id,
                                lastUpdate: new Date(lastUpdate).toISOString(),
                                timeSinceLastUpdate: Math.floor((now - lastUpdate) / 1000 / 60) + ' minut'
                            });
                            continue;
                        }

                        await this.executeMidnightUpdate();
                        await device.setStoreValue('lastMidnightUpdate', now)

                    } catch (error) {
                        this.logger.error('Chyba při midnight update zařízení', error, {
                            deviceId: device.getData().id
                        });
                    }
                }
            } catch (error) {
                if (this.logger) {
                    this.logger.error('Chyba v midnight callback', error);
                }
            }
        };

        // Funkce pro výpočet času do příští půlnoci + 5 sekund v Praze
        const getDelayToNextMidnight = () => {
            const now = new Date();
            
            // Výpočet ms do 23:00:05 systémového času (což je 00:00:01 local time)
            const targetHour = 23;
            const targetMinute = 0;
            const targetSecond = 1;
            
            let delay = (targetHour - now.getHours()) * 60 * 60 * 1000 +    // hodiny do cíle
                        (targetMinute - now.getMinutes()) * 60 * 1000 +      // minuty do cíle
                        (targetSecond - now.getSeconds()) * 1000 -           // sekundy do cíle
                        now.getMilliseconds();                               // odečtení ms
            
            // Pokud je delay záporný, přidáme 24 hodin
            if (delay < 0) {
                delay += 24 * 60 * 60 * 1000;
            }
        
            if (this.logger) {
                const nextUpdate = new Date(now.getTime() + delay);
                this.logger.debug('Vypočten čas do příštího update', {
                    currentTime: {
                        system: now.toISOString(),               // systémový čas (UTC)
                        systemHour: now.getHours(),             // systémová hodina
                        local: now.toLocaleString('cs-CZ', {    // lokální čas
                            timeZone: 'Europe/Prague'
                        })
                    },
                    targetTime: {
                        systemHour: targetHour,                 // cílová systémová hodina (23)
                        expectedLocal: '00:00:05'               // očekávaný lokální čas
                    },
                    delay: {
                        ms: delay,
                        hours: Math.floor(delay / (1000 * 60 * 60)),
                        minutes: Math.floor((delay % (1000 * 60 * 60)) / (1000 * 60)),
                        seconds: Math.floor((delay % (1000 * 60)) / 1000)
                    },
                    nextUpdateTime: nextUpdate.toISOString()    // pro kontrolu výsledného času
                });
            }
        
            return delay;
        };

        // Výpočet počátečního zpoždění
        const initialDelay = getDelayToNextMidnight();

        // Kontrola, zda je potřeba okamžitý update
        const devices = this.getDevices();
        for (const device of Object.values(devices)) {
            const lastUpdate = await device.getStoreValue('lastMidnightUpdate');
            const now = Date.now();
            
            // Okamžitý update pouze pokud poslední update byl před více než 6 hodinami
            if (!lastUpdate || (now - lastUpdate > 6 * 60 * 60 * 1000)) {
                if (this.logger) {
                    this.logger.debug('Spouštím okamžitý update - dlouhá doba od posledního updatu', {
                        deviceId: device.getData().id,
                        lastUpdate: lastUpdate ? new Date(lastUpdate).toISOString() : 'nikdy',
                        hoursAgo: lastUpdate ? Math.floor((now - lastUpdate) / 1000 / 60 / 60) : 'N/A'
                    });
                }
                
                setTimeout(async () => {
                    await midnightCallback();
                }, 5000);
                break;
            }
        }

        // Nastavení pravidelného intervalu
        this.intervalManager.setScheduledInterval(
            'midnight',
            midnightCallback,
            24 * 60 * 60 * 1000, // 24 hodin
            initialDelay
        );

        this.logger?.log?.('Midnight update naplánován', {
            nextUpdateIn: Math.round(initialDelay / 60000),
            nextUpdateTime: new Date(Date.now() + initialDelay).toISOString(),
            timezone: this.homey.clock.getTimezone(),
        });        

        } catch (error) {
        this.logger.error('Chyba při plánování midnight update', error);
        throw error;
        }
    }

    async executeMidnightUpdate(retryCount = 0) {
        const MAX_RETRIES = 5;
        const BASE_DELAY = 5 * 60 * 1000;

        if (this.logger) {
            this.logger.log(`Spouštím půlnoční aktualizaci (pokus: ${retryCount} z ${MAX_RETRIES})`);
        }

        const device = this._getFirstDevice();
        if (!device) {
            if (this.logger) {
                this.logger.error('Nenalezeno žádné zařízení pro aktualizaci');
            }
            return;
        }

        const success = await this._tryUpdatePrices(device);

        if (success) {
            try {
                // Použijeme PriceCalculator místo lokální metody
                const processedPrices = [];
                for (let hour = 0; hour < 24; hour++) {
                    const price = await device.getCapabilityValue(`hour_price_CZK_${hour}`);
                    if (price !== null && price !== undefined) {
                        processedPrices.push({ hour, priceCZK: price });
                    }
                }
                
                await device._updateMinMaxPrices(processedPrices);

            } catch (error) {
                if (this.logger) {
                    this.logger.error('Chyba při aktualizaci min/max cen', error);
                }
            }
            await this._handleUpdateSuccess(device, retryCount);
        } else {
            await this._handleUpdateFailure(device, retryCount, MAX_RETRIES, BASE_DELAY);
        }
    }

    _getFirstDevice() {
        const devices = this.getDevices();
        return Object.values(devices)[0];
    }

    async _tryUpdatePrices(device) {
        try {
            if (!device) {
                this.logger?.error('Device není definován pro _tryUpdatePrices');
                return false;
            }
            
            this.logger?.debug('Začátek _tryUpdatePrices', {
                deviceId: device.getData().id,
                deviceName: device.getName()
            });
            
            await device.setCapabilityValue('spot_price_update_status', false);
            
            const updateResult = await this.tryUpdateDevice(device);
            
            this.logger?.debug('Výsledek tryUpdateDevice', {
                updateResult,
                deviceId: device.getData().id
            });
            
            if (updateResult) {
                await device.setCapabilityValue('spot_price_update_status', true);
                this.logger?.log(`Aktualizace zařízení ${device.getName()} proběhla úspěšně`);
            } else {
                this.logger?.error(`Aktualizace zařízení ${device.getName()} selhala`);
            }
    
            return updateResult;
        } catch (error) {
            this.logger?.error(`Chyba při aktualizaci zařízení ${device.getName()}`, error, {
                deviceId: device.getData().id,
                stack: error.stack
            });
            return false;
        }
    }

    async _handleUpdateSuccess(device, retryCount) {
    // Vyčištění všech retry intervalů při úspěchu
    for (let i = 0; i <= retryCount; i++) {
        const retryIntervalId = `retry_midnight_${i}`;
        this.intervalManager.clearScheduledInterval(retryIntervalId);
    }

    if (this.logger) {
        this.logger.log('Půlnoční aktualizace úspěšně dokončena', { deviceId: device.getData().id });
    }
    }

    async _handleUpdateFailure(device, retryCount, maxRetries, baseDelay) {
    if (retryCount < maxRetries) {
        if (this.logger) {
            this.logger.warn('Půlnoční aktualizace selhala, plánuje se další pokus', { 
                deviceId: device.getData().id, 
                retryCount 
            });
        }
        await this._scheduleRetry(device, retryCount, baseDelay);
    } else {
        if (this.logger) {
            this.logger.error('Půlnoční aktualizace selhala po dosažení maximálního počtu pokusů', {
                deviceId: device.getData().id,
                retryCount
            });
        }
        await this._handleMaxRetriesReached(device);
    }
    }

    async _scheduleRetry(device, retryCount, baseDelay = 5 * 60 * 1000) {
        try {
            const delay = this.calculateRetryDelay(retryCount, baseDelay);
    
            const nextRun = new Date(Date.now() + delay);
            this.logger.warn(`Plánuji další pokus ${retryCount + 1}`, {
                deviceId: device.getData().id,
                retryCount,
                delayMinutes: Math.round(delay / 60000),
                nextRetryTime: nextRun.toISOString()
            });
    
            await this.triggerRetryNotification(device, retryCount, delay);
            await this.scheduleRetryInterval(device, retryCount, delay);
            return true;
        } catch (error) {
            this.logger.error('Chyba při plánování dalšího pokusu', error, {
                deviceId: device?.getData()?.id,
                retryCount,
                baseDelay
            });
            throw error;
        }
    }
 
    calculateRetryDelay(retryCount, baseDelay) {
        return baseDelay * Math.pow(2, retryCount);
    }
 
    async triggerRetryNotification(device, retryCount, delay) {
        try {
            if (!device?.triggerAPIFailure) {
                this.logger?.warn('Device instance není dostupná pro API failure trigger');
                return;
            }
    
            await device.triggerAPIFailure({
                primaryAPI: 'Aktualizace selhala',
                backupAPI: 'Čekání na další pokus',
                willRetry: true,
                retryCount: retryCount + 1,
                nextRetryIn: Math.round(delay / 60000),
                maxRetriesReached: false
            });
        } catch (error) {
            this.logger?.error('Chyba při spouštění API failure triggeru', error);
        }
    }
 
    async scheduleRetryInterval(device, retryCount, delay) {
        const intervalKey = `retry_midnight_${retryCount}`;
        const intervalPeriod = 24 * 60 * 60 * 1000;
    
        if (this.intervalManager) {
            this.intervalManager.clearScheduledInterval(intervalKey);
        }
    
        if (!this.intervalManager || typeof this.intervalManager.setScheduledInterval !== 'function') {
            throw new Error('IntervalManager není inicializován nebo jeho metoda není dostupná.');
        }
        
        this.intervalManager.setScheduledInterval(
            intervalKey,
            async () => {
                try {
                    await this.executeMidnightUpdate(retryCount + 1);
                } catch (error) {
                    if (this.logger) {
                        this.logger.error('Chyba při provádění midnight update', error);
                    }
                }
            },
            intervalPeriod,
            delay
        );
        
    }

    async _handleMaxRetriesReached(device) {
    try {
        if (this.logger) {
            this.logger.error('Vyčerpány všechny pokusy o aktualizaci. Zařízení nemusí mít aktuální data.', { deviceId: device.getData().id });
        }

        // Použijeme triggerAPIFailure z device instance
        if (device && typeof device.triggerAPIFailure === 'function') {
            await device.triggerAPIFailure({
                primaryAPI: 'Aktualizace selhala',
                backupAPI: 'Aktualizace selhala',
                willRetry: false,
                maxRetriesReached: true
            });

            if (this.logger) {
                this.logger.log('API failure trigger spuštěn pro maximální počet pokusů', { deviceId: device.getData().id });
            }
        } else if (this.logger) {
            this.logger.error('Device instance není dostupná pro API failure trigger', { deviceId: device ? device.getData().id : null });
        }

        // Nastavení indikátoru chyby na zařízení, pokud je dostupné
        if (device && typeof device.setCapabilityValue === 'function') {
            await device.setCapabilityValue('primary_api_fail', true);
            await device.setCapabilityValue('spot_price_update_status', false);

            if (this.logger) {
                this.logger.debug('Indikátory chyby nastaveny na zařízení', { deviceId: device.getData().id });
            }
        }

        } catch (error) {
        if (this.logger) {
            this.logger.error('Chyba při zpracování maximálního počtu pokusů', error);
        }
        }
    }

    async tryUpdateDevice(device) {
        try {
            this.logger?.debug('Začátek tryUpdateDevice', {
                deviceId: device.getData().id
            });
    
            const dailyPrices = await this.fetchDailyPrices(device);
            
            if (!dailyPrices || !Array.isArray(dailyPrices)) {
                this.logger?.error('Neplatná data z fetchDailyPrices', {
                    data: dailyPrices,
                    type: typeof dailyPrices
                });
                return false;
            }
    
            const processedPrices = this.processPrices(dailyPrices, device);
            
            this.logger?.debug('Data zpracována', {
                rawCount: dailyPrices.length,
                processedCount: processedPrices.length
            });
    
            // Oprava: Použití CapabilityManageru místo přímého volání na device
            return await device.capabilityManager.updateAllPrices(device, processedPrices);
        } catch (error) {
            this.logger?.error('Chyba při aktualizaci dat zařízení', error, {
                deviceId: device.getData().id,
                errorType: error.name,
                errorMessage: error.message,
                stack: error.stack
            });
            return false;
        }
    }
    
    async fetchDailyPrices(device) {
        try {
            this.logger?.debug('Začátek fetchDailyPrices');
            
            const data = await device.spotPriceApi.getDailyPrices(device);
            
            if (!data || !Array.isArray(data)) {
                throw new Error('Neplatná data z API');
            }
            
            this.logger?.debug('Data získána', {
                count: data.length,
                sample: data[0]
            });
            
            return data;
        } catch (error) {
            this.logger?.error('Chyba při získávání denních cen', error, {
                deviceId: device.getData().id
            });
            throw error;
        }
    }
    
    processPrices(dailyPrices, device) {
        const settings = device.getSettings();
    
        return dailyPrices.map(priceData => ({
            hour: priceData.hour,
            priceCZK: device.priceCalculationEngine.addDistributionPrice(
                priceData.priceCZK,
                settings,
                priceData.hour
            )
        }));
    }

    async onPairListDevices() {
        try {
            const deviceId = crypto.randomUUID();
            const deviceName = 'CZ Spot Prices Device';
      
            if (this.logger) {
                this.logger.log('Setting up device for pairing', { deviceName, deviceId });
            }
      
            return [{
                name: deviceName,
                data: { id: deviceId }
            }];
        } catch (error) {
            if (this.logger) {
                this.logger.error('Error during pairing', error);
            }
            throw error;
        }
      }

    async settingsChanged(data) {
    try {
        const devices = this.getDevices();

        if (this.logger) {
            this.logger.log('Settings changed, updating all devices', { changedData: data });
        }

        for (const device of Object.values(devices)) {
            await device.fetchAndUpdateSpotPrices();
            if (this.logger) {
                this.logger.debug('Device prices updated', { deviceId: device.getData().id });
            }
        }

        // Vyčistíme cache při změně nastavení
        this.cacheManager.clearAll();

        if (this.logger) {
            this.logger.debug('PriceCalculator cache cleared after settings change');
        }
    } catch (error) {
        if (this.logger) {
            this.logger.error('Error updating prices after settings change', error);
        }
    }
    }

    // Cleanup při odstranění driveru
    async onUninit() {
        try {
            await this._cleanupDevices();
            await this._cleanupManagers();
            this.logger?.log('Driver uninitialized successfully');
            this.logger = null;
        } catch (error) {
            this.logger?.error('Error during driver cleanup', error);
        }
    }
    
    async _cleanupDevices() {
        const devices = this.getDevices();
        for (const device of Object.values(devices)) {
            await this.deviceStateManager?.cleanupDeviceState(device);
        }
    }
    
    async _cleanupManagers() {
        const cleanupTasks = [
            // Aktivní managery - čistíme první
            { instance: 'intervalManager', method: 'clearAll' },
            { instance: 'cacheManager', method: 'clearAll' },
            { instance: 'priceCalculator', method: 'clearCache' },
            
            // Statické instance - stačí nullovat
            { instance: 'priceCalculationEngine' },
            { instance: 'tariffCalculator' },
            { instance: 'spotPriceApi' },
            { instance: 'dataValidator' },
            { instance: 'settingsManager' }
        ];
    
        for (const task of cleanupTasks) {
            const manager = this[task.instance];
            if (manager) {
                if (task.method && typeof manager[task.method] === 'function') {
                    await manager[task.method]();
                }
                this[task.instance] = null;
                this.logger?.debug(`${task.instance} cleared`);
            }
        }
    }
}

module.exports = CZSpotPricesDriver;