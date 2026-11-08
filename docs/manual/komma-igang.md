# Komma igång

Nav|ERP är byggt kring kärnflödet **artikel → lager → inköp/försäljning → tillverkningsorder → tidrapportering → kalkyl**. Den här manualen beskriver alla rutiner; det här kapitlet täcker det som är gemensamt för hela systemet.

## Logga in

Systemet nås i webbläsaren på serverns adress. Logga in med e-post och lösenord.

Efter 10 misslyckade inloggningsförsök på samma konto spärras kontot i 15 minuter — även rätt lösenord avvisas då med *"För många misslyckade inloggningsförsök — försök igen om … min."* En lyckad inloggning nollställer räkningen. Spärren skyddar mot lösenordsgissning; vill en administratör släppa den tidigare räcker det att starta om API:t.

**Första gången:** systemet har inga förinstallerade konton. Gå till `/register` och skapa det första kontot — det blir automatiskt administratör och du loggas in direkt. Fältet **Engångskod** fylls i med koden som API:t skriver i sin logg när det startar (på servern: `docker compose logs api`); på så sätt kan bara den som kommer åt servern skapa administratörskontot. Koden byts vid varje omstart, om den inte är fast satt som `SETUP_CODE` i `.env`. Så fort ett konto finns stängs registreringssidan; fler användare skapas därefter av en administratör under **System → Användare**.

## Navigering

