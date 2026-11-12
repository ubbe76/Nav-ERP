# Försäljning

Försäljningsmodulen i Nav|ERP omfattar kundregistret och flödet offert → kundorder → leverans → fakturering.

## Översikt

Menyvalet **Försäljning** öppnar modulens sida, där alla försäljningsfunktioner ligger grupperade i ett rutnät:

- **Order** — **Offerter**, **Kundorder**, **Utleverans**, **Leveranstidskontroll** och **Försändelser**.
- **Fakturering** — **Fakturor**, **Samlingsfakturering**, **Räntefakturering** och **Prislistor**.
- **Reskontra** — **Öppna poster** och **Betalningar**.
- **Register** — **Kunder** och **Grunddata**.

Knappen **+ Ny kundorder** öppnar formuläret **Ny kundorder** på orderlistan; offerter registreras i **Offerter**. Nyckeltal och bevakningslistor för hela verksamheten finns på **Översikt**, startsidan.

Offertlistan och offertkorten ligger under **Försäljning → Offerter** (`/forsaljning/offerter`), kundorderlistan och orderkorten under **Försäljning → Kundorder** (`/forsaljning/ordrar`). Gamla länkar och bokmärken till ett orderkort på den tidigare adressen skickas vidare automatiskt.

## Kunder

