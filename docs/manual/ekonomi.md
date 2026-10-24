# Ekonomi

Ekonomimodulen i Nav|ERP är grundbokföringen: kontoplan, räkenskapsår med löpande perioder, manuella verifikat som bokförs till ett löpnummer, och den härledda huvudboken som visar ett valt kontos rörelser och saldon. Utöver de manuella verifikaten bokför **automatkonteringen** kund- och leverantörsfakturor åt dig, se [Automatkontering](#automatkontering) och [Konteringsregler](#konteringsregler) nedan. Hur en rad beskattas — svensk moms, EU-handel, export, omvänd moms eller import — avgörs av **momskoderna**, se [Momskoder](#momskoder), och **momsrapporten** sammanställer momsdeklarationens alla rutor per period och ger dig deklarationen som fil till Skatteverket, se [Momsrapport](#momsrapport) och [Importmoms](#importmoms). Har du sålt till företag i andra EU-länder sammanställer **Periodisk sammanställning** försäljningen per köparens momsnummer och ger dig filen till Skatteverket, se [Periodisk sammanställning](#periodisk-sammanstallning). Ovanpå grundbokföringen finns även de härledda ekonomirapporterna **balansräkning** och **resultaträkning**, se [Balansräkning](#balansrakning) och [Resultaträkning](#resultatrakning). Hela Ekonomi-sektionen kräver rättigheten **Ekonomi** i användarens behörighetsgrupp (administratörer har den alltid) — varken menyn eller sidorna visas för andra, se [Behörighetsgrupper](/hjalp/system#behorighetsgrupper).

Menyvalet **Ekonomi** öppnar modulens sida, där ekonomifunktionerna ligger grupperade i ett rutnät: **Bokföring** (Verifikat, Huvudbok, Anläggningsregister, Bokslut), **Rapporter** (Balansräkning, Resultaträkning, Momsrapport, **Periodisk sammanställning**, Avskrivningsplan) och **Grunddata** (Kontoplan, Räkenskapsår, Konteringsregler, **Momskoder**, Anläggningsgrupper, SIE-filer). Hela modulen kräver rättigheten **Ekonomi**.

## Kontoplan

**Ekonomi → Kontoplan** listar företagets konton med sök på kontonummer eller namn, och filtret **Endast aktiva**/**Visa alla (inkl. inaktiva)**. Varje konto har ett fyrsiffrigt **Nummer** och ett **Namn** — till skillnad från de flesta andra register i systemet är namnet inte unikt (BAS-kontoplanen återanvänder samma namn på flera konton), så det är bara numret som måste vara unikt.

Klicka **+ Nytt konto** för att lägga upp ett konto manuellt, eller på en rad i listan för att öppna den till redigering. Kontonumret går inte att ändra i efterhand — fältet är låst på redigeringsvyn — men namnet kan ändras, och kontot kan sättas **Aktiv**/**Inaktiv** när det inte längre ska gå att bokföra mot. Ett inaktivt konto avvisas om det används på en ny verifikatrad eller vid bokföring.

Varje konto har också en **Momsruta** — rutan i momsdeklarationen som kontots rörelser redovisas i (se [Momsrapport](#momsrapport)). Välj en ruta, **Ingen ruta** för konton som medvetet inte ska redovisas (t.ex. påminnelseavgifter och öres- och kronutjämning), eller **Ej angiven**. Ett nytt konto får **Förval enligt BAS**: konton ur BAS-urvalet får sin standardruta, övriga blir **Ej angiven**. Samma förval gäller konton som skapas av SIE-importen. Kolumnen **Momsruta** syns i listan (ett konto utanför kontoklass 3 och 26xx utan ruta visas med ett streck) och i CSV-exporten.

Knappen **Förifyll BAS-urval** lägger in ett standardurval ur den svenska BAS-kontoplanen i ett enda klick. Den är säker att klicka flera gånger — konton som redan finns (t.ex. ett omdöpt konto 1930) lämnas orörda, och notisen efteråt visar vad som hände: **"X skapade, Y fanns redan"** när något nytt lades till, eller **"Alla poster fanns redan"** om urvalet redan var på plats.

## Räkenskapsår och perioder

**Ekonomi → Räkenskapsår** listar företagets räkenskapsår, nyast först. **+ Nytt räkenskapsår** öppnar en dialog med **Namn**, **Startdatum** och **Slutdatum** — datumfälten är förifyllda med nästa kalenderår, men brutna räkenskapsår (som inte följer kalenderåret) går lika bra. Räkenskapsåret får inte överlappa ett befintligt år och kan inte läggas upp före ett stängt räkenskapsår. Så fort året skapas genererar systemet automatiskt en period per kalendermånad inom intervallet — det finns inget separat steg för att lägga upp perioder.

Klicka **Visa perioder** på ett räkenskapsår för att expandera periodtabellen: **Månad** och **Status** (**Öppen** eller **Låst**), med en åtgärdsknapp per rad.

- **Lås period** fryser perioden. Ett bekräftelsemeddelande beskriver konsekvensen innan låsningen genomförs: **bokföring på datum i den låsta perioden blockeras**, men **utkast går fortfarande att skapa och redigera** — låsningen stoppar bara steget där ett utkast bokförs (Bokför), inte själva utkastarbetet.
- **Lås upp period** öppnar en dialog med ett obligatoriskt fält, **Motivering** (minst 5 tecken). Upplåsning är tillåten så länge räkenskapsåret inte är stängt i bokslutet, men lämnas aldrig spårlös: motiveringen sparas tillsammans med vem som gjorde det i systemets granskningslogg, så det alltid går att se i efterhand varför en stängd månad öppnades igen.

Ett stängt räkenskapsår visas med **Stängt**, och i stället för **Lås upp period** står **Året är stängt** — perioderna öppnas bara genom att året öppnas igen under [Bokslut](#oppna-aret-igen). Länken **Bokslut** på varje räkenskapsår leder till årets bokslutsguide.

## Verifikat

**Ekonomi → Verifikat** listar företagets verifikat, med filter på **räkenskapsår**, **serie** och status (**Utkast**/**Bokförd**) samt fritextsökning på beskrivning. **+ Nytt verifikat** öppnar en dialog med **Serie**, **Datum** och **Beskrivning** — verifikatet skapas som ett utkast (visas som **Utkast** tills det bokförs) och du kommer direkt till verifikatkortet för att lägga till rader.

### Utkast

Ett utkasts huvud (**Serie**, **Datum**, **Beskrivning**) är redigerbart tills det bokförs — ändra fälten och klicka **Spara verifikat**. Varje rad har ett **Konto** (endast aktiva konton, visade som t.ex. **"1930 · Företagskonto"**), en valfri **Beskrivning** och beloppen **Debet**/**Kredit**: fyller du i det ena nollställs det andra automatiskt, eftersom en rad aldrig får bokföras med belopp i båda samtidigt. Rader läggs till, ändras och tas bort löpande via **Lägg till rad**/**Ändra**/**Ta bort** på radtabellen.

Under raderna visar en **balansindikator** löpande summeringar — **∑ Debet**, **∑ Kredit** och **Differens** — där differensen visas i rött så länge den inte är noll.

- **Bokför** är inaktiv tills verifikatet har **minst två rader** och differensen är **0**. Ett bekräftelsemeddelande — **"Verifikatet får nummer och låses. Fortsätt?"** — visas innan bokföringen genomförs. Verifikatet får då sitt löpnummer (t.ex. **A-2026-17**: serie, räkenskapsår och löpnummer), blir **Bokfört** och raderna blir skrivskyddade.
- **Ta bort** raderar utkastet permanent efter bekräftelse (**"Ta bort verifikatet permanent?"**). Bara utkast kan tas bort — ett bokfört verifikat är append-only och kan bara rättas genom en omföring.

### Bokfört

Ett bokfört verifikat visar sitt nummer, när och (om det går att slå upp) av vem det bokfördes, och raderna skrivskyddade.

- **Omför** skapar ett nytt utkast som speglar verifikatet med debet och kredit omvända rad för rad — samma konton och belopp, så källan och omföringen alltid nettar till noll tillsammans. Det nya utkastet bokförs inte automatiskt; du kommer direkt till det nya utkastet och bokför det separat via **Bokför** ovan, precis som vilket annat utkast som helst. En omföring visar **"Omföring av"** med en länk till källverifikatet på sitt eget kort, och källverifikatet visar i sin tur **"Omförd genom"** med en länk tillbaka (till **Utkast** om omföringen själv inte är bokförd än). Ett verifikat kan bara omföras en gång — så fort en omföring finns döljs **Omför**-knappen på källan. Verifikat som bokslutsguiden har bokfört (serie **BS**) kan inte omföras här — kortet visar i stället en länk **Bokslut 2024: Lagerförändring** (eller motsvarande steg), och steget görs om i guiden.

### Underlag på verifikat

Under raderna på verifikatkortet finns avsnittet **Underlag** för verifikatets underlag — kvitto, kontoutdrag, avtal eller liknande — som PDF eller inskannad bild (JPEG/PNG, max 20 MB per fil). Välj en eller flera filer så laddas de upp; klicka på filnamnet för att öppna en fil. Underlaget är **räkenskapsinformation** och sparas i sju år:

- På ett **utkast** kan en fil tas bort med **Ta bort** (om fel fil valdes). Tas utkastet bort försvinner dess underlag med det.
- På ett **bokfört** verifikat kan underlag bara **läggas till** (t.ex. ett kvitto som kom senare), aldrig tas bort.
- Varje uppladdning och borttagning loggas i händelseloggen, och för varje fil sparas en kontrollsumma (SHA-256, syns när du håller muspekaren över filnamnet).

Bokförda verifikat, deras rader och underlag är dessutom skyddade **i själva databasen**: ändringar och borttagningar avvisas där även om de inte kommer från appen — t.ex. från ett skript eller en direkt databasanslutning. Rättelser görs alltid med en omföring. Samma skydd gäller leverantörsfakturornas underlag efter attest och kundfakturornas arkiverade PDF:er.

Verifikat som skapas av automatkonteringen har sitt underlag på källdokumentet: leverantörsfakturans **Underlag** (se [Inköp](/hjalp/inkop#underlag-leverantorens-faktura)) respektive kundfakturans arkiverade PDF (se [Försäljning](/hjalp/forsaljning#arkiverad-faktura)).

| Status | Betydelse |
| --- | --- |
| Utkast | Redigerbart — serie, datum, beskrivning och rader kan ändras fritt, inget nummer är tilldelat än. |
| Bokförd | Låst och nummererat (t.ex. A-2026-17) — endast läsbart; en rättelse görs via **Omför**. |

### Skriv ut verifikatlista

Knappen **Skriv ut lista (PDF)** överst på verifikatlistan — och **Ladda ner CSV** bredvid, för samma urval i Excel-vänligt format — skriver ut exakt det urval som råkar vara satt på sidan just då — **räkenskapsår**, **serie**, **status** och fritextsökningen — så en filtrering på **Bokförd** innan utskrift ger en ren grundbok utan utkast. Under varje verifikat listas dess konteringsrader med konto, text, debet och kredit, följt av en summerad debet-/kreditsumma för verifikatet. Utkast tas med om filtret tillåter det och skrivs då ut med numret **Utkast** i stället för ett löpnummer. Långa texter radbryts inom sina kolumner, och blir utskriften längre än en sida numreras varje sida med **Sida X av Y** nere till höger — samma sidnumrering finns på systemets övriga interna utskrifter (huvudbok, balans- och resultaträkning, plocklista, räknelista, TO-utskrift och löneunderlag).

Utskriften skriver ingenting till databasen — den kan tas fram hur många gånger som helst, oavsett om perioden är låst eller ej.

## Huvudbok

**Ekonomi → Huvudbok** visar ett valt kontos alla bokförda rader inom ett datumintervall, med ingående och utgående saldo. Välj **Konto** i listan (t.ex. **"1930 · Företagskonto"**) och ange **Från**- och **Till**-datum — fälten är förifyllda med det senaste räkenskapsårets start- och slutdatum (innevarande kalenderår om inget räkenskapsår är upplagt än). Huvudboken hämtas om automatiskt så fort kontot eller intervallet ändras — det finns ingen separat sökknapp.

Radtabellen inleds med raden **Ingående saldo** — kontots saldo före **Från**-datumet; för ett resultatkonto (kontoklass 3–8) räknas det bara från början av det räkenskapsår **Från**-datumet ligger i, eftersom resultatkontona börjar om på 0 varje år (ligger datumet utanför alla räkenskapsår räknas hela historiken) — följt av varje bokförd rad på kontot i datumordning: **Datum**, **Verifikat** (en länk till verifikatkortet), **Text**, **Debet**, **Kredit** och det löpande **Saldo**t efter raden. Tabellen avslutas med raden **Utgående saldo**. Bara bokförda verifikat räknas med — ett utkast syns aldrig i huvudboken. **Ingående saldo** och **Utgående saldo** visas alltid, även när kontot saknar rader i det valda intervallet: ett konto med ett ingående saldo men ingen rörelse är inte ett tomt konto. Först när kontot varken har rader eller något saldo visas texten **"Inga bokförda rader på kontot i intervallet."**

### Alla konton

Fältet **Visa** växlar huvudboken mellan **Ett konto** (beskrivet ovan) och **Kontointervall**, som visar flera konton i samma körning. I intervalläget ersätts kontovalet av **Konto från** och **Konto till** — fyrsiffriga kontonummer, tomma fält betyder "alla konton" — och kryssrutan **Endast konton med rörelse eller saldo**, som döljer konton som varken har bokförda rader i perioden eller ett ingående saldo (ikryssad som standard). Ett balanskonto (kontoklass 1–2) med saldo men utan rörelse, t.ex. lagerkontot mellan två bokslut, visas alltså alltid. Resultatkonton (kontoklass 3–8) visas däremot bara när de har rörelse i intervallet — de för inget saldo vidare mellan åren. Precis som **Ett konto**-läget hämtas resultatet om automatiskt så fort ett fält ändras.

Resultatet visas som ett block per konto, i kontonummerordning, med samma tabellrader som enkontosläget: **Ingående saldo**, de bokförda raderna och **Utgående saldo**. Ingående och utgående saldo visas alltid, även för konton utan en enda rad i perioden. Ett inaktivt konto med bokförd historik går att välja i **Ett konto**-läget, märkt **"(inaktivt)"** i listan.

**Ladda ner PDF** och **Ladda ner CSV** finns i båda lägena och laddar ner exakt det som visas på skärmen (CSV i Excel-vänligt format, se [Rapporter](/hjalp/rapporter#exportera-till-excel-csv)).

## Balansräkning

**Ekonomi → Balansräkning** visar företagets tillgångar, eget kapital och skulder vid ett givet datum. Kräver rättigheten **Ekonomi**, som resten av modulen.

Sidan har ett enda styrfält, datumfältet **Per datum** — förifyllt med slutdatumet för det senaste räkenskapsåret. Rapporten hämtas om automatiskt så fort datumet ändras, det finns ingen sökknapp. Räkenskapsåret som datumet faller inom härleds och visas som **"Räkenskapsår 2026"** ovanför tabellen.

Tabellen har kolumnerna **Konto**, **Benämning** och **Belopp**. En kontorad länkar till huvudboken med kontot och räkenskapsårets start–**Per datum** förifyllt som intervall.

Raderna grupperas i två huvudrubriker:

- **TILLGÅNGAR** — grupperna **Anläggningstillgångar** och **Omsättningstillgångar**.
- **EGET KAPITAL OCH SKULDER** — grupperna **Eget kapital**, **Obeskattade reserver**, **Avsättningar**, **Långfristiga skulder** och **Kortfristiga skulder**.

Varje grupp listar sina konton och avslutas med en **"Summa …"**-rad.

Tecken: tillgångssidan visas **debetpositiv** — ackumulerade avskrivningar drar alltså ner sin anläggningsgrupp till det bokförda restvärdet — medan eget kapital och skulder visas **kreditpositiva**, så att t.ex. aktiekapital och leverantörsskulder redovisas som positiva belopp.

Under **Eget kapital** finns två rader som inte är konton utan **beräknade** av rapporten: **Årets resultat** och **Balanserat resultat (ej bokslutsfört)**. Rapporten räknar ut resultatet direkt ur kontoklass 3–8 och lägger det som eget kapital, så att balansräkningen går ihop även innan året är bokslutat. När bokslutets resultatöverföring är bokförd (se [Resultatöverföring](#resultatoverforing)) nettar kontoklass 3–8 till noll för året: **Årets resultat** blir 0,00 och resultatet visas i stället på konto 2099 under **Fritt eget kapital**. **Balanserat resultat (ej bokslutsfört)** är 0,00 så länge alla tidigare år är stängda.

Raden **Ej klassificerade konton** visas bara om något bokförts utanför kontoklass 1–8. En röd rad, **Differens**, visas bara om rapporten mot förmodan inte skulle balansera — det kan bara betyda att ett verifikat i sig är obalanserat.

Bara **bokförda** verifikat räknas med, ett utkast syns aldrig. Rapporten skriver ingenting — den kan köras hur många gånger som helst, även på ett datum i en låst period. **Ladda ner PDF** och **Ladda ner CSV** laddar ner rapporten.

## Resultaträkning

**Ekonomi → Resultaträkning** visar rörelsens intäkter och kostnader för en period. Fälten **Från** och **Till** är förifyllda med det senaste räkenskapsårets start- och slutdatum, och rapporten hämtas om automatiskt så fort något av dem ändras.

Raderna kommer i fast ordning med fem delsummerader: **Rörelseresultat**, **Resultat efter finansiella poster**, **Resultat före skatt**, **Årets resultat** och **Beräknat resultat**. Varje delsumma är en löpande summering av **alla** rader ovanför den, inte bara raderna sedan föregående delsumma.

Rapporten är **kreditpositiv**: intäkter visas som positiva belopp, kostnader som negativa, så den sista raden går att läsa direkt som resultatet. Sista raden (**Beräknat resultat**) är alltid samma belopp som balansräkningens **Årets resultat** för samma period.

När året är stängt i bokslutet (se [Resultatöverföring](#resultatoverforing)) visas överföringen på raden **Årets resultat (bokfört)** (konto 8999). **Årets resultat** visar då fortfarande årets resultat, medan **Beräknat resultat** blir 0,00 — resultatet ligger nu på konto 2099 under eget kapital.

Till skillnad från balansräkningen är resultaträkningen strikt periodavgränsad — intäkter och kostnader från tidigare år läcker aldrig in, även om de bokförts på samma konton.

Bara bokförda verifikat räknas med. Rapporten skriver ingenting och kan köras om obegränsat, även på låsta perioder. **Ladda ner PDF** och **Ladda ner CSV** laddar ner rapporten.

## Momskoder

**Ekonomi → Momskoder** visar de momskoder systemet bokför med. En **momskod** beskriver hur en rad beskattas: vilken sats den har, vilka konton den bokförs mot — och därmed vilken ruta i momsdeklarationen beloppen hamnar i — och vilken text fakturan ska bära. Koderna är en fast katalog, eftersom lagen avgör vilka som finns: du kan inte lägga upp nya koder eller ta bort någon. Det som är företagets eget är **kontonumren**, **fakturatexten**, **benämningen** och om koden är **Aktiv**.

Tabellen har kolumnerna **Kod**, **Benämning**, **Typ**, **Sats**, **Konton**, **Fakturatext** och **Status** (**Aktiv** eller **Inaktiv**, med knappen **Ändra** under). Under benämningen står hur många konteringsregler som använder koden. Kolumnen **Konton** visar varje konto koden bokför mot med sin roll (**Intäkt**, **Utg. moms**, **Ing. moms**, **Kostnad**, **Underlag** och **Motkonto**), kontots namn och den momsruta koden förväntar sig, t.ex. **Intäkt 3108 Försäljning varor till annat EU-land · ruta 35**. Under **Ändra** heter rollerna **Intäktskonto**, **Utgående moms**, **Ingående moms**, **Kostnadskonto**, **Underlag** och **Motkonto underlag**. Stämmer inte kontots momsruta i [kontoplanen](#kontoplan) med den koden förväntar sig visas en varning under kontot — **Kontot har ruta 05 men ska ha ruta 35**, **Kontot är inaktivt** eller **Kontot finns inte i kontoplanen** — och rörelserna skulle då hamna i fel ruta. Klicka på varningen för att öppna kontot i kontoplanen och rätta rutan.

| Kod | Benämning | Sats | Konton (förval) och ruta |
| --- | --- | --- | --- |
| MP25 | Moms 25 % | 25 % | Intäkt 3001 (05), utgående moms 2610 (10), ingående moms 2640 (48) |
| MP12 | Moms 12 % | 12 % | Intäkt 3002 (05), utgående moms 2620 (11), ingående moms 2640 (48) |
| MP6 | Moms 6 % | 6 % | Intäkt 3003 (05), utgående moms 2630 (12), ingående moms 2640 (48) |
| MF | Momsfri | 0 % | Intäkt 3004 (42) |
| EUV | Varor till annat EU-land | 0 % | Intäkt 3108 (35) |
| EUT | Tjänster till annat EU-land | 0 % | Intäkt 3308 (39) |
| EXV | Export av varor | 0 % | Intäkt 3105 (36) |
| EXT | Tjänster till land utanför EU | 0 % | Intäkt 3305 (40) |
| OB | Omvänd betalningsskyldighet, Sverige | 0 % | Intäkt 3231 (41) |
| IEUV25 / IEUV12 / IEUV6 | Inköp varor från EU 25 / 12 / 6 % | 25 / 12 / 6 % | Kostnad 4515 / 4516 / 4517 (20), utgående moms 2614 / 2624 / 2634 (30 / 31 / 32), ingående moms 2645 (48) |
| IEUT | Inköp tjänster från EU 25 % | 25 % | Kostnad 4535 (21), utgående moms 2614 (30), ingående moms 2645 (48) |
| IUTT | Inköp tjänster utanför EU 25 % | 25 % | Kostnad 4531 (22), utgående moms 2614 (30), ingående moms 2645 (48) |
| IOBV | Inköp varor i Sverige, omvänd betalningsskyldighet | 25 % | Kostnad 4415 (23), utgående moms 2614 (30), ingående moms 2647 (48) |
| IOBT | Inköp tjänster i Sverige, omvänd betalningsskyldighet | 25 % | Kostnad 4425 (24), utgående moms 2614 (30), ingående moms 2647 (48) |
| IUTV | Inköp varor utanför EU (importmoms separat) | 0 % | Inga egna konton — kostnadskontot följer konteringsreglerna och standardkontot |
| IMP25 / IMP12 / IMP6 | Importmoms 25 / 12 / 6 % | 25 / 12 / 6 % | Underlag 4545 / 4546 / 4547 (50), motkonto 4549 (ingen ruta), utgående moms 2615 / 2625 / 2635 (60 / 61 / 62), ingående moms 2645 (48) |

Koderna **EUV**, **EUT** och **OB** kräver köparens momsregistreringsnummer på fakturan. Momsrutorna 06, 07, 08, 37 och 38 (uttag, vinstmarginalbeskattning, frivillig skattskyldighet för hyra och trepartshandel) har ingen momskod — de redovisas via konton med rätt momsruta och manuella verifikat. Ruta 37 (mellanmans inköp vid trepartshandel) räknas som ett inköp, på samma sätt som ruta 20–24 och 50: ett belopp debiterat kontot ger ett positivt belopp i rutan. Ruta 38 räknas som försäljning.

**Ändra** öppnar en dialog med:

- **Benämning** — namnet som visas i listor och på fakturan.
- **Fakturatext** — skrivs en gång på fakturan under momssammanställningen när någon rad har koden. Tomt fält betyder ingen text. **Återställ till förvald text** sätter tillbaka katalogens text (t.ex. *Unionsintern leverans (artikel 138 i mervärdesskattedirektivet)* för **EUV**).
- **Aktiv** — en inaktiv kod kan inte väljas på nya fakturarader och leverantörsfakturor (ett dokument som redan har koden behåller den). **Moms 25 %**, **Moms 12 %**, **Moms 6 %** och **Momsfri** kan inte inaktiveras — Nav faller tillbaka på dem varje gång den väljer momskod själv — så reglaget är avstängt med texten *Används när Nav väljer momskod automatiskt — kan inte inaktiveras.* (API:t svarar *Momskoden används när Nav väljer momskod automatiskt och kan inte inaktiveras*). De andra koderna Nav väljer själv — **Varor till annat EU-land**, **Tjänster till annat EU-land**, **Export av varor**, **Tjänster till land utanför EU**, **Omvänd betalningsskyldighet, Sverige**, **Inköp varor från EU 25 %** och **Inköp varor utanför EU** — går att inaktivera, men dialogen varnar efter **Spara**, t.ex. *Momskoden EUV väljs automatiskt för varor till företagskunder i andra EU-länder — nya fakturarader för sådana kunder måste då få en momskod för hand*. Används koden av en konteringsregel får du också en varning (*Momskoden EUV är inaktiv men används av 1 konteringsregel*): regeln fortsätter gälla. I formuläret **Ny konteringsregel** listas bara aktiva koder (en regel som redan har en kod som inaktiverats behåller den i listan, märkt **(inaktiv)**), men API:t tar emot även en inaktiv kod på en regel.
- Ett konto per roll koden använder, som en lista över aktiva konton i formatet **"3108 Försäljning varor till annat EU-land"**. Överst i listan står **Återställ till standard (3108)**, som tar bort ett eget val. Under varje fält står den momsruta kontot förväntas ha.

Kontot måste finnas i kontoplanen och vara aktivt, och en kod får inte använda samma konto för två roller — då skulle bokföringen ta ut sig själv (**"Momskoden använder samma konto för två roller — bokföringen skulle ta ut sig själv. Välj olika konton."**). Efter **Spara** visar dialogen eventuella varningar — t.ex. att ett valt konto har en annan momsruta än koden förväntar sig — innan du stänger den. Varje ändring loggas i händelseloggen som **Momskod ändrad**.

Momsrapporten läser fortfarande **kontona**, inte fakturorna. Momskoden är bara vägen till rätt konto: ett manuellt verifikat på kontot 3108 hamnar i ruta 35 på samma sätt som en EU-faktura.

**Efter uppgraderingen.** Har företaget använt Nav före momskoderna finns tre saker att kontrollera. Öppna **Momskoder** och läs varningarna under kontona (**Kontot har ruta … men ska ha …**, **Kontot är inaktivt**, **Kontot finns inte i kontoplanen**) — konton som redan har bokförda verifikat har inte fått sin momsruta ändrad automatiskt, eftersom det skulle ändra redan deklarerade perioder, så rätta dem själv i kontoplanen. Öppna sedan [Momsrapport](#momsrapport) för en period och läs varningarna överst (**Konton utan momsruta**, **Momskoder med fel momsruta**, **Konteringsregler med fel momsruta**, **Redovisningskonton med momsruta**). Kontrollera till sist **Land** på varje utländsk leverantör (leverantörskortet, fliken **Allmänt**): Nav har försökt läsa landet ur leverantörens momsnummer och annars ur dess IBAN, och står det **SE** på en leverantör som egentligen finns i utlandet får fakturorna svensk moms i stället för omvänd moms. Leverantörskortet varnar när valutan inte är SEK men landet är Sverige.

## Momsrapport

**Ekonomi → Momsrapport** sammanställer momsdeklarationens alla rutor för en vald redovisningsperiod, direkt ur de bokförda verifikaten. Välj **Räkenskapsår** och **Period** — en enskild månad (t.ex. **Januari 2026**), ett helt kalenderkvartal (t.ex. **Kvartal 1 2026 (jan–mar)**) eller hela räkenskapsåret (**Helår 2026**; ett brutet räkenskapsår heter t.ex. **Helår 2025/2026**). Kvartal erbjuds bara när räkenskapsåret innehåller kvartalets alla tre månader. Rapporten hämtas om automatiskt så fort periodvalet ändras, och bara **bokförda** verifikat räknas — utkast syns aldrig.

Under periodvalet står inställningen **Redovisningsperiod för moms** (**Månad**, **Kvartal** eller **Helår**) — den period Skatteverket har bestämt för företaget. Den styr vilken period sidan förväljer när du öppnar den: den senast avslutade månaden eller det senast avslutade kvartalet, eller — för **Helår** — det senast avslutade räkenskapsåret (det pågående året är inte slut och har inget att deklarera än; finns inget avslutat år väljs det pågående). Ändra den och klicka **Spara**.

Rutorna visas grupperade som Skatteverkets blankett, med kolumnerna **Ruta**, **Beskrivning**, **Belopp** och **Att deklarera (hela kr)**. Rutor utan belopp visas nedtonade — de finns kvar så att tabellen är hela deklarationen.

| Grupp | Rutor | Hämtas från |
| --- | --- | --- |
| A · Momspliktig försäljning eller uttag exklusive moms | 05, 06, 07, 08 | Konton med momsruta **05**–**08** |
| B · Utgående moms på försäljning eller uttag i ruta 05–08 | 10, 11, 12 | Konton med momsruta **10**/**11**/**12** (25/12/6 %) |
| C · Momspliktiga inköp vid omvänd skattskyldighet | 20, 21, 22, 23, 24 | Konton med momsruta **20**–**24** |
| D · Utgående moms på inköp i ruta 20–24 | 30, 31, 32 | Konton med momsruta **30**/**31**/**32** (25/12/6 %) |
| H · Import | 50, 60, 61, 62 | Konton med momsruta **50** (beskattningsunderlag) och **60**/**61**/**62** (utgående moms 25/12/6 %) |
| E · Försäljning m.m. som är undantagen från moms | 35, 36, 37, 38, 39, 40, 41, 42 | Konton med momsruta **35**–**42** |
| F · Ingående moms | 48 | Konton med momsruta **48** |
| G · Moms att betala eller få tillbaka | 49 | (10 + 11 + 12 + 30 + 31 + 32 + 60 + 61 + 62) − 48 — negativt belopp visas som **"Moms att få tillbaka"** |

Momsrutorna läser **kontona**, inte fakturorna — varje konto redovisas i den **Momsruta** som är angiven i [kontoplanen](#kontoplan), så även ett manuellt verifikat räknas med. Vilket konto en fakturarad bokförs mot avgörs av dess [momskod](#momskoder). Avyttringsverifikat från [Anläggningsregistret](#avyttring) (serie AV) utesluts ur rapporten på samma sätt som momsomföringarna — försäljningen av en tillgång räknas via kundfakturan, inte via avyttringsverifikatet.

**Hela kronor.** Deklarationen anges i hela kronor. **Belopp** visar öresbeloppen, så att rapporten stämmer mot huvudboken, och **Att deklarera (hela kr)** visar närmaste hela krona per ruta (en halv krona avrundas bort från noll). Ruta 49 räknas på de **avrundade** rutorna — den summa Skatteverket kontrollerar.

**Varningar.** Överst på rapporten visas varningar när något gör att rutorna inte stämmer:

- **Konton utan momsruta** — ett intäktskonto (kontoklass 3), ett momskonto (26xx) eller ett inköpskonto (44xx/45xx) har rörelser i perioden men momsrutan **Ej angiven**. Beloppen ingår inte i någon ruta förrän rutan är angiven; länken öppnar kontot i kontoplanen.
- **Momskoder med fel momsruta** — en aktiv momskods konto har en annan momsruta i kontoplanen än koden förväntar sig (t.ex. *Momskod EUV: konto 3108 har ruta 05 men ska ha ruta 35*), eller kontot saknas. Länkarna öppnar **Momskoder** respektive kontot.
- **Konteringsregler med fel momsruta** — en konteringsregel ersätter momskodens eget konto, så kontot den pekar på måste hamna i rätt ruta: för en regel för exakt en utrikes- eller omvänd momskod kodens egen ruta (intäktskontot för försäljningskoder, kostnadskontot för omvänd moms på inköp); för **Moms 25 %**, **Moms 12 %** och **Moms 6 %** ett intäktskonto med ruta **05**, för **Momsfri** ruta **42**, och för **Alla momskoder** ruta **05** eller **42**; och kostnadskontot i en regel för svensk moms, **Inköp varor utanför EU** eller **Alla momskoder** får inte ha någon av inköpsrutorna **20–24**, **37** eller **50** — då skulle ett vanligt inköp deklareras som ett EU-, omvänd-moms- eller importinköp. Varje konto i en regel är en egen rad i varningen (*Konteringsregel 100 Maskiner / Alla momskoder: intäktskonto 3108 har ruta 35 men ska ha ruta 05 eller ruta 42*). Länkarna öppnar **Konteringsregler** respektive kontot.
- **Redovisningskonton med momsruta** — **Redovisningskonto för moms** eller **Öres- och kronutjämning** (under [Konteringsregler](#standardkonton)) har en momsruta som momsomföringen tömmer. Rapporten visas ändå, men **Bokför momsomföring** är avstängd tills kontot har en annan ruta eller ett annat konto har valts. Länkarna öppnar kontot i kontoplanen och **Konteringsregler**.

**Ladda ned fil till Skatteverket** skapar momsdeklarationen som en XML-fil för periodens rutor i hela kronor (ISO-8859-1, filnamnet **momsdeklaration-ÅÅÅÅMM.xml** där ÅÅÅÅMM är periodens sista månad — för ett kvartal eller helår alltså den sista månaden i det). Filen laddar du själv upp i Skatteverkets e-tjänst för momsdeklaration via fil; Nav skickar ingenting. Rutor utan belopp utelämnas utom ruta 49. Filen kräver att företagets organisationsnummer är ifyllt med tio siffror under **System → Företagsuppgifter** — annars visas **"Företagets organisationsnummer saknas eller har inte tio siffror — ange det under Företagsuppgifter."** med länken **Öppna Företagsuppgifter**.

Knappen **Bokför importmoms** bokför importmomsen på ett tullbeslut, se [Importmoms](#importmoms).

### Bokför momsomföring

Kortet **Momsomföring** visar alla momskonton som rört sig i perioden — konton med momsruta 10, 11, 12, 30, 31, 32, 48, 60, 61 eller 62 — med deras **Ruta**, **Debet**, **Kredit** och **Netto**: underlaget för omföringen. Under tabellen visas hur omföringen avslutas: ruta 49 **i hela kronor** på **Redovisningskonto för moms** (kredit när moms ska betalas, debet vid moms att få tillbaka) och den **öresdifferens** som hela-kronorsavrundningen lämnar på **Öres- och kronutjämning**.

Knappen **Bokför momsomföring** öppnar en bekräftelsedialog som visar exakt vad som kommer att bokföras, rad för rad med **Debet**, **Kredit** och **Summa**: varje momskonto nollställs för perioden, ruta 49 bokförs på redovisningskontot och öresdifferensen på öres- och kronutjämning. Verifikatet bokförs i serien **M** (Momsredovisning) med **periodens sista dag** som datum. Redovisningskontot och öres- och kronutjämning får inte själva ha en momsruta som omföringen tömmer — annars är knappen avstängd (rapporten visar varningen **Redovisningskonton med momsruta**, se ovan) och omföringen nekas även via API:t (**"Redovisningskontot för moms eller Öres- och kronutjämning har en momsruta som momsomföringen tömmer — välj ett konto utan momsruta under Konteringsregler."**). Själva rapporten och filen till Skatteverket påverkas inte.

Arbetsgången är: **granska rapporten → Bokför momsomföring → lås perioden** under Räkenskapsår. Är periodens sista månad redan låst nekas omföringen — lås upp månaden (med motivering) först. En period utan momsrörelser går inte att omföra (**"Ingen moms att omföra i perioden."**).

När omföringen är bokförd visar kortet **Deklarerad** med en länk till verifikatet (**Verifikat M-…**), och perioden kan inte deklareras igen — inte heller som del av ett kvartal eller helår som överlappar den. Rapportens rutor står stilla efter omföringen: själva M-verifikatet räknas aldrig med i rutorna, så deklarationsunderlaget går alltid att ta fram igen i efterhand.

**Ångra:** öppna M-verifikatet via länken och använd **Omför** (se [Bokfört](#bokfort) ovan), och bokför omföringsutkastet. Perioden blir då deklarerbar igen, och en ny momsomföring tar med både de ursprungliga rörelserna och allt som bokförts i perioden sedan dess. Betalningen av momsskulden mot skattekontot (och en eventuell flytt av momsfordran till 1650) bokförs manuellt som vanligt verifikat.

## Importmoms

Vid import av varor från ett land utanför EU (momskoden **IUTV**, *Inköp varor utanför EU (importmoms separat)*) bokförs ingen moms på leverantörsfakturan. Importmomsen är en egen händelse som bokförs på **tullbeslutet**: beskattningsunderlaget är tullvärdet + tull + frakt till gränsen enligt tullbeslutet — inte leverantörens fakturabelopp — och momsen kvittas direkt som ingående moms. Importmomsen kopplas därför inte till någon leverantörsfaktura.

Knappen **Bokför importmoms** på [Momsrapport](#momsrapport) öppnar en dialog med:

- **Datum** — förvalt till i dag; verifikatet får det datumet och datumet måste ligga i en öppen period.
- **Beskrivning** — t.ex. *Tullbeslut 2026-10-01* (obligatorisk).
- En eller flera rader med **Momssats** (**25 %**, **12 %** eller **6 %** — koderna **IMP25**, **IMP12** och **IMP6**) och **Beskattningsunderlag** (större än 0), eftersom ett tullbeslut kan ha flera satser. **+ Lägg till rad** lägger till en rad, **Ta bort rad** tar bort en.

Medan du fyller i visar dialogen **Kontering**: per rad **debet** underlagskontot (4545/4546/4547, ruta 50) och **kredit** motkontot 4549 (ingen ruta) med beskattningsunderlaget, samt **debet** ingående moms 2645 (ruta 48) och **kredit** utgående moms 2615/2625/2635 (ruta 60/61/62) med underlaget gånger satsen, avrundat till ören. Kontona kommer från momskoderna — de ändras under [Momskoder](#momskoder). Finns ingen aktiv importmomskod visar dialogen **"Det finns ingen aktiv importmomskod. Aktivera Importmoms 25, 12 eller 6 % under Momskoder."**

Klicka **Bokför importmoms** så bokförs ett verifikat i serien **IM** (Importmoms) och du kommer direkt till verifikatet. Ladda upp tullbeslutet som underlag där, se [Underlag på verifikat](#underlag-pa-verifikat). Importmomsen hamnar i momsrapporten via kontonas momsrutor: underlaget i ruta 50, utgående moms i ruta 60/61/62 och ingående moms i ruta 48 — de två momsbeloppen tar ut varandra i ruta 49.

## Periodisk sammanställning

**Ekonomi → Periodisk sammanställning** sammanställer företagets försäljning av varor och tjänster till företag i andra EU-länder, per köparens momsnummer — det underlag Skatteverket kräver för all EU-försäljning. Sammanställningen bygger på de **utfärdade** kund- och kreditfakturorna, hämtas om automatiskt när perioden ändras och skriver ingenting.

**Period.** Välj **Period** — en **Månad** (t.ex. **Oktober 2026**) eller ett **Kvartal** (t.ex. **Kvartal 3 2026 (jul–sep)**); en annan avgränsning än exakt en kalendermånad eller ett kalenderkvartal nekas (**"Perioden måste vara exakt en kalendermånad eller ett kalenderkvartal."**). Förvald är **föregående månad**. Varor till företag i andra EU-länder ska redovisas per kalendermånad; kvartal gäller bara om Skatteverket har beviljat det eller om du bara säljer tjänster — sidan påminner om det under periodvalet.

**Vad som räknas.** Fakturor med fakturadatum i perioden. Rader med momskoden **Varor till annat EU-land** hamnar i kolumnen **Varor** och rader med **Tjänster till annat EU-land** i kolumnen **Tjänster** (se [Momskoder](#momskoder)); kreditfakturor räknas negativt. Beloppen summeras per **köparens momsnummer** så som det står på fakturan — versaler, bara bokstäver och siffror, med landsprefixet (Grekland skrivs **EL**; saknar en äldre faktura prefixet läggs kundens land till). Ett momsnummer förekommer bara en gång, även om flera kunder eller fakturor har det. Beloppen anges i hela kronor, avrundade per rad. **Trepartshandel** är alltid tom — Nav har ingen momskod för den.

Tabellen har kolumnerna **Momsnummer**, **Kund** (länk till kundkortet), **Varor**, **Trepartshandel**, **Tjänster** och **Fakturor** (länkar till fakturakorten), med en rad **Summa** längst ner.

**Avstämning mot momsrapporten.** Kortet **Avstämning mot momsrapporten** ställer sammanställningen mot ruta 35 (varor) och ruta 39 (tjänster) i [momsrapporten](#momsrapport) för samma period, med kolumnerna **Ruta**, **Bokfört**, **Sammanställning** och **Skillnad**. Avstämningen görs i **ören**: radernas ören mot rutans ören, så att varken avrundning hittar på en skillnad eller en liten skillnad döljs. Stämmer de exakt står det **Stämmer**; annars visas skillnaden med ören. Varningen **Skillnad mot bokföringen** visar beloppen med ören — t.ex. *Varor: sammanställningen 1 234,50 kr, bokfört i ruta 35 1 234,80 kr (skillnad -0,30 kr) — typiskt ett manuellt verifikat eller en faktura med fel momskod*. Orsaken är oftast ett manuellt verifikat på 3108 eller 3308, en faktura med fel momskod eller en faktura som lämnats utanför sammanställningen för sitt momsnummer.

**Varningar.** Överst visas varningar, med länkar till de fakturor de gäller:

- **Saknat momsnummer** — fakturor med EU-försäljning saknar köparens momsregistreringsnummer och kommer inte med i sammanställningen.
- **Ogiltigt momsnummer** — numret är inte ett momsnummer från något annat EU-land än Sverige (landskoden först, Grekland **EL**); fakturorna kommer inte med. Ett momsnummer från en annan medlemsstat än kundens eget land räknas som giltigt.
- **Kund utanför EU** — en kund med EU-momskod har ett land som inte är ett EU-land; kontrollera momskoden på fakturorna.
- **Skillnad mot bokföringen** — sammanställningen och ruta 35/39 stämmer inte, se avstämningen ovan.

**Kontaktuppgifter i filen.** Kortet **Kontaktuppgifter i filen** visar **Företagets momsregistreringsnummer** (från **System → Företagsuppgifter**, länken **Öppna Företagsuppgifter**) och har fälten **Kontaktperson** (högst 35 tecken), **Telefon** (högst 17 tecken: siffror med bindestreck efter riktnumret, t.ex. 08-1234567, eller inledande + för ett utlandsnummer) och **E-post** (frivillig). **Spara** lägger dem i inställningarna, där de följer med varje fil; rättigheten **Ekonomi** räcker. Uppgifterna kontrolleras redan vid **Spara** mot det filen kan bära — namnet mot *Kontaktpersonens namn får vara högst 35 tecken och bara innehålla tecken som finns i ISO-8859-1 (latin1) — Skatteverkets fil kan inte bära andra tecken* och telefonnumret mot *Telefonnumret ska vara siffror med högst ett bindestreck efter riktnumret (till exempel 08-123456), eller börja med + för ett utländskt nummer — högst 17 tecken utan mellanslag*. Saknas något filen kräver visar kortet **Filen kan inte skapas än:** med vad som återstår — **Företagets momsregistreringsnummer saknas eller har fel form**, **Kontaktperson saknas** eller **Telefon saknas eller har fel form**.

**Ladda ned fil** skapar Skatteverkets fil för periodisk sammanställning (SKV 574008; ISO-8859-1, filnamnet **PeriodiskSammanstallning** följt av periodens kod — **PeriodiskSammanstallning2610.txt** för oktober 2026, **PeriodiskSammanstallning26K3.txt** för tredje kvartalet). Filen laddar du själv upp i Skatteverkets e-tjänst; Nav skickar ingenting. Filen har företagets och kontaktpersonens uppgifter överst och en rad per köpare; en kolumn som inte används lämnas tom, och en köpare som nettar till noll får **0**. Går filen inte att skapa visas orsaken under knappen:

- **"Ingen EU-försäljning i perioden — ingen periodisk sammanställning ska lämnas."** — inga rader, ingen fil.
- **"Alla EU-fakturor i perioden saknar giltigt momsnummer — rätta kunderna."** — det finns EU-försäljning att redovisa, men ingen faktura har ett giltigt köparnummer, så filen skulle bli tom. Rätta kundernas VAT-nummer (se varningarna ovanför tabellen) och ladda ned igen.
- **"Uppgifter saknas för filen — företagets momsregistreringsnummer (Företagsuppgifter) samt kontaktpersonens namn och telefonnummer måste vara ifyllda."**
- **"Ett belopp är för stort för filen (högst 12 tecken inklusive minustecken) — kontrollera fakturorna i perioden."**

Sidan kräver rättigheten **Ekonomi**, som resten av modulen.

## SIE-filer

**Ekonomi → SIE-filer** hanterar utbyte av bokföring med revisor eller ett annat bokföringsprogram, i det svenska SIE-formatet (typ 4). Kräver rättigheten **Ekonomi**, som resten av modulen.

### Exportera

Välj **Räkenskapsår** och klicka **Ladda ner SIE-fil**. Filen innehåller räkenskapsårets kontoplan, ingående och utgående saldon, årets resultat per konto och **samtliga bokförda verifikat** med sina konteringsrader. Utkast följer aldrig med. Finns ett föregående räkenskapsår tas även dess datumintervall med som jämförelseår, vilket många mottagande program vill ha.

Filen skrivs i teckenkodningen **CP437**, som SIE-standarden kräver — öppnar du den i en vanlig textredigerare kan svenska tecken därför se konstiga ut, medan bokföringsprogrammet läser den rätt. Filändelsen är `.se` och filnamnet innehåller företagsnamn och räkenskapsårets datum.

### Importera ingående balanser

Rutinen är till för att **flytta in bokföring från ett annat system**: den läser filens ingående balanser (`#IB`) och bokför dem som ett verifikat i serien **I** (Ingående balanser), daterat räkenskapsårets första dag. Därefter syns de som vilken bokföring som helst — i huvudboken, i balansräkningen och i en senare SIE-export.

Välj **Räkenskapsår**, välj filen och klicka **Importera**. Resultatet visar vilket verifikat som skapades, hur många konton som fick en ingående balans, och vilka konton som lades upp automatiskt.

Regler att känna till:

- **Konton som saknas skapas automatiskt** med namnet ur filens `#KONTO`-rader.
- **Balanserna måste summera till noll.** Gör de inte det avbryts importen med differensen angiven — systemet uppfinner aldrig en motpost, eftersom det skulle dölja ett fel i källdatat.
- **Filens räkenskapsår måste stämma** med det du valt, annars avbryts importen. Annars skulle fjolårets balanser kunna hamna på fel år utan att någon märkte det.
- **Bara en gång per räkenskapsår.** Ett andra försök avvisas — annars skulle varje balans dubbleras.
- **Finns det redan bokförda verifikat före räkenskapsårets början avvisas importen.** Då räknas den ingående balansen fram automatiskt ur den befintliga bokföringen, och en import ovanpå skulle dubblera den.
- Är räkenskapsårets första period låst går det inte att bokföra — lås upp den under **Räkenskapsår** först.
- Ingenting skrivs förrän hela filen är godkänd: en avvisad import lämnar inga spår.

## Anläggningsregister

**Ekonomi → Anläggningsregister** håller företagets anläggningstillgångar (maskiner, inventarier, bilar, datorer, byggnader) och bokför de planenliga avskrivningarna. Registret bokför **inte** själva anskaffningen — den är redan bokförd via leverantörsfakturan eller ett manuellt verifikat på tillgångskontot. Registret bokför avskrivningar och avyttringar, i verifikatserien **AV** (Anläggningar), som skapas automatiskt första gången den behövs.

### Anläggningsgrupper

**Ekonomi → Anläggningsgrupper** är grunddata: varje grupp bär fem konton — **Tillgångskonto** (t.ex. 1220), **Ack. avskrivningar** (1229), **Avskrivningskostnad** (7830), **Vinst vid avyttring** (3973) och **Förlust vid avyttring** (7970) — samt **Förvald nyttjandetid (månader)**, som förifylls på nya anläggningar i gruppen. Tillgångskonto, ack-konto och kostnadskonto måste vara tre olika konton. När någon anläggning i gruppen har bokförd avskrivning eller en **Ingående avskrivning** är de tre kontona låsta i gruppens dialog (*"Tillgångskonto, ack-konto och kostnadskonto är låsta — gruppen har bokförd eller ingående avskrivning"*) — de bär redan bokförda belopp; vinst- och förlustkonto, namn och nyttjandetid kan fortfarande ändras.

Knappen **Förifyll BAS-grupper** skapar fem grupper ur BAS-kontoplanen: *Maskiner och andra tekniska anläggningar* (1210/1219/7830, 60 mån), *Inventarier och verktyg* (1220/1229/7830, 60 mån), *Bilar och andra transportmedel* (1240/1249/7830, 60 mån), *Datorer* (1250/1259/7830, 36 mån) och *Byggnader* (1110/1119/7820, 600 mån = 2 % per år). Grupper som redan finns hoppas över. Saknas ett av kontona i kontoplanen avbryts förifyllningen — kör **Förifyll BAS-urval** under Kontoplan först. Nyttjandetiderna är bara förval; ändra dem efter företagets egna bedömningar. En grupp kan tas bort så länge den saknar anläggningar.

### Ny anläggning

**+ Ny anläggning** på registersidan: **Benämning**, **Grupp** (sätter förvald nyttjandetid), **Anskaffningsdatum**, **Avskrivningsstart** (förval anskaffningsmånaden — kan flyttas till en senare månad), **Anskaffningsvärde**, **Restvärde** (förval 0; lika med anskaffningsvärdet för t.ex. mark som inte skrivs av), **Nyttjandetid (månader)**, valfri **Leverantörsfaktura** (länk till köpet) och **Anteckning**. Anläggningen får ett nummer i serien **AN-**.

**Anläggningar anskaffade före Nav:** för en tillgång som köptes innan företaget började använda Nav ligger den hittills ackumulerade avskrivningen redan i den ingående balansen (se [SIE-filer](#sie-filer)). Fyll i den som **Ingående avskrivning** (beloppet) och **Avskriven t.o.m. månad** (sista månaden som beloppet täcker). Båda fälten fylls i tillsammans eller inte alls. Anskaffningsvärde, Anskaffningsdatum och Nyttjandetid anges som de ursprungligen var; den första körningen fortsätter från månaden efter **Avskriven t.o.m. månad** och skriver inte av det som redan ligger i balansen. Beloppet får inte överstiga det avskrivningsbara underlaget (anskaffningsvärde − restvärde), och månaden måste vara en passerad månad inom nyttjandetiden, inte före avskrivningsstart. Tillgångskortet visar **Ingående avskrivning** i översikten, och ackumulerad avskrivning och bokfört värde räknar med den. Fälten låses, precis som anskaffningsvärdet, när den första avskrivningen är bokförd.

Avskrivningen är linjär på hela månader: *(anskaffningsvärde − restvärde) / nyttjandetid* per månad, och sista månaden tar resten så summan blir exakt. Tillgångskortet visar den bokförda och den planerade avskrivningen per månad, ackumulerad avskrivning och bokfört värde — allt beräknat ur de bokförda raderna, inget lagrat saldo.

**Ändra i efterhand:** benämning och anteckning kan alltid ändras. När den första avskrivningen är bokförd låses **Anskaffningsdatum**, **Anskaffningsvärde**, **Avskrivningsstart** och **Grupp** (de bestämmer vad som redan bokförts). **Nyttjandetid** och **Restvärde** kan ändras även då — ändringen är framåtverkande: det återstående underlaget fördelas jämnt på de återstående månaderna, och inget bokfört rörs. Nyttjandetiden kan inte göras kortare än att det finns minst en månad kvar efter den senast bokförda (*"Nyttjandetiden kan inte vara kortare än de månader som redan bokförts"*). En anläggning utan bokförda avskrivningar kan tas bort med **Ta bort**; numret återanvänds inte.

### Bokför avskrivningar

Kortet **Avskrivningar** överst på registersidan visar **Senast bokförd t.o.m.** med länk till verifikatet. Välj **T.o.m. månad** (förval förra månaden; en månad som inte passerat kan inte väljas) och klicka **Bokför avskrivningar**. Dialogen visar exakt vad som bokförs: per grupp (kostnadskonto / ack-konto, belopp), per anläggning (vilka månader, belopp), verifikatdatumet (månadens sista dag) och totalsumman. **Bokför avskrivningar** i dialogen bokför ett verifikat i serien **AV** med en debetrad per kostnadskonto och en kreditrad per ack-konto, och meddelar *"Avskrivningar bokförda — Verifikat AV-…"*.

Körningen fyller på **alla saknade månader** från varje anläggnings avskrivningsstart t.o.m. vald månad — en ny anläggning som registrerats i efterhand kommer alltså ikapp automatiskt. Månader som ligger i **låsta** perioder bokförs ändå, på verifikatdatumet i den öppna månaden; dialogen markerar dem *hämtas ikapp*. Är perioden för verifikatdatumet själv låst nekas körningen (*"Perioden för det här datumet är låst för bokföring"*) — lås upp månaden under Räkenskapsår. Finns inget att bokföra visas *"Inget att bokföra — alla månader t.o.m. vald månad är redan avskrivna"*. Har ett av gruppens konton avaktiverats i kontoplanen varnar dialogen (*"Ett av gruppens konton är inaktivt i kontoplanen — aktivera kontot eller byt konto på gruppen"*, med konto och grupp) och körningen nekas tills kontot är aktivt igen. Rutinen per månad är: **Bokför avskrivningar → granska → lås perioden** under Räkenskapsår. Listan under kortet visar tidigare körningar med verifikat, belopp och om de är omförda.

### Ångra senaste körning

**Ångra senaste körning** på kortet omför den senaste körningens verifikat — omföringen bokförs i serien AV **på körningens eget datum**, så månaden nettar till noll — och körningens månader blir obokförda igen; nästa körning bokför dem på nytt (med då gällande nyttjandetid och restvärde). Bara den **senaste** körningen kan ångras; behöver flera körningar backas, ångra dem bakifrån en i taget. En körning som hör till en avyttring kan inte ångras, och därmed inte heller någon körning före en avyttring — avyttringen är slutgiltig. Är körningens period låst nekas ångringen tills perioden låsts upp; ett stängt räkenskapsår kan därför aldrig ändras den här vägen.

**Omför** på verifikatkortet är avstängt för registrets AV-verifikat (*"Verifikatet hör till anläggningsregistret — ångra via Anläggningsregistret"*): en omföring utanför registret skulle nolla huvudboken medan registret fortfarande räknar månaderna som bokförda. Verifikatkortet länkar i stället till registret.

### Avyttring

På tillgångskortet, kortet **Avyttring**, klickar du **Avyttra**. Välj **Typ** — **Försäljning** eller **Utrangering** — och **Datum** (inte i framtiden). En försäljning har dessutom **Försäljningspris exkl. moms** och **Mellankonto**. Klicka **Visa kontering** för att se exakt vad som bokförs, och **Bokför avyttring** för att bokföra.

Avyttringen bokar först avskrivning t.o.m. avyttringsmånaden (om det saknas månader — dialogen visar dem), och därefter ett avyttringsverifikat i serien **AV** som tar bort anskaffningsvärdet (kredit på tillgångskontot) och de ackumulerade avskrivningarna (debet på ack-kontot). Vid försäljning debiteras **Mellankontot** med försäljningspriset och mellanskillnaden mot bokfört värde bokförs som **vinst** (kredit på gruppens vinstkonto) eller **förlust** (debet på gruppens förlustkonto). En utrangering bokar hela bokförda värdet som förlust. Tillgången får status **Avyttrad** och kortet länkar till avyttringsverifikatet. Avyttringen kan **inte ångras**; en felaktig avyttring rättas med ett manuellt verifikat och en ny tillgång.

**Mellankontot och kundfakturan.** Försäljningen faktureras till kunden på vanligt sätt, och fakturans intäktsrad ska konteras på **samma konto** som mellankontot — ge den fakturerade artikeln (eller dess artikelgrupp) en [konteringsregel](#konteringsregler) på det kontot. Fakturan krediterar då mellankontot och avyttringsverifikatet debiterar det, så kontot nettar till noll och vinst eller förlust blir kvar på resultatkontona. Förvalet är gruppens vinstkonto (normalt 3973).

**Momsen.** Avyttringsverifikatet räknas aldrig i [momsrapporten](#momsrapport) — bara kundfakturan gör det. För att försäljningens underlag ska hamna i **ruta 05** måste mellankontot ha **Momsruta 05** i [kontoplanen](#kontoplan). Saknar mellankontot ruta 05 visar dialogen varningen *"Mellankontot saknar momsruta 05 — försäljningen kommer inte med i ruta 05 i momsrapporten"*. Observera att **alla** bokningar på kontot då räknas i ruta 05 — även en manuellt bokförd vinst på 3973. Den som vill hålla 3973 rent väljer ett eget mellankonto med ruta 05.

### Avskrivningsplan

**Ekonomi → Avskrivningsplan** visar, per räkenskapsår (välj under **Räkenskapsår**) och grupp, varje anläggnings **IB ansk.**, **Anskaffningar**, **Avyttringar**, **UB ansk.**, **IB ack.**, **Årets avskr.**, **Avskr. avyttrat**, **UB ack.** och **Bokfört värde**, med summor per grupp och en rad **Summa alla grupper**. **Ladda ner PDF** ger rapporten på företagets A4-mall; **Exportera CSV** ger en rad per anläggning med alla kolumner. En avskrivning hör till det datum körningens verifikat har — en körning t.o.m. juni bokförd den 30 juni räknas i juni, en ikappbokning av januari gjord i juni räknas i juni — precis som i huvudboken.

En anläggnings **Ingående avskrivning** (avskrivningar som bokfördes före Nav och ingår i den ingående balansen) visas alltid i kolumnen **IB ack.** (ingående ackumulerad avskrivning), aldrig som årets avskrivning.

Kortet **Avstämning mot huvudboken** jämför, per konto, registrets anskaffningsvärde med tillgångskontots saldo och registrets ackumulerade avskrivningar med ack-kontots saldo per räkenskapsårets sista dag (samma siffror som balansräkningen). Stämmer allt visas *"Registret stämmer mot huvudboken."*; annars en varning per konto: *"Registret stämmer inte mot konto 1220 …: huvudbok …, register … (skillnad …)"*. En skillnad betyder typiskt att ett köp bokförts på tillgångskontot utan att läggas upp i registret (eller tvärtom), att köpet bokförts på fel konto, eller att ett manuellt verifikat rört 12xx-kontona.

## Årsbokslut

**Ekonomi → Bokslut** är guiden som stänger ett räkenskapsår. Välj **Räkenskapsår** överst — förvalt är det äldsta öppna året vars slutdatum har passerat. Finns inget bokslut för året ännu väljer du **Bokslutsdatum** (förval årets sista dag; datumet måste ligga i årets sista månad) och klickar **Starta bokslut**. Bokslutsdatumet kan ändras i kortet **Bokslutsdatum** (**Spara bokslutsdatum**) tills det första steget har bokförts — även avskrivningarna i steg 3 räknas, eftersom deras verifikat dateras på bokslutsdatumet.

Guiden består av sex steg som alla syns samtidigt, och du kan lämna sidan och fortsätta senare. Varje steg har en status: **Klar**, **Ej gjord**, **Inaktuell** (bokföringen har ändrats efter steget — gör om det) eller **Spärrad** (en kontroll i steg 1 hindrar bokföring). Alla bokslutsverifikat bokförs i serien **BS** (Bokslut) och dateras på bokslutsdatumet. Ett steg kan göras om hur många gånger som helst innan året stängs: blir resultatet detsamma bokförs ingenting, annars omförs det förra stegverifikatet och ett nytt bokförs. Listan **Bokslutsverifikat** längst ned visar allt guiden har bokfört.

### Kontroller

Steg 1 visar spärrar och varningar. **Spärrar** hindrar stegen 2–5: verifikatutkast i året (bokför eller ta bort dem — de första 20 listas som länkar), att föregående räkenskapsår inte är stängt, att bokslutsmånaden är låst (knappen **Lås upp period** öppnar den vanliga upplåsningen med motivering) och att bokslutsdagen inte har passerat. **Varningar** hindrar inget men ska granskas:

- Momsen är inte omförd för alla månader. Omför momsen för december (och övriga månader) *innan* året stängs — efteråt kan den inte bokföras i året.
- Kund- eller leverantörsreskontran stämmer inte mot kundfordrings- respektive leverantörsskuldkontot per räkenskapsårets sista dag (även när bokslutsdatumet ligger tidigare). Vanliga orsaker: ett manuellt verifikat på kontot, ett standardkonto som bytts under året, eller fakturor från innan automatkonteringen.
- Anläggningsregistret stämmer inte mot tillgångskontona (samma avstämning som i [Avskrivningsplan](#avskrivningsplan)).
- Intäkter på konton utan momsruta.
- Lagerkontots saldo stämmer inte med den bokförda lagervärderingen.

### Lagerförändring

Steg 2 värderar lagret per bokslutsdatumet med vald **Värderingsmetod** (**Standardpris**, **Senaste inköp** eller **Vägt snitt**; förvalt är metoden från förra årets bokslut, annars **Vägt snitt**). **Visa lagervärdering** visar lagervärdet, saldot på lagerkontot, skillnaden och exakt den kontering som bokförs. **Bokför lagerförändring** bokför skillnaden mellan lagervärdet och kontot **Lager** mot **Lagerförändring** (se [Standardkonton](#standardkonton)). Artiklar utan pris räknas som 0 och visas som en varning. Har företaget inget lager — lagervärdet och saldot på **Lager** är båda 0 — blir steget **Klar** utan verifikat, även om kontona **Lager** och **Lagerförändring** saknas i kontoplanen.

Lagret värderas som det var registrerat vid bokslutsdagens slut — inventera och rapportera alla lagerrörelser före årsskiftet. Inkurans och pågående tillverkning bokförs med ett eget manuellt verifikat på egna konton (t.ex. 1469 eller 1440); bokför du på själva lagerkontot efter steget blir steget **Inaktuell** och en omkörning rättar kontot mot lagervärderingen.

Lagervärdet beror på lagerloggen per bokslutsdatumet: sätter du i efterhand ett standardpris på en artikel som tidigare saknade pris kan värdet ändras — kör i så fall om steget (**Bokför lagerförändring** igen) så rättas bokföringen.

### Avskrivningar i bokslutet

Steg 3 kör anläggningsregistrets avskrivningar t.o.m. bokslutsmånaden, daterade på bokslutsdatumet, i registrets serie **AV**. **Visa avskrivningar** visar vad som saknas och **Bokför avskrivningar** bokför det. Är allt redan bokfört står steget som **Klar**. En avskrivningskörning ångras i [Anläggningsregistret](#angra-senaste-korning).

### Periodiseringar

Steg 4 bokför upplupna och förutbetalda kostnader och intäkter. Lägg till en rad per post med **Lägg till rad**: **Typ** (**Förutbetald kostnad**, **Upplupen intäkt**, **Upplupen kostnad** eller **Förutbetald intäkt**), **Balanskonto** (förval 1790 respektive 2990), **Resultatkonto**, **Belopp** och **Text**. Konteringen visas under raderna. **Bokför periodiseringar** bokför alla rader i ett verifikat på bokslutsdatumet och **återför dem automatiskt** med ett spegelvänt verifikat på nästa räkenskapsårs första dag. Finns inget nästa räkenskapsår skapas det. Är första perioden i nästa räkenskapsår låst visar steget en varning — återföringen kan inte bokföras förrän perioden låsts upp under [Räkenskapsår och perioder](#rakenskapsar-och-perioder). Har året inga periodiseringar klickar du **Inga periodiseringar**. Ändrar du raderna och bokför igen omförs både periodiseringen och återföringen innan de nya bokförs. Periodiseringar påverkar inte momsrapporten. En identisk omkörning vägras om ett av kontona i de bokförda raderna har inaktiverats sedan dess — aktivera kontot igen, eller ändra raderna.

### Resultatöverföring

Steg 5 visar årets resultat (kontoklass 3–8) och bokför det mot eget kapital med **Bokför resultatöverföring**: en vinst bokförs som debet 8999 och kredit 2099, en förlust tvärtom. Stegen 2–4 måste vara gjorda först. Efter överföringen visar balansräkningen **Årets resultat** 0,00 och resultatet på 2099, och resultaträkningen visar överföringen på raden **Årets resultat (bokfört)**. Bokförs något i året efteråt blir steget **Inaktuell** — gör om det. Är resultatet 0,00 står steget som **Klar** utan verifikat. Saknas konto 8999 eller 2099 i kontoplanen (eller är något av dem inaktivt) visar steget en hänvisning till [Kontoplan](#kontoplan) i stället för konteringen — lägg upp kontona där, t.ex. med **Förifyll BAS-urval**.

### Stäng året

Steg 6 visar de spärrar som återstår, varningarna och en avstämning av nästa års ingående balanser mot årets utgående. Den kan bara skilja om ingående balanser har importerats till nästa år via SIE — omför i så fall det importerade verifikatet först. Avstämningen läser bara serien **I** i nästa år. Skulle omföringen hamna i ett senare år (bokslutet görs sent), ändrar du omföringsutkastets datum till ett datum i nästa räkenskapsår innan du bokför det — eller rättar ingående balansen med ett manuellt verifikat i serien **I** i nästa år. En rättelse i en annan serie tar inte bort spärren. Året kan stängas tidigast dagen efter räkenskapsårets sista dag, även om bokslutsdatumet ligger tidigare. Finns varningar kryssar du i **Jag har granskat varningarna**. **Stäng räkenskapsåret** låser alla perioder och markerar året som stängt. Därefter kan inga verifikat bokföras i året — inte heller från ett skript eller direkt i databasen — och perioderna kan inte låsas upp.

### Öppna året igen

På ett stängt år finns **Öppna året igen**, som kräver en **Motivering**. Resultatöverföringen omförs och bokslutsmånaden låses upp; övriga månader förblir låsta och kan låsas upp en i taget under [Räkenskapsår och perioder](#rakenskapsar-och-perioder). Lagerförändring, avskrivningar och periodiseringar ligger kvar. Året kan inte öppnas om nästa räkenskapsår är stängt eller om en vinstdisposition är bokförd — ångra den först (så länge dispositionen är bokförd är **Öppna året igen** avstängd). Händelsen loggas i händelseloggen.

### Vinstdisposition

På ett stängt år bokför du årsstämmans beslut: ange **Stämmodatum** (efter räkenskapsårets slut, i ett öppet räkenskapsår) och eventuell **Utdelning (kr)**, klicka **Visa kontering** och sedan **Bokför vinstdisposition**. Saldot på 2099 flyttas till 2091 Balanserad vinst eller förlust, och utdelningen bokförs på 2898 Outtagen vinstutdelning. Överstiger utdelningen det fria egna kapitalet visas en varning. Utbetalningen av utdelningen bokförs som ett vanligt verifikat. **Ångra** omför dispositionen på stämmodatumet.

## Automatkontering

Kund- och leverantörsfakturor bokförs automatiskt — du behöver aldrig knappa in ett verifikat för hand för dem. Detsamma gäller kund- och leverantörsreskontrans betalningar, kundens betalningspåminnelser och momsrapportens momsomföring. Verifikaten hamnar i egna serier som skapas automatiskt första gången de behövs (ingen separat uppsättning krävs):

- **F** (Kundfakturor) — bokförs när en faktura **utfärdas**. Se [Bokföring av fakturan](/hjalp/forsaljning#bokforing-av-fakturan) i kapitlet Försäljning för hela konteringen, kreditfaktura och vad som händer om bokföringen inte går att genomföra.
- **L** (Leverantörsfakturor) — bokförs när en leverantörsfaktura **godkänns**, och en **omföring** bokförs i samma serie när en godkänd faktura **avbryts**. Se [Bokföring av leverantörsfakturan](/hjalp/inkop#bokforing-av-leverantorsfakturan) i kapitlet Inköp.
- **K** (Kundreskontra) — bokförs när en **betalning registreras** (bankbeloppet mot betalkontot, kundfordran mot det som stängs, mellanskillnaden mot öres-/kronutjämning vid en avskrivning inom toleransen), när en **betalningspåminnelse** skickas med avgift ikryssad (avgiften mot kundfordran respektive kontot för påminnelseavgifter) och som en **omföring** när en betalning **makuleras**. En ren kvittning mellan en fakturas och en kreditfakturas öppna poster flyttar inget saldo och bokför därför inget verifikat — se [Kvittning av kreditfaktura](/hjalp/forsaljning#registrera-betalning) i kapitlet Försäljning.
- **U** (Leverantörsreskontra) — bokförs när en **utbetalning registreras** i leverantörsreskontran (bankbeloppet mot betalkontot, leverantörsskulden mot det som stängs, mellanskillnaden mot öres-/kronutjämning vid en avskrivning inom toleransen), och som en **omföring** när en betalning **makuleras**. Delar betalkontots standardvärde och betalningstoleransen med kundreskontran. Se [Leverantörsreskontra](/hjalp/inkop#leverantorsreskontra) i kapitlet Inköp för hela flödet, inklusive kvittning mot leverantörens kreditfaktura.
- **M** (Momsredovisning) — bokförs när momsrapportens **momsomföring** bokförs, se [Momsrapport](#momsrapport) ovan.
- **IM** (Importmoms) — bokförs när du **bokför importmoms** på ett tullbeslut, se [Importmoms](#importmoms).
- **AV** (Anläggningar) — avskrivningskörningar, deras omföringar (**Ångra senaste körning**) och avyttringsverifikat från [Anläggningsregistret](#anlaggningsregister).

Serierna skapas bara om de saknas. Finns redan en verifikatserie med koden **F**, **L**, **K**, **U**, **M**, **IM**, **AV** eller **BS** — t.ex. en du lagt upp själv för något annat — återanvänder automatkonteringen den serien utan att säga till, och fakturaverifikaten hamnar alltså i din befintliga serie. Vill du hålla dem åtskilda, använd andra koder än F, L, K, U, M, IM, AV och BS för egna serier.

Fakturanumret/attesten/BET-numret/UTB-numret och verifikatet skapas i ett och samma steg — antingen blir båda av, eller ingetdera. På respektive faktura-/betalningskort visas en länk till verifikatet (**Verifikat F-…** / **Verifikat L-…** / **Verifikat K-…** / **Verifikat U-…**), synlig bara för den som kan öppna Ekonomi.

**Vilket konto en rad bokförs mot avgörs i den här ordningen:**

1. En **konteringsregel** för radens artikelgrupp och exakta [momskod](#momskoder).
2. Annars en konteringsregel för artikelgruppen med momskod **"Alla momskoder"** (en katalog-regel som gäller oavsett moms) — men bara för svensk moms, momsfritt och *Inköp varor utanför EU*. En katalog-regel som skickar en artikelgrupp till ett konto med ruta 05 får inte tyst ta en EU-försäljning, som ska till ruta 35.
3. Annars kontot på **momskoden** — intäktskontot för en försäljning, kostnadskontot för ett inköp med omvänd moms — och för en kostnad med svensk moms eller momsfritt standardkontot **Kostnad, standard**.

Momskoden avgör också momsen: utgående moms bokförs på kodens konto för utgående moms, och vid **omvänd moms** på ett inköp (t.ex. **IEUV25**) beräknas momsen på leverantörsfakturan och bokförs både som utgående och ingående moms. Regler, standardkonton och momskoder läggs upp under [Konteringsregler](#konteringsregler) och [Momskoder](#momskoder). Rader utan artikelgrupp (t.ex. artiklar utan grupp, eller fria rader utan artikel på en leverantörsfaktura) hoppar direkt till kontot på momskoden respektive standardkontot.

## Konteringsregler

**Ekonomi → Konteringsregler** styr automatkonteringen: dels **standardkontona** som gäller när ingen regel matchar, dels **konteringsreglerna** som styr enskilda artikelgrupper. Allt på sidan — standardkontona, beloppen under **Kundreskontra** och reglerna — kan ändras av alla med rättigheten **Ekonomi**; övriga inställningar under **System → Inställningar** är fortfarande bara för administratörer.

### Standardkonton

Sektionen **Standardkonton** listar de nio konton automatkonteringen faller tillbaka på: **Kundfordringar**, **Leverantörsskulder**, **Kostnad, standard**, **Bank/betalkonto**, **Påminnelseavgifter**, **Öres- och kronutjämning** och **Redovisningskonto för moms** (momsomföringens motkonto, standard 2650), samt bokslutets två konton **Lager** och **Lagerförändring** (se nedan). **Intäktskontona och momskontona** (utgående och ingående moms) ligger inte här längre utan på [momskoderna](#momskoder) — en länk till **Momskoder** står under rubriken. De värden som tidigare låg i standardkontona flyttades till momskoderna **MP25**, **MP12**, **MP6** och **MF** när funktionen infördes. Varje fält är en lista över aktiva konton i formatet **"1510 Kundfordringar"**; det förvalda värdet är kontot som gäller just nu (eget val eller BAS-standard). Välj **"Återställ till standard (…)"** överst i listan för att ta bort ett eget val och gå tillbaka till standardkontot. Klicka **Spara** — bara de fält du faktiskt ändrat skickas.

**Öres- och kronutjämning** måste vara ett eget konto, skilt från **Kundfordringar** och **Leverantörsskulder** — pekar det på något av dem nekar betalningsregistreringen (kundreskontran respektive leverantörsreskontran) med ett konfliktfel, eftersom kontot då skulle både öppna och stänga samma post i en och samma bokning.

**Lager** (förval 1460) och **Lagerförändring** (förval 4990) används av bokslutets steg *Lagerförändring* (se [Årsbokslut](#arsbokslut)): skillnaden mellan lagervärdet och saldot på **Lager** bokförs mot **Lagerförändring**. Ett tillverkande företag byter ofta **Lager** till t.ex. 1410 eller 1450. De två fälten får inte vara samma konto.

### Kundreskontra

Sektionen **Kundreskontra** styr två belopp: **Betalningstolerans (kr)** — hur mycket en kundbetalning får avvika från fakturans resterande belopp och ändå räknas som fullt betald — och **Påminnelseavgift (kr)** — avgiften som läggs på en betalningspåminnelse. Till skillnad från standardkontona ovan har fälten inget "Återställ till standard": ett belopp måste alltid anges (0 eller större). Klicka **Spara** — bara de fält du faktiskt ändrat skickas.

### Regler per artikelgrupp

Sektionen **Konteringsregler** listar reglerna i en tabell: **Artikelgrupp**, **Momskod**, **Intäktskonto** och **Kostnadskonto**. Under varje konto står kontots momsruta i kontoplanen, och en regel vars konto har fel momsruta får en varning med länk till kontot — samma kontroll som [Momsrapport](#momsrapport) gör: ruta 05 för intäktskontot i en regel för **Moms 25 %**, **Moms 12 %** eller **Moms 6 %** (ruta 42 för **Momsfri**, ruta 05 eller 42 för **Alla momskoder**), kodens egen ruta för utrikes- och omvända koder, och ingen av inköpsrutorna 20–24, 37 eller 50 på kostnadskontot i en regel för svensk moms, **Inköp varor utanför EU** eller **Alla momskoder**. **+ Ny regel** öppnar ett formulär med:

- **Artikelgrupp** — obligatorisk.
- **Momskod** — **Alla momskoder** (katalog-regeln, se ovan) eller en av koderna, grupperade som *Svensk moms och momsfritt*, *Försäljning till utlandet och omvänd betalningsskyldighet* och *Inköp från utlandet och omvänd moms*. Importmomskoderna kan inte väljas — importmomsen har ingen artikelgrupp. Listan visar de aktiva koderna; en regel vars kod har inaktiverats behåller den i listan, märkt **(inaktiv)**, och gäller som vanligt. **Alla momskoder** gäller bara svensk moms, momsfritt och *Inköp varor utanför EU*: utrikes- och omvända koder (t.ex. **Varor till annat EU-land**) tar kodens eget konto om det inte finns en regel för exakt den koden.
- **Intäktskonto** och **Kostnadskonto** — samma kontoformat som standardkontona, tom lista visas som **"—"**. Minst ett av de två måste anges — en regel kan styra bara intäkt, bara kostnad, eller båda. Vill du ha ett eget intäktskonto för EU-försäljning av en artikelgrupp lägger du en regel för exakt **EUV**; kontot bör ha ruta 35, annars varnar [momsrapporten](#momsrapport).

En kombination av artikelgrupp och momskod kan bara ha **en** regel — försöker du lägga upp en till för samma kombination avvisas det. Regler som fanns innan momskoderna infördes är flyttade: momssats 25 % blev **Moms 25 %**, 12 % blev **Moms 12 %**, 6 % blev **Moms 6 %**, 0 % blev **Momsfri** och **Alla satser** blev **Alla momskoder**. Klicka **Ändra** på en rad för att redigera regeln, eller **Ta bort** för att radera den (bekräftas innan den tas bort).
