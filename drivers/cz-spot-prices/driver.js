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
        const requiredManagers = {
            logger: Logger,
            cacheManager: CacheManager,
            deviceStateManager: DeviceStateManager,
            dataValidator: DataValidator,
            settingsManager: SettingsManager,
            tariffCalculator: TariffCalculator,
            priceCalculationEngine: PriceCalculationEngine,
            priceCalculator: PriceCalculator,
            spotPriceApi: SpotPriceAPI,
            intervalManager: IntervalManager
        };
    
        try {
            if (!this.homey) throw new Error('Homey instance není dostupná');
            
            Object.entries(requiredManagers).forEach(([key, Manager]) => {
                this[key] = Manager.getInstance(this.homey);
            });
    
            this.logger.log('Inicializace CZSpotPricesDriver');
            await this.scheduleMidnightUpdate();
            this.logger.log('Driver úspěšně inicializován');
        } catch (error) {
            this.logger?.error('Chyba při inicializaci driveru', error, { driverId: this.id });
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
            this.logger?.log('Plánování midnight update');
    
            // Callback pro půlnoční aktualizaci
            const midnightCallback = async () => {
                try {
                    const devices = this.getDevices();
                    const timeInfo = this.spotPriceApi.getCurrentTimeInfo();
                    
                    this.logger?.debug('Spouštím midnight callback', {
                        hour: timeInfo.hour,
                        date: timeInfo.date,
                        timezone: this.homey.clock.getTimezone(),
                        currentTime: new Date().toISOString()
                    });
    
                    // Spustíme update pro všechna zařízení
                    for (const device of Object.values(devices)) {
                        try {
                            const lastUpdate = await device.getStoreValue('lastMidnightUpdate');
                            const now = Date.now();
    
                            // Přeskočíme pokud update proběhl v poslední hodině
                            if (lastUpdate && (now - lastUpdate < 60 * 60 * 1000)) {
                                this.logger?.debug('Přeskakuji update - již proběhl v poslední hodině', {
                                    deviceId: device.getData().id,
                                    lastUpdate: new Date(lastUpdate).toISOString(),
                                    timeSinceLastUpdate: Math.floor((now - lastUpdate) / 1000 / 60) + ' minut'
                                });
                                continue;
                            }
    
                            await this.executeMidnightUpdate();
                            await device.setStoreValue('lastMidnightUpdate', now);
    
                        } catch (error) {
                            this.logger?.error('Chyba při midnight update zařízení', error, {
                                deviceId: device.getData().id
                            });
                        }
                    }
                } catch (error) {
                    this.logger?.error('Chyba v midnight callback', error);
                }
            };
    
            // Výpočet počátečního zpoždění pomocí IntervalManageru
            const initialDelay = this.intervalManager.getDelayToNextMidnight();
    
            // Kontrola potřeby okamžitého updatu
            const devices = this.getDevices();
            for (const device of Object.values(devices)) {
                const lastUpdate = await device.getStoreValue('lastMidnightUpdate');
                const now = Date.now();
                
                // Okamžitý update při dlouhé prodlevě
                if (!lastUpdate || (now - lastUpdate > 6 * 60 * 60 * 1000)) {
                    this.logger?.debug('Spouštím okamžitý update - dlouhá doba od posledního updatu', {
                        deviceId: device.getData().id,
                        lastUpdate: lastUpdate ? new Date(lastUpdate).toISOString() : 'nikdy',
                        hoursAgo: lastUpdate ? Math.floor((now - lastUpdate) / 1000 / 60 / 60) : 'N/A'
                    });
                    
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
                24 * 60 * 60 * 1000,
                initialDelay
            );
    
            this.logger?.log('Midnight update naplánován', {
                nextUpdateIn: Math.round(initialDelay / 60000),
                nextUpdateTime: new Date(Date.now() + initialDelay).toISOString(),
                timezone: this.homey.clock.getTimezone(),
            });        
    
        } catch (error) {
            this.logger?.error('Chyba při plánování midnight update', error);
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
                
                await device.capabilityManager.updateMinMaxPrices(device, processedPrices);

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
        const deviceInfo = { deviceId: device.getData().id, retryCount };
        
        if (retryCount < maxRetries) {
            this.logger?.debug('Půlnoční aktualizace selhala, plánuje se další pokus', deviceInfo);
            
            const delay = baseDelay * Math.pow(2, retryCount);
            
            // Notify device about retry
            await device.triggerAPIFailure?.({
                primaryAPI: 'Aktualizace selhala',
                backupAPI: 'Čekání na další pokus',
                willRetry: true,
                retryCount: retryCount + 1,
                nextRetryIn: Math.round(delay / 60000),
                maxRetriesReached: false
            });
    
            return this.scheduleRetryInterval(device, retryCount, delay);
        }
        
        this.logger?.error('Půlnoční aktualizace selhala po dosažení maximálního počtu pokusů', deviceInfo);
        return this._handleMaxRetriesReached(device);
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
            
            if (!dailyPrices || dailyPrices.length === 0) {
                this.logger?.error('Žádná data z fetchDailyPrices', {
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