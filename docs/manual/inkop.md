# Inköp

Inköpsmodulen i Nav|ERP omfattar leverantörsregistret, förfrågningar (prisförfrågningar), inköpsorder med mottagning, fakturaunderlag, fakturainkorg och leverantörsfakturor.

## Översikt

Menyvalet **Inköp** öppnar modulens sida, där alla inköpsfunktioner ligger grupperade i ett rutnät:

- **Inköp** — **Inköpsorder**, **Förfrågningar** och **Inleverans**.
- **Leverantörsfakturor** — **Leverantörsfakturor**, **Fakturainkorg** och **Fakturaunderlag**.
- **Reskontra** — **Öppna poster** och **Betalningar**.
- **Register** — **Leverantörer** och **Grunddata**.

Knappen **+ Ny inköpsorder** leder till orderlistan där ordern registreras. Nyckeltal och bevakningslistor för hela verksamheten finns på **Översikt**, startsidan.

Inköpsorderlistan och orderkorten ligger under **Inköp → Inköpsorder** (`/inkop/ordrar`). Gamla länkar och bokmärken till ett orderkort på den tidigare adressen skickas vidare automatiskt.

## Leverantörer

**Inköp → Leverantörer** listar alla leverantörer med kolumnen **Lev.nr** först; sökrutan matchar leverantörsnummer och namn. **+ Ny leverantör** registrerar **Leverantörsnummer** (valfritt — lämnas fältet tomt tilldelas nästa nummer automatiskt ur nummerserien, se [Nummerserier](/hjalp/system#nummerserier)), namn, vårt kundnummer, valuta (3 bokstäver, t.ex. SEK/EUR) och adress med postnummer/postort/**Land** — kontaktpersoner läggs upp på leverantörskortets flik **Kontakter**. Knappen **Importera** läser in leverantörer, kontakter och leveransadresser från exportfiler (se [Importera leverantörer](#importera-leverantorer)).

Klicka på leverantörens namn för att öppna **leverantörskortet** med fyra flikar:

- **Allmänt** — **Leverantörsnummer** (unikt internt nummer; kan skrivas över i efterhand, upptagna nummer avvisas — skrivs inte ut på några dokument), **Vårt kundnummer** (vårt kundnummer i leverantörens system — skrivs ut som "Vårt kundnummer hos er" på förfrågan och inköpsorder när det är ifyllt), namn, aktiv, adress, postnummer, postort, **Land** (ISO-2-kod, t.ex. "SE", "DE" eller "CN"; standardvärde "SE") och valuta. Landet avgör leverantörens förvalda momskod, se [Land och momskod](#land-och-momskod).
- **Adresser** — en lista med valbara **Leveransadresser** (**+ Ny leveransadress**), var och en med **Benämning** (t.ex. "Huvudlager"), adress, postnummer och postort. Knappen **Kopiera från adressen** i dialogen fyller i adressfälten från Allmänt-flikens adress (visas bara när en adress finns). En adress kan markeras som **Förvald**; max en adress åt gången är förvald, markeras en ny flyttas markeringen automatiskt. Till skillnad från kundkortets adressflik finns ingen fakturaadress här — leverantörens adress på Allmänt-fliken används som den.
- **Villkor & frakt** — organisationsnummer, VAT-nummer, **Momskod (förval)**, **Kostnadsställe (förval)** (när det finns kostnadsställen), leveransvillkor, betalningsvillkor, speditör och kundnummer hos speditör. Villkor och speditörer väljs ur registren under [Grunddata](/hjalp/grunddata) och visas med sitt namn, t.ex. "30 dagar netto". Här anges också leverantörens **Leveransdagar**, **Dagarna avser** och **Transportdagar**, se [Leveransdagar](#leveransdagar).
- **Kontakter** — flera kontakter per leverantör med namn, telefon, mobil, e-post och kommentar. En kontakt kan markeras som **Huvudkontakt** och visas då överst.

Uppe till höger på kortet finns **+ Ny förfrågan** och **+ Ny inköpsorder** — båda skapas med leverantören förvald.

### Betalning

Fliken **Villkor & frakt** har sektionen **Betalning**. Där väljer du **Betalningssätt** — **Bankgiro**, **Plusgiro**, **Bankkonto**, **IBAN** eller **Utländskt kontonummer** — och fyller i uppgifterna för det valda sättet. Nav kontrollerar siffrorna (kontrollsiffran på bankgiro och plusgiro, IBAN-kontrollen) och sparar dem utan mellanslag och bindestreck. En leverantör utan betalningssätt kan inte betalas via betalfil. Fel visas under respektive fält när du klickar **Spara betalningsuppgifter**.

- **Bankkonto** (svenskt konto) tar **Clearingnummer** och **Kontonummer**. Clearingnummer i 8-serien (Swedbank) ska vara 5 siffror, t.ex. 8327-9; övriga banker har 4 siffror.
- **IBAN** gäller IBAN från alla länder, inte bara svenska. **BIC** är frivillig inom SEPA-området och krävs för IBAN i övriga länder (*BIC krävs för IBAN utanför SEPA-området*).
- **Utländskt kontonummer** är för konton i länder utan IBAN, t.ex. USA, Kanada och Australien. Fyll i **Kontonummer** (bokstäver och siffror, högst 34 tecken) och identifiera mottagarbanken med **BIC** och/eller ett nationellt bank-id: välj typen i **Bank-id (typ)** — *USA – ABA routing number*, *Kanada – CPA routing number*, *Australien – BSB*, *Storbritannien – sort code*, *Hongkong – bank code*, *Indien – IFSC*, *Nya Zeeland – bank/branch*, *Sydafrika – branch code* eller *Kina – CNAPS* — och skriv numret i **Bank-id**; hjälptexten under fälten säger hur många siffror just den typen har. Antingen BIC eller bank-id måste anges (*Ange BIC eller bank-id (t.ex. ABA routing number)*). **Bankens namn** behövs hos vissa banker (Nordea) när mottagarbanken bara anges med bank-id. Mottagare i SEPA-området betalas med IBAN (*Mottagare i SEPA-området betalas med IBAN*), och leverantörens **Land** får inte vara **SE** (*Ett utländskt kontonummer kräver att leverantörens land inte är Sverige*).

För en mottagare utomlands — ett IBAN som inte börjar med SE eller ett utländskt kontonummer — visas också två fält:

- **Avgiftsfördelning** — **Delade avgifter (SHA)** (förval; vi betalar vår banks avgifter och mottagaren sin) eller **Vi betalar alla avgifter (OUR)**. Valet gäller internationella betalningar. En betalning i EUR inom SEPA-området skickas alltid med SEPA-avgifter, oavsett valet, och Nordea tar bara delade avgifter till en bank inom EU/EES.
- **Betalningskod (Skatteverket)** — tre siffror, förval **101** (varuexport/varuimport). Koden skrivs i betalfilen för betalningar över 150 000 kr, som banken rapporterar till Skatteverket (KU81) — se [Utlandsbetalningar](#utlandsbetalningar).

En utländsk mottagare kräver dessutom **gatuadress** och **ort**, som fylls i på fliken **Allmänt** (fälten **Adress** och **Postort**; **Land** sätts där också). Saknas de visar sektionen *En utländsk mottagare kräver gatuadress och ort* och betalfilen kan inte exporteras. Sparar du betalningsuppgifter som bryter mot reglerna, eller ändrar adress eller land så att de gör det, avvisas ändringen med felet vid fältet — på fliken **Allmänt** visas samma text överst.

### Land och momskod

Leverantörens **Land** (fliken **Allmänt**) och **Momskod (förval)** (fliken **Villkor & frakt**) styr hur en ny leverantörsfaktura från leverantören beskattas — se [Momskod och omvänd moms](#momskod-och-omvand-moms). **Momskod (förval)** är en lista över aktiva momskoder för inköp. Lämnar du den på **Härleds ur landet** väljer Nav koden efter landet, och hjälptexten under fältet säger vilken: **Sverige** ger **Moms 25 %**, ett **annat EU-land** **Inköp varor från EU 25 %** (omvänd moms på EU-varor) och **övriga länder** **Inköp varor utanför EU (importmoms separat)**. Köper du tjänster från leverantören, eller varor med en annan momssats, väljer du en annan kod som förval här eller på fakturan. Ändrar du **Land** på en leverantör som bara fått ett automatiskt förval följer koden med; ett eget val ligger kvar. Står valutan på något annat än SEK men **Land** på **SE** varnar leverantörskortet — *Leverantören har annan valuta än SEK men land Sverige — kontrollera landet. Landet avgör momskoden på leverantörsfakturan (Sverige ger svensk moms, inte omvänd moms).* — eftersom det nästan alltid är en utländsk leverantör som fått förvalet. Leverantörer som lades upp innan landet fanns fick landet utläst ur sitt VAT-nummer och annars ur sitt IBAN (annars **SE**); kontrollera **Land** på dina utländska leverantörer.

### Leveransdagar

Vissa leverantörer levererar bara vissa veckodagar, eller skickar varor bara vissa dagar. Det anger du på leverantörskortets flik **Villkor & frakt**, och Nav använder det för att föreslå datum och varna när ett datum inte passar. Förslagen och varningarna är bara stöd — de spärrar aldrig något, och du kan alltid skriva ett eget datum.

Fälten på fliken **Villkor & frakt**:

- **Leveransdagar** — kryssrutorna **Mån**, **Tis**, **Ons**, **Tor**, **Fre**, **Lör** och **Sön**. Hjälptexten säger "Lämna tomt om alla dagar fungerar." Ingen dag vald betyder att leverantören saknar fasta dagar — alla arbetsdagar fungerar, och inga förslag eller varningar görs.
- **Dagarna avser** — väljer vad veckodagarna betyder: **Systemets förval (…)** (förvalets namn står inom parentes) eller ett av lägena **Ankomst till oss** respektive **Avsändning från leverantören**.
- **Transportdagar** — hur många arbetsdagar transporten tar. Tomt betyder systemets förval; platshållaren visar förvalet, t.ex. *Förval: 0*.

Spara med **Spara**. Förvalet för läge och transportdagar sätts för alla leverantörer under [System → Inställningar → Leveransdagar](/hjalp/system#leveransdagar); en leverantör kan avvika. Veckodagarna har inget förval.

**Så räknas datumen:**

- **Ledtid och transportdagar räknas i arbetsdagar** — måndag–fredag utom helgdagar i [helgdagsregistret](/hjalp/personal-tid#helgdagar). En helgdag med eget dagschema (en kortdag) räknas som arbetsdag. Ett förslag räknas aldrig från en lördag eller söndag: en beräkning "från i dag" startar på nästa arbetsdag.
- Läget **Ankomst till oss**: veckodagarna är de dagar varorna kan komma fram till oss. Förslaget är den första sådan dag som ligger efter leverantörens ledtid och transportdagar.
- Läget **Avsändning från leverantören**: veckodagarna är de dagar leverantören skickar. Ankomsten är avsändningsdagen plus transportdagarna.
- **Ledtiden** är leverantörskatalogens **Ledtid (dagar)** på artikelkortets Inköp-flik (se [Artiklar](/hjalp/artiklar#inkop)) — arbetsdagar tills leverantören kan skicka. Ledtid och transportdagar adderas.

**Var du ser det:**

- **Ny inköpsorder:** väljer du en leverantör med leveransdagar fylls **Önskat leveransdatum (valfritt)** i med den tidigast möjliga ankomstdagen från i dag. Ändrar du datumet själv rör förslaget det inte mer. Under fältet står leverantörens dagar, t.ex. "Levereras till oss mån, tor" eller "Leverantören skickar mån, tor · 2 transportdagar".
- **Inköpsorderkortet:** samma sammanfattning visas under huvudets datum. I **Lägg till rad** föreslås tidigaste ankomst när artikeln väljs, med artikelns ledtid i leverantörskatalogen (plus leverantörens dagar och transportdagar). Förslaget fylls i radens **Önskat leveransdatum** bara om det är senare än orderns datum eller ordern saknar datum — annars följer raden ordern.
- **Varningar** visas under datumfälten på ny inköpsorder och på inköpsorderkortets huvud och rader, bara när leverantören har leveransdagar. I ankomstläget: "Leverantören levererar inte till oss på onsdagar." (på en helgdag: "Leverantören levererar inte till oss på helgdagar."). I avsändningsläget: "Datumet passar inte leverantörens avsändningsdagar (mån, tor + 2 transportdagar)."
- **Skapa ordrar** i behovsberäkningen sätter inköpsordrarnas datum efter leverantörens dagar, se [Önskat leveransdatum](#onskat-leveransdatum).

En **förfrågan** får varken förslag eller varning. Leverantörsimporten läser inte fälten — de sätts på kortet.

## Importera leverantörer

**Inköp → Leverantörer → Importera** öppnar en guide med tre flikar — **Leverantörer**, **Kontakter** och **Leveransadresser** — som tillsammans tar in en fullständig leverantörsexport. Endast administratörer har åtkomst. Filer läses som CSV (semikolon, komma och tabb känns alla igen — även teckenkodningen identifieras automatiskt) eller Excel (.xlsx, bara det första bladet läses). Varje flik kör sin egen guide i fyra steg: **Fil**, **Kolumner**, **Förhandsgranska** och **Resultat**.

Mallen laddas ned med **Ladda ned mall** i fliken; kolumnerna förklaras i [Importmallar](/hjalp/importmallar#leverantorer) (kontakter: [Leverantörskontakter](/hjalp/importmallar#leverantorskontakter), leveransadresser: [Leverantörernas leveransadresser](/hjalp/importmallar#leverantorernas-leveransadresser)).

Leverantörsexporten består av flera separata filer. **Fliken Leverantörer** körs en gång per fil, alltid i den här ordningen:

1. **Lista** — skapar leverantörerna (matchning på leverantörsnummer; finns leverantören redan uppdateras den i stället) med kortnamn, organisationsnummer, VAT-nummer och vårt kundnummer hos leverantören.
2. **Postadress** — ersätter kortnamnet med det juridiska namnet ("Postadress – Namn") och fyller i adressen.

Kör alltså de två filerna efter varandra genom samma flik, utan att kryssa i **Hoppa över rader som redan finns** mellan körningarna — annars skrivs Postadress-filens fält aldrig in. Körs Lista-filen i stället *efter* Postadress skriver dess kortnamn över det juridiska namnet — sätt då kolumnen "Namn" till **Importera inte**. Kontakter och leveransadresser importeras efteråt, var för sig, på sina egna flikar (kräver att leverantörerna redan finns). Exportens Besöksadress-fil har ingen motsvarighet i Nav och hoppas över; någon fakturaadress finns inte på leverantörer.

1. **Fil** — välj filen med filväljaren, så läses den in direkt. Första raden ska innehålla kolumnrubriker. Max 10 000 rader per fil.
2. **Kolumner** — varje kolumn i filen mappas mot ett fält; kända rubriker föreslås automatiskt (se listorna nedan) och kolumner satta till **Importera inte** hoppas över. Kryssrutan **Hoppa över rader som redan finns** lämnar poster som redan finns helt orörda i stället för att uppdatera/skapa dem — se [Hoppa över befintliga rader](/hjalp/artiklar#hoppa-over-befintliga-rader). Klicka **Förhandsgranska** för att gå vidare.
3. **Förhandsgranska** — varje rad visas som **Ny**, **Uppdateras** eller **Hoppas över** tillsammans med eventuella fel och varningar. En ruta ovanför tabellen listar de register som kommer att skapas automatiskt (se nedan). Knappen **Importera** är låst tills alla fel är åtgärdade — rätta filen och börja om från steget **Fil**.
4. **Resultat** — visar hur många rader som skapades, uppdaterades och hoppades över, plus vilka register som skapades. De överhoppade listas i tabellen **Överhoppade rader**, som kan sparas som fil eller skrivas ut. **Klar** går tillbaka till leverantörsregistret.

### Fliken Leverantörer

Kolumner som känns igen automatiskt (exportfilens egna rubriker inom citattecken) och fältet de mappas mot:

- **Lista-filen**: "Leverantör" → Leverantörsnummer, "Namn" → Namn (kortnamnet — ersätts av det juridiska namnet i nästa steg), "Organisationsnummer", "Momsreg.nr" → VAT-nummer, "Vårt kundnr" → Vårt kundnummer. Övriga kolumner (Leverantörsroll, Leverantörsgrupp, Webbsida m.fl.) saknar motsvarighet och lämnas omappade.
- **Postadress-filen**: "Leverantör" → Leverantörsnummer, "Postadress – Namn" → Namn, "Postadress – Adressrad 1/2/3" → Adress/Adressrad 2/Adressrad 3 (slås ihop till en adress med radbrytning; Adressrad 4 saknar motsvarighet), "Postadress – Postnummer" → Postnummer, "Postadress – Stad" → Postort. "Postadress – Land" och "Land" → Land (landskod med två bokstäver; tom cell ger **SE** på en ny leverantör). Den kortare kolumnen "Namn" mappas automatiskt bara i Lista-filen — i Postadress- och övriga filer lämnas den omappad så att det juridiska namnet aldrig skrivs över av misstag.

Övriga mappningsbara fält: Kontaktperson, E-post, Telefon, Land, Valuta, Betalningsvillkor, Leveransvillkor, Leveranssätt/speditör och Kundnummer hos speditör — de fyra sista fylls i på leverantörskortets flik **Villkor & frakt** och känns igen från rubriker som "Betalningsvillkor", "Leveransvillkor", "Leveranssätt"/"Speditör" och "Kundnummer hos speditör" i en egen CSV. **Leverantörsnummer** är obligatoriskt (märkt *). Namn behövs bara för nya leverantörer — kolumnen kan lämnas omappad och cellen får vara tom vid uppdatering.

Regler att känna till:

- **Allt eller inget.** Innehåller filen ett enda radfel importeras ingenting — det som förhandsgranskningen visar som fel måste rättas i filen först. Varningar stoppar däremot aldrig importen.
- **Tomma celler skriver aldrig över.** Vid uppdatering lämnas fält med tom cell orörda; vid ny leverantör lämnas de tomma.
- **Valuta** versaliseras automatiskt ("eur" blir "EUR") och måste vara en kod på tre bokstäver — annars stoppas raden med felet "Ogiltig valutakod '…' — ange 3 bokstäver, t.ex. SEK". Tom valutakolumn ger **SEK** för nya leverantörer och rör inte befintliga.
- **Ogiltig e-postadress stoppar inte raden.** Adressen hoppas över med varningen "Ogiltig e-postadress '…' — fältet lämnades tomt", och fältet behåller sitt tidigare värde vid uppdatering.
- **Vårt kundnummer** fyller i vårt kundnummer hos leverantören på leverantörskortets flik **Allmänt** — det skrivs ut som "Vårt kundnummer hos er" på förfrågan och inköpsorder.
- Samma leverantörsnummer två gånger i filen ger fel på den andra raden.
- Numeriska leverantörsnummer räknar upp leverantörernas nummerserie, så nästa **+ Ny leverantör** får ett nummer ovanför det högsta importerade. Serien sänks aldrig, och leverantörsnummer med bokstäver importeras som de är utan att röra serien (se [Nummerserier](/hjalp/system#nummerserier)). Nollutfyllda nummer ("0001") behålls som de är.
- **Betalningsvillkor, Leveransvillkor och Leveranssätt skapas automatiskt** i respektive register om värdet i filen inte redan finns där (namn- eller kodmatchning, skiftlägesokänsligt) — förhandsgranskningen visar vilka som kommer att skapas. Ett betalningsvillkor av typen "30 dagar netto" får koden **30**, vilket styr förfallodatumberäkningen (se [Leverantörsreskontra](#leverantorsreskontra)); övriga skapade poster får koden av namnet versaliserat.

### Fliken Kontakter

Läser exportens **Referenser**-fil. Mappningsbara fält (filens rubrik inom citattecken där den skiljer sig från fältnamnet): Leverantörsnummer ("Leverantör"), Namn ("Referens – Namn"), Förvald, Telefon, Mobiltelefon, E-post, Anmärkning, Faxnummer (läggs till i Anmärkning som "Fax …", eftersom kontakter saknar ett eget faxfält). Leverantörsnummer och Namn är obligatoriska.

- Leverantören måste redan finnas i registret (importera fliken **Leverantörer** först) — annars blir raden ett radfel.
- En kontakt som redan finns hos leverantören (samma namn, skiftlägesokänsligt) hoppas över — kontakter uppdateras aldrig via import, bara skapas.
- Förekommer samma namn två gånger på samma leverantör i filen hoppas den senare raden över ("Kontakten förekommer flera gånger i filen") — den första raden vinner, även om raderna skiljer sig i telefon, e-post eller anmärkning.
- Bara en kontakt per leverantör kan vara **Förvald**. Har leverantören redan en huvudkontakt (eller har en tidigare rad i filen redan satt en) blir raden en varning i stället, och kontakten skapas som vanlig kontakt.

### Fliken Leveransadresser

Läser exportens **Leveransadress**-fil. Mappningsbara fält (filens rubriker "Leveransadress – …" känns igen automatiskt): Leverantörsnummer ("Leverantör"), Namn ("Leveransadress – Namn" — etiketten på adressen; saknas den blir den "Leveransadress"), Adressrad 1–3 (slås ihop som på leverantörsfliken), Postnummer, Stad. Leverantörsexporten saknar egna kolumner för postnummer och stad — de ligger i regel på Adressrad 3 och följer med i den sammanslagna adressen. "Leveransadress – Land" mappas inte.

- Leverantören måste redan finnas i registret.
- En rad utan adress (exporten skriver en rad per leverantör även när ingen leveransadress är registrerad) hoppas över, liksom en adress som är identisk med leverantörens egen adress. Saknar raden postnummer och stad jämförs bara adressraderna — så en rad som bara upprepar leverantörens postadress skapar ingen extra leveransadress.
- En adress som redan finns registrerad på leverantören hoppas också över.
- Kryssrutan **Sätt som förvald leveransadress** gör att en leverantör som ännu saknar en förvald adress får sin första importerade adress som förvald — aldrig en till om leverantören redan har en förvald sedan tidigare.

## Importera inköpspriser

Fliken **Inköpspriser** på **Artiklar → Importera** läser in artiklarnas leverantörskatalog (fliken **Inköp** på artikelkortet, se [Artiklar](/hjalp/artiklar#inkop)) från exporten **Prislista Inköp**. Mallen laddas ned med **Ladda ned mall** i fliken; kolumnerna förklaras i [Importmallar](/hjalp/importmallar#inkopspriser).

Två exportfiler läses med samma flik:

- **Prislista-Inköp (Lista)** — en rad per artikel och leverantör med rubrikerna **Förvald**, **Leverantör** (leverantörsnumret), **Lev. art.nr**, **Pris** och **Rabatt**, som alla känns igen automatiskt. **Förvald** = Ja gör leverantören till artikelns **huvudleverantör**.
- **Prislista-Inköp (stafflat)** — samma rader men en rad per **staffelsteg**: kolumnen **Gränsvärde antal** och en andra **Pris**-kolumn (guiden visar den som **Pris (2)** och mappar den till **Staffel: pris**). Grundpriset upprepas på varje rad. Filen saknar Förvald, så huvudleverantören lämnas orörd när den läses in.

Kolumner: **Artikelnummer** och **Leverantörsnummer** är obligatoriska; **Leverantörens artikelnummer**, **Pris**, **Rabatt (%)**, **Huvudleverantör (Förvald)**, **Staffel: från antal (Gränsvärde)** och **Staffel: pris** är valfria. Namn, Ställpris och Prisdatum importeras inte.

Regler att känna till:

- Artikeln och leverantören måste redan finnas (leverantören matchas på **leverantörsnummer**, se [Importera leverantörer](#importera-leverantorer)).
- **Rabatten räknas in i priset.** Filens Pris är bruttopriset och Rabatt en procentsats på det; katalogen har inget rabattfält, så importen sparar nettopriset Pris × (1 − Rabatt/100) — för grundpriset och varje staffelsteg — och varnar på raden att rabatten bakats in. Tomt Pris ger en katalograd utan pris.
- **Staffeln ersätts som helhet** per artikel och leverantör när kolumnen Gränsvärde är mappad — den stafflade filen är en fullständig lista, så en leverantör utan staffelrader i filen får sin staffel rensad. Läser du den vanliga listan (utan Gränsvärde) rörs stegen inte alls. Ett gränsvärde på 1 eller lägre ignoreras med en varning (antal 1 är grundpriset), ett gränsvärde utan pris eller samma gränsvärde två gånger är ett fel.
- **Huvudleverantör**: när kolumnen Förvald är mappad blir raden med Ja huvudleverantör och en tidigare huvudleverantör avmarkeras; Nej eller en tom cell tar bort markeringen från en befintlig katalograd. Två Ja på samma artikel i filen är ett fel.
- **Valuta**: en ny katalograd får leverantörens valuta (som när raden läggs upp på artikelkortet), och priset tolkas i den; en befintlig katalograd behåller sin valuta.
- En leverantör som redan finns i artikelns katalog uppdateras (pris, artikelnummer, huvudleverantör och staffel); med **Hoppa över rader som redan finns** lämnas hela katalograden orörd, staffel inräknad. Se [Hoppa över befintliga rader](/hjalp/artiklar#hoppa-over-befintliga-rader).
- Förhandsgranskningen räknar rader; resultatet räknar katalograder — en artikel-leverantör med tre staffelsteg är fyra rader men en katalogpost.

## Förfrågningar (prisförfrågan)

**Inköp → Förfrågningar** är rutinen för att begära pris från en leverantör innan beställning. Varje förfrågan får ett eget nummer i FO-serien.

### Skapa och driva en förfrågan

1. **+ Ny förfrågan** (från listan eller leverantörskortet). Välj leverantör, ev. **Önskat leveransdatum** (skrivs ut på förfrågans PDF så leverantören ser när vi behöver varorna) och anteckning, och lägg rader med artikel, antal och enhet — **á-priset är valfritt** och lämnas normalt tomt. Enhetsvalet fungerar som på inköpsorderrader (förifylls med artikelns inköpsenhet, byte räknar om antal/pris) och följer med när förfrågan görs till inköpsorder. Förfrågan får automatiskt leverantörens **Leveransvillkor**, **Betalningsvillkor** och **Speditör** — de visas i huvudet på förfrågningskortet och kan ändras med **Ändra** (dialogen **Ändra villkor och frakt**) tills förfrågan är beställd eller avbruten, och skrivs ut på PDF:en när de är satta. Samma dialog innehåller **Frakt på vårt konto**, som fungerar som på inköpsordern (se nedan) och följer med när förfrågan görs till order.
2. Skicka förfrågan till leverantören: **Skicka via e-post** under rubriken **E-post** mejlar förfrågan som PDF-bilaga och sätter status **Skickad** automatiskt (se [Skicka dokument via e-post](#skicka-dokument-via-e-post)). Skickas den utanför systemet, klicka i stället **Skicka förfrågan** i knappraden under raderna.
3. När svaret kommit: klicka **Markera besvarad** och fyll i priserna på raderna med **Ändra** (status **Besvarad**). Rader kan läggas till, ändras och tas bort ända tills förfrågan beställs.
4. Klicka **Gör till inköpsorder** — en ny inköpsorder skapas med raderna kopierade (rader utan pris får 0), förfrågan får status **Beställd** och länkas till ordern. Du hamnar direkt på inköpsordern.
5. **Avbryt förfrågan** kan göras när som helst före beställning (status **Avbruten**).

Radlistan visar **Belopp** per rad (antal × á-pris) och summerar längst ned. Så länge någon rad saknar pris heter summan **Summa besvarade** och räknar bara de prissatta raderna; när alla rader har pris heter den **Summa**.

| Status | Betydelse |
|---|---|
| Utkast | Registrerad men inte skickad |
| Skickad | Skickad till leverantören |
| Besvarad | Leverantören har svarat; priser ifyllda |
| Beställd | Konverterad till inköpsorder (låst) |
| Avbruten | Avbruten (låst) |

### Legorader på förfrågan

Precis som en inköpsorderrad (se [Lego-rader](#rader-och-statusflode) nedan) kan en förfrågansrad köpa en legooperation i stället för att vara en vanlig artikelrad. I dialogen **Lägg till rad** väljer fältet **Legooperation** vad raden gäller: **Ingen (vanlig rad)**, eller en av artikelns lego-operationer — antingen kopplad till en tillverkningsorder (t.ex. **TO-1024 · Op 20 · Ytbehandling**) eller, saknas en pågående TO, direkt mot beredningens operation för en ren prisförfrågan utan TO-koppling (**Op 20 · Ytbehandling (beredning)**). Valet fyller i **Ställpris** från operationen. Ställpriset visas som en egen kolumn i radlistan och redigeras, liksom antal/enhet/á-pris, med radens **Ändra** — fältet finns bara på lego-rader. Radens belopp räknas som antal × á-pris + ställpris, precis som på inköpsordern.

Under artikelnamnet i radlistan visas en dämpad referensrad som visar vilken operation raden gäller, t.ex. **Lego för TO-1024 · Op 20 · Ytbehandling** för en rad kopplad till en tillverkningsorder; en TO-lös rad (kopplad direkt mot beredningen) visar en kortare referens utan ordernummer. Samma referens skrivs ut på förfrågans PDF tillsammans med **Ställpris: …**, samt **Nettovikt: … kg** när operationens **Visa nettovikt på legoinköpet** är ikryssad och artikeln har en vikt, och **Ytbehandling: … · Färg: …** när artikeln har värden i de fälten (se [Artiklar](/hjalp/artiklar#allmant)).

**Gör till inköpsorder** för en legorad som är kopplad till en tillverkningsorder tar med operationskopplingen och ställpriset till inköpsorderraden, så att [Inleverans](#inleverans) avrapporterar operationen som vanligt. En **TO-lös** legorad (en ren prisförfrågan mot beredningen) blir i stället en helt vanlig inköpsorderrad med ställpriset kvar — ingenting rapporteras mot någon operation vid inleveransen, och ordermejlet har ingen ritningskälla för raden (kryssa i **Bifoga ritningar** om ritningen ändå ska med). Har flera förfrågningar skickats till olika leverantörer för samma TO-operation (för att jämföra pris) är det bara den ena som ska göras till order — **Gör till inköpsorder** på båda ger två inköpsorderrader som var för sig avrapporterar operationen vid inleverans, och behovsberäkningen räknar då operationen som beställd två gånger.

När en legorad har fått ett pris visas knappen **Uppdatera beredningens legopris** — från status **Besvarad**, och även efter **Beställd**. Den skriver radens styckpris, ställpris och förfrågans leverantör till artikelns beredningsoperation, efter bekräftelsen "Skriv styckpris, ställpris och leverantör till beredningens operation Op 20?". Uppdateringen sker aldrig automatiskt — det är alltid ett medvetet klick.

## Inköpsorder

**Inköp → Inköpsorder** listar alla ordrar med sök och statusfilter. Filtret **Alla ordertyper** kan ställas på **Legoinköp** — ordrar med minst en [lego-rad](#rader-och-statusflode), alltså en rad som köper en operation på en tillverkningsorder — eller **Övriga inköp** (ordrar utan lego-rad). En order som blandar lego-rader och vanliga rader räknas som legoinköp. Exporten till CSV följer filtret.

### Skapa

**+ Ny inköpsorder** från listan eller leverantörskortet: välj leverantör, ev. **Önskat leveransdatum** (se [Önskat leveransdatum](#onskat-leveransdatum)), **växelkurs** (mot SEK — visas när leverantören fakturerar i annan valuta; valutan snapshotas från leverantören), **Er referens** (leverantörens referens), **Vår referens** och anteckning. Ordern får ett IO-nummer och skapas som **Utkast**.

En konfigurerbar mall i läget Variantartiklar (se [Artiklar](/hjalp/artiklar#varianter)) går inte att välja på inköpsorder- eller förfrågningsrader — artikelväljaren döljer den; köp i stället en av dess varianter.

Orderkortet inleds med **orderhuvudet**: ett kort med status, **Rev**, valuta och orderns uppgifter — **Leverantör** (klickbar till leverantörskortet), **Önskat leveransdatum**, **Bekräftat leveransdatum**, **Växelkurs**, **Er referens**, **Vår referens**, **Frakt på vårt konto**, de tre villkoren och **Notering**. Knappen **Ändra** öppnar dialogen **Ändra orderhuvud** där allt detta redigeras på ett ställe och sparas i ett svep, så länge ordern är i status Utkast, Bekräftad eller Delvis mottagen. Valutan är låst till leverantörens valuta vid skapandet. Er referens och Vår referens skrivs ut på PDF:en när de är satta.

Under **Ändra** på orderhuvudet kan ordern få ett **Projekt** (visas i huvudet när det är satt). Det följer med till leverantörsfakturan när fakturaunderlaget hämtas från ordern, se [Kostnadsställe och projekt på fakturan](#kostnadsstalle-och-projekt-pa-fakturan).

Ordern får automatiskt leverantörens **Leveransvillkor**, **Betalningsvillkor** och **Speditör** (skapas ordern från en förfrågan tas villkoren från förfrågan i stället). De skrivs ut på PDF:en när de är satta.

### Önskat leveransdatum

**Önskat leveransdatum** talar om för leverantören när vi vill ha varorna. Datumet i orderhuvudet gäller hela ordern och skrivs ut på inköpsorderns PDF som **Önskat leveransdatum: …** under ordernumret. Ska en enskild rad komma ett annat datum sätter du radens eget datum:

- I **Lägg till rad** finns fältet **Önskat leveransdatum (valfritt)** — tomt betyder samma som ordern.
- På en befintlig rad redigeras datumet med **Ändra** (under benämningen); töm fältet så följer raden ordern igen.
- En rad med eget datum visar **Önskat leveransdatum …** under benämningen på orderkortet, och på PDF:en skrivs datumet ut under raden. Rader som följer orderns datum får ingen egen rad — orderns datum gäller för dem.

Radens datum (annars orderns) är också det datum inleveransen räknas på i [artikelöversikten](/hjalp/artiklar#artikeloversikt) och i [färdigdatumsförslaget](/hjalp/tillverkning#foreslaget-fardigdatum). Inköpsordrar som [behovsberäkningens](/hjalp/tillverkning#orderforslag-och-skapa-ordrar) **Skapa ordrar** skapar får datumet satt automatiskt: arbetsdagen före varje artikels första otäckta behov, där ordern får det tidigaste och rader med ett senare behov får sitt eget datum. Har leverantören [leveransdagar](#leveransdagar), ledtid eller transportdagar följer datumet dem i stället: den senaste möjliga ankomsten **före** behovsdagen enligt leverantörens dagar, men aldrig tidigare än den tidigast möjliga ankomsten med ledtid och transportdagar. Hamnar leveransen efter behovet skapas ordern ändå och en varning listas i resultatet.

Har leverantören [leveransdagar](#leveransdagar) fylls datumet i på **Ny inköpsorder** och i **Lägg till rad** med ett förslag, och ett datum som inte passar ger en varning (som aldrig spärrar).

I orderhuvudet finns även kryssrutan **Frakt på vårt konto**. Kryssa i den när företaget står för frakten — då skrivs företagets eget kundnummer hos den valda speditören ut bredvid speditören på inköpsorderns PDF ("Vårt kundnr: …"), så leverantören kan boka frakten på rätt konto. Kundnumren läggs upp per speditör under [Företagsinformation → Speditörer](/hjalp/system#foretagsinformation); finns inget kundnummer för orderns speditör skrivs inget extra ut.

### Bekräftat leveransdatum

När leverantören har bekräftat ordern fyller du i **Bekräftat leveransdatum** i **Ändra orderhuvud**. Datumet gäller direkt på alla rader som inte har ett eget bekräftat datum — det är förifyllt på raderna. Kommer en rad ett annat datum ändrar du den raden med **Ändra** (fältet **Bekräftat leveransdatum**, med texten "Tomt = som ordern" under); töm fältet så följer raden orderns bekräftade datum igen. Ändrar du orderns datum senare behåller rader du redan ändrat sitt eget datum. Fältet finns också i **Lägg till rad**.

En rad med eget bekräftat datum visar **Bekräftat leveransdatum …** under benämningen. Det bekräftade datumet går alltid före det önskade: [artikelöversikten](/hjalp/artiklar#artikeloversikt), [färdigdatumsförslaget](/hjalp/tillverkning#foreslaget-fardigdatum), behovsberäkningen och [Leveranstidskontrollen](/hjalp/forsaljning#leveranstidskontroll) räknar varorna på radens bekräftade datum, annars orderns bekräftade, annars radens önskade, annars orderns önskade. Det bekräftade datumet skrivs inte ut på inköpsorderns PDF, eftersom det är leverantören som har lämnat det.

Kolumnen **Leveransdatum** i inköpsorderlistan och bevakningslistan på [Översikten](/hjalp/komma-igang#oversikten) visar **nästa leveransdatum**: det tidigaste datumet bland raderna som inte är fullt mottagna. Ordern visas alltså som sen så fort en rad är sen, även när resten kommer senare. Leveransprecisionsrapporten mäter fortfarande mot orderns **Önskat leveransdatum**.

### Rader och statusflöde

Under orderhuvudet ligger radlistan, och under den en **knapprad** med de åtgärder som är möjliga i orderns aktuella status.

- Rader läggs till med **Lägg till rad** i knappraden — dialogen tar artikel via artikelväljaren, antal, enhet och á-pris. **Á-priset förifylls** från orderns leverantör i artikelns leverantörskatalog (fliken Inköp på artikelkortet) så snart artikel och antal är valda, med hänsyn till leverantörens staffel: ändras antalet över ett staffelsteg räknas priset om. Ett á-pris du själv skrivit in ligger kvar även om antalet ändras ("manuellt vinner"). Saknar leverantören pris för artikeln, eller har katalograden en annan valuta än ordern, lämnas fältet orört. Samma förifyllning gäller i **Ändra** på en befintlig rad när antalet ändras. Raderna kan ändras (**Ändra** — antal, enhet, á-pris och radens **Önskat leveransdatum** och **Bekräftat leveransdatum**, samt **Ställpris** på lego-rader, se nedan) och tas bort (**Ta bort**) så länge ordern är i status Utkast, Bekräftad eller Delvis mottagen. Antalet kan aldrig sättas under det som redan är mottaget, och en rad med mottaget gods kan inte tas bort. Har artikeln en **Avrundning** (Lager-fliken på artikelkortet) avrundas antalet uppåt till närmaste multipel i grundenheten när raden sparas — skriver du 12 på en artikel med Avrundning 5 blir raden 15; detsamma gäller förfrågningsrader. En konfigurerbar mall — i läget Variantartiklar eller Beställningsvara — visas inte i artikelväljaren på inköpsorder och förfrågan och kan inte köpas in (API:et svarar att artikeln är en mall respektive en beställningsvara). Se [Artiklar](/hjalp/artiklar#lager).
- **Enhet på raden:** dropdownen **Enhet** visar artikelns grundenhet och alternativa enheter (se [Artiklar](/hjalp/artiklar)) och förifylls med artikelns **Inköpsenhet**. Byter du enhet räknas ifyllt antal och à-pris om direkt (500 kg ⇄ 100 st vid faktorn 1 st = 5 kg); à-pris-etiketten visar `kr/{enhet}`. Radantal och pris lagras alltid i grundenheten, men kortet och PDF:en visar raden i den valda enheten. Lagersaldot förs alltid i grundenheten.
- Kolumnen **Belopp** visar radens värde (antal × á-pris) och tabellen avslutas med **Summa** i orderns valuta. Beloppet är detsamma oavsett vilken enhet raden visas i. På en **lego-rad** (se nedan) läggs ställpriset till en gång i radens belopp och summan.
- **Lego-rader** skapas av [behovsberäkningen](/hjalp/tillverkning#behovsberakning) för lego-operationer och är knutna till en operation på en tillverkningsorder. Raden visar **Lego för** tillverkningsordernumret, operationen och eventuellt **Ställpris** under benämningen. Ställpriset (och antal, enhet, á-pris) redigeras med radens **Ändra** — fältet visas bara på lego-rader, tomt sparas som inget ställpris. På PDF:en skrivs samma TO-referens och ställpris ut under raden, samt **Nettovikt** (artikelns vikt × antal) när operationens **Visa nettovikt på legoinköpet** är ikryssad. Vid **Skicka via e-post** bifogas legoradernas ritningar **alltid** (artikelns filer eller operationens uppladdade ritning, enligt operationens ritningsval) — kryssrutan **Bifoga ritningar** styr bara övriga rader. Inleverans av en lego-rad avrapporterar operationen automatiskt, se [Inleverans](#inleverans).
- **Bekräfta** ordern när den är beställd hos leverantören — eller mejla den med **Skicka via e-post**, vilket bekräftar ordern automatiskt (se [Skicka dokument via e-post](#skicka-dokument-via-e-post)).
- Vid leverans: klicka **Ta emot leverans**, ange rad, lagerplats och antal i dialogen och klicka **Ta emot** — ett inleveranssaldo bokförs i lagret. Delleveranser stöds (status **Delvis mottagen** tills allt är mottaget). Hela ordern rapporteras smidigast i rutinen [Inleverans](#inleverans), som nås direkt med knappen **Inleveransrutinen**.
- **Stäng order** när den är färdighanterad; **Avbryt order** går att göra innan mottagning påbörjats.

| Status | Betydelse |
|---|---|
| Utkast | Rader kan läggas till och ändras |
| Bekräftad | Beställd hos leverantör; mottagning kan ske; rader fortfarande redigerbara |
| Delvis mottagen | Några rader delvis mottagna |
| Mottagen | Allt mottaget — lagerfört |
| Stängd | Avslutad |
| Avbruten | Avbruten |

### Ångra inleverans

Sektionen **Inleveranser** på inköpsorderkortet listar varje inleverans som gjorts på ordern — med **Ta emot leverans** eller i rutinen [Inleverans](#inleverans) — senaste först: **Tid**, **Artikel**, **Antal** (i radens enhet), **Lagerplats** och vem som tog emot (**Av**).

**Ångra** backar exakt den inleveransen, efter en bekräftelse:

- Varorna tas ut ur lager igen från den lagerplats de togs emot på. Finns de inte kvar där (de har förbrukats, flyttats eller levererats) vägras ångra och felmeddelandet visar hur mycket som finns kvar. Blir lagerplatsen tom städas den bort som efter vilket annat uttag som helst.
- Radens mottagna antal minskar och orderstatusen räknas om: **Mottagen** blir **Delvis mottagen**, och när inget längre är mottaget blir ordern **Bekräftad** igen.
- På en **lego-rad** ångras samtidigt rapporteringen som inleveransen gjorde på tillverkningsordern: operationens antal dras av, materialet läggs tillbaka i lager och färdiga varor från en sista operation tas ut ur lager igen. Allt sker på en gång, eller inte alls. Är tillverkningsordern inte längre öppen (t.ex. **Stängd**) kan inleveransen inte ångras.

En ångrad inleverans ligger kvar i listan, överstruken och märkt **Ångrad** med tid och vem som ångrade. Ångra kräver samma behörighet som att ta emot leverans (Inköp) och går bara när ordern är **Delvis mottagen** eller **Mottagen**, inte när den är stängd. När allt på en rad är ångrat kan raden tas bort. Ångrade inleveranser räknas inte i artikelns **Inleveranslogg**, i lagervärderingens senaste inköpspris eller i leveransprecisionen.

Inleveranser som gjordes innan funktionen fanns (oktober 2026) finns också i listan och kan ångras. Undantaget är lego-inleveranser som gjordes innan tillverkningens rapporteringslogg fanns, eller vars avrapportering misslyckades.

### Manuell statusändring

Knappen **Ändra status manuellt** längst till höger i orderkortets knapprad låter dig sätta vilken status som helst, åt vilket håll som helst — även från Avbruten eller Stängd. Välj status i dialogen och klicka **Byt status**; en bekräftelsedialog visas eftersom ändringen hoppar över orderflödets regler. Statusbytet bokför **aldrig** lager — inleveranser som redan är bokförda ligger kvar, och inget tas emot av att sätta status Mottagen.

### Revision

Ordern har ett revisionsnummer (**Rev** i orderkortets huvud) som börjar på 1. Varje gång orderns innehåll sparas — ändringar i orderhuvudet (leveransdatum, växelkurs, referenser, anteckning, villkor) och på raderna (lägg till, ändra, ta bort) — ställs frågan **"Ska ordern få en ny revision?"**: **OK** räknar upp revisionen med 1, **Avbryt** sparar ändringen utan att revisionen ändras. Hela orderhuvudet sparas i ett svep, så frågan kommer en gång även om du ändrar flera fält samtidigt. Statusändringar, inleveranser och e-postutskick påverkar inte revisionen. Revisionen skrivs ut direkt efter ordernumret på inköpsorderns PDF (t.ex. **Inköpsorder IO-1024 / 2**), så leverantören ser vilken version av ordern de har; utskriften kan stängas av med inställningen **Visa orderns revision på dokument** (se [System](/hjalp/system)).

Sektionen **Historik** längst ner på orderkortet visar orderns egna händelser — se [Händelselogg](/hjalp/system#handelselogg).

## Inleverans

**Inköp → Inleverans** är rutinen för att rapportera mottagning av hela inköpsorder på en gång:

1. Välj order i fältet **Inköpsorder** — sök på ordernummer, leverantör, artikelnummer eller benämning (till nytta när följesedeln bara visar leverantörens artiklar, inte vårt IO-nummer); varje träffrad visar datum, status och antal restrader. Så länge ingen order är vald visas i stället tabellen **Mottagbara ordrar** under sökfältet — samtliga ordrar i status **Bekräftad** eller **Delvis mottagen**, nyast först, klicka på ordernumret för att välja ("Inga ordrar väntar på inleverans." om listan är tom). Från inköpsorderkortet når du rutinen med ordern förvald via knappen **Inleveransrutinen**.
2. Välj **Lagerplats** (gäller hela rapporteringen).
3. Radtabellen visar **Beställt** (totalt antal på raden), Enhet, **Mottaget** och **Rest** (beställt minus mottaget, det som återstår att leverera in) per rad — allt i radens enhet — och fältet **Ta emot nu** är förifyllt med restantalet. Justera antalen — rader som sätts till 0 hoppas över. Antalet räknas om till grundenheten när saldot bokförs.
4. Klicka **Rapportera inleverans**. Varje rad bokförs som ett inleveranssaldo i lagret och orderstatusen uppdateras (**Delvis mottagen** tills allt är mottaget, därefter **Mottagen**). Eventuella fel visas per rad.

Enstaka rader kan fortfarande tas emot direkt på inköpsorderkortet med **Ta emot leverans**.

### Skanna i inleveransen

Överst i rutinen finns skanningsfältet (**Skanna inköpsorder, artikel eller lagerplats…**) — skanna med handskanner eller med knappen **Kamera**, precis som på [Lager → Skanna](/hjalp/lager#skanna). Rutinen fungerar i mobilen, så inleveransen kan göras ute vid godset. Under fältet visas vad den senaste skanningen gjorde; en varning visas i rött (och telefonen vibrerar, där det går).

- **Inköpsordern** väljer ordern. Inköpsorderns PDF har ordernumret som streckkod uppe till höger (inställningen **Streckkod på inköpsorder** under [System → Inställningar](/hjalp/system#installningar), på som standard), så en utskriven order kan skannas direkt. En order som inte är **Bekräftad** eller **Delvis mottagen** kan inte väljas ("IO-1006 kan inte tas emot — Utkast"). Har du redan räknat något på en annan order frågar rutinen först — **Byt order** släpper det räknade.
- **Lagerplatsens etikett** (LP-koden) väljer **Lagerplats**. En plats som inte har något saldo kan vara inaktiv — den aktiveras igen när varorna tas emot på den.
- **Artikeln** — artikelnumret eller **Streckkod (EAN)** på förpackningen — räknar en enhet på artikelns rad, i radens enhet. Den första artikelskanningen på en order nollställer de förifyllda restantalen och raden **Räknar skannade artiklar — rader med 0 tas inte emot.** visas: det är bara det du har räknat som tas emot. Antalen kan rättas för hand när som helst (Enter i fältet flyttar tillbaka markören till skanningsfältet), och **Fyll i restantal** går tillbaka till restantalen. Skannas mer än restantalet varnar rutinen ("… — mer än restantalet"); om överleveransen godtas avgör inställningen för överleverans när du rapporterar. En artikel som inte finns på ordern ("… finns inte på IO-…") eller som redan är helt mottagen räknas inte. Rader med en **tjänst** (till exempel frakt) räknas inte heller — de behåller sitt restantal när skanningen börjar och skrivs för hand.
- **Artikel innan ordern är vald.** Skannar du en artikel utan att ha valt order letar rutinen upp de mottagbara ordrar som väntar på artikeln. Finns den bara på en order väljs ordern och skanningen räknas; finns den på flera visas de under **Ordrar som väntar på …** — klicka på ordernumret, så räknas skanningen på den ordern (**Visa alla** visar hela listan igen).

Avsluta med **Rapportera inleverans** som vanligt.

**Överleverans.** Hur mycket mer än beställt som får tas emot på en rad styrs av inställningen **Tillåten överleverans på inköpsorder (%)** under [System → Inställningar](/hjalp/system#installningar): standard är 0 (aldrig mer än beställt), ett tomt fält betyder ingen gräns. Överleveransen tas emot i samma inleverans — skriv in hela det mottagna antalet i **Ta emot nu** (eller **Antal** i dialogen). En rad som blivit fullt mottagen visas inte längre i inleveransen, och radens antal kan inte ändras till mindre än det som tagits emot. Går antalet över gränsen avvisas raden med ett felmeddelande som anger den tillåtna procentsatsen.

**Lego-rader avrapporterar operationen automatiskt — och bokför inget inleveranssaldo för raden.** När en rad som är knuten till en lego-operation (skapad från [behovsberäkningen](/hjalp/tillverkning#behovsberakning)) inlevereras rapporteras det mottagna antalet som **Antal OK** på tillverkningsorderns operation — material som är kopplat till operationen dras enligt de vanliga reglerna. Till skillnad från vanliga rader bokförs **inget** inleveranssaldo för raden: en lego-rad köper en operation på artikeln som redan tillverkas, inte gods. Är lego-operationen tillverkningsorderns **sista** operation läggs det mottagna antalet in i lager som tillverkningsorderns färdiga varor (artikeln själv, inte en inköpsrad), och ordern blir **Klar** när hela antalet kommit — se [Tillverkning](/hjalp/tillverkning#inleverans-fran-sista-operationen). Annars lagerförs det färdiga godset när en senare operation rapporteras eller ordern slutförs. Den inleverans som gör raden fullt mottagen markerar samtidigt operationen som **Klar**. Bekräftelsen visar hur många legooperationer som avrapporterades. Kan operationen inte avrapporteras (t.ex. för att tillverkningsordern redan är Klar eller Stängd) registreras mottagningen på ordern ändå och en varning visas på raden — rapportera i så fall operationen manuellt från TO-kortet vid behov.

**Materialbrist på legorader.** Dras det material som hör till lego-operationen och saldot inte räcker styr inställningen **Materialbrist vid rapportering** (System → Inställningar, se [Tillverkning](/hjalp/tillverkning#materialbrist-vid-rapportering)). Med **Varning** får du frågan "Det saknas ingående delar: … Rapportera ändå?" **innan** inleveransen bokförs — svarar du nej bokförs ingenting. Med **Spärr** bokförs inleveransen ändå, men operationen avrapporteras inte och en varning visas på raden; fyll på lagret och rapportera operationen från TO-kortet.

## Fakturaunderlag

**Inköp → Fakturaunderlag** är arbetslistan över **inlevererade inköpsorder som väntar på en leverantörsfaktura**. Det är vyn du stämmer av inkommande leverantörsfakturor mot: varje rad är en inköpsorder som (helt eller delvis) tagits emot.

Listan visar en rad per inköpsorder med **Ordernr** (länk till orderkortet), **Leverantör**, **Mottaget** (senaste inleveransdatum), **Mottaget värde** (summan av mottaget antal × à-pris) och **Fakturastatus**. Som standard visas bara **ej fakturerade** order; filtret uppe till höger växlar mellan **Ej fakturerade**, **Fakturerade** och **Alla**, och du kan filtrera på leverantör och söka på ordernummer/leverantör.

- Är ordern ännu inte fakturerad visas knappen **Skapa faktura**, som öppnar dialogen **Ny leverantörsfaktura** förifylld på ordern — orderns rader hämtas som fakturaunderlag (mottaget antal, IO-matchade), och du fyller bara i leverantörens fakturanummer och kontrollerar beloppen (se [Leverantörsfakturor](#leverantorsfakturor) nedan).
- Är ordern redan fakturerad visas **Fakturerad** med en länk till leverantörsfakturan. En avbruten faktura räknas inte som fakturerad — ordern ligger då kvar i arbetslistan.

## Leverantörsfakturor

**Inköp → Leverantörsfakturor** är leverantörsreskontran — registret över mottagna leverantörsfakturor. Varje faktura får ett eget internt registreringsnummer i **LF**-serien, utöver leverantörens eget fakturanummer. Samma fakturanummer kan återanvändas för olika leverantörer, men inte två gånger för samma leverantör.

### Skapa en faktura

**+ Ny leverantörsfaktura**. I huvudet anges **Leverantör**, **Leverantörens fakturanummer**, **Fakturadatum**, **Förfallodatum**, **Nettobelopp**, **Momskod**, **Momssats**, **Momsbelopp**, **Bruttobelopp** och **Notering**. Beloppen i huvudet matas in från pappersfakturan och är det som gäller — så att frakt och öresavrundning alltid stämmer.

**Momsen förifylls.** **Momskod** förifylls från leverantören: leverantörens egen **Momskod (förval)**, annars koden som härleds ur dess land, se [Land och momskod](#land-och-momskod); väljer du en annan leverantör byts koden. Koden styr **Momssats**: en svensk momskod med moms ger sin egen sats (**Moms 25 %** ger 25 %), medan omvänd moms, **Momsfri** och **Inköp varor utanför EU (importmoms separat)** — där leverantören inte debiterar någon moms — ger **0 %**, och då är **Momssats** låst (avstängd, med texten *Låst till 0 % — momskoden tar ingen debiterad moms.*) så att fakturan inte kan sparas med en moms som **Godkänn** sedan avvisar. När du fyller i **Nettobelopp** räknas **Momsbelopp** ut som nettobeloppet × **Momssats**, och **Bruttobelopp** som netto + moms; med en kod som inte tar någon moms blir **Momsbelopp** alltså 0. Skriver du själv i **Momsbelopp** eller **Bruttobelopp** rörs fältet inte längre — välj en annan **Momskod** (eller, för en svensk momskod, **Momssats**) så räknas momsen om igen. Skriver du ändå ett momsbelopp på en kod som inte tar någon visar dialogen *Momsbelopp ska vara 0 med den här momskoden — fakturan kan annars inte godkännas. Välj en svensk momskod om leverantören har debiterat moms.* Kontrollera alltid beloppen mot pappersfakturan.

Visas en gul varning under **Momskod** eller **Leverantör** är den bara en upplysning, aldrig ett hinder: *Leverantören har annan valuta än SEK men land Sverige — kontrollera landet på leverantörskortet.* betyder att leverantören troligen har fel **Land** (landet styr den förvalda momskoden, så en utländsk leverantör som står som **SE** får svensk moms i stället för omvänd moms).

### Leverantörsfaktura i utländsk valuta

Fakturan registreras i **leverantörens valuta** — står leverantören som EUR anger du beloppen i EUR, och fälten heter då **Nettobelopp (EUR)**, **Momsbelopp (EUR)** och **Bruttobelopp (EUR)**. Texten *Leverantören fakturerar i EUR — ange beloppen i EUR. Kursen räknar om dem till SEK, och fakturan bokförs i SEK när den godkänns.* påminner om det. För en faktura i SEK ändras ingenting.

**Kurs.** Under **Fakturadatum** visas fältet **Kurs (SEK per 1 EUR)**. Det förifylls med kursen för fakturadatumet — Riksbankens dagskurs (senaste bankdag före eller på datumet), eller en egen kurs från [Ekonomi → Valutakurser](/hjalp/ekonomi#valutakurser) — och under fältet står varifrån kursen kommer: *Riksbanken 2026-10-23. Källa: Sveriges Riksbank.*, *egen kurs i Valutakurser 2026-10-23*, *manuell* (du har skrivit kursen själv) eller *inköpsorderns kurs*. Ändrar du **Fakturadatum** hämtas kursen på nytt — men inte över en kurs du själv har skrivit i fältet — och väljer du en leverantör med annan valuta börjar fältet om för den valutan. Skriver du i fältet gäller din kurs; **Använd kursen för fakturadatumet** (visas då) tar tillbaka den uppslagna. Hittas ingen kurs visas *Ingen kurs för EUR 2026-10-24 — ange kursen själv* och du skriver den från fakturan eller bankens kurslista; är fakturan kopplad till en inköpsorder i samma valuta används i sista hand inköpsorderns växelkurs. Utan kurs vid **Skapa faktura** avvisas fakturan med samma text.

**Momslagens regel.** Mervärdesskattelagen (8 kap. 21 §) kräver att beloppet räknas om till kronor med den senaste kurs som Riksbanken eller ECB har publicerat när den beskattningsgrundande händelsen inträffar — oftast leveransen, inte alltid fakturadatumet. Kursen för fakturadatumet är förvalet; skiljer sig leveransdagen ändrar du **Kurs** (i utkast, se nedan). Kursen gäller både momsen och kostnaden.

Under beloppsfälten visas **I SEK vid godkännande: netto … kr · moms … kr · brutto … kr** — vad fakturan bokförs som, se [Bokföring av leverantörsfakturan](#bokforing-av-leverantorsfakturan). Rader som hämtas från en inköpsorder kommer med orderns à-priser — kontrollera att de är i fakturans valuta; beloppen i huvudet är det som gäller.

**Betalas till en annan leverantör.** Ibland kommer fakturan från någon annan än leverantören du beställde av, t.ex. ett factoringbolag eller ett moderbolag. Välj då leverantören du beställde av under **Leverantör** (så att dess inköpsorder går att hämta), kryssa i **Betalas till en annan leverantör** och välj leverantören fakturan ska betalas till under **Betalas till**. Fakturan registreras på den leverantören — det är den som syns i reskontran och får betalningen — medan raderna förblir matchade mot inköpsordern. På fakturakortet kan leverantören ändras under **Leverantör (betalas till)** så länge fakturan är ett **Utkast**; valutan följer då med från den nya leverantören, och bytet loggas i **Historik** som **Leverantör ändrad**.

Rader kan läggas till med **Beskrivning**, **Artikel** (valfri — frakt- och avgiftsrader saknar artikel), **Antal**, **À-pris** och **Momskod** — tom betyder **Följer fakturan (…)** med fakturans kod i parentes, annars en egen momskod för just den raden (t.ex. frakt med svensk moms på en faktura i övrigt med omvänd moms). Det är huvudets **Momsbelopp** som bokförs; radens momskod styr vilket kostnadskonto och vilken omvänd moms raden får. Radens belopp räknas ut automatiskt (Antal × À-pris). Rader kan också läggas till i efterhand på fakturakortet så länge fakturan är i **Utkast**.

**Hämta underlag från inköpsorder.** När leverantören är vald visas **Hämta underlag från inköpsorder** med en lista över leverantörens inlevererade order (status Delvis mottagen, Mottagen eller Stängd). Välj en order, välj **Mottaget antal** (bara inlevererade rader, med mottaget antal) eller **Beställt antal** (alla rader, med beställt antal) och klicka **Hämta orderrader**. Raderna fylls i som en förhandsgranskning där enskilda rader kan tas bort innan du sparar, à-priset tas från orderraden, och varje rad blir automatiskt IO-matchad (se nedan). Är **Nettobelopp** tomt fylls det i från radsumman, och momsen och bruttobeloppet räknas ut därifrån som ovan. Raderna följer fakturans **Momskod**. Har leverantören inga inlevererade order visas i stället en upplysning, och du kan mata in raderna för hand som vanligt.

### Momskod och omvänd moms

Fakturans **Momskod** gäller alla rader utan egen momskod och det som blir över av **Nettobelopp** efter raderna (frakt och avgifter som bara står i huvudet). På fakturakortet ändras den i huvudet så länge fakturan är ett **Utkast**; i kolumnen **Momskod** i radlistan står radens egen kod, eller **Följer fakturan**. Efter **Godkänn** visar kortet bara koden. Bara aktiva momskoder för inköp kan väljas — svensk moms och momsfritt, inköp från EU, inköp utanför EU och omvänd betalningsskyldighet i Sverige; importmomskoderna används bara för [importmomsen](/hjalp/ekonomi#importmoms).

| Momskod | När |
|---|---|
| **Moms 25 %**, **12 %**, **6 %** | Leverantören har debiterat svensk moms — huvudets **Momsbelopp** är den moms som bokförs |
| **Momsfri** | Ingen moms |
| **Inköp varor från EU 25 %** (och 12 / 6 %), **Inköp tjänster från EU 25 %** | Köp från ett annat EU-land — leverantören debiterar ingen moms, du redovisar den själv |
| **Inköp tjänster utanför EU 25 %** | Tjänster från ett land utanför EU |
| **Inköp varor i Sverige, omvänd betalningsskyldighet**, **Inköp tjänster i Sverige, omvänd betalningsskyldighet** | Svenska leverantörer som inte debiterar moms (t.ex. byggtjänster, skrot) |
| **Inköp varor utanför EU (importmoms separat)** | Varor från ett land utanför EU — ingen moms på fakturan; importmomsen bokförs på tullbeslutet, se [Importmoms](/hjalp/ekonomi#importmoms) |

Under **Momskod** står en förklaring när koden inte tar någon debiterad moms. För **Inköp varor från EU 25 %** och de andra omvända koderna: *Leverantören debiterar ingen moms med den här momskoden — Nav beräknar momsen när fakturan godkänns och bokför den som både utgående och ingående moms.* För **Momsfri**: *Momsfritt — leverantören debiterar ingen moms på fakturan.* För **Inköp varor utanför EU (importmoms separat)** finns ingen omvänd moms — varan importeras och momsen bokförs separat — och förklaringen är i stället *Varor från ett land utanför EU: leverantören debiterar ingen svensk moms. Importmomsen redovisas separat när tullbeslutet kommer — se Bokför importmoms i Momsrapporten.* Importmomsen bokförs alltså aldrig på leverantörsfakturan utan med **Bokför importmoms** när tullbeslutet kommer, se [Importmoms](/hjalp/ekonomi#importmoms).

**Beräknad moms (omvänd).** Med en omvänd momskod är **Momsbelopp** 0 — leverantören har inte debiterat någon moms. Nav beräknar i stället momsen på underlaget och visar den i avsnittet **Beräknad moms (omvänd)** på fakturakortet, med **Momskod**, **Underlag** och **Moms** per kod och en **Summa**. Det är samma beräkning som bokförs när fakturan godkänns: momsen krediteras som utgående moms och debiteras som ingående moms (t.ex. 2614 → ruta 30 och 2645 → ruta 48), så ingen moms läggs på skulden — **Bruttobelopp** är det som ska betalas. Avsnittet visas bara när fakturan har omvända rader — alltså aldrig för **Inköp varor utanför EU (importmoms separat)**. På en faktura i utländsk valuta är **Underlag** och **Moms** i SEK: fakturans netto omräknat med kursen, eftersom momsen beräknas på beloppet i kronor.

**Varningar på kortet.** Överst på fakturakortet (utom på en makulerad faktura) visas fakturans varningar i gult. De hindrar aldrig något — **Godkänn** bokför det fakturan säger — utan pekar ut de två typiska misstagen: *Momskoden MP25 har 25 % moms men fakturan har inget momsbelopp — kontrollera momskoden (utlandsköp ska ha en omvänd kod)* (en svensk momskod med moms täcker en del av en faktura med nettobelopp, men fakturan har inget **Momsbelopp** — oftast ett utlandsköp som borde ha en omvänd kod, eller ett bortglömt belopp) och *Leverantören har annan valuta än SEK men land Sverige — kontrollera landet* (leverantörens **Land** är troligen fel).

Har fakturan ett **Momsbelopp** men en momskod som inte tar någon debiterad moms (omvänd moms, momsfritt eller import) varnar kortet — *Fakturan har momsbelopp, men momskoden … tar ingen debiterad moms (omvänd moms, momsfritt eller import). Välj en svensk momskod eller ange momsbelopp 0.* — och **Godkänn** avvisas (**"Fakturan har moms, men momskoden tar ingen debiterad moms (omvänd moms, momsfritt eller import) — välj en svensk momskod eller ange momsbelopp 0."**). Välj en svensk momskod eller sätt **Momsbelopp** till 0.

**Valuta på fakturakortet.** Raden överst visar **Kurs: 11,131 · Riksbanken 2026-10-23. Källa: Sveriges Riksbank** och, för en godkänd faktura, **Öppet belopp** i fakturans valuta med det bokförda värdet i kronor — *Öppet belopp: 1 000,00 EUR (11 131,00 kr bokfört)*. Rubrikerna i radlistan får valutan (**À-pris (EUR)**, **Belopp (EUR)**). Efter **Godkänn** visar kortet **Nettobelopp i SEK**, **Momsbelopp i SEK** och **Bruttobelopp i SEK** — leverantörsskulden som bokfördes — under beloppen i fakturans valuta. I utkast har huvudet fältet **Kurs (SEK per 1 EUR)** och, under beloppen, raden **I SEK vid godkännande**; båda visar det som sparas. Fältet visar den sparade kursen med källan under. Ändrar du **Fakturadatum** slår Nav upp kursen för det nya datumet — fältet visar den direkt och **Spara faktura** sparar den — utom när den sparade kursen är en som du själv har skrivit: den ligger kvar. Skriver du en kurs i fältet gäller den (källa *manuell*) och sparas som den är; **Använd kursen för fakturadatumet** (visas när kursen är skriven eller sparad av dig) tar tillbaka den automatiska kursen — fältet visar då kursen för fakturadatumet och **Spara faktura** sparar den. Byter du **Leverantör (betalas till)** till en med samma valuta behålls kursen, och en kurs du skrivit i samma sparning följer med. Byter du till en leverantör med annan valuta ersätts fältet **Kurs** av en notis — fakturan får den nya valutan när du sparar och kursen hämtas för fakturadatumet — och en kurs du skrivit gäller bara den gamla valutan och sparas inte; kontrollera beloppen, som då gäller den nya valutan. Ett utkast som sparades i utländsk valuta innan kurser fanns saknar bekräftad kurs: kortet varnar *Fakturan är i EUR men kursen är inte bekräftad (ett äldre utkast utan kurs), och fakturan kan inte godkännas före dess. Kursen för fakturadatumet visas i Kurs nedan — Spara faktura bekräftar den, eller skriv in en egen kurs.* Fältet **Kurs** visar då kursen för fakturadatumet (hittas ingen visas *Ingen kurs för EUR …* och du skriver kursen själv), och **Godkänn** avvisas tills kursen är sparad.

### Underlag — leverantörens faktura

Leverantörens egen faktura sparas som **underlag** på leverantörsfakturan, så att verifikationen och dess underlag finns på samma ställe. I **+ Ny leverantörsfaktura** finns fältet **Underlag — leverantörens faktura (PDF/bild)**: välj en eller flera filer (PDF, JPEG eller PNG, max 20 MB per fil) så laddas de upp när fakturan skapas. På fakturakortet finns avsnittet **Underlag** med filerna — klicka på filnamnet för att öppna fakturan — och ett filval för att ladda upp fler, t.ex. en sida som kom senare.

Underlaget är **räkenskapsinformation** och ska enligt bokföringslagen sparas i sju år. Därför gäller:

- Så länge fakturan är **Utkast** kan en fil tas bort med **Ta bort** (om fel fil valdes).
- Efter **Godkänn** — och på en avbruten faktura — kan underlag bara **läggas till**, aldrig tas bort.
- Varje uppladdning och borttagning loggas i fakturans **Historik** (**Underlag uppladdat**/**Underlag borttaget**), och för varje fil sparas en kontrollsumma (SHA-256, visas när du håller muspekaren över filnamnet) som visar att filen är oförändrad sedan uppladdningen.

Underlagen lagras i databasen och följer därmed med i varje säkerhetskopia (se [Säkerhetskopiering](/hjalp/system#sakerhetskopiering)).

### IO-matchning

En fakturarad kan kopplas till en rad på en inköpsorder. Artikeln måste vara densamma, annars nekas kopplingen. Leverantören behöver inte vara densamma — fakturan kan betalas till en annan leverantör än den du beställde av (se ovan). På fakturakortet erbjuds rader från fakturaleverantörens inköpsorder och från fakturans egen inköpsorder. Systemet visar då pris- och antalsavvikelse mot ordern/mottaget. Matchningen påverkar inte lagersaldot — lagret bokfördes redan vid inleveransen.

### Betalningsreferens

**Betalningsreferens** är antingen **OCR** (från leverantörens inbetalningskort, kontrolleras med kontrollsiffra) eller **Meddelande**. Referensen kan ändras i utkast och på godkända fakturor, men inte medan fakturan ingår i en betalfil (*Ingår i betalfil BO-7*). Utan referens skickas "Faktura {fakturanummer}". Till ett bankkonto får meddelandet vara högst 12 tecken, så där skickas bara fakturanumret.

### Statusflöde

Statusflödet är **Utkast → Godkänd → Betald**:

- **Godkänn** flyttar Utkast → Godkänd. Samtidigt **bokförs** fakturan automatiskt, se [Bokföring av leverantörsfakturan](#bokforing-av-leverantorsfakturan) nedan.
- **Betald** sätts automatiskt — det finns ingen knapp för det. Så snart en registrerad betalning stänger fakturans öppna post helt (se [Leverantörsreskontra](#leverantorsreskontra) nedan) blir statusen Betald av sig själv, och en makulerad betalning som gjorde detta öppnar fakturan igen till **Godkänd**.
- **Avbryt** går från Utkast eller Godkänd → Avbruten. Avbryts en **Godkänd** faktura bokförs samtidigt en **omföring** av attestens verifikat. En **Godkänd** faktura med registrerade betalningar kan inte avbrytas — makulera betalningarna först.

Avbruten är ett slutläge. Betald kan gå tillbaka till Godkänd (se ovan), men aldrig längre än så — det finns ingen väg tillbaka till Utkast. Huvud och rader kan bara ändras i läget **Utkast**.

| Status | Betydelse |
|---|---|
| Utkast | Registrerad; huvud och rader redigerbara |
| Godkänd | Godkänd för betalning (låst för redigering, bokförd) |
| Betald | Öppet belopp 0 — kan öppnas igen till Godkänd om betalningen makuleras |
| Avbruten | Avbruten, bara möjligt från Utkast eller Godkänd utan registrerade betalningar (slutläge) |

De fakturor som rör en viss artikel syns även i sektionen **Leverantörsfakturor** på artikelkortets Inköp-flik (se [Artiklar](/hjalp/artiklar)).

Sektionen **Historik** längst ner på fakturakortet visar fakturans egna händelser — se [Händelselogg](/hjalp/system#handelselogg).

### Kostnadsställe och projekt på fakturan

Finns det kostnadsställen eller projekt (se [Kostnadsställen och projekt](/hjalp/ekonomi#kostnadsstallen-och-projekt)) har fakturahuvudet fälten **Kostnadsställe** och **Projekt**, som gäller alla rader utan egna. Varje rad kan få egna i **Lägg till rad**. Listan **Kostnadsställe** har, när raden har en artikel, valen **Varugruppens förval** (kostnadsstället som varugruppen är inställd på, om något) och **Följer fakturan** (raden får inget eget kostnadsställe utan tar fakturans); utan artikel finns bara **Följer fakturan**. Listan **Projekt** har **Följer fakturan**, som lämnar projektet till huvudet, och kolumnen **Kostnadsställe / projekt** visar vad raden har. Förval är leverantörens **Kostnadsställe (förval)** (leverantörskortet, fliken **Villkor & frakt**), annars varugruppens, och inköpsorderns **Projekt** när underlaget hämtas från en inköpsorder. Objekten bokförs på kostnadsraden när fakturan godkänns; restraden tar alltid fakturans objekt.

### Bokföring av leverantörsfakturan

**Godkänn** bokför fakturan automatiskt — du behöver aldrig knappa in något verifikat för hand. Verifikatet hamnar i serien **L** (Leverantörsfakturor) och får beskrivningen **Leverantörsfaktura LF-… (leverantörens fakturanummer) — leverantörens namn**. Attesten och verifikatet sker i ett och samma steg: antingen blir båda av, eller ingetdera.

**Fakturadatum styr bokföringsperioden.** Verifikatet dateras med fakturans **Fakturadatum**, inte med dagens datum — det är alltså fakturadatumets period som måste vara öppen. Är perioden låst: ändra **Fakturadatum** på utkastet (huvudet är redigerbart i **Utkast**) eller lås upp perioden under **Ekonomi → Räkenskapsår**.

Konteringen utgår från **huvudets** belopp, som du matat in från pappersfakturan:

- **Leverantörsskuld** krediteras med **Bruttobelopp** (standardkonto **2440 Leverantörsskulder**).
- **Ingående moms** debiteras med **Momsbelopp** på momskodens konto för ingående moms (**2640 Ingående moms** för svensk moms, se [Momskoder](/hjalp/ekonomi#momskoder)).
- **Kostnaden** debiteras rad för rad. För svensk moms, momsfritt och *Inköp varor utanför EU* gäller: har radens artikel en varugrupp med en konteringsregel styr regeln kostnadskontot; annars används standardkontot **4010 Inköp material och varor**. Rader utan artikel (frakt, avgifter) hamnar alltid på standardkontot.
- **Omvänd moms.** För en omvänd momskod (t.ex. **Inköp varor från EU 25 %**) styr bara en konteringsregel för varugruppen och exakt den momskoden kostnadskontot; annars används momskodens eget kostnadskonto (4515 för EU-varor, 4535 för EU-tjänster, 4531 för tjänster utanför EU, 4415/4425 för omvänd betalningsskyldighet i Sverige) — aldrig "Alla momskoder"-regeln eller standardkontot, så att underlaget alltid hamnar i rätt ruta. Den beräknade momsen krediteras som utgående moms och debiteras som ingående moms (se [Momskod och omvänd moms](#momskod-och-omvand-moms)), och kostnaden är nettobeloppet — ingen moms ligger på leverantörsskulden.
- **Skillnaden mellan Nettobelopp och radernas summa** — frakt och öresavrundning som inte ligger på egna rader — bokförs som en sista kostnadsrad på fakturans momskod (för svensk moms på standardkontot). Har fakturan inga rader alls hamnar hela nettobeloppet där.

**Faktura i utländsk valuta.** Allt i verifikatet är i SEK. Leverantörsskulden är exakt **Bruttobelopp** × kursen avrundat till ören (*Bruttobelopp i SEK* på kortet), momsen bokförs som **Momsbelopp** × kursen, varje rad som radbeloppet × kursen, och det som raderna inte förklarar — frakt och öresavrundning — tas av den sista kostnadsraden, så att verifikatet alltid går ihop. Omvänd moms beräknas på kronbeloppet (fakturans netto i SEK). Verifikatets beskrivning får valuta, belopp och kurs: **Leverantörsfaktura LF-… (leverantörens fakturanummer) — leverantörens namn, EUR 1 234,00 à 11,131000**. Leverantörsreskontran (öppet belopp, förfallolistan, betalningar) fortsätter att räknas i fakturans valuta; det bokförda värdet i kronor visas bredvid.

På fakturakortet visas **Verifikat L-…** med en länk till verifikatet (t.ex. **L-2026-12**: serie, räkenskapsår och löpnummer). Numret är en länk för den som har behörighet till [Ekonomi](/hjalp/ekonomi) (administratörer och användare vars behörighetsgrupp ger Ekonomi, se [Behörighetsgrupper](/hjalp/system#behorighetsgrupper)); för andra visas det som text. Det är attesten som ger fakturan sitt L-verifikat — betalningen bokförs separat, i sin egen serie **U**, när den registreras i [Leverantörsreskontra](#leverantorsreskontra) nedan.

**Avbryt** på en **Godkänd** faktura bokför en **omföring** av attestens verifikat — samma konton och belopp, men debet och kredit ombytta, daterad i dag och med beskrivningen **Makulering LF-… (leverantörens fakturanummer) — leverantörens namn**. Verifikat raderas aldrig, de rättas. Har verifikatet redan förts om för hand under **Ekonomi → Verifikat** (**Omför**) och den omföringen är **bokförd** sker ingen ny omföring — makuleringen går igenom ändå. Ligger den manuella omföringen kvar som **Utkast** stoppas däremot makuleringen: ett utkast är ingen rättelse i bokföringen (det går fortfarande att ta bort), så fakturan förblir **Godkänd** tills utkastet bokförs eller tas bort. Fakturor som godkändes innan automatkonteringen fanns saknar verifikat och makuleras rakt av.

**Om bokföringen inte går att genomföra stoppas åtgärden.** Fakturan behåller då sin status (**Utkast** vid Godkänn, **Godkänd** vid Avbryt) och inget nummer bränns i verifikatserien — nästa verifikat fortsätter obrutet. Det händer i dessa fall:

- **Bokföringsperioden är låst** — för fakturadatumet vid Godkänn, för dagens datum vid Avbryt. Lås upp perioden under **Ekonomi → Räkenskapsår** (**Lås upp period**, motivering krävs) och försök igen.
- **Inget räkenskapsår täcker datumet.** Lägg upp räkenskapsåret under **Ekonomi → Räkenskapsår** först — perioderna skapas automatiskt.
- **Ett konto som konteringen behöver saknas eller är inaktivt** i kontoplanen. Lägg upp eller aktivera kontot under **Ekonomi → Kontoplan** (**Förifyll BAS-urval** lägger in hela standardurvalet på en gång).
- **Huvudets belopp går inte ihop.** **Nettobelopp** + **Momsbelopp** måste vara exakt **Bruttobelopp**.
- **Fakturan har moms men momskoden tar ingen debiterad moms** — omvänd moms, momsfritt eller import. Välj en svensk momskod eller sätt **Momsbelopp** till 0.
- **Fakturan är i utländsk valuta men saknar kurs.** Gäller bara ett äldre utkast som sparades innan kurser fanns: **Godkänn** avvisas med *Fakturan är i utländsk valuta men saknar kurs — ange kursen innan fakturan godkänns.* Fältet **Kurs** i huvudet visar kursen för fakturadatumet: bekräfta den med **Spara faktura** (eller skriv en egen kurs först) och godkänn igen.
- **Fakturans bruttobelopp är noll.** Det finns ingenting att bokföra.

## Fakturainkorg

**Inköp → Fakturainkorg** tar emot leverantörsfakturor som PDF, foto eller e-post och tolkar dem till ett **förslag**. Du granskar förslaget bredvid originalet och trycker **Skapa leverantörsfaktura** — då skapas en leverantörsfaktura som **utkast**, med filen som underlag. Fakturan attesteras och bokförs sedan som vanligt (se [Leverantörsfakturor](#leverantorsfakturor)): **inget sker automatiskt**, varken attest eller bokföring.

Sidan och inställningarna kräver menyn **Inköp**; inställningarna under **System → Fakturaskanning** är bara för administratörer, se [Fakturaskanning](/hjalp/system#fakturaskanning).

### Ladda upp och fota

Överst på sidan finns uppladdningsytan. **Dra och släpp** en eller flera filer på den, eller klicka **Ladda upp filer**. Filerna ska vara PDF, JPEG eller PNG, högst 20 MB per fil och högst 20 filer åt gången. På en mobil visas också **Fota faktura**, som öppnar kameran — fota fakturan rakt uppifrån med hela sidan i bild.

Under uppladdningsytan visas resultatet: vilka filer som lästes in (med länk till posten, t.ex. **FI-12**), vilka som redan fanns i inkorgen (*finns redan i inkorgen som FI-7 (Tolkad)*) och vilka som inte kunde läsas in, med orsak (t.ex. *Filtypen stöds inte — ladda upp PDF, JPEG eller PNG*). En dubblett eller en felaktig fil stoppar inte de övriga filerna. Samma fil kan inte ligga i inkorgen två gånger; en avvisad fil räknas inte som dubblett.

Varje fil får ett eget **FI**-nummer.

### E-postlådan

Nav kan också läsa en e-postlåda och lägga fakturorna i brevens bilagor i inkorgen, se [Fakturaskanning](/hjalp/system#fakturaskanning). Posterna har då **E-post** som **Källa**, med avsändaren efter. Bilagor av typen PDF läses in; JPEG och PNG läses bara in när brevet saknar PDF, och små bilder (t.ex. signaturlogotyper) hoppas över. Andra filtyper, som XML, läses inte in, och högst 10 bilagor per brev läses in. Brevet flyttas till mappen för inlästa.

### Listan

Flikarna ovanför listan väljer vad som visas:

- **Att granska** — fakturor som är **Ny**, **Tolkad** eller **Osäker** (förval).
- **Skapade** — fakturor som blivit leverantörsfakturor.
- **Avvisade** — fakturor som avvisats.
- **Alla**.

Kolumnerna är **Nr**, **Inkommen**, **Källa** (**Uppladdad** eller **E-post** med avsändare), **Fil**, **Leverantör** (den tolkade), **Fakturanr**, **Att betala** och **Status**. För en **Skapad** faktura visar **Leverantör**, **Fakturanr** och **Att betala** den skapade leverantörsfakturans värden, så som de sparades. Sökfältet söker på filnamn, FI-nummer, avsändare, ämne, leverantör och fakturanummer, och filtret **Alla källor** väljer uppladdade eller e-postade fakturor.

Statusen är:

- **Ny** — filen är inläst men har ännu inte tolkats.
- **Tolkad** — ett förslag finns och alla viktiga fält är säkra.
- **Osäker** — ett förslag finns, men leverantören, fakturanumret, fakturadatumet, förfallodatumet eller beloppet är inte säkert. Kontrollera dem mot originalet.
- **Skapad** — leverantörsfakturan är skapad; registreringsnumret (t.ex. **LF-31**) är en länk till den.
- **Avvisad** — fakturan är avvisad.

Aviseringen **Fakturor i inkorgen att granska** på [Aviseringar](/hjalp/aviseringar) och på Översikten räknar fakturorna under **Att granska**.

### Granska en faktura

Klicka på en post i listan. På en bred skärm ligger **Originalet** till vänster och förslaget till höger; på en mobil ligger originalet överst och kan fällas ihop med **Dölj originalet** (och fram igen med **Visa originalet**). En PDF visas i sidan, en bild kan **Förstoras** och **Förminskas**, och **Öppna i ny flik** visar filen i fullstorlek.

Förslaget har samma fält som **+ Ny leverantörsfaktura**: **Leverantör**, **Leverantörens fakturanummer**, **Fakturadatum**, **Förfallodatum**, **Betalningsreferens** (**OCR** eller **Meddelande**), **Inköpsorder**, **Momskod**, **Nettobelopp**, **Momssats**, **Momsbelopp**, **Bruttobelopp**, **Kostnadsställe** och **Projekt** (när sådana finns), **Notering** och **Rader**. Momskoden väljs som på en vanlig leverantörsfaktura, se [Momskod och omvänd moms](#momskod-och-omvand-moms); en leverantör i utländsk valuta får samma **Kurs** som där, se [Leverantörsfaktura i utländsk valuta](#leverantorsfaktura-i-utlandsk-valuta).

**Det du skriver gäller.** Ett fält du har ändrat skrivs aldrig över när du trycker **Tolka igen** eller **Tolka med AI** — den nya tolkningen fyller bara i de fält du inte rört. Skriver du i **Nettobelopp** räknas **Momsbelopp** och **Bruttobelopp** om, tills du skrivit i dem själv.

Ovanför formuläret kan en gul ruta visa:

- kontrollerna som tolkningen gjorde, t.ex. att netto + moms inte stämmer med beloppet att betala;
- *Leverantören har redan en faktura med det här fakturanumret* med länk till den, om det är en dubblett;
- **Osäker** — något viktigt fält är inte säkert tolkat;
- om AI-tolkningen misslyckades, med orsaken.

#### Osäker, AI och Inlärt

Under ett fält kan det stå var värdet kommer ifrån eller att det inte är säkert:

- **Osäker — kontrollera mot originalet** — värdet hittades men tolkningen är inte säker på det.
- **Hittades inte — fyll i för hand** — fältet gick inte att läsa ut.
- **AI** — värdet kommer från AI-tolkningen.
- **Inlärt** — värdet hittades med en etikett som Nav lärt sig av en tidigare faktura från samma leverantör. Varje gång du skapar en leverantörsfaktura från inkorgen lär sig Nav var den leverantörens fakturanummer, datum och belopp står, så nästa faktura tolkas säkrare.
- **Från inköpsorder** — värdet eller raden kommer från inköpsordern.

Meddelandena försvinner under ett fält när du själv skrivit i det.

**Reglerna och AI.** Tolkningen använder alltid reglerna först: de läser PDF:ens textlager helt lokalt. Foton och inskannade PDF utan textlager kan inte tolkas av reglerna — då visas bilden bredvid ett tomt förslag som du fyller i för hand, eller med **Tolka med AI** om den är inställd (se [Fakturaskanning](/hjalp/system#fakturaskanning)). **Tolka igen** kör reglerna på nytt; knappen visas bara för PDF:er med textlager, eftersom reglerna inte kan läsa en bild eller en inskannad PDF. Ett förslag från AI skrivs aldrig över av reglerna. **Tolka med AI** visas bara när AI-tolkning är inställd; knapparna visar **Tolkar…** medan tolkningen pågår — AI-tolkning kan ta upp till en minut, och under tiden kan du inte skapa eller avvisa fakturan.

#### Vad som skickas till AI-tjänsten

Utan en API-nyckel lämnar ingen fil Nav. Med företagets egen API-nyckel skickas **bara fakturafilen och företagets namn och organisationsnummer** till AI-tjänsten (Anthropic), och bara när AI-tolkning körs — automatiskt i läget **Automatiskt när reglerna inte räcker** (för e-post bara när avsändaren är en känd leverantör eller användare och e-postservern har verifierat avsändarens domän, så att reklam och förfalskade avsändare inte kostar pengar; högst 100 per dag), annars när du trycker **Tolka med AI**. Leverantörsregistret och inköpsordrarna skickas aldrig; leverantören och inköpsordern matchas i Nav på svaret. AI:ns svar är bara ett förslag som du granskar.

#### Leverantör som saknas

Matchar ingen leverantör fakturan visas *Ingen leverantör matchade fakturan.* och knappen **Skapa leverantör**. Den öppnar **Ny leverantör** förifylld med namn, organisationsnummer, VAT-nummer, adress och betalningsuppgifter (bankgiro, plusgiro eller IBAN) från fakturan. När du tryckt **Skapa leverantör** där kommer du tillbaka till fakturan, med den nya leverantören vald. Passar flera leverantörer visas *Flera leverantörer passar fakturan — välj rätt i listan ovan.*

#### Rader och inköpsorder

Har AI läst raderna visas de under **Rader**, annars är listan tom. Varje rad har **Beskrivning**, **Antal**, **À-pris** och **Belopp**, kan tas bort med **Ta bort** och nya rader läggs till med **+ Rad**. En rad som tolkningen inte är säker på märks **Osäker**.

Med inställningen **Matcha mot inköpsorder** föreslår Nav vilken inlevererad inköpsorder fakturan hör till (fältet **Inköpsorder**, märkt **Från inköpsorder**). Har fakturan inga rader från AI byggs raderna av inköpsordern, som med **Hämta orderrader** i **+ Ny leverantörsfaktura** — mottaget antal och inköpsorderns à-pris, märkta **Från inköpsorder**. **Hämta orderrader** med **Mottaget antal** eller **Beställt antal** ersätter raderna med ordern. Raderna kopplas till orderraderna så att pris- och antalsavvikelser visas på leverantörsfakturan, se [IO-matchning](#io-matchning). Står bara ett nummer utan inköpsorderns prefix på fakturan (t.ex. *Ordernummer 1005*) märks förslaget **Osäker** — det kan vara leverantörens eget ordernummer. Byter du **Leverantör** töms **Inköpsorder**, raderna från ordern tas bort och övriga rader förlorar sin koppling till orderraderna.

#### Skapa leverantörsfaktura

**Skapa leverantörsfaktura** skapar leverantörsfakturan som utkast och öppnar den. Filen följer med som **Underlag** och ligger kvar som räkenskapsinformation; den kan inte tas bort från utkastet. Är fakturanumret redan använt för leverantören visas felet och ingenting skapas. Inkorgsposten blir **Skapad** och kan inte ändras.

#### Avvisa, Återställ och Radera

**Avvisa…** flyttar en faktura som inte ska bokföras (reklam, en dubblett, fel mottagare) till **Avvisade**; du anger en **Orsak**. En avvisad faktura visar orsaken, vem som avvisade och när. **Återställ** lägger tillbaka den under **Att granska**. **Radera** tar bort posten och filen för alltid och frågar först; bara en avvisad faktura kan raderas, och en skapad faktura sparas som underlag på leverantörsfakturan.

## Leverantörsreskontra

Leverantörsreskontran håller reda på vilka leverantörsfakturor som fortfarande har ett öppet belopp och registrerar de betalningar (utbetalningar) som stänger dem.

### Öppna poster

**Inköp → Öppna poster** listar varje godkänd leverantörsfaktura som fortfarande har ett öppet belopp: **Faktura** (registreringsnumret i LF-serien, med leverantörens eget fakturanummer under), **Leverantör**, **Förfallodatum** (rött och märkt "förfallen" när datumet har passerat), **Belopp** och **Öppet belopp** — i fakturans valuta (en EUR-faktura visar t.ex. **1 000,00 EUR** med **kurs 11,131** under). Finns en faktura i utländsk valuta på sidan visas även kolumnen **Öppet i SEK**, det öppna beloppets bokförda värde i kronor — det är den kolumnen du summerar, aldrig valutabelopp tillsammans med kronor. Filtrera på leverantör eller kryssa i **Endast förfallna**; sökfältet matchar registreringsnummer, fakturanummer och leverantörsnamn. Klicka på fakturanumret för att öppna fakturakortet. Kolumnen **Betalfil** visar vilken betalfil fakturan ingår i, och kryssrutorna används för att [skapa en betalfil](#skapa-betalfil).

Förfallodatumet räknas fram ur leverantörens betalningsvillkor när fältet lämnas tomt när fakturan registreras (se [Skapa en faktura](#skapa-en-faktura) ovan) — anges det för hand vinner det alltid, och ändras aldrig i efterhand av sig själv.

### Registrera betalning

**Inköp → Betalningar** listar alla registrerade betalningar (UTB-nummer, datum, leverantör, belopp i betalningens valuta, konto, verifikat och status; finns en betalning i utländsk valuta på sidan visas även **Draget i SEK**). Knappen **+ Registrera betalning** öppnar registreringsformuläret:

1. Välj **Leverantör** — leverantörens öppna poster hämtas in i en tabell nedanför. Till skillnad från kundreskontran finns ingen OCR-sökning här: leverantörsfakturor matchas alltid manuellt mot posterna.
2. Kryssa i de fakturor betalningen gäller. Varje ikryssad rad visar leverantörens **Fakturanr**, **Öppet belopp** och ett redigerbart **Belopp**, förifyllt med öppet belopp. En betalning kan inte blanda valutor: har du kryssat i en EUR-faktura är fakturor i andra valutor avstängda (*En betalning kan inte blanda valutor — välj bara fakturor i EUR*). Fältet till höger om beloppet visar direkt vad som händer:
   - **Stänger posten** — beloppet matchar öppet belopp exakt.
   - **Stänger posten · avskrivning X,XX kr** — beloppet ligger inom toleransen (se nedan) men matchar inte exakt; mellanskillnaden bokförs som öres-/kronutjämning och posten stängs ändå.
   - **Delbetalning · rest X,XX kr** — beloppet ligger utanför toleransen; posten förblir öppen med resten kvar.
   - **Beloppet överstiger öppet belopp** — beloppet är för högt även med toleransen inräknad; posten kan inte stängas med det beloppet.

   En leverantörs kreditfaktura har ett negativt öppet belopp — beloppet på dess rad anges också negativt.
3. Hur mycket en betalning får missa öppet belopp med och ändå räknas som fullt betald ställs in under **Ekonomi → Konteringsregler** som **Betalningstolerans (kr)** — samma inställning som styr kundreskontrans betalningar. På en faktura i utländsk valuta räknas toleransen om till fakturans valuta med fakturans kurs, och texten vid raden anger valutan (**Stänger posten · avskrivning 0,44 EUR**).
4. Fyll i **Betalkonto** (förvalt till kontot under Ekonomi → Konteringsregler → **Bank/betalkonto**, samma standardvärde som kundreskontran), **Betalningsdatum** (dagens datum förvalt) och en valfri **Notering**. **Summa** räknas fram automatiskt som summan av de ikryssade radernas belopp — för en SEK-betalning är det detta belopp som bokförs mot betalkontot.
5. För en faktura i utländsk valuta, fyll i **Belopp i SEK (draget från kontot)** och eventuell **Bankavgift** — se [Utbetalning i utländsk valuta](#utbetalning-i-utlandsk-valuta).
6. Klicka **Registrera betalning**.

**Kvittning av kreditfaktura:** kryssar du i poster vars belopp tar ut varandra helt inom samma betalning — till exempel en leverantörskreditfakturas negativa belopp mot en vanlig fakturas positiva, utan att någon av raderna hamnar inom toleransen och får en avskrivning — blir betalningens **Summa** 0 och inget verifikat bokförs, eftersom inga pengar har rört sig i banken. Det är en ren kvittning mellan leverantörens egna poster, och listan visar **—** i kolumnen **Verifikat** för en sådan betalning.

### Utbetalning i utländsk valuta

En faktura i EUR betalas i EUR: **Belopp** och **Summa** är i fakturans valuta, men banken drar kronor från betalkontot. Därför frågar formuläret även efter:

- **Belopp i SEK (draget från kontot)** — vad som faktiskt lämnade bankkontot, inklusive bankens avgift. Fältet förifylls med kursen för **Betalningsdatum** × beloppet (hjälptexten säger vilken kurs: *Förifyllt med kursen 11,20 för 2026-10-24 × 1 000,00 EUR. Källa: Sveriges Riksbank.* — källtexten står med när kursen är Riksbankens), men det är beloppet på kontoutdraget som ska gälla — **skriv av det därifrån**. Skriver du i fältet slutar Nav att räkna om det. Hittas ingen kurs lämnas fältet tomt med en upplysning. Utan belopp avvisas betalningen (*En betalning i EUR behöver beloppet i SEK som drogs från kontot.*).
- **Bankavgift** — bankens avgift i kronor, om du vet den. Avgiften ingår i beloppet som drogs från kontot och bokförs som **Bankkostnader** i stället för att hamna i kursdifferensen.

Under fälten visar formuläret vad betalningen leder till: **Avräknas mot skulden: 11 131,00 kr (bokfört värde).** och **Kursvinst 31,00 kr** eller **Kursförlust 12,50 kr** (eller **Ingen kursdifferens**). Det är samma uträkning som sparas.

**Bokföring.** Utbetalningen bokförs i serien **U**, allt i SEK: leverantörsskulden debiteras med det bokförda värdet av det som betalas (kronorna fakturan bokades till — en delbetalning tar sin andel och den sista betalningen resten, så en faktura betald i flera delar frigör exakt sin skuld), betalkontot krediteras med **Belopp i SEK**, **Bankavgift** debiteras på **Bankkostnader** och skillnaden bokförs som **Kursförlust** (mer kronor lämnade banken än skulden bokades till) eller **Kursvinst**. Standardkontona **Kursvinst**, **Kursförlust** och **Bankkostnader** ställs in under [Ekonomi → Konteringsregler](/hjalp/ekonomi#standardkonton). Verifikatets beskrivning får betalningens valuta och belopp: **Betalning UTB-… — leverantörens namn, EUR 1 000,00**.

Efter **Registrera betalning** visar sidan en notis med resultatet — *Betalning UTB-12 registrerades — Kursvinst 31,00 kr.* — och betalningskortet visar **Belopp**, **Draget från kontot**, **Bankavgift** och kursdifferensen, med fakturans kurs och **Avräknat i SEK** per rad. På fakturakortet har tabellen **Betalningar** kolumnen **Avräknat i SEK**. Att **Makulera** en betalning bokför en omföring av hela verifikatet, kursdifferensen och bankavgiften inräknade, och fakturan öppnas igen med sitt bokförda värde.

En kvittning (**Summa** 0) flyttar inga pengar och tar varken **Belopp i SEK** eller **Bankavgift** — har de kvittade fakturorna olika kurser blir det ändå en kursdifferens, och formuläret visar den. Fakturor i utländsk valuta kan också betalas med en betalfil (se [Utlandsbetalningar](#utlandsbetalningar)); då anger du **Belopp i SEK** och **Bankavgift** per post i **Bekräfta utförd** — eller så hämtas de ur bankens debiteringsavi — och utbetalningen bokförs på samma sätt som här.

Har fakturan betalningar visas de i en egen sektion **Betalningar** på fakturakortet, under raderna: **Datum**, **Betalning** (länk till betalningens UTB-nummer, en makulerad betalning märks **· Makulerad** efter numret), **Belopp**, **Avskrivning** och **Verifikat** (länk för den som har behörighet till Ekonomi, annars bara text — en ren kvittning visar **– (kvittning)** i stället). Så länge fakturan är **Godkänd** med ett öppet belopp skilt från 0 visar kortet knappen **Registrera betalning**, som tar dig till Betalningar med fakturan förvald.

### Makulera betalning

På betalningens detaljsida (klicka på UTB-numret i listan) finns knappen **Makulera** under **Åtgärder**, synlig så länge betalningen inte redan är makulerad. En bekräftelsedialog visas eftersom åtgärden bokför en omföring av betalningens verifikat (om den bokförde något) och öppnar de fakturor betalningen stängde igen — de får tillbaka exakt det öppna belopp de hade innan betalningen, och statusen går tillbaka till **Godkänd**. En kvittning utan eget verifikat kan makuleras precis som en betalning med bankbelopp; det finns då inget att omföra, bara fakturorna som öppnas igen. En redan makulerad betalning visar statusen **Makulerad** och kan inte makuleras igen.

## Betalfiler

En betalfil är en betalningsomgång som Nav skriver som en pain.001-fil. Filen laddas upp i internetbankens filöverföring och attesteras där. Ingenting bokförs när filen skapas, eftersom banken kan avvisa betalningar. Utbetalningarna bokförs först när banken har bekräftat dem.

Förutsättningar: **System → Bank** är ifyllt (administratör), leverantören har ett **Betalningssätt** och fakturan är **Godkänd**.

### Skapa betalfil

Under **Öppna poster** kryssar du i fakturorna och klickar **Skapa betalfil**; raden ovanför tabellen visar summan av de valda posterna per valuta (t.ex. **12 000,00 kr · 3 400,00 EUR**) — kronor och andra valutor läggs aldrig ihop. Kryssrutan är avstängd för kreditfakturor (*Kreditfakturor kvittas under Betalningar*), för leverantörer utan betalningsuppgifter och för fakturor som redan ingår i en betalfil. Fakturor i utländsk valuta och leverantörer med IBAN i andra länder eller utländskt kontonummer kan väljas — se [Utlandsbetalningar](#utlandsbetalningar). Omgången får ett nummer i serien **BO-** och en post per faktura, med beloppet som är öppet (i fakturans valuta) och betalningsdagen satt till förfallodagen (eller idag om fakturan redan har förfallit). Betalfilens sida visar **Belopp** per valuta, och tabellen **Poster** har kolumnen **Typ** — **Inrikes**, **SEPA** eller **Utland**, för en annan valuta än SEK med valutan efter punkt (**Utland · USD**). En faktura i en levande omgång är *reserverad*: den kan inte registreras manuellt under **Betalningar**, inte makuleras och inte få ny betalningsreferens förrän omgången är klar.

I utkastet kan du **Ändra** belopp (högst det öppna beloppet, för en delbetalning) och betalningsdag, **Ta bort** poster, **Lägg till fakturor** och **Makulera omgång**. Varningar som *Mottagarens namn skickas som "Svets och Montage i Exempelby AB"* visar hur banken kommer att se texten (bankernas teckenmängd saknar t.ex. `&`).

Utkastet visar också i förväg vad exporten skulle vägra: under fakturan står problemen per post i rött, och överst listas de under *Betalfilen kan inte exporteras än:*. Så länge något står där är **Exportera betalfil** avstängd. Rätta problemet på leverantörskortet, i **Företagsinformation** eller under **System → Bank** och ladda om sidan.

### Utlandsbetalningar

En betalfil kan betala utomlands, i fakturans valuta. Nav delar in varje post efter fakturans valuta och mottagarens konto:

- **Inrikes** — SEK till bankgiro, plusgiro, svenskt bankkonto eller svenskt IBAN, precis som förut.
- **SEPA** — EUR till ett IBAN i SEPA-området (EU-länderna, Island, Liechtenstein, Norge, Schweiz, Storbritannien m.fl.). Betalningen skickas som SEPA-betalning med SEPA-avgifter.
- **Utland** — allt annat: andra valutor än EUR, IBAN utanför SEPA, utländskt kontonummer och SEK till ett utländskt konto. Avgifterna följer leverantörens **Avgiftsfördelning**; kolumnen **Betalsätt** visar valet (*Delade avgifter (SHA)* eller *Vi betalar alla avgifter (OUR)*, för SEPA *SEPA-avgifter (SLEV)*) och mottagarens land och bank.

Betalningen dras alltid från företagets SEK-konto och banken växlar — Nav skickar fakturans belopp i fakturans valuta, och ingenting bokförs när filen skapas. Bankgiro, plusgiro och svenska bankkonton tar bara emot SEK: en faktura i annan valuta till en leverantör med ett sådant konto avvisas (*Bankgiro, plusgiro och svenska bankkonton tar bara emot SEK — leverantören behöver IBAN för en betalning i annan valuta*), så leverantören behöver IBAN eller utländskt kontonummer.

**Det banken kräver.** Leverantören behöver gatuadress och ort (fliken **Allmänt**), och mottagarbanken måste kunna identifieras: IBAN, och för IBAN utanför SEPA även BIC, eller ett utländskt kontonummer med BIC och/eller bank-id. Bankerna skiljer sig åt, och Nav följer varje banks regler: SEB kräver mottagarbankens BIC (*SEB kräver mottagarbankens BIC för utlandsbetalningar*), Nordea kräver bankens namn när bara bank-id anges och tar högst 105 tecken för namn, gatuadress och ort tillsammans, Swedbank tar bara bank-id av typen USA och Kanada och Handelsbanken sex av typerna (*Swedbank tar inte bank-id av typen GBDSC — ange mottagarbankens BIC*). Företaget behöver dessutom ett **IBAN** i **Företagsinformation** att betala från — alla fyra banker dras utomlands från IBAN, och Swedbank som inrikes dras från bankgiro behöver alltså ett IBAN för utlandsbetalningar (*Swedbank kräver IBAN som debiteringskonto för utlandsbetalningar — lägg in det i Företagsinformation*). Det IBAN-kontot ska vara ett svenskt konto (SE…). Saknas IBAN varnar **System → Bank** (se [Bank](/hjalp/system#bank)); inrikes betalningar påverkas inte.

**Teckenmängd.** Utlandsbetalningar skickas utan å, ä och ö: å, ä och æ blir a, ö och ø blir o, ü blir u, ß blir ss och & blir *and* i namn, adress och meddelande. Utkastet visar vad som skickas, t.ex. *Mottagarens namn skickas som "Muller and Sohne GmbH"* för *Müller & Söhne GmbH*. Inrikes betalningar behåller sin teckenmängd.

**Rapportering till Skatteverket (KU81).** Banken rapporterar betalningar till utlandet över 150 000 kr till Skatteverket, och betalningen ska då bära leverantörens **Betalningskod (Skatteverket)**. Nav räknar värdet med dagens kurs (**Ekonomi → Valutakurser**) och skriver koden i filen när värdet **överstiger** 150 000 kr. Posten markeras i kolumnen **Typ** med *Rapporteras till Skatteverket, kod 101* och motvärdet i kronor, och exportdialogen listar de rapporterade posterna. Går det inte att hitta någon kurs för valutan visas *Kursen för EUR saknades, så betalningen rapporteras för säkerhets skull* i kolumnen **Typ** och utkastet varnar med *Kurs för EUR saknas — betalningen rapporteras till Skatteverket med betalningskod 101 för säkerhets skull (ange kursen under Ekonomi → Valutakurser)* — koden skrivs då alltid, eftersom en onödig kod är ofarlig men en saknad kod ger en rättelse till Skatteverket. Det gäller även betalningar i SEK till utländska konton.

### Exportera och ladda upp

**Exportera betalfil** kontrollerar filen mot bankens regler, arkiverar den (med kontrollsumma, som räkenskapsinformation) och laddar ner den. Betalningsdagar som har passerat flyttas till idag. Ladda upp filen i internetbanken. Filen kan laddas ner igen med **Ladda ner fil**, men den skapas aldrig om. Om banken avvisar hela filen: **Makulera omgång** och skapa en ny.

Prova den första filen i bankens testverktyg (Swedbank Validex, SEB Test Bench). Gör det även för den första utlandsbetalningen — SEPA och internationella betalningar har egna regler hos varje bank.

### Bekräfta betalningar

Banken bekräftar betalningarna i en debiteringsavi (camt.054). Under **Inköp → Bankfiler** väljer du **Läs in bankfil**. Filens sida visar vilket **Konto** avin gäller och varnar om det inte är något av företagets konton under Företagsinformation (IBAN, bankgiro eller plusgiro). Poster som hör till en betalfil visas som **Matchad**, och **Bokför valda** registrerar dem som utbetalningar (serie U) på bankens bokföringsdag. Saknas avin används **Bekräfta utförd** på betalfilen: välj **Betalningsdag** och kryssa i de betalningar som banken har genomfört. Förvalda är de poster vars betalningsdag har kommit (alla väntande om ingen har det), och en varning visas om datumet ligger före betalningsdagen i filen för någon vald post. Poster du bockar ur väntar kvar på banken. Omgången är **Exporterad · 2 av 3 bekräftade** tills varje post är bekräftad, avvisad eller återförd. Då blir den **Bekräftad**.

**Utlandsbetalningar.** En post i utländsk valuta bokförs i SEK, så den behöver beloppet som banken drog från kontot. I **Bekräfta utförd** visar varje vald post i utländsk valuta fälten **Belopp i SEK (draget från kontot)** och **Bankavgift**. Beloppet förifylls med kursen för **Betalningsdag** × beloppet, men det är kontoutdragets belopp som ska gälla — skriv av det. Avgiften ingår i beloppet och bokförs som bankkostnad. Under fälten visar dialogen vad utbetalningen leder till: **Avräknas mot skulden: 11 131,00 kr (bokfört värde).** och **Kursvinst …** eller **Kursförlust …**, samma uträkning som vid [Utbetalning i utländsk valuta](#utbetalning-i-utlandsk-valuta). **Bekräfta utförd** är avstängd tills varje vald post i utländsk valuta har ett belopp i SEK; poster i SEK bokförs som förut.

Läser du in debiteringsavin (camt.054) sköts det av sig självt: en utlandsbetalning matchas på det belopp som skickades i fakturans valuta (avin anger det som ursprungligt belopp), och bokförs med postens belopp i SEK och, när banken anger dem, bankens avgifter. På filens sida visar kolumnen **Belopp** det utländska beloppet med **… kr från kontot**, **Bankens kurs** och **varav avgifter**, och under **Läge** står vad som bokförs (*Bokförs med 11 131,00 kr draget från kontot, varav bankavgift 95,00 kr.*). Nordea anger inga avgifter i avin — då hamnar avgiften i kursdifferensen (*Banken anger ingen avgift — en eventuell avgift hamnar i kursdifferensen.*). Anger avin inget belopp i fakturans valuta blir läget **Beloppet avviker**; bekräfta då för hand med **Bekräfta utförd** på betalfilen. En separat avgiftspost från banken matchas inte utan visas som **Okänd** och kan markeras **Hanterad utanför Nav**.

En returnerad utlandsbetalning makulerar utbetalningen med en omföring av dess belopp i SEK, och det går bara om banken återförde exakt samma belopp i SEK som den drog. Annars bokförs ingenting (*Returen gäller ett annat belopp i kronor än utbetalningen tog från kontot. Makulera utbetalningen manuellt under Betalningar och bokför skillnaden för hand.*).

Lägen i bankfilen: **Beloppet avviker** (bankens belopp skiljer sig från betalfilens — kontrollera i internetbanken och bekräfta manuellt; gäller det en retur bokförs ingenting automatiskt, utan du makulerar utbetalningen för hand under **Betalningar** om det behövs), **Redan bekräftad** (omgångsposten är redan bekräftad för hand — raden visar utbetalningens UTB-nummer, och du markerar bankfilsposten med **Hanterad utanför Nav** så att den räknas som hanterad), **Okänd** (t.ex. kortköp) och **Hanterad utanför Nav**. **Ångra** tar tillbaka markeringen.

Läser du in en fil som redan är inläst visas *Filen är redan inläst* med länk till den befintliga filen, och poster som fanns i en tidigare fil hoppas över med besked om vilken fil de kom från. Misslyckas en enskild post (t.ex. för att bokföringsperioden är låst) visas orsaken per post, och övriga bokförs ändå.

### Avvisade och returnerade betalningar

**Markera som avvisad** används när internetbanken visar att en betalning inte gick iväg. Fakturan blir fri igen och kan läggas i en ny betalfil. Returnerar banken en utförd betalning (t.ex. *AC01* fel kontonummer) visas den som **Retur** i nästa bankfil. **Bokför valda** makulerar utbetalningen med en omföring på returdagen, och fakturan blir en öppen post igen (*Återförd*). Att makulera en utbetalning från en betalfil för hand under **Betalningar** ger samma resultat.

## Skicka dokument via e-post

Förfrågnings- och inköpsorderkorten har en sektion **E-post** längst ner (kräver att SMTP är konfigurerat under [System → Inställningar](/hjalp/system)):

- **Skicka via e-post** öppnar en dialog med **Mottagare** (förifylld med leverantörens huvudkontakts e-post; saknas den används en eventuell e-postadress från leverantörsimporten eller en äldre registrering), **Ämne** och **Meddelande** — alla redigerbara. Dokumentet bifogas som PDF med företagsuppgifter och logotyp från [Företagsinformation](/hjalp/system).
- Har någon av orderns artiklar uppladdade ritningar visas kryssrutan **Bifoga ritningar (N filer)**, ikryssad från början — bocka ur den för att bara skicka dokumentet. Ritningarna bifogas som egna filer med sina originalnamn (se fliken Filer i [Artiklar](/hjalp/artiklar)). Legorader — på både inköpsorder och förfrågan — bifogar sina ritningar **alltid**, oavsett kryssrutan: artikelns filer eller operationens egen uppladdade ritning, enligt operationens val **Använd artikelns ritningar** (se [Legorader på förfrågan](#legorader-pa-forfragan) ovan). Kryssrutan **Bifoga ritningar** styr bara de övriga raderna.
- Statuskoppling: en förfrågan i **Utkast** blir **Skickad**, en inköpsorder i **Utkast** blir **Bekräftad** — men bara om utskicket lyckas. Från senare statusar skickas mejlet om utan att statusen ändras. Beställda/avbrutna förfrågningar samt stängda/avbrutna ordrar kan inte mejlas.
- **Ladda ner PDF** hämtar samma dokument utan att skicka något.
- Kortets utskickshistorik visas under knapparna; hela loggen finns i [System → E-postlogg](/hjalp/system), där misslyckade utskick kan skickas om.
