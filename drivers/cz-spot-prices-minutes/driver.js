'use strict';

const Homey = require('homey');
const SpotPriceAPI = require('../../helpers/api');
const IntervalManager = require('../../helpers/IntervalManager');
const PriceCalculator = require('../../helpers/pricecalculation/PriceCalculator');
const TariffCalculator = require('../../helpers/pricecalculation/TariffCalculator');
const PriceCalculationEngine = require('../../helpers/pricecalculation/PriceCalculationEngine');
const DataValidator = require('../../helpers/DataValidator');
const CacheManager = require('../../helpers/CacheManager');
const SettingsManager = require('../../helpers/SettingsManager');
const DeviceStateManager = require('../../helpers/DeviceStateManager');
const Logger = require('../../helpers/Logger');

/**
 * CZ Spot Prices Driver
 * 
 * Spravuje devices pracující s 15minutovými sloty (96 slotů denně)
 * Provádí půlnoční refresh dat z API
 * Řídí retry mechanismus při selhání
 * 
 * BREAKING CHANGE: Odstraněna podpora hodinových devices (24 slotů)
 */
class CZSpotPricesQuarterDriver extends Homey.Driver {
    static CONTEXT = 'CZSpotPricesDriver';

    /**
     * Inicializace driveru při startu
     */
    async onInit() {
        try {
            if (!this.homey) throw new Error('Homey instance není dostupná');
                
            // Nejdřív inicializujeme Logger - defaultně zapnutý
            this.logger = Logger.getInstance(this.homey);
            Logger.setEnabled(true);
            
            // Inicializace všech manažerů
            const managers = {
                settingsManager: SettingsManager,
                cacheManager: CacheManager,
                deviceStateManager: DeviceStateManager,
                dataValidator: DataValidator,
                tariffCalculator: TariffCalculator,
                priceCalculationEngine: PriceCalculationEngine,
                priceCalculator: PriceCalculator,
                spotPriceApi: SpotPriceAPI,
                intervalManager: IntervalManager
            };
    
            Object.entries(managers).forEach(([key, Manager]) => {
                this[key] = Manager.getInstance(this.homey);
            });
    
            this.logger.debug('Inicializace CZSpotPricesDriver');
            await this.scheduleMidnightUpdate();
            this.logger.debug('Driver úspěšně inicializován');
        } catch (error) {
            this.logger?.error('Chyba při inicializaci driveru', error, { driverId: this.id });
            throw error;
        }
    }

    static setHomeyInstance(homey) {
        if (!homey) {
            throw new Error('Homey instance je vyžadována pro Driver');
        }
        CZSpotPricesQuarterDriver.homeyInstance = homey;
    }

    /**
     * Naplánuje půlnoční aktualizaci dat z API
     * Spouští se 1x denně po půlnoci
     * Při restartu může spustit okamžitý update pokud data jsou stará
     */
    async scheduleMidnightUpdate() {
        try {
            this.logger?.debug('Plánování midnight update');
    
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
                
                // Okamžitý update pokud data jsou starší než 6 hodin
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
    
            // Nastavení pravidelného intervalu (každých 24h)
            this.intervalManager.setScheduledInterval(
                'midnight_prices',
                midnightCallback,
                24 * 60 * 60 * 1000,
                initialDelay
            );
    
            this.logger?.debug('Midnight update naplánován', {
                nextUpdateIn: Math.round(initialDelay / 60000) + ' minut',
                nextUpdateTime: new Date(Date.now() + initialDelay).toISOString(),
                timezone: this.homey.clock.getTimezone(),
            });        
    
        } catch (error) {
            this.logger?.error('Chyba při plánování midnight update', error);
            throw error;
        }
    }

    /**
     * Provede půlnoční aktualizaci dat
     * Při selhání plánuje retry s exponenciálním backoffem
     * 
     * @param {number} retryCount - Počet předchozích pokusů (default 0)
     */
    async executeMidnightUpdate(retryCount = 0) {
        const MAX_RETRIES = 5;
        const BASE_DELAY = 5 * 60 * 1000; // 5 minut

        this.logger?.debug(`Spouštím půlnoční aktualizaci (pokus: ${retryCount + 1} z ${MAX_RETRIES + 1})`);

        const device = this._getFirstDevice();
        if (!device) {
            this.logger?.error('Nenalezeno žádné zařízení pro aktualizaci');
            return;
        }

        const success = await this._tryUpdatePrices(device);

        if (success) {
            // ✅ Min/max/average se aktualizují automaticky v tryUpdateDevice()
            // přes capabilityManager.updateDeviceCapabilities()
            // Není třeba je volat explicitně
            await this._handleUpdateSuccess(device, retryCount);
        } else {
            await this._handleUpdateFailure(device, retryCount, MAX_RETRIES, BASE_DELAY);
        }
    }