**Försäljning → Kunder** listar alla kunder med kolumnen **Kundnr** först; sökrutan matchar kundnummer och namn, och kolumnen **Valuta** visar kundens valuta. **+ Ny kund** registrerar **Kundnummer** (valfritt — lämnas fältet tomt tilldelas nästa nummer automatiskt ur nummerserien, se [Nummerserier](/hjalp/system#nummerserier)), namn och adress med postnummer/postort/**Land** samt **Valuta** (förvalt SEK, se [Försäljning i utländsk valuta](#forsaljning-i-utlandsk-valuta)) — kontaktpersoner läggs upp på kundkortets flik **Kontakter**. Knappen **Importera** läser in kunder, kontakter och leveransadresser från exportfiler (se [Importera kunder](#importera-kunder)).

Klicka på kundens namn för att öppna **kundkortet** med sex flikar — samma upplägg som leverantörskortet, plus en adressflik och två priser-/artikelnummerflikar:

- **Allmänt** — **Kundnummer** (unikt; kan skrivas över i efterhand, upptagna nummer avvisas), namn, aktiv och **Besöksadress** med postnummer/postort/**Land** (ISO-2-kod, t.ex. "SE"; standardvärde "SE"). **Språk** (**Svenska** eller **Engelska**) är språket på kundens dokument — se [Dokument på engelska](#dokument-pa-engelska). **Valuta** är kundens valuta (tre bokstäver, t.ex. SEK eller EUR): nya offerter och kundorder tas i den med dagens kurs, och kundens särpriser på fliken **Priser** anges i den — se [Försäljning i utländsk valuta](#forsaljning-i-utlandsk-valuta). Kundnumret skrivs ut som **Kundnr** på offert och orderbekräftelse, och fryses på fakturan när den utfärdas — en senare omnumrering ändrar inte redan utfärdade fakturor. Landet skrivs bara ut på dokumenten när det avviker från Sverige. **Vårt leverantörsnummer** (fritext) är det nummer kunden själv har på oss som leverantör i sitt system — det skrivs ut på offert, orderbekräftelse och faktura som "Vårt leverantörsnr hos er: …" och hämtas alltid från kundkortets aktuella värde, även på en redan utfärdad faktura. **Webbsida** visas på kundkortet som en klickbar länk; saknas protokoll läggs `https://` till automatiskt. Fältet **Kod på pallkort** (**Systemets förval**, **Ingen**, **Streckkod**, **QR-kod**) styr om kundens pallkort får en kod; **Systemets förval** följer systeminställningen. Fältet **Överleverans** (**Systemets förval**, **Tillåt**, **Tillåt inte**) styr om kundens orderrader får levereras med mer än beställt — se [Överleverans till kund](#overleverans-till-kund). Kryssrutan **Visa tilläggspriser** styr förvalet när offert och orderbekräftelse med konfigurerade rader skrivs ut eller mejlas (varje vals tillägg skrivs då ut efter valet) och vad fakturan visar när den utfärdas — se [Kundorder](#kundorder).
- **Adresser** — kundens övriga adresser:
  - **Fakturaadress** med ett eget **Fakturanamn** (töms fältet används kundens namn i stället), postnummer/postort/**Land** samt **E-post för faktura**.
  - **Leveransadresser** — en lista med valbara leveransadresser (**+ Ny leveransadress**), var och en med **Benämning** (t.ex. "Huvudlager"), adress, postnummer, postort och **Land**. Knappen **Kopiera från besöksadressen** i dialogen fyller i adressfälten från Allmänt-flikens besöksadress (visas bara när en besöksadress finns). En adress kan markeras som **Förvald** — den förifylls då på nya kundordrar. Max en adress åt gången är förvald; markeras en ny flyttas markeringen automatiskt. Landkolumnen visas bara i listan när adressen avviker från Sverige. Används adressen av ordrar har dialogen **Ändra** kryssrutan **Ändra inte befintliga ordrar (N st)**: med kryss behåller ordrarna den gamla adressen som sin egen adress (i orderns **Ändra orderhuvud** står den med tillägget *(bara den här ordern)*) och ändringen gäller bara nya ordrar; utan kryss ändras adressen även på ordrarna, också på deras utskrifter. **Ta bort** tar bort adressen från kundens lista, men ordrarna som använder den behåller den alltid som egen adress — bekräftelsen säger hur många.
- **Villkor & frakt** — organisationsnummer, VAT-nummer, leveransvillkor, betalningsvillkor, speditör, kundnummer hos speditör (väljs ur [Grunddata](/hjalp/grunddata)-registren och visas med sitt namn, t.ex. "30 dagar netto"), **Prislista** — kopplar kunden till en registrerad prislista (se [Prislistor](#prislistor)); en lista i annan valuta än SEK visas med valutan efter namnet, t.ex. *Exportlista (EUR)*, och kortet varnar när listans valuta skiljer sig från kundens (*Prislistan är i EUR men kundens valuta är SEK. Listan används bara på ordrar i EUR; kundens vanliga ordrar prissätts utan den.*); standardvalet är **Ingen prislista** — **Kundrabatt (%)**, en generell rabatt som slår igenom sist i priskedjan, och **Generellt påslag (%)** och **Materialpåslag (%)**, kundens egna påslag på förkalkylen som ger ett **Kalkylpris**, se [Priskedjan](#priskedjan) och [Kalkylpris och kundens påslag](#kalkylpris-och-kundens-paslag) nedan. Kryssrutan **Privatperson** byter etiketten **Organisationsnummer** till **Personnummer** och gör att offert, orderbekräftelse och faktura till kunden visar priser inklusive moms — raden "Priser inklusive moms" ovanför radtabellen, à-pris och radsumma inklusive moms, och summablocket blir **Summa inkl. moms** (offert/orderbekräftelse) respektive **Att betala** (faktura) följt av **Varav moms**; bokföringen påverkas inte, fakturan bokförs precis som vanligt, och visningen fryses vid utfärdandet så att ett senare ändrat kryss inte ändrar en redan utfärdad faktura. Kryssrutan **Samlingsfaktura** gör att kunden faktureras via rutinen [Samlingsfakturering](#samlingsfakturering) i stället för från fakturadialogen — se nedan. Kryssrutan **Faktura i vänteläge** markerar att kundens fakturor ska granskas före utskick: samlingsfaktureringens **Utfärda direkt** lämnar då kundens fakturor som **Utkast**, se [Samlingsfakturering](#samlingsfakturering), och fakturakortet påminner om det. Kryssrutan **Omvänd betalningsskyldighet för byggtjänster** och raden **Momsbehandling** styr hur kundens fakturarader beskattas, se [Momsbehandling](#momsbehandling). **Dröjsmålsränta** (förvalt ja) avgör om kunden får ränta på förfallna fakturor, **Avtalad räntesats (%)** — visas när **Dröjsmålsränta** är på — är en avtalad total räntesats per år som gäller i stället för räntelagens (tomt = enligt räntelagen: referensräntan plus räntemarginalen), och **Förseningsersättning** (förvalt ja) avgör om kunden får förseningsersättning på 450 kr. **Förseningsersättning** visas inte för en **Privatperson** — lagen ger bara företag rätt till den. Se [Räntefakturering](#rantefakturering). **Förvald fraktprodukt** väljer kundens standardtransport, se [Förvald fraktprodukt](#forvald-fraktprodukt). Här anges också kundens **Leveransdagar**, **Dagarna avser** och **Transportdagar**, se [Leveransdagar](#leveransdagar). Under organisationsnummer och VAT-nummer väljer **Fakturaleverans** hur kunden vill ha sina fakturor — **E-post** (förvalet) eller **E-faktura (Peppol)** — och **Peppol-id** anger kundens adress i Peppol-nätet (`0007:5560000000`: schemat `0007` är svenskt organisationsnummer, sedan numret utan bindestreck). Tomt **Peppol-id** betyder att Nav använder kundens organisationsnummer: `0007:` för en kund i Sverige, `0192:` i Norge, `0184:` (CVR-numret) i Danmark och `0208:` (företagsnumret) i Belgien — hjälptexten under fältet visar vilket. För kunder i andra länder måste Peppol-id fyllas i, till exempel `9930:DE123456789` för ett tyskt företag som tar emot på sitt momsnummer. Knappen **Kontrollera** frågar Peppols katalog i kundens land om id:t (det som står i fältet, även osparat) och svarar **Finns i Peppol** med företagets registrerade namn och vilka dokument det tar emot, **Finns inte i Peppol**, eller ett felmeddelande; i sandboxmiljön står det att svaret kommer därifrån. Fälten visas inte för **Privatperson**. Se [E-faktura (Peppol)](#e-faktura-peppol).
- **Kontakter** — flera kontakter med namn, telefon, mobil, e-post, kommentar och möjlighet att markera en **Huvudkontakt**.
- **Priser** — kundens egna prisregler, se [Kundpriser](#kundpriser) nedan.
- **Kundens artikelnummer** — vad kunden själv kallar våra artiklar, se [Kundens artikelnummer](#kundens-artikelnummer) nedan.

Uppe till höger på kortet finns **+ Ny offert** och **+ Ny kundorder** — båda skapas med kunden förvald.

### Momsbehandling

Hur en fakturarad beskattas avgörs av radens **Momskod** (se [Momskoder](/hjalp/ekonomi#momskoder) i kapitlet Ekonomi). Nav väljer koden åt dig utifrån kunden och artikeln — du kan alltid välja en annan kod på fakturaraden. Det är kundens egen **Land** på fliken **Allmänt** (besöksadressens land) som räknas, aldrig fakturaadressens eller leveransadressens.

| Kunden | Varor | Tjänster |
|---|---|---|
| **Privatperson** i Sverige eller annat EU-land | Artikelns svenska moms | Artikelns svenska moms |
| **Privatperson** i land utanför EU | **Export av varor** | Artikelns svenska moms |
| Sverige | Artikelns svenska moms | Artikelns svenska moms — men **Omvänd betalningsskyldighet, Sverige** om kunden har **Omvänd betalningsskyldighet för byggtjänster** |
| Annat EU-land, **med** VAT-nummer | **Varor till annat EU-land** | **Tjänster till annat EU-land** |
| Annat EU-land, utan VAT-nummer | Artikelns svenska moms | Artikelns svenska moms |
| Land utanför EU | **Export av varor** | **Tjänster till land utanför EU** |

**Artikelns svenska moms** är momskoden för artikelns momssats (den följer artikelns [varugrupp](/hjalp/artiklar#varugrupper), eller 25 % utan varugrupp): **Moms 25 %**, **Moms 12 %**, **Moms 6 %** eller **Momsfri**. **Varor** är alla artiklar som inte är tjänsteartiklar, samt fraktartikeln (frakt följer varuleveransen) och fria rader utan artikel. En privatperson utanför EU får alltså export utan moms för varor (varor som lämnar EU är undantagna oavsett köpare) men svensk moms för tjänster; distansförsäljning till privatpersoner i andra EU-länder (OSS) ingår inte i Nav.

**Momsbehandling** på fliken **Villkor & frakt** visar vad kunden får: **Svensk moms**, **Svensk moms (saknar momsnummer)**, **EU — utan moms**, **Export — utan moms**, **Privatperson i annat EU-land — svensk moms** eller **Privatperson utanför EU — export utan moms för varor**. Raden räknas ut av kundens **sparade** **Land** (fliken **Allmänt**) och av **VAT-nummer**, **Privatperson** och **Omvänd betalningsskyldighet för byggtjänster** som de står i formuläret. De tre sistnämnda följer dina ändringar medan du fyller i, men ett ändrat **Land** räknas först när **Allmänt** är sparat — och på fakturaraderna gäller allt först när kortet är sparat. Några lägen ger en varning på kortet:

- **Svensk moms (saknar momsnummer)** — *Kunden saknar momsregistreringsnummer — svensk moms debiteras.* Ange VAT-numret med landskod (t.ex. DE123456789) för att kunna fakturera utan moms inom EU.
- **Privatperson i annat EU-land — svensk moms** — svensk moms debiteras; distansförsäljning till privatpersoner i andra EU-länder (OSS) ingår inte i Nav.
- **Privatperson utanför EU — export utan moms för varor** — *Privatperson utanför EU — varor faktureras som export utan moms, tjänster får svensk moms. Spara tull- eller utförselbevis som underlag för momsfriheten.*
- **EU — utan moms** med ett VAT-nummer som har ett annat landsprefix än kundens **Land** — *Momsnumret har ett annat landsprefix (AT) än kundens land (DE) — kontrollera att det är rätt.* Det är tillåtet (ett EU-företag kan ha ett momsnummer från en annan medlemsstat än den adressen ligger i) men värt en extra titt.
- **EU — utan moms** med ett VAT-nummer som inte ser ut som ett momsnummer från något annat EU-land än Sverige — *Momsnumret ser inte ut som ett momsnummer från ett annat EU-land än Sverige — det ska börja med landskoden (för kundens land DE). Fakturor med EU-försäljning kan inte utfärdas förrän det är rättat.*

**Omvänd betalningsskyldighet för byggtjänster** gäller en svensk kund som själv är byggföretag: tjänsterader till kunden får momskoden **Omvänd betalningsskyldighet, Sverige** och fakturan skrivs ut utan moms. Varor påverkas inte, och kryssrutan gör ingenting för en kund i ett annat land eller en privatperson. Momskoden kräver kundens VAT-nummer på formen SE + tio siffror + 01, se [Köparens momsnummer](#koparens-momsnummer).

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

### Dokument på engelska

Fältet **Språk** på kundkortets flik **Allmänt** (och i dialogen **+ Ny kund**) är **Svenska** eller **Engelska** och styr vilket språk kundens dokument skrivs på. Förvalt är **Svenska**, och svenska dokument ser exakt ut som förut.

- **Offert**, **orderbekräftelse**, **följesedel** och **pallkort** följer kundens **Språk** vid varje utskrift: byter du språk på kunden skrivs nästa utskrift på det nya språket. Etiketter, rubriker, villkor, benämningar och enheter översätts; datum skrivs som förut (2026-11-01) men tal skrivs med engelsk talskrivning, t.ex. 1,234.50.
- **Fakturan** (och kreditfakturan) tar kundens språk **när den utfärdas** — **Utfärda** stämplar språket på fakturan. Eftersom fakturans PDF arkiveras då ändrar ett senare byte av kundens språk inte utskriften, påminnelserna eller arkivet för en redan utfärdad faktura. Ett utkast följer kundens aktuella språk tills det utfärdas.
- Artiklar skrivs med sin **Benämning (engelska)** och **Extra benämning (engelska)** när de är ifyllda, annars med den svenska texten (se [Artikelkortet](/hjalp/artiklar#allmant)). Leveransvillkor, betalningsvillkor, enheter och momskodernas namn och fakturatext hämtas på samma sätt ur sina engelska fält (se [Grunddata](/hjalp/grunddata) och [Momskoder](/hjalp/ekonomi#momskoder)); saknas en engelsk text används den svenska.
- Interna dokument — plocklista, interna pallkort och tillverkningsorder — är alltid på svenska. E-fakturan (Peppol) påverkas inte av språket.
- Dokumentens typsnitt har tecknen för de flesta europeiska språk, så namn som *Łódź Meble Spółka z o.o.* eller *Černý s.r.o.* och tecken som Ω och ≤ skrivs ut som de står. Ett tecken som typsnittet saknar (till exempel ⌀) blir en tom ruta; resten av texten påverkas inte.
- Ämne och meddelande i dialogerna **Skicka offert**, **Skicka orderbekräftelse**, **Skicka faktura** och **Skicka påminnelse** förifylls på dokumentets språk (till exempel *Quotation OF123* och *Hello, Please find attached quotation OF123. Best regards*). På kort för order och faktura visas texten **Dokument på engelska** vid knapparna för PDF och e-post när dokumentet skrivs på engelska.

### Försäljning i utländsk valuta

Varje kund har en **Valuta** (förvalt SEK). Säljer du till en kund i EUR följer valutan med genom hela flödet, och bokföringen sker alltid i SEK:

- **Offert och kundorder** får kundens valuta och **dagens kurs** (kronor per enhet av valutan) när de skapas — båda syns i orderhuvudet och kan ändras så länge ordern är en offert eller bekräftad. Raderna prissätts i orderns valuta, se [Priskedjan i valuta](#priskedjan-i-valuta) och [Valuta och kurs på offert och order](#valuta-och-kurs-pa-offert-och-order).
- **Fakturan** tar orderns valuta, och kursen sätts när fakturan **utfärdas** (fakturadatumets kurs) — eller en kurs du skriver in på utkastet. En kreditfaktura får alltid kursen från fakturan den krediterar. Se [Faktura i utländsk valuta](#faktura-i-utlandsk-valuta).
- **Kundbetalningen** registreras i fakturans valuta tillsammans med kronorna som kom in på kontot och bankens eventuella avgift; skillnaden mot det bokförda värdet bokförs som kursvinst eller kursförlust. Se [Betalning i utländsk valuta](#betalning-i-utlandsk-valuta).
- **Samlingsfakturering** gör en faktura per kund **och valuta**, **Öppna poster** visar beloppen i fakturans valuta med det bokförda värdet i kronor, och inbetalningar i utländsk valuta kan bokföras direkt från [bankfilen](#inbetalningar-i-utlandsk-valuta).

Kurserna hämtas från Sveriges Riksbank eller läggs in för hand under [Ekonomi → Valutakurser](/hjalp/ekonomi#valutakurser). Påminnelseavgiften kan bara tas ut på fakturor i SEK. E-faktura via Peppol skickas i fakturans valuta, se [E-faktura (Peppol)](#e-faktura-peppol).

## Importera alla kundfiler

Fliken **Alla filer** på **Försäljning → Kunder → Importera** (den första fliken) tar emot **alla kundexporter på en gång** i stället för en fil per flik. Guiden har fyra steg: **Filer**, **Kolumner**, **Förhandsgranska** och **Resultat**. Mallar och kolumnförklaringar finns under [Importera kunder](#importera-kunder).

1. **Filer** — välj alla filer i filväljaren (flera kan markeras samtidigt). Varje fil läses in direkt och känns igen på sina kolumnrubriker: Lista, Övrigt, Postadress och Fakturaadress som **Kunder**, Referenser som **Kontakter**, Leveransadress och Alternativa leveransadresser som **Leveransadresser**. Besöksadress känns inte igen — Nav har ingen besöksadress — och visas som **Okänd fil – hoppas över**, liksom en artikelfil eller annan fil som inte hör till kundsidan. Listan visar radantal och igenkänd typ per fil; **Ta bort** plockar bort en fil.
2. **Kolumner** — ett kort per fil, sorterat i importordning: kunderna först (Lista och Övrigt före Postadress och Fakturaadress, så att det juridiska namnet står kvar), sedan kontakter och sist leveransadresser. Typen kan ändras i fältet på kortet (välj **Hoppa över filen** för att lämna en fil utanför), kolumnmappningen ligger hopfälld under **Kolumner (…)** och filtypens egna val — t.ex. **Hoppa över rader som redan finns** — finns under den. **Förhandsgranska alla** granskar alla filer i ett svep.
3. **Förhandsgranska** — ett kort per fil med sammanfattningen (nya, uppdateras, hoppas över, fel, varningar). Varje fil visas som den kommer att se ut när de tidigare filerna har importerats: kontakter och leveransadresser till kunder som Lista-filen skapar visas alltså som **Ny**, inte som fel. Inget sparas förrän du klickar **Importera alla**. En fil med fel stoppar förhandsgranskningen av filerna efter den — de visar "Förhandsgranskas när felen i filen ovan är rättade." tills felet är rättat. **Importera alla** är låst tills ingen fil har fel — rätta filen, ta bort den eller sätt den till Hoppa över filen.
4. **Resultat** — filerna importeras i ovanstående ordning, varje fil som en egen import (allt eller inget per fil). Misslyckas en fil stoppas körningen där: de redan importerade filerna står kvar, den misslyckade visar raderna som stoppade den, och de efterföljande visas som **ej importerad – stoppad av felet ovan**. Rätta felet och kör de återstående filerna igen — det som redan kommit in hoppas över eller uppdateras enligt filtypens regler. Guiderna varnar om du försöker lämna sidan eller byta flik medan en inläst fil väntar på import. Överhoppade rader visas per fil med **Spara som fil** och **Skriv ut**.

## Importera kunder

**Försäljning → Kunder → Importera** öppnar en guide med fyra flikar. **Alla filer** tar emot alla kundfiler på en gång (se [Importera alla kundfiler](#importera-alla-kundfiler)); **Kunder**, **Kontakter** och **Leveransadresser** tar en fil i taget och tar tillsammans in en fullständig kundexport. Endast administratörer har åtkomst. Filer läses som CSV (semikolon, komma och tabb känns alla igen — även teckenkodningen identifieras automatiskt) eller Excel (.xlsx, bara det första bladet läses). Varje flik kör sin egen guide i fyra steg: **Fil**, **Kolumner**, **Förhandsgranska** och **Resultat**.

Mallen laddas ned med **Ladda ned mall** i fliken; kolumnerna förklaras i [Importmallar](/hjalp/importmallar#kunder) (kontakter: [Kundkontakter](/hjalp/importmallar#kundkontakter), leveransadresser: [Kundernas leveransadresser](/hjalp/importmallar#kundernas-leveransadresser)). **Exportera** bredvid ger det som redan finns i registret i samma kolumner, se [Exportera registren som importfiler](/hjalp/importmallar#exportera-registren-som-importfiler).

Kundexporten består av flera separata filer. **Fliken Kunder** körs en gång per fil, alltid i den här ordningen:

Fliken **Alla filer** gör hela den här körningen av sig själv — se [Importera alla kundfiler](#importera-alla-kundfiler).

1. **Lista** — skapar kunderna (matchning på kundnummer; finns kunden redan uppdateras den i stället) med kortnamn, organisationsnummer och VAT-nummer — och med villkor, speditör, prislista och rabatt när de kolumnerna finns med i filen (se nedan).
2. **Övrigt** — organisationsnummer, personnummer, VAT-nummer, **Samlingsfaktura**, **Faktura i vänteläge**, **Privatperson**, webbsida och vårt leverantörsnummer (kolumnerna känns igen som i Lista-filen, se nedan). Liksom Lista mappar filen det korta "Namn" och måste därför köras före Postadress — annars skrivs det juridiska namnet över av kortnamnet. Fliken **Alla filer** sköter ordningen åt dig.
3. **Postadress** — ersätter kortnamnet med det juridiska namnet ("Postadress – Namn") och fyller i besöksadress och land.
4. **Fakturaadress** — uppdaterar fakturaadressen för de kunder som avviker från sin postadress.

Kör alltså filerna efter varandra genom samma flik, utan att kryssa i **Hoppa över rader som redan finns** mellan körningarna — annars skrivs Postadress- och Fakturaadress-filernas fält aldrig in. Kontakter och leveransadresser importeras efteråt, var för sig, på sina egna flikar (kräver att kunderna redan finns). Körs Lista-filen (eller Övrigt) i stället *efter* Postadress skriver dess kortnamn över det juridiska namnet — sätt då kolumnen "Namn" till **Importera inte** i steget **Kolumner**.

1. **Fil** — välj filen med filväljaren, så läses den in direkt. Första raden ska innehålla kolumnrubriker. Max 10 000 rader per fil.
2. **Kolumner** — varje kolumn i filen mappas mot ett fält; kända rubriker föreslås automatiskt (se listorna nedan) och kolumner satta till **Importera inte** hoppas över. Kryssrutan **Hoppa över rader som redan finns** lämnar poster som redan finns helt orörda i stället för att uppdatera/skapa dem — se [Hoppa över befintliga rader](/hjalp/artiklar#hoppa-over-befintliga-rader). Klicka **Förhandsgranska** för att gå vidare.
3. **Förhandsgranska** — varje rad visas som **Ny**, **Uppdateras** eller **Hoppas över** tillsammans med eventuella fel och varningar. En ruta ovanför tabellen listar de register som kommer att skapas automatiskt (se nedan). Knappen **Importera** är låst tills alla fel är åtgärdade — rätta filen och börja om från steget **Fil**.
4. **Resultat** — visar hur många rader som skapades, uppdaterades och hoppades över, plus vilka register som skapades. De överhoppade listas i tabellen **Överhoppade rader**, som kan sparas som fil eller skrivas ut. **Klar** går tillbaka till kundregistret.

### Fliken Kunder

Kolumner som känns igen automatiskt (exportfilens egna rubriker inom citattecken) och fältet de mappas mot:

- **Lista-filen**: "Kund" → Kundnummer, "Namn" → Namn (kortnamnet — ersätts av det juridiska namnet i nästa steg), "Organisationsnr" → Organisationsnummer, "Momsreg.nr" → VAT-nummer (importeras som det står i filen — cellen innehåller ibland ett VAT-nummer, ibland ett organisationsnummer). Har kolumnerna tagits med i exportens listinställning känns även "Betalningsvillkor", "Leveransvillkor", "Leveranssätt" → Leveranssätt/speditör, "Prislista", "Rabatt" → Kundrabatt (%), "Vårt leverantörsnummer", "Samlingsfaktura", "Faktura i vänteläge", "Privatperson" och "Webbsida" igen — exportera gärna Lista med dem så att en enda körning både skapar kunderna och sätter villkoren. **Samlingsfaktura** och **Privatperson** tolkas som kryss: Ja/Nej, 1/0, x eller true/false — **Faktura i vänteläge** tolkas på samma sätt (Ja/Nej, 1/0, x eller true/false), och för Samlingsfaktura räknas lägena "Per kund", "Per leveransadress" osv. (allt som börjar med "Per") som ikryssat, "Nej" som avmarkerat. Ett annat värde ger radfel. "Personnummer" → **Personnummer**, som sparas i fältet Organisationsnummer (kundkortet visar det som Personnummer när **Privatperson** är ikryssad) — bara när radens Organisationsnummer är tomt; en rad med båda behåller organisationsnumret med varningen "Personnumret importerades inte — raden har redan organisationsnummer …". Övriga Lista-kolumner saknar motsvarighet i Nav och lämnas omappade: Prioritet, Kundgrupp, Moderbolag (kund), Välj leveransadress, Kundkategori, Kundnummer faktura, Kreditlimit, Försäkringsavgift, Bankgiro, PlusGiro, Faktureringsavgift, Betalningspåminnelse, Påminnelseavgift, Öresavrundning, Factoring, Distributionsmetod, Terminskurs, Strökund, Order/Faktura/Ärende som XML, EORI-nr samt Flera order/fakturor i e-post.
- **Postadress-filen**: "Kund" → Kundnummer, "Postadress – Namn" → Namn (det juridiska namnet — skriver över Lista-filens kortnamn, vilket är avsikten), "Postadress – Adressrad 1/2/3" → Adress/Adressrad 2/Adressrad 3 (slås ihop till en adress med radbrytning; Adressrad 4 saknar motsvarighet), "Postadress – Postnummer" → Postnummer, "Postadress – Stad" → Postort, "Postadress – Land" → Land. Den kortare kolumnen "Namn" mappas automatiskt bara i Lista-filen — i Postadress-, Fakturaadress- och övriga filer lämnas den omappad så att det juridiska namnet aldrig skrivs över av misstag.
- **Fakturaadress-filen**: "Avviker från postadress", "Fakturaadress – Namn" → Fakturanamn, "Fakturaadress – Adressrad 1/2/3" → Fakturaadress/Fakturaadressrad 2/Fakturaadressrad 3, "Fakturaadress – Postnummer"/"Fakturaadress – Stad"/"Fakturaadress – Land" → Fakturapostnummer/Fakturapostort/Fakturaland.

Övriga mappningsbara fält: Kontaktperson, E-post, Telefon, E-post för faktura och Valuta (känns igen från rubrikerna "Valuta" och "Valutakod"). **Kundnummer** är obligatoriskt (märkt *). Namn behövs bara för nya kunder — kolumnen kan lämnas omappad och cellen får vara tom vid uppdatering; en ny kund utan namn stoppas med "Namn saknas — obligatoriskt för ny kund".

Regler att känna till:

- **Allt eller inget.** Innehåller filen ett enda radfel importeras ingenting — det som förhandsgranskningen visar som fel måste rättas i filen först. Varningar stoppar däremot aldrig importen.
- **Tomma celler skriver aldrig över.** Vid uppdatering lämnas fält med tom cell orörda; vid ny kund lämnas de tomma.
- **Ogiltig e-postadress stoppar inte raden.** Adressen hoppas över med varningen "Ogiltig e-postadress '…' — fältet lämnades tomt", och fältet behåller sitt tidigare värde vid uppdatering. Gäller både **E-post** och **E-post för faktura**.
- Samma kundnummer två gånger i filen ger fel på den andra raden.
- Numeriska kundnummer räknar upp kundernas nummerserie, så nästa **+ Ny kund** får ett nummer ovanför det högsta importerade. Serien sänks aldrig, och kundnummer med bokstäver importeras som de är utan att röra serien (se [Nummerserier](/hjalp/system#nummerserier)).
- **Valuta** versaliseras automatiskt ("eur" blir "EUR") och måste vara en kod på tre bokstäver — annars stoppas raden med felet "Ogiltig valutakod '…' — ange 3 bokstäver, t.ex. SEK". Tom valutakolumn ger **SEK** för nya kunder och rör inte befintliga. Nya offerter och kundordrar får kundens valuta (se [Försäljning i utländsk valuta](#forsaljning-i-utlandsk-valuta)); befintliga ordrar behåller sin.
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

Läser exportens **Leveransadress**-fil och filen **Alternativa leveransadresser**. Mappningsbara fält (filens rubriker "Leveransadress – …" känns igen automatiskt): Kundnummer ("Kund"), Namn ("Leveransadress – Namn" — etiketten på adressen; saknas den blir den "Leveransadress"), Adressrad 1–3 (slås ihop som på kundfliken), Postnummer, Stad, Land och **Förvald**. I filen Alternativa leveransadresser heter två kolumner "Namn": den första är kundens namn och lämnas omappad, den andra (**Namn (2)** i kolumnväljaren) är adressens namn. Leveransvillkor, Leveranssätt, Kundgrupp och momsregistreringsnumret per adress har ingen motsvarighet och importeras inte.

- Kunden måste redan finnas i registret.
- En rad utan adress (exporten skriver en rad per kund även när ingen leveransadress är registrerad) hoppas över, liksom en adress som är identisk med kundens egen adress (postnummer, ort och land normaliserade).
- En adress som redan finns registrerad på kunden hoppas också över.
- Kryssrutan **Sätt som förvald leveransadress** gör att en kund som ännu saknar en förvald adress får sin första importerade adress som förvald — aldrig en till om kunden redan har en förvald sedan tidigare.
- Är kolumnen **Förvald** mappad avgör den per rad i stället för kryssrutan (Ja/Nej, 1/0, X eller true/false). Har kunden redan en förvald adress läggs raden till utan att vara förvald, med en varning.

## Prislistor

**Försäljning → Prislistor** är registret över prislistor: gemensamma staffelprissättningar som kopplas till en eller flera kunder via kundkortets flik Villkor & frakt. Listan visar **Kod**, **Namn**, **Beskrivning**, **Valuta** och **Antal rader**; sökrutan matchar kod eller namn. **+ Ny prislista** registrerar **Kod**, **Namn**, en valfri **Beskrivning** och **Valuta** (förvalt SEK) — listans priser anges i den valutan.

Klicka på en rad för att öppna **prislistans kort**:

- Huvudet (**Kod**, **Namn**, **Beskrivning**, **Valuta**) redigeras och sparas med knappen **Spara**. **Valuta** kan bara ändras så länge listan saknar prisrader — har den rader är fältet låst, och en ändring via API:t avvisas med *Valutan kan inte ändras när prislistan har rader*. Ta bort raderna först om listan ska byta valuta.
- **Prisrader** — en rad per artikel och staffelsteg, med kolumnerna **Artikel**, **Från antal** och **À-pris (kr)** (för en lista i annan valuta står valutakoden i stället för kr, t.ex. **À-pris (EUR)**). **+ Lägg till rad** öppnar en dialog där artikeln väljs med artikelväljaren; **Från antal** och **À-pris (kr)** anges (`Från antal` minst 0, fritt antal decimaler; priset med två decimaler). Samma artikel kan ha flera rader med olika **Från antal** för att bygga en staffel, t.ex. 1 st → 90 kr och 10 st → 80 kr. Varje rad har egna knappar för **Ändra** och **Ta bort** — vilken artikel raden gäller kan inte ändras i efterhand, bara tas bort och läggas till på nytt.
- **Ta bort prislista** tar bort hela listan, men avvisas (409) så länge en kund fortfarande pekar på den.

Bara **administratörer** skapar och ändrar prislistor: **+ Ny prislista**, **Spara**, **+ Lägg till rad**, radernas **Ändra** och **Ta bort** samt **Ta bort prislista** visas inte för andra användare, som kan öppna och läsa listorna men inte ändra dem.

Vid prissättning väljs den rad vars **Från antal** är det högsta som fortfarande är ≤ det beställda antalet — se [Kundpriser](#kundpriser) för hela priskedjan. Priskedjan använder en prislista bara på ordrar i listans egen valuta, se [Priskedjan i valuta](#priskedjan-i-valuta).

## Kundpriser

Utöver prislistorna kan varje kund ha egna prisregler, oberoende av vilken prislista (om någon) kunden är kopplad till. De hanteras på **kundkortets flik Priser**:

- Kundens priser för en artikel kan också ändras från artikelkortets flik **Försäljning**, avsnittet **Kundpriser** (dialogen **Kundpris**, se [Fliken Försäljning](/hjalp/artiklar#fliken-forsaljning)) — det är samma uppgifter, så en ändring syns på båda ställena. Där hanteras artikelns alla staffelsteg för kunden på en gång.
- Tabellen visar kundens registrerade regler: **Artikel/Grupp**, **Från antal**, **Pris**, **Rabatt %**, **Ställpris** (— när regeln saknar ställpris). Har kunden en annan valuta än SEK står den i kolumnrubriken, t.ex. **Pris (EUR)**.
- **+ Ny prisregel** öppnar en dialog:
  - **Måltyp** — radioknapparna **Artikel** eller **Varugrupp** väljer om regeln gäller en enskild artikel (artikelväljaren) eller en hel varugrupp (dropdown ur varugruppsregistret).
  - **Från antal** — staffelgränsen, precis som på prislistan.
  - **Pristyp** — radioknapparna **Specialpris (kr)** eller **Rabatt (%)** väljer om regeln sätter ett fast pris eller en procentuell rabatt. Ett specialpris anges i **kundens valuta**, så för en kund i EUR heter alternativet **Specialpris (EUR)**.
  - Beroende på valet visas fältet **Specialpris (kr)** (respektive kundens valuta) eller **Rabatt (%)**.
  - **Ställpris** (valfritt) — ett engångsbelopp i kundens valuta som läggs på ordern som en egen rad, se [Ställpris och ställkostnad](#stallpris-och-stallkostnad). Tomt fält = inget ställpris; tömmer du fältet i **Ändra** tas ett befintligt ställpris bort.
  - Målet (artikel eller varugrupp) låses när regeln väl är skapad — **Ändra** visar det som ett skrivskyddat fält; är regeln fel skapad tas den bort och läggs till på nytt.
- **Ta bort** tar bort en regel efter bekräftelse.

### Ställpris och ställkostnad

En prisregel kan ha ett **Ställpris**: en engångskostnad (till exempel för inställning eller verktyg) som kunden betalar en gång per orderrad, oavsett antal. Ställpriset anges i regelns valuta, alltså kundens, och gäller regeln som matchar artikeln och antalet enligt [priskedjan](#priskedjan).

Ställpriset blir en **egen orderrad**, en *ställkostnadsrad*:

- **När den läggs till:** när en ny rad läggs på en offert eller order — i **Ny offert**, **Ny kundorder**, **Lägg till rad** på orderkortet eller via API:et — för en artikel vars kundprisregel har ett ställpris över 0, läggs raden direkt efter artikelraden. Den får **Ställkostnadsartikeln** som artikel, antal 1 och ställpriset som à-pris, även om du själv skrev ett eget à-pris på artikelraden. En artikel utan ställpris, eller som är själva Ställkostnadsartikeln, får ingen ställkostnadsrad.
- **Förutsättning:** en **Ställkostnadsartikel** måste vara vald under **System → Inställningar** ([Ställkostnadsartikel](/hjalp/system#installningar)). Är den tom läggs ingen rad till, och ställpriset används inte.
- **På orderkortet** visas raden som en vanlig rad med den dämpade texten **Ställkostnad för {artikelnummer}** under benämningen. Den kan ändras och tas bort som andra rader (priset kan alltså justeras för hand), och den levereras och faktureras som andra rader. Flera artiklar på samma order kan ha var sin ställkostnadsrad. Ställkostnadsraderna räknas inte när formulären varnar för att artikeln redan finns på ordern.
- **Ändras antalet** på artikelraden ändras inte ställkostnadsraden — ställpriset är ett engångsbelopp.
- **Tas artikelraden bort** tas dess ställkostnadsrad bort med den, så länge den inte är levererad. Bekräftelsen **Ta bort … ur ordern?** nämner det.
- **Utskrifter:** på offert, orderbekräftelse och faktura skrivs **Ställkostnad för {artikelnummer}** ut under ställkostnadsraden.
- **Befintliga rader** påverkas inte när ett ställpris läggs till eller ändras på kunden i efterhand — bara nya rader får en ställkostnadsrad.

### Kundens artikelnummer

Många kunder har egna artikelnummer för det de köper av oss. På **kundkortets flik Kundens artikelnummer** registrerar du vad kunden kallar varje artikel — ett nummer per kund och artikel:

- Tabellen visar **Artikelnummer**, **Benämning** och **Kundens artikelnummer**, sorterade efter artikelnummer.
- **+ Nytt artikelnummer** öppnar en dialog där du väljer **Artikel** (den sökbara artikelväljaren) och skriver **Kundens artikelnummer** (högst 50 tecken, inledande och avslutande blanksteg tas bort). Har kunden redan ett nummer för artikeln visas *Kunden har redan ett artikelnummer för den här artikeln.*
- **Ändra** ändrar bara kundens artikelnummer; artikeln visas skrivskyddad. Är artikeln fel tar du bort raden och lägger till den på nytt.
- **Ta bort** tar bort numret efter bekräftelse.
- Fliken kräver samma behörighet som kundens prisregler på fliken **Priser**.

Kundens artikelnummer kan också skrivas in i dialogen **Kundpris** på artikelkortets flik **Försäljning** ([Fliken Försäljning](/hjalp/artiklar#fliken-forsaljning)).

Numret skrivs ut som **Ert art.nr: …** på första raden under artikelns benämning på **offert, orderbekräftelse, plocklista, följesedel och faktura**. Det hämtas alltid från kundkortets aktuella värde när dokumentet skrivs ut — men en redan utfärdad faktura behåller det nummer den hade när den utfärdades, eftersom fakturans PDF arkiveras. Kundens artikelnummer kan också läsas in med [Importera kundpriser](#importera-kundpriser).

### Priskedjan

Priset på en orderrad slås upp i sex steg, mest specifika regel vinner:

1. **Kundens egen prisregel för artikeln** (Priser-fliken, Måltyp Artikel).
2. **Kundens prisregel för artikelns varugrupp** (Priser-fliken, Måltyp Varugrupp).
3. **Kundens prislista** (kundkortets Villkor & frakt-flik).
4. **Kalkylpris** — bara när kunden har ett eget **Generellt påslag (%)** eller **Materialpåslag (%)** (kundkortets Villkor & frakt-flik) och varken steg 1–3 gav en träff. Priset räknas på artikelns senaste sparade förkalkyl med kundens påslag, se [Kalkylpris och kundens påslag](#kalkylpris-och-kundens-paslag). Ingen kundrabatt läggs på det.
5. **Artikelns eget försäljningspris** (artikelkortets fält **Försäljningspris (kr)**, se [Artiklar](/hjalp/artiklar)).
6. **Kundens rabatt (%)** (kundkortets Villkor & frakt-flik, fältet **Kundrabatt (%)**) — bara när inget av steg 1–2 gav en träff. Rabatten läggs på priset från steg 3 eller, saknas det, steg 5; finns inget sådant grundpris ger den inget pris alls. Rabatten läggs aldrig på ett **Kalkylpris**.

Inom varje steg med staffelrader (Priser-fliken och prislistan) vinner raden med det högsta **Från antal** som fortfarande är ≤ det beställda antalet. En regel av typen **Rabatt (%)** i steg 1–2 räknas alltid på det pris som skulle gällt ett steg längre ner i kedjan (prislistan eller, saknas den, artikelns försäljningspris — aldrig ett Kalkylpris) — finns inget sådant grundpris ger regeln inget pris alls, den faller inte tyst vidare i kedjan. Saknas pris i alla stegen går det inte att lägga raden.

Offert- och orderformulären låter servern sätta priset när fälten **Á-pris** och **Rabatt (%)** är orörda och priset föreslogs av priskedjan (vilket steg som helst). Raden minns då att priskedjan prissatte den och följer orderns påslag om de ändras, se [Påslag på offert och order](#paslag-pa-offert-och-order). Skriver du själv ett à-pris eller en rabatt räknas raden som handskriven och ändras aldrig av påslagen. API:t löser priset automatiskt enligt kedjan ovan när **à-pris utelämnas** på en orderrad — det är tänkt för en extern produktkonfigurator som bara skickar artikel, antal och kund.

**Varianter** av en konfigurerbar artikel tar kundens avtal på mallen när varianten själv saknar prisregel och prislisterad — se [Variantens pris](/hjalp/artiklar#varianter).

### Kalkylpris och kundens påslag

Ger kunden ett eget påslag kan priset räknas ur kalkylen i stället för att hämtas ur ett prisregister. Ange **Generellt påslag (%)** och/eller **Materialpåslag (%)** på kundkortets flik **Villkor & frakt** (0–1 000). Tomt fält betyder att kunden ärver varugruppens eller företagets påslag (platshållaren *Ärvs*), och **0** är ett uttryckligt 0 %. Att ändra fälten kräver behörigheten Försäljning och loggas i händelseloggen som **Påslag ändrade**.

För en artikel som varken har en kundspecifik prisregel eller ett prislistepris (och kunden har ett eget påslag) räknar Nav fram **Kalkylpris** på artikelns senaste sparade förkalkyl, med kundens påslag i stället för företagets. Räknas påslaget som i kalkylen blir priset samma som **Sätt försäljningspris** i förkalkylen ger. Kundrabatten läggs inte ovanpå, och inget ställpris följer med.

På **Ny offert**, **Ny kundorder**, **Lägg till rad** och **Ändra** visar texten under à-priset varifrån priset kommer, till exempel *Kalkylpris: förkalkyl 2026-11-07, generellt påslag 25 % (kunden), materialpåslag 0 % (företaget)*; nivån anger om påslaget kommer från ordern, kunden, varugruppen eller företaget. Fyller du själv i **Á-pris** eller **Rabatt (%)** vinner ditt värde och texten försvinner. Sparas raden med det föreslagna priset märks den med **Kalkylpris** under à-priset. Ändrar du antalet på en rad med **Ändra** och låter à-priset och rabatten vara orörda räknas priset om ur priskedjan på det nya antalet; behålls antalet sparas priset som det är. Ändrar du bara rabatten med **Ändra** blir raden handskriven, även om à-priset är detsamma.

Kan påslaget inte användas visar formuläret en varning och artikelns försäljningspris används i stället: *Kundens påslag kunde inte användas — artikeln saknar sparad förkalkyl* eller *Kundens påslag kunde inte användas — spara en ny förkalkyl för artikeln* (en äldre flernivåkalkyl där materialbasen saknas när materialpåslaget ändras).

Kalkylpriset är i SEK och räknas om med orderns kurs på en order i annan valuta, se [Priskedjan i valuta](#priskedjan-i-valuta).

### Priskedjan i valuta

På en offert eller order i annan valuta än SEK prissätts raderna i **orderns valuta**, och stegen ovan gäller så här:

1. **Kundens prisregler** (steg 1–2, både **Specialpris** och **Rabatt (%)**) gäller bara när ordern är i **kundens egen valuta** — reglerna är angivna i den. En order i en annan valuta än kundens ignorerar kundens prisregler.
2. **Kundens prislista** (steg 3) används bara när listans **Valuta** är densamma som orderns. En lista i annan valuta hoppas över, utan fel.
3. **Kalkylpris** (steg 4) räknas i SEK och **räknas om med orderns kurs** på samma sätt som artikelns försäljningspris. Påslaget är en procentsats och gäller i alla valutor.
4. **Artikelns försäljningspris** (steg 5) står alltid i SEK och **räknas om med orderns kurs** (kronor per enhet av valutan) till närmaste öre — 1 000 kr vid kursen 11,131 blir 89,84 EUR.
5. **Kundens rabatt (%)** (steg 6) är en procentsats och gäller i alla valutor.

Staffeln (**Från antal**) fungerar som vanligt, och en konfigurerad artikels tillägg (anges i SEK på mallen) räknas om med samma kurs. Priset räknas när raden läggs till eller antalet ändras — **kursen på ordern ändrar aldrig priset på rader som redan finns**, se [Valuta och kurs på offert och order](#valuta-och-kurs-pa-offert-och-order).

För att en order i EUR ska få egna priser i stället för omräknade SEK-priser: lägg upp en **prislista i EUR** och koppla kunden till den, eller — för en kund som alltid handlar i EUR — sätt kundens **Valuta** till EUR och ange **Specialpris** på fliken **Priser**.

## Importera kundpriser

Fliken **Kundpriser** på **Artiklar → Importera** läser in kundernas artikelpriser (kundkortets flik **Priser**, se [Kundpriser](#kundpriser)) och kundernas egna artikelnummer (flik **Kundens artikelnummer**, se [Kundens artikelnummer](#kundens-artikelnummer)). Tre exporter från det tidigare affärssystemet känns igen automatiskt: **Prislista Försäljning** — en rad per kund och artikel med rubrikerna **Kund** (kundnumret), **Pris** och **Rabatt** — den **stafflade** prislistan med samma kolumner plus **Gränsvärde antal** och **Pris (staffling)**, och **Artikellista, Kundkopplingar**, som kopplar artiklar till kunder med kundens eget artikelnummer.

Kolumner: **Artikelnummer** och **Kundnummer** är obligatoriska; **Pris**, **Rabatt (%)**, **Ställpris**, **Kundens artikelnummer**, **Staffel: från antal** och **Staffel: pris** är valfria. Rubrikerna **Kundens art.nr** och **Kundens art.nummer** pekar på **Kundens artikelnummer**. En rad måste ha minst ett pris eller ett kundens artikelnummer — en rad kan alltså bära enbart kundens artikelnummer. **Ställpris** kräver att raden har ett **Pris** eller ett staffelsteg, och anges i kundens valuta; **0** betyder inget ställpris och en tom cell lämnar ett befintligt ställpris orört. Ställpriset läggs på ordern som en egen rad om en **Ställkostnadsartikel** är vald, se [Ställpris och ställkostnad](#stallpris-och-stallkostnad).

Från **Artikellista, Kundkopplingar** importeras **Artikelnummer**, **Kundnummer** (från kolumnen Kund), **Pris**, **Rabatt**, **Ställpris** och **Kundens art.nr**. Kundnamn, Valuta, Enh. och Ledtid importeras inte.

Mallen laddas ned med **Ladda ned mall** i fliken; kolumnerna förklaras i [Importmallar](/hjalp/importmallar#kundpriser). **Exportera** bredvid ger det som redan finns i registret i samma kolumner, se [Exportera registren som importfiler](/hjalp/importmallar#exportera-registren-som-importfiler).

- Kunden (matchad på **kundnummer**) och artikeln måste redan finnas.
- Rader utan kund (i exporten står **Kundkoppling saknas**) och rader med varken pris eller kundens artikelnummer hoppas över och listas som överhoppade.
- Priset sparas som en **artikelregel med Specialpris (kr)** från antal 1. En rad utan **Pris** (och utan staffel) skapar ingen prisregel, och därmed inget ställpris heller.
- **Rabatten räknas in i priset.** En prisregel är antingen ett pris eller en rabatt, så importen sparar nettopriset Pris × (1 − Rabatt/100) och varnar på raden att rabatten bakats in.
- **Kundens artikelnummer** sparas på kundkortets flik **Kundens artikelnummer**. Läses samma kund och artikel in igen ersätts det befintliga numret med filens.
- Har kunden redan en regel för artikeln (från antal 1) uppdateras den till det nya priset — även en regel som var en rabatt blir då ett specialpris. Med **Hoppa över rader som redan finns** lämnas ett befintligt pris eller artikelnummer orört, staffel inräknad. Samma kund och artikel två gånger i filen är ett fel — utom i en stafflad fil, där varje steg är en egen rad.

### Stafflade kundpriser

I den stafflade prislistan har varje staffelsteg en egen rad: kund och artikel upprepas, **Gränsvärde antal** är antalet där steget börjar och **Pris (staffling)** stegets pris. Varje steg blir en egen prisregel på kundkortets flik **Priser** med **Från antal** = gränsvärdet. På offert- och orderraden gäller steget med det högsta **Från antal** som inte överstiger radens antal — se [Kundpriser](#kundpriser).

- **Pris** blir regeln från antal 1. Finns ett steg med gränsvärde **1** gäller dess pris från antal 1 i stället, med en varning om det skiljer sig från **Pris**.
- **Pris 0** på en artikel med staffel betyder *inget eget pris under första steget*: ingen regel från antal 1 skapas och en befintlig tas bort (varning på raden). Under första steget gäller då kundens prislista eller artikelns försäljningspris. Utan staffel är Pris 0 ett pris på 0 kr, som i den vanliga listan. Ett tomt **Pris** lämnar en befintlig regel från antal 1 orörd.
- Filens steg **ersätter** kundens tidigare staffel på artikeln: steg som inte finns i filen tas bort, och en rad utan gränsvärde betyder att artikeln inte har någon staffel. Den vanliga prislistan (utan kolumnen **Gränsvärde antal**) rör aldrig staffeln.
- **Rabatt** räknas in i stegens priser på samma sätt som i **Pris**.
- **Ställpris** hör till kundens avtal på artikeln och sparas på varje steg, så att det följer med oavsett vilket steg ordern hamnar på. En tom cell ger nya steg samma ställpris som regeln från antal 1.
- Samma gränsvärde två gånger för samma kund och artikel, eller ett gränsvärde utan staffelpris, är ett fel.

## Offerter

**Försäljning → Offerter** är offertlistan: alla offerter med status **Offert**, **Order**, **Förlorad** eller **Avbruten**. Sökrutan matchar offertnummer och kund, statusfiltret har just de fyra statusarna, och kolumnen **Giltig t.o.m.** visar märkningen **Utgången** när datumet har passerat (bara på en offert i status Offert — en offert med status **Order** är aldrig utgången). **+ Ny offert** (även på kundkortet) öppnar formuläret [Ny offert](#kundorder) och landar på offertkortet.

En offert är en kundorder i status **Offert** — raderna, konfigurationen, fraktpriset, revisionen och offertuppföljningen fungerar som på en order — men den har ett **eget nummer** ur serien **Offert** (**OF-1001**, se [Nummerserier](/hjalp/system#nummerserier)) och sin egen lista och sitt eget kort, med rubriken **Offert OF-1001**. Offert-PDF:en och offertmejlet använder offertnumret.

Offertkortet har inga knappar för orderbekräftelse och plocklista: **Orderbekräftelse (PDF)**, **Skicka orderbekräftelse** och **Plocklista (PDF)** finns på orderkortet, när en kundorder har skapats.

**Skapa kundorder** (ersätter den tidigare knappen **Bekräfta** på offertkortet; kräver rättigheten Försäljning) frågar *Skapa en kundorder av offert OF-1001? Raderna och priserna kopieras.* och skapar sedan en **ny kundorder** som du flyttas till: den får nästa **KO-nummer** ur serien Kundorder, offertens rader kopieras med sina priser och huvudfälten (kund, referens, villkor, leveransadress, valuta och kurs, påslag, kostnadsställe och projekt) följer med och kan ändras på ordern. Orderkortet visar **Offertnummer** (länk till offerten) i huvudet och *Från offert OF-1001* under rubriken **Kundorder KO-1043**. Där finns **Skicka orderbekräftelse** och **Orderbekräftelse (PDF)**; orderbekräftelsen skriver **Vår offert: OF-1001** i huvudet, och orderkortets **Historik** visar även händelserna från tiden som offert. Offerten finns kvar och får statusen **Order**; den kan ändras (rader, huvud, PDF och e-post fungerar som förut) och ge **fler ordrar** — varje **Skapa kundorder** kopierar offertens rader som de ser ut just då. En offert med status Order kan inte bli **Förlorad**, **Avbruten** eller öppnas igen, och den manuella statusändringen saknas (servern svarar *Offerten har redan gett en kundorder och kan inte byta status*). Så snart det finns ordrar visar offertkortet avsnittet **Ordrar från offerten** med varje orders KO-nummer (som länk), status och skapad-datum, äldsta först. En order som sätts tillbaka till status Offert behåller sitt KO-nummer och får inget nytt när den bekräftas igen; förloras eller avbryts den får den tillbaka sitt OF-nummer och KO-numret blir oanvänt.

**+ Ny kundorder** (på [Kundorder](#kundorder)) skapar och bekräftar i ett steg och får ett KO-nummer direkt utan att förbruka något offertnummer. **Offerter som skapades före offertnumreringen behåller sina KO-nummer** — de står kvar i offertlistan så länge de har status Offert eller Förlorad, men saknar OF-nummer.

Öppnar du en offert på orderkortets adress, eller en order på offertkortets, flyttas du automatiskt till rätt kort.

### Giltighetstid och förlorade offerter

**Giltig t.o.m.** är sista dagen offerten gäller. Fältet finns i formuläret **Ny offert** (inte i **Ny kundorder**), förifyllt med dagens datum plus inställningen **Offertens giltighetstid (dagar)** (förval 30, se [Inställningar](/hjalp/system#installningar)); töm fältet för en offert utan giltighetstid. På en befintlig offert ändras datumet i **Ändra orderhuvud** och visas i orderhuvudet; ändringen höjer revisionen eftersom datumet skrivs ut. Offert-PDF:en och offertmejlet skriver *Offerten gäller till och med 2026-11-20.* under huvudet; orderbekräftelsen skriver inte ut det.

Passerar datumet markeras offerten **Utgången** i orderhuvudet och i offertlistan, som har en egen kolumn **Giltig t.o.m.**. En utgången offert byter aldrig status av sig själv: den står kvar som offert tills du skapar en kundorder av den, markerar den som förlorad eller ändrar datumet. En offert med status **Order** markeras aldrig som **Utgången** och visas inte under **Offerter att följa upp**. Offerter som snart går ut eller har gått ut dyker upp bland [Aviseringarna](/hjalp/aviseringar) som **Offerter att följa upp**.

**Förlorad…** (bara i status Offert) öppnar dialogen **Markera offerten som förlorad**. Välj **Orsak** (obligatorisk, ur de aktiva [förlustorsakerna](/hjalp/grunddata#forlustorsaker)), skriv ev. en **Kommentar** och klicka **Markera som förlorad**. Offerten får status **Förlorad** och orderhuvudet visar **Förlustorsak**, **Markerad förlorad** (när och av vem) och **Kommentar**. En förlorad offert är låst som en avbruten: inga rad- eller huvudändringar och ingen PDF eller e-post. Skillnaden mot **Avbryt order** är att en förlorad offert räknas i [Offertuppföljningen](/hjalp/rapporter#offertuppfoljning), medan en avbruten offert ses som felregistrerad och inte räknas i hit rate.

**Öppna igen** (bara i status Förlorad) frågar först och gör sedan ordern till en vanlig offert igen; förlustorsaken rensas men finns kvar i orderns historik. Giltigheten rörs inte, så ändra **Giltig t.o.m.** om den har gått ut. Sätter du status Förlorad med [Ändra status manuellt](#manuell-statusandring) blir det utan orsak (rapporten visar *Ingen orsak angiven*), och byter du från Förlorad till annan status rensas orsaken.

## Kundorder

En kundorder skapas på två sätt:

- **+ Ny kundorder** (på **Försäljning → Kundorder** och kundkortet) skapar och bekräftar i samma steg — används när affären redan är klar. Ordern får ett KO-nummer direkt.
- **+ Ny offert** (på **Försäljning → Offerter**, se [Offerter](#offerter)) skapar en offert som blir kundorder när den bekräftas — används när kunden ska ta ställning till pris först.

Båda använder samma formulär: du väljer kund (förvald från kortet), ev. förväntat leveransdatum, anteckning samt orderrader: artikel via artikelväljaren, antal, enhet, **Á-pris** och **Rabatt (%)**. **Kundorder**-listan visar bara ordrar (statusfiltret har inte Offert eller Förlorad); offerterna finns i sin egen lista. Statusfiltret har också **Sen**: bekräftade ordrar och ordrar under tillverkning där en rad med rest har ett leveransdatum som har passerat — samma urval som aviseringen [Försenade kundordrar](/hjalp/aviseringar). **Sen** är ingen egen status utan räknas fram när listan visas, och exporten till CSV följer filtret.

**Konfigurerbara artiklar:** en mall (se [Artiklar](/hjalp/artiklar#konfigurator)) visas i artikelväljaren med märkningen **Konfigurerbar** och öppnar dialogen **Konfigurera** med mallens valgrupper, giltighetsfel per grupp och priset för valet (kundens pris när kunden är vald, på det antal raden har). I läget **Variantartiklar** hämtar **Lägg in** varianten om den finns och skapar den annars, och raden får variantartikeln — därefter är det en vanlig rad med [variantens priskedja](/hjalp/artiklar#varianter); under artikelfältet står *Varianten 63000-B-1200 skapades* respektive *fanns redan*. I läget **Beställningsvara** stannar mallen som radens artikel: **Lägg in** lägger valen på raden, valraderna (t.ex. *Lock: Lock B*, *Bredd: 1 200 mm*) visas under artikelfältet, **Á-pris** och **Rabatt (%)** förifylls från konfigurationens pris (kundens pris på mallen plus tilläggen, kundens rabatt) och kan skrivas över, och **Konfigurera om** öppnar dialogen igen innan raden sparas. Samma mall får ligga flera gånger på en order med olika val. **Avbryt** (eller Esc) tömmer artikelfältet. Själva mallen kan aldrig sparas utan konfiguration; via API:t svarar systemet att artikeln är en beställningsvara och ska konfigureras. Samma dialog finns på **Lägg till rad** på orderkortet. Går strukturen inte att härleda för valen (mallen har t.ex. en strukturrad vars alternativ saknar artikel, en formel som inte går att räkna eller ett operationsnummer som krockar) vägrar systemet raden redan här — på offert såväl som kundorder, och lika vid antalsändring och **Ändra konfiguration** — med *Kombinationen kan inte tillverkas — åtgärda mallens struktur på artikelkortet.* följt av vad som är fel. Via API:t ges samma avslag utan detaljer.

**Ändra konfiguration:** på orderkortet har beställningsvarurader och variantrader valet **Ändra konfiguration** i radens meny **⋯** så länge ordern är i status Offert, Bekräftad eller Under tillverkning och raden varken har levererats, har en tillverkningsorder eller är fakturerad (annars saknas valet, och servern vägrar med samma skäl). Dialogen är förifylld med radens val. För en beställningsvara ersätts valen och priset — även ett á-pris du skrivit själv, vilket dialogen påpekar; för en variantrad byter raden till den variant valen ger (den hämtas eller skapas) och prissätts om enligt priskedjan — ligger varianten redan som vanlig rad på ordern blir det två rader på samma variant. Vägrar servern (raden har gått vidare, strukturen går inte att härleda) står felet i dialogen och valen finns kvar. Ändras antalet på en konfigurerad rad räknas priset om med mallens staffel, som på vanliga rader. Valen skrivs ut under raden på offert, orderbekräftelse, faktura, plocklista och följesedel; tilläggspriserna bara på offert/orderbekräftelse/faktura och bara med **Visa tilläggspriser** (se [Skicka offert och orderbekräftelse via e-post](#skicka-offert-och-orderbekraftelse-via-e-post)).

**Pris- och rabattförifyllning:** så snart artikel och antal är ifyllda (och kunden är vald) slås [priskedjan](#kundpriser) upp automatiskt och fyller i **Á-pris** och **Rabatt (%)** — ändras antalet över en staffelgräns räknas priset om på nytt. Skriver du själv i något av fälten vinner det manuella värdet ("manuellt vinner") — en senare antalsändring skriver aldrig över ett pris eller en rabatt du själv har fyllt i, och byts artikeln nollställs det manuella låset så nästa artikel prisförifylls som vanligt. Samma förifyllning och samma regel gäller när en rad läggs till eller ändras på ett befintligt orderkort.

**Enhet på raden:** dropdownen **Enhet** visar artikelns grundenhet och alternativa enheter (se [Artiklar](/hjalp/artiklar)) och förifylls med artikelns **Försäljningsenhet**. Byter du enhet räknas ifyllt antal och à-pris om direkt (500 kg ⇄ 100 st vid faktorn 1 st = 5 kg); à-pris-etiketten visar `kr/{enhet}`. Radantal och pris lagras alltid i grundenheten, men kortet och PDF:erna visar raden i den valda enheten. PDF:erna (offert, orderbekräftelse, faktura, plocklista, följesedel) skriver antal och à-pris med upp till fyra decimaler (2,125 st à 1,4306 kr), beloppen med två. Lagersaldot förs alltid i grundenheten.

**Avrundning:** har artikeln en **Avrundning** (Lager-fliken på artikelkortet) avrundas radens antal uppåt till närmaste multipel i grundenheten när raden sparas eller antalet ändras — 12 på en artikel med Avrundning 5 blir 15 — och priskedjan slås upp på det avrundade antalet. Se [Artiklar](/hjalp/artiklar#lager).

Formuläret har också fälten **Kundens förfrågan (valfritt)** i **Ny offert** respektive **Kundens ordernummer (valfritt)** i **Ny kundorder**, **Referens (valfritt)** samt en **Leveransadress**-select med kundens registrerade leveransadresser (se kundkortets Adresser-flik) — kundens förvalda adress är förifylld, och **Ingen** går alltid att välja.

**Ny leveransadress direkt på ordern.** Ska ordern till en adress som inte finns på kunden väljer du **+ Ny leveransadress…** sist i listan och fyller i **Benämning** (t.ex. "Bygget Solna" — skrivs ut som första raden i leveransadressblocket), **Adress**, **Postnummer**, **Postort** och **Land**. Utan kryss i **Spara på kunden** gäller adressen bara den här ordern: den syns inte bland kundens leveransadresser och kan inte väljas på andra ordrar, och den tas bort när ordern byter till en annan adress. Med kryss läggs den till bland kundens leveransadresser (inte som förvald) och kan användas igen. Samma val finns i **Ändra orderhuvud** på orderkortet, där orderns egen adress visas med tillägget *(bara den här ordern)*.

**Kundens förfrågan** är kundens eget nummer eller beteckning på förfrågan som offerten svarar på; **Kundens ordernummer** är kundens beställningsnummer, som sällan finns förrän kunden beställer. Kundens förfrågan, ordernummer och referens skrivs ut som **Er förfrågan** / **Ert ordernummer** / **Er referens** på offerten och orderbekräftelsen när de är ifyllda — orderbekräftelsen till en order som kom från en offert visar alltså både kundens ordernummer och förfrågan. Ett **Leveransadress**-block skrivs ut när en leveransadress är vald. Plocklistan visar också leveransadressen, kundens ordernummer och referens — plocklistan, följesedeln och fakturan skriver inte ut kundens förfrågan. Båda numren finns som kolumner (**Kundens ordernr**, **Kundens förfrågan**) i listans export. Landet skrivs ut i adressblocket — kundens, fakturaadressens och leveransadressens — bara när det avviker från Sverige. Har kunden ett **Vårt leverantörsnummer** ifyllt skrivs det ut som "Vårt leverantörsnr hos er: …". Är kunden markerad **Privatperson** (se [Kunder](#kunder)) visas priserna inklusive moms — raden "Priser inklusive moms" ovanför radtabellen, à-pris och radsumma inklusive moms, och summablocket blir **Summa inkl. moms** följt av **Varav moms**.

Ordern får automatiskt kundens **Leveransvillkor**, **Betalningsvillkor** och **Speditör** från kundkortets flik Villkor & frakt, och de skrivs ut på offerten och orderbekräftelsen när de är satta.

**Moms på offert och orderbekräftelse.** Momsen räknas per rad efter den momskod raden skulle få på fakturan — en EU-kund med VAT-nummer ser alltså 0 % redan på offerten — och kodernas fakturatexter skrivs ut under summeringen, precis som på fakturan. Se [Momsbehandling](#momsbehandling).

**Orderhuvudet.** Orderkortet (och offertkortet) inleds med ett kort som visar status, **Rev**, valuta (och fakturanummer när ordern är fakturerad) tillsammans med orderns uppgifter: **Kund** (klickbar till kundkortet), **Offertnummer** (på en order som skapats ur en offert; länk till offerten), **Kundens förfrågan** på en offert respektive **Kundens ordernummer** på en order (en order visar även **Kundens förfrågan** när den är ifylld, och en äldre offert som har ett ordernummer visar det), **Referens**, **Leveransdatum**, de tre villkoren, **Leveransadress** och **Notering**. Knappen **Ändra** öppnar dialogen **Ändra orderhuvud**, där kundens förfrågan, kundens ordernummer (på en offert bara när den redan har ett), referens, **Kostnadsställe** och **Projekt** (se [Kostnadsställe och projekt](#kostnadsstalle-och-projekt-pa-order-och-faktura)), villkoren och leveransadressen redigeras på ett ställe och sparas i ett svep, så länge ordern är i status Offert, Bekräftad eller Under tillverkning. Leveransdatum och notering sätts när offerten skapas och visas bara.

### Valuta och kurs på offert och order

**Ny offert** och **Ny kundorder** har fälten **Valuta** och — för en annan valuta än SEK — **Kurs**, direkt under **Kund**. **Valuta** är förifylld med kundens valuta och kan ändras för just den här ordern (en order i SEK åt en kund i EUR, eller tvärtom). **Kurs** är kronor per 1 enhet av valutan och förifylls med dagens kurs — Riksbankens senaste dagskurs, eller en egen kurs från [Ekonomi → Valutakurser](/hjalp/ekonomi#valutakurser) — och under fältet står varifrån den kommer: *Riksbanken 2026-10-23. Källa: Sveriges Riksbank.*, *egen kurs i Valutakurser 2026-10-23* eller *manuell*. Skriver du i fältet gäller din kurs; **Använd dagens kurs** (visas då) tar tillbaka den uppslagna. Hittas ingen kurs visas *Ingen kurs för EUR 2026-10-24 — ange kursen själv*, och ordern går inte att skapa förrän kursen är ifylld. Byter du valuta eller kurs i formuläret räknas priserna om för alla rader du inte skrivit in själv; priser du skrivit för hand ändras inte (formuläret påminner om det). Kolumnen **Á-pris** heter då t.ex. **Á-pris (EUR/st)**.

**På orderkortet** visar huvudet valutan (**Rev 1 · EUR**) och raden **Kurs** (*1 EUR = 11,131 kr*). I **Ändra orderhuvud** (så länge ordern är en offert eller bekräftad) finns **Valuta** och **Kurs**:

- **Valuta** kan bara ändras när ordern **saknar rader** — annars skulle priserna stå i fel valuta. Har ordern rader är fältet låst med texten *Valutan kan inte ändras när offerten/ordern har rader — ta bort raderna först*, och en ändring via API:t avvisas med samma besked. En ny valuta får dagens kurs om du inte anger en.
- **Kurs** kan ändras även när raderna finns. **Hämta dagens kurs** tar en ny kurs. Raderna **behåller sina priser**: kursen räknar om artikelns SEK-pris på rader som läggs till därefter, orderns värde i SEK i rapporterna och täckningsbidraget. Vill du prissätta om en befintlig rad ändrar du den med **Ändra**.
- När ordern är **Under tillverkning** (eller längre fram) ändras varken valuta eller kurs. Varje ändring loggas under **Historik**.

Radlistan visar à-priser och summa i orderns valuta (**89,84 EUR**, **Summa … EUR**) och under den står **Ordervärde i SEK: … kr (kurs 11,131)**. **Täckningsbidraget** räknas alltid i **SEK**: självkostnaden i förkalkylen är i kronor, så radens pris räknas om med orderns kurs innan det jämförs (*Täckningsbidrag … SEK (räknat med orderns kurs)*; i formulären *TB … · räknat i SEK*). Frakten prissätts av Sendify i SEK och läggs på en order i EUR omräknad med orderns kurs — dialogen **Fraktpris** säger det. Dialogen **Konfigurera** visar valmöjligheternas pris i orderns valuta (*Priserna är i EUR (kurs 11,131).*). Offert, orderbekräftelse och faktura skrivs ut i orderns valuta. Rapporterna **Orderförteckning**, marginalrapporten och **Offertuppföljning** räknar om ordrar i utländsk valuta till SEK med orderns kurs; offertuppföljningen visar även offertens eget värde i valutan.

**Kundorderlistan** och **Offerter** har kolumnen **Valuta**.

### Påslag på offert och order

Ett påslag kan också sättas på just den här offerten eller ordern. I **Ändra orderhuvud** finns **Generellt påslag (%)** och **Materialpåslag (%)** (0–1 000, två decimaler). Platshållaren visar kundens eget värde, eller *Ärvs* när kunden inte har något; tomt fält betyder att ordern ärver kundens, sedan varugruppens och sist företagets påslag, och **0** är ett uttryckligt 0 %. Orderns påslag går före kundens, fält för fält. Fälten kräver behörigheten Försäljning och går bara att sätta på orderkortet, inte i **Ny offert** eller **Ny kundorder**. Är ett påslag satt visas det i orderhuvudet som **Generellt påslag** respektive **Materialpåslag**, och ändringen loggas under **Historik** som **Påslag ändrade**.

**Omräkning.** Ändrar du ett påslag och trycker **Spara** frågar Nav först vad ändringen gör med raderna. Raderna som räknas om är de som priskedjan prissatt — med **Kalkylpris**, artikelns försäljningspris, ett kundpris eller prislistan, se [Priskedjan](#priskedjan) — och som varken är levererade eller fakturerade, inte heller på ett fakturautkast eller en kreditfaktura. Priskedjan prissätter raden på nytt med orderns nya påslag, så en rad som hade artikelns försäljningspris får **Kalkylpris** när ordern får ett påslag, även om raden lades till innan. En rad med kundpris eller prislistepris får samma pris igen. Ändrar du också **Kurs** i samma sparning räknas priserna med den nya kursen. Bekräftelsen räknar upp de påslag som ändras, listar varje rad med artikelnummer och à-pris före och efter (med *nu Kalkylpris* eller *inte längre Kalkylpris* när priset byter steg), de rader som inte ändras med orsaken (*handskrivet pris*, *levererad*, *fakturerad*, *samma pris som förut* eller *priskedjan ger inget pris*) och meningen *Handskrivna priser och levererade eller fakturerade rader ändras inte.* Knappen **Räkna om och spara** räknar om raderna och sparar huvudet i ett svep; **Avbryt** sparar ingenting. Därefter frågar Nav som vanligt om ordern ska få en ny revision. Ändrar påslagen inget pris sparas huvudet utan bekräftelse.

**Det som aldrig räknas om:**

- Handskrivna rader: rader där du skrivit à-priset eller rabatten själv, och rader som inte prissatts av priskedjan — konfigurerade rader, ställkostnadsrader och fraktraden.
- Levererade och fakturerade rader, även delvis.
- Rader som lades in innan Nav började spara varifrån priset kom räknas som handskrivna, utom de som var märkta **Kalkylpris**. Vill du att en sådan rad ska följa påslagen tar du bort den och lägger till den igen.

Kan kalkylen inte ge något pris med de nya påslagen (till exempel *Förkalkylen är sparad före ändringen av påslagskedjan — förkalkylera igen*) går raden vidare i kedjan och får artikelns försäljningspris, vilket syns i bekräftelsen. Raden följer fortfarande påslagen: rensar du ett påslag av misstag och sätter tillbaka det får raden **Kalkylpris** igen. Ändras raderna eller påslagen av någon annan medan du sparar avvisas sparningen med ett meddelande och orderkortet läses om; öppna **Ändra orderhuvud** och spara igen. Ändringen påverkar aldrig förkalkylen, lagervärdet eller kundens eller varugruppens egna påslag.

### Leveransdatum per rad

Orderns **Leveransdatum** gäller alla rader. Ska en rad levereras ett annat datum ger du den ett eget:

- I **Ny kundorder** och **Ny offert** kryssar du i **Eget leveransdatum per rad**, så får varje rad fältet **Leveransdatum**. Tomt betyder samma som ordern.
- På orderkortet finns fältet **Leveransdatum** i **Lägg till rad** och i radens **Ändra**, med texten "Tomt = som ordern" under. Töm fältet så följer raden orderns datum igen.
- En rad med eget datum visar **Leveransdatum …** under benämningen. På offerten, orderbekräftelsen och plocklistan står orderns **Leveransdatum** i huvudet och radens eget datum under raden, bara när det avviker.

Radens datum, annars orderns, är det datum planeringen räknar behovet på: [artikelöversikten](/hjalp/artiklar#artikeloversikt), [färdigdatumsförslaget](/hjalp/tillverkning#foreslaget-fardigdatum) (även **Skapa TO** på raden) och [Leveranstidskontrollen](#leveranstidskontroll) — på avsändningsdagen, se [Leveransdagar](#leveransdagar). Kolumnen **Leveransdatum** i kundorderlistan och bevakningslistan på [Översikten](/hjalp/komma-igang#oversikten) visar **nästa leveransdatum**: det tidigaste datumet bland raderna som inte är fullt levererade. Leveransprecisionsrapporten mäter fortfarande hela ordern mot orderns datum.

Vill du veta vilket leveransdatum du faktiskt kan lova, använd knappen **Leveranstidskontroll** på orderkortet (och i **Ny kundorder**) — den räknar fram ett datum ur lager, material och produktionens beläggning och låter dig sätta **Förväntat leveransdatum** med **Använd datumet**. Se [Leveranstidskontroll](#leveranstidskontroll).

Längst ner på kortet visar sektionen **Historik** ordens egna händelser (statusövergångar och radändringar) — se [Händelselogg](/hjalp/system#handelselogg).

### Statusflöde

Överst på kortet ligger en **knapprad** med de åtgärder som är möjliga i orderns aktuella status; sekundära åtgärder ligger under **⋯**. Radlistan visar dessutom kolumnerna **Á-pris** och **Rabatt** (rabatten visas bara när den är större än 0) samt **Belopp** per rad (antal × á-pris × (1 − rabatt/100)) och avslutas med **Summa**; beloppet är detsamma oavsett vilken enhet raden visas i.

**Täckningsbidrag.** Under radlistan visas orderns **täckningsbidrag** och **täckningsgrad**, räknade mot varje artikels senaste sparade **förkalkyl** (självkostnad per styck — se [Artiklar](/hjalp/artiklar#kalkyl)). Samma siffra visas live medan du sätter priset, både i **Lägg till rad** och när en ny offert skapas: `TB … kr · TG … %`.

På en konfigurerad beställningsvarurad mäts täckningsbidraget i stället mot **förkalkylen för konfigurationen**: kostnaden för radens egna struktur (material och operationer för just de valda alternativen) vid radens antal, inte mallens sparade kalkyl. I **Lägg till rad** ändras TB när du ändrar antalet, och på orderkortet räknas kostnaden om när raden sparas, när du använder **Ändra konfiguration** och när antalet ändras. Under täckningsbidraget står *Förkalkyl för konfigurationen, <datum>* med datumet kostnaden räknades. Rader vars konfiguration saknar användbar kalkyl räknas som *saknar förkalkyl*, och under täckningsbidraget står då *Förkalkyl saknas för konfigurationen på N rad(er)*. Ett fel i själva kalkylen (t.ex. en valutakurs som inte går att hämta) stoppar aldrig raden eller tillverkningsordern — raden sparas utan förkalkyl och felet hamnar i serverloggen. Hur tillverkningsordern för en beställningsvara skapas och rapporteras beskrivs under [Tillverkningsorder för beställningsvara](/hjalp/tillverkning#tillverkningsorder-for-bestallningsvara).

Rader vars artikel saknar förkalkyl kan inte mätas. De ingår i orderns summa men **inte** i täckningsbidraget, och texten säger hur många de är — en saknad kalkyl räknas alltså aldrig som kostnad noll, vilket hade överdrivit marginalen. Saknar samtliga rader kalkyl visas ingen siffra alls.

1. **Skapa kundorder** (på en offert i status Offert eller Order) — skapar en ny kundorder med eget KO-nummer av offertens rader och flyttar dig till orderkortet; se [Offerter](#offerter). Rader kan läggas till (**Lägg till rad** i knappraden), ändras (**Ändra** längst till höger på raden — antal, enhet, á-pris och rabatt) och tas bort (**Ta bort** i radens meny **⋯**, där också **Ändra konfiguration** och **Reklamera** finns) så länge ordern är i status Offert, Order, Bekräftad eller Under tillverkning; antalet kan aldrig sättas under det som redan är levererat, och en rad med levererat gods, en kopplad tillverkningsorder eller historik kan inte tas bort — historik är en leverans som ångrats och en fakturarad, även på en avbruten eller krediterad faktura (*Raden har leveranser (även ångrade) och kan inte tas bort.* respektive *Raden finns på en faktura (även makulerad eller krediterad) och kan inte tas bort.*); kopplingen till tillverkningsordern blockerar borttagning även om tillverkningsordern har avbrutits, men en avbruten TO räknas inte längre med i kolumnen **I tillverkning**.
2. **Starta tillverkning** — markerar att tillverkning pågår. En rad med en tillverkningsartikel kan i stället kopplas till en riktig tillverkningsorder med knappen **Skapa TO** i radens kolumn **I tillverkning** (kräver status Bekräftad eller Under tillverkning) — se [Skapa från kundorder](/hjalp/tillverkning#skapa-fran-kundorder). Det flyttar automatiskt ordern till **Under tillverkning** om den inte redan är det, och kolumnen **I tillverkning** visar sedan det kopplade antalet och, för varje tillverkningsorder, TO-numret som länk och dess status (t.ex. **Frisläppt**, **Pågår**, **Klar**). När raden har en tillverkningsorder men inte är helt täckt står knappen **Skapa TO för resten (N st)** under dem; när tillverkningsordrarna täcker hela radens antal, eller raden är helt levererad, visas ingen knapp — en extra tillverkningsorder skapas då med **+ Ny tillverkningsorder**. På en konfigurerad beställningsvarurad finns knappen också; tillverkningsordern får radens val (se [Tillverkningsorder för beställningsvara](/hjalp/tillverkning#tillverkningsorder-for-bestallningsvara)).
3. **Leverera** — ange rad, lagerplats (förvalet **Automatiskt** tar från artikelns lagerplats och sedan från andra platser med saldo) och antal i dialogen; ett utleveranssaldo bokförs i lagret och en följesedel skapas (se [Följesedel](#foljesedel)). Delleveranser stöds. Hela ordern rapporteras smidigast i rutinen [Utleverans](#utleverans), som nås direkt med knappen **Utleveransrutinen**. En felrapporterad leverans ångras rad för rad (se [Ångra utleverans](#angra-utleverans)); en **Levererad** order går då tillbaka till **Under tillverkning**.
4. **Fakturera** — synlig när ordern är **Levererad**; knappen tar dig till **Försäljning → Fakturor** med skapa-dialogen förifylld på ordern (se [Fakturor](#fakturor)). Har ordern inget levererat kvar att fakturera — oftast för att resten redan ligger på ett fakturautkast — står det överst i dialogen i stället för att ordern kryssas i. Knappen tilldelar inget fakturanummer själv — det sker när fakturan **utfärdas** i fakturamodulen — och ordern blir automatiskt **Fakturerad** först när alla dess rader är fullt fakturerade.
5. **Förlorad…** — bara i status Offert (inte Order); se [Giltighetstid och förlorade offerter](#giltighetstid-och-forlorade-offerter).
6. **Öppna igen** — bara i status Förlorad.
7. **Avbryt order** (på en offert **Avbryt offert**) — möjligt i status Offert och Bekräftad (inte Order), och frågar först eftersom en avbruten order inte kan öppnas igen.

Står en rad öppen i **Ändra** är knapparna i knappraden (**Lägg till rad**, **Skapa kundorder**, **Starta tillverkning**, **Leverera**, **Avbryt order** med flera) spärrade tills du sparat eller avbrutit raden. Ett orört **Á-pris** och en orörd **Rabatt (%)** skickas inte med när du sparar raden: samma antal behåller radens pris och prisursprung, och ett nytt antal prissätts om av priskedjan.

| Status | Betydelse |
|---|---|
| Offert | Ej bekräftad; rader redigerbara |
| Order | Offerten har gett minst en kundorder; fortfarande redigerbar men kan inte förloras eller makuleras |
| Bekräftad | Kundorder |
| Under tillverkning | Tillverkning pågår |
| Levererad | Utlevererad från lager |
| Fakturerad | Avslutad |
| Avbruten | Avbruten |
| Förlorad | Offerten gick inte hem; orsak registrerad, låst som en avbruten |

### Manuell statusändring

Knappen **Ändra status manuellt** längst till höger i orderkortets knapprad låter dig sätta vilken status som helst, åt vilket håll som helst — även från Avbruten eller Fakturerad. Välj status i dialogen och klicka **Byt status**; en bekräftelsedialog visas eftersom ändringen hoppar över orderflödets regler:

- Statusbytet bokför **aldrig** lager — utleveranser som redan är bokförda ligger kvar, och inget levereras ut av att sätta status Levererad.
- Att sätta **Fakturerad** manuellt skapar **ingen** faktura — skapa och utfärda en faktura i fakturamodulen i stället (se [Fakturor](#fakturor)). Äldre ordrar som redan bär ett fakturanummer (fakturerade innan fakturamodulen fanns) behåller det även om statusen backas.

### Revision

Ordern har ett revisionsnummer (**Rev** i orderkortets huvud) som börjar på 1. Varje gång orderns innehåll sparas — ändringar i orderhuvudet (referenser, leveransadress, villkor) och på raderna (lägg till, ändra, ta bort) — ställs frågan **"Ska ordern få en ny revision?"**: **OK** räknar upp revisionen med 1, **Avbryt** sparar ändringen utan att revisionen ändras. Hela orderhuvudet sparas i ett svep, så frågan kommer en gång även om du ändrar flera fält samtidigt. Statusändringar, utleveranser och e-postutskick påverkar inte revisionen. Revisionen skrivs ut direkt efter ordernumret på offerten och orderbekräftelsen (t.ex. **Orderbekräftelse KO-1024 / 2**, inte på fakturan), så mottagaren ser vilken version av ordern de har; utskriften kan stängas av med inställningen **Visa orderns revision på dokument** (se [System](/hjalp/system)).

### Skicka offert och orderbekräftelse via e-post

Orderns detaljsida har en sektion **E-post** längst ner (kräver att SMTP är konfigurerat under [System → Inställningar](/hjalp/system)):

- **Skicka offert** (endast i status Offert) mejlar offerten (med offertnumret) som PDF-bilaga utan att ändra status.
- **Skicka orderbekräftelse** (bara på orderkortet) mejlar orderbekräftelsen som PDF-bilaga utan att ändra status. En offert har ingen orderbekräftelse — skapa först en kundorder med **Skapa kundorder**. Avbrutna ordrar kan inte mejlas.
- Dialogen förifyller **Mottagare** (kundens huvudkontakts e-post; saknas den används en eventuell e-postadress från kundimporten eller en äldre registrering), **Ämne** och **Meddelande** — alla redigerbara. Ämne och meddelande skrivs på kundens språk, se [Dokument på engelska](#dokument-pa-engelska).
- Har någon av orderns artiklar uppladdade ritningar visas kryssrutan **Bifoga ritningar (N filer)**, ikryssad från början — bocka ur den för att bara skicka dokumentet (se fliken Filer i [Artiklar](/hjalp/artiklar)).
- Har ordern konfigurerade rader (se [Beställningsvara](#kundorder)) visas kryssrutan **Visa tilläggspriser** bredvid PDF-länkarna — ikryssad enligt kundkortets inställning **Visa tilläggspriser**. Med kryss skrivs varje vals tillägg ut efter valet, t.ex. *Lock: Lock B (+ 240,00)*; utan kryss bara valet. Valet gäller både **Offert (PDF)**/**Orderbekräftelse (PDF)** och mejlets bilaga, sparas i e-postloggen och används oförändrat av **Skicka om**.
- **Offert (PDF)**, **Orderbekräftelse (PDF)** och **Plocklista (PDF)** (se [Plocklista](#plocklista)) laddar ner dokumenten utan att skicka något; orderbekräftelsen och plocklistan finns bara på orderkortet. Offertens och orderbekräftelsens radtabell har en egen kolumn **Rabatt**; cellen är tom för rader utan rabatt.
- Kortets utskickshistorik visas under knapparna; hela loggen finns i [System → E-postlogg](/hjalp/system).

## Leveranstidskontroll

Leveranstidskontrollen räknar fram den **tidigaste avsändningsdagen** och det **tidigaste leveransdatumet** för en kundorder — utifrån vad som finns i lager, vad som redan är på väg in, ledtiden på material som måste köpas och produktionens lediga tid. Saldo på [spärrade lagerplatser](/hjalp/lager#sparrade-lagerplatser) räknas inte som lager. Den kan köras på en kundorder, på raderna i **Ny kundorder** eller på en fristående sida för artiklar och antal.

Själva kontrollen är en beräkning som läser och räknar — den ändrar ingenting. Datumet sätts, och tillverkningsordrar skapas, först när du själv klickar **Använd datumet** (se [Skapa tillverkningsordrar för det som saknas](#skapa-tillverkningsordrar-for-det-som-saknas)).

### Starta en kontroll

- **På kundorderkortet:** knappen **Leveranstidskontroll** finns när ordern är i status Offert, Bekräftad eller Under tillverkning. Dialogen visar resultatet för orderns rader.
- **I Ny kundorder:** samma knapp räknar formulärets rader (och vald kund) innan ordern är sparad.
- **Fristående:** **Försäljning → Leveranstidskontroll**. Lägg in rader med **Lägg till rad** — artikel och antal; en konfigurerbar mall konfigureras med **Konfigurera**, som på en orderrad — välj om du vill en **Kund** och klicka **Kontrollera**.

Ger [alternativa resurser](/hjalp/artiklar#alternativa-resurser) ett tidigare datum visar dialogen båda datumen och låter dig välja — se [Alternativa resurser i kontrollen](#alternativa-resurser-i-kontrollen).

Knappen **Använd datumet** i dialogen sätter orderns **Förväntat leveransdatum**; i **Ny kundorder** fylls fältet i. Knappen visas bara när kontrollen räknats med en kund — utan kund är datumet avsändningsdagen och dialogen visar i stället texten "Välj kund för att räkna med kundens transportdagar." Raderna på ordern ändras aldrig — har några rader ett [eget leveransdatum](#leveransdatum-per-rad) behåller de det, och dialogen säger hur många de är. Kräver behörigheten Försäljning eller Tillverkning.

### Skapa tillverkningsordrar för det som saknas

Räknade kontrollen med tillverkade artiklar som saknas i lager, visas under resultatet i dialogen på kortet för en **bekräftad** kundorder (eller en order **under tillverkning**) kryssrutan **Skapa tillverkningsordrar för det som saknas (3 st)** — antalet är de tillverkningsordrar som skulle skapas. Den är förvald. Med kryssrutan ikryssad skapar **Använd datumet** tillverkningsordrarna och sätter orderns **Förväntat leveransdatum** i ett svep; avkryssad sätts bara datumet. På en offert, i **Ny kundorder** och på den fristående sidan finns ingen kryssruta — tillverkningsordrar kopplas bara till en bekräftad orders rader.

- Det skapas **en tillverkningsorder per brist-parti på varje nivå** i strukturen: kundorderradens artikel (kopplad till raden, som **Skapa tillverkningsorder** — raden visar därefter **I tillverkning**) och de halvfabrikat som saknas under den (vanliga tillverkningsordrar med noteringen "Skapad från leveranstidskontroll för KO-…"). Antalet är bristen (avrundat enligt artikelns **Avrundning**), färdigdatumet är det datum kontrollen räknade för partiet.
- Ordrarna **planeras i exakt de veckor kontrollen räknade med**, så att det lovade datumet håller kapaciteten — de syns direkt i [Beläggning](/hjalp/tillverkning#belaggning). Halvfabrikaten skapas före sin förälder.
- **Inköp skapas inte.** Material som måste köpas syns i Behovsberäkningen, som skapar inköpsorderna med **Skapa ordrar**.
- Tillverkningsordrarna **låses** i de veckor kontrollen räknade, så att **Planera** i [Beläggning](/hjalp/tillverkning#belaggning) inte flyttar dem — det lovade datumet håller tills någon väljer **Lås upp** på operationen.
- Allt eller inget: går något fel skapas ingen order alls och datumet ändras inte.
- Efter lyckat resultat visar dialogen de skapade tillverkningsordrarna med länkar (till dem du har behörighet att öppna) och orderkortet läses om.
- **Med alternativa resurser:** när kontrollen visade båda datumen och du valt **Med alternativa resurser** byter tillverkningsordrarna resurs på de operationer som lades på ett alternativ. Bytet skrivs på operationen med **Vald för hand**, och veckorna låses tillsammans med resursen, så att **Planera** inte flyttar tillbaka den. Bara de alternativ som behövs för datumet skrivs (se [Alternativa resurser i kontrollen](#alternativa-resurser-i-kontrollen)). Efteråt visar dialogen under varje tillverkningsorder vad som byttes, till exempel *TO-1234: op 20 bytt från 110 till 120 (Vald för hand)*. Operationer på ordinarie resurs påverkas inte. Har beredningen ändrats eller resursen inaktiverats mellan kontrollen och skapandet så att alternativet inte längre finns, skapas ingenting: dialogen visar "Läget har ändrats sedan kontrollen" och byter till den nya kontrollen. Väljer du **Med ordinarie resurser** byts ingen resurs.
- **Läget kan ha ändrats:** har någon annan hunnit boka kapacitet eller skapa en order sedan kontrollen, eller har antalet tillverkningsordrar som skulle skapas ändrats, visas "Läget har ändrats sedan kontrollen — det nya datumet är …" och dialogen byter till den nya kontrollen. Ingenting har skapats — granska resultatet och klicka **Använd datumet** igen.
- **Använd datumet utan tillverkningsordrar** (kryssrutan avkryssad, på en offert eller i **Ny kundorder**) sparar bara datumet, och ingen resurs skrivs. Bygger det valda datumet på alternativ resurs varnar dialogen: *Datumet bygger på alternativ resurs. Tillverkningsordrar som skapas senare planeras på ordinarie resurs — skapa dem här för att hålla datumet.* Tillverkningsordrar som skapas senare får i stället ett förslag i [Beläggning](/hjalp/tillverkning#belaggning).
- Finns det inget att skapa (allt täcks av lager och öppna ordrar) visas ingen kryssruta, och **Använd datumet** sätter bara datumet.

### Alternativa resurser i kontrollen

Har en operation i beredningen [alternativa resurser](/hjalp/artiklar#alternativa-resurser) prövar kontrollen dem när den ordinarie resursen är full. Den räknar två gånger, med alternativ och med bara ordinarie resurser, och använder alternativen **bara när de ger ett tidigare leveransdatum** (eller ett datum där ordinarie resurser inte ger något inom två år). Annars är hela svaret räknat på ordinarie resurser och inget av det som beskrivs här visas.

Alternativen behålls **bara där de behövs för datumet.** Blir en rad klar tidigare på ett alternativ men avgör en annan rad leveransdatumet, räknas raden på ordinarie resurs i stället. Kontrollen prövar varje alternativ i tur och ordning och lägger tillbaka operationen på ordinarie resurs så länge leveransdatumet håller. Det är bara de kvarvarande alternativen som visas och som skrivs på tillverkningsordrarna.

- Överst står en rad som *Leverans 2026-11-12 med alternativa resurser (ordinarie: 2026-11-19)*. Ger ordinarie resurser inget datum inom två år står det *(ordinarie resurser ger inget datum inom två år)*.
- Under raden väljer du datum med två radioknappar: **Med alternativa resurser (2026-11-12)**, som är förvald, och **Med ordinarie resurser (2026-11-19)**. Valet styr vilket datum **Använd datumet** använder, och vilket läge tillverkningsordrarna skapas i. Väljer du **Med ordinarie resurser** visar leveransdatum, avsändningsdag och *Klar* ordinariedatumen; stegen under *Vad som begränsar* visar fortfarande körningen med alternativ.
- I *Vad som begränsar* står resursen på varje operation, och används ett alternativ står det efter resursen, till exempel *BÄNK-1 op 20 Bocka — Kantpress 2 (120) (alternativ till 110, ordinarie v. 49), vecka 46, klar 2026-11-12*. Veckan är den som den ordinarie resursen hade gett. Ryms operationen inte på den ordinarie resursen inom två år står det i stället *(alternativ till 110, ordinarie ger ingen vecka inom två år)*.
- Den fristående sidan och **Ny kundorder** listar bara de två datumen — där finns inget val att göra.

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

**+ Ny faktura**. Välj **Kund** — då visas kundens **Ordrar att fakturera**: kundorder som är (helt eller delvis) levererade och har outfakturerat antal kvar. Kryssa i en eller flera ordrar för att hämta deras rader som en förhandsgranskning, grupperad per ordernummer. Antalet är förifyllt med resten men går att ändra, liksom **À-pris**, **Rabatt %** (förifylld från orderradens rabatt) och **Momskod** — koden är förvald efter kunden och artikeln, se [Momsbehandling](#momsbehandling), men kan ändras per rad (se [Momskod och leveransdatum på raden](#momskod-och-leveransdatum-pa-raden)). Under kundfältet står kundens **Momsbehandling**, och en varning om kundens VAT-nummer väcker någon (se [Momsbehandling](#momsbehandling)). Enskilda rader kan tas bort med **Ta bort**.

Är kunden markerad **Samlingsfaktura** (se [Kunder](#kunder)) visar knappen **Ny faktura** i stället texten "Kunden faktureras med samlingsfaktura." med länken **Öppna Samlingsfakturering** — dialogen spärrar mot att skapa en vanlig faktura för kunden (API:et svarar 409 om det ändå försöks).

Bokade, ofakturerade försändelser för kunden visas som fraktrader i gruppen **Frakt**. De som är i fakturans valuta — den valda ordens valuta, annars kundens — är förbockade från början; frakt i en annan valuta kryssar du i själv, en valuta åt gången, och frakt vars valuta saknar kurs går inte att kryssa i (muspekaren förklarar: *Ingen kurs för EUR — frakten kan inte prissättas i EUR förrän en kurs finns (Ekonomi → Valutakurser)*). Se [Frakt på fakturan](#frakt-pa-fakturan).

Under kunden står fältet **Valuta**. En faktura har **en** valuta: de ordrar du kryssar i (och frakten) avgör den, och med bara fria rader väljer du den själv — förvald är kundens. Ordrar i en annan valuta än de redan valda går inte att kryssa i (muspekaren förklarar: *En faktura har en valuta — välj bara poster i EUR*); fakturera dem på en egen faktura. Kolumnerna heter då **À-pris (EUR)** och **Belopp (EUR)**. Se [Faktura i utländsk valuta](#faktura-i-utlandsk-valuta).

Knappen **Lägg till fri rad** lägger till en rad utan artikelkoppling — **Beskrivning**, **Antal**, **À-pris** och **Momskod** skrivs in för hand (t.ex. frakt eller andra avgifter). Momskoden står som **Automatisk** med namnet på den kod kunden skulle få (t.ex. **Automatisk — Moms 25 %**) tills du väljer en annan.

På ett utkasts kort lägger **Lägg till rad** till en rad med eller utan artikel. Väljer du en artikel visas fältet **Enhet** med artikelns enheter, förvalt på dess försäljningsenhet; **Antal** och **À-pris** anges i den enheten, och raden visas och skrivs ut i den (byter du enhet räknas det du skrivit om, t.ex. 10 st till 2 kartonger). En rad som hämtas från en order har alltid orderradens enhet.

Sökfältet i fakturalistan matchar fakturanummer och kundnamn — både namnet som står på fakturan och kundens nuvarande namn, så en faktura till en kund som bytt namn hittas på båda.

Klicka **Skapa faktura** för att spara som **Utkast**. Fakturan får sitt fakturanummer i FA-serien först när den utfärdas. Under varje fakturarad som är kopplad till en order skriver PDF:en ut "Order KO… · Ert ordernr …" (ordernumret alltid, kundens ordernummer när det finns) — det gäller alla fakturor, inte bara samlingsfakturor. Fria rader får ingen sådan rad.

En fakturarad som hämtats från en konfigurerad orderrad bär en kopia av radens konfiguration: valen skrivs ut under benämningen på fakturan (och på en kreditfaktura som kopierar raden), med tilläggspriserna enligt kundens **Visa tilläggspriser** när fakturan utfärdas — eftersom fakturans PDF arkiveras då ändras utseendet inte efteråt. Samlingsfakturering gör likadant.

### Kostnadsställe och projekt på order och faktura

Finns det kostnadsställen eller projekt (se [Kostnadsställen och projekt](/hjalp/ekonomi#kostnadsstallen-och-projekt)) har kundordern och offerten fälten **Kostnadsställe** och **Projekt** — i **Ny offert**/**Ny kundorder** och under **Ändra** på orderhuvudet — och de visas i orderhuvudet när de är satta. De är förval för fakturaraderna.

På fakturan har varje rad ett kostnadsställe och ett projekt: kolumnen **Kostnadsställe / projekt**, ändringsbara med **Ändra** på raden i ett utkast, och **Kostnadsställe (valfritt)** och **Projekt (valfritt)** i **Lägg till rad**. Båda listorna har valen **Förval** (raden får förvalet nedan) och **Inget** (raden får inget objekt) utöver objekten. Förval för kostnadsstället är orderns **Kostnadsställe** när raden hämtas från en order, annars varugruppens **Kostnadsställe (förval)** (se [Artiklar](/hjalp/artiklar#varugrupper)); förval för projektet är orderns **Projekt**. Objekten bokförs på intäktsraden när fakturan utfärdas, inte på kundfordran eller momsen. Ett stängt projekt kan inte väljas på en ny rad. En kreditfaktura kopierar källradernas objekt som de är, även om ett projekt stängts sedan dess.

### Momskod och leveransdatum på raden

Varje fakturarad har en **Momskod** i stället för en bar momssats. Raderna som hämtas från en order får den kod Nav härleder för kunden och artikeln, se [Momsbehandling](#momsbehandling); en fri rad står som **Automatisk** och får samma härledning när fakturan sparas. I listan finns bara aktiva koder för försäljning (de svenska koderna och försäljningskoderna), och ändrar du raden på fakturakortet — **Ändra** på en rad i ett **Utkast**, eller fältet **Momskod** i **Lägg till rad** — gäller koden du väljer. Momsen räknas på kodens sats; ett EU-företag som valt en 0 %-kod får alltså aldrig svensk moms av misstag. På kortet visar kolumnen **Momskod** kodens namn.

Fakturakortet har kolumnen **Leveransdatum**. Datumet fylls i när raden hämtas från en orderrad: det är den **senaste leveransdagen** för orderraden, utan leveranser som ångrats, och tomt om raden inte levererats. Du kan ändra eller tömma det i **Ändra** på raden eller ange det i **Leveransdatum (valfritt)** i **Lägg till rad**. Har en leverans ångrats (**Ångra…** på kundorderns följesedel) efter att utkastet skapades rättar **Utfärda** datumet: pekar det på en ångrad leverans flyttas det till den senaste kvarstående leveransdagen för orderraden (högst fakturadatumet), eller töms om ingen leverans finns kvar. Ett datum du själv har skrivit in — en dag som aldrig var en leverans av raden — lämnas orört. En kreditfaktura kopierar källradens momskod och leveransdatum. På fakturan skrivs **Levererad ÅÅÅÅ-MM-DD** i radens underrad, bredvid orderreferensen, när datumet skiljer sig från fakturadatumet.

### Köparens momsnummer

Fakturakortet visar **Köparens momsnr** i huvudet, och PDF:en skriver **Ert momsreg.nr** — kundens VAT-nummer som det var när fakturan utfärdades (på ett utkast det nuvarande). En **kreditfaktura** använder i stället momsnumret på fakturan den krediterar — leveransen den ångrar gjordes till det numret, vad kundens nummer är idag — både i huvudet, i kontrollen nedan och när den utfärdas. Momskoderna **Varor till annat EU-land**, **Tjänster till annat EU-land** och **Omvänd betalningsskyldighet, Sverige** kräver att numret finns och har rätt form: för EU-försäljning ett momsnummer från **något annat EU-land än Sverige** (landskoden först, Grekland **EL**, t.ex. DE123456789) — det behöver inte vara kundens eget land; för **Varor till annat EU-land** godtas även ett nordirländskt **XI**-nummer, inte för tjänster — och för omvänd betalningsskyldighet **SE** + tio siffror + **01**. Saknas det eller är det fel varnar ett **utkast** högst upp på kortet — t.ex. *Kunden saknar momsregistreringsnummer — fakturan kan inte utfärdas med EU-försäljning eller omvänd betalningsskyldighet.* — med länken **Öppna kundkortet** (för en kreditfaktura står i stället att den använder den krediterade fakturans nummer); rätta **VAT-nummer** under **Villkor & frakt**. **Utfärda** vägrar så länge felet finns och visar en egen text per fall: *Kunden saknar momsregistreringsnummer — det krävs för EU-försäljning och omvänd betalningsskyldighet*, *Kundens momsregistreringsnummer ska vara ett momsnummer från ett annat EU-land än Sverige, med landskoden först (till exempel DE) — det krävs för EU-försäljning* eller *Kundens momsregistreringsnummer ska ha formen SE + tio siffror + 01 för omvänd betalningsskyldighet*. Fakturan förblir då ett **Utkast** och får inget fakturanummer.

Har EU-försäljningens nummer ett annat landsprefix än kundens **Land** — t.ex. ATU12345678 för en kund i Tyskland — är det tillåtet (artikel 138 kräver köparens momsnummer i en annan medlemsstat, inte att det är adressens land), men ett **utkast** visar en varning högst upp på kortet: *Momsnumret har ett annat landsprefix (AT) än kundens land (DE) — kontrollera att det är rätt.* Varningen hindrar inte **Utfärda** och visas inte tillsammans med ett fel ovan.

Under momssammanställningen på PDF:en skrivs **fakturatexten** för varje momskod som finns på fakturan, en gång per kod — t.ex. *Unionsintern leverans (artikel 138 i mervärdesskattedirektivet)* för **Varor till annat EU-land**, *Omvänd betalningsskyldighet* för **Omvänd betalningsskyldighet, Sverige** och *Momsfri omsättning* för **Momsfri**; texterna ställs in under [Momskoder](/hjalp/ekonomi#momskoder). Momssammanställningen grupperar per momskod, så en 0 %-rad med EU-försäljning och en med momsfritt blir två rader med kodens namn. Varje rad visar också beskattningsunderlaget — t.ex. **Moms (25 %) på 200,00** och **Varor till annat EU-land på 1 000,00** (på engelska *VAT (25%) on 200.00*). Offerten och orderbekräftelsen räknar momsen per rad på samma sätt — en EU-kund ser 0 % redan där — och skriver samma texter. Redan arkiverade fakturor ändras aldrig — bara nya fakturor får texterna.

### Faktura i utländsk valuta

En faktura har en valuta — orderns, eller den du väljer för en faktura med bara fria rader — och står i den: **Nettobelopp**, **Momsbelopp**, **Bruttobelopp**, **Öppet belopp** och betalningarna visas i fakturans valuta (**EUR**), och kolumnerna i radlistan heter **À-pris (EUR)** och **Belopp (EUR)**. Det är fakturans valuta som skrivs ut på PDF:en. Orderrader kan bara hämtas från ordrar i fakturans valuta — försöker du ändå via API:t avvisas det med *Raden är i USD men fakturan är i EUR — en faktura har en valuta*.

**Kurs.** Kursen — kronor per 1 enhet av valutan — sätts på ett av två sätt:

- **Automatiskt vid Utfärda.** Ett utkast i utländsk valuta har ingen kurs än: kortets huvud säger *Kurs: sätts vid utfärdandet*, och bekräftelsedialogen vid **Utfärda** nämner att kursen sätts till fakturadatumets (dagens) kurs. Kursen är Riksbankens senaste dagskurs (senaste bankdag före eller på fakturadatumet) eller en egen kurs från [Ekonomi → Valutakurser](/hjalp/ekonomi#valutakurser). Finns ingen kurs avvisas **Utfärda** med *Ingen kurs för EUR … — ange kursen själv*; skriv då kursen på utkastet.
- **Manuell kurs på utkastet.** I huvudet av ett **Utkast** finns fältet **Kurs (SEK per 1 EUR)**. Skriver du en kurs där gäller den vid **Utfärda** (kortet visar *Kurs: 11,131 (manuell)*); **Använd automatisk kurs** (visas då) och ett tomt fält ger tillbaka den automatiska. Momslagen (mervärdesskattelagen 8 kap. 21 §) kräver kursen när den beskattningsgrundande händelsen inträffar — oftast leveransen, inte alltid fakturadatumet — så skiljer sig leveransdagen från fakturadatumet skriver du in den dagens kurs.

En **kreditfaktura** har alltid **den krediterade fakturans kurs** (fältet visas låst: *En kreditfaktura har alltid den krediterade fakturans kurs*) — krediteringen ska backa exakt det som bokfördes.

**Belopp i SEK.** Under summeringen visar kortet **I SEK med kursen (förhandsvisning)** i ett utkast med kurs — nettobelopp, moms och brutto i kronor — och **Bokfört i SEK** efter **Utfärda**. Saknar utkastet kurs står *SEK-värdena visas när kursen är satt*. Har fakturan svensk moms skrivs momsbeloppet även i kronor på PDF:en, under summorna — *Moms i SEK: 2 782,75 (kurs 11,131000)* — eftersom mervärdesskattelagen (17 kap. 29 §) kräver det oavsett fakturans valuta. I huvudet av en utfärdad faktura står kursen (*Kurs: 11,131 (fakturadatumets)*) och **Öppet belopp** med det bokförda värdet i kronor — *Öppet belopp: 1 000,00 EUR (11 131,00 kr bokfört)*. Fakturalistan visar beloppet i fakturans valuta och, för en utfärdad faktura, kundfordran i kronor under det.

**Bokföring.** Allt bokförs i SEK med fakturans kurs: **Kundfordran** debiteras exakt bruttobeloppet omräknat till kronor och avrundat till öre, momsen och varje rads intäkt får sina egna omräknade belopp, och en eventuell öresdifferens läggs på raden med störst belopp så att verifikatet balanserar. Verifikatets beskrivning får fakturans valuta, belopp och kurs: **Kundfaktura FA-1043 — kundens namn, EUR 1 000,00 à 11,131000**. Fakturan, kundreskontran och betalningarna räknas i fakturans valuta; kronvärdet är det som bokfördes.

**Påminnelseavgift** kan bara läggas på fakturor i **SEK** — avgiften är ett belopp i kronor. På en faktura i utländsk valuta är kryssrutan **Lägg till påminnelseavgift** inaktiv med förklaringen *Påminnelseavgiften är ett belopp i kronor och kan bara tas ut på fakturor i SEK*; en påminnelse utan avgift går att skicka, och via API:t avvisas avgiften med *Påminnelseavgift kan bara tas ut på fakturor i SEK*.

**E-faktura (Peppol)** skrivs i fakturans valuta, med momsen även i SEK när fakturan har svensk moms, se [E-faktura (Peppol)](#e-faktura-peppol).

### Delfakturering

En kundorder behöver inte faktureras i sin helhet på en gång. **Ordrar att fakturera** visar bara det som återstår att fakturera per orderrad: **rest = utlevererat − redan fakturerat** (fakturor i Utkast räknas som fakturerade, så samma rad inte kan hamna på två fakturor samtidigt). Sänk antalet i förhandsgranskningen för att bara fakturera en del av en rad — nästa faktura mot samma order visar då automatiskt vad som återstår. Systemet spärrar mot att fakturera mer än vad som är levererat.

### Samlingsfaktura

Kryssa i flera ordrar samtidigt i **Ordrar att fakturera** (alltid samma kund) för att samla dem på en och samma faktura. Varje order visas som en egen grupp med ordernumret som rubrik i förhandsgranskningen, men resultatet blir en enda faktura med ett fakturanummer.

Kunder med **Samlingsfaktura** ikryssat faktureras i stället via [Samlingsfakturering](#samlingsfakturering).

### Fakturans statusflöde

Statusflödet är **Utkast → Utfärdad → Betald**:

- **Utfärda** (bekräftelsedialog: "Fakturan får nummer och låses") tilldelar fakturanummer ur **FA**-serien (se [System → Nummerserier](/hjalp/system)) och **OCR-nummer**, räknar fram **Förfallodatum** ur betalningsvillkoret och fryser kundens namn, fakturaadress och betalningsvillkor som de såg ut vid utfärdandet — senare ändringar på kundkortet påverkar aldrig en redan utfärdad faktura. Samtidigt **bokförs** fakturan automatiskt, se [Bokföring av fakturan](#bokforing-av-fakturan) nedan. Går bara från **Utkast**, och bara om fakturan har minst en rad. Har du ändrat **Betalningsvillkor**, **Notering** eller **Kurs** utan att klicka **Spara faktura** sparas ändringen först (dialogen säger det), så fakturan utfärdas med det du ser. En rad som står öppen i **Ändra** med osparade ändringar, eller en ifylld rad i **Lägg till rad** som inte lagts till, stoppar **Utfärda** tills du sparat, lagt till eller avbrutit den — annars skulle fakturan utfärdas utan ändringen. Lämnar du kortet med osparade ändringar frågar Nav först.
- **Betald** sätts automatiskt — det finns ingen knapp för det. Så snart en registrerad betalning stänger fakturans öppna post helt (se [Kundreskontra](#kundreskontra) nedan) blir statusen Betald av sig själv, och en makulerad betalning som gjorde detta öppnar fakturan igen till Utfärdad. En kreditfaktura som blir helt kvittad mot en annan post på samma sätt blir Betald.
- **Avbryt faktura** går bara från **Utkast** → Avbruten och frågar först, eftersom en avbruten faktura inte kan öppnas igen — rättelser efter utfärdande görs i stället med en [kreditfaktura](#kreditfaktura).

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

- **Betalningar** — en rad per betalning som rör vid fakturan: **Datum**, **Betalning** (länk till betalningens BET-nummer), **Belopp**, **Avskrivning**, för en faktura i utländsk valuta **Avräknat i SEK** (kronorna raden stängde av det bokförda värdet) och **Verifikat** (länk för den som har behörighet till Ekonomi, annars bara text — en ren kvittning visar **– (kvittning)** i stället). En makulerad betalning märks **· Makulerad** efter BET-numret.
- **Påminnelser** — en rad per skickad betalningspåminnelse: **Nivå**, **Datum**, **Avgift**, **Verifikat** (länk för den som har behörighet till Ekonomi, annars bara text) och **Dokument** — länken **Påminnelse (PDF)** öppnar påminnelsen exakt som den mejlades.
- **Räntefakturerad** — när [Räntefakturering](#rantefakturering) har debiterat ränta eller förseningsersättning på fakturan: en rad per debitering med **Period**, **Dagar**, **Ränta**, **Förseningsersättning** och **Räntefaktura** (länk till räntefakturan). Är räntefakturan makulerad eller helt krediterad märks raden **makulerad** — debiteringen räknas då inte längre och perioden kan faktureras igen.

En räntefaktura själv märks **Räntefaktura** i huvudet, och varje rad visar kontot den bokförs på, t.ex. *Konto 8313* för ränta och *Konto 3990* för förseningsersättning. Raderna har momskoden **Utanför momsens tillämpningsområde** (0 %, ingen momsruta), och fakturan kan krediteras som vilken faktura som helst.

När **Debitera dröjsmålsränta** är på under [Konteringsregler](/hjalp/ekonomi#konteringsregler) och kunden har **Dröjsmålsränta** skriver fakturans PDF under betalningsvillkoren *Vid betalning efter förfallodagen debiteras dröjsmålsränta enligt räntelagen.* Texten finns inte på kreditfakturor, på räntefakturan själv eller på fakturor i annan valuta än SEK (rutinen räntefakturerar bara SEK-fakturor).

#### Arkiverad faktura

En utfärdad faktura (och kreditfaktura) är en verifikation som enligt bokföringslagen ska sparas oförändrad i sju år. Därför sparas fakturans PDF **när den utfärdas**, och **Faktura (PDF)** och **Skicka faktura** använder sedan alltid just den filen — även om företagets uppgifter (adress, bankgiro, logotyp m.m.) ändras senare ser en omutskrift ut precis som originalet. På samma sätt sparas varje skickad betalningspåminnelse som den mejlades. Fakturor som utfärdades innan arkivet fanns sparas första gången de skrivs ut eller mejlas.

Så länge fakturan är **Utfärdad** med ett öppet belopp skiljt från 0 visar kortet knappen **Registrera betalning**, som tar dig till [Kundreskontran](#kundreskontra) med fakturan förvald.

#### Skicka påminnelse

Så länge fakturan är **Utfärdad** med ett öppet belopp **större än 0** visar kortet knappen **Skicka påminnelse**. Dialogen förifyller **Mottagare** (kundens **E-post för faktura**, annars kundens vanliga **E-post**), **Ämne** och **Meddelande** — alla redigerbara — och har kryssrutan **Lägg till påminnelseavgift (X,XX kr)**, där beloppet hämtas från **Ekonomi → Konteringsregler → Kundreskontra → Påminnelseavgift**. Avgiften får bara läggas på **en gång per faktura**: har en tidigare påminnelse redan tagit ut den är kryssrutan avbockad och inaktiv med texten **Avgift redan tillagd**. På en faktura i utländsk valuta är kryssrutan alltid inaktiv — avgiften är ett belopp i kronor och tas bara ut på fakturor i SEK (se [Faktura i utländsk valuta](#faktura-i-utlandsk-valuta)). Har fakturan en debiterad **Förseningsersättning** (se [Räntefakturering](#rantefakturering)) är kryssrutan inaktiv med texten *Förseningsersättning är debiterad på fakturan — påminnelseavgiften ryms i ersättningen* — lagen räknar påminnelseavgiften in i förseningsersättningen, så båda kan inte tas ut. Är dröjsmålsränta på skriver påminnelsens PDF samma villkor som fakturan och, när det finns upplupen ränta, raden *Upplupen dröjsmålsränta t.o.m. [datum]: [belopp] kr* — det är bara information, påminnelsen debiterar inget. Länken **Påminnelse (PDF)** visar exakt det dokument som skulle skickas med kryssrutans nuvarande läge, utan att skicka något — beloppet i förhandsgranskningen är en ögonblicksbild av det öppna beloppet just då, precis som i det skickade mejlets bilaga. Klicka **Skicka** för att mejla påminnelsen och, om ikryssad, bokföra avgiften i samma steg.

**Skicka om** i [E-postloggen](/hjalp/system#e-postlogg) kör om hela påminnelserutinen mot fakturans läge just då och är **alltid avgiftsfri** — den registrerar en ny påminnelse på nästa nivå men lägger aldrig på någon påminnelseavgift. Avgiften kan bara läggas till här på fakturakortet, med kryssrutan.

### E-faktura (Peppol)

Med e-faktura skickas fakturan som ett strukturerat dokument (UBL, Peppol BIS Billing 3) direkt in i kundens ekonomisystem via nätverket Peppol, i stället för som PDF i ett mejl. Nav skickar den genom B2Brouter. Funktionen är avstängd tills en administratör har slagit på den under [System → E-faktura](/hjalp/system#e-faktura). Den gäller företagskunder i Sverige och i andra länder, och fakturor i fakturans egen valuta.

**Det här krävs:**

- E-faktura är **Aktiverad** och ansluten under System → E-faktura, och [Företagsinformation](/hjalp/system#foretagsinformation) har organisationsnummer, VAT-nummer, adress och bankgiro, plusgiro eller IBAN — saknas något står det under **Företagsuppgifter som skickas** på inställningssidan.
- Fakturan är **Utfärdad** eller **Betald** (en kreditfaktura går också att skicka).
- Kunden är ingen **Privatperson**.
- Kunden har ett Peppol-id, eget eller härlett ur organisationsnumret. Nav härleder det för kunder i Sverige (`0007`), Norge (`0192`), Danmark (`0184`) och Belgien (`0208`); i andra länder måste **Peppol-id** fyllas i på kunden (se [Kunder](#kunder)).
- Raderna har momskoder som går att uttrycka i Peppol. En räntefaktura (momskoden **Utanför momsens tillämpningsområde**) kan inte skickas som e-faktura, och export av tjänster (**Tjänster till land utanför EU**) kan inte stå på samma e-faktura som andra momskoder — fakturera tjänsterna för sig.

Saknas något av detta visar sektionen en förklaring i stället för knappen.

**Skicka e-faktura.** Från och med **Utfärdad** har fakturakortet sektionen **E-faktura**. Den visar mottagaren — "Peppol-id 0007:5560000000 (kundens organisationsnummer)" eller "(angivet på kunden)" — och knappen **Skicka e-faktura**. Knappen är den primära när kundens **Fakturaleverans** är **E-faktura (Peppol)**, annars en sekundär knapp: du kan skicka e-faktura till vilken kund som helst som tar emot det. Klicka, bekräfta frågan "Skicka FA-… som e-faktura till …?" och dokumentet byggs, kontrolleras och skickas. En faktura kan bara ha en pågående eller godkänd sändning i taget per miljö — en sandboxsändning hindrar inte den riktiga. Har kunden **E-faktura (Peppol)** som Fakturaleverans visar kortet också en påminnelse vid **Skicka faktura** i sektionen E-post: "Kunden vill ha e-faktura". E-post fungerar fortfarande — Nav hindrar dig inte.

**Automatiskt vid Utfärda.** När **Skicka e-faktura automatiskt vid Utfärda** är på under [System → E-faktura](/hjalp/system#e-faktura) (förvalt) skickas fakturan direkt när du klickar **Utfärda**, om kundens **Fakturaleverans** är **E-faktura (Peppol)**. Det gäller också kreditfakturor och fakturor som samlingsfaktureringens **Utfärda direkt** utfärdar. Fakturan utfärdas alltid — misslyckas sändningen står det på fakturakortet ("E-fakturan kunde inte skickas: …") eller på samlingsfaktureringens resultatrad, och sändningen syns under **Sändningar** som vanligt. Kan fakturan inte skickas alls, till exempel för att kunden saknar Peppol-id, står "Skickades inte som e-faktura: …" med orsaken. Rätta orsaken och klicka **Skicka e-faktura**. Stoppas sändningen innan något skickats (till exempel av kontrollen av e-fakturans innehåll) står det också i fakturans **Historik** som *E-faktura skickades inte*, så att det syns även när resultatet inte lästes. Svarar B2Brouter inte under samlingsfaktureringen väntar Nav inte på det för resten av körningen: de följande fakturorna utfärdas som vanligt, men deras e-fakturor skickas inte. Resultatraden säger "E-fakturan skickades inte: B2Brouter svarade inte tidigare i körningen — skicka den från fakturakortet".

**Utländska kunder och valuta.** E-fakturan skrivs i fakturans valuta, och momskoden avgör hur raden beskrivs i Peppol:

| Momskod | I e-fakturan |
|---|---|
| Moms 25 %, Moms 12 % och Moms 6 % | Moms med satsen |
| Momsfri | Undantagen från moms |
| Omvänd betalningsskyldighet, Sverige, och Tjänster till annat EU-land | Omvänd betalningsskyldighet |
| Varor till annat EU-land | Unionsintern leverans, med leveransdatum och leveransland |
| Export av varor | Export utanför EU |
| Tjänster till land utanför EU | Utanför momsens tillämpningsområde — e-fakturan har då varken ditt eller kundens momsnummer, som Peppol kräver |

Texten efter kategorin är momskodens fakturatext, på engelska när fakturan är på engelska. Leveransdatumet är den senaste leveransdagen bland raderna (annars fakturadatumet) och leveranslandet landet i orderns leveransadress (annars kundens land). Har en faktura i annan valuta än SEK svensk moms står momsen också i SEK, samma belopp som PDF:ens **Moms i SEK**. Till en utländsk kund eller i annan valuta skrivs företagets IBAN som betalningsuppgift i första hand, eftersom bankgiro inte kan betalas från utlandet.

**Statusarna.** Varje sändning loggas under **Sändningar** med tid, status och miljö:

| Status | Betydelse |
|---|---|
| Skickas | Fakturan är lämnad till B2Brouter men har inte nått Peppol än |
| Skickad | Fakturan är skickad in i Peppol-nätet |
| Mottagen | Kundens system har tagit emot fakturan — slutstatus |
| Avvisad | Kundens system eller nätverket avvisade fakturan — feltexten står under statusen |
| Misslyckad | Sändningen gick inte att genomföra — feltexten står under statusen |

Statusen uppdateras automatiskt av ett bakgrundsjobb (intervallet ställs in under System → E-faktura), eller direkt när B2Brouter meddelar en ändring om **Statusbesked direkt** är aktivt där. **Uppdatera status** på en pågående rad hämtar den direkt. Statusen hämtas bara för sändningar i den miljö som är vald under System → E-faktura, eftersom den sparade nyckeln hör till den miljön. En sändning från den andra miljön står kvar som den var tills du byter tillbaka. Länken **UBL** laddar ned exakt det dokument som skickades. Efter **Avvisad** eller **Misslyckad** kan du rätta orsaken — till exempel kundens Peppol-id — och klicka **Skicka igen**.

**Mottagen betyder inte betald.** Statusen säger bara att dokumentet kommit fram. Betalningen registreras som vanligt under [Kundreskontra](#kundreskontra).

**Påminnelser skickas fortfarande med e-post**, se [Skicka påminnelse](#skicka-paminnelse) — de skickas inte som e-faktura. Fakturalistan har kolumnen **E-faktura** med den senaste produktionssändningens status, eller — när bara sandboxsändningar finns — den senaste av dem, märkt "(sandbox)".

**Sandbox.** Är E-faktura inställt på miljön **Sandbox** visar sektionen texten "Sandbox — ingen faktura skickas på riktigt". Det är till för att prova flödet: sändningarna går till B2Brouters testmottagare och loggas som sandboxsändningar — i listan **Sändningar** märkta **Sandbox** i kolumnen Miljö och "(sandbox)" efter statusen. Knapparna **Skicka e-faktura** och **Skicka igen** ser bara till sändningarna i den miljö som är vald just nu.

### Bokföring av fakturan

**Utfärda** bokför fakturan automatiskt — du behöver aldrig knappa in något verifikat för hand. Verifikatet hamnar i serien **F** (Kundfakturor), får fakturadatumet som verifikatdatum och beskrivningen **Kundfaktura FA-… — kundens namn** (för en kreditfaktura: **Kreditfaktura FA-…**). Fakturanumret och verifikatet skapas i ett och samma steg: antingen blir båda av, eller ingetdera.

Konteringen ser ut så här (en faktura i utländsk valuta bokförs på samma sätt i SEK med fakturans kurs, se [Faktura i utländsk valuta](#faktura-i-utlandsk-valuta)):

- **Kundfordran** debiteras med bruttobeloppet (standardkonto **1510 Kundfordringar**).
- **Försäljningsintäkten** krediteras rad för rad, på ett konto som avgörs av radens [momskod](/hjalp/ekonomi#momskoder): först en konteringsregel för radens varugrupp och exakt den momskoden; annars en regel för varugruppen med **Alla momskoder** — men den gäller bara svensk moms och momsfritt, så att en EU-försäljning aldrig hamnar på ett konto med ruta 05; annars kontot på momskoden själv. För svensk moms är det **3001** (**Moms 25 %**), **3002** (12 %), **3003** (6 %) och **3004** (**Momsfri**); för EU-försäljning **3108** (varor) och **3308** (tjänster), export **3105** (varor) och **3305** (tjänster) och omvänd betalningsskyldighet **3231**. Kontona kan ändras under **Ekonomi → Momskoder**.
- **Utgående moms** krediteras per rad på momskodens konto för utgående moms: **2610** (25 %), **2620** (12 %) och **2630** (6 %). En rad med en 0 %-kod ger ingen momsrad alls — och har en 0 %-rad ändå ett momsbelopp avvisas bokföringen.

En **kreditfaktura** bokförs som en spegling av samma konton — kundfordran krediteras, intäkt och moms debiteras. Den är ett eget verifikat, inte en omföring av originalfakturans.

På fakturakortet visas **Verifikat F-…** med en länk till verifikatet (t.ex. **F-2026-12**: serie, räkenskapsår och löpnummer). Numret är en länk för den som har behörighet till [Ekonomi](/hjalp/ekonomi) (administratörer och användare vars behörighetsgrupp ger Ekonomi, se [Behörighetsgrupper](/hjalp/system#behorighetsgrupper)); för andra visas det som text.

**Om bokföringen inte går att genomföra stoppas utfärdandet.** Fakturan förblir då **Utkast**, får inget fakturanummer och inget nummer bränns i FA-serien — nästa faktura fortsätter obruten. Det händer i dessa fall:

- **Bokföringsperioden är låst** för fakturadatumet. Lås upp perioden under **Ekonomi → Räkenskapsår** (**Lås upp period**, motivering krävs) och utfärda igen.
- **Inget räkenskapsår täcker fakturadatumet.** Lägg upp räkenskapsåret under **Ekonomi → Räkenskapsår** först — perioderna skapas automatiskt.
- **Ett konto som konteringen behöver saknas eller är inaktivt** i kontoplanen. Lägg upp eller aktivera kontot under **Ekonomi → Kontoplan** (**Förifyll BAS-urval** lägger in hela standardurvalet på en gång).
- **En rad har moms trots att momskoden är momsfri**, eller en annan sats än momskoden — rätta raden (*Fakturaraden har moms trots att momskoden är momsfri, eller en annan sats än momskoden — rätta raden.*).
- **Köparens momsregistreringsnummer saknas eller har fel form** för en EU-försäljning eller omvänd betalningsskyldighet, se [Köparens momsnummer](#koparens-momsnummer).
- **Fakturans totalbelopp är noll.** Det finns ingenting att bokföra, så fakturan kan inte utfärdas.

### Kreditfaktura

Knappen **Skapa kreditfaktura** på fakturakortet (synlig i status **Utfärdad** eller **Betald**, men inte på en kreditfaktura själv — en kreditfaktura kan inte krediteras igen) skapar en ny faktura av typen **Kreditfaktura** som **Utkast**, förifylld som en spegling av alla den ursprungliga fakturans rader. Du landar direkt på det nya utkastet och kan redigera det precis som vilket annat utkast som helst — ta bort rader eller ändra antal för en delkreditering. Fakturakortet visar **Krediterar faktura FA-…** med en länk till originalfakturan. Krediterar du en faktura i utländsk valuta får kreditfakturan samma valuta och **originalfakturans kurs**, och bokförs i kronor med den. Kreditfakturorna mot en faktura får tillsammans inte överstiga dess belopp inklusive moms: **Utfärda** vägrar en kreditfaktura som skulle göra det (*Kreditfakturorna skulle överstiga beloppet på fakturan de krediterar.*) — det gäller även rader utan orderrad, som en räntefaktura eller en fraktrad. Två kreditutkast av samma faktura går alltså att skapa, men bara så mycket som återstår att kreditera kan utfärdas.

Krediterar fakturan en orderrad som gjorde att ordern blev **Fakturerad**, och krediteringen sänker fakturerat antal under det levererade igen, backar ordern automatiskt till **Levererad** när kreditfakturan **utfärdas** — precis som originalfakturans utfärdande satte den till Fakturerad.

## Samlingsfakturering

**Försäljning → Fakturering → Samlingsfakturering** (`/forsaljning/samlingsfakturering`) samlar fakturering av alla kunder som är markerade **Samlingsfaktura** (se [Kunder](#kunder)) på ett ställe, i stället för att öppna fakturadialogen kund för kund. Begreppen är olika: **Samlingsfaktura** på kundkortet är en egenskap hos kunden, medan [Samlingsfaktura](#samlingsfaktura) i den vanliga fakturadialogen bara betyder att flera ordrar väljs på en faktura — den här rutinen kör i stället regeln automatiskt för alla sådana kunder i ett svep.

Tabellen listar de kunder som har **Samlingsfaktura** ikryssat och samtidigt har levererade men ofakturerade orderrader, med kolumnerna **Kundnr**, **Kund**, **Order** (antal berörda order), **Rader**, **Frakter** och **Belopp exkl. moms**. Finns det kunder med order i annan valuta än SEK tillkommer kolumnen **Valutor** och beloppet heter **Belopp exkl. moms (SEK)** — order i utländsk valuta är omräknade till kronor med orderns kurs. Alla rader är förvalda från början. Kommer du hit via ett orderkorts knapp **Fakturera** är i stället bara den ordens kund vald. På en smal skärm (mobil i stående läge) visas listan som staplade kort utan rubrikrad; då ligger kryssrutan **Välj alla**, antal valda och belopp, **Utfärda direkt** och **Skapa samlingsfakturor** i en rad ovanför listan som följer med när du skrollar.

Kryssrutan **Utfärda direkt** styr vad som händer med fakturorna: ikryssad tilldelas de fakturanummer i FA-serien och bokförs i serie F direkt, precis som en vanlig utfärdad faktura; avbockad skapas de som **Utkast** som du granskar och utfärdar från respektive fakturakort — där går det också att lägga till fria rader, t.ex. en avgift, innan utfärdandet.

**Faktura i vänteläge.** En kund med **Faktura i vänteläge** ikryssat på kundkortet (se [Kunder](#kunder)) får aldrig sin faktura utfärdad av **Utfärda direkt**: fakturan skapas som **Utkast** även när rutan är ikryssad, och resultatraden säger **Utkast — Faktura i vänteläge** så att du ser varför. Övriga valda kunder utfärdas som vanligt. Granska utkastet och utfärda det för hand med **Utfärda** på fakturakortet, som visar noteringen *Kunden har Faktura i vänteläge — granska fakturan innan den utfärdas.* så länge fakturan är ett utkast.

Knappen **Skapa samlingsfakturor** skapar **en faktura per vald kund och valuta**, med alla kundens levererade, ofakturerade rader från samtliga dess order — samma underlag som förslaget i den vanliga fakturadialogen (levererat minus redan fakturerat, utkast inräknade). En faktura har en valuta, så en kund med order i flera valutor — t.ex. SEK och EUR — får en faktura för varje (texten under tabellen påminner om det), med frakten i samma valuta som ordern den hör till. Varje kund hanteras för sig: misslyckas en kund (t.ex. för att bokföringsperioden är låst) visas felet på den raden under **Resultat**, men de andra valda kundernas fakturor skapas ändå.

Frakten från bokade, ofakturerade försändelser tas med automatiskt som fraktrader (kolumnen **Frakter**), se [Frakt på fakturan](#frakt-pa-fakturan).

Resultatet visar en rad per kund — och per valuta när kunden fick flera fakturor, då märkt med valutan, t.ex. *(EUR)* — med status **Utkast**, **Utfärdad**, **Inget att fakturera** (inget levererat och ofakturerat fanns kvar) eller **Misslyckades** (med felmeddelande). Fakturanumret respektive texten Utkast är en länk till fakturakortet. Fakturornas kurs sätts när de utfärdas (eller på utkastet), se [Faktura i utländsk valuta](#faktura-i-utlandsk-valuta). Tabellen uppdateras automatiskt efter körningen.

## Räntefakturering

**Försäljning → Fakturering → Räntefakturering** (`/forsaljning/rantefakturering`) fakturerar **dröjsmålsränta** och **förseningsersättning** på förfallna och sent betalda kundfakturor — en räntefaktura per kund. Rutinen är avstängd från början: sidan säger då *Dröjsmålsränta är avstängd* och länkar till [Konteringsregler](/hjalp/ekonomi#konteringsregler), där **Debitera dröjsmålsränta** slås på (och **Debitera förseningsersättning** om du vill ta ut den).

**Reglerna.** Dröjsmålsräntan är Riksbankens [referensränta](/hjalp/ekonomi#referensranta) för kalenderhalvåret plus **Räntemarginal (procentenheter)** — 8 enligt räntelagen — räknad från dagen efter förfallodagen till betalningsdagen, faktiska dagar delat med 365. Betalas fakturan på förfallodagen är det 0 dagar och ingen ränta; förfaller den 1 september och betalas den 20 september är det 19 dagar, perioden skrivs *2026-09-02–2026-09-20*. Räntan bestäms för varje halvår för sig, så en period som korsar 1 januari eller 1 juli räknas i delar med respektive halvårs ränta, och en inbetalning sänker kapitalet från dagen efter betalningsdagen. Kapitalet är fakturans belopp inklusive moms minus betalningar; påminnelseavgiften räknas inte in. En inbetalning efter att påminnelseavgiften tagits ut betalar först avgiften, och bara resten sänker kapitalet (kostnader före kapital) — betalar kunden 60 kr i avgift och 1 000 kr i kapital vid olika tillfällen löper räntan på 1 000 kr tills kapitalet betalats. En inbetalning samma dag som påminnelsen skickades räknas mot kapitalet. Har kunden en **Avtalad räntesats (%)** på kundkortet används den i stället för referensränta plus marginal. **Förseningsersättning** är lagens fasta 450 kr (inkassokostnadslagen 4 a §) och tas ut en gång per faktura, bara från företag — inte från en **Privatperson** (det är kryssrutans läge på fakturan när den utfärdades som gäller, inte kundkortets i dag) — och bara när fakturan betalats efter förfallodagen eller är förfallen. Har en påminnelseavgift redan tagits ut på fakturan dras den av, så ersättningen blir 450 kr minus avgiften. Ränta och förseningsersättning ligger utanför momsens tillämpningsområde: ingen moms och ingen momsruta.

**Urvalet.** Överst väljer du **T.o.m. datum** (förvalt dagens, aldrig senare — ränta debiteras bara för dagar som har passerat), **Kund** (valfri, förvalt **Alla kunder**) och kryssrutan **Ta med obetalda fakturor** (förvald). Klicka **Visa** för att läsa om listan. Listan tar upp fakturor i SEK till kunder med **Dröjsmålsränta** på. Sent betalda fakturor räknas till betalningsdagen; obetalda räknas till **T.o.m. datum** (bara med **Ta med obetalda fakturor**). Rader utan ränta och utan förseningsersättning visas inte. En räntefaktura är aldrig själv en kandidat.

**Tabellen** har en rad per faktura med kryssruta och kolumnerna **Kund**, **Faktura** (med fakturans brutto), **Förfallodag**, **Betald** (*Obetald* med öppet belopp om den inte är betald), **Period**, **Dagar**, **Räntesats** (*10,00 / 12,00 %* när perioden korsar ett halvårsskifte), **Ränta** och — när **Debitera förseningsersättning** är på — **Förseningsersättning** med en egen kryssruta och beloppet. Raderna är förvalda utom de där räntan ensam är under **Minsta räntebelopp** (märkta *Under minsta belopp*, de går att välja) och de där referensränta saknas (*Saknas* — kryssrutan är inaktiv). Under tabellen visar **Summa per kund** vad varje räntefaktura blir. Är *Referensränta saknas för första halvåret 2026* meddelandet överst: lägg in räntan under [Referensränta](/hjalp/ekonomi#referensranta) och klicka **Visa** igen. Nav försöker själv hämta saknade halvår från Riksbanken när listan öppnas. På en smal skärm ligger **Välj alla**, summan, **Utfärda direkt** och **Skapa räntefakturor** i en rad ovanför listan som följer med när du skrollar.

**Minsta räntebelopp.** Gränsen (förvalt 100 kr, ändras under Konteringsregler) gäller räntan per räntefaktura — summan för kunden bland de markerade raderna, inte varje faktura för sig. Blir kundens ränta lägre skapas ingen räntefaktura för räntan; finns förseningsersättning skapas fakturan ändå med bara ersättningsraden. En kund utan något att fakturera hamnar under **Resultat** som *Inget att fakturera*.

**Skapa räntefakturor.** Kryssrutan **Utfärda direkt** (förval av) styr om fakturorna får fakturanummer och bokförs direkt (serie F) eller skapas som **Utkast**. **Skapa räntefakturor** frågar först om du vill fortsätta och skapar sedan **en räntefaktura per kund** med kundens betalningsvillkor, valutan SEK och noteringen *Räntefaktura*. Fakturadatumet blir dagen fakturan utfärdas, som för alla fakturor — **T.o.m. datum** styr bara ränteperioden. Raderna är *Dröjsmålsränta FA-1234, 2026-09-02–2026-09-20 (19 dagar, 12,00 %)* (flera satser: *10,00/12,00 %*) och *Förseningsersättning FA-1234*, med momskoden **Utanför momsens tillämpningsområde**. Räntan bokförs på kontot **Dröjsmålsränta** (förval 8313 Ränteintäkter från kortfristiga fordringar) och ersättningen på **Förseningsersättning** (förval 3990), båda inställda under Konteringsregler. **Resultat** listar de skapade fakturorna med länk, status och belopp, de kunder som hoppades över och eventuella fakturor som inte kunde utfärdas — de ligger då kvar som utkast med felet angivet.

**Ingen dubbeldebitering.** Varje debiterad period sparas på källfakturan, och nästa körning börjar dagen efter den förra periodens slut — en obetald faktura kan alltså faktureras flera gånger utan att samma dag räknas två gånger, och förseningsersättningen tas ut en gång. Har någon annan debiterat samma faktura sedan din lista hämtades får du *Ränta eller förseningsersättning har redan debiterats … — uppdatera listan och försök igen.* En debitering frigörs när räntefakturan makuleras (utkast), raden tas bort från utkastet eller fakturan krediteras helt; en delkrediterad räntefaktura räknas fortfarande som debiterad. Debiteringarna syns på källfakturan under [Räntefakturerad](#fakturor).

## Kundreskontra

Kundreskontran håller reda på vilka fakturor som fortfarande har ett öppet belopp och registrerar de betalningar som stänger dem.

### Öppna poster

**Försäljning → Öppna poster** listar varje utfärdad faktura och kreditfaktura som fortfarande har ett öppet belopp: **Faktura**, **Kund**, **Typ**, **Förfallodatum** (rött och märkt "förfallen" när datumet har passerat), **Belopp**, **Öppet belopp** och **Påminnelser**. En faktura i utländsk valuta visar beloppen i sin valuta (**1 000,00 EUR**) med fakturans kurs under **Öppet belopp**, och när sidan har sådana poster tillkommer kolumnen **Öppet i SEK** — det bokförda värdet av det som är öppet, den kolumn du summerar. Beloppen i olika valutor läggs aldrig ihop. Filtrera på kund eller kryssa i **Endast förfallna**; sökfältet matchar fakturanummer, OCR-nummer och kundnamn. Klicka på fakturanumret för att öppna fakturakortet.

> Fakturor som markerades som betalda med den gamla knappen **Markera som betald** (innan betalningsregistreringen fanns) syns aldrig här — de har redan status Betald och har inget öppet belopp kvar att bevaka.

### Registrera betalning

**Försäljning → Betalningar** listar alla registrerade betalningar (BET-nummer, datum, kund, belopp, konto, verifikat och status). Knappen **+ Registrera betalning** öppnar registreringsformuläret:

1. Välj **Kund** — kundens öppna poster hämtas in i en tabell nedanför — eller ange kundens **OCR-nummer** under **Hämta via OCR-nummer** och klicka **Hämta** för att slå upp fakturan direkt (kunden väljs automatiskt och fakturan kryssas i).
2. Kryssa i de fakturor betalningen gäller. Varje ikryssad rad visar **Öppet belopp** och ett redigerbart **Belopp**, förifyllt med öppet belopp. Fältet till höger om beloppet visar direkt vad som händer:
   - **Stänger posten** — beloppet matchar öppet belopp exakt.
   - **Stänger posten · avskrivning X,XX kr** — beloppet ligger inom toleransen (se nedan) men matchar inte exakt; mellanskillnaden bokförs som öres-/kronutjämning och posten stängs ändå.
   - **Delbetalning · rest X,XX kr** — beloppet ligger utanför toleransen; posten förblir öppen med resten kvar.
   - **Beloppet överstiger öppet belopp** — beloppet är för högt även med toleransen inräknad; posten kan inte stängas med det beloppet.

   En kreditfaktura har ett negativt öppet belopp — beloppet på dess rad anges också negativt. Står en ikryssad rad på en röd text (**Beloppet överstiger öppet belopp** eller **Beloppet måste ha samma tecken som öppet belopp**) är knappen **Registrera betalning** inaktiv tills beloppet är rättat.
3. Hur mycket en betalning får missa öppet belopp med och ändå räknas som fullt betald ställs in under **Ekonomi → Konteringsregler** som **Betalningstolerans (kr)**.
4. Fyll i **Betalkonto** (förvalt till kontot under Ekonomi → Konteringsregler → **Bank/betalkonto**), **Betalningsdatum** (dagens datum förvalt) och en valfri **Notering**. **Summa** räknas fram automatiskt som summan av de ikryssade radernas belopp — det är detta belopp som bokförs mot betalkontot.
5. För fakturor i utländsk valuta, fyll i **Belopp i SEK (insatt på kontot)** och eventuell **Bankavgift** — se [Betalning i utländsk valuta](#betalning-i-utlandsk-valuta).
6. Klicka **Registrera betalning**.

**Kvittning av kreditfaktura:** kryssar du i poster vars belopp tar ut varandra helt inom samma betalning — till exempel en kreditfakturas negativa belopp mot en vanlig fakturas positiva, utan att någon av raderna hamnar inom toleransen och får en avskrivning — blir betalningens **Summa** 0 och inget verifikat bokförs, eftersom inga pengar har rört sig i banken. Det är en ren kvittning mellan kundens egna poster, och listan visar **—** i kolumnen **Verifikat** för en sådan betalning.

### Betalning i utländsk valuta

En faktura i EUR betalas i EUR: **Belopp** och **Summa** är i fakturans valuta, men banken sätter in kronor på betalkontot. En betalning kan inte blanda valutor — kryssar du i en faktura i EUR går fakturor i andra valutor inte att kryssa i (muspekaren förklarar *En betalning kan inte blanda valutor — välj bara fakturor i EUR*). Toleransen under **Betalningstolerans (kr)** är i kronor och räknas om till fakturans valuta med fakturans kurs. Raden **Öppet belopp** visar fakturans kurs och det bokförda värdet (*kurs 11,131 · 11 131,00 kr bokfört*). Formuläret frågar dessutom efter:

- **Belopp i SEK (insatt på kontot)** — vad som faktiskt kom in på bankkontot i kronor, efter bankens eventuella avgift. Fältet förifylls med kursen för **Betalningsdatum** × beloppet (hjälptexten säger vilken kurs: *Förifyllt med kursen 11,20 för 2026-10-24 × 1 000,00 EUR. Källa: Sveriges Riksbank.* — källtexten står med när kursen är Riksbankens), men det är beloppet på kontoutdraget som ska gälla — **skriv av det därifrån**. Skriver du i fältet slutar Nav att räkna om det. Hittas ingen kurs lämnas fältet tomt med en upplysning. Utan belopp avvisas betalningen (*En betalning i EUR behöver beloppet i SEK som kom in på kontot.*). För en återbetalning (kreditfaktura) är det beloppet som lämnade kontot.
- **Bankavgift** — bankens avgift i kronor, om banken tog en. Den ingår **inte** i beloppet som kom in på kontot och bokförs som **Bankkostnader** i stället för att hamna i kursdifferensen.

Under fälten visar formuläret vad betalningen leder till: **Avräknas mot fordran: 11 131,00 kr (bokfört värde).** och **Kursvinst 31,00 kr** eller **Kursförlust 12,50 kr** (eller **Ingen kursdifferens**). Det är samma uträkning som sparas.

**Bokföring.** Betalningen bokförs i serien **K**, allt i SEK: betalkontot debiteras med **Belopp i SEK**, **Bankavgift** debiteras på **Bankkostnader**, kundfordran krediteras med det bokförda värdet av det som betalas (kronorna fakturan bokades till — en delbetalning tar sin andel och den sista betalningen resten, så en faktura betald i flera delar frigör exakt sin fordran) och skillnaden bokförs som **Kursvinst** (kontot **3960**, när kronorna som kom in — bankavgiften medräknad — överstiger fordran) eller **Kursförlust** (**7960**, när de understiger den). Standardkontona **Kursvinst**, **Kursförlust** och **Bankkostnader** ställs in under [Ekonomi → Konteringsregler](/hjalp/ekonomi#standardkonton). Verifikatets beskrivning får betalningens valuta och belopp: **Betalning BET-… — kundens namn, EUR 1 000,00**.

Efter **Registrera betalning** visar sidan en notis med resultatet — *Betalning BET-12 registrerades — Kursvinst 31,00 kr.* — och betalningskortet visar **Belopp**, **Insatt på kontot**, **Bankavgift** och kursdifferensen, med fakturans kurs och **Avräknat i SEK** per rad. Listan **Betalningar** har kolumnen **Insatt i SEK** när sidan har betalningar i utländsk valuta. En kvittning (**Summa** 0) flyttar inga pengar och tar varken **Belopp i SEK** eller **Bankavgift** — har de kvittade fakturorna olika kurser blir det ändå en kursdifferens, och formuläret visar den.

> **Att betala** på en utskriven betalningspåminnelse är en ögonblicksbild av det öppna beloppet när påminnelsen skrevs ut — kommer det in en delbetalning efteråt utan att en ny påminnelse skrivs ut ändras inte den redan utskrivna PDF:en.

### Makulera betalning

På betalningens detaljsida (klicka på BET-numret i listan) finns knappen **Makulera** under **Åtgärder**, synlig så länge betalningen inte redan är makulerad. En bekräftelsedialog visas eftersom åtgärden bokför en omföring av betalningens verifikat (om den bokförde något) och öppnar de fakturor betalningen stängde igen — de får tillbaka exakt det öppna belopp de hade innan betalningen. En kvittning utan eget verifikat kan makuleras precis som en betalning med bankbelopp; det finns då inget att omföra, bara fakturorna som öppnas igen. En redan makulerad betalning visar statusen **Makulerad** och kan inte makuleras igen. Makuleras en betalning i utländsk valuta bokförs omföringen för hela verifikatet — kursdifferensen och bankavgiften inräknade — och fakturan öppnas igen med sitt bokförda värde.

## Bankfiler (inbetalningar)

Bankens kreditavi (camt.054) innehåller kundernas inbetalningar, t.ex. allt som kommit in på bankgirot under dagen. Under **Försäljning → Bankfiler** väljer du **Läs in bankfil**. Filen sparas som räkenskapsinformation (kan laddas ner igen från filens sida) och visas med en rad per inbetalning. Filens sida visar också vilket **Konto** avin gäller. Är kontot inte något av företagets konton under Företagsinformation (IBAN, bankgiro eller plusgiro) visas en varning — kontrollera då att filen verkligen hör till företaget. Swedbank anger bankkontot bakom bankgirot, så lägg in företagets IBAN under Företagsinformation om varningen gäller det egna kontot.

### Matchning

Varje inbetalning matchas mot de öppna kundfakturorna varje gång sidan visas, så förslagen speglar alltid dagens öppna poster:

- **Matchad** — OCR-numret (eller flera, med egna belopp) pekar på öppna fakturor hos en och samma kund. En inbetalning som inte täcker hela fakturan visas som **Matchad · delbetalning**, och resten står kvar som öppen post.
- **Förslag** — ingen OCR träffade, men beloppet och betalarens namn passar en faktura (*Förslag: belopp + namn*), beloppet är unikt (*Förslag: endast belopp*), eller namnet passar en kund vars öppna poster räcker (*Förslag: namn — fördelning*). Kontrollera och kryssa i själv.
- **Omatchad** — inget passar, eller betalningen kan inte bokföras med reskontrans regler. Orsaken visas, t.ex. *Överbetalning 70,00 kr på FA-5012 — registrera manuellt under Betalningar* eller *OCR 501262 tillhör FA-5012 som redan är betald — möjlig dubbelbetalning*. Det sista betyder att kunden kan ha betalat samma faktura två gånger: återbetala eller hantera den ena utanför Nav och markera posten med **Hanterad utanför Nav**.

Under **Fördelning** väljer du kund och fakturor och ändrar beloppen. Raden visar samma förhandsvisning som **Betalningar** (*Stänger posten*, *Delbetalning · rest …*), och *Fördelat … av …* måste bli exakt inbetalningens belopp innan raden kan bokföras. En ikryssad post som inte kan bokföras säger varför: *Välj kund under Fördelning — posten bokförs inte förrän den har en kund och fakturor*, *Välj fakturor under Fördelning — posten bokförs inte förrän den har fakturor* eller *Fördelningen stämmer inte med beloppet — posten bokförs inte förrän den gör det*; **Bokför valda** bokför då de övriga. En inbetalning kan delas på flera fakturor hos samma kund, och en delbetalning lämnar resten som öppen post.

### Bokför inbetalningar

Matchade poster är förvalda. **Bokför valda** registrerar en betalning per post (serie K) på bankens bokföringsdag, mot betalkontot under Konteringsregler, med tolerans och kvittning precis som under **Betalningar**. Betalningens kort visar *Från bankfil …* med länk tillbaka, och betalningen får sin egen rad i [Händelseloggen](/hjalp/system#handelselogg) precis som en betalning registrerad för hand. En post som inte gick att bokföra (t.ex. för att bokföringsperioden är låst, eller för att fakturan hunnit betalas för hand) får sitt fel på raden och bokförs inte, och de andra bokförs ändå; felet står kvar tills posten byter läge (bokförs eller markeras **Hanterad utanför Nav**). Ett oväntat fel visas som *Ett oväntat fel inträffade — se serverns logg.* Makuleras en sådan betalning senare under **Betalningar** blir posten obokförd igen och kan bokföras mot rätt faktura.

**Hanterad utanför Nav** markerar en post som inte är en kundbetalning (t.ex. en överföring mellan egna konton) och kräver en orsak. **Ångra** tar tillbaka markeringen. **Annan valuta** visas bara för poster på ett **konto i annan valuta än SEK** (Nav hanterar inte valutakonton i banken): de kan inte bokföras här och markeras med **Hanterad utanför Nav**. En inbetalning i utländsk valuta på ditt SEK-konto — kunden har betalat i EUR och banken har växlat — är inte en sådan post: den matchas och bokförs som vilken inbetalning som helst, se [Inbetalningar i utländsk valuta](#inbetalningar-i-utlandsk-valuta). Står en sådan post som **Omatchad** finns ingen faktura i samma valuta som betalningen att knyta den till — registrera den i så fall under **Betalningar**.

### Inbetalningar i utländsk valuta

När kunden betalat en faktura i EUR och banken växlat till kronor anger avin både beloppet som kom in på kontot (**kr insatt på kontot**), det ursprungliga beloppet i EUR, bankens kurs och eventuella avgifter. Posten visar då **1 000,00 EUR** med *11 131,00 kr insatt på kontot*, *Bankens kurs 11,131* och *varav avgifter …* under, och förslaget matchar mot kundens öppna fakturor i EUR **eller** i kronor — OCR-numret som vanligt, annars belopp och namn, där varje faktura jämförs i sin egen valuta (EUR-beloppet mot en EUR-faktura, kronorna som kom in mot en kronfaktura). Har kunden betalat en **kronfaktura** genom att ange ett belopp i EUR bokförs posten som en vanlig betalning med kronorna som kom in på kontot. Pekar OCR-numret på fakturor i olika valutor matchas posten inte på OCR, och en rad under posten säger varför.

Under **Fördelning** bestämmer den första fakturan du kryssar i vilken valuta posten bokförs i: väljer du en EUR-faktura är beloppen i EUR och *Fördelat … av 1 000,00 EUR* måste bli exakt det betalda beloppet; väljer du en kronfaktura fördelas kronorna som kom in. Fakturor i andra valutor går inte att kryssa i, och förhandsvisningen använder toleransen omräknad till EUR med fakturans kurs. En rad under posten förklarar bokföringen: betalningen bokförs mot fakturor i EUR med kontots kronor som SEK-värde och avgiften — den bank som anger en — som **Bankkostnader**; resten är **Kursvinst** eller **Kursförlust** mot fakturans bokförda värde. Anger banken ingen avgift hamnar en eventuell avgift i kursdifferensen. Betalningens kort visar *Från bankfil …* som vanligt, och den bokförs i serie K exakt som en betalning som registrerats för hand i [Betalning i utländsk valuta](#betalning-i-utlandsk-valuta).

### Redan inlästa poster

Samma fil kan läsas in igen utan risk: *Filen är redan inläst*. En fil som delvis överlappar en tidigare (t.ex. dagsslutsfilen efter en intradagsfil) visar *3 poster var redan inlästa och hoppades över* med besked om vilken fil de kom från, tillsammans med filens egna varningar (t.ex. en överhoppad post med status PDNG). Ingen post kan bokföras två gånger, och samma fil kan läsas in från Inköp och Försäljning utan dubbletter.

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
2. Välj **Lagerplats** (gäller hela rapporteringen). Standardvalet **Automatiskt** tar varorna från artikelns egen lagerplats och sedan från andra platser med saldo (se [Uttag med Automatiskt](/hjalp/lager#uttag-med-automatiskt)); väljer du en plats tas allt därifrån. En [spärrad lagerplats](/hjalp/lager#sparrade-lagerplatser) kan inte väljas för uttag, och platsvalet per rad visar den inte.
3. Radtabellen visar **Beställt** (totalt antal på raden), Enhet, **Levererat** och **Rest** (beställt minus levererat, det som återstår att leverera) per rad — allt i radens enhet — och fältet **Leverera nu** är förifyllt med restantalet. Justera antalen — rader som sätts till 0 hoppas över. Antalet räknas om till grundenheten när saldot bokförs. Varje rad har också en egen **Lagerplats**: förvalet **Som ovan** följer fältet **Lagerplats** överst, och i listan finns de platser där artikeln har saldo, med saldot i grundenheten, t.ex. *Huvudlager — A1 (12 st)*. Välj en plats på en rad för att ta just den raden därifrån; övriga rader följer fortfarande fältet överst.
4. Klicka **Rapportera utleverans**. Alla ifyllda rader bokförs tillsammans som **ett leveranstillfälle** — inte en separat bokning per rad — med ett eget **FS-nummer** (en följesedel), och ordern blir **Levererad** när allt är rapporterat. Ett fel visas under knappen **Rapportera utleverans**; gäller det en bestämd rad — en rad som tagits bort, eller en rad där **Leverera nu** överskrider vad ordern tillåter — visas felet i stället under den radens **Leverera nu**. Efter att en försändelse skapats med **Boka transport** ersätts knappen av en länk till försändelsen. Efter en lyckad rapportering visas länkarna **Följesedel FS-N (PDF)** och **Pallkort (PDF)** för att skriva ut leveranstillfällets följesedel respektive pallkort, och **Ångra…** som öppnar dialogen **Ångra utleverans** för följesedeln (se [Ångra utleverans](#angra-utleverans)). En notis nere till höger säger vad som levererades — *Utlevererat 2 rader på KO-5003 — följesedel FS-1012.* — och har samma **Ångra…**.

Enstaka rader kan fortfarande levereras direkt på kundorderkortet med **Leverera** — även det skapar ett eget leveranstillfälle (en följesedel med en rad).

En rad med en **tjänst** levereras utan att något dras från lagret — [tjänster lagerförs inte](/hjalp/artiklar#artikeltyper) — och **Ångra…** räknar bara ned raden.

### Överleverans till kund

Om en kundorderrad får levereras med mer än beställt antal styrs först av kundkortets fält **Överleverans** och annars av systeminställningen **Tillåten överleverans på kundorder (%)** under [System → Inställningar](/hjalp/system#installningar):

- **Systemets förval** (förval på alla kunder) följer inställningen: **0** = aldrig mer än beställt (standard), ett tal = så många procent över, tomt fält = ingen gräns.
- **Tillåt** gäller kundens egen **Tillåten överleverans (%)** — med 10 får en rad på 100 st levereras med högst 110 st totalt; ett tomt fält betyder ingen gräns.
- **Tillåt inte** spärrar överleverans för kunden även om inställningen tillåter den.

Skriv hela det levererade antalet i **Leverera nu** (eller **Antal** i dialogen **Leverera**). Går det över gränsen avvisas leveransen med ett felmeddelande som anger den tillåtna procentsatsen. En överlevererad rad räknas som levererad — ordern blir **Levererad** när alla rader nått sitt beställda antal — och faktureras med det levererade antalet. Radens beställda antal kan inte ändras till mindre än det som levererats, men raden kan fortfarande ändras i övrigt så länge ordern inte är levererad.

### Skanna vid plock

Överst i rutinen finns skanningsfältet (**Skanna kundorder, artikel eller lagerplats…**) — skanna med handskanner eller med knappen **Kamera**, precis som på [Lager → Skanna](/hjalp/lager#skanna). Rutinen fungerar i mobilen, så plocket kan göras med telefonen i handen. Under fältet visas vad den senaste skanningen gjorde; en varning visas i rött (och telefonen vibrerar, där det går).

- **Kundordern** väljer ordern. [Plocklistan](#plocklista) har ordernumret som streckkod uppe till höger, så plocket kan börja med att skanna den. Bara ordrar i status **Under tillverkning** kan väljas ("KO-1003 kan inte levereras — Bekräftad"). Har du redan plockat något på en annan order frågar rutinen först — **Byt order** släpper det plockade.
- **Lagerplatsens etikett** (LP-koden) väljer **Lagerplats** — platsen varorna tas från. En inaktiv plats har inget saldo, och rutinen varnar. En spärrad plats väljs inte — rutinen varnar att uttag inte görs därifrån.
- **Artikeln** — artikelnumret eller **Streckkod (EAN)** — räknar en plockad enhet på artikelns rad, i radens enhet. Den första artikelskanningen nollställer de förifyllda restantalen och raden **Räknar plockade artiklar — rader med 0 levereras inte.** visas, tillsammans med hur många rader som har **Kvar att plocka** (eller **Allt är plockat.**). Tabellen får kolumnen **Kvar att plocka** per rad. Antalen kan rättas för hand (Enter i fältet flyttar tillbaka markören till skanningsfältet), och **Fyll i restantal** går tillbaka till restantalen.
- **Överplock.** Skanningen räknar upp till det beställda antalet plus kundens [tillåtna överleverans](#overleverans-till-kund) — som standard ingen. Över det beställda varnar rutinen ("… — överleverans (tillåten överleverans 10 %)"), och när även gränsen är nådd lägger en skanning inte till något ("Överplock — … är redan plockad (3 av 3 st)"). En artikel som inte finns på ordern eller redan är levererad räknas inte heller.
- **Tjänster och ställkostnader** plockas inte: de raderna behåller sitt restantal när skanningen börjar och följer med leveransen. Skannas en sådan artikel ändå svarar rutinen att antalet skrivs för hand.

**Samma artikel på flera rader.** En artikel får ligga på flera rader på en order eller offert, till exempel när leveransen delas upp på olika datum; **Lägg till rad**, **Ny offert** och **Ny kundorder** visar då notisen *Artikeln finns redan på ordern — den läggs till som en egen rad.* (på en offert: *…på offerten…*), men sparar ändå. Skannas en sådan artikel i **Utleverans** räknas skanningen på raden med **tidigast leveransdatum** först (radens eget datum, annars orderns; rader utan datum sist, sedan radordningen), och först när den är fylld på nästa rad.

Skanna kundordern först — en artikel som skannas innan en order är vald räknas inte. Avsluta med **Rapportera utleverans** som vanligt.

**Varning för beställningsvara.** Levererar du en konfigurerad rad (beställningsvara) mer än tillverkningsordrarna kopplade till raden har färdigrapporterat visas en varning under antalet, både här och i dialogen **Leverera** på orderkortet: *KO-raden har bara X av Y färdigrapporterade*. X är det färdigrapporterade antalet på de kopplade tillverkningsordrarna (Klar eller Avslutad), Y det antal som raden då skulle vara levererad till. Varningen stoppar inte leveransen — mallens lagersaldo är gemensamt och en enhet som byggts fritt får levereras — den påminner bara om att tillverkningen inte hunnit ikapp. Se [Tillverkningsorder för beställningsvara](/hjalp/tillverkning#tillverkningsorder-for-bestallningsvara).

#### Pallkort vid utleverans

Efter en lyckad rapportering öppnas leveransens **pallkort** automatiskt i en ny flik — **en A4-sida per levererad rad**. Kortet är ett inramat kort med svart rubrikband (**PALLKORT** och **TILL KUND**) under företagets logotyp och visar **Artikelnummer**, **Benämning**, **Kund**, **Leveransadress** (när ordern har en vald leveransadress), **Kundens ordernummer** (ett streck när ordern saknar sådant), **Vårt kundordernummer** och det levererade antalet i radens enhet. Längst ner i ramen står **Datum** (leveransens tid) och **Referens** (följesedelns nummer) — utleveransens kort visar inte vem som rapporterade. Allt trycks på övre halvan av arket så det kan vikas på mitten (en streckad viklinje visar var) och läggas på pallen. Beroende på inställningen **Kod på pallkort** (systeminställningen och kundkortets fält) får artikelnumret och vårt ordernummer även en streckkod eller QR-kod.

Behöver du skriva ut igen, eller ett annat antal, klickar du **Pallkort (PDF)** i resultatraden eller **Pallkort** bredvid **PDF** i listan **Följesedlar** på kundorderkortet. Dialogen **Pallkort** visar ett block per levererad rad med **Totalt antal** (förifyllt med levererat antal), **Antal kolli** (förifyllt 1, högst 50; 0 hoppar över raden) och en lista **Kolli 1**, **Kolli 2** … med eget antal per kolli — totalen fördelas jämnt tills du skriver ett antal för hand. Varje kolli blir ett kort som alltid visar vilket kolli det är, t.ex. "Kolli 2 av 3" (även "Kolli 1 av 1" när raden bara får ett kort, också vid den automatiska utskriften). Under listan visar en rad om kollina stämmer med totalen, hur många som är **kvar att fördela** eller **för mycket**, och om något kolli saknar antal (*Varje kolli måste ha ett antal*). **Skriv ut** öppnar PDF:en i en ny flik; knappen är avstängd när alla rader har 0 kolli eller något kolli saknar antal, och även när en rads kolli inte stämmer med dess totalt antal — om inte systeminställningen **Tillåt utskrift av pallkort även om kollina inte stämmer med totalt antal** är på. Tillverkningens pallkort beskrivs i [Tillverkning](/hjalp/tillverkning#pallkort).

### Plocklista

**Plocklista (PDF)** — på utleveransrutinen när en order är vald, och bland PDF-knapparna på kundorderkortet — skriver ut plockunderlaget för ordern:

- Bara rader med kvarvarande antal tas med, och **Att plocka** är restantalet (beställt minus levererat) i radens enhet.
- Kolumnen **Lagerplats (saldo)** visar var artikeln finns och aktuellt saldo per lagerplats — saldona anges i artikelns grundenhet. Artikelns egen lagerplats står först, därefter de övriga platserna i samma ordning som **Automatiskt** tar dem, så att papperet och utleveransen säger samma sak. [Spärrade lagerplatser](/hjalp/lager#sparrade-lagerplatser) listas inte.
- Kolumnen **Plockat** och raden "Plockat av / Datum" fylls i för hand av den som plockar.
- Ordernumret står också som streckkod uppe till höger, så att ordern kan skannas i [Utleverans](#skanna-vid-plock).
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

Har en leverans rapporterats fel kan den ångras i efterhand. På kundorderkortet, i listan **Följesedlar** — eller direkt efter rapporteringen i rutinen [Utleverans](#utleverans) —, öppnar **Ångra…** dialogen **Ångra utleverans** med följesedelns rader (artikel, benämning och levererat antal). Knappen visas bara när ordern är **Under tillverkning** eller **Levererad** och du har behörighet till Försäljning.

- Varje rad ångras för sig med knappen **Ångra** och alltid med hela sitt levererade antal. Du får först en bekräftelsefråga.
- Varorna läggs tillbaka på den lagerplats de togs från. Togs en rad från flera lagerplatser (**Automatiskt**) läggs varje del tillbaka där den togs; dialogen och bekräftelsefrågan säger var, t.ex. *Varorna läggs tillbaka på Huvudlager — A1 (5 st) och Huvudlager — B2 (3 st).* Hade leveransen tömt en tillfällig plats och gjort den inaktiv aktiveras den igen.
- Radens levererade antal på kundordern minskar, och en **Levererad** order går tillbaka till **Under tillverkning**.
- Ångrade rader ligger kvar i dialogen, överstrukna och märkta **Ångrad** med tid och namn.
- När alla rader på en följesedel är ångrade visas följesedeln som **Ångrad** i listan. Den går fortfarande att skriva ut — PDF:en markerar de ångrade raderna och rubriken **Ångrad** — men **Pallkort** och **Boka transport** finns inte längre för den.

En rad kan inte ångras när:

- raden är fakturerad, även på ett fakturautkast — kreditera fakturan eller ta bort utkastet först.
- följesedeln ligger på en försändelse — ta bort den från försändelseutkastet eller avboka försändelsen först.
- ordern har en annan status än **Under tillverkning** eller **Levererad**.
- lagerplatsen är under inventering.
- leveransen gjordes innan funktionen fanns och kunde inte kopplas till sin lagerrörelse (eller sina lagerrörelser). Raden visas då som **Kan inte ångras**.

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
- **Kollin** — ett förslag byggs från artiklarnas kollityp, **Antal per kolli** eller egna mått. Raderna kan ändras (**Kolliart**, **L (cm)**, **B (cm)**, **H (cm)**, **Vikt (kg)**, **Antal**, **Stapelbar**, **Flakmeter**, **Beskrivning**), läggas till med **+ Kolli** och tas bort med ✕. **Föreslå kollin igen** ersätter dina ändringar med ett nytt förslag (bekräftas först) och **Spara kollin** sparar. **Hämta priser** och **Boka vald produkt** frågar Sendify med det som är *sparat* — så länge kollina, mottagaren eller upphämtningen har osparade ändringar är knapparna spärrade och kortet säger vad som behöver sparas först. Varningar visas ovanför tabellen när vikt, mått eller fraktsätt saknas på en artikel. Kolli av typen **Paket** är alltid stapelbara (Sendifys regel) — kryssrutan **Stapelbar** är ikryssad och låst för dem.

### Hämta priser och boka

1. Klicka **Hämta priser**. Dialogen **Priser** visar en rad per transportör och produkt med **Transportör**, **Produkt**, **Pris**, **Kundpris**, **Ledtid (dagar)**, **Upphämtning** och **Beräknad leverans**. Eventuella varningar visas under tabellen. Bara priser i SEK kan bokas direkt; övriga valutor visas som **Bara SEK**. Ändrar någon annan försändelsen medan priserna hämtas sparas inga priser utan meddelandet **Försändelsen ändrades under prishämtningen — hämta priser igen** visas.
2. Klicka **Boka** på önskad rad för att boka direkt, eller **Spara val** för att spara produkten och boka senare. Den valda produkten markeras med **(valt)**.
3. Har du sparat ett val bokas det med **Boka vald produkt**. Då hämtas nya priser, och har priset ändrats mer än gränsen **Bekräfta prisändring över (%)** (se [Fraktinställningar](/hjalp/system#fraktinstallningar)) visas dialogen **Priset har ändrats** med sparat och nytt pris — **Boka ändå** bokar till det nya priset. Ett prisförslag som hunnit gå ut hämtas om automatiskt.

Medan bokningen pågår visas **Bokning pågår…**.

Svarar Sendify inte på bokningen, eller går svaret inte att läsa, visas *Sendify svarade inte på bokningen. Bokningen kan ha genomförts – kontrollera i Sendify innan du försöker igen.* Försändelsen står kvar som **Utkast**, men transporten kan ändå vara bokad hos Sendify: kortets historik får raden **Bokningen kan ha genomförts hos Sendify — kontrollera där** med försändelsens Sendify-id och den valda produkten. Kontrollera i Sendify innan du bokar igen, annars kan samma gods bokas två gånger.

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

Under radtabellen och täckningsbidraget visas sedan raden **Fraktprodukt: {transportör} · {produkt} (offererat {pris})** med den valda produkten och Sendifys pris vid prisfrågan. Priset är en uppskattning och har ingen giltighetstid i systemet: fraktraden behåller det offererade kundpriset tills du klickar **Lägg till frakt** igen, och vid bokningen hämtas alltid nya priser hos Sendify.

När ordern är bekräftad och utlevererad skapas försändelsen med **Boka transport** som vanligt — den får orderns fraktprodukt förvald och det offererade priset som sparat val, så **Boka vald produkt** fungerar direkt. Har priset hunnit ändras mer än gränsen **Bekräfta prisändring över (%)** visas dialogen **Priset har ändrats** med offererat och nytt pris, och **Boka ändå** bokar till det nya priset. Fraktraden på ordern ändras inte av bokningen. Samlastas flera följesedlar i en försändelse är det den första ordern i listan vars produkt förväljs.

### Sandlådan och begränsningar

I Sendifys sandlåda fungerar full bokning bara med DHL, UPS och DSV. Mot produktion gäller alla transportörer ni har avtal med.

Ingår inte i den här versionen: ombud/utlämningsställen och tull.

### Spårning

Försändelsekortet har sektionen **Spårning** med senaste status från transportören, händelselistan och **Senast kontrollerad**. Statusarna visas på svenska (t.ex. **Beställd**, **Under transport**, **Levererad**, **Avvikelse**) och tider i svensk tid. Länken till transportörens spårning ligger på **Fraktsedelsnr** i sektionen **Frakt**. Status hämtas automatiskt: systemet kontrollerar var femte minut vilka försändelser som är på tur och kör enligt **Spårningsintervall** under **System → Frakt** (**Varje timme**, **Var fjärde timme** eller **Dagligen**). Under inställningen visas **Senaste spårningskörning**. Knappen **Uppdatera spårning** på kortet hämtar status direkt. Försändelser som bokades för mer än 60 dagar sedan spåras inte automatiskt (knappen fungerar fortfarande).

Meddelar transportören ett undantag, t.ex. försenat eller skadat gods, markeras statusen med rött på kortet och i kolumnen **Spårning** i försändelselistan. Rapporterar transportören att godset levererats får försändelsen status **Levererad** och kortet visar **Levererad** med leveransdatum.

### Frakt på fakturan

En bokad försändelse som ännu inte fakturerats föreslås som fraktrad i fakturadialogen (se [Skapa en faktura](#skapa-en-faktura)). Raden hamnar i gruppen **Frakt** och består av fraktartikeln (**Fraktartikel** under **System → Frakt**), antal 1 och försändelsens kundpris i fakturans valuta — på en faktura i SEK är det **Kundpris (kr)** rakt av, på en faktura i annan valuta räknas kronpriset om med orderns kurs (en försändelse utan order med dagens kurs); priset går att ändra. Raden är förbockad från början när försändelsen är i den valuta fakturan får — den valda ordens valuta, annars kundens; frakt i en annan valuta kryssar du i själv, en valuta åt gången, och frakt vars valuta saknar kurs går inte att kryssa i förrän en kurs finns under **Ekonomi → Valutakurser**. Avbockas raden följer ingen frakt med. Har någon av orderna bakom försändelsen redan en rad med fraktartikeln (se [Frakt på offert och order](#frakt-pa-offert-och-order)) föreslås ingen fraktrad, så frakten faktureras inte två gånger. Spärren gäller åt andra hållet också: när försändelsens fraktrad ligger på en faktura vägrar **Lägg till frakt** på ordern med **Frakten för ordern är redan fakturerad via försändelse FR-… — ingen fraktrad läggs till**. Samlingsfaktureringen tar med frakten automatiskt och visar antalet i kolumnen **Frakter**.

En fraktrad tas bort genom att kryssrutan under **Frakt** avmarkeras. Benämning och pris på fraktraden kan ändras fritt; antalet är alltid 1. Är ingen fraktartikel vald under **System → Frakt** kan frakt inte faktureras.

Fakturakortet visar länken **Försändelse FR-…** till försändelsen, och försändelsekortet visar raden **Faktura** (fakturanumret, **Utkast** eller **Ej fakturerad**). Makuleras ett fakturautkast frigörs frakten och kan faktureras igen; en kreditfaktura frigör den inte. Medan en försändelse avbokas hos Sendify kan dess frakt inte läggas på en faktura; försök igen när avbokningen är klar.

### Förvald fraktprodukt

På kundkortets flik **Villkor & frakt** finns **Förvald fraktprodukt** (visas när frakten är aktiverad under **System → Frakt**). En ny försändelse får produkten som valts på ordern ([Frakt på offert och order](#frakt-pa-offert-och-order)) i första hand, annars kundens förvalda produkt — utan Sendifys pris, som hämtas vid bokningen. Därefter bokas den direkt med **Boka vald produkt**.
