# Lager

Lagermodulen i Nav|ERP visar saldon och den fullständiga transaktionsloggen, hanterar lagerplatser, lagerflytt, inventering och justeringar.

## Så fungerar saldot

Lagret är **append-only**: saldot ändras aldrig direkt, utan varje förändring bokförs som en transaktion (inleverans, utleverans, materialuttag, tillverkningsinleverans, lagerflytt eller inventeringsjustering). Aktuellt saldo är alltid summan av transaktionerna. Det gör att varje saldo kan förklaras rad för rad i transaktionsloggen — och att historiken aldrig kan ändras i efterhand.

## Saldon

**Lager → Saldon** (`/lager/saldon`) listar saldo per artikel och lagerplats med sök på artikelnummer/benämning. Menyvalet **Lager** öppnar modulens sida med alla lagerfunktioner i ett rutnät — saldolistan är den första av dem. Ett saldo uppstår första gången en transaktion bokförs på artikeln/platsen, och försvinner ur listan när artikeln nettar till 0 på platsen — historiken finns kvar i transaktionsloggen. Negativa saldon tillåts och lyfts fram på Översiktens bevakningslista.

Varje rad har en **Flytta**-länk som öppnar [lagerflytten](#lagerflytt) med artikeln och lagerplatsen förvalda.

Saldon och transaktioner förs alltid i artikelns **grundenhet** — även när en orderrad är skriven i en alternativ enhet räknas antalet om till grundenheten innan det bokförs (se [Artiklar](/hjalp/artiklar)).

## Skanna

**Lager → Skanna** visar vad en kod är: skanna en artikel, en lagerplats eller en order och se den direkt — en artikel med **saldo per lagerplats** och länk till artikelkortet, en lagerplats med sitt innehåll, en inköps-, kund- eller tillverkningsorder med länk till ordern. Sidan fungerar i mobilen och är också ett enkelt sätt att prova en skanner.

Koden kan läsas på två sätt:

- **Handskanner** — en skanner som skriver som ett tangentbord (USB eller Bluetooth). Ställ markören i skanningsfältet och skanna; skannern skickar koden och Enter.
- **Kamera** — knappen **Kamera** öppnar mobilens eller datorns kamera. Håll koden framför kameran; den läses automatiskt och dialogen stängs. Webbläsaren frågar första gången om sidan får använda kameran.

Det här känns igen:

- **Artikelnummer** — det som står på pallkortens och artikeletiketternas kod.
- **Streckkod (EAN)** — tillverkarens kod på förpackningen, när den är ifylld på artikelkortet (se [Artiklar](/hjalp/artiklar#allmant)).
- **Lagerplatsens etikettkod** — **LP** följt av ett nummer (till exempel **LP0042**), se [Etiketter](#etiketter).
- **Ordernummer** — inköpsorder, kundorder (även offertnumret) och tillverkningsorder, som på pallkorten.

Koder läses med Code 128, EAN-8, EAN-13, UPC och QR.

Skanningsfältet finns också i [Inleverans](/hjalp/inkop#skanna-i-inleveransen), där en skannad artikel räknas mot inköpsorderns rader.

## Etiketter

Artiklar och lagerplatser kan få etiketter med en kod att skanna: **Skriv ut etiketter** för de markerade raderna i lagerplatsregistret och i artikelregistret, och **Skriv ut etikett** på artikelkortet. En artikeletikett har artikelnumret, benämningen och artikelnumret som kod (och EAN-koden som text när den finns); en lagerplatsetikett har platsens namn, lagret och platsens **etikettkod**. Koden är en streckkod (Code 128), eller en QR-kod när texten innehåller tecken som en streckkod inte kan bära, till exempel å, ä eller ö.

Välj format i dialogen:

- **A4-ark (70 × 37 mm, 24 per ark)** — vanliga etikettark i en vanlig skrivare. **Börja på etikett** anger var på arket utskriften börjar (1–24, vänster till höger, uppifrån), så att ett halvanvänt ark kan användas igen.
- **Etikettskrivare (100 × 50 mm)** — en etikett per sida för en etikettskrivare.

**Antal per etikett** skriver ut flera exemplar av varje. Etikettkoden står i lagerplatsregistrets kolumn **Etikettkod**; den byts inte när platsen byter namn, så en uppsatt etikett gäller så länge platsen finns.

## Transaktioner

**Lager → Transaktioner** (`/lager/transaktioner`) är hela loggen, nyast först. Kolumnerna är **Datum**, **Artikel**, **Lagerplats**, **Typ**, **Mängd** (+/−), **Saldo**, **Källa**, **Vem**, **À-pris**, **Värde** och **Anteckning**. Från artikelkortets Lager-flik öppnar länken **Visa lagerlogg** loggen med artikeln förvald.

### Filter

Sök på artikelnummer eller benämning, eller använd filtren: artikel (artikelväljaren), **Alla lagerplatser**, **Alla typer**, **In och ut** (Inflöden/Utflöden) samt datumfälten **Från** och **Till**. Datumen är kalenderdagar i svensk tid och gäller inklusive båda dagarna. Filtren ligger i sidans URL (går att bokmärka), följer med när du bläddrar mellan sidor och gäller även **Exportera CSV** (där kolumnen Saldo bara tas med när en artikel är vald).

### Kolumnerna

- **Källa** visar dokumentet som gav upphov till raden, och länkar till det när du har behörighet till dokumentets sida: inköpsordern (IO-nummer) vid inleverans, kundordern (KO-nummer) vid utleverans, tillverkningsordern (TO-nummer) vid materialuttag och inleverans TO, och inventeringen (INV-nummer) vid en inventeringsjustering. En justering som gjorts för hand visar **Manuell**, och en lagerflytt visar **Flytt till** (minusraden) eller **Flytt från** (plusraden) och den andra lagerplatsen i flytten ("Flytt till Huvudlager — B2"). Kan källan inte avgöras visas ett streck.
- **Saldo** är artikelns verkliga saldo direkt efter raden, räknat över hela artikelns historik — inte bara över de rader som filtret visar. Kolumnen visas bara när en artikel är vald; är även en lagerplats vald gäller saldot just den platsen, annars artikelns totalsaldo. Utan andra filter än artikel (och plats) stämmer översta raden med saldot i [Saldon](#saldon) (summan av artikelns platser när ingen plats är vald).
- **Vem** är användaren som bokförde raden (ett streck när den saknas).
- **À-pris** och **Värde** (mängd gånger à-pris) visas bara för administratörer och användare med behörigheten Ekonomi — övriga ser varken kolumnerna eller beloppen, och de saknas även i CSV-exporten. À-pris sätts bara på inflöden (se [Lagervärdering](#lagervardering)), så utflöden och lagerflytt har ett streck.

Transaktionstyperna:

| Typ | Uppstår vid |
|---|---|
| Inköpsmottagning | **Ta emot** på en inköpsorderrad |
| Kundleverans | **Leverera** på en kundorderrad |
| Materialförbrukning | **Förbruka** material på en tillverkningsorder |
| Tillverkningsmottagning | **Slutför order** på en tillverkningsorder |
| Inventeringsjustering | **Registrera justering** i justeringen, eller **Registrera** i inventeringen |
| Lagerflytt | **Flytta** i lagerflytten — två rader per artikel (− på avsändarplatsen, + på mottagande) |

## Lagerplatser

**Lager → Lagerplatser** hanterar lagerstrukturen: **lager** (t.ex. Huvudlager) med **lagerplatser** (t.ex. A1). Skapa nya med respektive +-knapp, och redigera befintliga med **Ändra** — namn, aktiv/inaktiv och (för lagerplatser) vilket lager platsen hör till.

**Lagerplats är obligatorisk på varje transaktion**, men behöver inte väljas manuellt. Väljs ingen används i tur och ordning:

1. **Artikelns lagerplats** — fältet Lagerplats på artikelkortets Allmänt-flik (se [Artiklar](/hjalp/artiklar)). En inaktiverad plats hoppas över.
2. **`***`** — en reservplats (lagret `***` med lagerplatsen `***`) som systemet skapar automatiskt första gången den behövs.

I formulären heter standardvalet **"Artikelns lagerplats"**; välj en specifik plats i listan för att styra transaktionen dit i stället.

### Tomma lagerplatser städas bort

När en lagerplats blir helt tom — oavsett om det var en lagerflytt, en utleverans, ett materialuttag eller en negativ justering som tömde den — **inaktiveras den automatiskt** och försvinner ur alla lagerplatsval i systemet. Reservplatsen `***` inaktiveras aldrig.

Platsen raderas inte på riktigt: raden finns kvar så att transaktionsloggen fortsatt kan visa var saldot en gång låg. Kryssa i **Visa inaktiva** på Lagerplatser för att se dem, och använd **Ändra** för att aktivera en plats igen.

**En lagerplats med saldo är alltid aktiv.** Det är inget du behöver hålla reda på — systemet ser till att det stämmer åt båda hållen:

- Försöker du inaktivera en lagerplats som fortfarande har saldo via **Ändra** avvisas det: *"Lagerplatsen … har saldo kvar och kan inte inaktiveras — flytta eller nolla saldot först"*. Flytta saldot med [lagerflytten](#lagerflytt) först, så inaktiveras platsen av sig själv. (Byta namn eller lager går fortfarande bra.)
- Bokförs ändå en transaktion på en inaktiverad lagerplats — t.ex. från en integration, eller när en orderrad levereras mot en plats som just tömdes — **aktiveras platsen automatiskt igen** i stället för att saldot göms undan.

Saldo kan alltså aldrig ligga på en lagerplats du inte ser i listorna.

Pekade en artikels **Lagerplats** på den inaktiverade platsen nollställs fältet till `***` — men om det var en lagerflytt som tömde platsen följer artikeln i stället med till den mottagande lagerplatsen.

## Lagerflytt

**Lager → Lagerflytt** flyttar saldon mellan lagerplatser.

1. Välj **Från lagerplats**. Alla artiklar med saldo där listas med hela saldot förifyllt i **Flytta**-kolumnen.
2. Välj **Till lagerplats**.
3. Justera antalen — rader som lämnas på 0 hoppas över — och fyll gärna i en **Anteckning** (den hamnar på båda transaktionsraderna).
4. Klicka **Flytta**.

Hela flytten bokförs i ett svep: antingen går alla rader igenom eller ingen. Varje artikel ger två transaktioner av typen **Lagerflytt** — en negativ på avsändarplatsen och en positiv på den mottagande.

Du kan bara flytta det som faktiskt står på platsen; ett för stort antal avvisas med *"Otillräckligt saldo"*. Går det inte att flytta till en plats beror det på att den är inaktiverad.

Tömmer flytten avsändarplatsen inaktiveras den automatiskt (se [Tomma lagerplatser städas bort](#tomma-lagerplatser-stadas-bort)) — kvittensen säger till när det händer.

## Inventering

**Lager → Inventering** (endast administratörer) är rutinen för att räkna av en hel lagerplats: skapa ett underlag som fryser det bokförda saldot, skriv ut en räknelista, mata in räknade antal och registrera — differenserna bokförs då som transaktioner av typen Inventeringsjustering.

### Skapa underlag

Klicka **+ Ny inventering**, välj **Lagerplats** och eventuellt en **Anteckning**. Kryssrutan **Spärra lagertransaktioner under inventeringen** fryser lagerplatsen:

- **Med spärr** avvisas alla lagerrörelser på platsen (inleverans, utleverans, materialuttag, flytt, justering) med felet *"Lagerplatsen … är under inventering (INV-…) — registrera eller avbryt inventeringen först"* tills inventeringen registreras eller avbryts.
- **Utan spärr** tillåts rörelser, men rader vars artikel fått transaktioner efter frysningen varningsflaggas med **⚠ Rörelser efter frysning** — kontrollera att räkningen gjordes efter rörelsen innan du registrerar.

**Skapa inventeringsunderlag** ger underlaget ett INV-nummer och en rad per artikel med saldo på platsen, med det bokförda saldot fryst som jämförelsetal. En lagerplats kan bara ha en pågående inventering i taget.

### Räkna och registrera

Skriv ut **räknelistan** med **Skriv ut räknelista** — den är avsiktligt *blind* (bokfört saldo skrivs inte ut, så räkningen inte påverkas av facit); **Räknelista med saldo** tar med kolumnen. Mata in de räknade antalen i kolumnen **Räknat** (i artikelns grundenhet), klicka **Spara räknade antal**, och lägg till artiklar som hittas fysiskt men saknar rad med **Lägg till artikel**. Diffen mot bokfört visas live per rad.

**Registrera** bokför differenserna: en transaktion av typen Inventeringsjustering per räknad rad där räknat ≠ bokfört, med anteckningen "Inventering INV-…". Rader utan räknat antal **hoppas över** — de justeras inte och tolkas aldrig som noll. Rader där räknat = bokfört bokför inget. Registreringen kan inte ångras (men saldot kan förstås justeras igen). Statusen blir **Registrerad**.

**Avbryt inventering** stänger underlaget utan att boka något och släpper spärren. Statusen blir **Avbruten**.

## Justering

**Lager → Justering** registrerar en enstaka saldojustering: välj artikel (artikelväljaren), lagerplats, ange **justeringen som +/− antal** (inte det räknade totalsaldot) och gärna en anteckning om orsaken. Klicka **Registrera justering** — justeringen bokförs som transaktion och syns direkt i saldot.

Har artikeln alternativa enheter visas en **Enhet**-dropdown vid justeringsfältet — antalet kan då matas in i t.ex. kg och räknas om till grundenheten vid bokföringen (omräkningen visas som hjälptext innan du sparar).

## Importera lagersaldon

Vid start med Nav|ERP läses de ingående saldona in från fil i stället för en justering per artikel: **Artiklar → Importera**, fliken **Lagersaldon** (endast administratörer). Guiden är densamma som för artiklarna — **Fil**, **Kolumner**, **Förhandsgranska** och **Resultat** — och tar CSV eller Excel. Mallen laddas ned med **Ladda ned mall**; kolumnerna förklaras i [Importmallar](/hjalp/importmallar#lagersaldon). Importera artiklarna först — raderna måste peka på artiklar som finns.

En rad per artikel och lagerplats med kolumnerna **Artikelnummer**, **Lager**, **Lagerplats**, **Antal** och **À-pris**:

- **Antal är saldot efter importen**, som vid en inventering. Nav jämför med dagens saldo på platsen och bokar **skillnaden** som en vanlig lagerjustering med anteckningen *Import av lagersaldo* — den syns i [transaktionsloggen](#transaktioner) som alla andra lagerhändelser. Samma fil två gånger ändrar alltså ingenting, en rättad fil rättar saldot och **0** tömmer platsen. En rad där saldot redan stämmer räknas som överhoppad.
- **Lager och Lagerplats** anger platsen. Ett lager eller en plats som saknas **skapas** — förhandsgranskningen visar vilka under **Skapas automatiskt**. Bara Lagerplats fungerar när platsnamnet finns i ett enda lager. Är båda tomma hamnar saldot på artikelns lagerplats, annars på reservplatsen **`***`**.
- **À-pris** värderar det som läggs till (kronor per grundenhet), så att [lagervärderingen](#lagervardering) stämmer från första dagen. Tom cell betyder artikelns standardkostnad — samma som en manuell justering. Saknas båda bokas ökningen utan värde, med en varning. En minskning värderas aldrig; den tar det som fanns.

Raden stoppas när artikeln inte finns, är en tjänst eller en fantomartikel, när samma artikel står två gånger på samma plats, när antalet är negativt eller när platsen [inventeras](#inventering) med spärr. **Hoppa över rader som redan finns** lämnar platser där artikeln redan har ett saldo orörda. Importen är allt eller inget: har någon rad fel importeras ingenting.

## Lagervärdering

**Lager → Lagervärdering** (endast administratörer) visar lagrets värde — saldo gånger ett värderingspris — per valfritt datum, uppdelat per varugrupp med en summarad längst ner. Ange **Per datum**, välj **Metod** och eventuellt en **Varugrupp** eller **Artikelkod** (annars visas alla). Med **Gruppera** väljer du om rapporten delas upp per **Varugrupp** (förvalt, artiklar utan varugrupp hamnar under **Utan varugrupp**) eller per **Artikelkod** (artiklar utan kod under **Utan artikelkod**); valet följer med i PDF:en. Rapporten hämtas direkt när du ändrar ett val, och sidans URL följer med så vyn går att bokmärka. Ladda ner samma rapport som PDF med **Ladda ner PDF**.

De tre metoderna:

- **Standardpris** — artikelns historiska standardpris: priset som gällde vid det valda datumet. Om datumet ligger före den första kända prisändringen används det äldsta kända priset (historiken började byggas upp när funktionen infördes, den kan inte se bakåt förbi det).
- **Senaste inköp** — priset från den senaste inleveransen (i SEK) fram till och med valt datum. Endast inleveranser som har ett pris räknas.
- **Vägt snitt** — ett glidande medelpris, uppspelat ur lagrets transaktionslogg fram till valt datum. Transaktioner utan pris (t.ex. från innan priset började sparas på lagerraden) påverkar antalet men inte snittet.

En artikel utan pris för vald metod visar **"—"** i kolumnen Värde och räknas inte med i summan — antalet syns ändå. Finns en eller flera sådana artiklar visas en hjälptext under kontrollerna med hur många det gäller, t.ex. *"3 artiklar saknar pris för vald metod och ingår inte i summan."* (böjs i singular: *"1 artikel saknar…"*).

Värderingen följer **när lagerhändelserna faktiskt bokfördes**, inte en separat affärsdag — en rörelse kan alltså inte backdateras in i en tidigare värdering.