    /**
     * Získá první dostupný device pro operace
     * @private
     */
    _getFirstDevice() {
        const devices = this.getDevices();
        return Object.values(devices)[0];
    }

    /**
     * Pokusí se aktualizovat ceny na device
     * @private
     * @returns {Promise<boolean>} True pokud aktualizace proběhla úspěšně
     */
    async _tryUpdatePrices(device) {
        try {            
            this.logger?.debug('Začátek _tryUpdatePrices', {
                deviceId: device.getData().id,
                deviceName: device.getName()
            });
            
            // Reset status před pokusem
            await device.setCapabilityValue('spot_price_update_status', false).catch(() => {
                // Capability možná neexistuje, to je OK
            });
            
            const updateResult = await this.tryUpdateDevice(device);
            
            this.logger?.debug('Výsledek tryUpdateDevice', {
                updateResult,
                deviceId: device.getData().id
            });
            
            if (updateResult) {
                await device.setCapabilityValue('spot_price_update_status', true).catch(() => {});
                this.logger?.debug(`Aktualizace zařízení ${device.getName()} proběhla úspěšně`);
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

    /**
     * Zpracuje úspěšnou aktualizaci
     * @private
     */
    async _handleUpdateSuccess(device, retryCount) {
        // Vyčištění všech retry intervalů při úspěchu
        for (let i = 0; i <= retryCount; i++) {
            const retryIntervalId = `retry_midnight_${i}`;
            this.intervalManager.clearScheduledInterval(retryIntervalId);
        }

        this.logger?.debug('Půlnoční aktualizace úspěšně dokončena', { 
            deviceId: device.getData().id 
        });
    }

    /**
     * Zpracuje selhání aktualizace a naplánuje retry
     * @private
     */
    async _handleUpdateFailure(device, retryCount, maxRetries, baseDelay) {
        const deviceInfo = { deviceId: device.getData().id, retryCount };
        
        if (retryCount < maxRetries) {
            this.logger?.debug('Půlnoční aktualizace selhala, plánuje se další pokus', deviceInfo);
            
            // Exponenciální backoff: 5min, 10min, 20min, 40min, 80min
            const delay = baseDelay * Math.pow(2, retryCount);
            
            // Notifikace device o retry
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
 
    /**
     * Naplánuje retry interval s exponenciálním backoffem
     * @private
     */
    async scheduleRetryInterval(device, retryCount, delay) {
        const intervalKey = `retry_midnight_${retryCount}`;
        const intervalPeriod = 24 * 60 * 60 * 1000; // 24 hodin
    
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
                    this.logger?.error('Chyba při provádění midnight update', error);
                }
            },
            intervalPeriod,
            delay
        );
    }

    /**
     * Zpracuje stav kdy byly vyčerpány všechny pokusy
     * @private
     */
    async _handleMaxRetriesReached(device) {
        try {
            this.logger?.error('Vyčerpány všechny pokusy o aktualizaci. Zařízení nemusí mít aktuální data.', { 
                deviceId: device.getData().id 
            });

            // Spustíme API failure trigger
            if (device && typeof device.triggerAPIFailure === 'function') {
                await device.triggerAPIFailure({
                    primaryAPI: 'Aktualizace selhala',
                    backupAPI: 'Aktualizace selhala',
                    willRetry: false,
                    maxRetriesReached: true
                });

                this.logger?.debug('API failure trigger spuštěn pro maximální počet pokusů', { 
                    deviceId: device.getData().id 
                });
            } else {
                this.logger?.error('Device instance není dostupná pro API failure trigger', { 
                    deviceId: device ? device.getData().id : null 
                });
            }

            // Nastavení indikátorů chyby
            if (device && typeof device.setCapabilityValue === 'function') {
                await device.setCapabilityValue('primary_api_fail', true).catch(() => {});
                await device.setCapabilityValue('spot_price_update_status', false).catch(() => {});

                this.logger?.debug('Indikátory chyby nastaveny na zařízení', { 
                    deviceId: device.getData().id 
                });
            }

        } catch (error) {
            this.logger?.error('Chyba při zpracování maximálního počtu pokusů', error);
        }
    }

    /**
     * Pokusí se aktualizovat device s novými daty
     * 
     * @param {Device} device - Instance zařízení
     * @returns {Promise<boolean>} True pokud aktualizace proběhla úspěšně
     */
    async tryUpdateDevice(device) {
        try {
            this.logger?.debug('Začátek tryUpdateDevice', {
                deviceId: device.getData().id
            });
    
            // Získání 96 slotů z API
            const slotPrices = await this.fetchSlotPrices(device);
            
            if (!slotPrices || slotPrices.length !== 96) {
                this.logger?.error('Neplatná data z fetchSlotPrices', {
                    data: slotPrices?.length || 0,
                    expected: 96
                });
                return false;
            }

            // Zpracování cen (přidání distribučních tarifů)
            const processedPrices = this.processPrices(slotPrices, device);
            
            this.logger?.debug('Data zpracována', {
                rawCount: slotPrices.length,
                processedCount: processedPrices.length
            });
    
            // Nastavení indexů pro 96 slotů
            const settings = device.getSettings();
            const pricesWithIndexes = device.priceCalculator.setIndexes(
                processedPrices,
                settings.low_index_intervals || 8,
                settings.high_index_intervals || 8
            );

            // Aktualizace capabilities
            return await device.capabilityManager.updateDeviceCapabilities(device, pricesWithIndexes);
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
    
    /**
     * Získá slot ceny z API (96 slotů)
     * 
     * @param {Device} device - Instance zařízení
     * @returns {Promise<Array>} Pole s 96 sloty
     * @throws {Error} Pokud data nejsou platná
     */
    async fetchSlotPrices(device) {
        try {
            this.logger?.debug('Začátek fetchSlotPrices');
            
            // API vrací {today: [...96], tomorrow: [...]}
            const data = await device.spotPriceApi.getPrices(device);
            
            if (!data || !data.today || !Array.isArray(data.today)) {
                throw new Error('Neplatná data z API');
            }
            
            if (data.today.length !== 96) {
                throw new Error(`Nesprávný počet slotů: ${data.today.length}, očekáváno 96`);
            }
            
            this.logger?.debug('Slot data získána', {
                count: data.today.length,
                sample: data.today[0]
            });
            
            return data.today;
        } catch (error) {
            this.logger?.error('Chyba při získávání slot cen', error, {
                deviceId: device.getData().id
            });
            throw error;
        }
    }
    
    /**
     * Zpracuje ceny - přidá distribuční tarify (HODINOVÉ)
     * 
     * @param {Array} slotPrices - Pole s 96 sloty
     * @param {Device} device - Instance zařízení
     * @returns {Array} Zpracované ceny s distribučními tarify
     */
    processPrices(slotPrices, device) {
        const settings = device.getSettings();

        // ✅ OPTIMALIZACE: Vytvoř tariffMap JEDNOU pro celý batch
        const tariffMap = device.tariffCalculator.getTariffMap(settings);

        this.logger?.debug('🗺️ TariffMap vytvořena pro driver batch', {
            slotsCount: slotPrices.length,
            mapSize: tariffMap.size
        });

        return slotPrices.map(priceData => ({
            hour: priceData.hour,
            minute: priceData.minute,
            priceCZK: device.priceCalculationEngine.addDistributionPrice(
                priceData.priceCZK,
                settings,
                priceData.hour,
                tariffMap  // ✅ Předej tariffMap!
            )
        }));
    }

    /**
     * Handler pro pairing nového zařízení
     * @returns {Promise<Array>} Seznam zařízení k přidání
     */
    async onPairListDevices() {
        try {
            const deviceName = 'CZ Spot Prices Device';
            
            // ✅ Statické ID - vždy stejné
            const deviceId = 'cz-spot-prices-main';

            this.logger?.debug('Nastavení device pro pairing', { 
                deviceName,
                deviceId
            });

            return [{
                name: deviceName,
                data: {
                    id: deviceId  // ✅ Jednoduché, stabilní ID
                }
            }];
        } catch (error) {
            this.logger?.error('Chyba při pairingu', error);
            throw error;
        }
    }

    /**
     * Handler pro změnu nastavení
     * Aktualizuje všechna zařízení s novým nastavením
     * 
     * @param {Object} data - Změněná data nastavení
     */
    async settingsChanged(data) {
        try {
            const devices = this.getDevices();

            this.logger?.debug('Nastavení změněno, aktualizuji všechna zařízení', { changedData: data });

            for (const device of Object.values(devices)) {
                await device.fetchAndUpdateSpotPrices();
                this.logger?.debug('Device ceny aktualizovány', { deviceId: device.getData().id });
            }

            // Vyčistíme cache při změně nastavení
            this.cacheManager.clearAll();

            this.logger?.debug('Cache vyčištěna po změně nastavení');
        } catch (error) {
            this.logger?.error('Chyba při aktualizaci cen po změně nastavení', error);
        }
    }

    /**
     * Cleanup při odstranění driveru
     */
    async onUninit() {
        try {
            await this._cleanupDevices();
            await this._cleanupManagers();
            this.logger?.debug('Driver úspěšně ukončen');
            this.logger = null;
        } catch (error) {
            this.logger?.error('Chyba při cleanup driveru', error);
        }
    }
    
    /**
     * Vyčistí všechna zařízení
     * @private
     */
    async _cleanupDevices() {
        const devices = this.getDevices();
        for (const device of Object.values(devices)) {
            await this.deviceStateManager?.cleanupDeviceState(device);
        }
    }
    
    /**
     * Vyčistí všechny manažery
     * @private
     */
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

module.exports = CZSpotPricesQuarterDriver;