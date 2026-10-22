# Inköp

Inköpsmodulen i Nav|ERP omfattar leverantörsregistret, förfrågningar (prisförfrågningar), inköpsorder med mottagning, fakturaunderlag och leverantörsfakturor.

## Översikt

Menyvalet **Inköp** öppnar modulens sida, där alla inköpsfunktioner ligger grupperade i ett rutnät:

- **Inköp** — **Inköpsorder**, **Förfrågningar** och **Inleverans**.
- **Leverantörsfakturor** — **Leverantörsfakturor** och **Fakturaunderlag**.
- **Reskontra** — **Öppna poster** och **Betalningar**.
- **Register** — **Leverantörer** och **Grunddata**.

Knappen **+ Ny inköpsorder** leder till orderlistan där ordern registreras. Nyckeltal och bevakningslistor för hela verksamheten finns på **Översikt**, startsidan.

Inköpsorderlistan och orderkorten ligger under **Inköp → Inköpsorder** (`/inkop/ordrar`). Gamla länkar och bokmärken till ett orderkort på den tidigare adressen skickas vidare automatiskt.

## Leverantörer

**Inköp → Leverantörer** listar alla leverantörer med kolumnen **Lev.nr** först; sökrutan matchar leverantörsnummer och namn. **+ Ny leverantör** registrerar **Leverantörsnummer** (valfritt — lämnas fältet tomt tilldelas nästa nummer automatiskt ur nummerserien, se [Nummerserier](/hjalp/system#nummerserier)), namn, vårt kundnummer, valuta (3 bokstäver, t.ex. SEK/EUR) och adress med postnummer/postort — kontaktpersoner läggs upp på leverantörskortets flik **Kontakter**. Knappen **Importera** läser in leverantörer, kontakter och leveransadresser från exportfiler (se [Importera leverantörer](#importera-leverantorer)).

Klicka på leverantörens namn för att öppna **leverantörskortet** med fyra flikar:

- **Allmänt** — **Leverantörsnummer** (unikt internt nummer; kan skrivas över i efterhand, upptagna nummer avvisas — skrivs inte ut på några dokument), **Vårt kundnummer** (vårt kundnummer i leverantörens system — skrivs ut som "Vårt kundnummer hos er" på förfrågan och inköpsorder när det är ifyllt), namn, aktiv, adress, postnummer, postort och valuta.
- **Adresser** — en lista med valbara **Leveransadresser** (**+ Ny leveransadress**), var och en med **Benämning** (t.ex. "Huvudlager"), adress, postnummer och postort. Knappen **Kopiera från adressen** i dialogen fyller i adressfälten från Allmänt-flikens adress (visas bara när en adress finns). En adress kan markeras som **Förvald**; max en adress åt gången är förvald, markeras en ny flyttas markeringen automatiskt. Till skillnad från kundkortets adressflik finns ingen fakturaadress här — leverantörens adress på Allmänt-fliken används som den.
- **Villkor & frakt** — organisationsnummer, VAT-nummer, leveransvillkor, betalningsvillkor, speditör och kundnummer hos speditör. Villkor och speditörer väljs ur registren under [Grunddata](/hjalp/grunddata) och visas med sitt namn, t.ex. "30 dagar netto". Här anges också leverantörens **Leveransdagar**, **Dagarna avser** och **Transportdagar**, se [Leveransdagar](#leveransdagar).
- **Kontakter** — flera kontakter per leverantör med namn, telefon, mobil, e-post och kommentar. En kontakt kan markeras som **Huvudkontakt** och visas då överst.

Uppe till höger på kortet finns **+ Ny förfrågan** och **+ Ny inköpsorder** — båda skapas med leverantören förvald.

### Betalning

Fliken **Villkor & frakt** har sektionen **Betalning**. Där väljer du **Betalningssätt** (**Bankgiro**, **Plusgiro**, **Bankkonto** eller **IBAN**) och fyller i numret. Nav kontrollerar kontrollsiffran och sparar numret utan mellanslag och bindestreck. Clearingnummer i 8-serien (Swedbank) ska vara 5 siffror, t.ex. 8327-9; övriga banker har 4 siffror. En leverantör utan betalningssätt kan inte betalas via betalfil. **IBAN** kan bara användas för svenska konton (SE…), eftersom utlandsbetalningar inte stöds.

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

Mallen laddas ned med **Ladda ned mall** i fliken; kolumnerna förklaras i [Importmallar](/hjalp/importmallar#leverantorer) (kontakter: [#leverantorskontakter](/hjalp/importmallar#leverantorskontakter), leveransadresser: [#leverantorernas-leveransadresser](/hjalp/importmallar#leverantorernas-leveransadresser)).

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
- **Postadress-filen**: "Leverantör" → Leverantörsnummer, "Postadress – Namn" → Namn, "Postadress – Adressrad 1/2/3" → Adress/Adressrad 2/Adressrad 3 (slås ihop till en adress med radbrytning; Adressrad 4 saknar motsvarighet), "Postadress – Postnummer" → Postnummer, "Postadress – Stad" → Postort. "Postadress – Land" mappas inte — leverantörer har inget landfält i Nav. Den kortare kolumnen "Namn" mappas automatiskt bara i Lista-filen — i Postadress- och övriga filer lämnas den omappad så att det juridiska namnet aldrig skrivs över av misstag.

Övriga mappningsbara fält: Kontaktperson, E-post, Telefon, Valuta, Betalningsvillkor, Leveransvillkor, Leveranssätt/speditör och Kundnummer hos speditör — de fyra sista fylls i på leverantörskortets flik **Villkor & frakt** och känns igen från rubriker som "Betalningsvillkor", "Leveransvillkor", "Leveranssätt"/"Speditör" och "Kundnummer hos speditör" i en egen CSV. **Leverantörsnummer** är obligatoriskt (märkt *). Namn behövs bara för nya leverantörer — kolumnen kan lämnas omappad och cellen får vara tom vid uppdatering.

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

Fliken **Inköpspriser** på **Artiklar → Importera** läser in artiklarnas leverantörskatalog (fliken **Inköp** på artikelkortet, se [Artiklar](/hjalp/artiklar#inkop)) från exporten **Prislista Inköp**. Två exportfiler läses med samma flik:

Mallen laddas ned med **Ladda ned mall** i fliken; kolumnerna förklaras i [Importmallar](/hjalp/importmallar#inkopspriser).

- **Prislista-Inköp (Lista)** — en rad per artikel och leverantör med rubrikerna **Förvald**, **Leverantör** (leverantörsnumret), **Lev. art.nr**, **Pris** och **Rabatt**, som alla känns igen automatiskt. **Förvald** = Ja gör leverantören till artikelns **huvudleverantör**.
- **Prislista-Inköp (stafflat)** — samma rader men en rad per **staffelsteg**: kolumnen **Gränsvärde antal** och en andra **Pris**-kolumn (guiden visar den som **Pris (2)** och mappar den till **Staffel: pris**). Grundpriset upprepas på varje rad. Filen saknar Förvald, så huvudleverantören lämnas orörd när den läses in.

Kolumner: **Artikelnummer** och **Leverantörsnummer** är obligatoriska; **Leverantörens artikelnummer**, **Pris**, **Rabatt (%)**, **Huvudleverantör (Förvald)**, **Staffel: från antal (Gränsvärde)** och **Staffel: pris** är valfria. Namn, Ställpris och Prisdatum importeras inte.

Regler att känna till:

- Artikeln och leverantören måste redan finnas (leverantören matchas på **leverantörsnummer**, se [Importera leverantörer](#importera-leverantorer)).
- **Rabatten räknas in i priset.** Filens Pris är bruttopriset och Rabatt en procentsats på det; katalogen har inget rabattfält, så importen sparar nettopriset Pris × (1 − Rabatt/100) — för grundpriset och varje staffelsteg — och varnar på raden att rabatten bakats in. Tomt Pris ger en katalograd utan pris.
- **Staffeln ersätts som helhet** per artikel och leverantör när kolumnen Gränsvärde är mappad — den stafflade filen är en fullständig lista, så en leverantör utan staffelrader i filen får sin staffel rensad. Läser du den vanliga listan (utan Gränsvärde) rörs stegen inte alls. Ett gränsvärde på 1 eller lägre ignoreras med en varning (antal 1 är grundpriset), ett gränsvärde utan pris eller samma gränsvärde två gånger är ett fel.
- **Huvudleverantör**: när kolumnen Förvald är mappad blir raden med Ja huvudleverantör och en tidigare huvudleverantör avmarkeras; två Ja på samma artikel i filen är ett fel.
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

**+ Ny leverantörsfaktura**. I huvudet anges **Leverantör**, **Leverantörens fakturanummer**, **Fakturadatum**, **Förfallodatum**, **Nettobelopp**, **Momssats**, **Momsbelopp**, **Bruttobelopp** och **Notering**. Beloppen i huvudet matas in från pappersfakturan och är det som gäller — så att frakt och öresavrundning alltid stämmer.

**Momsen förifylls.** När du fyller i **Nettobelopp** räknas **Momsbelopp** ut som nettobeloppet × **Momssats**, och **Bruttobelopp** som netto + moms. Momssatsen är **25 %** för leverantörer i svenska kronor och **0 %** för leverantörer i annan valuta. Skriver du själv i **Momsbelopp** eller **Bruttobelopp** rörs fältet inte längre — välj en annan **Momssats** så räknas momsen om igen. Kontrollera alltid beloppen mot pappersfakturan.

**Betalas till en annan leverantör.** Ibland kommer fakturan från någon annan än leverantören du beställde av, t.ex. ett factoringbolag eller ett moderbolag. Välj då leverantören du beställde av under **Leverantör** (så att dess inköpsorder går att hämta), kryssa i **Betalas till en annan leverantör** och välj leverantören fakturan ska betalas till under **Betalas till**. Fakturan registreras på den leverantören — det är den som syns i reskontran och får betalningen — medan raderna förblir matchade mot inköpsordern. På fakturakortet kan leverantören ändras under **Leverantör (betalas till)** så länge fakturan är ett **Utkast**; valutan följer då med från den nya leverantören, och bytet loggas i **Historik** som **Leverantör ändrad**.

Rader kan läggas till med **Beskrivning**, **Artikel** (valfri — frakt- och avgiftsrader saknar artikel), **Antal**, **À-pris** och **Moms %** — en lista med **25 %**, **12 %**, **6 %**, **0 %** eller **"— Ingen —"** (samma satser som på kundfakturan; radens momssats används bara för konteringsregeluppslaget, det är huvudets **Momsbelopp** som bokförs). Radens belopp räknas ut automatiskt (Antal × À-pris). Rader kan också läggas till i efterhand på fakturakortet så länge fakturan är i **Utkast**.

**Hämta underlag från inköpsorder.** När leverantören är vald visas **Hämta underlag från inköpsorder** med en lista över leverantörens inlevererade order (status Delvis mottagen, Mottagen eller Stängd). Välj en order, välj **Mottaget antal** (bara inlevererade rader, med mottaget antal) eller **Beställt antal** (alla rader, med beställt antal) och klicka **Hämta orderrader**. Raderna fylls i som en förhandsgranskning där enskilda rader kan tas bort innan du sparar, à-priset tas från orderraden, och varje rad blir automatiskt IO-matchad (se nedan). Är **Nettobelopp** tomt fylls det i från radsumman, och momsen och bruttobeloppet räknas ut därifrån som ovan. Raderna får fakturans **Momssats**. Har leverantören inga inlevererade order visas i stället en upplysning, och du kan mata in raderna för hand som vanligt.

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

### Bokföring av leverantörsfakturan

**Godkänn** bokför fakturan automatiskt — du behöver aldrig knappa in något verifikat för hand. Verifikatet hamnar i serien **L** (Leverantörsfakturor) och får beskrivningen **Leverantörsfaktura LF-… (leverantörens fakturanummer) — leverantörens namn**. Attesten och verifikatet sker i ett och samma steg: antingen blir båda av, eller ingetdera.

**Fakturadatum styr bokföringsperioden.** Verifikatet dateras med fakturans **Fakturadatum**, inte med dagens datum — det är alltså fakturadatumets period som måste vara öppen. Är perioden låst: ändra **Fakturadatum** på utkastet (huvudet är redigerbart i **Utkast**) eller lås upp perioden under **Ekonomi → Räkenskapsår**.

Konteringen utgår från **huvudets** belopp, som du matat in från pappersfakturan:

- **Leverantörsskuld** krediteras med **Bruttobelopp** (standardkonto **2440 Leverantörsskulder**).
- **Ingående moms** debiteras med **Momsbelopp** (standardkonto **2640 Ingående moms**).
- **Kostnaden** debiteras rad för rad. Har radens artikel en artikelgrupp med en konteringsregel styr regeln kostnadskontot; annars används standardkontot **4010 Inköp material och varor**. Rader utan artikel (frakt, avgifter) hamnar alltid på standardkontot.
- **Skillnaden mellan Nettobelopp och radernas summa** — frakt och öresavrundning som inte ligger på egna rader — bokförs som en sista kostnadsrad på standardkontot. Har fakturan inga rader alls hamnar hela nettobeloppet där.

På fakturakortet visas **Verifikat L-…** med en länk till verifikatet (t.ex. **L-2026-12**: serie, räkenskapsår och löpnummer). Numret är en länk för den som har behörighet till [Ekonomi](/hjalp/ekonomi) (administratörer och användare vars behörighetsgrupp ger Ekonomi, se [Behörighetsgrupper](/hjalp/system#behorighetsgrupper)); för andra visas det som text. Det är attesten som ger fakturan sitt L-verifikat — betalningen bokförs separat, i sin egen serie **U**, när den registreras i [Leverantörsreskontra](#leverantorsreskontra) nedan.

**Avbryt** på en **Godkänd** faktura bokför en **omföring** av attestens verifikat — samma konton och belopp, men debet och kredit ombytta, daterad i dag och med beskrivningen **Makulering LF-… (leverantörens fakturanummer) — leverantörens namn**. Verifikat raderas aldrig, de rättas. Har verifikatet redan förts om för hand under **Ekonomi → Verifikat** (**Omför**) och den omföringen är **bokförd** sker ingen ny omföring — makuleringen går igenom ändå. Ligger den manuella omföringen kvar som **Utkast** stoppas däremot makuleringen: ett utkast är ingen rättelse i bokföringen (det går fortfarande att ta bort), så fakturan förblir **Godkänd** tills utkastet bokförs eller tas bort. Fakturor som godkändes innan automatkonteringen fanns saknar verifikat och makuleras rakt av.

**Om bokföringen inte går att genomföra stoppas åtgärden.** Fakturan behåller då sin status (**Utkast** vid Godkänn, **Godkänd** vid Avbryt) och inget nummer bränns i verifikatserien — nästa verifikat fortsätter obrutet. Det händer i dessa fall:

- **Bokföringsperioden är låst** — för fakturadatumet vid Godkänn, för dagens datum vid Avbryt. Lås upp perioden under **Ekonomi → Räkenskapsår** (**Lås upp period**, motivering krävs) och försök igen.
- **Inget räkenskapsår täcker datumet.** Lägg upp räkenskapsåret under **Ekonomi → Räkenskapsår** först — perioderna skapas automatiskt.
- **Ett konto som konteringen behöver saknas eller är inaktivt** i kontoplanen. Lägg upp eller aktivera kontot under **Ekonomi → Kontoplan** (**Förifyll BAS-urval** lägger in hela standardurvalet på en gång).
- **Huvudets belopp går inte ihop.** **Nettobelopp** + **Momsbelopp** måste vara exakt **Bruttobelopp**.
- **Fakturan är i annan valuta än SEK.** Automatkonteringen räknar inte om valuta — registrera fakturan i SEK.
- **Fakturans bruttobelopp är noll.** Det finns ingenting att bokföra.

## Leverantörsreskontra

Leverantörsreskontran håller reda på vilka leverantörsfakturor som fortfarande har ett öppet belopp och registrerar de betalningar (utbetalningar) som stänger dem.

### Öppna poster

**Inköp → Öppna poster** listar varje godkänd leverantörsfaktura som fortfarande har ett öppet belopp: **Faktura** (registreringsnumret i LF-serien, med leverantörens eget fakturanummer under), **Leverantör**, **Förfallodatum** (rött och märkt "förfallen" när datumet har passerat), **Belopp** och **Öppet belopp**. Filtrera på leverantör eller kryssa i **Endast förfallna**; sökfältet matchar registreringsnummer, fakturanummer och leverantörsnamn. Klicka på fakturanumret för att öppna fakturakortet. Kolumnen **Betalfil** visar vilken betalfil fakturan ingår i, och kryssrutorna används för att [skapa en betalfil](#skapa-betalfil).

Förfallodatumet räknas fram ur leverantörens betalningsvillkor när fältet lämnas tomt när fakturan registreras (se [Skapa en faktura](#skapa-en-faktura) ovan) — anges det för hand vinner det alltid, och ändras aldrig i efterhand av sig själv.

### Registrera betalning

**Inköp → Betalningar** listar alla registrerade betalningar (UTB-nummer, datum, leverantör, belopp, konto, verifikat och status). Knappen **+ Registrera betalning** öppnar registreringsformuläret:

1. Välj **Leverantör** — leverantörens öppna poster hämtas in i en tabell nedanför. Till skillnad från kundreskontran finns ingen OCR-sökning här: leverantörsfakturor matchas alltid manuellt mot posterna.
2. Kryssa i de fakturor betalningen gäller. Varje ikryssad rad visar leverantörens **Fakturanr**, **Öppet belopp** och ett redigerbart **Belopp**, förifyllt med öppet belopp. Fältet till höger om beloppet visar direkt vad som händer:
   - **Stänger posten** — beloppet matchar öppet belopp exakt.
   - **Stänger posten · avskrivning X,XX kr** — beloppet ligger inom toleransen (se nedan) men matchar inte exakt; mellanskillnaden bokförs som öres-/kronutjämning och posten stängs ändå.
   - **Delbetalning · rest X,XX kr** — beloppet ligger utanför toleransen; posten förblir öppen med resten kvar.
   - **Beloppet överstiger öppet belopp** — beloppet är för högt även med toleransen inräknad; posten kan inte stängas med det beloppet.

   En leverantörs kreditfaktura har ett negativt öppet belopp — beloppet på dess rad anges också negativt.
3. Hur mycket en betalning får missa öppet belopp med och ändå räknas som fullt betald ställs in under **Ekonomi → Konteringsregler** som **Betalningstolerans (kr)** — samma inställning som styr kundreskontrans betalningar.
4. Fyll i **Betalkonto** (förvalt till kontot under Ekonomi → Konteringsregler → **Bank/betalkonto**, samma standardvärde som kundreskontran), **Betalningsdatum** (dagens datum förvalt) och en valfri **Notering**. **Summa** räknas fram automatiskt som summan av de ikryssade radernas belopp — det är detta belopp som bokförs mot betalkontot.
5. Klicka **Registrera betalning**.

**Kvittning av kreditfaktura:** kryssar du i poster vars belopp tar ut varandra helt inom samma betalning — till exempel en leverantörskreditfakturas negativa belopp mot en vanlig fakturas positiva, utan att någon av raderna hamnar inom toleransen och får en avskrivning — blir betalningens **Summa** 0 och inget verifikat bokförs, eftersom inga pengar har rört sig i banken. Det är en ren kvittning mellan leverantörens egna poster, och listan visar **—** i kolumnen **Verifikat** för en sådan betalning.

Har fakturan betalningar visas de i en egen sektion **Betalningar** på fakturakortet, under raderna: **Datum**, **Betalning** (länk till betalningens UTB-nummer, en makulerad betalning märks **· Makulerad** efter numret), **Belopp**, **Avskrivning** och **Verifikat** (länk för den som har behörighet till Ekonomi, annars bara text — en ren kvittning visar **– (kvittning)** i stället). Så länge fakturan är **Godkänd** med ett öppet belopp skilt från 0 visar kortet knappen **Registrera betalning**, som tar dig till Betalningar med fakturan förvald.

### Makulera betalning

På betalningens detaljsida (klicka på UTB-numret i listan) finns knappen **Makulera** under **Åtgärder**, synlig så länge betalningen inte redan är makulerad. En bekräftelsedialog visas eftersom åtgärden bokför en omföring av betalningens verifikat (om den bokförde något) och öppnar de fakturor betalningen stängde igen — de får tillbaka exakt det öppna belopp de hade innan betalningen, och statusen går tillbaka till **Godkänd**. En kvittning utan eget verifikat kan makuleras precis som en betalning med bankbelopp; det finns då inget att omföra, bara fakturorna som öppnas igen. En redan makulerad betalning visar statusen **Makulerad** och kan inte makuleras igen.

## Betalfiler

En betalfil är en betalningsomgång som Nav skriver som en pain.001-fil. Filen laddas upp i internetbankens filöverföring och attesteras där. Ingenting bokförs när filen skapas, eftersom banken kan avvisa betalningar. Utbetalningarna bokförs först när banken har bekräftat dem.

Förutsättningar: **System → Bank** är ifyllt (administratör), leverantören har ett **Betalningssätt** och fakturan är **Godkänd**.

### Skapa betalfil

Under **Öppna poster** kryssar du i fakturorna och klickar **Skapa betalfil**. Kryssrutan är avstängd för kreditfakturor (*Kreditfakturor kvittas under Betalningar*), för leverantörer utan betalningsuppgifter och för fakturor som redan ingår i en betalfil. Omgången får ett nummer i serien **BO-** och en post per faktura, med beloppet som är öppet och betalningsdagen satt till förfallodagen (eller idag om fakturan redan har förfallit). En faktura i en levande omgång är *reserverad*: den kan inte registreras manuellt under **Betalningar**, inte makuleras och inte få ny betalningsreferens förrän omgången är klar.

I utkastet kan du **Ändra** belopp (högst det öppna beloppet, för en delbetalning) och betalningsdag, **Ta bort** poster, **Lägg till fakturor** och **Makulera omgång**. Varningar som *Mottagarens namn skickas som "Svets och Montage i Exempelby AB"* visar hur banken kommer att se texten (bankernas teckenmängd saknar t.ex. `&`).

### Exportera och ladda upp

**Exportera betalfil** kontrollerar filen mot bankens regler, arkiverar den (med kontrollsumma, som räkenskapsinformation) och laddar ner den. Betalningsdagar som har passerat flyttas till idag. Ladda upp filen i internetbanken. Filen kan laddas ner igen med **Ladda ner fil**, men den skapas aldrig om. Om banken avvisar hela filen: **Makulera omgång** och skapa en ny.

Prova den första filen i bankens testverktyg (Swedbank Validex, SEB Test Bench).

### Bekräfta betalningar

Banken bekräftar betalningarna i en debiteringsavi (camt.054). Under **Inköp → Bankfiler** väljer du **Läs in bankfil**. Filens sida visar vilket **Konto** avin gäller och varnar om det inte är något av företagets konton under Företagsinformation (IBAN, bankgiro eller plusgiro). Poster som hör till en betalfil visas som **Matchad**, och **Bokför valda** registrerar dem som utbetalningar (serie U) på bankens bokföringsdag. Saknas avin används **Bekräfta utförd** på betalfilen: välj **Betalningsdag** och kryssa i de betalningar som banken har genomfört. Förvalda är de poster vars betalningsdag har kommit (alla väntande om ingen har det), och en varning visas om datumet ligger före betalningsdagen i filen för någon vald post. Poster du bockar ur väntar kvar på banken. Omgången är **Exporterad · 2 av 3 bekräftade** tills varje post är bekräftad, avvisad eller återförd. Då blir den **Bekräftad**.

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
