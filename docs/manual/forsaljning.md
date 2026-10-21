# Försäljning

Försäljningsmodulen i Nav|ERP omfattar kundregistret och flödet offert → kundorder → leverans → fakturering.

## Översikt

Menyvalet **Försäljning** öppnar modulens sida, där alla försäljningsfunktioner ligger grupperade i ett rutnät:

- **Order** — **Kundorder**, **Utleverans** och **Försändelser**.
- **Fakturering** — **Fakturor** och **Prislistor**.
- **Reskontra** — **Öppna poster** och **Betalningar**.
- **Register** — **Kunder** och **Grunddata**.

Knappen **+ Ny kundorder** leder till orderlistan där ordern registreras. Nyckeltal och bevakningslistor för hela verksamheten finns på **Översikt**, startsidan.

Kundorderlistan och orderkorten ligger under **Försäljning → Kundorder** (`/forsaljning/ordrar`). Gamla länkar och bokmärken till ett orderkort på den tidigare adressen skickas vidare automatiskt.

## Kunder

**Försäljning → Kunder** listar alla kunder med kolumnen **Kundnr** först; sökrutan matchar kundnummer och namn. **+ Ny kund** registrerar **Kundnummer** (valfritt — lämnas fältet tomt tilldelas nästa nummer automatiskt ur nummerserien, se [Nummerserier](/hjalp/system#nummerserier)), namn och adress med postnummer/postort/**Land** — kontaktpersoner läggs upp på kundkortets flik **Kontakter**. Knappen **Importera** läser in kunder, kontakter och leveransadresser från exportfiler (se [Importera kunder](#importera-kunder)).

Klicka på kundens namn för att öppna **kundkortet** med fem flikar — samma upplägg som leverantörskortet, plus en adressflik och en prisflik:

- **Allmänt** — **Kundnummer** (unikt; kan skrivas över i efterhand, upptagna nummer avvisas), namn, aktiv och **Besöksadress** med postnummer/postort/**Land** (ISO-2-kod, t.ex. "SE"; standardvärde "SE"). Kundnumret skrivs ut som **Kundnr** på offert och orderbekräftelse, och fryses på fakturan när den utfärdas — en senare omnumrering ändrar inte redan utfärdade fakturor. Landet skrivs bara ut på dokumenten när det avviker från Sverige. **Vårt leverantörsnummer** (fritext) är det nummer kunden själv har på oss som leverantör i sitt system — det skrivs ut på offert, orderbekräftelse och faktura som "Vårt leverantörsnr hos er: …" och hämtas alltid från kundkortets aktuella värde, även på en redan utfärdad faktura. **Webbsida** visas på kundkortet som en klickbar länk; saknas protokoll läggs `https://` till automatiskt. Fältet **Kod på pallkort** (**Systemets förval**, **Ingen**, **Streckkod**, **QR-kod**) styr om kundens pallkort får en kod; **Systemets förval** följer systeminställningen. Kryssrutan **Visa tilläggspriser** styr förvalet när offert och orderbekräftelse med konfigurerade rader skrivs ut eller mejlas (varje vals tillägg skrivs då ut efter valet) och vad fakturan visar när den utfärdas — se [Offert och kundorder](#offert-och-kundorder).
- **Adresser** — kundens övriga adresser:
  - **Fakturaadress** med ett eget **Fakturanamn** (töms fältet används kundens namn i stället), postnummer/postort/**Land** samt **E-post för faktura**.
  - **Leveransadresser** — en lista med valbara leveransadresser (**+ Ny leveransadress**), var och en med **Benämning** (t.ex. "Huvudlager"), adress, postnummer, postort och **Land**. Knappen **Kopiera från besöksadressen** i dialogen fyller i adressfälten från Allmänt-flikens besöksadress (visas bara när en besöksadress finns). En adress kan markeras som **Förvald** — den förifylls då på nya kundordrar. Max en adress åt gången är förvald; markeras en ny flyttas markeringen automatiskt. Landkolumnen visas bara i listan när adressen avviker från Sverige.
- **Villkor & frakt** — organisationsnummer, VAT-nummer, leveransvillkor, betalningsvillkor, speditör, kundnummer hos speditör (väljs ur [Grunddata](/hjalp/grunddata)-registren och visas med sitt namn, t.ex. "30 dagar netto"), **Prislista** — kopplar kunden till en registrerad prislista (se [Prislistor](#prislistor)); standardvalet är **Ingen prislista** — och **Kundrabatt (%)**, en generell rabatt som slår igenom sist i priskedjan, se [Priskedjan](#priskedjan) nedan. Kryssrutan **Privatperson** byter etiketten **Organisationsnummer** till **Personnummer** och gör att offert, orderbekräftelse och faktura till kunden visar priser inklusive moms — raden "Priser inklusive moms" ovanför radtabellen, à-pris och radsumma inklusive moms, och summablocket blir **Summa inkl. moms** (offert/orderbekräftelse) respektive **Att betala** (faktura) följt av **Varav moms**; bokföringen påverkas inte, fakturan bokförs precis som vanligt, och visningen fryses vid utfärdandet så att ett senare ändrat kryss inte ändrar en redan utfärdad faktura. Kryssrutan **Samlingsfaktura** gör att kunden faktureras via rutinen [Samlingsfakturering](#samlingsfakturering) i stället för från fakturadialogen — se nedan. **Förvald fraktprodukt** väljer kundens standardtransport, se [Förvald fraktprodukt](#forvald-fraktprodukt). Här anges också kundens **Leveransdagar**, **Dagarna avser** och **Transportdagar**, se [Leveransdagar](#leveransdagar). Under organisationsnummer och VAT-nummer väljer **Fakturaleverans** hur kunden vill ha sina fakturor — **E-post** (förvalet) eller **E-faktura (Peppol)** — och **Peppol-id** anger kundens adress i Peppol-nätet (`0007:5560000000`: schemat `0007` är svenskt organisationsnummer, sedan numret utan bindestreck). Tomt **Peppol-id** betyder `0007:` följt av kundens organisationsnummer. Knappen **Kontrollera** frågar Peppols katalog om id:t (det som står i fältet, även osparat) och svarar **Finns i Peppol** med företagets registrerade namn och vilka dokument det tar emot, **Finns inte i Peppol**, eller ett felmeddelande; i sandboxmiljön står det att svaret kommer därifrån. Fälten visas inte för **Privatperson**. Se [E-faktura (Peppol)](#e-faktura-peppol).
- **Kontakter** — flera kontakter med namn, telefon, mobil, e-post, kommentar och möjlighet att markera en **Huvudkontakt**.
- **Priser** — kundens egna prisregler, se [Kundpriser](#kundpriser) nedan.

Uppe till höger på kortet finns **+ Ny offert** och **+ Ny kundorder** — båda skapas med kunden förvald.

### Leveransdagar

Kunder kan ha fasta leveransdagar på samma sätt som [leverantörer](/hjalp/inkop#leveransdagar). På kundkortets flik **Villkor & frakt** finns:

- **Leveransdagar** — kryssrutorna **Mån**, **Tis**, **Ons**, **Tor**, **Fre**, **Lör** och **Sön** ("Lämna tomt om alla dagar fungerar."). Ingen dag vald betyder att kunden saknar fasta dagar.
- **Dagarna avser** — **Systemets förval (…)**, **Ankomst till kunden** (dagar då kunden tar emot leveranser) eller **Avsändning från oss** (dagar då vi skickar).
- **Transportdagar** — arbetsdagar från avsändning till leverans. Tomt betyder systemets förval; platshållaren visar förvalet, t.ex. *Förval: 0*.

Spara med **Spara**. Förvalet för läge och transportdagar sätts under [System → Inställningar → Leveransdagar](/hjalp/system#leveransdagar) (förval för kunder: **Avsändning från oss**, 0 transportdagar); veckodagarna har inget förval. Transportdagar räknas i arbetsdagar, se [Leveransdagar](/hjalp/inkop#leveransdagar) i Inköp för vad som räknas som arbetsdag.

Kundorderns **Förväntat leveransdatum** är **dagen kunden får varan**. Det vi måste ha klart är **avsändningsdagen**: leveransdatumet minus transportdagarna (och, i avsändningsläget, den senaste avsändningsdag som hinner fram).

- **Ny kundorder** och **Ny offert:** väljer du en kund med leveransdagar fylls **Förväntat leveransdatum (valfritt)** i med det tidigast möjliga leveransdatumet. Förslaget räknar bara kundens egna dagar och tar inte hänsyn till lager, material eller beläggning — det gör [Leveranstidskontroll](#leveranstidskontroll), som även räknar lager, inköpsledtider och beläggning i produktionen. Under fältet står en sammanfattning, t.ex. "Kunden tar emot tis · 2 transportdagar" eller "Vi skickar mån, tor". Ändrar du datumet själv rör förslaget det inte mer.
- **Varning** under datumfältet, bara när kunden har leveransdagar och aldrig som spärr: i ankomstläget "Kunden tar inte emot leveranser på onsdagar." (på en helgdag "… på helgdagar."), i avsändningsläget "Datumet passar inte våra avsändningsdagar till kunden (mån, tor + 2 transportdagar)."
- **Planering:** behovsberäkningen, artikelöversikten och färdigdatumsförslaget räknar kundorderns behov på **avsändningsdagen**, se [Föreslaget färdigdatum](/hjalp/tillverkning#foreslaget-fardigdatum). Kundorderkortet visar fortfarande leveransdatumet, och [leveransprecisionsrapporten](/hjalp/rapporter) mäter mot leveransdatumet.

Kundimporten läser inte fälten — de sätts på kortet.

## Importera kunder

**Försäljning → Kunder → Importera** öppnar en guide med tre flikar — **Kunder**, **Kontakter** och **Leveransadresser** — som tillsammans tar in en fullständig kundexport. Endast administratörer har åtkomst. Filer läses som CSV (semikolon, komma och tabb känns alla igen — även teckenkodningen identifieras automatiskt) eller Excel (.xlsx, bara det första bladet läses). Varje flik kör sin egen guide i fyra steg: **Fil**, **Kolumner**, **Förhandsgranska** och **Resultat**.

Kundexporten består av flera separata filer. **Fliken Kunder** körs en gång per fil, alltid i den här ordningen:

1. **Lista** — skapar kunderna (matchning på kundnummer; finns kunden redan uppdateras den i stället) med kortnamn, organisationsnummer och VAT-nummer — och med villkor, speditör, prislista och rabatt när de kolumnerna finns med i filen (se nedan).
2. **Postadress** — ersätter kortnamnet med det juridiska namnet ("Postadress – Namn") och fyller i besöksadress och land.
3. **Fakturaadress** — uppdaterar fakturaadressen för de kunder som avviker från sin postadress.

Kör alltså de tre filerna efter varandra genom samma flik, utan att kryssa i **Hoppa över rader som redan finns** mellan körningarna — annars skrivs Postadress- och Fakturaadress-filernas fält aldrig in. Kontakter och leveransadresser importeras efteråt, var för sig, på sina egna flikar (kräver att kunderna redan finns). Körs Lista-filen i stället *efter* Postadress skriver dess kortnamn över det juridiska namnet — sätt då kolumnen "Namn" till **Importera inte** i steget **Kolumner**.

1. **Fil** — välj filen med filväljaren, så läses den in direkt. Första raden ska innehålla kolumnrubriker. Max 10 000 rader per fil.
2. **Kolumner** — varje kolumn i filen mappas mot ett fält; kända rubriker föreslås automatiskt (se listorna nedan) och kolumner satta till **Importera inte** hoppas över. Kryssrutan **Hoppa över rader som redan finns** lämnar poster som redan finns helt orörda i stället för att uppdatera/skapa dem — se [Hoppa över befintliga rader](/hjalp/artiklar#hoppa-over-befintliga-rader). Klicka **Förhandsgranska** för att gå vidare.
3. **Förhandsgranska** — varje rad visas som **Ny**, **Uppdateras** eller **Hoppas över** tillsammans med eventuella fel och varningar. En ruta ovanför tabellen listar de register som kommer att skapas automatiskt (se nedan). Knappen **Importera** är låst tills alla fel är åtgärdade — rätta filen och börja om från steget **Fil**.
4. **Resultat** — visar hur många rader som skapades, uppdaterades och hoppades över, plus vilka register som skapades. De överhoppade listas i tabellen **Överhoppade rader**, som kan sparas som fil eller skrivas ut. **Klar** går tillbaka till kundregistret.

### Fliken Kunder

Kolumner som känns igen automatiskt (exportfilens egna rubriker inom citattecken) och fältet de mappas mot:

- **Lista-filen**: "Kund" → Kundnummer, "Namn" → Namn (kortnamnet — ersätts av det juridiska namnet i nästa steg), "Organisationsnr" → Organisationsnummer, "Momsreg.nr" → VAT-nummer (importeras som det står i filen — cellen innehåller ibland ett VAT-nummer, ibland ett organisationsnummer). Har kolumnerna tagits med i exportens listinställning känns även "Betalningsvillkor", "Leveransvillkor", "Leveranssätt" → Leveranssätt/speditör, "Prislista", "Rabatt" → Kundrabatt (%), "Vårt leverantörsnummer", "Samlingsfaktura", "Privatperson" och "Webbsida" igen — exportera gärna Lista med dem så att en enda körning både skapar kunderna och sätter villkoren. **Samlingsfaktura** och **Privatperson** tolkas som kryss: Ja/Nej, 1/0, x eller true/false — och för Samlingsfaktura räknas lägena "Per kund", "Per leveransadress" osv. (allt som börjar med "Per") som ikryssat, "Nej" som avmarkerat. Ett annat värde ger radfel. Övriga Lista-kolumner saknar motsvarighet i Nav och lämnas omappade: Prioritet, Kundgrupp, Moderbolag (kund), Välj leveransadress, Personnummer, Kundkategori, Kundnummer faktura, Kreditlimit, Försäkringsavgift, Bankgiro, PlusGiro, Faktureringsavgift, Betalningspåminnelse, Påminnelseavgift, Öresavrundning, Faktura i vänteläge, Factoring, Distributionsmetod, Terminskurs, Strökund, Order/Faktura/Ärende som XML, EORI-nr samt Flera order/fakturor i e-post.
- **Postadress-filen**: "Kund" → Kundnummer, "Postadress – Namn" → Namn (det juridiska namnet — skriver över Lista-filens kortnamn, vilket är avsikten), "Postadress – Adressrad 1/2/3" → Adress/Adressrad 2/Adressrad 3 (slås ihop till en adress med radbrytning; Adressrad 4 saknar motsvarighet), "Postadress – Postnummer" → Postnummer, "Postadress – Stad" → Postort, "Postadress – Land" → Land. Den kortare kolumnen "Namn" mappas automatiskt bara i Lista-filen — i Postadress-, Fakturaadress- och övriga filer lämnas den omappad så att det juridiska namnet aldrig skrivs över av misstag.
- **Fakturaadress-filen**: "Avviker från postadress", "Fakturaadress – Namn" → Fakturanamn, "Fakturaadress – Adressrad 1/2/3" → Fakturaadress/Fakturaadressrad 2/Fakturaadressrad 3, "Fakturaadress – Postnummer"/"Fakturaadress – Stad"/"Fakturaadress – Land" → Fakturapostnummer/Fakturapostort/Fakturaland.

Övriga mappningsbara fält: Kontaktperson, E-post, Telefon, E-post för faktura. **Kundnummer** är obligatoriskt (märkt *). Namn behövs bara för nya kunder — kolumnen kan lämnas omappad och cellen får vara tom vid uppdatering; en ny kund utan namn stoppas med "Namn saknas — obligatoriskt för ny kund".

Regler att känna till:

- **Allt eller inget.** Innehåller filen ett enda radfel importeras ingenting — det som förhandsgranskningen visar som fel måste rättas i filen först. Varningar stoppar däremot aldrig importen.
- **Tomma celler skriver aldrig över.** Vid uppdatering lämnas fält med tom cell orörda; vid ny kund lämnas de tomma.
- **Ogiltig e-postadress stoppar inte raden.** Adressen hoppas över med varningen "Ogiltig e-postadress '…' — fältet lämnades tomt", och fältet behåller sitt tidigare värde vid uppdatering. Gäller både **E-post** och **E-post för faktura**.
- Samma kundnummer två gånger i filen ger fel på den andra raden.
- Numeriska kundnummer räknar upp kundernas nummerserie, så nästa **+ Ny kund** får ett nummer ovanför det högsta importerade. Serien sänks aldrig, och kundnummer med bokstäver importeras som de är utan att röra serien (se [Nummerserier](/hjalp/system#nummerserier)).
- **Land** och **Fakturaland** måste vara en landskod med två bokstäver (t.ex. "SE"); en tom cell blir "SE" för en ny kund och rörs inte vid uppdatering.
- **Avviker från postadress = Nej** lämnar alla fakturafält orörda — kunden fortsätter använda sin postadress som fakturaadress. Är fältet **Ja** (eller kolumnen inte mappad) läses fakturaadressens övriga kolumner in.
- **Betalningsvillkor, Leveransvillkor, Leveranssätt och Prislista skapas automatiskt** i respektive register om värdet i filen inte redan finns där (namnmatchning, skiftlägesokänsligt) — förhandsgranskningen visar vilka som kommer att skapas. Ett betalningsvillkor av typen "30 dagar netto" får koden **30**, vilket styr förfallodatumberäkningen (se [Leverantörsreskontra](/hjalp/inkop#leverantorsreskontra)); övriga skapade poster får koden av namnet versaliserat.

### Fliken Kontakter

Läser exportens **Referenser**-fil. Mappningsbara fält (filens rubrik inom citattecken där den skiljer sig från fältnamnet): Kundnummer ("Kund"), Namn ("Referens – Namn"), Förvald, Telefon, Mobiltelefon, E-post, Anmärkning, Faxnummer (läggs till i Anmärkning som "Fax …", eftersom kontakter saknar ett eget faxfält). Kundnummer och Namn är obligatoriska.

- Kunden måste redan finnas i registret (importera fliken **Kunder** först) — annars blir raden ett radfel.
- En kontakt som redan finns hos kunden (samma namn, skiftlägesokänsligt) hoppas över — kontakter uppdateras aldrig via import, bara skapas.
- Förekommer samma namn två gånger på samma kund i filen hoppas den senare raden över ("Kontakten förekommer flera gånger i filen") — den första raden vinner, även om raderna skiljer sig i telefon, e-post eller anmärkning.
- Bara en kontakt per kund kan vara **Förvald**. Har kunden redan en huvudkontakt (eller har en tidigare rad i filen redan satt en) blir raden en varning i stället, och kontakten skapas som vanlig kontakt.

### Fliken Leveransadresser

Läser exportens **Leveransadress**-fil. Mappningsbara fält (filens rubriker "Leveransadress – …" känns igen automatiskt): Kundnummer ("Kund"), Namn ("Leveransadress – Namn" — etiketten på adressen; saknas den blir den "Leveransadress"), Adressrad 1–3 (slås ihop som på kundfliken), Postnummer, Stad, Land.

- Kunden måste redan finnas i registret.
- En rad utan adress (exporten skriver en rad per kund även när ingen leveransadress är registrerad) hoppas över, liksom en adress som är identisk med kundens egen adress (postnummer, ort och land normaliserade).
- En adress som redan finns registrerad på kunden hoppas också över.
- Kryssrutan **Sätt som förvald leveransadress** gör att en kund som ännu saknar en förvald adress får sin första importerade adress som förvald — aldrig en till om kunden redan har en förvald sedan tidigare.

## Prislistor

**Försäljning → Prislistor** är registret över prislistor: gemensamma staffelprissättningar som kopplas till en eller flera kunder via kundkortets flik Villkor & frakt. Listan visar **Kod**, **Namn**, **Beskrivning** och **Antal rader**; sökrutan matchar kod eller namn. **+ Ny prislista** registrerar **Kod**, **Namn** och en valfri **Beskrivning**.

Klicka på en rad för att öppna **prislistans kort**:

- Huvudet (**Kod**, **Namn**, **Beskrivning**) redigeras och sparas med knappen **Spara**.
- **Prisrader** — en rad per artikel och staffelsteg, med kolumnerna **Artikel**, **Från antal** och **À-pris (kr)**. **+ Lägg till rad** öppnar en dialog där artikeln väljs med artikelväljaren; **Från antal** och **À-pris (kr)** anges (`Från antal` minst 0, fritt antal decimaler; priset med två decimaler). Samma artikel kan ha flera rader med olika **Från antal** för att bygga en staffel, t.ex. 1 st → 90 kr och 10 st → 80 kr. Varje rad har egna knappar för **Ändra** och **Ta bort** — vilken artikel raden gäller kan inte ändras i efterhand, bara tas bort och läggas till på nytt.
- **Ta bort prislista** tar bort hela listan, men avvisas (409) så länge en kund fortfarande pekar på den.

Vid prissättning väljs den rad vars **Från antal** är det högsta som fortfarande är ≤ det beställda antalet — se [Kundpriser](#kundpriser) för hela priskedjan.

## Kundpriser

Utöver prislistorna kan varje kund ha egna prisregler, oberoende av vilken prislista (om någon) kunden är kopplad till. De hanteras på **kundkortets flik Priser**:

- Tabellen visar kundens registrerade regler: **Artikel/Grupp**, **Från antal**, **Pris**, **Rabatt %**.
- **+ Ny prisregel** öppnar en dialog:
  - **Måltyp** — radioknapparna **Artikel** eller **Artikelgrupp** väljer om regeln gäller en enskild artikel (artikelväljaren) eller en hel artikelgrupp (dropdown ur artikelgruppsregistret).
  - **Från antal** — staffelgränsen, precis som på prislistan.
  - **Pristyp** — radioknapparna **Specialpris (kr)** eller **Rabatt (%)** väljer om regeln sätter ett fast pris eller en procentuell rabatt.
  - Beroende på valet visas fältet **Specialpris (kr)** eller **Rabatt (%)**.
  - Målet (artikel eller artikelgrupp) låses när regeln väl är skapad — **Ändra** visar det som ett skrivskyddat fält; är regeln fel skapad tas den bort och läggs till på nytt.
- **Ta bort** tar bort en regel efter bekräftelse.

### Priskedjan

Priset på en orderrad slås upp i fem steg, mest specifika regel vinner:

1. **Kundens egen prisregel för artikeln** (Priser-fliken, Måltyp Artikel).
2. **Kundens prisregel för artikelns artikelgrupp** (Priser-fliken, Måltyp Artikelgrupp).
3. **Kundens prislista** (kundkortets Villkor & frakt-flik).
4. **Artikelns eget försäljningspris** (artikelkortets fält **Försäljningspris (kr)**, se [Artiklar](/hjalp/artiklar)).
5. **Kundens rabatt (%)** (kundkortets Villkor & frakt-flik, fältet **Kundrabatt (%)**) — bara när inget av steg 1–2 gav en träff. Rabatten läggs på priset från steg 3 eller, saknas det, steg 4; finns inget sådant grundpris ger den inget pris alls.

Inom varje steg med staffelrader (Priser-fliken och prislistan) vinner raden med det högsta **Från antal** som fortfarande är ≤ det beställda antalet. En regel av typen **Rabatt (%)** i steg 1–2 räknas alltid på det pris som skulle gällt ett steg längre ner i kedjan (prislistan eller, saknas den, artikelns försäljningspris) — finns inget sådant grundpris ger regeln inget pris alls, den faller inte tyst vidare i kedjan. Saknas pris i alla fem stegen går det inte att lägga raden.

Offert- och orderformulären skickar alltid ett explicit pris, men API:t löser priset automatiskt enligt kedjan ovan när **à-pris utelämnas** på en orderrad — det är tänkt för en extern produktkonfigurator som bara skickar artikel, antal och kund.

**Varianter** av en konfigurerbar artikel tar kundens avtal på mallen när varianten själv saknar prisregel och prislisterad — se [Variantens pris](/hjalp/artiklar#varianter).

## Importera kundpriser

Fliken **Kundpriser** på **Artiklar → Importera** läser in kundernas artikelpriser (kundkortets flik **Priser**, se [Kundpriser](#kundpriser)) från exporten **Prislista Försäljning** — en rad per kund och artikel med rubrikerna **Kund** (kundnumret), **Pris** och **Rabatt**, som känns igen automatiskt. Kolumner: **Artikelnummer**, **Kundnummer** och **Pris** är obligatoriska; **Rabatt (%)** är valfri. Namn, Kundens art.nummer, Ställpris och Prisdatum importeras inte (kundens eget artikelnummer har inget fält i systemet).

- Kunden (matchad på **kundnummer**) och artikeln måste redan finnas.
- Priset sparas som en **artikelregel med Specialpris (kr)** från antal 1 — exportfilen bär ingen staffel.
- **Rabatten räknas in i priset.** En prisregel är antingen ett pris eller en rabatt, så importen sparar nettopriset Pris × (1 − Rabatt/100) och varnar på raden att rabatten bakats in.
- Har kunden redan en regel för artikeln (från antal 1) uppdateras den till det nya priset — även en regel som var en rabatt blir då ett specialpris. Med **Hoppa över rader som redan finns** lämnas den orörd. Samma kund och artikel två gånger i filen är ett fel.

## Offert och kundorder

Kundordrar och offerter är samma flöde: en offert är en order i status **Offert** som blir kundorder när den bekräftas.

- **+ Ny offert** skapar ordern i status Offert — används när kunden ska ta ställning till pris först.
- **+ Ny kundorder** skapar och bekräftar i samma steg — används när affären redan är klar.

Båda finns på **Försäljning → Kundorder** och på kundkortet. I formuläret väljer du kund (förvald från kortet), ev. förväntat leveransdatum, anteckning samt orderrader: artikel via artikelväljaren, antal, enhet, **Á-pris** och **Rabatt (%)**. Ordern får ett KO-nummer.

**Konfigurerbara artiklar:** en mall (se [Artiklar](/hjalp/artiklar#konfigurator)) visas i artikelväljaren med märkningen **Konfigurerbar** och öppnar dialogen **Konfigurera** med mallens valgrupper, giltighetsfel per grupp och priset för valet (kundens pris när kunden är vald, på det antal raden har). I läget **Variantartiklar** hämtar **Lägg in** varianten om den finns och skapar den annars, och raden får variantartikeln — därefter är det en vanlig rad med [variantens priskedja](/hjalp/artiklar#varianter); under artikelfältet står *Varianten 63000-B-1200 skapades* respektive *fanns redan*. I läget **Beställningsvara** stannar mallen som radens artikel: **Lägg in** lägger valen på raden, valraderna (t.ex. *Lock: Lock B*, *Bredd: 1 200 mm*) visas under artikelfältet, **Á-pris** och **Rabatt (%)** förifylls från konfigurationens pris (kundens pris på mallen plus tilläggen, kundens rabatt) och kan skrivas över, och **Konfigurera om** öppnar dialogen igen innan raden sparas. Samma mall får ligga flera gånger på en order med olika val. **Avbryt** (eller Esc) tömmer artikelfältet. Själva mallen kan aldrig sparas utan konfiguration; via API:t svarar systemet att artikeln är en beställningsvara och ska konfigureras. Samma dialog finns på **Lägg till rad** på orderkortet.

**Ändra konfiguration:** på orderkortet har beställningsvarurader och variantrader knappen **Ändra konfiguration** så länge ordern är i status Offert, Bekräftad eller Under tillverkning och raden varken har levererats, har en tillverkningsorder eller är fakturerad (annars är knappen dold, och servern vägrar med samma skäl). Dialogen är förifylld med radens val. För en beställningsvara ersätts valen och priset — även ett á-pris du skrivit själv, vilket dialogen påpekar; för en variantrad byter raden till den variant valen ger (den hämtas eller skapas) och prissätts om enligt priskedjan — ligger varianten redan som vanlig rad på ordern vägras bytet. Ändras antalet på en konfigurerad rad räknas priset om med mallens staffel, som på vanliga rader. Valen skrivs ut under raden på offert, orderbekräftelse, faktura, plocklista och följesedel; tilläggspriserna bara på offert/orderbekräftelse/faktura och bara med **Visa tilläggspriser** (se [Skicka offert och orderbekräftelse via e-post](#skicka-offert-och-orderbekraftelse-via-e-post)).

**Pris- och rabattförifyllning:** så snart artikel och antal är ifyllda (och kunden är vald) slås [priskedjan](#kundpriser) upp automatiskt och fyller i **Á-pris** och **Rabatt (%)** — ändras antalet över en staffelgräns räknas priset om på nytt. Skriver du själv i något av fälten vinner det manuella värdet ("manuellt vinner") — en senare antalsändring skriver aldrig över ett pris eller en rabatt du själv har fyllt i, och byts artikeln nollställs det manuella låset så nästa artikel prisförifylls som vanligt. Samma förifyllning och samma regel gäller när en rad läggs till eller ändras på ett befintligt orderkort.

**Enhet på raden:** dropdownen **Enhet** visar artikelns grundenhet och alternativa enheter (se [Artiklar](/hjalp/artiklar)) och förifylls med artikelns **Försäljningsenhet**. Byter du enhet räknas ifyllt antal och à-pris om direkt (500 kg ⇄ 100 st vid faktorn 1 st = 5 kg); à-pris-etiketten visar `kr/{enhet}`. Radantal och pris lagras alltid i grundenheten, men kortet och PDF:erna visar raden i den valda enheten. Lagersaldot förs alltid i grundenheten.

**Avrundning:** har artikeln en **Avrundning** (Lager-fliken på artikelkortet) avrundas radens antal uppåt till närmaste multipel i grundenheten när raden sparas eller antalet ändras — 12 på en artikel med Avrundning 5 blir 15 — och priskedjan slås upp på det avrundade antalet. Se [Artiklar](/hjalp/artiklar#lager).

Formuläret har också fälten **Kundens ordernummer** och **Referens** (valfria) samt en **Leveransadress**-select med kundens registrerade leveransadresser (se kundkortets Adresser-flik) — kundens förvalda adress är förifylld, och **Ingen** går alltid att välja.

**Ny leveransadress direkt på ordern.** Ska ordern till en adress som inte finns på kunden väljer du **+ Ny leveransadress…** sist i listan och fyller i **Benämning** (t.ex. "Bygget Solna" — skrivs ut som första raden i leveransadressblocket), **Adress**, **Postnummer**, **Postort** och **Land**. Utan kryss i **Spara på kunden** gäller adressen bara den här ordern: den syns inte bland kundens leveransadresser och kan inte väljas på andra ordrar, och den tas bort när ordern byter till en annan adress. Med kryss läggs den till bland kundens leveransadresser (inte som förvald) och kan användas igen. Samma val finns i **Ändra orderhuvud** på orderkortet, där orderns egen adress visas med tillägget *(bara den här ordern)*.

Kundens ordernummer och referens skrivs ut som **Ert ordernummer** / **Er referens** på offerten och orderbekräftelsen, tillsammans med ett **Leveransadress**-block när en leveransadress är vald. Plocklistan visar också leveransadressen och fälten. Landet skrivs ut i adressblocket — kundens, fakturaadressens och leveransadressens — bara när det avviker från Sverige. Har kunden ett **Vårt leverantörsnummer** ifyllt skrivs det ut som "Vårt leverantörsnr hos er: …". Är kunden markerad **Privatperson** (se [Kunder](#kunder)) visas priserna inklusive moms — raden "Priser inklusive moms" ovanför radtabellen, à-pris och radsumma inklusive moms, och summablocket blir **Summa inkl. moms** följt av **Varav moms**.

Ordern får automatiskt kundens **Leveransvillkor**, **Betalningsvillkor** och **Speditör** från kundkortets flik Villkor & frakt, och de skrivs ut på offerten och orderbekräftelsen när de är satta.

**Orderhuvudet.** Orderkortet inleds med ett kort som visar status, **Rev**, valuta (och fakturanummer när ordern är fakturerad) tillsammans med orderns uppgifter: **Kund** (klickbar till kundkortet), **Kundens ordernummer**, **Referens**, **Leveransdatum**, de tre villkoren, **Leveransadress** och **Notering**. Knappen **Ändra** öppnar dialogen **Ändra orderhuvud**, där kundens ordernummer, referens, villkoren och leveransadressen redigeras på ett ställe och sparas i ett svep, så länge ordern är i status Offert, Bekräftad eller Under tillverkning. Leveransdatum och notering sätts när offerten skapas och visas bara.

### Leveransdatum per rad

Orderns **Leveransdatum** gäller alla rader. Ska en rad levereras ett annat datum ger du den ett eget:

- I **Ny kundorder** och **Ny offert** kryssar du i **Eget leveransdatum per rad**, så får varje rad fältet **Leveransdatum**. Tomt betyder samma som ordern.
- På orderkortet finns fältet **Leveransdatum** i **Lägg till rad** och i radens **Ändra**, med texten "Tomt = som ordern" under. Töm fältet så följer raden orderns datum igen.
- En rad med eget datum visar **Leveransdatum …** under benämningen. På offerten, orderbekräftelsen och plocklistan står orderns **Leveransdatum** i huvudet och radens eget datum under raden, bara när det avviker.

Radens datum, annars orderns, är det datum planeringen räknar behovet på: [artikelöversikten](/hjalp/artiklar#artikeloversikt), [färdigdatumsförslaget](/hjalp/tillverkning#foreslaget-fardigdatum) (även **Skapa TO** på raden) och [Leveranstidskontrollen](#leveranstidskontroll) — på avsändningsdagen, se [Leveransdagar](#leveransdagar). Kolumnen **Leveransdatum** i kundorderlistan och bevakningslistan på [Översikten](/hjalp/komma-igang#oversikten) visar **nästa leveransdatum**: det tidigaste datumet bland raderna som inte är fullt levererade. Leveransprecisionsrapporten mäter fortfarande hela ordern mot orderns datum.

Vill du veta vilket leveransdatum du faktiskt kan lova, använd knappen **Leveranstidskontroll** på orderkortet (och i **Ny kundorder**) — den räknar fram ett datum ur lager, material och produktionens beläggning och låter dig sätta **Förväntat leveransdatum** med **Använd datumet**. Se [Leveranstidskontroll](#leveranstidskontroll).

Längst ner på kortet visar sektionen **Historik** ordens egna händelser (statusövergångar och radändringar) — se [Händelselogg](/hjalp/system#handelselogg).

### Statusflöde

Under radlistan ligger en **knapprad** med de åtgärder som är möjliga i orderns aktuella status. Radlistan visar dessutom kolumnerna **Á-pris** och **Rabatt** (rabatten visas bara när den är större än 0) samt **Belopp** per rad (antal × á-pris × (1 − rabatt/100)) och avslutas med **Summa**; beloppet är detsamma oavsett vilken enhet raden visas i.

**Täckningsbidrag.** Under radlistan visas orderns **täckningsbidrag** och **täckningsgrad**, räknade mot varje artikels senaste sparade **förkalkyl** (självkostnad per styck — se [Artiklar](/hjalp/artiklar#kalkyl)). Samma siffra visas live medan du sätter priset, både i **Lägg till rad** och när en ny offert skapas: `TB … kr · TG … %`.

På en konfigurerad beställningsvarurad mäts täckningsbidraget i stället mot **förkalkylen för konfigurationen**: kostnaden för radens egna struktur (material och operationer för just de valda alternativen) vid radens antal, inte mallens sparade kalkyl. I **Lägg till rad** ändras TB när du ändrar antalet, och på orderkortet räknas kostnaden om när raden sparas, när du använder **Ändra konfiguration** och när antalet ändras. Under täckningsbidraget står *Förkalkyl för konfigurationen, <datum>* med datumet kostnaden räknades. Rader vars konfiguration saknar användbar kalkyl räknas som *saknar förkalkyl*. Hur tillverkningsordern för en beställningsvara skapas och rapporteras beskrivs under [Tillverkningsorder för beställningsvara](/hjalp/tillverkning#tillverkningsorder-for-bestallningsvara).

Rader vars artikel saknar förkalkyl kan inte mätas. De ingår i orderns summa men **inte** i täckningsbidraget, och texten säger hur många de är — en saknad kalkyl räknas alltså aldrig som kostnad noll, vilket hade överdrivit marginalen. Saknar samtliga rader kalkyl visas ingen siffra alls.

1. **Bekräfta** — offerten blir kundorder. Rader kan läggas till (**Lägg till rad** i knappraden), ändras (**Ändra** — antal, enhet, á-pris och rabatt) och tas bort (**Ta bort**) så länge ordern är i status Offert, Bekräftad eller Under tillverkning; antalet kan aldrig sättas under det som redan är levererat, och en rad med levererat gods eller en kopplad tillverkningsorder kan inte tas bort — kopplingen blockerar borttagning även om tillverkningsordern har avbrutits, men en avbruten TO räknas inte längre med i kolumnen **I tillverkning**.
2. **Starta tillverkning** — markerar att tillverkning pågår. En rad med en tillverkningsartikel kan i stället kopplas till en riktig tillverkningsorder med knappen **Skapa tillverkningsorder** direkt på raden (kräver status Bekräftad eller Under tillverkning) — se [Skapa från kundorder](/hjalp/tillverkning#skapa-fran-kundorder). Det flyttar automatiskt ordern till **Under tillverkning** om den inte redan är det, och raden får kolumnen **I tillverkning** med det kopplade antalet och, för varje tillverkningsorder, TO-numret som länk och dess status (t.ex. **Frisläppt**, **Pågår**, **Klar**). När raden har en tillverkningsorder men inte är helt täckt heter knappen **Skapa TO för resten (N st)**; när tillverkningsordrarna täcker hela radens antal, eller raden är helt levererad, visas ingen knapp — en extra tillverkningsorder skapas då med **+ Ny tillverkningsorder**. På en konfigurerad beställningsvarurad finns knappen också; tillverkningsordern får radens val (se [Tillverkningsorder för beställningsvara](/hjalp/tillverkning#tillverkningsorder-for-bestallningsvara)).
3. **Leverera** — ange rad, lagerplats och antal i dialogen; ett utleveranssaldo bokförs i lagret och en följesedel skapas (se [Följesedel](#foljesedel)). Delleveranser stöds. Hela ordern rapporteras smidigast i rutinen [Utleverans](#utleverans), som nås direkt med knappen **Utleveransrutinen**. En felrapporterad leverans ångras rad för rad (se [Ångra utleverans](#angra-utleverans)); en **Levererad** order går då tillbaka till **Under tillverkning**.
4. **Fakturera** — synlig när ordern är **Levererad**; knappen tar dig till **Försäljning → Fakturor** med skapa-dialogen förifylld på ordern (se [Fakturor](#fakturor)). Knappen tilldelar inget fakturanummer själv — det sker när fakturan **utfärdas** i fakturamodulen — och ordern blir automatiskt **Fakturerad** först när alla dess rader är fullt fakturerade.
5. **Förlorad…** — bara i status Offert; se [Giltighetstid och förlorade offerter](#giltighetstid-och-forlorade-offerter).
6. **Öppna igen** — bara i status Förlorad.
7. **Avbryt order** — möjligt i status Offert och Bekräftad.

| Status | Betydelse |
|---|---|
| Offert | Ej bekräftad; rader redigerbara |
| Bekräftad | Kundorder |
| Under tillverkning | Tillverkning pågår |
| Levererad | Utlevererad från lager |
| Fakturerad | Avslutad |
| Avbruten | Avbruten |
| Förlorad | Offerten gick inte hem; orsak registrerad, låst som en avbruten |

### Giltighetstid och förlorade offerter

**Giltig t.o.m.** är sista dagen offerten gäller. Fältet finns i formuläret **Ny offert** (inte i **Ny kundorder**), förifyllt med dagens datum plus inställningen **Offertens giltighetstid (dagar)** (förval 30, se [Inställningar](/hjalp/system#installningar)); töm fältet för en offert utan giltighetstid. På en befintlig offert ändras datumet i **Ändra orderhuvud** och visas i orderhuvudet; ändringen höjer revisionen eftersom datumet skrivs ut. Offert-PDF:en och offertmejlet skriver *Offerten gäller till och med 2026-11-20.* under huvudet; orderbekräftelsen skriver inte ut det.

Passerar datumet markeras offerten **Utgången** i orderhuvudet och i orderlistan, som har en egen kolumn **Giltig t.o.m.** för offerter. En utgången offert byter aldrig status av sig själv: den står kvar som offert tills du bekräftar den, markerar den som förlorad eller ändrar datumet. Offerter som snart går ut eller har gått ut dyker upp bland [Aviseringarna](/hjalp/aviseringar) som **Offerter att följa upp**.

**Förlorad…** (bara i status Offert) öppnar dialogen **Markera offerten som förlorad**. Välj **Orsak** (obligatorisk, ur de aktiva [förlustorsakerna](/hjalp/grunddata#forlustorsaker)), skriv ev. en **Kommentar** och klicka **Markera som förlorad**. Offerten får status **Förlorad** och orderhuvudet visar **Förlustorsak**, **Markerad förlorad** (när och av vem) och **Kommentar**. En förlorad offert är låst som en avbruten: inga rad- eller huvudändringar och ingen PDF eller e-post. Skillnaden mot **Avbryt order** är att en förlorad offert räknas i [Offertuppföljningen](/hjalp/rapporter#offertuppfoljning), medan en avbruten offert ses som felregistrerad och inte räknas i hit rate.

**Öppna igen** (bara i status Förlorad) frågar först och gör sedan ordern till en vanlig offert igen; förlustorsaken rensas men finns kvar i orderns historik. Giltigheten rörs inte, så ändra **Giltig t.o.m.** om den har gått ut. Sätter du status Förlorad med [Ändra status manuellt](#manuell-statusandring) blir det utan orsak (rapporten visar *Ingen orsak angiven*), och byter du från Förlorad till annan status rensas orsaken.

### Manuell statusändring

Knappen **Ändra status manuellt** längst till höger i orderkortets knapprad låter dig sätta vilken status som helst, åt vilket håll som helst — även från Avbruten eller Fakturerad. Välj status i dialogen och klicka **Byt status**; en bekräftelsedialog visas eftersom ändringen hoppar över orderflödets regler:

- Statusbytet bokför **aldrig** lager — utleveranser som redan är bokförda ligger kvar, och inget levereras ut av att sätta status Levererad.
- Att sätta **Fakturerad** manuellt skapar **ingen** faktura — skapa och utfärda en faktura i fakturamodulen i stället (se [Fakturor](#fakturor)). Äldre ordrar som redan bär ett fakturanummer (fakturerade innan fakturamodulen fanns) behåller det även om statusen backas.

### Revision

Ordern har ett revisionsnummer (**Rev** i orderkortets huvud) som börjar på 1. Varje gång orderns innehåll sparas — ändringar i orderhuvudet (referenser, leveransadress, villkor) och på raderna (lägg till, ändra, ta bort) — ställs frågan **"Ska ordern få en ny revision?"**: **OK** räknar upp revisionen med 1, **Avbryt** sparar ändringen utan att revisionen ändras. Hela orderhuvudet sparas i ett svep, så frågan kommer en gång även om du ändrar flera fält samtidigt. Statusändringar, utleveranser och e-postutskick påverkar inte revisionen. Revisionen skrivs ut direkt efter ordernumret på offerten och orderbekräftelsen (t.ex. **Orderbekräftelse KO-1024 / 2**, inte på fakturan), så mottagaren ser vilken version av ordern de har; utskriften kan stängas av med inställningen **Visa orderns revision på dokument** (se [System](/hjalp/system)).

### Skicka offert och orderbekräftelse via e-post

Orderns detaljsida har en sektion **E-post** längst ner (kräver att SMTP är konfigurerat under [System → Inställningar](/hjalp/system)):

- **Skicka offert** (endast i status Offert) mejlar offerten som PDF-bilaga utan att ändra status.
- **Skicka orderbekräftelse** mejlar orderbekräftelsen som PDF-bilaga. På en offert är det detta som bekräftar den — status blir **Bekräftad**, men bara om utskicket lyckas. Från senare statusar skickas bekräftelsen om utan statusändring. Avbrutna ordrar kan inte mejlas.
- Dialogen förifyller **Mottagare** (kundens huvudkontakts e-post; saknas den används en eventuell e-postadress från kundimporten eller en äldre registrering), **Ämne** och **Meddelande** — alla redigerbara.
- Har någon av orderns artiklar uppladdade ritningar visas kryssrutan **Bifoga ritningar (N filer)**, ikryssad från början — bocka ur den för att bara skicka dokumentet (se fliken Filer i [Artiklar](/hjalp/artiklar)).
- Har ordern konfigurerade rader (se [Beställningsvara](#offert-och-kundorder)) visas kryssrutan **Visa tilläggspriser** bredvid PDF-länkarna — ikryssad enligt kundkortets inställning **Visa tilläggspriser**. Med kryss skrivs varje vals tillägg ut efter valet, t.ex. *Lock: Lock B (+ 240,00)*; utan kryss bara valet. Valet gäller både **Offert (PDF)**/**Orderbekräftelse (PDF)** och mejlets bilaga, sparas i e-postloggen och används oförändrat av **Skicka om**.
- **Offert (PDF)**, **Orderbekräftelse (PDF)** och **Plocklista (PDF)** (se [Plocklista](#plocklista)) laddar ner dokumenten utan att skicka något. Offertens och orderbekräftelsens radtabell har en egen kolumn **Rabatt**; cellen är tom för rader utan rabatt.
- Kortets utskickshistorik visas under knapparna; hela loggen finns i [System → E-postlogg](/hjalp/system).

## Leveranstidskontroll

Leveranstidskontrollen räknar fram den **tidigaste avsändningsdagen** och det **tidigaste leveransdatumet** för en kundorder — utifrån vad som finns i lager, vad som redan är på väg in, ledtiden på material som måste köpas och produktionens lediga tid. Den kan köras på en kundorder, på raderna i **Ny kundorder** eller på en fristående sida för artiklar och antal.

Själva kontrollen är en beräkning som läser och räknar — den ändrar ingenting. Datumet sätts, och tillverkningsordrar skapas, först när du själv klickar **Använd datumet** (se [Skapa tillverkningsordrar för det som saknas](#skapa-tillverkningsordrar-for-det-som-saknas)).

### Starta en kontroll

- **På kundorderkortet:** knappen **Leveranstidskontroll** finns när ordern är i status Offert, Bekräftad eller Under tillverkning. Dialogen visar resultatet för orderns rader.
- **I Ny kundorder:** samma knapp räknar formulärets rader (och vald kund) innan ordern är sparad.
- **Fristående:** **Försäljning → Leveranstidskontroll**. Lägg in rader med **Lägg till rad** — artikel och antal; en konfigurerbar mall konfigureras med **Konfigurera**, som på en orderrad — välj om du vill en **Kund** och klicka **Kontrollera**.

Knappen **Använd datumet** i dialogen sätter orderns **Förväntat leveransdatum**; i **Ny kundorder** fylls fältet i. Knappen visas bara när kontrollen räknats med en kund — utan kund är datumet avsändningsdagen och dialogen visar i stället texten "Välj kund för att räkna med kundens transportdagar." Raderna på ordern ändras aldrig — har några rader ett [eget leveransdatum](#leveransdatum-per-rad) behåller de det, och dialogen säger hur många de är. Kräver behörigheten Försäljning eller Tillverkning.

### Skapa tillverkningsordrar för det som saknas

Räknade kontrollen med tillverkade artiklar som saknas i lager, visas under resultatet i dialogen på kortet för en **bekräftad** kundorder (eller en order **under tillverkning**) kryssrutan **Skapa tillverkningsordrar för det som saknas (3 st)** — antalet är de tillverkningsordrar som skulle skapas. Den är förvald. Med kryssrutan ikryssad skapar **Använd datumet** tillverkningsordrarna och sätter orderns **Förväntat leveransdatum** i ett svep; avkryssad sätts bara datumet. På en offert, i **Ny kundorder** och på den fristående sidan finns ingen kryssruta — tillverkningsordrar kopplas bara till en bekräftad orders rader.

- Det skapas **en tillverkningsorder per brist-parti på varje nivå** i strukturen: kundorderradens artikel (kopplad till raden, som **Skapa tillverkningsorder** — raden visar därefter **I tillverkning**) och de halvfabrikat som saknas under den (vanliga tillverkningsordrar med noteringen "Skapad från leveranstidskontroll för KO-…"). Antalet är bristen (avrundat enligt artikelns **Avrundning**), färdigdatumet är det datum kontrollen räknade för partiet.
- Ordrarna **planeras i exakt de veckor kontrollen räknade med**, så att det lovade datumet håller kapaciteten — de syns direkt i [Beläggning](/hjalp/tillverkning#belaggning). Halvfabrikaten skapas före sin förälder.
- **Inköp skapas inte.** Material som måste köpas syns i Behovsberäkningen, som skapar inköpsorderna med **Skapa ordrar**.
- Tillverkningsordrarna **låses** i de veckor kontrollen räknade, så att **Planera** i [Beläggning](/hjalp/tillverkning#belaggning) inte flyttar dem — det lovade datumet håller tills någon väljer **Lås upp** på operationen.
- Allt eller inget: går något fel skapas ingen order alls och datumet ändras inte.
- Efter lyckat resultat visar dialogen de skapade tillverkningsordrarna med länkar (till dem du har behörighet att öppna) och orderkortet läses om.
- **Läget kan ha ändrats:** har någon annan hunnit boka kapacitet eller skapa en order sedan kontrollen, eller har antalet tillverkningsordrar som skulle skapas ändrats, visas "Läget har ändrats sedan kontrollen — det nya datumet är …" och dialogen byter till den nya kontrollen. Ingenting har skapats — granska resultatet och klicka **Använd datumet** igen.
- Finns det inget att skapa (allt täcks av lager och öppna ordrar) visas ingen kryssruta, och **Använd datumet** sätter bara datumet.

### Vad som räknas

Kontrollen går igenom varje rad, och för en tillverkad artikel varje nivå i strukturen:

1. **Det som redan finns.** Lagersaldo och öppna inköps- och tillverkningsordrar läggs i datumordning. Det som redan finns räknas mot det **projicerade saldot**: det kontrollen kan ta på en dag är det som finns kvar utan att saldot någon gång längre fram går under noll för de behov som redan är lovade (andra kundordrar och tillverkningsordrars materialbehov). Exempel: 10 i lager, ett inköp om 10 som kommer om två veckor och en kundorder om 10 om sex veckor — en ny order på 10 kan skickas i dag. Det som täcks av en öppen order räknas som klart den dag ordern kommer. Kontrollerar du en befintlig kundorder räknas inte orderns egna rader som behov.
2. **Det som saknas och köps.** Bristen får **huvudleverantörens ledtid** i leverantörskatalogen, tillsammans med leverantörens leveransdagar och transportdagar (se [Leveransdagar](/hjalp/inkop#leveransdagar) i Inköp). Saknar artikeln huvudleverantör räknas den som tillgänglig direkt, och en notering visas.
3. **Det som saknas och tillverkas — på alla nivåer.** Strukturen löses upp (fantomartiklar går genom), varje komponent räknas på samma sätt, och när materialet är klart läggs beredningens operationer i tur och ordning på **ledig tid per resurs och vecka**. Den lediga tiden är resursens veckoschema — eller, utan schema, dess kapacitet i timmar per dag — × kapacitetsfaktor minus beläggningen från öppna tillverkningsordrar (planerade operationer räknas i sina planerade veckor) — samma beläggning som visas i [Beläggning](/hjalp/tillverkning#belaggning). En operation kan delas över flera veckor och räknas klar sista arbetsdagen i den vecka den blir färdig; nästa operation får börja samma vecka om det finns tid kvar. Innevarande vecka räknas bara från i dag. Last som inte ryms i en vecka (t.ex. försenade tillverkningsordrar) skjuts framåt till nästa vecka innan kontrollen lägger sina operationer. **Legooperationer** tar legoresursens ledtid i arbetsdagar. Operationer märkta **Kalkyl** räknas inte.
4. **Avsändningsdag och leveransdatum.** Avsändningsdagen är nästa arbetsdag efter att allt är klart; finns allt i lager redan i dag är den i dag. **Leveransdatum** är avsändningsdagen plus kundens transportdagar och leveransdagar (se [Leveransdagar](#leveransdagar)). Utan kund, på den fristående sidan, är svaret avsändningsdagen.

**Konfigurerade rader:** en beställningsvara räknas på sin konfigurerade struktur och rutt. En variant som redan finns räknas som sin artikel, annars på den struktur den skulle få — kontrollen skapar aldrig en variant.

### Läsa resultatet

Överst står **Leveransdatum** och **Avsändningsdag** — eller *Inget datum — se noteringarna* när något inte går att räkna. Under dem visas en rad per orderrad med *Artikel*, *Antal*, *Klar* och *Vad som begränsar*. Den sista kolumnen följer den **kritiska kedjan** steg för steg, från det som kommer sist och nedåt, till exempel:

- *Köps 40 PLÅT-2 — ankomst 2026-11-02 (Stål AB, ledtid 10 dagar)*
- *BÄNK-1 op 20 Bocka — Kantpress (110), vecka 45–46, klar 2026-11-13*
- *Lagersaldo — 5 st SKRUV-6*
- *SKRUV-6: IO-1042 2026-10-28*

En försenad order (orderns eget datum ligger före i dag) visas med "(försenad)" och ett utkast till inköpsorder med "(utkast)", t.ex. *SKRUV-6: IO-1042 2026-09-01 (försenad)* och *SKRUV-6: IO-1050 2026-11-02 (utkast)*; är det båda står det "(försenad, utkast)".

Raden med senast klar-datum bestämmer ordern; det är den du behöver påverka för att få ett tidigare datum.

### Noteringar

Under resultatet kan noteringar visas när något i underlaget saknas. Gäller samma sak flera artiklar, ordrar eller resurser samlas de i en notering per rad, t.ex. *Resurserna 100, 200 och 700 saknar veckoschema och timmar per dag — kapaciteten räknas inte*:

- *<artikel> saknar huvudleverantör — räknad som tillgänglig direkt*
- *<dokumentnr> saknar datum — räknad som tillgänglig direkt* (en öppen order utan datum)
- *<dokumentnr> är försenad — räknad som tillgänglig direkt*
- *<dokumentnr> är ett utkast — räknat som tillgång*
- *<artikel> saknar beredning — räknad som tillgänglig direkt*
- *Resurs <kod> saknar veckoschema och timmar per dag — kapaciteten räknas inte* (ange **Veckoschema (kapacitet)** eller **Kapacitet (timmar per dag)** på resursen)
- *Legoresurs <kod> saknar ledtid — räknad som 0 dagar*
- *Resurs <kod> har <n> h beläggning utan datum som inte räknas*
- *Kapaciteten räcker inte inom två år* — raden får då inget datum och ordern inget leveransdatum.

### Vad kontrollen inte gör

- Den **bokar ingenting**: den reserverar varken tid eller material, så två kontroller efter varandra ser inte varandra. Lovar du två kunder samma lediga tid får båda samma svar.
- Den gör ingen detaljplanering per dag och räknar inga köer — bara ledig tid per vecka.
- **Odaterad beläggning** (tillverkningsordrar utan **Planerat färdigdatum**) ingår inte; en notering visar hur många timmar det gäller.
- Alternativa leverantörer eller resurser prövas inte — bara huvudleverantören och operationens egen resurs.

## Fakturor

**Försäljning → Fakturor** är fakturaregistret — registret över kundfakturor. En faktura kan bygga på rader från flera kundordrar hos samma kund (samlingsfaktura) eller fyllas i för hand, och är redigerbar som **Utkast** innan den bokförs.

### Skapa en faktura

**+ Ny faktura**. Välj **Kund** — då visas kundens **Ordrar att fakturera**: kundorder som är (helt eller delvis) levererade och har outfakturerat antal kvar. Kryssa i en eller flera ordrar för att hämta deras rader som en förhandsgranskning, grupperad per ordernummer. Antalet är förifyllt med resten men går att ändra, liksom **À-pris**, **Rabatt %** (förifylld från orderradens rabatt) och **Moms %** — momssatsen ärvs från artikeln men kan ändras per rad. Enskilda rader kan tas bort med **Ta bort**.

Är kunden markerad **Samlingsfaktura** (se [Kunder](#kunder)) visar knappen **Ny faktura** i stället texten "Kunden faktureras med samlingsfaktura." med länken **Öppna Samlingsfakturering** — dialogen spärrar mot att skapa en vanlig faktura för kunden (API:et svarar 409 om det ändå försöks).

Bokade, ofakturerade försändelser för kunden visas som förbockade fraktrader i gruppen **Frakt**, se [Frakt på fakturan](#frakt-pa-fakturan).

Knappen **Lägg till fri rad** lägger till en rad utan artikelkoppling — **Beskrivning**, **Antal**, **À-pris** och **Moms %** skrivs in för hand (t.ex. frakt eller andra avgifter).

Klicka **Skapa faktura** för att spara som **Utkast**. Fakturan får sitt fakturanummer i FA-serien först när den utfärdas. Under varje fakturarad som är kopplad till en order skriver PDF:en ut "Order KO… · Ert ordernr …" (ordernumret alltid, kundens ordernummer när det finns) — det gäller alla fakturor, inte bara samlingsfakturor. Fria rader får ingen sådan rad.

En fakturarad som hämtats från en konfigurerad orderrad bär en kopia av radens konfiguration: valen skrivs ut under benämningen på fakturan (och på en kreditfaktura som kopierar raden), med tilläggspriserna enligt kundens **Visa tilläggspriser** när fakturan utfärdas — eftersom fakturans PDF arkiveras då ändras utseendet inte efteråt. Samlingsfakturering gör likadant.

### Delfakturering

En kundorder behöver inte faktureras i sin helhet på en gång. **Ordrar att fakturera** visar bara det som återstår att fakturera per orderrad: **rest = utlevererat − redan fakturerat** (fakturor i Utkast räknas som fakturerade, så samma rad inte kan hamna på två fakturor samtidigt). Sänk antalet i förhandsgranskningen för att bara fakturera en del av en rad — nästa faktura mot samma order visar då automatiskt vad som återstår. Systemet spärrar mot att fakturera mer än vad som är levererat.

### Samlingsfaktura

Kryssa i flera ordrar samtidigt i **Ordrar att fakturera** (alltid samma kund) för att samla dem på en och samma faktura. Varje order visas som en egen grupp med ordernumret som rubrik i förhandsgranskningen, men resultatet blir en enda faktura med ett fakturanummer.

Kunder med **Samlingsfaktura** ikryssat faktureras i stället via [Samlingsfakturering](#samlingsfakturering).

### Fakturans statusflöde

Statusflödet är **Utkast → Utfärdad → Betald**:

- **Utfärda** (bekräftelsedialog: "Fakturan får nummer och låses") tilldelar fakturanummer ur **FA**-serien (se [System → Nummerserier](/hjalp/system)) och **OCR-nummer**, räknar fram **Förfallodatum** ur betalningsvillkoret och fryser kundens namn, fakturaadress och betalningsvillkor som de såg ut vid utfärdandet — senare ändringar på kundkortet påverkar aldrig en redan utfärdad faktura. Samtidigt **bokförs** fakturan automatiskt, se [Bokföring av fakturan](#bokforing-av-fakturan) nedan. Går bara från **Utkast**, och bara om fakturan har minst en rad.
- **Betald** sätts automatiskt — det finns ingen knapp för det. Så snart en registrerad betalning stänger fakturans öppna post helt (se [Kundreskontra](#kundreskontra) nedan) blir statusen Betald av sig själv, och en makulerad betalning som gjorde detta öppnar fakturan igen till Utfärdad. En kreditfaktura som blir helt kvittad mot en annan post på samma sätt blir Betald.
- **Avbryt** går bara från **Utkast** → Avbruten — rättelser efter utfärdande görs i stället med en [kreditfaktura](#kreditfaktura).

Avbruten är ett slutläge. Betald kan gå tillbaka till Utfärdad (se ovan), men aldrig längre än så — det finns ingen väg tillbaka till Utkast. Huvudet (Betalningsvillkor, Notering) och raderna kan bara ändras i läget **Utkast**.

Sektionen **Historik** längst ner på fakturakortet visar fakturans egna händelser sedan den utfärdades — se [Händelselogg](/hjalp/system#handelselogg).

| Status | Betydelse |
|---|---|
| Utkast | Registrerad; huvud och rader redigerbara |
| Utfärdad | Fakturanummer tilldelat (låst för redigering); har ett öppet belopp så länge det inte är fullt betalt |
| Betald | Öppet belopp 0 — kan öppnas igen till Utfärdad om betalningen makuleras |
| Avbruten | Avbruten, bara möjligt från Utkast (slutläge) |

Från och med **Utfärdad** visar fakturakortet fakturanummer, **OCR-nummer**, **Förfallodatum**, **Öppet belopp** och den frysta fakturaadressen i huvudet (**Öppet belopp** visas för både Utfärdad och Betald), samt **Faktura (PDF)** och **Skicka faktura** i sektionen E-post (mottagaren förifylls med kundens **E-post för faktura** när den är satt). PDF:ens betalningsruta längst ner visar OCR-numret och förfallodatumet tillsammans med bankgiro/plusgiro från [Företagsinformation](/hjalp/system).

Har fakturan betalningar eller påminnelser visas de som egna sektioner under raderna:

- **Betalningar** — en rad per betalning som rör vid fakturan: **Datum**, **Betalning** (länk till betalningens BET-nummer), **Belopp**, **Avskrivning** och **Verifikat** (länk för den som har behörighet till Ekonomi, annars bara text — en ren kvittning visar **– (kvittning)** i stället). En makulerad betalning märks **· Makulerad** efter BET-numret.
- **Påminnelser** — en rad per skickad betalningspåminnelse: **Nivå**, **Datum**, **Avgift**, **Verifikat** (länk, administratörer) och **Dokument** — länken **Påminnelse (PDF)** öppnar påminnelsen exakt som den mejlades.

#### Arkiverad faktura

En utfärdad faktura (och kreditfaktura) är en verifikation som enligt bokföringslagen ska sparas oförändrad i sju år. Därför sparas fakturans PDF **när den utfärdas**, och **Faktura (PDF)** och **Skicka faktura** använder sedan alltid just den filen — även om företagets uppgifter (adress, bankgiro, logotyp m.m.) ändras senare ser en omutskrift ut precis som originalet. På samma sätt sparas varje skickad betalningspåminnelse som den mejlades. Fakturor som utfärdades innan arkivet fanns sparas första gången de skrivs ut eller mejlas.

Så länge fakturan är **Utfärdad** med ett öppet belopp skiljt från 0 visar kortet knappen **Registrera betalning**, som tar dig till [Kundreskontran](#kundreskontra) med fakturan förvald.

#### Skicka påminnelse

Så länge fakturan är **Utfärdad** med ett öppet belopp **större än 0** visar kortet knappen **Skicka påminnelse**. Dialogen förifyller **Mottagare** (kundens **E-post för faktura**, annars kundens vanliga **E-post**), **Ämne** och **Meddelande** — alla redigerbara — och har kryssrutan **Lägg till påminnelseavgift (X,XX kr)**, där beloppet hämtas från **Ekonomi → Konteringsregler → Kundreskontra → Påminnelseavgift**. Avgiften får bara läggas på **en gång per faktura**: har en tidigare påminnelse redan tagit ut den är kryssrutan avbockad och inaktiv med texten **Avgift redan tillagd**. Länken **Påminnelse (PDF)** visar exakt det dokument som skulle skickas med kryssrutans nuvarande läge, utan att skicka något — beloppet i förhandsgranskningen är en ögonblicksbild av det öppna beloppet just då, precis som i det skickade mejlets bilaga. Klicka **Skicka** för att mejla påminnelsen och, om ikryssad, bokföra avgiften i samma steg.

**Skicka om** i [E-postloggen](/hjalp/system#e-postlogg) kör om hela påminnelserutinen mot fakturans läge just då och är **alltid avgiftsfri** — den registrerar en ny påminnelse på nästa nivå men lägger aldrig på någon påminnelseavgift. Avgiften kan bara läggas till här på fakturakortet, med kryssrutan.

### E-faktura (Peppol)

Med e-faktura skickas fakturan som ett strukturerat dokument (UBL, Peppol BIS Billing 3) direkt in i kundens ekonomisystem via nätverket Peppol, i stället för som PDF i ett mejl. Nav skickar den genom B2Brouter. Funktionen är avstängd tills en administratör har slagit på den under [System → E-faktura](/hjalp/system#e-faktura); i den här första versionen gäller den svenska kunder och fakturor i SEK.

**Det här krävs:**

- E-faktura är **Aktiverad** och ansluten under System → E-faktura, och [Företagsinformation](/hjalp/system#foretagsinformation) har organisationsnummer, VAT-nummer, adress och bankgiro, plusgiro eller IBAN — saknas något står det under **Företagsuppgifter som skickas** på inställningssidan.
- Fakturan är **Utfärdad** eller **Betald** (en kreditfaktura går också att skicka).
- Kunden är ingen **Privatperson** och är en svensk kund; fakturan är i SEK.
- Kunden har ett Peppol-id, eget eller härlett ur organisationsnumret (se [Kunder](#kunder)). Saknas något av detta visar sektionen en förklaring i stället för knappen.

**Skicka e-faktura.** Från och med **Utfärdad** har fakturakortet sektionen **E-faktura**. Den visar mottagaren — "Peppol-id 0007:5560000000 (kundens organisationsnummer)" eller "(angivet på kunden)" — och knappen **Skicka e-faktura**. Knappen är den primära när kundens **Fakturaleverans** är **E-faktura (Peppol)**, annars en sekundär knapp: du kan skicka e-faktura till vilken kund som helst som tar emot det. Klicka, bekräfta frågan "Skicka FA-… som e-faktura till …?" och dokumentet byggs, kontrolleras och skickas. En faktura kan bara ha en pågående eller godkänd sändning i taget per miljö — en sandboxsändning hindrar inte den riktiga. Har kunden **E-faktura (Peppol)** som Fakturaleverans visar kortet också en påminnelse vid **Skicka faktura** i sektionen E-post: "Kunden vill ha e-faktura". E-post fungerar fortfarande — Nav hindrar dig inte.

**Statusarna.** Varje sändning loggas under **Sändningar** med tid, status och miljö:

| Status | Betydelse |
|---|---|
| Skickas | Fakturan är lämnad till B2Brouter men har inte nått Peppol än |
| Skickad | Fakturan är skickad in i Peppol-nätet |
| Mottagen | Kundens system har tagit emot fakturan — slutstatus |
| Avvisad | Kundens system eller nätverket avvisade fakturan — feltexten står under statusen |
| Misslyckad | Sändningen gick inte att genomföra — feltexten står under statusen |

Statusen uppdateras automatiskt av ett bakgrundsjobb (intervallet ställs in under System → E-faktura). **Uppdatera status** på en pågående rad hämtar den direkt. Länken **UBL** laddar ned exakt det dokument som skickades. Efter **Avvisad** eller **Misslyckad** kan du rätta orsaken — till exempel kundens Peppol-id — och klicka **Skicka igen**.

**Mottagen betyder inte betald.** Statusen säger bara att dokumentet kommit fram. Betalningen registreras som vanligt under [Kundreskontra](#kundreskontra).

**Påminnelser skickas fortfarande med e-post**, se [Skicka påminnelse](#skicka-paminnelse) — de skickas inte som e-faktura. Fakturalistan har kolumnen **E-faktura** med den senaste produktionssändningens status, eller — när bara sandboxsändningar finns — den senaste av dem, märkt "(sandbox)".

**Sandbox.** Är E-faktura inställt på miljön **Sandbox** visar sektionen texten "Sandbox — ingen faktura skickas på riktigt". Det är till för att prova flödet: sändningarna går till B2Brouters testmottagare och loggas som sandboxsändningar — i listan **Sändningar** märkta **Sandbox** i kolumnen Miljö och "(sandbox)" efter statusen. Knapparna **Skicka e-faktura** och **Skicka igen** ser bara till sändningarna i den miljö som är vald just nu.

### Bokföring av fakturan

**Utfärda** bokför fakturan automatiskt — du behöver aldrig knappa in något verifikat för hand. Verifikatet hamnar i serien **F** (Kundfakturor), får fakturadatumet som verifikatdatum och beskrivningen **Kundfaktura FA-… — kundens namn** (för en kreditfaktura: **Kreditfaktura FA-…**). Fakturanumret och verifikatet skapas i ett och samma steg: antingen blir båda av, eller ingetdera.

Konteringen ser ut så här:

- **Kundfordran** debiteras med bruttobeloppet (standardkonto **1510 Kundfordringar**).
- **Försäljningsintäkten** krediteras rad för rad. Har radens artikel en artikelgrupp med en konteringsregel styr regeln intäktskontot; annars används standardkontot för radens momssats — **3001** (25 %), **3002** (12 %), **3003** (6 %) eller **3004** (momsfritt).
- **Utgående moms** krediteras per momssats: **2610** (25 %), **2620** (12 %) och **2630** (6 %). En rad med **0 %** ger ingen momsrad alls.

En **kreditfaktura** bokförs som en spegling av samma konton — kundfordran krediteras, intäkt och moms debiteras. Den är ett eget verifikat, inte en omföring av originalfakturans.

På fakturakortet visas **Verifikat F-…** med en länk till verifikatet (t.ex. **F-2026-12**: serie, räkenskapsår och löpnummer). Numret är en länk för den som har behörighet till [Ekonomi](/hjalp/ekonomi) (administratörer och användare vars behörighetsgrupp ger Ekonomi, se [Behörighetsgrupper](/hjalp/system#behorighetsgrupper)); för andra visas det som text.

**Om bokföringen inte går att genomföra stoppas utfärdandet.** Fakturan förblir då **Utkast**, får inget fakturanummer och inget nummer bränns i FA-serien — nästa faktura fortsätter obruten. Det händer i dessa fall:

- **Bokföringsperioden är låst** för fakturadatumet. Lås upp perioden under **Ekonomi → Räkenskapsår** (**Lås upp period**, motivering krävs) och utfärda igen.
- **Inget räkenskapsår täcker fakturadatumet.** Lägg upp räkenskapsåret under **Ekonomi → Räkenskapsår** först — perioderna skapas automatiskt.
- **Ett konto som konteringen behöver saknas eller är inaktivt** i kontoplanen. Lägg upp eller aktivera kontot under **Ekonomi → Kontoplan** (**Förifyll BAS-urval** lägger in hela standardurvalet på en gång).
- **En rad har en momssats som inte går att bokföra.** Bara 25, 12, 6 och 0 % har konton.
- **Fakturans totalbelopp är noll.** Det finns ingenting att bokföra, så fakturan kan inte utfärdas.

### Kreditfaktura

Knappen **Skapa kreditfaktura** på fakturakortet (synlig i status **Utfärdad** eller **Betald**, men inte på en kreditfaktura själv — en kreditfaktura kan inte krediteras igen) skapar en ny faktura av typen **Kreditfaktura** som **Utkast**, förifylld som en spegling av alla den ursprungliga fakturans rader. Du landar direkt på det nya utkastet och kan redigera det precis som vilket annat utkast som helst — ta bort rader eller ändra antal för en delkreditering. Fakturakortet visar **Krediterar faktura FA-…** med en länk till originalfakturan.

Krediterar fakturan en orderrad som gjorde att ordern blev **Fakturerad**, och krediteringen sänker fakturerat antal under det levererade igen, backar ordern automatiskt till **Levererad** när kreditfakturan **utfärdas** — precis som originalfakturans utfärdande satte den till Fakturerad.

## Samlingsfakturering

**Försäljning → Fakturering → Samlingsfakturering** (`/forsaljning/samlingsfakturering`) samlar fakturering av alla kunder som är markerade **Samlingsfaktura** (se [Kunder](#kunder)) på ett ställe, i stället för att öppna fakturadialogen kund för kund. Begreppen är olika: **Samlingsfaktura** på kundkortet är en egenskap hos kunden, medan [Samlingsfaktura](#samlingsfaktura) i den vanliga fakturadialogen bara betyder att flera ordrar väljs på en faktura — den här rutinen kör i stället regeln automatiskt för alla sådana kunder i ett svep.

Tabellen listar de kunder som har **Samlingsfaktura** ikryssat och samtidigt har levererade men ofakturerade orderrader, med kolumnerna **Kundnr**, **Kund**, **Order** (antal berörda order), **Rader** och **Belopp exkl. moms**. Alla rader är förvalda från början. Kommer du hit via ett orderkorts knapp **Fakturera** är i stället bara den ordens kund vald. På en smal skärm (mobil i stående läge) visas listan som staplade kort utan rubrikrad; då ligger kryssrutan **Välj alla**, antal valda och belopp, **Utfärda direkt** och **Skapa samlingsfakturor** i en rad ovanför listan som följer med när du skrollar.

Kryssrutan **Utfärda direkt** styr vad som händer med fakturorna: ikryssad tilldelas de fakturanummer i FA-serien och bokförs i serie F direkt, precis som en vanlig utfärdad faktura; avbockad skapas de som **Utkast** som du granskar och utfärdar från respektive fakturakort — där går det också att lägga till fria rader, t.ex. en avgift, innan utfärdandet.

Knappen **Skapa samlingsfakturor** skapar **en faktura per vald kund**, med alla kundens levererade, ofakturerade rader från samtliga dess order — samma underlag som förslaget i den vanliga fakturadialogen (levererat minus redan fakturerat, utkast inräknade). Varje kund hanteras för sig: misslyckas en kund (t.ex. för att bokföringsperioden är låst) visas felet på den raden under **Resultat**, men de andra valda kundernas fakturor skapas ändå.

Frakten från bokade, ofakturerade försändelser tas med automatiskt som fraktrader (kolumnen **Frakter**), se [Frakt på fakturan](#frakt-pa-fakturan).

Resultatet visar en status per kund: **Utkast**, **Utfärdad**, **Inget att fakturera** (inget levererat och ofakturerat fanns kvar) eller **Misslyckades** (med felmeddelande). Fakturanumret respektive texten Utkast är en länk till fakturakortet. Tabellen uppdateras automatiskt efter körningen.

## Kundreskontra

Kundreskontran håller reda på vilka fakturor som fortfarande har ett öppet belopp och registrerar de betalningar som stänger dem.

### Öppna poster

**Försäljning → Öppna poster** listar varje utfärdad faktura och kreditfaktura som fortfarande har ett öppet belopp: **Faktura**, **Kund**, **Typ**, **Förfallodatum** (rött och märkt "förfallen" när datumet har passerat), **Belopp**, **Öppet belopp** och **Påminnelser**. Filtrera på kund eller kryssa i **Endast förfallna**; sökfältet matchar fakturanummer, OCR-nummer och kundnamn. Klicka på fakturanumret för att öppna fakturakortet.

> Fakturor som markerades som betalda med den gamla knappen **Markera som betald** (innan betalningsregistreringen fanns) syns aldrig här — de har redan status Betald och har inget öppet belopp kvar att bevaka.

### Registrera betalning

**Försäljning → Betalningar** listar alla registrerade betalningar (BET-nummer, datum, kund, belopp, konto, verifikat och status). Knappen **+ Registrera betalning** öppnar registreringsformuläret:

1. Välj **Kund** — kundens öppna poster hämtas in i en tabell nedanför — eller ange kundens **OCR-nummer** under **Hämta via OCR-nummer** och klicka **Hämta** för att slå upp fakturan direkt (kunden väljs automatiskt och fakturan kryssas i).
2. Kryssa i de fakturor betalningen gäller. Varje ikryssad rad visar **Öppet belopp** och ett redigerbart **Belopp**, förifyllt med öppet belopp. Fältet till höger om beloppet visar direkt vad som händer:
   - **Stänger posten** — beloppet matchar öppet belopp exakt.
   - **Stänger posten · avskrivning X,XX kr** — beloppet ligger inom toleransen (se nedan) men matchar inte exakt; mellanskillnaden bokförs som öres-/kronutjämning och posten stängs ändå.
   - **Delbetalning · rest X,XX kr** — beloppet ligger utanför toleransen; posten förblir öppen med resten kvar.
   - **Beloppet överstiger öppet belopp** — beloppet är för högt även med toleransen inräknad; posten kan inte stängas med det beloppet.

   En kreditfaktura har ett negativt öppet belopp — beloppet på dess rad anges också negativt.
3. Hur mycket en betalning får missa öppet belopp med och ändå räknas som fullt betald ställs in under **Ekonomi → Konteringsregler** som **Betalningstolerans (kr)**.
4. Fyll i **Betalkonto** (förvalt till kontot under Ekonomi → Konteringsregler → **Bank/betalkonto**), **Betalningsdatum** (dagens datum förvalt) och en valfri **Notering**. **Summa** räknas fram automatiskt som summan av de ikryssade radernas belopp — det är detta belopp som bokförs mot betalkontot.
5. Klicka **Registrera betalning**.

**Kvittning av kreditfaktura:** kryssar du i poster vars belopp tar ut varandra helt inom samma betalning — till exempel en kreditfakturas negativa belopp mot en vanlig fakturas positiva, utan att någon av raderna hamnar inom toleransen och får en avskrivning — blir betalningens **Summa** 0 och inget verifikat bokförs, eftersom inga pengar har rört sig i banken. Det är en ren kvittning mellan kundens egna poster, och listan visar **—** i kolumnen **Verifikat** för en sådan betalning.

> **Att betala** på en utskriven betalningspåminnelse är en ögonblicksbild av det öppna beloppet när påminnelsen skrevs ut — kommer det in en delbetalning efteråt utan att en ny påminnelse skrivs ut ändras inte den redan utskrivna PDF:en.

### Makulera betalning

På betalningens detaljsida (klicka på BET-numret i listan) finns knappen **Makulera** under **Åtgärder**, synlig så länge betalningen inte redan är makulerad. En bekräftelsedialog visas eftersom åtgärden bokför en omföring av betalningens verifikat (om den bokförde något) och öppnar de fakturor betalningen stängde igen — de får tillbaka exakt det öppna belopp de hade innan betalningen. En kvittning utan eget verifikat kan makuleras precis som en betalning med bankbelopp; det finns då inget att omföra, bara fakturorna som öppnas igen. En redan makulerad betalning visar statusen **Makulerad** och kan inte makuleras igen.

## Bankfiler (inbetalningar)

Bankens kreditavi (camt.054) innehåller kundernas inbetalningar, t.ex. allt som kommit in på bankgirot under dagen. Under **Försäljning → Bankfiler** väljer du **Läs in bankfil**. Filen sparas som räkenskapsinformation (kan laddas ner igen från filens sida) och visas med en rad per inbetalning. Filens sida visar också vilket **Konto** avin gäller. Är kontot inte något av företagets konton under Företagsinformation (IBAN, bankgiro eller plusgiro) visas en varning — kontrollera då att filen verkligen hör till företaget. Swedbank anger bankkontot bakom bankgirot, så lägg in företagets IBAN under Företagsinformation om varningen gäller det egna kontot.

### Matchning

Varje inbetalning matchas mot de öppna kundfakturorna varje gång sidan visas, så förslagen speglar alltid dagens öppna poster:

- **Matchad** — OCR-numret (eller flera, med egna belopp) pekar på öppna fakturor hos en och samma kund. En inbetalning som inte täcker hela fakturan visas som **Matchad · delbetalning**, och resten står kvar som öppen post.
- **Förslag** — ingen OCR träffade, men beloppet och betalarens namn passar en faktura (*Förslag: belopp + namn*), beloppet är unikt (*Förslag: endast belopp*), eller namnet passar en kund vars öppna poster räcker (*Förslag: namn — fördelning*). Kontrollera och kryssa i själv.
- **Omatchad** — inget passar, eller betalningen kan inte bokföras med reskontrans regler. Orsaken visas, t.ex. *Överbetalning 70,00 kr på FA-5012 — registrera manuellt under Betalningar* eller *OCR 501262 tillhör FA-5012 som redan är betald — möjlig dubbelbetalning*. Det sista betyder att kunden kan ha betalat samma faktura två gånger: återbetala eller hantera den ena utanför Nav och markera posten med **Hanterad utanför Nav**.

Under **Fördelning** väljer du kund och fakturor och ändrar beloppen. Raden visar samma förhandsvisning som **Betalningar** (*Stänger posten*, *Delbetalning · rest …*), och *Fördelat … av …* måste bli exakt inbetalningens belopp innan raden kan bokföras. En ikryssad post vars fördelning inte stämmer märks *Fördelningen stämmer inte med beloppet — posten bokförs inte förrän den gör det*; **Bokför valda** bokför då de övriga. En inbetalning kan delas på flera fakturor hos samma kund, och en delbetalning lämnar resten som öppen post.

### Bokför inbetalningar

Matchade poster är förvalda. **Bokför valda** registrerar en betalning per post (serie K) på bankens bokföringsdag, mot betalkontot under Konteringsregler, med tolerans och kvittning precis som under **Betalningar**. Betalningens kort visar *Från bankfil …* med länk tillbaka. En post som inte gick att bokföra (t.ex. för att bokföringsperioden är låst, eller för att fakturan hunnit betalas för hand) får sitt fel på raden och bokförs inte, och de andra bokförs ändå. Makuleras en sådan betalning senare under **Betalningar** blir posten obokförd igen och kan bokföras mot rätt faktura.

**Hanterad utanför Nav** markerar en post som inte är en kundbetalning (t.ex. en överföring mellan egna konton) och kräver en orsak. **Ångra** tar tillbaka markeringen. Poster i annan valuta än SEK visas som **Annan valuta**: de kan inte bokföras här och markeras med **Hanterad utanför Nav**.

### Redan inlästa poster

Samma fil kan läsas in igen utan risk: *Filen är redan inläst*. En fil som delvis överlappar en tidigare (t.ex. dagsslutsfilen efter en intradagsfil) visar *3 poster var redan inlästa och hoppades över* med besked om vilken fil de kom från. Ingen post kan bokföras två gånger, och samma fil kan läsas in från Inköp och Försäljning utan dubbletter.

### Poster utan bankreferens

Banken anger normalt en unik referens per transaktion. Swedbank gör det bara för bankgirobetalningar, så insättningar direkt på kontot saknar den. Sådana poster känns igen på sitt innehåll (konto, datum, belopp, betalare och meddelande) och märks *Banken angav ingen unik referens — posten känns igen på sitt innehåll*. Två helt identiska betalningar i samma fil hålls isär, men kontrollera dem särskilt.

> **Swedbank:** prova den första betalfilen som Nav skapar (Inköp → Betalfiler) i Swedbank Validex innan den första skarpa betalningen. Se [Inköp](/hjalp/inkop).

## Faktura

Fakturor skapas i **fakturamodulen** (se [Fakturor](#fakturor) ovan) i stället för direkt på kundorderkortet — en faktura kan bygga på rader från flera kundordrar hos samma kund, och kan redigeras som utkast innan den bokförs. Ordrar fakturerade före fakturamodulen behåller sitt FA-nummer på ordern; deras PDF och e-post nås som tidigare från orderkortet. Nedanstående beskriver hur dessa äldre, redan fakturerade ordrar fortsätter att fungera:

- **Adress:** fakturan ställs till kundens **Fakturaadress** (kundkortets Allmänt-flik) under rubriken **Fakturaadress**; saknas den används besöksadressen under rubriken **Kund**.
- **Förfallodatum:** räknas fram ur orderns betalningsvillkor när villkorets kod är ett antal dagar (t.ex. `30` → fakturadatum + 30 dagar); annars utelämnas raden och villkoret skrivs ut som vanligt.
- **Moms:** summeringen visar **Summa exkl. moms**, **Moms (25 %)** och **Att betala**. Ordernumret skrivs ut som referens, och kundens ordernummer/referens och leveransadress följer med som på orderbekräftelsen.
- Sidfoten med betalningsuppgifter (bankgiro m.m.) kommer från [Företagsinformation](/hjalp/system).
- **Faktura (PDF)** laddar ner dokumentet; **Skicka faktura** mejlar det som PDF-bilaga (loggas som Faktura i e-postloggen). Omtryck ger alltid samma fakturanummer.

## Utleverans

**Försäljning → Utleverans** är rutinen för att rapportera leverans av hela kundorder på en gång:

1. Välj order i fältet **Kundorder** — sök på ordernummer, kund, artikelnummer eller benämning; varje träffrad visar datum, status och antal restrader. Bara ordrar i status **Under tillverkning** visas (starta tillverkningen på orderkortet först). Så länge ingen order är vald visas i stället tabellen **Levererbara ordrar** under sökfältet — samtliga ordrar i status **Under tillverkning**, nyast först, klicka på ordernumret för att välja ("Inga ordrar väntar på utleverans." om listan är tom). Från kundorderkortet når du rutinen med ordern förvald via knappen **Utleveransrutinen**.
2. Välj **Lagerplats** (gäller hela rapporteringen).
3. Radtabellen visar **Beställt** (totalt antal på raden), Enhet, **Levererat** och **Rest** (beställt minus levererat, det som återstår att leverera) per rad — allt i radens enhet — och fältet **Leverera nu** är förifyllt med restantalet. Justera antalen — rader som sätts till 0 hoppas över. Antalet räknas om till grundenheten när saldot bokförs.
4. Klicka **Rapportera utleverans**. Alla ifyllda rader bokförs tillsammans som **ett leveranstillfälle** — inte en separat bokning per rad — med ett eget **FS-nummer** (en följesedel), och ordern blir **Levererad** när allt är rapporterat. Eventuella fel visas per rad. Efter en lyckad rapportering visas länkarna **Följesedel FS-N (PDF)** och **Pallkort (PDF)** för att skriva ut leveranstillfällets följesedel respektive pallkort.

Enstaka rader kan fortfarande levereras direkt på kundorderkortet med **Leverera** — även det skapar ett eget leveranstillfälle (en följesedel med en rad).

**Varning för beställningsvara.** Levererar du en konfigurerad rad (beställningsvara) mer än tillverkningsordrarna kopplade till raden har färdigrapporterat visas en gul varning under antalet, både här och i dialogen **Leverera** på orderkortet: *KO-raden har bara X av Y färdigrapporterade*. X är det färdigrapporterade antalet på de kopplade tillverkningsordrarna (Klar eller Avslutad), Y det antal som raden då skulle vara levererad till. Varningen stoppar inte leveransen — mallens lagersaldo är gemensamt och en enhet som byggts fritt får levereras — den påminner bara om att tillverkningen inte hunnit ikapp. Se [Tillverkningsorder för beställningsvara](/hjalp/tillverkning#tillverkningsorder-for-bestallningsvara).

#### Pallkort vid utleverans

Efter en lyckad rapportering öppnas leveransens **pallkort** automatiskt i en ny flik — **en A4-sida per levererad rad**. Kortet är ett inramat kort med svart rubrikband (**PALLKORT** och **TILL KUND**) under företagets logotyp och visar **Artikelnummer**, **Benämning**, **Kund**, **Leveransadress** (när ordern har en vald leveransadress), **Kundens ordernummer** (ett streck när ordern saknar sådant), **Vårt kundordernummer** och det levererade antalet i radens enhet. Längst ner i ramen står **Datum** (leveransens tid) och **Referens** (följesedelns nummer) — utleveransens kort visar inte vem som rapporterade. Allt trycks på övre halvan av arket så det kan vikas på mitten (en streckad viklinje visar var) och läggas på pallen. Beroende på inställningen **Kod på pallkort** (systeminställningen och kundkortets fält) får artikelnumret och vårt ordernummer även en streckkod eller QR-kod.

Behöver du skriva ut igen, eller ett annat antal, klickar du **Pallkort (PDF)** i resultatraden eller **Pallkort** bredvid **PDF** i listan **Följesedlar** på kundorderkortet. Dialogen **Pallkort** visar ett block per levererad rad med **Totalt antal** (förifyllt med levererat antal), **Antal kolli** (förifyllt 1, högst 50; 0 hoppar över raden) och en lista **Kolli 1**, **Kolli 2** … med eget antal per kolli — totalen fördelas jämnt tills du skriver ett antal för hand. Varje kolli blir ett kort som alltid visar vilket kolli det är, t.ex. "Kolli 2 av 3" (även "Kolli 1 av 1" när raden bara får ett kort, också vid den automatiska utskriften). Under listan visar en rad om kollina stämmer med totalen, hur många som är **kvar att fördela** eller **för mycket**, och om något kolli saknar antal (*Varje kolli måste ha ett antal*). **Skriv ut** öppnar PDF:en i en ny flik; knappen är avstängd när alla rader har 0 kolli eller något kolli saknar antal, och även när en rads kolli inte stämmer med dess totalt antal — om inte systeminställningen **Tillåt utskrift av pallkort även om kollina inte stämmer med totalt antal** är på. Tillverkningens pallkort beskrivs i [Tillverkning](/hjalp/tillverkning#pallkort).

### Plocklista

**Plocklista (PDF)** — på utleveransrutinen när en order är vald, och bland PDF-knapparna på kundorderkortet — skriver ut plockunderlaget för ordern:

- Bara rader med kvarvarande antal tas med, och **Att plocka** är restantalet (beställt minus levererat) i radens enhet.
- Kolumnen **Lagerplats (saldo)** visar var artikeln finns och aktuellt saldo per lagerplats — saldona anges i artikelns grundenhet.
- Kolumnen **Plockat** och raden "Plockat av / Datum" fylls i för hand av den som plockar.
- Konfigurerade rader visar valen (t.ex. *Lock: Lock B*, *Bredd: 1 200 mm*) under benämningen — aldrig priser.

Plocklistan kan skrivas ut i alla statusar utom Avbruten och ändrar ingenting i systemet.

### Följesedel

Varje leveranstillfälle — via utleveransrutinen eller kundorderkortets **Leverera**-dialog — får ett eget **FS-nummer** och en egen följesedel:

- **Följesedel FS-N (PDF)** nås direkt efter rapporteringen i utleveransrutinen, eller i efterhand från listan **Följesedlar** på kundorderkortet.
- Dokumentet visar samma kund- och adressuppgifter som plocklistan (**Kund**, **Ert ordernummer**, **Er referens**, leveransadress) samt leveransdatum, och radtabellen har kolumnerna **Artikel**, **Benämning**, **Levererat**, **Enhet** och **Tidigare levererat** — hur mycket av raden som levererats vid tidigare tillfällen, oavsett om de rapporterades före eller efter att följesedlar infördes.
- Konfigurerade rader visar valen (t.ex. *Lock: Lock B*, *Bredd: 1 200 mm*) under benämningen — aldrig priser.
- Kundorderkortet listar alla leveranstillfällen under rubriken **Följesedlar**: FS-nummer, datum, antal rader och en PDF-länk per tillfälle. Listan visas bara när ordern har minst en leverans.

> Externa system (t.ex. en produktkonfigurator) kan skapa offerter programmatiskt via API:t — se [System & inställningar](/hjalp/system) om integrationer.

### Ångra utleverans

Har en leverans rapporterats fel kan den ångras i efterhand. På kundorderkortet, i listan **Följesedlar**, öppnar **Ångra…** dialogen **Ångra utleverans** med följesedelns rader (artikel, benämning och levererat antal). Knappen visas bara när ordern är **Under tillverkning** eller **Levererad** och du har behörighet till Försäljning.

- Varje rad ångras för sig med knappen **Ångra** och alltid med hela sitt levererade antal. Du får först en bekräftelsefråga.
- Varorna läggs tillbaka på den lagerplats de togs från. Hade leveransen tömt platsen och gjort den inaktiv aktiveras den igen.
- Radens levererade antal på kundordern minskar, och en **Levererad** order går tillbaka till **Under tillverkning**.
- Ångrade rader ligger kvar i dialogen, överstrukna och märkta **Ångrad** med tid och namn.
- När alla rader på en följesedel är ångrade visas följesedeln som **Ångrad** i listan. Den går fortfarande att skriva ut — PDF:en markerar de ångrade raderna och rubriken **Ångrad** — men **Pallkort** och **Boka transport** finns inte längre för den.

En rad kan inte ångras när:

- raden är fakturerad, även på ett fakturautkast — kreditera fakturan eller ta bort utkastet först.
- följesedeln ligger på en försändelse — ta bort den från försändelseutkastet eller avboka försändelsen först.
- ordern har en annan status än **Under tillverkning** eller **Levererad**.
- lagerplatsen är under inventering.
- leveransen gjordes innan funktionen fanns och kunde inte kopplas till sin lagerrörelse. Raden visas då som **Kan inte ångras**.

Det går inte att ångra bara en del av en rads antal. Ångra raden och leverera på nytt med rätt antal — den nya leveransen får ett nytt följesedelsnummer.

## Frakt

Frakten bokar transport hos en speditör direkt från en följesedel. Tjänsten förmedlas av Sendify, som erbjuder bland annat DHL, UPS, DSV, PostNord och Schenker; du jämför priser, bokar och skriver ut fraktsedel utan att lämna systemet. Funktionen måste vara **Aktiverad** under **System → Frakt** (se [System & inställningar](/hjalp/system#fraktinstallningar)) innan knappen **Boka transport** visas.

### Skapa en försändelse

En **försändelse** (nummer `FR-…`) är en transport som hör till en eller flera följesedlar. Skapa den med **Boka transport**:

- i [Utleverans](#utleverans) när leveransen har rapporterats, och
- i listan **Följesedlar** på kundorderkortet.

En följesedel kan bara ligga i en försändelse åt gången. Har följesedeln redan en försändelse visas i stället försändelsens nummer (med fraktsedelsnumret när transporten är bokad) som länk till försändelsekortet.

Under **Försäljning → Försändelser** finns listan över alla försändelser med kolumnerna **Försändelse**, **Kund**, **Följesedlar**, **Transportör**, **Fraktsedelsnr**, **Upphämtning** och **Status**. Sökfältet söker på försändelse, kund, följesedel eller fraktsedelsnummer, och filtret **Alla statusar** väljer en av statusarna **Utkast**, **Bokad**, **Levererad** och **Avbruten**. Filtret **Alla kunder** visar bara en kunds försändelser.

### Försändelsekortet

Kortet visar statusen och kunden överst med knapparna till höger. Därunder ligger panelerna **Mottagare** (med **Avsändare**) till vänster och **Följesedlar**, **Upphämtning** och **Frakt** till höger — på en smal skärm staplas de — och **Kollin** under dem. Kortet är redigerbart så länge försändelsen är **Utkast**; en bokad, levererad eller avbruten försändelse visar samma uppgifter som en sammanfattning i stället för fält.

- **Följesedlar** — **Lägg till följesedel** (”Välj följesedel till samma kund…”) lägger till fler följesedlar åt samma kund, så att flera leveranser samlastas i en transport. Varje följesedel visas som länk till sin PDF följd av kundordern; **Ta bort** tar bort den igen (den sista går inte att ta bort). Kollinen föreslås om när följesedlarna ändras.
- **Mottagare** — förifylld från orderns leveransadress; saknas den används kundens förvalda leveransadress och annars besöksadressen. Kontaktperson, telefon och e-post hämtas från kundens huvudkontakt. Alla fält går att ändra och sparas med **Spara mottagare**. **Privatperson** kryssas för privatleverans, och **Avsändarens referens**/**Mottagarens referens** skrivs på fraktsedeln. **Avsändare** under mottagaren visar avsändarens adress och kontakt; de hämtas från **Företagsinformation** och **System → Frakt** och ändras där. Sendify kräver ett kontaktnamn: saknas kontakt hos mottagaren (eller avsändaren) skickas företagets respektive kundens namn.
- **Upphämtning** — **Datum**, **Från** och **Till** förifylls med nästa dag som har upphämtning enligt upphämtningstiderna. Dagens upphämtning föreslås bara så länge det går att begära en tid före fönstrets slut (nu avrundat uppåt till närmaste kvart), annars nästa upphämtningsdag. Har datumet passerat, eller saknar dagen upphämtning, visas en varning på kortet. Byts datumet hämtas den dagens tider. Sparas med **Spara upphämtning**. Gäller upphämtningen i dag begärs den hos Sendify tidigast klockslaget just nu avrundat uppåt till närmaste kvart (fönstret på kortet ändras inte); har **Till** redan passerat måste ett nytt datum väljas innan priser kan hämtas.
- **Kollin** — ett förslag byggs från artiklarnas kollityp, **Antal per kolli** eller egna mått. Raderna kan ändras (**Kolliart**, **L (cm)**, **B (cm)**, **H (cm)**, **Vikt (kg)**, **Antal**, **Stapelbar**, **Flakmeter**, **Beskrivning**), läggas till med **+ Kolli** och tas bort med ✕. **Föreslå kollin igen** ersätter dina ändringar med ett nytt förslag (bekräftas först) och **Spara kollin** sparar. Varningar visas ovanför tabellen när vikt, mått eller fraktsätt saknas på en artikel. Kolli av typen **Paket** är alltid stapelbara (Sendifys regel) — kryssrutan **Stapelbar** är ikryssad och låst för dem.

### Hämta priser och boka

1. Klicka **Hämta priser**. Dialogen **Priser** visar en rad per transportör och produkt med **Transportör**, **Produkt**, **Pris**, **Kundpris**, **Ledtid (dagar)**, **Upphämtning** och **Beräknad leverans**. Eventuella varningar visas under tabellen. Bara priser i SEK kan bokas direkt; övriga valutor visas som **Bara SEK**. Ändrar någon annan försändelsen medan priserna hämtas sparas inga priser utan meddelandet **Försändelsen ändrades under prishämtningen — hämta priser igen** visas.
2. Klicka **Boka** på önskad rad för att boka direkt, eller **Spara val** för att spara produkten och boka senare. Den valda produkten markeras med **(valt)**.
3. Har du sparat ett val bokas det med **Boka vald produkt**. Då hämtas nya priser, och har priset ändrats mer än gränsen **Bekräfta prisändring över (%)** (se [Fraktinställningar](/hjalp/system#fraktinstallningar)) visas dialogen **Priset har ändrats** med sparat och nytt pris — **Boka ändå** bokar till det nya priset. Ett prisförslag som hunnit gå ut hämtas om automatiskt.

Medan bokningen pågår visas **Bokning pågår…**.

### Efter bokning

Försändelsen får status **Bokad** och sektionen **Frakt** visar **Produkt**, **Sendifys pris** och **Fraktsedelsnr** (som länk till spårning när transportören anger en sådan), samt **Fraktsedel** och/eller **Etikett** som PDF. Vissa transportörer ger bara en **Etikett** och ingen separat fraktsedel (t.ex. DHL Paket i Sendifys sandlåda). Saknas dokumenten klicka **Hämta fraktsedel**. Transportör och fraktsedelsnummer skrivs också ut på följesedelns PDF.

**Kundpris (kr)** är Sendifys pris plus påslaget enligt **System → Frakt**. Det kan ändras för hand och sparas med **Spara kundpris**; töm fältet och spara för att återgå till påslaget.

### Avboka och ta bort

- **Avboka** (på en bokad försändelse) avbokar transporten hos Sendify och frigör följesedlarna. Vägrar Sendify avbokningen — t.ex. för att godset redan hämtats — står försändelsen kvar som **Bokad**. Har transporten redan avbokats hos Sendify (t.ex. i Sendifys eget gränssnitt) avbokas försändelsen i Nav utan fel. Ligger frakten som fraktrad på ett fakturautkast vägrar **Avboka** med **Frakten ligger på ett fakturautkast — ta bort fraktraden från utkastet innan du avbokar** (se [Frakt på fakturan](#frakt-pa-fakturan)); en utfärdad faktura hindrar inte avbokningen — krediteras frakten görs det med en kreditfaktura.
- **Avbryt** avbryter ett utkast (status **Avbruten**) och **Ta bort utkast** raderar det helt. Båda bekräftas först.

### Frakt på offert och order

Fraktpriset kan läggas på redan i offerten, innan det finns någon följesedel att boka från. Knappen **Kontrollera fraktpris** finns på kundorderkortet i statusarna **Offert**, **Bekräftad** och **Under tillverkning** (frakten måste vara **Aktiverad** under **System → Frakt**, och du behöver rättigheten Försäljning). Den öppnar dialogen **Fraktpris**:

1. **Kollin** föreslås från orderns rader på samma sätt som på försändelsekortet (artiklarnas kollityp, **Antal per kolli** eller egna mått — raderna som redan är levererade räknas inte). Förslaget går att ändra rad för rad, fler kollin läggs till med **+ Kolli** och tas bort med ✕. Saknas vikt, mått eller fraktsätt på en artikel visas en varning ovanför tabellen. Kollina sparas inte — de används bara för prisfrågan.
2. **Hämta priser** frågar Sendify med orderns leveransadress (saknas den används kundens förvalda leveransadress och annars besöksadressen), kundens huvudkontakt och nästa dag med upphämtning enligt upphämtningstiderna. Tabellen visar samma kolumner som på försändelsen: **Transportör**, **Produkt**, **Pris**, **Kundpris**, **Ledtid (dagar)**, **Upphämtning** och **Beräknad leverans**. **Kundpris** är Sendifys pris plus påslaget under **System → Frakt**. Bara priser i SEK kan väljas; övriga visas som **Bara SEK**. Saknas mottagarens adress, telefon eller e-post, eller finns ingen upphämtningsdag de närmaste 14 dagarna, visas felet i dialogen i stället för priser.
3. **Lägg till frakt** på önskad rad lägger till fraktartikeln som en orderrad med antal 1 och radens **Kundpris** som à-pris (ingen rabatt). Det kräver att en **Fraktartikel** är vald under **System → Frakt** — utan den går det att hämta priser, men **Lägg till frakt** ger felet **Fraktartikel saknas — se System → Frakt**. Finns fraktraden redan på ordern ersätts priset i stället — klicka **Lägg till frakt** på en annan produkt för att byta. Har fraktraden redan levererats kan den inte ändras (**Fraktraden är redan levererad och kan inte ändras**). Dialogen stängs och ordern laddas om.

Under knappraden visas sedan raden **Fraktprodukt: {transportör} · {produkt} (offererat {pris})** med den valda produkten och Sendifys pris vid prisfrågan. Priset är en uppskattning och har ingen giltighetstid i systemet: fraktraden behåller det offererade kundpriset tills du klickar **Lägg till frakt** igen, och vid bokningen hämtas alltid nya priser hos Sendify.

När ordern är bekräftad och utlevererad skapas försändelsen med **Boka transport** som vanligt — den får orderns fraktprodukt förvald och det offererade priset som sparat val, så **Boka vald produkt** fungerar direkt. Har priset hunnit ändras mer än gränsen **Bekräfta prisändring över (%)** visas dialogen **Priset har ändrats** med offererat och nytt pris, och **Boka ändå** bokar till det nya priset. Fraktraden på ordern ändras inte av bokningen. Samlastas flera följesedlar i en försändelse är det den första ordern i listan vars produkt förväljs.

### Sandlådan och begränsningar

I Sendifys sandlåda fungerar full bokning bara med DHL, UPS och DSV. Mot produktion gäller alla transportörer ni har avtal med.

Ingår inte i den här versionen: ombud/utlämningsställen och tull.

### Spårning

Försändelsekortet har sektionen **Spårning** med senaste status från transportören, händelselistan och **Senast kontrollerad**. Statusarna visas på svenska (t.ex. **Beställd**, **Under transport**, **Levererad**, **Avvikelse**) och tider i svensk tid. Länken till transportörens spårning ligger på **Fraktsedelsnr** i sektionen **Frakt**. Status hämtas automatiskt: systemet kontrollerar var femte minut vilka försändelser som är på tur och kör enligt **Spårningsintervall** under **System → Frakt** (**Varje timme**, **Var fjärde timme** eller **Dagligen**). Under inställningen visas **Senaste spårningskörning**. Knappen **Uppdatera spårning** på kortet hämtar status direkt. Försändelser som bokades för mer än 60 dagar sedan spåras inte automatiskt (knappen fungerar fortfarande).

Meddelar transportören ett undantag, t.ex. försenat eller skadat gods, markeras statusen med rött på kortet och i kolumnen **Spårning** i försändelselistan. Rapporterar transportören att godset levererats får försändelsen status **Levererad** och kortet visar **Levererad** med leveransdatum.

### Frakt på fakturan

En bokad försändelse som ännu inte fakturerats föreslås som fraktrad i fakturadialogen (se [Skapa en faktura](#skapa-en-faktura)). Raden hamnar i gruppen **Frakt**, är förbockad från början och består av fraktartikeln (**Fraktartikel** under **System → Frakt**), antal 1 och försändelsens **Kundpris (kr)**; priset går att ändra, och avbockas raden följer ingen frakt med. Har någon av orderna bakom försändelsen redan en rad med fraktartikeln (se [Frakt på offert och order](#frakt-pa-offert-och-order)) föreslås ingen fraktrad, så frakten faktureras inte två gånger. Spärren gäller åt andra hållet också: när försändelsens fraktrad ligger på en faktura vägrar **Lägg till frakt** på ordern med **Frakten för ordern är redan fakturerad via försändelse FR-… — ingen fraktrad läggs till**. Samlingsfaktureringen tar med frakten automatiskt och visar antalet i kolumnen **Frakter**.

En fraktrad tas bort genom att kryssrutan under **Frakt** avmarkeras. Benämning och pris på fraktraden kan ändras fritt; antalet är alltid 1. Är ingen fraktartikel vald under **System → Frakt** kan frakt inte faktureras.

Fakturakortet visar länken **Försändelse FR-…** till försändelsen, och försändelsekortet visar raden **Faktura** (fakturanumret, **Utkast** eller **Ej fakturerad**). Makuleras ett fakturautkast frigörs frakten och kan faktureras igen; en kreditfaktura frigör den inte. Medan en försändelse avbokas hos Sendify kan dess frakt inte läggas på en faktura; försök igen när avbokningen är klar.

### Förvald fraktprodukt

På kundkortets flik **Villkor & frakt** finns **Förvald fraktprodukt** (visas när frakten är aktiverad under **System → Frakt**). En ny försändelse får produkten som valts på ordern ([Frakt på offert och order](#frakt-pa-offert-och-order)) i första hand, annars kundens förvalda produkt — utan Sendifys pris, som hämtas vid bokningen. Därefter bokas den direkt med **Boka vald produkt**.
