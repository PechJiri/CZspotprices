La aplicación te permite recibir actualizaciones diarias sobre los precios actuales de la electricidad en el mercado CZ. Te permite añadir costos de distribución a estos precios para cada hora y definir las horas durante las cuales utilizas la tarifa más baja. Basado en el precio actual o el índice de precios, puedes controlar tus flujos y monitorear precios a través de widgets interactivos.

Para un funcionamiento adecuado:
1. Añade el dispositivo a Homey
2. Establece los costos de distribución para tarifas altas y bajas
3. Especifica las horas durante las cuales está disponible la tarifa más baja
4. Opcionalmente, habilita el registro de depuración para resolver problemas

Características de la app:
- Monitoreo de precios en tiempo real a través de dos widgets:
  - Widget de Precio de Hora Actual que muestra los precios actuales, de la siguiente hora y el promedio
  - Gráfico de Precios Diarios Interactivo con tarifas codificadas por color y niveles de precios
- Cambio automático a fuente de datos de respaldo si la API principal no está disponible
- Visualización de precios en MWh o kWh
- Amplio soporte de flujo para automatización basada en precios y tarifas
- Cálculo avanzado de períodos de precio óptimos

Los costos de distribución se incluirán automáticamente en los precios durante la próxima actualización. La app utiliza dos fuentes de datos: datos primarios de spotovaelektrina.cz y datos de respaldo de OTE-CR cuando sea necesario.