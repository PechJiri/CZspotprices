Applikationen låter dig få dagliga uppdateringar om de aktuella spotpriserna på el för den tjeckiska marknaden. Den gör det möjligt att lägga till distributionskostnader för dessa priser varje timme och definiera de timmar när du använder den lägre tariffen. Baserat på det aktuella priset eller prisindexet kan du styra dina flöden och övervaka priserna genom interaktiva widgets.

För att fungera korrekt:
1. Lägg till enheten till Homey
2. Ställ in distributionskostnader för både höga och låga tariffer
3. Ange de timmar då lägre tariff är tillgänglig
4. Aktivera valfritt loggning för felsökning

Appens funktioner:
- Prisövervakning i realtid genom två widgets:
  - Nuvarande Timpris Widget som visar det aktuella, nästa timme och genomsnittliga priser
  - Interaktiv Daglig Prisgraf med färgkodade tariffer och prisnivåer
- Automatisk växling till reservdatasystem om den primära API:n inte är tillgänglig
- Prisdiplay i antingen MWh eller kWh
- Omfattande flödesstöd för automation baserat på priser och tariffer
- Avancerad beräkning av optimala prisperioder

Distributionskostnaderna kommer automatiskt att inkluderas i priserna vid nästa uppdatering. Appen använder två datakällor: primära data från spotovaelektrina.cz och reservdata från OTE-CR vid behov.