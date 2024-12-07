Met de applicatie ontvang je dagelijkse updates over de actuele spot-elektriciteitsprijzen voor de CZ-markt. Je kunt distributiekosten per uur toevoegen en de uren definiëren waarin je het lagere tarief gebruikt. Op basis van de huidige prijs of prijsindex kun je je flows beheren en prijzen volgen via interactieve widgets.

Voor de juiste werking:
1. Voeg het apparaat toe aan Homey
2. Stel de distributiekosten in voor zowel hoge als lage tarieven
3. Specificeer de uren waarin het lagere tarief beschikbaar is
4. Schakel eventueel debug logging in voor probleemoplossing

De app biedt:
- Real-time prijsbewaking via twee widgets:
  - Widget voor de huidige uurprijs met huidige, volgende uur en gemiddelde prijzen
  - Interactieve dagelijkse prijsgrafiek met kleurgecodeerde tarieven en prijsniveaus
- Automatisch overschakelen naar een back-up gegevensbron als de primaire API niet beschikbaar is
- Prijsweergave in MWh of kWh
- Uitgebreide flow-ondersteuning voor automatisering op basis van prijzen en tarieven
- Geavanceerde berekening van optimale prijsperiodes

De distributiekosten worden automatisch in de prijzen opgenomen tijdens de volgende update. De app maakt gebruik van twee gegevensbronnen: primaire gegevens van spotovaelektrina.cz en back-upgegevens van OTE-CR indien nodig.