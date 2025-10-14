## About the Application

**IMPORTANT: This is a newly redesigned application that now works with 15-minute market data instead of hourly data.**

The application allows you to receive updates on current spot electricity prices for the CZ market based on 15-minute intervals (96 slots per day). It enables you to add distribution costs to these prices for each hour and define the hours during which you utilize the lower tariff. Based on the current price or price index, you can control your flows and monitor prices through interactive widget.

The app uses  data from **spotovaelektrina.cz**

## For Proper Functionality

1. **Add the device to Homey** (or re-add device if you have used hourly device from previous version)
2. **Set the distribution costs** for both high and low tariffs
3. **Specify the hours** during which the lower tariff is available (hourly tariffs: hour_0 through hour_23)
4. **Optionally enable debug logging** for troubleshooting

## Key Features

### Real-time Price Monitoring
The app provides interactive widget for price monitoring:
- **Interactive Daily Price Graph**
  - Three view modes: 24h (full day), 6h, and 3h
  - Color-coded price levels (low/medium/high)
  - Visual indication of current time slot
  - Shows tariff zones
  - Responsive design with automatic updates
  - Updates every 15 minutes

### 15-Minute Market Data
- **96 slots per day** (4 slots per hour at 0, 15, 30, and 45 minutes)
- Automatic updates every 15 minutes
- Data fetched once daily at midnight

### Distribution Tariffs
- **Hourly tariffs** remain in effect (hour_0 through hour_23)
- Separate pricing for high and low tariff periods
- Automatic tariff switching based on configured hours
- Optional VAT inclusion for commodity prices

### Price Display Options
- Display prices in **kWh** or **MWh**
- Automatic unit conversion

### Automatic API data system System
- API: spotovaelektrina.cz
- Retry mechanism with exponential backoff
- Maximum retry attempts before alerting
- Status indicators for API health

### Advanced Flow Support

**Triggers:**
- When electricity price changes
- When price index equals specific value
- When average price period starts
- When high/low tariff starts
- When distribution tariff changes
- When API call fails

**Conditions:**
- Check if current price is in average price period
- Check if current price is in remaining day's best period
- Check if current distribution tariff is high/low

**Actions:**
- Manually update spot price data via API

### Price Period Calculations
The app includes advanced algorithms to calculate optimal price periods:
- Find N consecutive cheapest/most expensive slots
- Calculate average prices for any period length
- Support for both hour-based and slot-based calculations

## Migration Notice

**Breaking Change:** This version no longer supports hourly devices (24 slots). All devices now work exclusively with 15-minute intervals (96 slots per day). The distribution tariffs remain hourly with standard electricity billing practices.

## Data Sources

**Primary API:** spotovaelektrina.cz  
**Update Frequency:** Once daily at midnight (00:00)  
**Slot Updates:** Every 15 minutes for current slot data  
**Timezone:** Configured via Homey system settings

---

**Developed for Homey Pro**  
Compatible with Homey SDK 3