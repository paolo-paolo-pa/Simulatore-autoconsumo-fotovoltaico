# Come funziona il calcolo

**1. Consumi.** Si parte dalle bollette mensili di luce (per fascia F1/F2/F3) e gas. Si usano solo i mesi rappresentativi: restano fuori i periodi di cantiere, gli appartamenti vuoti e le estati prima dell'installazione dei condizionatori. La base predefinita («normalizzata») usa due inverni completi e l'ultima estate.

**2. Produzione solare.** Per ogni mese la resa in kWh per kWp viene da PVGIS (Commissione Europea), con la forma oraria della giornata tipo. Si sottraggono perdite extra (sporco, ombre, primo anno).

**3. Giornata tipo, ora per ora.** Per ognuno dei 12 mesi si costruisce una giornata di 24 ore: il carico della casa (con profili «fuori casa / misto / in casa» o una curva reale caricata), più auto elettrica, pompa di calore, condizionatori in riscaldamento e raffrescamento estivo.

**4. Autoconsumo, batteria e rete.** Ogni ora: il fotovoltaico copre prima la casa; il surplus carica la batteria (rendimento 90%); quello che resta va in rete. La sera la batteria copre il fabbisogno. Gli acquisti dalla rete sono divisi nelle fasce F1/F2/F3.

**5. Costi.** Parte fissa dell'impianto + €/kWp + maggior costo oltre 6 kWp (trifase) + batteria (parte fissa + €/kWh) + eventuali pompa, wallbox e auto, meno gli incentivi (detrazione in 10 anni o Conto Termico).

**6. Flusso di cassa a 20 anni.** Risparmio di luce e gas, vendita dell'energia ceduta, degrado dei pannelli (0,5%/anno) e della batteria (2%/anno), rincaro dell'energia, sostituzione dell'inverter all'anno 12. Da qui rientro e guadagno netto.

**7. Prezzi.** Luce e gas: parte variabile delle bollette con IVA. Gasolio: dalle fatture, senza IVA. Energia ceduta: ipotesi di ritiro dedicato. Tutto modificabile, con un'etichetta che dice se il valore è misurato, da PVGIS, da fonte web, una stima o da confermare.

**8. Ottimizzatore e sensibilità.** Ogni combinazione di potenza e batteria viene valutata per 6 usi della casa; si scelgono la migliore, la più rapida e quella che «non rimpiangi» in nessun uso (minimo rimpianto). La sensibilità sposta un parametro alla volta tra minimo e massimo plausibile.

## Anonimizzazione dei dati di esempio

Consumi di luce ×1,17, gas ×0,91, litri di carburante ×1,08 (prezzi invariati); indirizzo, codici di fornitura, targhe, luoghi dei rifornimenti e nomi dei fornitori rimossi; posizione solare arrotondata alla regione.
