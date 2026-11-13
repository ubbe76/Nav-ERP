# Lager

Lagermodulen i Nav|ERP visar saldon och den fullständiga transaktionsloggen, hanterar lagerplatser, lagerflytt, inventering och justeringar.

## Så fungerar saldot

Lagret är **append-only**: saldot ändras aldrig direkt, utan varje förändring bokförs som en transaktion (inleverans, utleverans, materialuttag, tillverkningsinleverans, lagerflytt eller inventeringsjustering). Aktuellt saldo är alltid summan av transaktionerna. Det gör att varje saldo kan förklaras rad för rad i transaktionsloggen — och att historiken aldrig kan ändras i efterhand.

## Saldon

**Lager → Saldon** (`/lager/saldon`) listar saldo per artikel och lagerplats med sök på artikelnummer/benämning. Menyvalet **Lager** öppnar modulens sida med alla lagerfunktioner i ett rutnät — saldolistan är den första av dem. Ett saldo uppstår första gången en transaktion bokförs på artikeln/platsen, och försvinner ur listan när artikeln nettar till 0 på platsen — historiken finns kvar i transaktionsloggen. Negativa saldon tillåts och lyfts fram på Översiktens bevakningslista.

Filtret **Alla lagerplatser** / **Bara spärrade** / **Utan spärrade** begränsar listan, och saldot på en [spärrad lagerplats](#sparrade-lagerplatser) märks med **Spärrad**. Kolumnen **Spärrad** finns också i exporten.

En lagerplats kan visas ensam: **Visa saldon** i [Lagerplatser](#lagerplatser) öppnar listan för just den platsen.

Varje rad har en **Flytta**-länk som öppnar [lagerflytten](#lagerflytt) med artikeln och lagerplatsen förvalda.

Saldon och transaktioner förs alltid i artikelns **grundenhet** — även när en orderrad är skriven i en alternativ enhet räknas antalet om till grundenheten innan det bokförs (se [Artiklar](/hjalp/artiklar)).

## Skanna

**Lager → Skanna** visar vad en kod är: skanna en artikel, en lagerplats eller en order och se den direkt — en artikel med **saldo per lagerplats** och länk till artikelkortet, en lagerplats med sitt innehåll, en inköps-, kund- eller tillverkningsorder med länk till ordern. Sidan fungerar i mobilen och är också ett enkelt sätt att prova en skanner.

Koden kan läsas på två sätt:

- **Handskanner** — en skanner som skriver som ett tangentbord (USB eller Bluetooth). Ställ markören i skanningsfältet och skanna; skannern skickar koden och Enter.
- **Kamera** — knappen **Kamera** öppnar mobilens eller datorns kamera. Håll koden framför kameran; den läses automatiskt och dialogen stängs. Webbläsaren frågar första gången om sidan får använda kameran.

Det här känns igen:

- **Artikelnummer** — det som står på pallkortens och artikeletiketternas kod.
- **Streckkod (EAN)** — tillverkarens kod på förpackningen, när den är ifylld på artikelkortet (se [Artiklar](/hjalp/artiklar#allmant)). En UPC-A-kod (12 siffror) och samma kod som EAN-13 med en inledande nolla är samma kod: artikeln hittas oavsett i vilken form den sparats eller läses.
- **Lagerplatsens etikettkod** — **LP** följt av ett nummer (till exempel **LP0042**), se [Etiketter](#etiketter).
- **Ordernummer** — inköpsorder, kundorder (även offertnumret) och tillverkningsorder, som på pallkorten.

Koder läses med Code 128, EAN-8, EAN-13, UPC, QR och DataMatrix (när webbläsaren kan läsa formatet).

**GS1-koder.** En GS1-128- eller DataMatrix-kod kan bära flera fält på en gång, och Nav tolkar:

- **GTIN** (01) — artikeln slås upp på samma sätt som en Streckkod (EAN).
- **Batch** (10) och **serienummer** (21) — numret som står i koden.
- **Utgångsdatum** (17, annars bäst före 15).
- **Antal** (30/37) visas men räknas inte om automatiskt.

Fälten skiljs åt av en **gruppseparator** (GS/FNC1, ASCII 29) efter varje fält med variabel längd. Skannern ska skicka den: en handskanner i tangentbordsläge skickar den som **Ctrl+]**, och skanningsfältet lägger då separatorn i koden. Utan separatorn går gränsen mellan fälten inte att gissa — `10ABC21123` läses som batchen *ABC21123* — och blir det sammanslagna fältet för långt förkastas hela koden. En kod som inte går att tolka (fel kontrollsiffra, ogiltigt datum) tolkas inte alls, men hela koden slås ändå upp som artikelnummer, EAN, plats eller order.

Skannar du ett batch- eller serienummer visar sidan en rad **GS1-kod** med GTIN, batch, serienummer och utgångsdatum, och träffen *Batch* eller *Serienummer* med saldot per lagerplats och en länk till [Spårbarhet](#sparbarhet-sidan). En skanning skapar aldrig något. Har koden en GTIN söks numret bara på just den artikeln.

Så används GS1-koderna i rutinerna: [Inleverans](/hjalp/inkop#skanna-i-inleveransen), [Utleverans](/hjalp/forsaljning#skanna-vid-plock) och [Inventering](#skanna-vid-inventering).

Skanningsfältet finns också i [Inleverans](/hjalp/inkop#skanna-i-inleveransen) och [Utleverans](/hjalp/forsaljning#skanna-vid-plock), där en skannad artikel räknas mot orderns rader, och i [Inventering](#skanna-vid-inventering), där lagerplatsen öppnar platsens inventering och artikeln tar fram raden att skriva räknat antal på.

## Etiketter

Artiklar och lagerplatser kan få etiketter med en kod att skanna: **Skriv ut etiketter** för de markerade raderna i lagerplatsregistret och i artikelregistret, och **Skriv ut etikett** på artikelkortet. En artikeletikett har artikelnumret, benämningen och artikelnumret som kod (och EAN-koden som text när den finns); en lagerplatsetikett har platsens namn, lagret och platsens **etikettkod**. Koden är en streckkod (Code 128), eller en QR-kod när texten innehåller tecken som en streckkod inte kan bära, till exempel å, ä eller ö.

Välj format i dialogen:

- **A4-ark (70 × 37 mm, 24 per ark)** — vanliga etikettark i en vanlig skrivare. **Börja på etikett** anger var på arket utskriften börjar (1–24, vänster till höger, uppifrån), så att ett halvanvänt ark kan användas igen.
- **Etikettskrivare (100 × 50 mm)** — en etikett per sida för en etikettskrivare.

**Antal per etikett** skriver ut flera exemplar av varje. Etikettkoden står i lagerplatsregistrets kolumn **Etikettkod**; den byts inte när platsen byter namn, så en uppsatt etikett gäller så länge platsen finns.

## Transaktioner

**Lager → Transaktioner** (`/lager/transaktioner`) är hela loggen, nyast först. Kolumnerna är **Datum**, **Artikel**, **Lagerplats**, **Batch** (bara när någon rad har en batch, se [Batchnummer och spårbarhet](#batchnummer-och-sparbarhet)), **Typ**, **Mängd** (+/−), **Saldo**, **Källa**, **Vem**, **À-pris**, **Värde** och **Anteckning**. Från artikelkortets Lager-flik öppnar länken **Visa lagerlogg** loggen med artikeln förvald.

**Datum** är dagen raden räknas på i lagervärderingen. Det är samma tidpunkt som raden registrerades, utom för en inventering som registrerats per underlagets datum (se [Räkna och registrera](#rakna-och-registrera)). Då står raden på tidpunkten då underlaget skapades, och registrerades den en annan dag står **Registrerad** med den dagen under datumet. Ordningen, datumfiltret och **Saldo** följer **Datum**. Exporten har båda tidpunkterna, i kolumnerna **Datum** och **Registrerad**.

### Filter

Sök på artikelnummer eller benämning, eller använd filtren: artikel (artikelväljaren), **Alla lagerplatser**, **Alla typer**, **In och ut** (Inflöden/Utflöden) samt datumfälten **Från** och **Till**. Datumen är kalenderdagar i svensk tid och gäller inklusive båda dagarna. Filtren ligger i sidans URL (går att bokmärka), följer med när du bläddrar mellan sidor och gäller även **Exportera** (där kolumnen Saldo bara tas med när en artikel är vald).

### Kolumnerna

- **Källa** visar dokumentet som gav upphov till raden, och länkar till det när du har behörighet till dokumentets sida: inköpsordern (IO-nummer) vid inleverans, kundordern (KO-nummer) vid utleverans, tillverkningsordern (TO-nummer) vid materialuttag och inleverans TO, och inventeringen (INV-nummer) vid en inventeringsjustering. En justering som gjorts för hand visar **Manuell**, och en lagerflytt visar **Flytt till** (minusraden) eller **Flytt från** (plusraden) och den andra lagerplatsen i flytten ("Flytt till Huvudlager — B2"). Kan källan inte avgöras visas ett streck.
- **Saldo** är artikelns verkliga saldo direkt efter raden, räknat över hela artikelns historik — inte bara över de rader som filtret visar. Kolumnen visas bara när en artikel är vald; är även en lagerplats vald gäller saldot just den platsen, annars artikelns totalsaldo. Utan andra filter än artikel (och plats) stämmer översta raden med saldot i [Saldon](#saldon) (summan av artikelns platser när ingen plats är vald).
- **Vem** är användaren som bokförde raden (ett streck när den saknas).
- **À-pris** och **Värde** (mängd gånger à-pris) visas bara för administratörer och användare med behörigheten Ekonomi — övriga ser varken kolumnerna eller beloppen, och de saknas även i exporten. À-pris sätts bara på inflöden (se [Lagervärdering](#lagervardering)), så utflöden och lagerflytt har ett streck.

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

**Lager → Lagerplatser** hanterar lagerstrukturen: **lager** (t.ex. Huvudlager) med **lagerplatser** (t.ex. A1). Skapa nya med respektive +-knapp, och redigera befintliga med **Ändra** — namn, aktiv/inaktiv och (för lagerplatser) vilket lager platsen hör till samt om den är en **Fast lagerplats**. Kolumnen **Fast** i listan visar Ja eller Nej; en ny lagerplats är fast som förval (kryssrutan **Fast lagerplats** i **Ny lagerplats**). Se [Tomma lagerplatser städas bort](#tomma-lagerplatser-stadas-bort).

Listan över lagerplatser är sidindelad och har sökfältet **Sök lagerplats, lager eller etikettkod…**. Du kan söka på platsens namn, lagrets namn eller etikettkoden, till exempel *LP0042*. Tre filter begränsar listan:

- **Alla lager** (eller ett enskilt lager).
- Status: **Aktiva** (förval), **Inaktiva** eller **Alla**. En plats som tömts och städats bort är inaktiv och syns bara under **Inaktiva** eller **Alla**.
- **Alla lagerplatser** / **Bara spärrade** / **Utan spärrade**, som i [Saldon](#saldon).

Kolumnen **Artiklar** visar hur många artiklar som har saldo på platsen (artiklar som nettar till 0 räknas inte). Kolumnen **Saldo** visar saldot per enhet, till exempel *120 st · 35,5 kg*, eftersom en summa över olika enheter inte betyder något. Länken **Visa saldon** på raden öppnar [Saldon](#saldon) bara för den platsen, och **Visa alla lagerplatser** där tar bort begränsningen. **Exportera** (**CSV** eller **Excel**) hämtar hela urvalet, utan sidindelning, med samma sök och filter som listan: Lager, Lagerplats, Etikettkod, Fast, Spärrad, Spärrad sedan, Anteckning, Artiklar, Saldo och Status.

Markera platser i listan och klicka **Skriv ut etiketter** för att skriva ut etiketterna för dem. Det gäller de markerade raderna på sidan.

**Lagerplats är obligatorisk på varje transaktion**, men behöver inte väljas manuellt. Väljs ingen används i tur och ordning:

1. **Artikelns huvudplats** — kortet **Lagerplatser** på artikelkortets Lager-flik (se [Artiklar](/hjalp/artiklar#lager)). En inaktiverad eller [spärrad](#sparrade-lagerplatser) plats hoppas över. Är huvudplatsen reservplatsen (`*** (standard)` på kortet, som alla artiklar får när ingen plats väljs) räknas det som att artikeln saknar huvudplats.
2. **Artikelns första användbara alternativa lagerplats** — i den ordning som står under **Alternativa lagerplatser**. Inleveranser fyller alltså inte på en alternativ plats bara för att det finns saldo där; de går till huvudplatsen.
3. **`***`** — en reservplats (lagret `***` med lagerplatsen `***`) som systemet skapar automatiskt första gången den behövs. Namnet `***` är reserverat: ingen annan lagerplats kan heta så, och reservplatsen kan inte byta namn (*Namnet \*\*\* är reserverat för reservplatsen — välj ett annat namn*). En lagersaldofil med lagerplatsen `***` hamnar på reservplatsen, oavsett vilket lager filen anger.

I formulären för inleveranser och justeringar heter standardvalet **"Artikelns lagerplats"**; välj en specifik plats i listan för att styra transaktionen dit i stället. Vid uttag (utleverans, materialuttag på tillverkningsorder) heter standardvalet **"Automatiskt"** och fungerar lite annorlunda, se [Uttag med Automatiskt](#uttag-med-automatiskt).

### Spärrade lagerplatser

En lagerplats kan **spärras**, till exempel för en **Karantän** eller en **Reklamation**. Saldot där är fortfarande företagets lager och **värderas som vanligt** i [Lagervärdering](#lagervardering) och i bokslutet, men det är inte till hands:

- Det **räknas inte** i behovsberäkningen, artikelöversiktens **Lagersaldo idag (utan spärrat)**, Materialbrist vid rapportering, frisläppets bristvarning, Leveranstidskontrollen och färdigdatumsförslaget.
- Det **tas aldrig med Automatiskt** (se [Uttag med Automatiskt](#uttag-med-automatiskt)).
- En inleverans eller ett nytt saldo utan vald plats hoppar över en spärrad huvudplats och går till nästa användbara alternativa plats, till sist reservplatsen `***`. Reservplatsen kan inte spärras.
- Ett **minussaldo** på en spärrad plats räknas däremot med, som en brist. Det uppstår till exempel när en kassation tar mer än platsen hade, eller när platsen stod på minus innan den spärrades, och varorna har då i själva verket tagits från lagret du kan använda. På artikelkortet och i artikelöversikten visar **varav spärrat** bara plussaldon.

Så här spärrar och släpper du, med behörigheten Lager:

1. Klicka **Spärra…** på lagerplatsens rad, skriv gärna en **Anteckning** (t.ex. *Karantän, väntar på kontroll*) och klicka **Spärra**. Nav säger sedan hur många artiklar som har saldo på platsen och hur många som har den som huvudplats; deras inleveranser går till nästa plats tills spärren släpps. En spärrad alternativ plats hoppas också över, både vid inleverans och av Automatiskt. Du kan också skapa platsen spärrad direkt med kryssrutan **Spärrad lagerplats** i **Ny lagerplats**.
2. Kolumnen **Spärrad** visar **Spärrad** med anteckningen och *sedan* vilket datum. I **Saldon**, på artikelkortet och i Skanna märks saldot på platsen med **Spärrad**.
3. **Släpp spärr** tar bort spärren efter en bekräftelse. Saldot räknas då igen.

Behovsberäkningen sparar sitt resultat i en minut, så klicka **Uppdatera** där efter att du spärrat eller släppt en plats.

**Vad som går mot en spärrad plats**

| Flöde | Spärrad plats |
|---|---|
| Inleverans, tillverkningsinleverans, Slutför, positiv **Justering**, saldoimport | Går bra när du väljer platsen. Så hamnar gods i karantän. |
| Inleverans utan vald plats (**Artikelns lagerplats**) | Hoppar över en spärrad Lagerplats. |
| Utleverans, **Leverera** och **Förbruka** på orderkortet | Platsen kan inte väljas för uttag (*"Lagerplatsen är spärrad"*), och i **Utleverans** visas den inte i platsvalet per rad. En skannad LP-kod på en spärrad plats ger en varning och väljs inte. |
| **Automatiskt** | Hoppar över platsen. Det som inte räcker blir minus på artikelns huvudplats, annars på första användbara alternativa plats, annars på `***`, aldrig på den spärrade platsen. |
| Tillverkningsorderns rapportering och **Slutför order** | En vald spärrad plats tar bara emot de färdiga varorna. Materialet tas med Automatiskt. |
| [Lagerflytt](#lagerflytt), **Justering** (även negativ), [inventering](#inventering), saldoimport | Går bra, också från platsen. En flytt ut ur karantänen är det vanliga sättet att släppa gods. |
| **Ångra** inleverans, utleverans eller rapportering | Går bra. Varorna går tillbaka där de låg, även om platsen har spärrats sedan dess. |

Artikelkortets **Huvudplats** kan inte ändras till en spärrad plats, och en spärrad plats kan inte läggas till som **Alternativ lagerplats**.

**Karantän i praktiken**

- **Vid inleverans:** välj den spärrade platsen i **Lagerplats** eller skanna dess LP-kod. Godset räknas inte förrän det flyttats med **Lagerflytt** eller spärren släppts.
- **Tillverkat gods till kontroll:** välj platsen i tillverkningsorderns **Lagerplats för materialuttag** eller i Slutför-radens **Lagerplats**. Varorna läggs där, och materialet tas med Automatiskt.
- **Reklamation:** ett reklamationsärende flyttar inget lager. En returnerad vara tas in med en positiv **Justering** på den spärrade platsen, med AV-numret i anteckningen. Är hela leveransraden fel kan den ångras (**Ångra…**), och varorna flyttas sedan dit. Gods som redan står i lager flyttas med **Lagerflytt**. Se även [Kvalitet](/hjalp/kvalitet).
- **Kasseras:** negativ **Justering** på den spärrade platsen.

### Uttag med Automatiskt

När du lämnar **Lagerplats** på **Automatiskt** vid en utleverans eller ett materialuttag tar Nav varorna där de faktiskt finns, så att en plats inte går minus medan en annan har saldo kvar:

1. Först artikelns **huvudplats**, upp till dess saldo. Är huvudplatsen `*** (standard)` hoppas steget över, och `***` tas sist i steg 3.
2. Sedan artikelns **alternativa lagerplatser**, i den ordning de står på artikelkortet, upp till deras saldo.
3. Sedan övriga lagerplatser med saldo, i samma ordning som på plocklistan (lager och plats i ordning, reservplatsen `***` sist). Spärrade lagerplatser (se [Spärrade lagerplatser](#sparrade-lagerplatser)) och lagerplatser som är spärrade av en pågående inventering hoppas över.
4. Det som ändå inte räcker dras från samma plats som en inleverans utan vald plats skulle hamna på — huvudplatsen, annars första användbara alternativa plats, annars `***` — och går minus där.

Ett uttag kan alltså ge flera rader i [transaktionsloggen](/hjalp/lager), en per lagerplats. Väljer du en specifik lagerplats tas allt därifrån, även om saldot inte räcker. Ångrar du uttaget lägger Nav tillbaka varje del på den lagerplats den togs från.

### Tomma lagerplatser städas bort

En **fast** lagerplats (kryssrutan **Fast lagerplats**, kolumnen **Fast**) ligger kvar när den blir tom: den förblir aktiv och artiklar som har den som huvudplats eller alternativ plats behåller den. Det är det vanliga för hyllplatser som töms och fylls på igen.

Bara en **tillfällig** lagerplats (**Fast lagerplats** avkryssad) städas bort. När en tillfällig lagerplats blir helt tom — oavsett om det var en lagerflytt, en utleverans, ett materialuttag eller en negativ justering som tömde den — **inaktiveras den automatiskt** och försvinner ur alla lagerplatsval i systemet. Reservplatsen `***` är fast och inaktiveras aldrig. Alla lagerplatser som fanns när funktionen infördes är fasta. Gör du en tom, fast plats tillfällig ligger den kvar aktiv tills du inaktiverar den med **Ändra** eller den töms igen.

Platsen raderas inte på riktigt: raden finns kvar så att transaktionsloggen fortsatt kan visa var saldot en gång låg. Kryssa i **Visa inaktiva** på Lagerplatser för att se dem, och använd **Ändra** för att aktivera en plats igen.

**En lagerplats med saldo är alltid aktiv.** Det är inget du behöver hålla reda på — systemet ser till att det stämmer åt båda hållen:

- Försöker du inaktivera en lagerplats som fortfarande har saldo via **Ändra** avvisas det: *"Lagerplatsen … har saldo kvar och kan inte inaktiveras — flytta eller nolla saldot först"*. Flytta saldot med [lagerflytten](#lagerflytt) först, så inaktiveras platsen av sig själv. (Byta namn eller lager går fortfarande bra.)
- Bokförs ändå en transaktion på en inaktiverad lagerplats — t.ex. från en integration, eller när en orderrad levereras mot en plats som just tömdes — **aktiveras platsen automatiskt igen** i stället för att saldot göms undan.

Saldo kan alltså aldrig ligga på en lagerplats du inte ser i listorna.

Pekade en artikels **Huvudplats** på en tillfällig plats som inaktiverades nollställs fältet till `*** (standard)`, och inleveranserna går då till första alternativa plats, annars till `***` — men om det var en lagerflytt som tömde platsen följer huvudplatsen i stället med till den mottagande lagerplatsen. En tillfällig plats som var **alternativ lagerplats** tas bara bort ur artikelns lista, även vid en lagerflytt.

## Lagerflytt

**Lager → Lagerflytt** flyttar saldon mellan lagerplatser.

1. Välj **Från lagerplats**. Alla artiklar med saldo där listas med hela saldot förifyllt i **Flytta**-kolumnen.
2. Välj **Till lagerplats**.
3. Justera antalen — rader som lämnas på 0 hoppas över — och fyll gärna i en **Anteckning** (den hamnar på båda transaktionsraderna).
4. Klicka **Flytta**.

Hela flytten bokförs i ett svep: antingen går alla rader igenom eller ingen. Varje artikel ger två transaktioner av typen **Lagerflytt** — en negativ på avsändarplatsen och en positiv på den mottagande.

Du kan bara flytta det som faktiskt står på platsen; ett för stort antal avvisas med *"Otillräckligt saldo"*. Går det inte att flytta till en plats beror det på att den är inaktiverad. En [spärrad lagerplats](#sparrade-lagerplatser) fungerar både som **Från lagerplats** och **Till lagerplats**; en plats i listan märks då med *(spärrad)*.

Tömmer flytten en tillfällig avsändarplats inaktiveras den automatiskt (se [Tomma lagerplatser städas bort](#tomma-lagerplatser-stadas-bort)) — kvittensen säger till när det händer. En fast avsändarplats inaktiveras inte, och artiklarna behåller den som Lagerplats.

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

**Bokför differenserna per.** Skapades underlaget en tidigare dag väljer du ovanför knapparna om differenserna ska räknas per **Underlagets datum** eller per **I dag**. Underlagets datum är förvalt när det är tillåtet. Då räknas inventeringen in i lagervärderingen och bokslutets Lagerförändring per den tidpunkt då underlaget skapades, och inte per registreringsdagen. En inventering som börjar på bokslutsdagen och registreras några dagar senare kommer alltså med i bokslutet. En positiv differens värderas då till standardpriset som gällde när underlaget skapades. Registreringstiden ändras inte, och lagerloggen visar båda.

Underlagets datum går bara att välja när räkningen bevisligen visar läget när underlaget skapades och dagen fortfarande är öppen i bokföringen. Annars bokförs inventeringen per i dag, och kortet säger varför:

- *Inventeringens artiklar har fått lagerrörelser på lagerplatsen efter att underlaget skapades.* Det kan bara hända utan **Spärra lagertransaktioner**, och gäller bara rader som har en differens att bokföra.
- *Bokföringsperioden för … är låst.* eller *Räkenskapsåret … är stängt.*

Skapades underlaget i dag finns inget val. En registrerad inventering som bokförts per underlagets datum en tidigare dag visar **Bokförd per …** i sidhuvudet.

**Avbryt inventering** stänger underlaget utan att boka något och släpper spärren. Statusen blir **Avbruten**.

### Skanna vid inventering

Både listan **Lager → Inventering** och inventeringskortet har ett skanningsfält — handskanner eller knappen **Kamera**, som på [Skanna](#skanna).

- **Lagerplatsens etikett** (LP-koden) på listan öppnar platsens pågående inventering. Finns ingen öppnas **Ny inventering** med platsen förvald, så du väljer spärr och anteckning och klickar **Skapa inventeringsunderlag**. En inaktiv plats har inget saldo att inventera, och rutinen säger det. Räknelistan har platsens LP-kod som streckkod uppe till höger, så platsen kan också skannas från listan.
- På inventeringskortet bekräftar platsens egen etikett att du står på rätt plats. En annan plats öppnar den platsens inventering — har du skrivit räknade antal som inte sparats frågar rutinen först (**Byt lagerplats**).
- **Artikeln** — artikelnumret eller **Streckkod (EAN)** — markerar raden och ställer markören i **Räknat** med värdet markerat. Skriv det räknade antalet och tryck **Enter**: raden sparas direkt och markören går tillbaka till skanningsfältet, redo för nästa artikel. Vid inventering räknar varje skanning alltså inte upp antalet, som vid in- och utleverans — antalet på hyllan skrivs in.
- **Batch- och serienummer.** En GS1-kod (eller ett skannat nummer) räknar mot rätt rad: ett **serienummer** med rad sätter **Räknat** till 1 direkt, och finns ingen rad läggs raden till med numret och 1. En **batch** med rad ger den radens **Räknat** markören; finns ingen rad läggs den till med batchen. Skannas bara artikeln och den har flera rader filtreras underlaget till artikelns rader (**Visa alla** visar alla igen); för serienummer uppmanas du skanna numret.
- En artikel som **inte finns på underlaget** läggs till, som med **Lägg till artikel**, och får markören direkt. Rutinen varnar, så en felskanning syns och kan tas bort med **Ta bort**.

Enter i **Räknat** sparar raden även när du skriver utan att skanna. **Spara räknade antal** finns kvar för flera inskrivna rader på en gång.

## Justering

**Lager → Justering** registrerar en enstaka saldojustering: välj artikel (artikelväljaren), lagerplats, ange **justeringen som +/− antal** (inte det räknade totalsaldot) och gärna en anteckning om orsaken. Klicka **Registrera justering** — justeringen bokförs som transaktion och syns direkt i saldot. En tjänst kan inte justeras — [tjänster lagerförs inte](/hjalp/artiklar#artikeltyper).

Justeringen är också det enda en integration kan boka direkt via API:t (`POST /stock/transactions`). Inleveranser, utleveranser, materialuttag och lagerflyttar görs i sina egna rutiner, som kopplar rörelsen till sitt dokument och sitt pris.

Har artikeln alternativa enheter visas en **Enhet**-dropdown vid justeringsfältet — antalet kan då matas in i t.ex. kg och räknas om till grundenheten vid bokföringen (omräkningen visas som hjälptext innan du sparar).

## Importera lagersaldon

Vid start med Nav|ERP läses de ingående saldona in från fil i stället för en justering per artikel: **Artiklar → Importera**, fliken **Lagersaldon** (endast administratörer). Guiden är densamma som för artiklarna — **Fil**, **Kolumner**, **Förhandsgranska** och **Resultat** — och tar CSV eller Excel. Mallen laddas ned med **Ladda ned mall**; kolumnerna förklaras i [Importmallar](/hjalp/importmallar#lagersaldon). **Exportera** bredvid ger det som redan finns i registret i samma kolumner, se [Exportera registren som importfiler](/hjalp/importmallar#exportera-registren-som-importfiler). Importera artiklarna först — raderna måste peka på artiklar som finns.

En rad per artikel och lagerplats med kolumnerna **Artikelnummer**, **Lager**, **Lagerplats**, **Antal** och **À-pris**:

- **Antal är saldot efter importen**, som vid en inventering. Nav jämför med dagens saldo på platsen och bokar **skillnaden** som en vanlig lagerjustering med anteckningen *Import av lagersaldo* — den syns i [transaktionsloggen](#transaktioner) som alla andra lagerhändelser. Samma fil två gånger ändrar alltså ingenting, en rättad fil rättar saldot och **0** tömmer platsen. En rad där saldot redan stämmer räknas som överhoppad.
- **Lager och Lagerplats** anger platsen. Ett lager eller en plats som saknas **skapas** — förhandsgranskningen visar vilka under **Skapas automatiskt**. Bara det som en rad faktiskt bokar ett saldo på skapas: en rad med Antal 0 på en plats som inte finns hoppas över utan att lägga upp vare sig lagret eller platsen. Lagerplatsen **`***`** är alltid reservplatsen, vilket lager raden än anger — något annat lager eller en andra plats med det namnet skapas aldrig. Bara Lagerplats fungerar när platsnamnet finns i ett enda lager. Är båda tomma hamnar saldot på artikelns huvudplats (en spärrad hoppas över), annars på första alternativa platsen, annars på reservplatsen **`***`**.
- **À-pris** värderar det som läggs till (kronor per grundenhet), så att [lagervärderingen](#lagervardering) stämmer från första dagen. Tom cell betyder artikelns standardkostnad — samma som en manuell justering. Saknas båda bokas ökningen utan värde, med en varning. En minskning värderas aldrig; den tar det som fanns.

Raden stoppas när artikeln inte finns, är en tjänst eller en fantomartikel, när samma artikel står två gånger på samma plats, när antalet är negativt eller när platsen [inventeras](#inventering) med spärr. **Hoppa över rader som redan finns** lämnar platser där artikeln redan har ett saldo orörda. Importen är allt eller inget: har någon rad fel importeras ingenting.

## Batchnummer och spårbarhet

Med batchnummer vet du vilken omgång av en artikel som kom in, användes och levererades — så att du kan svara på "var kom den här leveransen ifrån" och "vilka kunder fick den här batchen". Med serienummer får varje enskilt styck ett eget nummer och spåras på samma sätt. Serienummer, utgångsdatum och Hållbarhet beskrivs i [Serienummer](#serienummer) och [Utgångsdatum och FEFO](#utgangsdatum-och-fefo) nedan.

**Slå på funktionen.** Under **System → Inställningar** finns **Använd batch- och serienummer** (av som förval). På: artikelkortet får fältet **Spårning** (**Ingen**, **Batch** eller **Serienummer**), lagerrutinerna håller reda på vilken batch saldot tillhör och **Spårbarhet** syns i Lager-menyn. Av: allt fungerar som förut. Inställningen kan bara stängas av när ingen artikel är batchstyrd.

**Spårning.** På artikelkortets flik **Lager** (under Planering) väljer du **Spårning**: **Ingen**, **Batch** (saldot hålls per batch) eller **Serienummer** (saldot hålls per nummer, ett styck per nummer). Fältet finns bara när inställningen är på, och inte för tjänster eller fantomartiklar. Spårningen kan bytas när som helst, även mellan Batch och Serienummer; gamla batcher och nummer ligger kvar och dras i vanlig ordning. Om Batch:

- Det saldo som redan finns när du slår på den hamnar i batchen **Okänd**. Okänd dras först, därefter äldsta batch först.
- Stänger du av den ligger batcherna kvar i loggen men visas och krävs inte längre. Slår du på den igen syns de som de var; uttag under tiden har dragits från Okänd.
- Är en artikel batchstyrd (eller serienummerstyrd) visas kortet **Saldo per batch** på fliken Lager: batch, lagerplats och saldo, med Okänd först. Batchnumret är en länk till [spårningen](#sparbarhet-sidan).
- Artikelimporten har en kolumn **Spårning**, se [Importera artiklar](/hjalp/artiklar#importera-artiklar).

**Inleverans.** I [Inleveransen](/hjalp/inkop#inleverans) får en batchstyrd rad fältet **Batch**: skriv eller skanna leverantörens batchnummer. Lämnar du fältet tomt blir inköpsorderns nummer batch. En rad som kommer i flera batcher delas med **Dela på flera batcher**: varje del får eget **Antal** och eget batchnummer, och **Ta bort** tar bort en del. Varje del bokförs som en egen inleverans som kan ångras för sig, och **Ångra inleverans** tar varorna ur samma batch igen. Batchen visas på inleveransen under Rapporteringar på inköpsordern.

**Tillverkning.** Färdiga varor från en tillverkningsorder får **tillverkningsordernumret som batch** — alla delinleveranser från samma order är samma batch, och inget behöver skrivas i terminalen. Materialet som dras väljs automatiskt (se nedan); i kortet **Rapportera** har en batchstyrd komponent ett val **Batch** vid **Förbruka**. Rapporteringarna visar *Inlevererad batch* och materialets batch när materialet kom ur en namngiven batch (Okänd visas inte där), och **Ångra** tar varor och material tillbaka i samma batch.

**Så väljs batch vid uttag.** **Automatiskt** (förvalet) tar äldsta batch först, och Okänd före alla andra; inom en batch gäller samma platsordning som i [Uttag med Automatiskt](#uttag-med-automatiskt). Räcker en batch inte tas resten från nästa, och det som ändå saknas dras som Okänd. Vill du styra batchen finns valet **Batch** i:

- **Förbruka** på en tillverkningsorder (terminalen väljer alltid automatiskt),
- [Utleverans](/hjalp/forsaljning#utleverans), en kolumn **Batch** per rad,
- [Lagerflytt](#lagerflytt), där batchen följer med varorna,
- [Justering](#justering) när du minskar saldot.

Valen är **Automatiskt**, **Okänd** och batcherna som har saldo (med antal). En vald batch gäller hela radens antal och kan **aldrig gå minus** — räcker den inte avvisas bokningen. Vill du ta ur två batcher bokar du två rader. Bara Okänd kan gå minus (ett serienummer har aldrig mer än ett styck). **Ångra utleverans** och återlämnat material läggs tillbaka i samma batch. En justering som ökar saldot har fältet **Batch** med platshållaren *Okänd*: skriv batchnumret, eller lämna tomt för Okänd.

**Inventering.** En batchstyrd artikel räknas **per batch**: underlaget har en rad per batch och plats, och kolumnen **Batch** visar batchnumret eller *Okänd*. Skillnaden bokas i radens egen batch. Vid **Lägg till artikel** får en batchstyrd artikel fältet **Batch** (tomt = Okänd) för att lägga till en rad för en batch som inte fanns i underlaget.

**Lagerlogg.** [Transaktioner](#transaktioner) har kolumnen **Batch** (efter **Lagerplats**) när någon rad har en batch; den är tom för Okänd. Batchnumret är en länk till Spårbarhet. Öppnas loggen för en batch står *Filtrerad på batch* överst, med **Visa alla batcher** för att ta bort filtret. Kolumnen finns också i exporten.

**Saldoimport.** [Importera lagersaldon](#importera-lagersaldon) har en sista kolumn **Batch** för batchstyrda artiklar: batchnumret, eller *Okänd* för saldot utan batch, och **Antal** gäller då batchens saldo efter importen. Tom Batch gäller hela platsen som förut. Batch på en artikel som inte är batchstyrd är ett radfel. Batcherna i en och samma import får samma ålder, så batchnumret avgör i vilken ordning de dras.

**Utskrifter.** Batchen skrivs på dokumenten:

- **Följesedel** och **pallkort till kund**: *Batch* under raden respektive som en cell **BATCH** på kortet. En batch som täcker hela raden står bara som numret, annars med antal per batch ("A123 (10), B456 (5)").
- **Faktura**: en rad *Batch: …* under orderraden med de batcher som levererats och inte ångrats när fakturan utfärdas. Raden delas inte. Kreditfakturan skriver ingen batch.
- **Plocklista**: för en batchstyrd artikel står platserna med batch i den ordning Automatiskt tar dem, t.ex. *Huvudlager — A1 · Batch L-778: 6*.
- **Räknelista** för inventering: *Batch: …* under benämningen.
- **Interna pallkort** och **lego-pallkort**: tillverkningsordernumret som **BATCH** när artikeln är batchstyrd.

**Okänd skrivs aldrig på ett dokument till kund** — där står bara namngivna batcher, och ingenting alls när artikeln inte längre är batchstyrd. Interna dokument (plocklistan) visar Okänd.

### Spårbarhet (sidan)

**Lager → Spårbarhet** (`/lager/sparbarhet`) följer en batch åt båda hållen. Raden syns i Lager-menyn bara när **Använd batch- och serienummer** är på.

Utan vald batch visar sidan en lista över batcherna, nyast först, med kolumnerna **Batch**, **Artikel**, **Ursprung** (*Inleverans*, *Tillverkning*, *Manuell* eller *Import*), **Skapad** och **Saldo**. Sök på batch- eller serienummer, artikelnummer eller benämning. Filtret **Sort** (**Alla**, **Batch**, **Serienummer**) begränsar listan, och kolumnen **Sort** visar vilket det är; ett serienummer vars utleverans ångrats märks *bränt*. Kolumnen **Utgångsdatum** och filtret **Alla utgångsdatum** (**Utgår**, **Utgångna**) visar utgångsdatum. Klicka numret för att öppna spårningen. Samma sida öppnas från länkarna till batchnummer på artikelkortets Saldo per batch, i lagerloggen, på inleveransen och i tillverkningsorderns rapporteringar. Knapparna **Alla batcher** och **Lagerlogg** tar dig tillbaka till listan respektive loggen för batchen.

För en vald batch visar sidan två kolumner (under varandra på en smal skärm):

- **Bakåt — varifrån batchen kommer:** **Inleverans** (inköpsordern, leverantören, datum och antal), **Tillverkningsorder** (och under *Material* batcherna som gick åt, som ett indraget träd som fortsätter ner genom halvfabrikat) samt **Justering** och **Inventering** som lagt till saldo.
- **Framåt — vart batchen har tagit vägen:** **Förbrukad i** tillverkningsordrar (med antal, och under *Tillverkad batch* batcherna de gav, som fortsätter framåt), **Utleverans** (kundorder, kund, följesedel, datum och antal), justeringar och inventeringar som minskat saldot (kassation, svinn) och **Kvar i lager** per lagerplats.

Länkarna går till inköpsorder, tillverkningsorder, kundorder, kund, leverantör och artikel — för dig som har behörighet till sidan. En Okänd batch är alltid slutet på en gren och visas som *Okänd batch*. *visas ovan* betyder att samma batch redan är uppritad längre upp (t.ex. vid omarbetning), och *(fortsättningen visas inte)* att spårningen blev för djup eller stor; då står också en notis överst om att spårningen är avkortad. Ångrade inleveranser och rapporteringar räknas bort; en ångrad utleverans visas som *Utleverans (ångrad)*. Sidan kan öppnas även när inställningen är av — batcherna ligger kvar i loggen.

### Serienummer

Med **Spårning: Serienummer** har varje styck ett eget nummer. Antalet är alltid ett helt antal styck, ett nummer finns som mest en gång i lager (saldo 0 eller 1) och numret är unikt per artikel (skiftlägesokänsligt). Befintligt saldo när du byter till Serienummer hamnar som *Okänd* och dras först.

**När numren skapas.** Fältet **Serienummer skapas** på artikelkortet väljer **Vid inleverans** (förval) eller **Vid utleverans**. **Serienummerserie** väljer artikelns serie ur listan (den gemensamma serien eller en egen); **Ny serie…** öppnar en liten ruta med **Namn**, **Prefix** och **Antal siffror** och **Skapa serie**. Serierna hanteras också under **System → Nummerserier** (**+ Ny serienummerserie**).

- **Vid inleverans.** I [Inleveransen](/hjalp/inkop#inleverans) skriver eller skannar du ett nummer per styck i fältet **Skriv eller skanna serienummer**; inleveransen sparas inte förrän alla nummer finns (*Ange ett serienummer per styck*). Ett kvitto skapas per styck och visas grupperat under Rapporteringar, och **Ångra inleverans** ångrar ett nummer i taget. Tillverkade styck får nästa löpnummer ur serien när de **inlevereras** (rapporten), även i terminalen — inga nummer bränns på ordrar som aldrig blir klara; *Mottagna serienummer* visas efter rapporteringen.
- **Vid utleverans.** Lagret räknas som vanligt utan nummer (som Okänd): inleverans och tillverkning ger inga nummer och uttag och inventering frågar inte efter nummer. I [Utleverans](/hjalp/forsaljning#utleverans) föreslås nästa nummer ur serien per styck (*Serienummer ur serien*); du kan skriva eller skanna ett annat, t.ex. från en märkskylt. Ett nummer som getts **bränns**: det används aldrig igen, och en **Ångra utleverans** ger heller inga nummer tillbaka — en ny utleverans får nya nummer.

**Vid uttag.** **Automatiskt** tar de äldsta numren. I **Förbruka**, [Utleverans](/hjalp/forsaljning#utleverans), [Lagerflytt](#lagerflytt) och [Justering](#justering) kan du i stället skanna eller söka (*Skanna eller sök serienummer*) eller välja bland numren i lager (*Välj bland … i lager*); terminalen väljer alltid automatiskt. En justering som ökar saldot tar ett serienummer och ett styck per justering; utan nummer bokas saldot som Okänd.

**Inventering.** Ett serienummer räknas per nummer: raden har en kryssruta **Hittad** (1 = finns, 0 = saknas). **Sätt oskannade till 0** sätter alla nummer som inte räknats till 0. Skillnaden bokas på numret.

**Saldoimport.** [Importera lagersaldon](#importera-lagersaldon) har kolumnen **Serienummer** (Antal 1 eller 0), **Batchdatum** och **Utgångsdatum**; se [Importmallar](/hjalp/importmallar#lagersaldon).

**Utskrifter.** Serienumren skrivs på följesedel, faktura (fryses när fakturan utfärdas) och plocklista, komprimerat när de är många (till exempel *SN-1001–SN-1010*). *Okänd* skrivs aldrig på ett dokument till kund.

**Spårning.** [Spårbarhetssidan](#sparbarhet-sidan) följer ett serienummer som en batch. Många nummer med samma historia visas som en grupp (*12 serienummer: SN-1001–SN-1012*). Ett bränt nummer märks *Bränt (utleveransen ångrad)*. För ett nummer som skapades vid utleverans visar bakåtgrenen *Skapat vid utleverans* med följesedel, kundorder, kund och datum, och inget mer bakåt.

Skanning av GS1-koder (till exempel batch-, utgångsdatum- och serienummerfälten i en streckkod) beskrivs i avsnittet [Skanna](#skanna).

### Utgångsdatum och FEFO

- **Utgångsdatum** anges per batch: fältet **Utgångsdatum (valfritt)** vid inleverans (även per del vid **Dela på flera batcher**) och vid en justering som ökar saldot, samt i saldoimporten. Tillverkade batcher får inleveransdagen plus artikelns **Hållbarhet (dagar)** (fält på artikelkortet för en batchstyrd artikel; tomt = inget datum).
- **FEFO** — vid uttag med **Automatiskt** tas först **Okänd**, sedan batcher med utgångsdatum (kortast först) och sist batcher utan datum, äldsta först.
- **Utgångna batcher tas inte av Automatiskt** (de kan väljas för hand). Finns bara utgånget saldo bokas bristen som Okänd minus. Behovsberäkningen räknar utgånget som saldo tills det kasseras eller flyttas till en spärrad plats.
- **Ändra.** Batchens sida under **Lager → Spårbarhet** visar **Utgångsdatum** och en knapp **Ändra** (för dig med lagerbehörighet): dialogen har **Utgångsdatum**, **Batchdatum** och **Batchnummer**. Tomt batchdatum betyder dagen batchen skapades; tomt utgångsdatum tar bort datumet.
- **Avisering.** [Aviseringen](/hjalp/aviseringar) **Utgångna batcher** visar utgångna och snart utgående batcher på ospärrade platser. Tidsgränsen sätts med **Batcher som går ut inom (dagar)** under System → Inställningar (förval 30).

## Prognos

En **prognosstyrd** artikel planeras mot ett förväntat månadsbehov, inte bara mot lagda order. Det passar **slutprodukter och reservdelar** som säljs löpande från lager. En komponent behöver i regel ingen egen prognos — dess behov följer av förälderns förslag och order. Säljs den också som reservdel går det bra att göra den prognosstyrd: behovsberäkningen låter då förälderns förslag förbruka prognosen, så ingenting räknas två gånger.

- **Prognosstyrd** är en kryssruta i sektionen **Planering** på artikelkortets [Lager-flik](/hjalp/artiklar#lager). När artikeln är sparad som Prognosstyrd visas kortet **Prognos** under Planering.
- **Snitt** är förbrukningen — kundorderutleveranser och materialuttag till tillverkningsordrar, med ångrade uttag avdragna — de senaste hela månaderna före innevarande, delat med antalet månader. Fönstrets längd ställs in under **Prognos — historik (månader)** i [System → Inställningar](/hjalp/system#installningar) (förval 12). En artikel som har rört sig i lagret först inne i fönstret delas bara med månaderna sedan den första rörelsen, så att en ny artikel inte får ett uppseendeväckande lågt snitt. Under kortet står snittet och fönstrets längd, och **Historik** listar förbrukningen per månad (**Månad**, **Förbrukat**).
- **Eget antal** ersätter snittet för en månad — för säsonger, kampanjer och kända avbrott. Tomt fält betyder att snittet gäller; **0** är ett eget antal och ger ingen prognos den månaden. **Spara** skickar bara de månader du ändrat och är avstängd tills något ändrats. Du kan bara sätta eget antal inom horisonten (**Prognos — horisont (månader)**, förval 6, från och med innevarande månad). Ändringen loggas i händelseloggen som **Prognos ändrad**.
- **Prognos** är månadens eget antal, annars snittet. **Order och behov** är det som redan är känt för månaden: kundorderrader, materialuttag på tillverkningsordrar och material till planerade tillverkningsordrar. Sena order med ett datum före innevarande månad räknas inte in — när de levereras syns de i stället som **Redan förbrukat**. **Redan förbrukat** (bara innevarande månad) är det som redan lämnat lagret i månaden. **Prognosbehov** = prognos − order och behov − redan förbrukat, aldrig under 0. Känd order **förbrukar alltså prognosen** — en order på 40 mot en prognos på 100 ger ett prognosbehov på 60, inte ett behov på 140.
- **Kortet och behovsberäkningen:** i [behovsberäkningen](/hjalp/tillverkning#behovsberakning) förbrukas prognosen dessutom av behov som *härleds* ur förslag på överordnade artiklar och ur konfigurerade orderrader. Kortet **Prognos** och artikelöversikten känner inte till härlett behov och visar prognosen förbrukad bara av order och material — behovsberäkningen kan därför visa ett mindre prognosbehov än kortet.
- Prognosbehovet fördelas per **arbetsdag** över månaden (för innevarande månad från och med i dag), samlat per vecka och daterat veckans första arbetsdag. I [Artikelöversikten](/hjalp/artiklar#artikeloversikt) syns det som rader av typen **Prognos** med numret *Prognos 2026-11 · v.47* — utan länk, eftersom det inte finns något dokument att öppna. I [behovsberäkningen](/hjalp/tillverkning#behovsberakning) räknas prognosen in i **Behov** och visas som *varav prognos*.
- **Prognosen är inget skarpt behov.** Den får behovsberäkningen att föreslå inköp och tillverkning i tid, men den flyttar aldrig ett föreslaget färdigdatum, påverkar inte kopplingen **Täcks av** / **Går till** och räknas inte av **Leveranstidskontrollen**.

## ABC-analys

**Lager → ABC-analys** (`/lager/abc-analys`, kräver en menybehörighet — samma som [behovsberäkningen](/hjalp/tillverkning#behovsberakning)) sorterar artiklarna efter **förbrukningsvärde** och delar in dem i klasserna **A**, **B** och **C**. Sidan hjälper dig välja vilka artiklar som är värda en **Beställningspunkt** och ett **Säkerhetslager** — oftast klass A och B — och vilka som kan beställas mot behov.

- **Förbrukningsvärde** = förbrukat antal under perioden × artikelns aktuella **standardkostnad**. Förbrukningen är samma som i [Prognos](#prognos): kundorderutleveranser och materialuttag, ångrade uttag avdragna. Perioden är de senaste hela månaderna före innevarande och ställs in under **ABC — period (månader)** i [System → Inställningar](/hjalp/system#installningar) (förval 12). Meningen ovanför tabellen säger vilken period och vilka gränser som gäller, t.ex. *Förbrukning 2025-11-01–2026-10-31 (12 månader), A upp till 80 %, B upp till 95 %*.
- **Gränserna** — **ABC — gräns A (%)** och **ABC — gräns B (%)**, förval 80 och 95 — avgör klassen på den **ackumulerade andelen**: artiklarna räknas i fallande värde, och en artikel är **A** så länge andelen *före* den ligger under gräns A, **B** så länge den ligger under gräns B, annars **C**. Gränserna sparas som ett par och A måste vara lägre än B. Artiklar utan förbrukning får värde 0 och blir alltid **C**.
- Urvalet är aktiva köpta och tillverkade artiklar. Fantomartiklar, tjänster och konfigurator-mallar ingår inte.
- Raden **A**, **B**, **C** överst visar antalet artiklar per klass — och, med behörighet att se priser, värde och andel. Tabellen har kolumnerna **Artikelnummer** (länk till artikelkortet), **Benämning**, **Typ** (**Köpt** eller **Tillverkad**), **ABC**, **Förbrukat**, **Förbrukningsvärde**, **Andel**, **Ackumulerat**, **Beställningspunkt**, **Säkerhetslager** och **Prognosstyrd** (**Ja** eller **–**). Filtren **Alla klasser** och **Alla typer** och sökfältet begränsar listan; summeringen överst gäller alltid hela klassningen.
- En artikel med förbrukning men utan standardpris får värde 0 och märket *saknar standardpris* — sätt priset på artikelkortet så hamnar den rätt. Standardpris 0 räknas som ett pris.
- **Priser är kontorsdata.** Utan behörighet att se priser saknas kolumnerna **Förbrukningsvärde**, **Andel** och **Ackumulerat** (och värdet i summeringen); klassen, antalen och planeringsfälten syns som vanligt.
- **Exportera** (**CSV** eller **Excel**) hämtar hela listan med samma sökning och filter. Klassen visas också på artikelkortet (**ABC-klass** i Planering), i kolumnen **ABC** i [artikelregistret](/hjalp/artiklar#artikelregistret) och i artikelexporten.

## Lagervärdering

**Lager → Lagervärdering** (endast administratörer) visar lagrets värde — saldo gånger ett värderingspris — per valfritt datum, uppdelat per varugrupp med en summarad längst ner. Saldot på [spärrade lagerplatser](#sparrade-lagerplatser) värderas som vanligt. Ange **Per datum**, välj **Metod** och eventuellt en **Varugrupp** eller **Artikelkod** (annars visas alla). Med **Gruppera** väljer du om rapporten delas upp per **Varugrupp** (förvalt, artiklar utan varugrupp hamnar under **Utan varugrupp**) eller per **Artikelkod** (artiklar utan kod under **Utan artikelkod**); valet följer med i PDF:en. Rapporten hämtas direkt när du ändrar ett val, och sidans URL följer med så vyn går att bokmärka. Ladda ner samma rapport som PDF med **Ladda ner PDF**.

De fyra metoderna:

- **Standardpris** — artikelns historiska standardpris: priset som gällde vid det valda datumet. Om datumet ligger före den första kända prisändringen används det äldsta kända priset (historiken började byggas upp när funktionen infördes, den kan inte se bakåt förbi det).
- **Senaste inköp** — priset från den senaste inleveransen (i SEK) fram till och med valt datum. Endast inleveranser som har ett pris räknas.
- **Vägt snitt** — ett glidande medelpris, uppspelat ur lagrets transaktionslogg fram till valt datum. Transaktioner utan pris (t.ex. från innan priset började sparas på lagerraden) påverkar antalet men inte snittet.
- **FIFO** — först in, först ut. Det som finns kvar på valt datum anses vara det som kom in senast, så saldot prissätts med de senaste inflödena bakåt tills hela saldot är täckt. Kolumnen À-pris visar snittet av de inflödena. Inflöden är inleveranser, tillverkningsmottagningar, positiva justeringar, inventeringar och importerade lagersaldon. En ångrad inleverans eller tillverkningsmottagning räknas inte, och en lagerflytt är inget inflöde. Inflöden utan pris hoppas över. Täcker inflödena med pris inte hela saldot värderas resten till deras snitt.

En artikel utan pris för vald metod visar **"—"** i kolumnen Värde och räknas inte med i summan — antalet syns ändå. Finns en eller flera sådana artiklar visas en hjälptext under kontrollerna med hur många det gäller, t.ex. *"3 artiklar saknar pris för vald metod och ingår inte i summan."* (böjs i singular: *"1 artikel saknar…"*).

Värderingen räknar på lagerradernas **Datum** i [Transaktioner](#transaktioner), som kalenderdagar i svensk tid. Det är dagen raden registrerades, utom för en inventering som registrerats per underlagets datum. Andra lagerrörelser kan inte bakdateras in i en tidigare värdering.
