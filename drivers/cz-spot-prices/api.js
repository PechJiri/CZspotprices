'use strict';

const Homey = require('homey');
const axios = require('axios');
const instance = axios.create({
    httpsAgent: new require('https').Agent({
        rejectUnauthorized: false
    })
});
const PriceCalculator = require('../../helpers/PriceCalculator');
const Logger = require('../../helpers/Logger');

class SpotPriceAPI {
    constructor(homey, deviceContext = 'SpotPriceAPI') {  // zde byl problém
        this.homey = homey;
        // Vytvoříme vlastní instanci loggeru pro API
        this.logger = new Logger(this.homey, deviceContext);  // používáme deviceContext, ne context
        // Defaultně zapneme logging pro API
        this.logger.setEnabled(true);
        
        

        this.baseUrl = 'https://spotovaelektrina.cz/api/v1/price';
        const today = new Date().toISOString().slice(0, 10); // získá datum ve formátu RRRR-MM-DD
        this.backupUrl = `https://www.ote-cr.cz/cs/kratkodobe-trhy/elektrina/denni-trh/@@chart-data?date=${today}`;
        this.exchangeRateUrl = 'https://data.kurzy.cz/json/meny/b[6].json';
        this.exchangeRate = 25.25;
        this.homeyTimezone = this.homey.clock.getTimezone();
        this.priceCalculator = new PriceCalculator(this.homey, 'PriceCalculator');
        
        this.logger.debug('SpotPriceAPI inicializován');
    }

  setLogger(logger) {
    this.logger = logger;
  }

  getLogger() {
    return this.logger;
  }

  async updateExchangeRate() {
    try {
        if (this.logger) this.logger.debug('Aktualizace směnného kurzu');
        const response = await axios.get(this.exchangeRateUrl);
        const data = response.data;
        if (data && data.kurzy && data.kurzy.EUR) {
            this.exchangeRate = data.kurzy.EUR.dev_stred;
            if (this.logger) this.logger.log('Směnný kurz aktualizován', { 
                newRate: this.exchangeRate 
            });
        }
    } catch (error) {
        if (this.logger) this.logger.error('Chyba při aktualizaci směnného kurzu', error);
    }
  }

  getCurrentTimeInfo() {
    const now = new Date();
    const options = { timeZone: this.homeyTimezone };
    
    let hour = parseInt(now.toLocaleString('en-US', { 
        ...options, 
        hour: 'numeric', 
        hour12: false 
    }));

    if (hour === 24) hour = 0;
    
    if (hour < 0 || hour > 23) {
        if (this.logger) this.logger.error('Neplatná hodina', { hour });
        hour = new Date().getHours();
    }

    if (this.logger) this.logger.debug('Časové informace', {
        hour,
        systemHour: new Date().getHours(),
        timezone: this.homeyTimezone
    });

    return {
        hour,
        date: now.toLocaleString('en-US', { 
            ...options, 
            year: 'numeric', 
            month: '2-digit', 
            day: '2-digit' 
        }).split('/').reverse().join('')
    };
  }

  getErrorMessage(error) {
    if (typeof error === 'string') return error;
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    if (typeof error === 'object' && error !== null) return JSON.stringify(error);
    return 'Unknown error';
  }

  handleApiError(context, error, device) {
    let errorMessage = this.getErrorMessage(error);
    
    // Logování chyby
    if (this.logger) {
        this.logger.error(`${context}: API chyba`, error, { 
            errorMessage, 
            deviceId: device ? device.id : 'N/A', 
            deviceName: device ? device.name : 'N/A' 
        });
    } else {
        this.homey.error(`${context}:`, errorMessage);
    }

    // Použití nové metody z device
    if (device && typeof device.triggerAPIFailure === 'function') {
        device.triggerAPIFailure({
            primaryAPI: errorMessage,
            backupAPI: '',
            willRetry: false,
            maxRetriesReached: true
        });
    }
  }

