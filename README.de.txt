Die Anwendung ermöglicht es dir, tägliche Updates über die aktuellen Spot-Strompreise für den CZ-Markt zu erhalten. Sie ermöglicht es dir, Verteilungskosten zu diesen Preisen pro Stunde hinzuzufügen und die Stunden zu definieren, in denen du den niedrigeren Tarif nutzt. Basierend auf dem aktuellen Preis oder Preisindex kannst du deine Flows steuern und die Preise über interaktive Widgets überwachen.

Für die korrekte Funktionalität:
1. Füge das Gerät zu Homey hinzu
2. Setze die Verteilungskosten für die hohen und niedrigen Tarife
3. Gib die Stunden an, in denen der niedrigere Tarif verfügbar ist
4. Optional kannst du das Debug-Logging für Fehlersuche aktivieren

Die App-Funktionen umfassen:
- Echtzeit-Preisüberwachung durch zwei Widgets:
  - Widget für den Preis der aktuellen Stunde, das die aktuellen, die nächsten Stundenpreise und Durchschnittspreise anzeigt
  - Interaktive tägliche Preisgrafik mit farbcodierten Tarifen und Preisniveaus
- Automatische Umschaltung auf die Backup-Datenquelle, wenn die primäre API nicht verfügbar ist
- Preisanzeige entweder in MWh oder kWh
- Umfassende Flow-Unterstützung für Automatisierung basierend auf Preisen und Tarifen
- Fortgeschrittene Berechnung optimaler Preisperioden

Die Verteilungskosten werden automatisch in den Preisen beim nächsten Update berücksichtigt. Die App verwendet zwei Datenquellen: primäre Daten von spotovaelektrina.cz und Backup-Daten von OTE-CR, wenn nötig.