Applikasjonen lar deg motta daglige oppdateringer om dagens spotpriser på strøm for CZ-markedet. Den gjør det mulig å legge til distribusjonskostnader til disse prisene for hver time og definere timene der du bruker lavere tariff. Basert på dagens pris eller prisindeks kan du kontrollere flytene dine og overvåke prisene gjennom interaktive widgets.

For korrekt funksjon:
1. Legg til enheten i Homey
2. Sett distribusjonskostnadene for både høy og lav tariff
3. Angi timene der den lavere tariffen er tilgjengelig
4. Aktiver eventuelt feilsøkingslogging for problemløsning

Appens funksjoner:
- Prisovervåking i sanntid gjennom to widgets:
  - Nåværende timepris-widget som viser nåværende, neste time og gjennomsnittspriser
  - Interaktiv daglig prisgraf med fargekodede tariffer og prisnivåer
- Automatisk bytte til backup-datakilde hvis den primære API-en ikke er tilgjengelig
- Prisutvisning enten i MWh eller kWh
- Omfattende flownstøtte for automatisering basert på priser og tariffer
- Avansert beregning av optimale prisperioder

Distribusjonskostnadene vil automatisk inkluderes i prisene ved neste oppdatering. Appen bruker to datakilder: primærdata fra spotovaelektrina.cz og backup data fra OTE-CR når det er nødvendig.