  // Nové metody využívající PriceCalculator
  async getDailyPrices(device) {
    if (!device || typeof device.triggerAPIFailure !== 'function') {
        const errorMessage = 'Neplatná device instance pro getDailyPrices';
        if (this.logger) {
            this.logger.error(errorMessage, new Error(errorMessage));
        }
        throw new Error(errorMessage);
    }

    const timeoutMs = 10000;
    let spotElektrinaError = null;
    let oteError = null;

    try {
        // Výchozí stav - normálně získáváme data z primárního API
        await device.setCapabilityValue('primary_api_fail', false);

        if (this.logger) {
            this.logger.debug('Pokus o získání dat z primárního API (spotovaelektrina.cz)');
        }

        const rawData = await this._fetchFromPrimaryAPI(timeoutMs);

        if (!rawData) {
            this.logger.error('Chyba: data jsou undefined po volání _fetchFromPrimaryAPI');
            throw new Error('Data z primárního API jsou undefined');
        }

        // Transformace dat - pouze hour a priceCZK
        const data = rawData.map(hourData => ({
            hour: hourData.hour,
            priceCZK: hourData.priceCZK
            // Úmyslně vynecháváme level z API
        }));

        if (!this.priceCalculator.validatePriceData(data)) {
            throw new Error('Neplatný formát dat z primárního API');
        }

        if (this.logger) {
            this.logger.log('Data úspěšně získána z primárního API', { 
                source: 'Primary API',
                sampleData: data[0] // Log prvního záznamu pro kontrolu
            });
        }

        return data;

    } catch (error) {
        spotElektrinaError = error;
        
        if (this.logger) {
            this.logger.error('Chyba primárního API', error, { 
                context: 'getDailyPrices', 
                deviceId: device.id 
            });
        }

        // Primární API selhalo - přepneme na záložní API
        await device.setCapabilityValue('primary_api_fail', true);

        try {
            if (this.logger) {
                this.logger.debug('Pokus o získání dat ze záložního API (ote.cr)');
            }

            const rawBackupData = await this.getBackupDailyPrices(device);

            // Transformace záložních dat - opět pouze hour a priceCZK
            const backupData = rawBackupData.map(hourData => ({
                hour: hourData.hour,
                priceCZK: hourData.priceCZK
                // Opět vynecháváme jakékoliv levely
            }));

            if (!this.priceCalculator.validatePriceData(backupData)) {
                throw new Error('Neplatný formát dat ze záložního API');
            }

            await device.triggerAPIFailure({
                primaryAPI: this.getErrorMessage(spotElektrinaError),
                backupAPI: 'Záložní API úspěšné',
                willRetry: true,
                retryCount: 0,
                nextRetryIn: '60'
            });

            if (this.logger) {
                this.logger.log('Data úspěšně získána ze záložního API', { 
                    source: 'Backup API',
                    sampleData: backupData[0] // Log prvního záznamu pro kontrolu
                });
            }

            // Ponecháme primary_api_fail na true, protože stále používáme záložní API
            return backupData;

        } catch (backupError) {
            oteError = backupError;

            if (this.logger) {
                this.logger.error('Selhání záložního API', backupError, { 
                    context: 'getDailyPrices', 
                    deviceId: device.id 
                });
            }

            await device.triggerAPIFailure({
                primaryAPI: this.getErrorMessage(spotElektrinaError),
                backupAPI: this.getErrorMessage(oteError),
                willRetry: false,
                maxRetriesReached: true
            });

            // Ponecháme primary_api_fail na true, protože primární API stále nefunguje
            throw new Error(`Selhání obou API: spotovaelektrina.cz: ${this.getErrorMessage(spotElektrinaError)}, ote.cr: ${this.getErrorMessage(oteError)}`);
        }
    }
}

// Pomocná metoda pro volání primárního API
async _fetchFromPrimaryAPI(timeoutMs) {
    const url = `${this.baseUrl}/get-prices-json`;
    let timeout;

    if (this.logger) {
        this.logger.debug('Volání primárního API pro získání cen', { url, timeoutMs });
    }

    try {
        const source = axios.CancelToken.source();
        timeout = setTimeout(() => {
            source.cancel(`Timeout při volání primárního API po ${timeoutMs}ms`);
        }, timeoutMs);

        const response = await axios.get(url, { cancelToken: source.token });
        clearTimeout(timeout);

        if (response.status !== 200) {
            const errorMessage = `HTTP error! status: ${response.status}`;
            if (this.logger) {
                this.logger.error('Chyba při volání primárního API', new Error(errorMessage), { url, status: response.status });
            }
            throw new Error(errorMessage);
        }

        const data = response.data;

        // Ověření struktury dat
        if (!data.hoursToday || !Array.isArray(data.hoursToday) || data.hoursToday.length !== 24) {
            const invalidDataError = new Error('Neplatná struktura dat z API');
            if (this.logger) {
                this.logger.error('Neplatná struktura dat z primárního API', invalidDataError, { 
                    url,
                    receivedData: data // Log celého objektu bez ořezání při chybě
                });
            }
            throw invalidDataError;
        }

        // Vrátíme pouze pole `hoursToday`
        return data.hoursToday;

    } catch (error) {
        if (axios.isCancel(error)) {
            const timeoutError = new Error('Timeout při volání API');
            if (this.logger) {
                this.logger.error('Timeout při volání primárního API', timeoutError, { url, timeoutMs });
            }
            throw timeoutError;
        }

        if (this.logger) {
            this.logger.error('Neočekávaná chyba při volání primárního API', error, { url });
        }
        throw error;

    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

async getBackupDailyPrices(device) {
    try {
        if (this.logger) {
            this.logger.debug('Začátek získávání cen ze záložního API', { url: this.backupUrl });
        }
  
        await this.updateExchangeRate();
        const timeInfo = this.getCurrentTimeInfo();
  
        if (this.logger) {
            this.logger.debug('Načítání dat z backup API s parametry', { date: timeInfo.date });
        }
  
        const response = await axios.get(this.backupUrl, {
            params: { report_date: timeInfo.date }
        });
  
        const data = response.data;
        
        // Najdeme data pro ceny v EUR/MWh
        const dataLine = data?.data?.dataLine.find(line => line.title === "Cena (EUR/MWh)");
  
        if (!dataLine || !Array.isArray(dataLine.point)) {
            const errorMessage = 'Invalid data structure from backup API';
            if (this.logger) {
                this.logger.error(errorMessage, new Error(errorMessage), { url: this.backupUrl });
            }
            throw new Error(errorMessage);
        }

        // Kontrola vstupních dat
        if (dataLine.point.length < 24) {
            const error = new Error(`Nedostatečný počet hodin ve vstupních datech: ${dataLine.point.length}`);
            if (this.logger) {
                this.logger.error('Chyba vstupních dat', error);
            }
            throw error;
        }

        // Map pro konverzi hodin 1-24 na 0-23
        const hourMap = new Map([...Array(24)].map((_, i) => [i + 1, i === 24 ? 0 : i]));

        // Převod hodin a výpočet ceny v CZK
        const hoursToday = dataLine.point.slice(0, 24).map(point => {
            try {
                // Převod x (1-24) na hour (0-23)
                const inputHour = parseInt(point.x, 10);
                if (!hourMap.has(inputHour)) {
                    throw new Error(`Neplatná vstupní hodina: ${inputHour}`);
                }
                const hour = hourMap.get(inputHour);

                // Zpracování ceny
                const priceEUR = parseFloat(point.y);
                if (isNaN(priceEUR)) {
                    throw new Error(`Neplatná cena pro hodinu ${inputHour}: ${point.y}`);
                }

                const priceCZK = priceEUR * this.exchangeRate;
                
                if (this.logger) {
                    this.logger.debug('Mapování hodiny', {
                        vstupníHodina: inputHour,
                        výstupníHodina: hour,
                        vstupníCenaEUR: priceEUR,
                        výstupníCenaCZK: priceCZK
                    });
                }

                return {
                    hour,
                    priceCZK: parseFloat(priceCZK.toFixed(2)),
                    priceEur: priceEUR  // pro debugging
                };
            } catch (error) {
                if (this.logger) {
                    this.logger.error('Chyba při zpracování hodinových dat', error, {
                        point,
                        exchangeRate: this.exchangeRate
                    });
                }
                throw error;
            }
        });

        // Seřazení podle hodin (0-23)
        hoursToday.sort((a, b) => a.hour - b.hour);

        // Kontrola výstupních dat
        const hoursCheck = new Set(hoursToday.map(h => h.hour));
        if (hoursCheck.size !== 24 || ![...hoursCheck].every(h => h >= 0 && h <= 23)) {
            const error = new Error('Neplatná transformace hodin');
            if (this.logger) {
                this.logger.error('Chyba výstupních dat', error, {
                    uniqueHours: [...hoursCheck].sort((a, b) => a - b)
                });
            }
            throw error;
        }
  
        // Validace dat pomocí PriceCalculatoru
        if (!this.priceCalculator.validatePriceData(hoursToday)) {
            const validationError = new Error('Invalid backup price data format');
            if (this.logger) {
                this.logger.error('Chyba validace dat záložního API', validationError, { 
                    url: this.backupUrl,
                    sampleData: hoursToday[0]
                });
            }
            throw validationError;
        }
  
        if (this.logger) {
            this.logger.debug('Úspěšné načtení cen ze záložního API', { 
                url: this.backupUrl, 
                dataLength: hoursToday.length,
                firstHour: hoursToday[0],
                lastHour: hoursToday[23]
            });
        }
  
        return hoursToday;
  
    } catch (error) {
        if (this.logger) {
            this.logger.error('Chyba při získávání cen ze záložního API', error, { 
                url: this.backupUrl,
                exchangeRate: this.exchangeRate 
            });
        }
        throw error;
    }
}

async updateCurrentValues(device) {
    let updatingLock = false;
    
    try {
        // Validace vstupního parametru
        if (!device || !device.getSettings || !device.setCapabilityValue) {
            throw new Error('Neplatná device instance');
        }

        // Kontrola, zda již neprobíhá aktualizace
        if (updatingLock) {
            if (this.logger) {
                this.logger.warn('Aktualizace již probíhá, přeskakuji');
            }
            return;
        }

        updatingLock = true;

        if (this.logger) {
            this.logger.log('=== ZAČÁTEK AKTUALIZACE SOUČASNÝCH HODNOT ===', {
                deviceId: device.getData().id,
                timestamp: new Date().toISOString()
            });
        }

        // Získání dat s validací
        let dailyPrices = [];
        try {
            if (this.logger) {
                this.logger.debug('Pokus o získání dat z primárního API...');
            }

            dailyPrices = await this.getDailyPrices(device);
            
            // Validace získaných dat
            if (!Array.isArray(dailyPrices) || dailyPrices.length !== 24) {
                throw new Error(`Neplatná data z API: Očekáváno 24 záznamů, získáno ${dailyPrices?.length}`);
            }

            if (this.logger) {
                this.logger.log('Data úspěšně získána z primárního API', { 
                    dataLength: dailyPrices.length,
                    sampleData: dailyPrices[0]
                });
            }
        } catch (error) {
            const errorInfo = {
                primaryAPI: error.message,
                backupAPI: '',
                willRetry: true,
                retryCount: 0,
                nextRetryIn: '5'
            };

            await device.triggerAPIFailure(errorInfo);
            
            if (this.logger) {
                this.logger.error('Chyba při získávání dat z primárního API', error, {
                    deviceId: device.getData().id,
                    errorInfo
                });
            }
            throw error;
        }

        // Příprava dat s validací
        const settings = device.getSettings();
        const lowIndexHours = device.getLowIndexHours();
        const highIndexHours = device.getHighIndexHours();

        if (this.logger) {
            this.logger.debug('Začátek zpracování dat', {
                settingsLoaded: !!settings,
                lowIndexHours,
                highIndexHours,
                priceInKWh: device.getPriceInKWh()
            });
        }

        // Zpracování cen s batch processingem pro optimalizaci
        const processedPrices = await Promise.all(
            dailyPrices.map(async priceData => {
                try {
                    return {
                        hour: priceData.hour,
                        priceCZK: this.priceCalculator.addDistributionPrice(
                            priceData.priceCZK,
                            settings,
                            priceData.hour
                        )
                    };
                } catch (error) {
                    if (this.logger) {
                        this.logger.error('Chyba při zpracování ceny', error, { priceData });
                    }
                    throw error;
                }
            })
        );

        // Výpočet indexů
        const pricesWithIndexes = this.priceCalculator.setPriceIndexes(
            processedPrices,
            lowIndexHours,
            highIndexHours
        );

        // Získání aktuální hodiny
        const timeInfo = this.getCurrentTimeInfo();
        const currentHour = timeInfo.hour === 24 ? 0 : timeInfo.hour;

        // Batch update capabilities pro lepší výkon
        const updatePromises = [];

        // Update hodinových hodnot
        for (const { hour, priceCZK, level } of pricesWithIndexes) {
            const convertedPrice = this.priceCalculator.convertPrice(
                priceCZK,
                device.getPriceInKWh()
            );
            
            updatePromises.push(
                device.setCapabilityValue(`hour_price_CZK_${hour}`, convertedPrice),
                device.setCapabilityValue(`hour_price_index_${hour}`, level)
            );

            if (this.logger) {
                this.logger.debug('Připravena aktualizace hodinových hodnot', { 
                    hour, 
                    convertedPrice, 
                    level 
                });
            }
        }

        // Update aktuálních hodnot
        const currentHourData = pricesWithIndexes.find(price => price.hour === currentHour);
        if (currentHourData) {
            const convertedCurrentPrice = this.priceCalculator.convertPrice(
                currentHourData.priceCZK,
                device.getPriceInKWh()
            );
            
            updatePromises.push(
                device.setCapabilityValue('measure_current_spot_price_CZK', convertedCurrentPrice),
                device.setCapabilityValue('measure_current_spot_index', currentHourData.level)
            );

            if (this.logger) {
                this.logger.debug('Připravena aktualizace současných hodnot', { 
                    currentHour, 
                    convertedCurrentPrice, 
                    currentLevel: currentHourData.level 
                });
            }
        }

        // Provedení všech aktualizací najednou
        await Promise.all(updatePromises);

        // Aktualizace průměrné denní ceny a emit události
        await Promise.all([
            device.updateDailyAverageCapability(),
            this.homey.emit('spot_prices_updated', {
                deviceId: device.getData().id,
                timestamp: new Date().toISOString(),
                updatedPrices: pricesWithIndexes.length
            })
        ]);

        if (this.logger) {
            this.logger.log('=== AKTUALIZACE SOUČASNÝCH HODNOT DOKONČENA ===', {
                deviceId: device.getData().id,
                updatedValues: updatePromises.length / 2, // Děleno 2, protože každá hodina má 2 capability
                timestamp: new Date().toISOString()
            });
        }

        return true;

    } catch (error) {
        if (this.logger) {
            this.logger.error('Kritická chyba při aktualizaci současných hodnot', error, { 
                deviceId: device.getData().id 
            });
        }

        // Správné zpracování API chyby s poskytnutím informací pro retry
        await device.triggerAPIFailure({
            primaryAPI: error.message,
            backupAPI: '',
            willRetry: true,
            retryCount: 0,
            nextRetryIn: '5',
            maxRetriesReached: false
        });

        throw error;
    } finally {
        updatingLock = false;
    }
}
}

module.exports = SpotPriceAPI;