/* Modello di calcolo per consumi e fotovoltaico. Funzioni pure: niente variabili globali.
   Si usa nel browser (window.FVModello) e in Node (require). Dati e parametri entrano sempre come argomenti.

   Flusso:  D = creaDati(grezzi)  →  ctx = contesto(D, P)  →  valuta(ctx, cfg)  /  sensibilitaAB(D, P, cfgA, cfgB)
   - D   dati misurati (bollette, PVGIS, carburante)
   - P   scelte dell'utente (menu in alto) + valori modificati a mano in P.ov
   - cfg una configurazione da valutare: {kwp, batt, riscaldamento, nev}
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FVModello = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MESI = ['Gen','Feb','Mar','Apr','Mag','Giu','Lug','Ago','Set','Ott','Nov','Dic'];
  const GG = [31,28.25,31,30,31,30,31,31,30,31,30,31];
  const UNITA = ['Primo piano', 'Secondo piano'];
  const PANEL_KWP = 0.43, PANEL_M2 = 1.95;       // pannello tipo da 430 Wp
  const COOK = 20;                                 // Smc/anno di cottura per appartamento (restano a gas)
  const SMC_KWH = 10.0, BOILER_EFF = 0.92;         // kWh utili per Smc (40,0108 MJ/Smc in bolletta) e rendimento caldaia
  const sum = a => a.reduce((x, y) => x + y, 0);
  const avg = a => (a.length ? sum(a) / a.length : 0);
  const monthShift = (m, d) => { let y = +m.slice(0, 4), mo = +m.slice(5) + d; while (mo < 1) { mo += 12; y--; } while (mo > 12) { mo -= 12; y++; } return `${y}-${String(mo).padStart(2, '0')}`; };
  const num = v => { if (v === undefined || v === null || v === '') return NaN; const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : NaN; };

  /* ============================== dati ============================== */
  /* Periodi in cui i consumi di un appartamento NON sono rappresentativi (informazioni date dall'utente). */
  const ESCLUSIONI = [
    { unita: '*', da: '2025-10', a: '2026-04', motivo: 'lavori nel palazzo (ottobre 2025 – aprile 2026)' },
    { unita: 'Primo piano', da: '2023-10', a: '9999-12', motivo: 'Primo piano disabitato dall\'8 ottobre 2023' }
  ];
  function normalizza(r) {
    const f1 = num(r.kwh_f1), f2 = num(r.kwh_f2), f3 = num(r.kwh_f3);
    let tot = num(r.kwh_tot); const hasF = isFinite(f1) && isFinite(f2) && isFinite(f3);
    if (!isFinite(tot) && hasF) tot = f1 + f2 + f3;
    if (!/^\d{4}-\d{2}$/.test(String(r.mese || '').trim()) || !isFinite(tot)) return null;
    return { mese: String(r.mese).trim(), unita: (r.unita || 'Secondo piano').trim(), f1: hasF ? f1 : NaN, f2: hasF ? f2 : NaN, f3: hasF ? f3 : NaN,
      tot, euro: num(r.euro), giorni: num(r.giorni), pmax: num(r.pot_max_kw), src: r.src || 'file' };
  }
  /* grezzi: {consumi:[righe mensili], info:BOLLETTE_INFO, pvgis:PVGIS_DATA, carburante:CARBURANTE_DATA, curva:{shape,...}} */
  function creaDati(grezzi) {
    const rows = (grezzi.consumi || []).map(normalizza).filter(Boolean).sort((a, b) => a.mese.localeCompare(b.mese));
    const byUnit = {}; UNITA.forEach(u => { byUnit[u] = rows.filter(r => r.unita === u); });
    const months = [...new Set(rows.map(r => r.mese))].sort();
    const ultimiPrimo = byUnit['Primo piano'].slice(-6).map(r => r.tot);
    return { rows, byUnit, months, info: grezzi.info || null, pvgis: grezzi.pvgis || null, carburante: grezzi.carburante || null,
             curva: grezzi.curva || null, spentoM: ultimiPrimo.length ? avg(ultimiPrimo) : 2 };
  }
  /* motivo per cui un mese dell'appartamento è escluso (o null). P.escludi === false disattiva le esclusioni. */
  /* Condizionatori del Secondo piano: installati negli ultimi due anni (data esatta da confermare). Le estati prima non contengono il raffrescamento:
     per i consumi di luce si usano solo i mesi estivi (giugno-settembre) dal mese 'climaDal' in poi. Non riguarda il gas né i periodi scelti a mano. */
  const CLIMA_DAL = '2026-05';
  const climaDal = P => (P && P.climaDal) || CLIMA_DAL;
  function motivoEsclusione(P, unita, mese, gas) {
    if (P && P.escludi === false) return null;
    const e = ESCLUSIONI.find(x => (x.unita === '*' || x.unita === unita) && mese >= x.da && mese <= x.a);
    if (e) return e.motivo;
    if (!gas && unita === 'Secondo piano' && P && P.climaDal !== 'nessuno' && (!P.range || P.range === 'validi' || P.range === 'ultimi12' || P.range === 'norm')) {
      const mo = +mese.slice(5);
      if (mo >= 6 && mo <= 9 && mese < climaDal(P)) return 'estate prima dei condizionatori';
    }
    return null;
  }
  const righeValide = (D, P, u) => D.byUnit[u].filter(r => !motivoEsclusione(P, u, r.mese));

  /* ============================== gas ============================== */
  const gasSerie = (D, u) => { const g = D.info && D.info.gas && D.info.gas[u]; return g ? Object.keys(g.annuali).sort().map(k => [k, g.annuali[k].smc]) : []; };
  const gasMensile = (D, u) => (D.info && D.info.gas && D.info.gas[u]) ? D.info.gas[u].mensile : {};
  /* un valore 'consumo annuo' di fine k copre i 12 mesi fino a k: è escluso se tocca un periodo escluso */
  const gasFinestraEsclusa = (P, u, k) => { for (let i = 0; i < 12; i++) if (motivoEsclusione(P, u, monthShift(k, -i), true)) return true; return false; };
  function gasFinestra(D, u, fine) {   // gas dei 12 mesi che finiscono a 'fine'; est=true se ricavato dalla somma dei mesi (meno affidabile)
    const ann = gasSerie(D, u).filter(x => x[0] >= monthShift(fine, -1) && x[0] <= monthShift(fine, 1));
    if (ann.length) return { v: ann[0][1], est: false };
    const mm = gasMensile(D, u); let t = 0, n = 0;
    for (let i = 0; i < 12; i++) { const v = mm[monthShift(fine, -i)]; if (v !== undefined) { t += v; n++; } }
    return n >= 10 ? { v: t / n * 12, est: true } : { v: null, est: true };
  }
  function gasPeriodo(D, P, u, rng) {
    const gf = rng.gasFrom || rng.from, gt = rng.gasTo || rng.to, s = gasSerie(D, u).filter(x => x[0] >= gf && x[0] <= gt && !gasFinestraEsclusa(P, u, x[0]));
    if (s.length) return avg(s.map(x => x[1]));
    const mm = gasMensile(D, u), ks = Object.keys(mm).filter(k => k >= gf && k <= gt && !motivoEsclusione(P, u, k, true));
    if (ks.length >= 6) return sum(ks.map(k => mm[k])) / ks.length * 12;
    const a = gasSerie(D, u).filter(x => !gasFinestraEsclusa(P, u, x[0])); return a.length ? a[a.length - 1][1] : 0;
  }
  const gasUltimiValidi = (D, P, u) => { const a = gasSerie(D, u).filter(x => !gasFinestraEsclusa(P, u, x[0])); return a.length ? a[a.length - 1][1] : 0; };
  const gasUltimi12 = (D, u) => { const s = gasSerie(D, u); return s.length ? s[s.length - 1][1] : 0; };
  function legnaDefault(D) {   // gas del Primo rispetto al Secondo negli ultimi dati utili (settembre 2025)
    const p = gasSerie(D, 'Primo piano').filter(x => x[0] <= '2025-09').pop(), s = gasSerie(D, 'Secondo piano').filter(x => x[0] <= '2025-09').pop();
    return (p && s && s[1] > 0) ? Math.min(100, Math.max(10, Math.round(p[1] / s[1] * 100))) : 60;
  }

  /* ============================== prezzi: storico dalle bollette ============================== */
  /* Costo medio annuo (ottobre-settembre) di luce e gas: spesa totale di bolletta diviso i consumi.
     Comprende la quota fissa, quindi NON è il prezzo del singolo kWh: serve a vedere come si muovono i prezzi nel tempo. */
  function storicoPrezzi(D) {
    const info = D.info || {}, lb = info.luce_bollette || [], out = { luce: [], gas: [] };
    for (let y = 2021; y <= 2026; y++) {
      const a = `${y - 1}-10`, b = `${y}-09`;
      const sel = lb.filter(x => x.unita === 'Secondo piano' && x.fine >= a && x.fine <= b);   // il Secondo ha consumi stabili: il confronto regge
      const k = sum(sel.map(x => x.kwh)), e = sum(sel.map(x => x.euro));
      if (sel.length >= 5 && k > 500) out.luce.push({ anno: y, eurkwh: e / k, kwh: k, euro: e, bollette: sel.length });
      const gb = info.gas && info.gas['Secondo piano'] ? info.gas['Secondo piano'].bollette : [];
      const gs = gb.filter(x => x.fine >= a && x.fine <= b);
      const sk = sum(gs.map(x => x.smc)), se = sum(gs.map(x => x.euro));
      if (gs.length >= 6 && sk > 300) out.gas.push({ anno: y, eursmc: se / sk, smc: sk, euro: se, bollette: gs.length });
    }
    const stat = arr => { if (!arr.length) return null; const m = avg(arr), sd = Math.sqrt(avg(arr.map(v => (v - m) ** 2))); return { min: Math.min(...arr), max: Math.max(...arr), media: m, sd, cv: sd / m }; };
    out.statLuce = stat(out.luce.map(x => x.eurkwh)); out.statGas = stat(out.gas.map(x => x.eursmc));
    return out;
  }
  /* Costo mensile luce/kWh (spesa del mese / kWh) del Secondo piano: serve al grafico dei prezzi nel tempo. */
  function prezzoMensileLuce(D, P) {
    return D.byUnit['Secondo piano'].filter(r => isFinite(r.euro) && r.tot >= 60 && !motivoEsclusione(P, 'Secondo piano', r.mese)).map(r => ({ mese: r.mese, eurkwh: r.euro / r.tot }));
  }

  /* ============================== parametri ============================== */
  /* Valori di partenza calcolati dai dati. 'tipo' dice da dove arriva ogni numero:
       bolletta = misurato nelle bollette/fatture · pvgis = PVGIS (UE) · web = fonte esterna datata ·
       stima = ipotesi di mercato · confermare = serve un dato tuo · scelta = scelta tua nel menu */
  const DETRAZIONI = {
    '2026p': { n: 'Prima casa, spese pagate nel 2026', pct: 50 },
    '2026a': { n: 'Altra abitazione, spese pagate nel 2026', pct: 36 },
    '2027p': { n: 'Prima casa, spese pagate dal 2027', pct: 36 },
    '2027a': { n: 'Altra abitazione, spese pagate dal 2027', pct: 30 }
  };
  const PRESET = {
    base:      { n: 'Prezzi di oggi', luce: 1, gas: 1, diesel: 1, cess: 0.10, costi: 1, rincaro: 2 },
    prudente:  { n: 'Prudente: energia −10%, cessione 0,08 €/kWh, costi +15%, nessun rincaro', luce: 0.9, gas: 0.9, diesel: 0.9, cess: 0.08, costi: 1.15, rincaro: 0 },
    ottimista: { n: 'Ottimistico: energia +10%, cessione 0,12 €/kWh, costi −10%, rincaro 3,5%/anno', luce: 1.1, gas: 1.15, diesel: 1.1, cess: 0.12, costi: 0.9, rincaro: 3.5 }
  };
  function prezzoLuceMarginale(D) {   // costo evitato da un kWh in meno: quota consumi + accisa + IVA, media pesata delle ultime 8 bollette significative
    const info = D.info; if (!info) return 0.25;
    const last = (info.prezzi_bollette || []).filter(x => x.kwh >= 50 && x.prezzo_q).slice(-8);
    if (!last.length) return info.prezzo_marginale || 0.25;
    return Math.round(sum(last.map(x => (x.prezzo_q + 0.0227) * 1.1 * x.kwh)) / sum(last.map(x => x.kwh)) * 1000) / 1000;
  }
  function prezzoGasMarginale(D) {    // quota consumi (media ultime bollette) + accise e addizionali stimate (0,20) + IVA 10%
    const v = D.info && D.info.gas ? Object.values(D.info.gas).map(g => g.prezzo_quota).filter(Boolean) : [];
    return v.length ? Math.round((avg(v) + 0.2) * 1.1 * 100) / 100 : 1.25;
  }
  /* Carburante: litri e prezzi reali dalle fatture (IP 2019-2025, Radius da nov 2025). I prezzi sono NETTI di IVA: il gasolio è un costo aziendale
     con IVA detratta, mentre la luce di casa si paga IVA compresa. Quota di litri dell'auto da sostituire: metà, seconda auto o prima auto. */
  function carburante(D, P) {
    const c = D.carburante && D.carburante.riepilogo; if (!c || !(c.litri12m > 0)) return { misurato: false, litriAuto: null, prezzoNetto: null, fonte: 'stima', quota: 0.5 };
    const q = (P && P.quotaAuto) || 'meta', lit = q === 'seconda' ? c.litri12m_seconda : q === 'prima' ? c.litri12m_prima : c.litri12m * 0.5;
    const pm = (c.prezzi_mensili || []).slice(-6), l6 = sum(pm.map(x => x.litri)), p6 = l6 ? sum(pm.map(x => x.spesa_netta)) / l6 : null;
    return { misurato: true, litriAuto: lit, prezzoNetto: p6 || c.prezzo_netto_ultimo, prezzoNetto12m: c.prezzo_netto_medio12m, quota: q, fonte: 'fatture IP e Radius', litriTotali: c.litri12m };
  }
  function valoriBase(D, P) {
    const f = carburante(D, P), iceL = 7;
    return {
      luce: prezzoLuceMarginale(D), cess: 0.10, cessSera: 0.14, gas: prezzoGasMarginale(D), diesel: f.prezzoNetto || 1.85, rincaro: 2,
      maxKwp: 10, fissoFV: 2500, eurokwp: 1300, trifase: 1500, fissoBatt: 800, eurobatt: 700, ombre: 8, degrado: 0.5, batdeg: 2, inverter: 1000, potKw: 26, potUnaTantum: 120, orizzonte: 20,
      detrFV: 50, detrPdc: 50, detrWb: 50, ctPct: 65,
      hpCop: 3.0, hpCopPrimo: 3.8, hpCostUnica: 12000, hpCostPiano: 8500, hpCool: 0, hpShare: 100,
      climaQuota: 25, climaCop: 3.3, climaGiorno: 60,
      legnaPct: legnaDefault(D), effic: 0,
      evKm: f.litriAuto ? Math.round(f.litriAuto / iceL * 100 / 500) * 500 : 12000, iceL, evKwh: 17, evHome: 85, evDay: 25, evPublic: 0.65,
      wbCost: 1500, evExtra: 6000, evPrezzo: 30000, fordValore: 1000, evManut: 300, evBollo: 150
    };
  }
  /* Registro dei parametri numerici: etichetta, unità, tipo di fonte e da dove arriva. 'lo/hi' = intervallo plausibile per le sensibilità. */
  function registro(D, P) {
    const b = valoriBase(D, P || {}), sp = storicoPrezzi(D), f = carburante(D, P || {}), cr = D.carburante && D.carburante.riepilogo;
    const sL = sp.statLuce, dLo = cr && cr.prezzo_netto_min ? cr.prezzo_netto_min : b.diesel * 0.8, dHi = cr && cr.prezzo_netto_max ? cr.prezzo_netto_max : b.diesel * 1.2;
    const R = [
      ['luce', 'Prezzo luce evitata (con IVA)', '€/kWh', 'Prezzi', 'bolletta', 'Quota consumi + accisa + IVA 10%, media pesata delle ultime 8 bollette. Il costo medio annuo è variato ' + (sL ? Math.round(sL.cv * 100) + '% (dev. standard) negli ultimi anni' : '') + '.', 0.005, b.luce * 0.8, b.luce * 1.2],
      ['cess', 'Prezzo energia ceduta alla rete', '€/kWh', 'Prezzi', 'web', 'Ritiro dedicato GSE, zona Sud: ~0,10–0,11 €/kWh; a mezzogiorno è più basso. Da verificare sulle tabelle GSE.', 0.01, 0.07, 0.13],
      ['cessSera', 'Prezzo di vendita serale (con batteria)', '€/kWh', 'Prezzi', 'stima', 'Ipotesi: nelle ore serali l\'energia vale più che a mezzogiorno. Non ho dati orari: da verificare sui prezzi orari GSE/PUN.', 0.01, 0.10, 0.20],
      ['gas', 'Prezzo gas evitato (con IVA)', '€/Smc', 'Prezzi', 'bolletta', 'Quota consumi delle bollette + accise e addizionali stimate (0,20 €/Smc) + IVA 10%.', 0.01, b.gas * 0.75, b.gas * 1.25],
      ['diesel', 'Prezzo gasolio, senza IVA', '€/l', 'Prezzi', f.misurato ? 'bolletta' : 'web', f.misurato ? 'Media pesata dei rifornimenti degli ultimi 6 mesi (fatture IP e Radius), senza IVA: l\'IVA la detrai come costo aziendale. Il prezzo alla pompa è ~22% più alto.' : 'Media self nazionale 2,259 €/l (Mimit, 21/10/2026) meno IVA 22%. Con le fatture diventa un dato misurato.', 0.05, dLo, dHi],
      ['rincaro', 'Rincaro annuo dell\'energia', '%/anno', 'Prezzi', 'stima', 'Ipotesi: i prezzi dell\'energia salgono ogni anno. 0% = prezzi fermi.', 0.5, 0, 4],
      ['maxKwp', 'Potenza massima installabile sul tetto', 'kWp', 'Impianto', 'confermare', 'Dipende dall\'area libera del tetto e dai vincoli paesaggistici: da misurare con il tecnico (circa 5–7 m² per kWp sul tetto piano). Limita le configurazioni cercate.', 0.5, 4.5, 14],
      ['fissoFV', 'Impianto fotovoltaico: parte fissa', '€', 'Impianto', 'stima', 'Pratiche, quadro, installazione base, inverter: costo che c\'è a prescindere dai kWp.', 100, b.fissoFV * 0.7, b.fissoFV * 1.4],
      ['eurokwp', 'Impianto fotovoltaico: costo per kWp', '€/kWp', 'Impianto', 'stima', 'Pannelli, strutture e posa. Mercato 2026 chiavi in mano 1.500–2.000 €/kWp tutto compreso. Da sostituire con i preventivi.', 50, b.eurokwp * 0.8, b.eurokwp * 1.2],
      ['trifase', 'Maggior costo oltre 6 kWp (inverter trifase e pratiche)', '€', 'Impianto', 'stima', 'Oltre 6 kW serve in genere l\'inverter trifase e una connessione diversa.', 100, 0, 3000],
      ['fissoBatt', 'Batteria: parte fissa (inverter ibrido, installazione)', '€', 'Impianto', 'stima', 'Costo che c\'è con qualunque capacità.', 100, 400, 1500],
      ['eurobatt', 'Batteria: costo per kWh', '€/kWh', 'Impianto', 'stima', 'Mercato 2026: 500–800 €/kWh. Da sostituire con i preventivi.', 50, b.eurobatt * 0.75, b.eurobatt * 1.25],
      ['ombre', 'Perdite extra (sporco, ombre, primo anno)', '%', 'Impianto', 'stima', 'PVGIS include già il 14% di perdite di sistema; qui si aggiunge una scorta prudente.', 1, 4, 12],
      ['degrado', 'Degrado dei pannelli', '%/anno', 'Impianto', 'stima', 'Tipico 0,4–0,7% annuo.', 0.1, 0.3, 0.8],
      ['batdeg', 'Degrado della batteria', '%/anno', 'Impianto', 'stima', 'Tipico 2%/anno (garanzia in genere 10 anni).', 0.5, 1, 4],
      ['inverter', 'Sostituzione inverter (anno 12)', '€', 'Impianto', 'stima', 'Costo tipico di sostituzione dopo ~12 anni.', 100, 600, 1500],
      ['detrFV', 'Detrazione fiscale fotovoltaico e batteria', '%', 'Incentivi', 'web', 'Legge 199/2025: 50% abitazione principale (spese 2026), 36% altre abitazioni; dal 2027 36% e 30%. In 10 anni, tetto 96.000 €. Da verificare sul testo ufficiale.', 1, 30, 50],
      ['detrPdc', 'Detrazione pompa di calore', '%', 'Incentivi', 'web', 'Stessa regola della detrazione per le ristrutturazioni (50% prima casa 2026).', 1, 30, 50],
      ['ctPct', 'Conto Termico 3.0 (alternativo alla detrazione)', '% della spesa', 'Incentivi', 'web', 'D.M. 7/8/2025: fino al 65% per la pompa di calore, non cumulabile con la detrazione. Massimali da verificare sulle tabelle GSE.', 1, 40, 65],
      ['detrWb', 'Detrazione wallbox', '%', 'Incentivi', 'web', 'Stessa regola della detrazione per le ristrutturazioni.', 1, 30, 50],
      ['hpCop', 'COP stagionale della pompa al Secondo piano (termosifoni)', '', 'Pompa di calore', 'stima', 'Il Secondo piano ha termosifoni classici ad acqua, non modificabili: servono 55–65 °C di mandata, quindi il rendimento è più basso (2,7–3,3 in clima mite). Con pannelli a pavimento si arriva a 4–4,5.', 0.1, 2.5, 3.6],
      ['hpCopPrimo', 'COP della pompa al Primo piano (dopo la ristrutturazione)', '', 'Pompa di calore', 'stima', 'Il Primo piano avrà un impianto rifatto da zero (bassa temperatura, ad esempio a pavimento): COP 3,5–4,5. Conta solo negli scenari «dopo la ristrutturazione».', 0.1, 3.2, 4.5],
      ['climaQuota', 'Quota del riscaldamento del Secondo piano fatta con i condizionatori', '%', 'Condizionatori', 'confermare', 'Due condizionatori coprono solo le stanze dove sono installati: ipotesi 25% del gas di riscaldamento. Da confermare (quali stanze, quanta potenza).', 5, 10, 50],
      ['climaCop', 'COP stagionale dei condizionatori in riscaldamento', '', 'Condizionatori', 'stima', 'Split inverter in clima mite (Puglia): 3,0–4,0, cala con il freddo intenso. Più alto di una pompa ad acqua a termosifoni perché scalda l\'aria direttamente.', 0.1, 2.8, 4.0],
      ['climaGiorno', 'Riscaldamento con i condizionatori fatto nelle ore di sole', '%', 'Condizionatori', 'stima', 'Quanto del tempo di accensione invernale è spostato alle ore centrali (10–17), quando il fotovoltaico produce. Il resto è serale.', 5, 30, 90],
      ['hpCostUnica', 'Una pompa di calore unica per i due piani', '€', 'Pompa di calore', 'stima', 'Macchina da ~12 kW, installata chiavi in mano. Mercato 7.000–23.000 € a seconda dell\'impianto.', 500, b.hpCostUnica * 0.7, b.hpCostUnica * 1.4],
      ['hpCostPiano', 'Una pompa di calore per singolo piano', '€', 'Pompa di calore', 'stima', 'Macchina da ~7 kW per un solo appartamento.', 500, b.hpCostPiano * 0.7, b.hpCostPiano * 1.4],
      ['hpCool', 'Raffrescamento estivo aggiunto', 'kWh/anno', 'Pompa di calore', 'stima', 'Elettricità in più se usi la pompa anche d\'estate.', 50, 0, 600],
      ['hpShare', 'Quota del gas di riscaldamento sostituita', '%', 'Pompa di calore', 'stima', '100% = la caldaia si usa solo per la cottura.', 5, 70, 100],
      ['legnaPct', 'Gas del Primo piano rispetto al Secondo', '%', 'Consumi', 'bolletta', 'Rapporto tra i gas dei due piani a settembre 2025: il Primo si scalda anche con il camino a legna.', 5, 20, 100],
      ['effic', 'Efficientamento dei consumi di casa', '%', 'Consumi', 'stima', 'Riduzione di luce e gas di casa (non di auto e pompa di calore).', 1, 0, 30],
      ['evKm', 'Km all\'anno dell\'auto da sostituire', 'km', 'Auto', f.misurato ? 'bolletta' : 'confermare', f.misurato ? `Ricavato dai litri delle fatture (${Math.round(f.litriAuto)} l/anno per l'auto, quota ${f.quota === 'meta' ? '50%' : f.quota}) con ${b.iceL} l/100 km. Le letture del contachilometri danno ~12.000 km/anno per l'auto con targa auto.` : 'Ipotesi 12.000 km/anno (media italiana): da confermare.', 500, b.evKm * 0.7, b.evKm * 1.3],
      ['iceL', 'Consumo dell\'auto diesel', 'l/100 km', 'Auto', 'confermare', 'Stima per una diesel del 2006 (6,5–7,5): da confermare. Con i litri delle fatture cambia i km, non la spesa di carburante.', 0.5, 5.5, 8.5],
      ['evKwh', 'Consumo dell\'auto elettrica', 'kWh/100 km', 'Auto', 'web', 'Test indipendenti sulle compatte: 16–18 kWh/100 km in uso misto.', 0.5, 15, 20],
      ['evHome', 'Ricarica fatta a casa', '%', 'Auto', 'stima', 'Il resto si ricarica fuori casa al prezzo pubblico.', 5, 60, 100],
      ['evDay', 'Ricarica a casa in ore di sole', '%', 'Auto', 'stima', 'Più ricarichi di giorno, più usi il fotovoltaico.', 5, 0, 60],
      ['evPublic', 'Prezzo ricarica pubblica', '€/kWh', 'Auto', 'stima', 'Colonnine AC 0,55–0,65; veloci 0,70–0,90.', 0.05, 0.5, 0.85],
      ['wbCost', 'Wallbox installata', '€', 'Auto', 'stima', 'Wallbox 7 kW con installazione.', 100, 1000, 2200],
      ['evExtra', 'Sovrapprezzo auto elettrica rispetto a una termica', '€ per auto', 'Auto', 'stima', 'Differenza di listino tra un\'elettrica e una termica equivalente.', 500, 0, 12000],
      ['evPrezzo', 'Prezzo pieno auto elettrica', '€ per auto', 'Auto', 'confermare', 'Circa 30.000 € indicati da te; prima di eventuali incentivi.', 1000, 22000, 42000],
      ['fordValore', 'Valore di realizzo della vecchia diesel', '€', 'Auto', 'confermare', 'Quanto incassi dalla vecchia diesel del 2006 se la cambi: da confermare.', 100, 0, 2500],
      ['evManut', 'Manutenzione risparmiata', '€/anno per auto', 'Auto', 'stima', 'Tagliandi e riparazioni di una diesel del 2006 contro un\'elettrica nuova.', 50, 100, 600],
      ['evBollo', 'Bollo risparmiato', '€/anno per auto', 'Auto', 'confermare', 'Bollo di una diesel del 2006; le elettriche ne sono esenti per 5 anni. Da confermare sulla tua cartella.', 25, 0, 300],
      ['potKw', 'Aumento potenza contatore: quota annua', '€/kW/anno', 'Auto', 'stima', 'Quota potenza delle bollette (~2 €/kW/mese).', 1, 15, 40],
      ['potUnaTantum', 'Aumento potenza contatore: una tantum', '€/kW', 'Auto', 'stima', 'Contributo di adeguamento del distributore (stima).', 10, 50, 250]
    ];
    return R.map(([k, label, unit, grp, tipo, fonte, step, lo, hi]) => ({ k, label, unit, grp, tipo, fonte, step, lo, hi, base: b[k] }));
  }

  /* ============================== contesto: parametri risolti ============================== */
  function periodo(D, P) {
    const first = D.months[0] || '2020-01', last = D.months[D.months.length - 1] || '2026-01', p = P.range;
    /* consumi normalizzati: inverni 2023-24 e 2024-25 + estate (da maggio) 2026. L'inverno 2025-26 è del cantiere, le estati prima non avevano i condizionatori.
       Il gas usa i 12 mesi che finiscono a settembre 2024 e a settembre 2025 (le estati contano poco: cottura e acqua calda). */
    if (p === 'norm') return { from: first, to: last, norm: true, gasFrom: '2024-09', gasTo: '2025-09', label: 'normalizzati: inverni 2023-24 e 2024-25 + da maggio 2026' };
    if (p === 'storico') return { from: first, to: '2023-09', label: 'storico fino a set 2023' };
    if (p === 'set2025') return { from: '2024-10', to: '2025-09', label: '12 mesi fino a set 2025' };
    if (p === 'ultimi12') return { from: first, to: last, ultimi12: true, label: 'ultimi 12 mesi validi' };
    if (p === 'custom') return { from: P.rFrom || first, to: P.rTo || last, label: `dal ${P.rFrom || first} al ${P.rTo || last}` };
    return { from: first, to: last, label: P.escludi === false ? 'tutto lo storico' : 'tutti i mesi validi (esclusi lavori, Primo piano vuoto, estati senza condizionatori)' };
  }
  /* Parametri effettivi E = valori base → scenario di costo → detrazione scelta → valori modificati a mano (P.ov) */
  function risolvi(D, P) {
    const b = valoriBase(D, P), pr = PRESET[P.price] || PRESET.base, ov = P.ov || {}, E = Object.assign({}, b);
    E.luce = b.luce * pr.luce; E.gas = b.gas * pr.gas; E.diesel = b.diesel * pr.diesel; E.cess = pr.cess; E.rincaro = pr.rincaro; E.cessSera = b.cessSera * (pr.cess / 0.10);
    ['fissoFV', 'eurokwp', 'trifase', 'fissoBatt', 'eurobatt', 'hpCostUnica', 'hpCostPiano', 'wbCost', 'inverter'].forEach(k => { E[k] = b[k] * pr.costi; });
    const det = DETRAZIONI[P.detr]; if (det) { E.detrFV = det.pct; E.detrPdc = det.pct; E.detrWb = det.pct; }
    Object.assign(E, ov);
    E._origine = {}; Object.keys(ov).forEach(k => { E._origine[k] = 'modificato da te'; });
    return E;
  }

  /* ============================== consumi ============================== */
  function calProfilo(rs) { const by = Array.from({ length: 12 }, () => []); rs.forEach(r => by[+r.mese.slice(5) - 1].push(r.tot)); return by.map(a => (a.length ? avg(a) : null)); }
  function riempi(C, ref) {
    const idx = C.map((v, i) => (v !== null ? i : -1)).filter(i => i >= 0);
    if (idx.length === 12) return C;
    if (!idx.length) return ref ? ref.slice() : Array(12).fill(0);
    const s = sum(idx.map(i => C[i])), d = ref ? sum(idx.map(i => ref[i])) : 0, f = d > 0 ? s / d : null, mean = s / idx.length;
    return C.map((v, i) => (v !== null ? v : (f !== null ? f * ref[i] : mean)));
  }
  const normOk = m => (m >= '2023-10' && m <= '2024-04') || (m >= '2024-10' && m <= '2025-04') || (m >= '2026-05' && m <= '2026-09');
  function righePeriodo(D, P, rng, unit) {
    const val = righeValide(D, P, unit);
    if (rng.ultimi12) return val.slice(-12);
    if (rng.norm) return val.filter(r => normOk(r.mese));
    return val.filter(r => r.mese >= rng.from && r.mese <= rng.to);
  }
  function profiloLuce(D, P, rng, unit, mode) {
    if (unit === 'Primo piano' && mode === 'secondo') return profiloLuce(D, P, rng, 'Secondo piano', 'proprio');
    if (mode === 'spento') return Array(12).fill(D.spentoM);
    const all = D.byUnit[unit]; if (!all.length) return Array(12).fill(0);
    let rs = righePeriodo(D, P, rng, unit); if (!rs.length) rs = righeValide(D, P, unit).slice(-12); if (!rs.length) rs = all.slice(-12);
    /* mesi del calendario senza dati validi: si riempiono con la stagionalità dello storico del Secondo piano */
    const ref = unit === 'Secondo piano' ? (() => { const sv = righeValide(D, P, 'Secondo piano').filter(r => r.mese <= '2023-09'); return sv.length >= 12 ? riempi(calProfilo(sv), null) : null; })() : profiloLuce(D, P, rng, 'Secondo piano', 'proprio');
    return riempi(calProfilo(rs), ref);
  }
  function gasBase(D, P, E, rng, u) {
    const sec = P.gasSecMode === 'custom' ? (P.gasSecCustom || 0) : gasPeriodo(D, P, 'Secondo piano', rng);
    if (u === 'Secondo piano') return sec;
    const m = P.gasPriMode;
    if (m === 'custom') return P.gasPriCustom || 0;
    if (m === 'secondo') return sec;
    if (m === 'legna') return sec * E.legnaPct / 100;
    if (m === 'spento') return gasUltimi12(D, 'Primo piano');
    return gasPeriodo(D, P, 'Primo piano', rng);
  }
  /* Raffrescamento stimato (kWh per mese di giugno-settembre): consumo medio delle estati con i condizionatori meno quello delle estati prima.
     È un confronto tra anni diversi (meteo, presenza): un ordine di grandezza, non una misura. */
  function coolProfilo(D, P, rng) {
    const z = Array(12).fill(0); if (P.climaDal === 'nessuno') return z;
    const cd = climaDal(P), nopre = Object.assign({}, P, { climaDal: 'nessuno' });
    for (let m = 5; m <= 8; m++) {
      const rows = D.byUnit['Secondo piano'].filter(r => +r.mese.slice(5) === m + 1 && !motivoEsclusione(nopre, 'Secondo piano', r.mese));
      const post = rows.filter(r => r.mese >= cd && r.mese >= rng.from && r.mese <= rng.to).map(r => r.tot), pre = rows.filter(r => r.mese < cd).map(r => r.tot);
      if (post.length && pre.length) z[m] = Math.max(0, avg(post) - avg(pre));
    }
    return z;
  }
  function consumi(D, P, E, rng) {
    const on = { 'Primo piano': P.ap !== 'secondo', 'Secondo piano': P.ap !== 'primo' }, f = 1 - E.effic / 100, zero = Array(12).fill(0);
    const coolSec = coolProfilo(D, P, rng);
    const parts = UNITA.map(u => {
      const mode = u === 'Primo piano' ? P.primoMode : 'proprio', all = D.byUnit[u], rs = righePeriodo(D, P, rng, u), last = all.slice(-12), esclusi = all.filter(r => motivoEsclusione(P, u, r.mese));
      const C = on[u] ? profiloLuce(D, P, rng, u, mode).map(v => v * f) : zero;
      const cool = on[u] && (u === 'Secondo piano' || mode === 'secondo') ? coolSec.map(v => v * f) : zero;
      return { unit: u, on: on[u], mode, C, cool, annual: sum(C), nRange: rs.length, nEsclusi: esclusi.length, gas: on[u] ? gasBase(D, P, E, rng, u) * f : 0, cook: on[u] ? COOK : 0,
               real: { kwh: sum(last.map(r => r.tot)), n: last.length, gas: gasUltimi12(D, u) } };
    });
    return { rng, parts, C: zero.map((_, m) => sum(parts.map(p => p.C[m]))), cool: zero.map((_, m) => sum(parts.map(p => p.cool[m]))), annual: sum(parts.map(p => p.annual)), gasTot: sum(parts.map(p => p.gas)), cook: sum(parts.map(p => p.cook)) };
  }
  function contesto(D, P) { const E = risolvi(D, P), rng = periodo(D, P); return { D, P, E, rng, M: consumi(D, P, E, rng) }; }

  /* ============================== riscaldamento e auto ============================== */
  /* Il Primo piano oggi è vuoto e il suo impianto va rifatto da zero: le opzioni che lo riguardano (unica, due, primo) valgono solo «dopo la ristrutturazione». */
  const RISCALDAMENTO = {
    no: 'Caldaia a gas (come oggi)', secondo: 'Pompa di calore al Secondo piano (termosifoni)',
    unica: 'Dopo la ristrutturazione: una pompa per i due piani', due: 'Dopo la ristrutturazione: due pompe, una per piano', primo: 'Dopo la ristrutturazione: pompa solo al Primo piano'
  };
  /* Le pompe di calore sostituiscono parte del gas; i condizionatori (se P.climaInv === 'si') si prendono una quota del riscaldamento
     del Secondo piano che resta a gas dopo la pompa, a un COP più alto e in buona parte nelle ore di sole. */
  function riscaldamento(ctx, opt) {
    const { M, E, P } = ctx, on = M.parts.filter(p => p.on), cop = p => (p.unit === 'Primo piano' ? E.hpCopPrimo : E.hpCop);
    const repl = on.filter(p => (opt === 'unica' || opt === 'due') || (opt === 'secondo' && p.unit === 'Secondo piano') || (opt === 'primo' && p.unit === 'Primo piano'));
    const gasU = p => Math.max(0, p.gas - p.cook) * E.hpShare / 100, gasSmc = sum(repl.map(gasU));
    const nPompe = opt === 'no' ? 0 : (opt === 'due' ? repl.length : 1);
    const cost = opt === 'no' ? 0 : (opt === 'unica' && repl.length > 1 ? E.hpCostUnica : E.hpCostPiano * (opt === 'due' ? repl.length : 1));
    const pdc = nPompe ? sum(repl.map(p => gasU(p) * SMC_KWH * BOILER_EFF / cop(p))) + E.hpCool * (opt === 'due' ? repl.length : 1) : 0;
    let climaGas = 0, clima = 0;
    if (P && P.climaInv === 'si') {
      const sec = on.find(p => p.unit === 'Secondo piano');
      if (sec) { const heat = Math.max(0, sec.gas - sec.cook); let left = Math.max(0, heat - (repl.includes(sec) ? gasU(sec) : 0)); if (left < 1e-6) left = 0; climaGas = left * E.climaQuota / 100; clima = climaGas * SMC_KWH * BOILER_EFF / E.climaCop; }
    }
    return { opt, label: RISCALDAMENTO[opt], gasSmc, nPompe, cost, pdc, climaGas, clima, gasTot: gasSmc + climaGas, unitaSostituite: repl.map(p => p.unit) };
  }
  function costoAutoElettrica(ctx, nev, modo) {   // acquisto auto nel calcolo: solo sovrapprezzo, prezzo pieno (meno il realizzo della vecchia diesel) o escluso
    const E = ctx.E;
    if (!nev || modo === 'nessuno') return 0;
    if (modo === 'pieno') return nev * E.evPrezzo - Math.min(nev, 1) * E.fordValore;
    return nev * E.evExtra;
  }
  function costoCarburanteAuto(ctx) {   // spesa annua di gasolio (senza IVA) di UNA auto da sostituire: litri reali delle fatture se ci sono, altrimenti km × consumo
    const { D, P, E } = ctx, f = carburante(D, P);
    const litri = f.misurato ? f.litriAuto : E.evKm * E.iceL / 100;
    return { litri, euro: litri * E.diesel, misurato: f.misurato };
  }

  /* ============================== fotovoltaico: giornata tipo oraria ============================== */
  const TETTI = {
    piatto_sud: { n: 'Tetto piano, strutture 15° a sud', m2: 7.5 }, piatto_ew: { n: 'Tetto piano, est-ovest 10°', m2: 5.0 },
    falda_sud: { n: 'Falda a sud (~30°)', m2: 4.6 }, falda_sdso: { n: 'Falda sud-est/sud-ovest', m2: 4.6 }, falda_eo: { n: 'Falda est o ovest', m2: 4.6 }
  };
  const RESA_FALLBACK = [48, 65, 100, 117, 135, 143, 152, 135, 104, 74, 43, 35];
  const resa = (D, k) => (D.pvgis && D.pvgis.yield[k]) ? D.pvgis.yield[k] : RESA_FALLBACK.map(v => v * ({ piatto_sud: 0.94, piatto_ew: 0.82, falda_sud: 1, falda_sdso: 0.94, falda_eo: 0.78 }[k] || 1));
  function formaSole(D, k, m) {
    if (D.pvgis && D.pvgis.shape[k]) return D.pvgis.shape[k][m];
    const L = 12 + 3.2 * Math.sin(2 * Math.PI * (m - 2.2) / 12), a = 13.2 - L / 2;
    const w = Array.from({ length: 24 }, (_, h) => Math.max(0, Math.sin(Math.PI * (h + 0.5 - a) / L))), s = sum(w) || 1; return w.map(x => x / s);
  }
  const BASE_LOAD = [.022, .020, .019, .019, .020, .025, .050, .062, .040, .028, .025, .027, .040, .035, .028, .027, .032, .045, .070, .085, .090, .080, .060, .036];
  const PROFILI = { fuori: 0, misto: 0.6, casa: 1.3 };
  const formaGenerica = k => { const a = BASE_LOAD.map((v, h) => v * (h >= 9 && h <= 16 ? 1 + k : 1)), s = sum(a); return a.map(x => x / s); };
  const formaCasa = (D, P, m) => (P.profilo === 'curva' && D.curva) ? D.curva.shape[m] : formaGenerica(PROFILI[P.profilo] !== undefined ? PROFILI[P.profilo] : 0.6);
  const PDC_W = [1.6, 1.4, 1.0, 0.5, 0.1, 0.3, 0.6, 0.6, 0.2, 0.4, 1.0, 1.5];
  const EV_NIGHT = (() => { const a = [4, 4, 4, 4, 4, 3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 6, 8, 9, 9, 8], t = sum(a); return a.map(v => v / t); })();
  const formaAuto = E => { const d = E.evDay / 100; return EV_NIGHT.map((v, h) => (1 - d) * v + d * ((h >= 10 && h <= 16) ? 1 / 7 : 0)); };
  /* condizionatori in riscaldamento: quota 'climaGiorno' nelle ore di sole (10-16), il resto la sera (18-23) */
  const formaClima = E => { const d = E.climaGiorno / 100; return Array.from({ length: 24 }, (_, h) => d * ((h >= 10 && h <= 16) ? 1 / 7 : 0) + (1 - d) * ((h >= 18 && h <= 23) ? 1 / 6 : 0)); };
  /* raffrescamento estivo: ore calde, picco nel pomeriggio-sera */
  const FRESCO = (() => { const a = [.3, .3, .3, .3, .3, .3, .2, .2, .3, .5, .8, 1, 1.2, 1.4, 1.6, 1.6, 1.6, 1.5, 1.4, 1.3, 1.2, 1, .7, .5], t = sum(a); return a.map(v => v / t); })();
  const extraMese = (m, ex) => ({ pdc: ex.pdc * PDC_W[m] / sum(PDC_W), ev: ex.ev * GG[m] / 365.25, clima: (ex.clima || 0) * PDC_W[m] / sum(PDC_W) });
  function caricoOrario(ctx, C, m, ex) {
    const days = GG[m], ls = formaCasa(ctx.D, ctx.P, m), e = extraMese(m, ex), ps = formaGenerica(1.3), es = formaAuto(ctx.E), cs = formaClima(ctx.E);
    const cool = (ctx.P.profilo === 'curva' && ctx.D.curva) ? 0 : Math.min((ctx.M.cool && ctx.M.cool[m]) || 0, C[m]);   // con la curva reale il raffrescamento è già dentro
    return ls.map((s, h) => ((C[m] - cool) * s + cool * FRESCO[h] + e.pdc * ps[h] + e.ev * es[h] + e.clima * cs[h]) / days);
  }
  /* Fasce orarie italiane: F1 lun-ven 8-19; F2 lun-ven 7-8 e 19-23 + sabato 7-23; F3 notte, domeniche e festivi.
     Quota dell'energia di ogni ora che cade in F1/F2/F3 (giornata tipo senza distinzione feriali/festivi). */
  const QUOTE_FASCIA = (() => { const wf = (5 / 7) * 0.975, ws = 1 / 7, f1 = [], f2 = [], f3 = [];
    for (let h = 0; h < 24; h++) { const a = (h >= 8 && h < 19) ? wf : 0, b = ((h === 7 || (h >= 19 && h < 23)) ? wf : 0) + ((h >= 7 && h < 23) ? ws : 0); f1.push(a); f2.push(b); f3.push(Math.max(0, 1 - a - b)); }
    return { f1, f2, f3 }; })();
  function simula(ctx, kwp, batt, ex, C) {
    const { D, P, E } = ctx, y = resa(D, P.tetto), loss = 1 - E.ombre / 100; C = C || ctx.M.C;
    let prod = 0, direct = 0, deliv = 0, stored = 0, exp = 0, imp = 0, arb = 0; const pm = [], scM = [], batM = [], expM = [], impM = [], impF = [[], [], []];
    for (let m = 0; m < 12; m++) {
      const days = GG[m], pr = kwp * y[m] * loss, dP = pr / days, sh = formaSole(D, P.tetto, m), L = caricoOrario(ctx, C, m, ex), dC = sum(L);
      let sc = 0, need = 0; const fm = [0, 0, 0];
      for (let h = 0; h < 24; h++) { const pv = dP * sh[h], l = L[h]; sc += Math.min(pv, l); const nd = Math.max(l - pv, 0); need += nd; fm[0] += nd * QUOTE_FASCIA.f1[h]; fm[1] += nd * QUOTE_FASCIA.f2[h]; fm[2] += nd * QUOTE_FASCIA.f3[h]; }
      const surplus = dP - sc, st = Math.min(batt, surplus), dl = Math.min(st * 0.9, need), used = dl / 0.9;
      /* la batteria scaricata copre il fabbisogno serale/notturno: toglie energia soprattutto da F2 e F3 */
      const restoNeed = need - dl, k = need > 0 ? restoNeed / need : 0, impDay = dC - sc - dl;
      prod += pr; pm.push(pr); scM.push(sc * days); batM.push(dl * days); expM.push((surplus - used) * days);
      direct += sc * days; deliv += dl * days; stored += used * days; exp += (surplus - used) * days; imp += impDay * days; impM.push(impDay * days);
      for (let i = 0; i < 3; i++) impF[i].push(fm[i] * k * days);
      const extra = Math.max(0, Math.min(batt - used, surplus - used)); arb += extra * days;   /* energia che una batteria più grande potrebbe spostare alla sera per venderla */
    }
    return { pm, scM, batM, expM, impM, impF, prod, sc: direct, bat: deliv, exp, imp, loss: prod - direct - deliv - exp, cicli: batt > 0 ? stored / batt : 0, arbKwh: arb,
             arbGain: arb * Math.max(0, 0.9 * E.cessSera - E.cess) };
  }

  /* ============================== costi dell'impianto ============================== */
  function costoImpianto(E, kwp, batt) {
    if (!(kwp > 0)) return { tot: 0, fisso: 0, perKwp: 0, trifase: 0, batteria: 0 };
    const fisso = E.fissoFV, perKwp = kwp * E.eurokwp, trifase = kwp > 6 ? E.trifase : 0, batteria = batt > 0 ? E.fissoBatt + batt * E.eurobatt : 0;
    return { tot: fisso + perKwp + trifase + batteria, fisso, perKwp, trifase, batteria };
  }

  /* ============================== valutazione economica ============================== */
  /* cfg = {kwp, batt, riscaldamento:'no'|'unica'|'due'|'secondo'|'primo', nev, nBase?}
     Restituisce anche la 'catena' del calcolo: i passaggi che portano al guadagno, con le fonti. */
  function valuta(ctx, cfg) {
    const { P, E, M } = ctx, ris = riscaldamento(ctx, cfg.riscaldamento || 'no'), nev = cfg.nev || 0, H = Math.max(5, Math.min(30, Math.round(E.orizzonte)));
    const ev = nev * E.evKm * E.evKwh / 100 * E.evHome / 100, cons0 = M.annual, ex = { pdc: ris.pdc, ev, clima: ris.clima };
    const sim = cfg.kwp > 0 ? simula(ctx, cfg.kwp, cfg.batt || 0, ex) : null;
    const consTot = cons0 + ex.pdc + ex.ev + ex.clima, imp = sim ? sim.imp : consTot, exp = sim ? sim.exp : 0, used = sim ? sim.sc + sim.bat : 0;
    const nBase = cfg.nBase !== undefined ? cfg.nBase : Math.max(1, nev), carburanteAuto = costoCarburanteAuto(ctx);
    const arbRicavo = (P.venditaSera && sim) ? sim.arbGain : 0;
    const base = { luce: cons0 * E.luce, gas: M.gasTot * E.gas, fuel: nBase * carburanteAuto.euro, pub: 0, pot: 0 };
    const manutBollo = nev * (E.evManut + E.evBollo);
    const sc = { luce: imp * E.luce - exp * E.cess - arbRicavo, gas: (M.gasTot - ris.gasTot) * E.gas, fuel: (nBase - nev) * carburanteAuto.euro,
                 pub: nev * E.evKm * E.evKwh / 100 * (1 - E.evHome / 100) * E.evPublic - manutBollo, pot: ((nev > 0 ? 3 : 0) + (ris.nPompe ? 2 : 0)) * E.potKw };
    const baseTot = sum(Object.values(base)), scTot = sum(Object.values(sc)), net = baseTot - scTot;
    const cfv = costoImpianto(E, sim ? cfg.kwp : 0, cfg.batt || 0), fv = cfv.tot, invPdc = ris.cost, invWb = nev > 0 ? E.wbCost : 0, invCar = costoAutoElettrica(ctx, nev, P.carCost);
    const invPot = ((nev > 0 ? 3 : 0) + (ris.nPompe ? 2 : 0)) * E.potUnaTantum;
    const gross = fv + invPdc + invWb + invCar + invPot;
    const detrFV = fv * E.detrFV / 100, ct = P.incPdc === 'ct' ? invPdc * E.ctPct / 100 : 0, detrPdc = P.incPdc === 'detr' ? invPdc * E.detrPdc / 100 : 0, detrWb = invWb * E.detrWb / 100;
    const detrTot = detrFV + detrPdc + detrWb, netInv = gross - detrTot - ct;
    const otherSave = ris.gasTot * E.gas + nev * carburanteAuto.euro - sc.pub;
    const cash = [-gross]; let cum = -gross, payback = NaN;
    for (let yr = 1; yr <= H; yr++) {
      const g = Math.pow(1 - E.degrado / 100, yr - 1), bg = Math.pow(1 - E.batdeg / 100, yr - 1), r = Math.pow(1 + E.rincaro / 100, yr - 1);
      const used_y = sim ? sim.sc * g + sim.bat * g * bg : 0, exp_y = sim ? sim.exp * g : 0, imp_y = consTot - used_y;
      let cf = (cons0 - imp_y) * E.luce * r + exp_y * E.cess + arbRicavo + otherSave * r - sc.pot;
      if (yr <= 10) cf += detrTot / 10;
      if (yr === 1) cf += ct;
      if (yr === 12 && sim) cf -= E.inverter;
      const prev = cum; cum += cf; cash.push(cum);
      if (!isFinite(payback) && prev < 0 && cum >= 0) payback = yr - 1 + (-prev) / cf;
    }
    const risparmioAcquisto = sim ? (cons0 + ex.pdc + ex.ev + ex.clima - imp) * E.luce : 0;   // kWh non comprati dalla rete × prezzo
    const ricavoCessione = exp * E.cess;
    return { cfg, ris, nev, sim, consTot, imp, exp, used, base, sc, baseTot, scTot, net, gross, netInv, detrFV, detrPdc, detrWb, ct, detrTot, payback, gain: cum, cash, H,
             invest: { fv, pdc: invPdc, wb: invWb, auto: invCar, pot: invPot, fvDettaglio: cfv }, carburanteAuto, ev, pdcKwh: ris.pdc, climaKwh: ris.clima, climaGas: ris.climaGas, acquistoEuro: imp * E.luce, venditaEuro: ricavoCessione,
             cover: consTot > 0 ? used / consTot : 0, scRate: sim && sim.prod > 0 ? used / sim.prod : 0, nPan: Math.ceil(cfg.kwp / PANEL_KWP - 0.001),
             catena: { consumi: consTot, produzione: sim ? sim.prod : 0, usata: used, ceduta: exp, risparmioAcquisto, ricavoCessione, altriRisparmi: otherSave, costi: gross, incentivi: detrTot + ct, inverter: sim ? E.inverter : 0 } };
  }
  /* anno in cui la linea cumulata di b supera quella di a */
  function annoSorpasso(a, b) {
    let prev = b.cash[0] - a.cash[0]; if (prev >= 0) return 0;
    for (let i = 1; i < b.cash.length; i++) { const d = b.cash[i] - a.cash[i]; if (d >= 0) return i - 1 + (-prev) / (d - prev); prev = d; }
    return NaN;
  }

  /* ============================== stime separate: auto e pompa di calore (senza fotovoltaico) ============================== */
  function stimaAuto(ctx, nev) {
    const { E, P } = ctx, car = costoCarburanteAuto(ctx), kwhCasa = nev * E.evKm * E.evKwh / 100 * E.evHome / 100;
    const costo = costoAutoElettrica(ctx, nev, P.carCost), lordoAuto = nev * (P.carCost === 'pieno' ? E.evPrezzo : E.evExtra), realizzo = P.carCost === 'pieno' ? Math.min(nev, 1) * E.fordValore : 0;
    const wb = nev > 0 ? E.wbCost : 0, incWb = wb * E.detrWb / 100, pot = nev > 0 ? 3 * E.potUnaTantum : 0, potAnno = nev > 0 ? 3 * E.potKw : 0;
    const carburanteEvitato = nev * car.euro, manut = nev * E.evManut, bollo = nev * E.evBollo, elettricita = kwhCasa * E.luce, pubblica = nev * E.evKm * E.evKwh / 100 * (1 - E.evHome / 100) * E.evPublic;
    const risparmiAnno = carburanteEvitato + manut + bollo, costiAnno = elettricita + pubblica + potAnno, nettoAnno = risparmiAnno - costiAnno;
    const investimento = costo + wb + pot, netto = investimento - incWb;
    return { nev, litri: nev * car.litri, carburanteEvitato, manut, bollo, elettricita, pubblica, potAnno, risparmiAnno, costiAnno, nettoAnno, kwhCasa,
             costoAuto: lordoAuto, realizzo, wallbox: wb, incentivoWb: incWb, potUnaTantum: pot, investimento, investimentoNetto: netto, rientroSemplice: nettoAnno > 0 ? netto / nettoAnno : NaN,
             misurato: car.misurato };
  }
  function stimaPompa(ctx, opt) {
    const { E, P } = ctx, r = riscaldamento(ctx, opt), gasEvitato = r.gasSmc * E.gas, elettricita = r.pdc * E.luce, potAnno = r.nPompe ? 2 * E.potKw : 0, pot = r.nPompe ? 2 * E.potUnaTantum : 0;
    const inc = P.incPdc === 'ct' ? r.cost * E.ctPct / 100 : P.incPdc === 'detr' ? r.cost * E.detrPdc / 100 : 0, nettoAnno = gasEvitato - elettricita - potAnno, investimento = r.cost + pot, netto = investimento - inc;
    return { ...r, gasEvitato, elettricita, potAnno, nettoAnno, incentivo: inc, potUnaTantum: pot, investimento, investimentoNetto: netto, rientroSemplice: nettoAnno > 0 ? netto / nettoAnno : NaN };
  }

  /* Condizionatori usati anche d'inverno al posto di parte dei termosifoni (nessun investimento: ci sono già). Senza fotovoltaico, luce a prezzo pieno. */
  function stimaClima(ctx, opt) {
    const c2 = Object.assign({}, ctx, { P: Object.assign({}, ctx.P, { climaInv: 'si' }) }), r = riscaldamento(c2, opt || 'no'), E = ctx.E;
    const gasEvitato = r.climaGas * E.gas, elettricita = r.clima * E.luce, costoTermGas = E.gas / (SMC_KWH * BOILER_EFF), costoTermClima = E.luce / E.climaCop;
    return { quota: E.climaQuota, cop: E.climaCop, climaGas: r.climaGas, kwh: r.clima, gasEvitato, elettricita, nettoAnno: gasEvitato - elettricita, costoTermGas, costoTermClima };
  }

  /* ============================== sensibilità ============================== */
  /* Per ogni parametro del registro: guadagno a fine orizzonte se vale 'lo' e se vale 'hi', tutto il resto uguale, per DUE scenari insieme. */
  function sensibilitaAB(D, P, cfgA, cfgB, chiavi) {
    const ctx0 = contesto(D, P), reg = registro(D, P), gA = valuta(ctx0, cfgA).gain, gB = valuta(ctx0, cfgB).gain, out = [];
    reg.filter(r => !chiavi || chiavi.includes(r.k)).forEach(r => {
      const val = x => { const c = contesto(D, Object.assign({}, P, { ov: Object.assign({}, P.ov || {}, { [r.k]: x }) })); return [valuta(c, cfgA).gain, valuta(c, cfgB).gain]; };
      const [aLo, bLo] = val(r.lo), [aHi, bHi] = val(r.hi);
      out.push({ k: r.k, label: r.label, unit: r.unit, tipo: r.tipo, fonte: r.fonte, step: r.step, valore: ctx0.E[r.k], lo: r.lo, hi: r.hi,
        A: { lo: aLo - gA, hi: aHi - gA, swing: Math.abs(aHi - aLo) }, B: { lo: bLo - gB, hi: bHi - gB, swing: Math.abs(bHi - bLo) } });
    });
    return { baseA: gA, baseB: gB, voci: out.sort((a, b) => Math.max(b.A.swing, b.B.swing) - Math.max(a.A.swing, a.B.swing)) };
  }

  /* ============================== ottimizzatore: quale configurazione conviene, per ogni scenario d'uso ============================== */
  /* Scenari d'uso = come verrà usata la casa. Ogni scenario ha i suoi consumi: l'impianto ideale cambia con essi. */
  function scenariUso(P) {
    const nev = Math.max(1, +P.car || 0 ? +P.car : 1), pompa = P.heating && P.heating !== 'no' ? P.heating : 'secondo';
    return [
      { id: 'oggi', label: 'Solo Secondo piano, come oggi', ap: 'secondo', nev: 0, riscaldamento: 'no' },
      { id: 'auto', label: 'Secondo piano + auto elettrica', ap: 'secondo', nev, riscaldamento: 'no' },
      { id: 'pompa', label: 'Secondo piano + pompa di calore', ap: 'secondo', nev: 0, riscaldamento: 'secondo' },
      { id: 'auto_pompa', label: 'Secondo piano + auto + pompa', ap: 'secondo', nev, riscaldamento: 'secondo' },
      { id: 'due', label: 'Dopo la ristrutturazione: due appartamenti abitati', ap: 'both', nev: 0, riscaldamento: 'no' },
      { id: 'due_tutto', label: 'Dopo la ristrutturazione: due appartamenti + auto + pompa unica', ap: 'both', nev, riscaldamento: 'unica' }
    ].map(x => Object.assign(x, { pompaScelta: pompa }));
  }
  /* opts: {kwps, batts, budget (€ netti, 0 = nessun limite), maxKwp, scenari} */
  function ottimizza(D, P, opts) {
    opts = opts || {}; const base = contesto(D, P), maxK = opts.maxKwp || base.E.maxKwp || 10;
    const kwps = (opts.kwps || [3, 4, 4.5, 5, 6, 7, 8, 9, 10]).filter(k => k <= maxK + 1e-9), batts = opts.batts || [0, 5, 10, 15, 20], budget = opts.budget || 0;
    const scen = (opts.scenari || scenariUso(P)).map(sc => {
      const c = contesto(D, Object.assign({}, P, { ap: sc.ap, primoMode: sc.ap === 'both' && P.primoMode === 'spento' ? 'secondo' : P.primoMode })), celle = [];
      kwps.forEach(k => batts.forEach(b => { const r = valuta(c, { kwp: k, batt: b, riscaldamento: sc.riscaldamento, nev: sc.nev, nBase: Math.max(1, sc.nev) });
        celle.push({ kwp: k, batt: b, gain: r.gain, payback: r.payback, netInv: r.netInv, gross: r.gross, net: r.net, cover: r.cover, scRate: r.scRate, roi: r.netInv > 0 ? r.gain / r.netInv : NaN, ok: !budget || r.netInv <= budget }); }));
      const ammessi = celle.filter(x => x.ok), sorted = f => ammessi.slice().sort(f);
      const nessuno = valuta(c, { kwp: 0, batt: 0, riscaldamento: sc.riscaldamento, nev: sc.nev, nBase: Math.max(1, sc.nev) });
      return { sc, ctx: c, celle, consumi: c.M.annual + nessuno.L ? nessuno.consTot : c.M.annual, gas: c.M.gasTot - nessuno.ris.gasTot,
        migliore: sorted((a, b) => b.gain - a.gain)[0] || null, piuRapido: sorted((a, b) => (isFinite(a.payback) ? a.payback : 99) - (isFinite(b.payback) ? b.payback : 99) || b.gain - a.gain)[0] || null,
        migliorRoi: sorted((a, b) => (isFinite(b.roi) ? b.roi : -1) - (isFinite(a.roi) ? a.roi : -1))[0] || null };
    });
    /* configurazione robusta: vale per tutti gli scenari d'uso (minimo rimpianto = minima distanza dal meglio nel caso peggiore) */
    const chiave = x => x.kwp + '|' + x.batt, ids = new Map();
    scen.forEach(s => s.celle.forEach(x => { if (!x.ok) return; const k = chiave(x); if (!ids.has(k)) ids.set(k, { kwp: x.kwp, batt: x.batt, gains: [], rimpianti: [], netInv: x.netInv }); }));
    scen.forEach(s => { const best = s.migliore ? s.migliore.gain : 0; s.celle.forEach(x => { const o = ids.get(chiave(x)); if (o) { o.gains.push(x.gain); o.rimpianti.push(best - x.gain); } }); });
    const lista = [...ids.values()].filter(o => o.gains.length === scen.length).map(o => Object.assign(o, { media: avg(o.gains), peggiore: Math.min(...o.gains), maxRimpianto: Math.max(...o.rimpianti) }));
    return { scenari: scen, kwps, batts, budget, robusta: lista.slice().sort((a, b) => a.maxRimpianto - b.maxRimpianto)[0] || null, miglioreMedia: lista.slice().sort((a, b) => b.media - a.media)[0] || null,
             migliorePeggiore: lista.slice().sort((a, b) => b.peggiore - a.peggiore)[0] || null };
  }

  return { MESI, GG, UNITA, PANEL_KWP, PANEL_M2, COOK, SMC_KWH, BOILER_EFF, DETRAZIONI, PRESET, RISCALDAMENTO, TETTI, ESCLUSIONI, QUOTE_FASCIA,
    sum, avg, monthShift, num, normalizza, creaDati, motivoEsclusione, righeValide, gasSerie, gasMensile, gasFinestra, gasPeriodo, gasUltimi12, gasUltimiValidi, legnaDefault, storicoPrezzi, prezzoMensileLuce,
    prezzoLuceMarginale, prezzoGasMarginale, carburante, valoriBase, registro, periodo, risolvi, consumi, contesto,
    riscaldamento, costoAutoElettrica, costoCarburanteAuto, costoImpianto, resa, formaSole, formaCasa, formaAuto, extraMese, caricoOrario, formaClima, simula, valuta, annoSorpasso, stimaAuto, stimaPompa, stimaClima, CLIMA_DAL, climaDal, normOk, sensibilitaAB, scenariUso, ottimizza };
});
