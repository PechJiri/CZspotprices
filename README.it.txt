L'applicazione ti consente di ricevere aggiornamenti giornalieri sui prezzi attuali dell'elettricità nel mercato CZ. Ti permette di aggiungere i costi di distribuzione a questi prezzi per ogni ora e definire le ore durante le quali utilizzi la tariffa più bassa. In base al prezzo o all'indice di prezzo attuale, puoi controllare i tuoi flussi e monitorare i prezzi tramite widget interattivi.

Per il corretto funzionamento:
1. Aggiungi il dispositivo a Homey
2. Imposta i costi di distribuzione per entrambe le tariffe, alta e bassa
3. Specifica le ore durante le quali è disponibile la tariffa inferiore
4. Abilita eventualmente il registro di debug per la risoluzione dei problemi

Caratteristiche dell'app:
- Monitoraggio del prezzo in tempo reale tramite due widget:
  - Widget del Prezzo dell'Ora Corrente che mostra prezzi attuali, della prossima ora e medi
  - Grafico del Prezzo Giornaliero Interattivo con tariffe e livelli di prezzo codificati a colori
- Commutazione automatica alla fonte dati di backup se l'API principale non è disponibile
- Visualizzazione del prezzo in MWh o kWh
- Supporto completo ai flussi per l'automazione basata su prezzi e tariffe
- Calcolo avanzato dei periodi di prezzo ottimali

I costi di distribuzione verranno automaticamente inclusi nei prezzi durante l'aggiornamento successivo. L'app utilizza due fonti di dati: dati primari da spotovaelektrina.cz e dati di backup da OTE-CR quando necessario.