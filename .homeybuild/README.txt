The application allows you to receive daily updates on the current spot electricity prices for the CZ market. It enables you to add distribution costs to these prices for each hour and define the hours during which you utilize the lower tariff. Based on the current price or price index, you can control your flows and monitor prices through interactive widgets.

For proper functionality:
1. Add the device to Homey
2. Set the distribution costs for both high and low tariffs
3. Specify the hours during which the lower tariff is available
4. Optionally enable debug logging for troubleshooting

The app features:
- Real-time price monitoring through two widgets:
  - Current Hour Price Widget showing current, next hour, and average prices
  - Interactive Daily Price Graph with color-coded tariffs and price levels
- Automatic switching to backup data source if the primary API is unavailable
- Price display in either MWh or kWh
- Comprehensive flow support for automation based on prices and tariffs
- Advanced calculation of optimal price periods

The distribution costs will be automatically included in the prices during the next update. The app uses two data sources: primary data from spotovaelektrina.cz and backup data from OTE-CR when needed.