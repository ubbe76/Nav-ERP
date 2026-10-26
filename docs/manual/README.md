# Användarmanual för Nav|ERP

<!-- Håll listan i takt med MANUAL_CHAPTERS i apps/web/lib/manual.ts. Webbplatsens
     synk (hemsida, npm run sync) varnar för kapitel som saknas här. -->

Manualen renderas i appen under **Hjälp** (`/hjalp`) och publiceras på
[naverp.se/hjalp](https://naverp.se/hjalp/) med sökning och innehållsförteckning.
Filerna i den här mappen är källan. Ändra här, så följer appen och webbplatsen med.

## Komma igång

- [Komma igång](https://naverp.se/hjalp/komma-igang/) ([källfil](komma-igang.md)) — Inloggning, navigering och hur listorna fungerar.

## Register

- [Artiklar](https://naverp.se/hjalp/artiklar/) ([källfil](artiklar.md)) — Artikelregistret, artikelkortet, struktur/beredning, import från CSV och artikelgrupper.
- [Grunddata](https://naverp.se/hjalp/grunddata/) ([källfil](grunddata.md)) — Leveransvillkor, betalningsvillkor och speditörer.
- [Importmallar](https://naverp.se/hjalp/importmallar/) ([källfil](importmallar.md), genererad av `npm run generate:import-templates -w apps/api`) — Excelmallar för alla importer, med förklaring och exempel per kolumn.
- [Personal & tid](https://naverp.se/hjalp/personal-tid/) ([källfil](personal-tid.md)) — Scheman, kalendrar, ATF och tidrapporter (personalregistret finns i Personal & lön).

## Flöden

- [Aviseringar](https://naverp.se/hjalp/aviseringar/) ([källfil](aviseringar.md)) — Det som behöver åtgärdas just nu, och den dagliga sammanställningen via e-post.
- [Inköp](https://naverp.se/hjalp/inkop/) ([källfil](inkop.md)) — Leverantörer med import från CSV, förfrågningar och inköpsorder med mottagning.
- [Försäljning](https://naverp.se/hjalp/forsaljning/) ([källfil](forsaljning.md)) — Kunder med import från CSV, offert, kundorder, leverans och fakturering.
- [Tillverkning](https://naverp.se/hjalp/tillverkning/) ([källfil](tillverkning.md)) — Tillverkningsorder, resurser, produktionsgrupper och efterkalkyl.
- [Stämpelterminalen](https://naverp.se/hjalp/terminal/) ([källfil](terminal.md)) — Närvarostämpling, orderstämpling och ATF-uttag i verkstaden.
- [Kvalitet](https://naverp.se/hjalp/kvalitet/) ([källfil](kvalitet.md)) — Reklamationer och avvikelser: kundreklamationer, leverantörsavvikelser och interna avvikelser med kostnader, genvägar och kvalitetsorsaker.
- [Personal & lön](https://naverp.se/hjalp/lon/) ([källfil](lon.md)) — Anställda, frånvaro, OB, attestering, löneunderlag och PAXml-export.
- [Lager](https://naverp.se/hjalp/lager/) ([källfil](lager.md)) — Saldon, transaktionslogg, lagerplatser, lagerflytt, inventering, justeringar och lagervärdering.
- [Ekonomi](https://naverp.se/hjalp/ekonomi/) ([källfil](ekonomi.md)) — Kontoplan, räkenskapsår och perioder, verifikat, huvudboken, momskoder, momsrapporten med fil till Skatteverket, importmoms, periodisk sammanställning, automatkontering, konteringsregler, balansräkning, resultaträkning och SIE-filer.
- [Rapporter](https://naverp.se/hjalp/rapporter/) ([källfil](rapporter.md)) — Leveransprecision, försäljnings- och inköpsstatistik, kassationsstatistik och kalkylutfall.

## System

- [System & inställningar](https://naverp.se/hjalp/system/) ([källfil](system.md)) — Användare, företagsinformation, nummerserier, integrationer och inställningar.
- [Drift & utveckling](https://naverp.se/hjalp/drift-utveckling/) ([källfil](drift-utveckling.md)) — Projektstruktur, manualens plats, testkörning och tekniska begränsningar.
