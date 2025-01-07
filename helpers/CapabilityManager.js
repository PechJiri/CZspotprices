'use strict';

const Logger = require('./Logger');

class CapabilityManager {
   static instance = null;
   static CONTEXT = 'CapabilityManager';

   static getInstance(homey) {
       if (!CapabilityManager.instance) {
           CapabilityManager.instance = new CapabilityManager(homey);
       }
       return CapabilityManager.instance;
   }

   constructor(homeyInstance) {
       if (CapabilityManager.instance) {
           throw new Error('Použijte CapabilityManager.getInstance()');
       }
       this.homey = homeyInstance;
       this.logger = Logger.getInstance();
   }

   static setHomeyInstance(homey) {
       if (!homey) {
           throw new Error('Homey instance je vyžadována pro CapabilityManager');
       }
       CapabilityManager.homeyInstance = homey;
   }

   async updateHourlyCapabilities(device, pricesWithIndexes) {
       const currentPriceInKWh = device.priceInKWh;

       const updatePromises = pricesWithIndexes.map(async priceData => {
           const convertedPrice = device.priceCalculationEngine.convertPrice(
               priceData.priceCZK,
               currentPriceInKWh
           );

           this.logger?.debug('Aktualizuji capability', {
               hour: priceData.hour,
               price: convertedPrice,
               level: priceData.level
           });

           return Promise.all([
               device.setCapabilityValue(`hour_price_CZK_${priceData.hour}`, convertedPrice),
               device.setCapabilityValue(`hour_price_index_${priceData.hour}`, priceData.level)
           ]).catch(err => {
               this.logger?.error('Chyba při aktualizaci hodinových capabilities', err);
               throw err;
           });
       });

       return Promise.all(updatePromises);
   }

   async updateCurrentAndNextHourPrices(device, pricesWithIndexes) {
       try {
           if (!device.spotPriceApi) {
               throw new Error('SpotPriceApi není inicializován');
           }

           const { hour: currentHour } = device.spotPriceApi.getCurrentTimeInfo();
           const nextHour = (currentHour + 1) % 24;
           const currentPriceInKWh = device.priceInKWh;

           this.logger?.debug('Začátek aktualizace current a next hour price', {
               currentHour,
               nextHour,
               priceInKWh: currentPriceInKWh
           });

           if (!Array.isArray(pricesWithIndexes)) {
               throw new Error('Neplatná vstupní data - není pole');
           }

           const currentHourData = pricesWithIndexes.find(price => price.hour === currentHour);
           const nextHourData = pricesWithIndexes.find(price => price.hour === nextHour);

           if (!currentHourData) {
               this.logger?.error('Nenalezena data pro aktuální hodinu', {
                   hour: currentHour,
                   availableHours: pricesWithIndexes.map(p => p.hour).join(', ')
               });
               throw new Error(`Nenalezena data pro aktuální hodinu ${currentHour}`);
           }

           const validIndexes = ['low', 'medium', 'high', 'unknown'];
           const currentIndex = currentHourData.level && validIndexes.includes(currentHourData.level) 
               ? currentHourData.level 
               : 'unknown';

           const convertedCurrentPrice = device.priceCalculationEngine.convertPrice(
               currentHourData.priceCZK,
               currentPriceInKWh
           );

           const convertedNextPrice = nextHourData ? 
               device.priceCalculationEngine.convertPrice(nextHourData.priceCZK, currentPriceInKWh) : 
               null;

           this.logger?.debug('Zpracování dat před aktualizací', {
               currentHour,
               currentPrice: convertedCurrentPrice,
               normalizedIndex: currentIndex,
               nextHour,
               nextPrice: convertedNextPrice,
               priceInKWh: currentPriceInKWh
           });

           const updatePromises = [
               device.setCapabilityValue('measure_current_spot_price_CZK', convertedCurrentPrice),
               device.setCapabilityValue('measure_current_spot_index', currentIndex)
           ];

           if (convertedNextPrice !== null) {
               updatePromises.push(
                   device.setCapabilityValue('measure_next_hour_price', convertedNextPrice)
               );
           }

           await Promise.all(updatePromises).catch(err => {
               this.logger?.error('Chyba při aktualizaci capabilities', err);
               throw err;
           });

           this.logger?.debug('Aktuální a následující ceny aktualizovány', {
               currentHour,
               currentPrice: convertedCurrentPrice,
               currentIndex,
               nextHour,
               nextPrice: convertedNextPrice
           });

           return { currentPrice: convertedCurrentPrice, currentIndex, nextPrice: convertedNextPrice };

       } catch (error) {
           this.logger?.error('Chyba při aktualizaci aktuální a následující ceny', error);
           throw error;
       }
   }

   async updateDailyAverage(device, pricesWithIndexes) {
       try {
           const currentPriceInKWh = device.priceInKWh;
           const totalPrice = pricesWithIndexes.reduce((sum, price) => sum + price.priceCZK, 0);
           const averagePrice = device.priceCalculationEngine.convertPrice(
               totalPrice / pricesWithIndexes.length,
               currentPriceInKWh
           );

           this.logger?.debug('Vypočítaná průměrná cena', {
               totalPrice,
               averagePrice,
               priceInKWh: currentPriceInKWh
           });

           await device.setCapabilityValue('daily_average_price', averagePrice)
               .catch(err => {
                   this.logger?.error('Chyba při aktualizaci průměrné ceny', err);
                   throw err;
               });

           this.logger?.log('Denní průměrná cena aktualizována', { averagePrice });

           return averagePrice;
       } catch (error) {
           this.logger?.error('Chyba při aktualizaci denního průměru', error);
           throw error;
       }
   }

   async updateMinMaxPrices(device, pricesWithIndexes) {
       try {
           const currentPriceInKWh = device.priceInKWh;

           this.logger?.debug('Začátek aktualizace min/max cen', {
               priceInKWh: currentPriceInKWh,
               počet_cen: pricesWithIndexes.length
           });

           const prices = pricesWithIndexes.map(p => p.priceCZK);
           const minRawPrice = Math.min(...prices);
           const maxRawPrice = Math.max(...prices);

           const convertedMinPrice = device.priceCalculationEngine.convertPrice(minRawPrice, currentPriceInKWh);
           const convertedMaxPrice = device.priceCalculationEngine.convertPrice(maxRawPrice, currentPriceInKWh);

           await Promise.all([
               device.setCapabilityValue('measure_today_min_price', convertedMinPrice),
               device.setCapabilityValue('measure_today_max_price', convertedMaxPrice)
           ]).catch(err => {
               this.logger?.error('Chyba při aktualizaci min/max capabilities', err);
               throw err;
           });

           this.logger?.debug('Min/max ceny aktualizovány', {
               min: convertedMinPrice,
               max: convertedMaxPrice,
               rawMin: minRawPrice,
               rawMax: maxRawPrice
           });

           return { minPrice: convertedMinPrice, maxPrice: convertedMaxPrice };

       } catch (error) {
           this.logger?.error('Chyba při aktualizaci min/max cen', error);
           throw error;
       }
   }
}

module.exports = CapabilityManager;