- **Sidomenyn** till vänster har ett menyval per modul och inga undermenyer: Översikt, Aviseringar, Artiklar, Inköp, Försäljning, Tillverkning, Lager, Personal & lön, Ekonomi, Rapporter, System (endast administratörer) och Hjälp — du ser bara de moduler din behörighetsgrupp ger dig (se [Behörighetsgrupper](/hjalp/system#behorighetsgrupper)). Klickar du på en modul öppnas **modulens egen sida**, där alla dess funktioner ligger grupperade i ett rutnät med en kort förklaring under varje. Därifrån går du vidare till rutinen du ska arbeta i. Funktioner som du inte har behörighet till visas inte i rutnätet. Det du använder ofta kan du lägga som genvägar under [Favoriter](#favoriter) överst i sidomenyn.
- **Sök i manualen:** på **Hjälp** finns fältet **Sök i manualen…** (och ovanför varje kapitel). Skriv ett eller flera ord och tryck **Sök**; träffarna visar kapitel, avsnittsrubrik och ett utdrag med sökorden markerade, och ett klick tar dig direkt till avsnittet. Alla ord måste finnas i samma avsnitt, och stora/små bokstäver samt å/ä/ö spelar ingen roll.
- Rutnätet är indelat i grupper med en rubrik över de funktioner som hör ihop. Under **Tillverkning** ligger till exempel **Behovsberäkning**, **Beläggning** och **Scheman** i gruppen **Planering**.
- Med **pilknappen** överst i sidomenyn fäller du ihop menyn till enbart ikoner. Valet sparas i webbläsaren och gäller tills du fäller ut den igen.
- **Toppremsan** överst på varje sida står kvar när du scrollar, liksom sidomenyn. Till höger i den finns **Favorit** (lägger till sidan du står på, se [Favoriter](#favoriter)), en klocka för [Aviseringar](/hjalp/aviseringar) och din användarmeny. Klockan visar hur många saker det finns att bevaka, med en röd siffra när något är rött och en gul annars. Siffran hämtas när sidan har laddats och sedan var femte minut, och ett klick öppnar sidan Aviseringar. Klockan visas bara för den som får öppna Aviseringar.
- **Sök eller gå till** mitt i toppremsan (eller **Ctrl+K**, **⌘K** på Mac, var som helst i Nav) öppnar ett sökfält för hela systemet. Skriv ett ordernummer, ett artikelnummer, ett kundnamn eller namnet på en sida. Från två tecken söker Nav bland kundorder och offerter, inköpsorder, tillverkningsorder, kundfakturor, artiklar, kunder och leverantörer. Under **Gå till** visas sidorna vars namn matchar, till exempel *lagervärdering* för Lagervärdering. Stora och små bokstäver och å, ä och ö spelar ingen roll. Utan söktext visar fältet **Senast öppnade**, de sidor du senast har öppnat i den här webbläsaren. **↑** och **↓** väljer, **Enter** öppnar och **Esc** stänger. Du ser bara sidor och register som din behörighetsgrupp ger dig. På mobilen är sökningen ett förstoringsglas bredvid klockan.
- **Verktygsraden på dokumenten:** på kundorder, offert, inköpsorder, förfrågan, tillverkningsorder och kundfaktura ligger knapparna för dokumentets flöde (till exempel **Lägg till rad**, **Bekräfta**, **Ta emot leverans**, **Efterkalkylera**, **Utfärda** och **Ändra status manuellt**) i en rad överst på kortet, ovanför dokumentets huvud. När du scrollar ned bland raderna står raden kvar under toppremsan och visar då dokumentets nummer och status. På mobilen följer raden med sidan som förut.
- **Ctrl+S** (**⌘S** på Mac) sparar formuläret du står i, precis som formulärets egen knapp, till exempel i **Ändra orderhuvud** eller **Lägg till rad**. Frågar formuläret något innan det sparar, som om ordern ska få en ny revision, kommer frågan som vanligt. Webbläsarens egen funktion för att spara sidan används aldrig i Nav, men övriga webbläsargenvägar fungerar som vanligt.
- **Kortkommandon:** tryck **?** för att se dem. När du inte skriver i ett fält gäller också följande:
  - **N** öppnar sidans **+ Ny …**, till exempel **+ Ny kundorder**. Håller du muspekaren över knappen står kortkommandot i verktygstipset, till exempel *Ny kundorder (N)*.
  - I en lista flyttar **↑** och **↓** en markerad rad, **Enter** öppnar den och **Esc** tar bort markeringen.
  - **Högerklick** på en rad öppnar radens ⋯-meny, där en sådan finns. Högerklickar du på en länk får du webbläsarens vanliga meny, till exempel för att öppna i en ny flik.
  - På sidor som inte är listor, och när en dialog är öppen, fungerar piltangenterna som vanligt.
- **Användarmenyn** (knappen med dina initialer) visar ditt namn och din roll, **Installera Nav** när webbläsaren kan installera Nav som program (se [Installera som app](#installera-som-app)), **Täthet** för tabellerna (se [Listor: sök, filter och bläddring](#listor-sok-filter-och-bladdring)), väljaren för färgtema — **Ljust**, **Mörkt** och **Dracula** (ett mörkt tema i lila och rosa efter [Dracula](https://draculatheme.com), som används under MIT-licensen) —, vilken version av Nav|ERP du använder, t.ex. **Version 0.8.5-alpha**, och **Logga ut**. Klickar du på versionen öppnas versionssidan på naverp.se med vad som är nytt i varje version; versionen syns också i API:ets `GET /health`. Temavalet sparas på användaren och följer med mellan datorer, och gäller på alla sidor, även stämpelterminalen och inloggningen. Administratören kan välja ett förvalt tema för företaget, låsa valet (då döljs väljaren) och installera egna teman under **System → Teman** — de syns i väljaren bredvid de tre inbyggda.
- **Notiser:** efter en del rutiner — utleverans, inleverans och rapportering på en tillverkningsorder — visas en kort notis nere till höger med vad som gjordes, ofta med **Ångra** (eller **Ångra…** när det finns något att välja). Notisen försvinner efter några sekunder; håller du muspekaren över den stannar den, och **✕** stänger den direkt. Ett fel visas längre och i rött.
- **När något hämtas:** en tabell som hämtar sina rader visar grå platshållarrader i tabellens form, och när du söker, filtrerar eller bläddrar i en lista bleknar de gamla raderna tills de nya har kommit.
- **Statusraden** längst ned (på datorn) visar om Nav har kontakt med servern — **Ansluten**, **Sessionen har gått ut** (med en länk till **Logga in**) eller **Ingen kontakt med servern** —, vem som är inloggad med vilken roll, och versionen. Den kontrollerar kontakten en gång i minuten.

## Installera som app

Nav är en webbsida och fungerar i alla moderna webbläsare. Vill du kan du dessutom installera Nav som ett program på datorn: det får då ett eget fönster utan webbläsarens adressfält och flikar, en egen ikon i Start-menyn, Dock eller programlistan, och öppnas alltid på **Översikten**. Det är fortfarande samma Nav — inget laddas ned, och programmet uppdateras när servern uppdateras.

- **Chrome och Edge** (Windows, Mac och Linux, även Chromium på Linux): välj **Installera Nav** i användarmenyn. Knappen visas bara när webbläsaren erbjuder installationen.
- **Safari på Mac** (Safari 17 eller senare): användarmenyn säger hur — välj **Arkiv → Lägg till i Dock**.
- **iPhone och iPad**: tryck på **Dela** och välj **Lägg till på hemskärmen**.
- **Firefox** på datorn kan inte installera webbprogram; använd Nav i en flik som vanligt.

Installationen kräver att Nav nås över **https** — en installation som öppnas med `http://` i det lokala nätet kan bara läggas som ett vanligt bokmärke, och då visas ingen knapp. Programfönstrets namnlist följer ditt färgtema.

## Favoriter

Överst i sidomenyn finns gruppen **Favoriter** med dina egna genvägar — till exempel **Kundorder**, **Inköpsorder** eller en lista med ett visst urval. Favoriterna sparas på användaren, så de följer med mellan datorer och till mobilen, och ingen annan ser dem. Så länge du inte har några står det en kort förklaring under rubriken.

- **Lägg till en funktion:** för musen över en rad på en modulsida, till exempel **Försäljning**, och klicka på stjärnan till höger på raden. Funktionen läggs sist under **Favoriter** med samma namn som i rutnätet. Ett klick på den ifyllda stjärnan tar bort den igen. På en pekskärm syns stjärnorna hela tiden.
- **Lägg till sidan du står på:** klicka på **Favorit** i toppremsan, bredvid klockan för Aviseringar. Skriv ett **Namn** — förslaget är sidans rubrik — och klicka på **Lägg till**. Sidan sparas med sina filter och sin sökning, så en favorit som "Bekräftade kundordrar" öppnar listan med samma urval (vilken sida i listan du stod på sparas inte). Det går också att spara ett kort, till exempel en kund du ofta arbetar med. När sidan redan är en favorit är stjärnan på **Favorit** ifylld, och ett klick tar bort den.
- **Ändra:** klicka på **Ändra** vid rubriken **Favoriter** för att byta namn, flytta favoriterna upp och ned med pilarna eller **Ta bort** dem. Ändringarna sparas när du klickar på **Spara**.
- Du kan ha högst 20 favoriter, och ett namn får vara högst 60 tecken.
- När sidomenyn är ihopfälld visas favoriterna som ikoner — för musen över en ikon för att se namnet.
- En favorit till en sida som din behörighetsgrupp inte längre ger dig visas inte, men den finns kvar och kommer tillbaka om du får behörigheten igen. Under **Ändra** syns alla dina favoriter.
- **Var favoriterna visas:** högst upp i sidomenyn, som kortet **Favoriter** på Översikten, eller båda. Kortet väljer du under [Anpassa Översikten](#anpassa-oversikten); där visas favoriterna som rutor med samma ikoner som i menyn, och kortet har en egen **Ändra**. Tar du bort bocken **Visa favoriterna i sidomenyn** under **Ändra** (och sparar) försvinner gruppen ur sidomenyn, och favoriterna syns bara på kortet. Valet sparas på användaren.

## Översikten

Startsidan visar materialflödet i fyra stationer — Inköp, Lager, Tillverkning, Försäljning — med antal öppna ordrar och varningar (försenade ordrar, negativa saldon). Varje station är klickbar: Inköp, Tillverkning och Försäljning öppnar modulens sida, och Lager landar direkt på saldolistan som stationens siffror beskriver. Under den finns:

- **Att bevaka** — de sju första raderna ur [Aviseringar](/hjalp/aviseringar): negativa saldon, försenade ordrar, förfallna fakturor och annat som behöver åtgärdas, röda före gula. **Visa alla (N)** öppnar sidan Aviseringar, och finns inget att bevaka står det "Inget att bevaka just nu." Raderna du ser beror på din behörighetsgrupp. Signalerna under stationerna ("2 försenade", "3 med negativt saldo") räknas ur samma aviseringar, så kortet och stationerna visar alltid samma sak. Saknar du behörighet till en typ står det "Se Aviseringar" i stället för en siffra. En order räknas som försenad när någon av raderna som inte är fullt mottagen/levererad har passerat sitt leveransdatum; offerter och levererade ordrar räknas aldrig.
- **Pågående tillverkning** och **Senaste lagerhändelser**.

Stationerna, raderna och knappen **+ Ny order** följer din behörighetsgrupp: det du inte får öppna visas som vanlig text i stället för som länk, och **+ Ny order** visas bara för den som kan öppna tillverkningsorderlistan.

### Anpassa Översikten

Knappen **Anpassa** i Översiktens sidhuvud, bredvid **+ Ny order**, öppnar dialogen **Anpassa Översikten**. Där väljer du själv vilka kort startsidan visar och i vilken ordning. Valet sparas på ditt konto och gäller bara dig — andra användare, även i samma behörighetsgrupp, behåller sin egen Översikt.

Standardvyn har fyra kort:

| Kort | Innehåll |
|---|---|
| **Materialflöde** | De fyra stationerna Inköp, Lager, Tillverkning och Försäljning |
| **Att bevaka** | De första raderna ur [Aviseringar](/hjalp/aviseringar) |
| **Pågående tillverkning** | De första pågående och frisläppta tillverkningsordrarna |
| **Senaste lagerhändelser** | De sex senaste lagerrörelserna |

Utöver dem kan du lägga till kortet **Favoriter** (dina [favoriter](#favoriter) som rutor, hela bredden) och följande kort. Varje kort finns bara med i dialogen om du får öppna listan som kortets **Se alla** leder till, till exempel kundorderlistan för **Leveranser denna vecka**:

| Kort | Innehåll | Se alla |
|---|---|---|
| **Leveranser denna vecka** | Bekräftade kundordrar och kundordrar under tillverkning vars nästa leveransdatum infaller senast på söndag, sena först | Kundorder |
| **Inleveranser denna vecka** | Bekräftade och dellevererade inköpsordrar vars nästa leveransdatum infaller senast på söndag (ett bekräftat datum går före det önskade), sena först | Inköpsorder |
| **Beläggning denna vecka** | Resurserna med planerad tid den här veckan, mest belastade först, med timmar mot kapacitet och procent | Beläggning |
| **Förfallna kundfakturor** | Samma rader som aviseringen med samma namn | Försäljning → Öppna poster |
| **Leverantörsfakturor att betala** | Samma rader som aviseringen med samma namn | Inköp → Öppna poster |
| **Offerter att följa upp** | Samma rader som aviseringen med samma namn | Offerter |
| **Öppna avvikelser** | Öppna reklamationer och avvikelser, de vars **Åtgärd senast** har passerat först | Avvikelser |

Korten visar högst sex rader, och **Visa alla (N)** när listan är längre. En röd prick betyder försenad: leveransdatumet har passerat, fakturan har förfallit, ärendets **Åtgärd senast** har passerat eller resursen är belagd över 100 %. En gul prick betyder i dag, snart eller minst 90 % beläggning. En resurs utan veckoschema visar timmarna utan procent ("inget schema"). Kan ett korts uppgifter inte läsas står det "Kunde inte läsa … just nu." i kortet, och resten av Översikten visas som vanligt.

Dialogen har en rad per kort. Kryssrutan **Visa** bestämmer om kortet visas, och knapparna ↑ och ↓ flyttar det i ordningen. **Spara** sparar valet, **Avbryt** stänger utan att spara och **Återställ standard** tar bort ditt val, så att de fyra korten i standardvyn visas i den ordning de har ovan. Ett nytt kort visas aldrig av sig självt — bara om du väljer det. Är inget kort valt står det "Inga kort valda." tillsammans med knappen **Anpassa**.

**Materialflöde** och **Senaste lagerhändelser** tar hela sidans bredd. Alla andra kort är halva kort: står två sådana efter varandra delar de en rad, och ett ensamt halvt kort tar hela bredden. Checklistan **Kom igång** (för administratörer) ligger kvar överst och styrs av sin egen knapp **Dölj**.

Översikten hämtar bara det korten du valt behöver. Döljer du **Materialflöde** och **Att bevaka** räknar sidan därför inte fram alla aviseringar, vilket gör den snabbare att öppna — korten för fakturor och offerter hämtar då bara sina egna. Konton med **Endast läsning** kan också anpassa sin egen Översikt.

## Listor: sök, filter och bläddring

Alla registerlistor (artiklar, kunder, leverantörer, ordrar, saldon, transaktioner, tidrapporter…) fungerar likadant:

- **Sökfältet** ovanför tabellen söker medan du skriver — t.ex. på artikelnummer/benämning eller ordernummer/namn beroende på lista.
- **Filterval** (artikeltyp, varugrupp, orderstatus…) ligger bredvid sökfältet.
- **Bläddring**: listan visar 50 rader åt gången som standard; under tabellen står "Visar X–Y av Z" med sidknappar.
- **Rader per sida**: bredvid "Visar X–Y av Z" finns valet **Rader per sida** (25/50/100/250). Valet sparas på ditt konto och gäller sedan alla listor du öppnar, tills du ändrar det igen.
- Sökning, filter och sida ligger i sidans adress — du kan bokmärka eller dela en filtrerad vy.
- **Kolumner** längst till höger ovanför tabellen väljer vilka kolumner listan visar. Kolumnen med numret eller namnet du klickar på och kolumnerna för kryssrutor och ⋯-menyn finns alltid kvar. Ikonen på knappen färgas när listan skiljer sig från hur den är byggd.
- **Kolumnbredd**: dra i kanten till höger om en kolumnrubrik för att göra kolumnen smalare eller bredare; dubbelklicka på kanten för att återställa den. Med tangentbordet: tabba till kanten och tryck **←** eller **→**. Ändringen gäller kolumnen tills du återställer den.
- Valen av kolumner och bredder sparas på ditt konto för varje lista för sig — kundorder och offerter har till exempel var sin uppsättning — och följer med mellan datorer. **Återställ kolumnerna** i **Kolumner** ger tillbaka listan som den är byggd. Listan över lagersaldon och inventeringslistan har inga kolumnval.
- **Täthet** i användarmenyn gäller alla tabeller i Nav: **Normal** eller **Kompakt**, som ger lägre rader så att fler får plats på skärmen. Valet sparas på ditt konto. På mobilen, där tabellerna visas som kort, ändras ingenting.

## Artikelväljaren

Där en artikel ska väljas (orderrader, tillverkningsorder, struktur) finns en **sökbar artikelväljare**: klicka i fältet så visas de första träffarna, skriv för att söka på artikelnummer eller benämning, välj med piltangenterna + Enter eller med klick.

## Vanliga knappar

| Knapp | Betydelse |
|---|---|
| **+ Ny …** | Öppnar formulär för att skapa en post |
| **Spara** | Sparar formuläret; "Sparat" visas vid lyckad sparning |
| **Ändra / Ta bort** | Radknappar i tabeller; Ta bort kräver bekräftelse |
| Namn/nummer i en lista | Öppnar postens kort eller detaljsida |

## Licens

Nav|ERP är fri programvara, © 2026 Urban Källefors, och sprids under **GNU General Public License version 3 eller senare** (GPL-3.0-or-later). Du får använda, sprida och ändra programmet enligt licensens villkor; det levereras utan garanti. Den fullständiga licenstexten finns i filen `LICENSE` i källkoden.

Färgtemat **Dracula** bygger på [Dracula-paletten](https://draculatheme.com) (© 2023 Dracula Theme) och används under MIT-licensen — licenstexten finns i `licenses/Dracula-MIT.txt`.
