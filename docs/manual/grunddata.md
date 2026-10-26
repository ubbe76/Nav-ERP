# Grunddata

**Inköp → Grunddata** i Nav|ERP (även under Försäljning och Artiklar) samlar de små register som delas av flera moduler: leveransvillkor, betalningsvillkor, speditörer, enheter, kollityper, förlustorsaker och kvalitetsorsaker. Varje post har en **kod** och en **benämning**, båda unika inom sitt register.

## Leveransvillkor

Villkor för hur gods levereras, t.ex. `DAP · Levererat angiven plats`.

Utöver kod och benämning har leveransvillkoren kolumnen **Förklaring** — en enkel beskrivning av vad villkoret innebär i praktiken (vem som betalar frakten och var risken går över). Texten redigeras i fältet **Förklaring (valfritt)** när du öppnar en post; ett tomt fält visas som `—` i listan. Förklaringen visas bara här i registret, inte på ordrar eller utskrifter.

- **Förifyll Combiterms** lägger in de elva standardvillkoren ur Combiterms 2020 (EXW, FCA, FAS, FOB, CFR, CIF, CPT, CIP, DAP, DPU, DDP) med svenska benämningar och färdiga förklaringar. Knappen är säker att trycka flera gånger — befintliga poster rörs aldrig, och egna ändringar av kod/benämning/förklaring bevaras.
- **+ Ny leveransvillkor** för egna villkor.

## Betalningsvillkor

T.ex. `30 · 30 dagar netto`. Skapa med **+ Ny betalningsvillkor**.

## Speditörer

Fraktbolag, t.ex. `DHL · DHL Freight`. Skapa med **+ Ny speditör**.

## Enheter

Måttenheter, t.ex. `st · Styck` och `kg · Kilogram`. Enheterna används som artiklarnas **grundenhet** och som **alternativa enheter** med omräkningsfaktor på artikelkortet (se kapitlet Artiklar).

- **Lägg till standardenheter** lägger in de vanligaste enheterna (st, kg, g, m, m2, m3, l, tim, förp). Knappen är säker att trycka flera gånger — befintliga poster rörs aldrig.
- Borttagning med **Flytta och ta bort** är till för att slå ihop dubbletter, t.ex. `ST` och `st`. Omräkningsfaktorn på varje rad rörs inte — bara enhetsreferensen byts — så flytten förutsätter att posterna faktiskt är samma enhet; att slå ihop olika enheter (t.ex. kg → g) gör att antal på befintliga rader läses fel.

## Kollityper

Förpackningstyper för artiklar, t.ex. `EUR · EUR-pall` och `KRT · Kartong`. Väljs på artikelkortets **Förpackning**-sektion tillsammans med **Antal per kolli** (se kapitlet [Artiklar](/hjalp/artiklar)).

- **Lägg till standardkollityper** lägger in de vanligaste (EUR-pall, halvpall, kvartspall, kartong, kolli, rullbur, låda, säck). Knappen är säker att trycka flera gånger — befintliga poster rörs aldrig.
- **+ Ny kollityp** för egna typer.
- Kollitypernas kolumn **Frakt** sammanfattar fraktuppgifterna; klicka på den för dialogen **Fraktuppgifter — <kollityp>**. Fälten är **Kolliart** (Paket eller Pall), **Längd (mm)**, **Bredd (mm)** och **Höjd (mm)** för full förpackning, **Egenvikt (kg)**, **Flakmeter** (tomt = transportören räknar från måtten) och **Stapelbar**. De används för kolliförslaget på en [försändelse](/hjalp/forsaljning#frakt). Standardkollityperna EUR-pall, halvpall och kvartspall får fotavtryck och egenvikt när de läggs in med **Lägg till standardkollityper**.
- **+ Ny enhet** för egna enheter.

## Förlustorsaker

Orsakerna man väljer när en offert markeras som **Förlorad** (se [Giltighetstid och förlorade offerter](/hjalp/forsaljning#giltighetstid-och-forlorade-offerter)), t.ex. `PRIS · Pris` och `LEVTID · Leveranstid`. Från början finns fem: Pris, Leveranstid, Valde annan leverantör, Projektet lades ned och Inget svar från kunden — de kan ändras och tas bort som alla andra poster.

- **+ Ny förlustorsak** för egna orsaker. **Kod** skrivs med versaler och siffror (högst 10 tecken), **Benämning** högst 100; båda måste vara unika.
- **Aktiv**: en inaktiv orsak kan inte väljas när en ny offert markeras som förlorad, men finns kvar på de offerter som redan använder den och i [Offertuppföljningen](/hjalp/rapporter#offertuppfoljning).
- Borttagning och flytt av kopplingar fungerar som för övriga register (se nedan); offerterna som använde orsaken flyttas då till den du väljer.

## Kvalitetsorsaker

Orsakerna som [avvikelser](/hjalp/kvalitet) och kassationer väljer ur, t.ex. `TRANSPORT · Transportskada` och `MATERIAL · Materialfel`. Registret finns som fliken **Kvalitetsorsaker** här och under **Kvalitet → Kvalitetsorsaker**. Kolumnerna och kryssrutorna **Kund**, **Leverantör**, **Intern** och **Kassation** styr var orsaken kan väljas: på kundreklamationer, leverantörsavvikelser, interna avvikelser och när kasserat antal rapporteras. Minst en måste vara ikryssad.

- **+ Ny kvalitetsorsak** för egna orsaker. **Kod** skrivs med versaler och siffror (högst 10 tecken), **Benämning** högst 100; båda måste vara unika. Att skapa och ändra orsaker kräver rättigheten **Kvalitet**.
- **Aktiv**: en inaktiv orsak kan inte väljas på nya avvikelser eller kassationer, men finns kvar där den redan används.
- **Ta bort** (administratörer) fungerar som för övriga register: används orsaken flyttas avvikelserna och kassationerna som använder den till en annan orsak du väljer under **Flytta kopplingarna till**.
- Finns minst en aktiv orsak med **Kassation** krävs en orsak vid kassation; annars anges den som fritext som tidigare. Se [Kvalitet](/hjalp/kvalitet#kassation-och-orsaker).

## Användning och regler

- Redigera en post genom att klicka på benämningen; dubbletter av kod eller benämning avvisas.
- Villkoren och speditören väljs på kund-/leverantörskortets flik **Villkor & frakt**; där anges också partens **kundnummer hos speditören**.
- Öppna en post och klicka **Ta bort** för att radera den. Används posten ingenstans visas frågan `Ta bort <namn>?` och posten tas bort.
- Används posten på andra rader visar dialogen `Posten används av:` med en rad per typ av koppling (t.ex. `3 kunder`, `2 leverantörer`, `5 kundorder`, `1 faktura`, `12 artiklar`, `4 orderrader`). Välj en annan post i samma register under **Flytta kopplingarna till** och klicka **Flytta och ta bort** — alla kopplingar flyttas till den valda posten i samma transaktion, sedan raderas originalet. Finns ingen annan post i registret visas i stället `Lägg först till den post kopplingarna ska flyttas till.`
- Redan utfärdade fakturor behåller det ursprungliga betalningsvillkorets text på utskriften (den stämplas vid fakturering), medan offert-/order-PDF:er visar den nya postens villkor efter en flytt.
- För speditörer flyttas även företagets eget fraktbolagskonto (Företagsinformation) med — om den nya speditören redan har ett eget konto tappas det borttagna kontot i stället.
- Rutinen används typiskt för att städa bort dubbletter som importen av kunder/leverantörer skapar automatiskt utifrån namn.
