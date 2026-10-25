# Rapporter

**Rapporter** i Nav|ERP:s huvudmeny samlar de analyserande rapporterna. Hela avsnittet kräver rättigheten **Rapporter** i användarens behörighetsgrupp (administratörer har den alltid) — menyposten syns inte för andra, se [Behörighetsgrupper](/hjalp/system#behorighetsgrupper). Alla rapporter är härledda ur befintliga order-, faktura- och tillverkningsdata i det ögonblick de visas; ingenting lagras separat.

Statistikrapporterna filtreras med ett månadsintervall (**Från månad** / **Till månad**); utan val visas de senaste tolv månaderna inklusive innevarande. Orderförteckningarna har egna urval med datum, se nedan. Varje rapport har **Exportera CSV** — se [Exportera till Excel (CSV)](#exportera-till-excel-csv).

## Orderförteckning

**Rapporter → Orderförteckning kundorder** och **Rapporter → Orderförteckning inköp** listar ordrarna med **Ordervärde** och **Restvärde** — som en rad per order, eller med kryssrutan **Visa rader** som order med sina rader (artikel, antal, **Levererat**/**Mottaget**, rest, à-pris, belopp, restbelopp och leveransdatum).

Urvalet:

- **Datum avser** — **Orderdatum** (dagen ordern skapades) eller **Leveransdatum**, med **Från** och **Till**. Leveransdatum är radens eget datum, annars orderns; på inköpsordrar går **Bekräftat leveransdatum** före **Önskat leveransdatum**, samma regel som planeringen använder. Tomma datum = inget datumurval.
- **Kund** / **Leverantör**, **Status** (förvalt **Öppna ordrar**: Offert, Bekräftad och Under tillverkning för kundordrar; Utkast, Bekräftad och Delvis mottagen för inköpsordrar), **Artikelgrupp** och **Artikel**.
- **Bara rader med rest** — bara rader som inte är fullt levererade eller mottagna.

Urvalet gäller **orderraderna**: leveransdatum, artikel, artikelgrupp och rest väljer rader, och en order visas med de rader som kom med — dess ordervärde och restvärde summerar bara dem. Ordrar utan rader visas inte.

Värdena räknas per rad: antal × à-pris med radens rabatt (kundorder) och ställpriset (inköp; ställpriset räknas som rest tills något på raden är mottaget). Inköpsordrar i annan valuta visas i sin valuta; summorna överst och på utskriften är omräknade till SEK med orderns växelkurs. Antal och à-pris visas i radens enhet.

**Skriv ut** öppnar förteckningen som PDF (liggande A4) med urvalet i rubriken, och **Exportera CSV** ger samma urval som fil — med **Visa rader** en rad per orderrad med orderns uppgifter upprepade, så att den går att filtrera i Excel. Ett urval med fler än 10 000 orderrader avvisas; avgränsa då med datum, status eller kund/leverantör.

## Offertuppföljning

**Rapporter → Offertuppföljning** visar hur stor andel av offerterna som blir order. Urvalet är **Från** och **Till** (förval innevarande år) på dagen offerten skapades, och valfritt en **Kund**; alla val ligger i adressen så att urvalet går att spara eller skicka vidare.

Överst står nyckeltalen **Offerter**, **Vunna**, **Förlorade**, **Öppna** (med antalet utgångna), **Makulerade**, **Hit rate (antal)** och **Hit rate (värde)**. Därunder kommer tabellerna **Per kund** (störst offererat värde först), **Per månad**, **Per förlustorsak** (antal, värde och andel av de förlorade; offerter förlorade utan orsak står som *Ingen orsak angiven*) och **Offerter** med varje offert: offertnummer (länkat till offertkortet; vunna offerter visar även det KO-nummer de fick), kund, skapad, giltig t.o.m., utfall, orsak och värde. **Exportera CSV** ger offertlistan.

Definitionerna:

- **Vunnen** är en offert som blivit bekräftad, under tillverkning, levererad eller fakturerad. **Förlorad** är en offert med status Förlorad. **Öppen** är en offert som fortfarande är offert, varav **Utgången** när **Giltig t.o.m.** har passerat. **Makulerad** är en avbruten offert.
- **Hit rate (antal)** = vunna / (vunna + förlorade). **Hit rate (värde)** räknas på samma sätt med vunnet och förlorat värde. Öppna och makulerade offerter räknas inte; finns varken vunna eller förlorade visas **–**.
- **Värde** är radernas nuvarande värde (antal × à-pris minus rabatt) exklusive moms, i SEK. En offert vars rader har ändrats efter att den vanns visar alltså det nya värdet.
- En order skapad med **+ Ny kundorder** är ingen offert och ingår inte. Statistiken gäller offerter som var öppna när funktionen infördes och offerter som skapats efter det; äldre ordrar går inte att avgöra och räknas inte.
- Ett urval med fler än 10 000 offerter avvisas; korta ned perioden eller välj en kund.

## Leveransprecision

**Rapporter → Leveransprecision** mäter hur väl lovade leveransdatum hålls, för kundordrar och inköpsordrar var för sig.

- **Kundordrar**: ordern räknas när den är **Levererad** eller **Fakturerad**. Utlovat datum är orderns **Förväntat leveransdatum** (dagen kunden får varan — även för kunder med [transportdagar](/hjalp/forsaljning#leveransdagar)); faktiskt datum är det **sista leveranstillfällets** datum. Leverans samma dag som utlovat räknas **i tid**.
- **Inköpsordrar**: ordern räknas när den är **Mottagen** eller **Stängd** och har minst en inleverans. Faktiskt datum är den sista inleveransens datum.
- **Precision** = andelen ordrar i tid av de mätbara; **Snitt försening** räknas enbart över de försenade ordrarna.
- **Ej mätbara** redovisas separat: ordrar utan förväntat leveransdatum, och äldre kundordrar som levererades innan leveranstillfällen infördes (de saknar leveransdatum i systemet).
- Delvis levererade ordrar syns inte förrän de är färdiglevererade — rapporten mäter hela ordern mot dess sista leverans.

## Försäljningsstatistik

**Rapporter → Försäljningsstatistik** summerar fakturerad nettoomsättning ur kundfakturorna (status **Utfärdad** eller **Betald**; utkast och makulerade räknas inte). Kreditfakturor dras av. Gruppera per **Månad** (fakturadatum), **Kund** eller **Artikel** — artikelgrupperingen visar även fakturerat antal, och fritextrader utan artikel samlas under **(Fritextrader)**.

## Inköpsstatistik

**Rapporter → Inköpsstatistik** summerar leverantörsfakturorna (status **Attesterad** eller **Betald**). Per **Månad** och **Leverantör** summeras fakturornas **nettobelopp från huvudet** — det är fakturans facit. Per **Artikel** summeras i stället radbeloppen; eftersom huvudbeloppet matas från pappersfakturan kan artikeluppdelningens summa avvika från huvudtotalerna, vilket sidan påpekar. Rader utan artikel samlas under **(Rader utan artikel)**.

## Kassationsstatistik

**Rapporter → Kassationsstatistik** summerar kassationerna från tillverkningens avrapporteringar. Gruppera per **Månad**, **Artikel** (tillverkningsorderns artikel), **Resurs** eller **Orsak**. Kolumnerna visar **Antal kasserade** och **Antal rapporter**.

Orsaken är fritext från avrapporteringen och grupperas på exakt text — "Materialfel" och "materialfel" blir två rader. Skriv orsaker konsekvent för användbar statistik.

## Kalkylutfall

**Rapporter → Kalkylutfall** ställer förkalkyl mot efterkalkyl per tillverkningsorder. Varje order med en sparad [efterkalkyl](/hjalp/tillverkning#efterkalkyl) jämförs med sin senaste efterkalkyl. En förkalkyl sparas däremot på artikeln, inte på ordern (se [Artiklar](/hjalp/artiklar#kalkyl)), så ordern jämförs med artikelns **senaste förkalkyl som sparades före efterkalkylen** — den kalkyl som gällde när ordern efterkalkylerades. En förkalkyl som sparas senare ändrar alltså inte utfallet för en order som redan är efterkalkylerad, och två ordrar på samma artikel kan jämföras mot olika förkalkyler. Tas den förkalkyl bort som en order jämfördes mot, jämförs ordern i stället med närmast tidigare förkalkyl.

Tillverkningskostnaden (TVK — utan TO-påslag, som ligger utanför tillverkningskostnaden) jämförs **per styck** — förkalkylens och efterkalkylens antal kan skilja. **Avvikelse %** är efterkalkylens styck-TVK mot förkalkylens; rapportens nyckeltal är snittavvikelsen. En förkalkyl som gjordes med **Räkna om underliggande nivåer** märks **flernivå** på raden: den räknar halvfabrikaten till deras egen tillverkningskostnad medan efterkalkylen tar det pris de levererades in till, så en stor avvikelse där kan bero på metoden snarare än på tillverkningen.

Under tabellen redovisas ordrar som **ej jämförbara**:

- **utan jämförbar förkalkyl** — artikeln hade ingen sparad förkalkyl när efterkalkylen sparades, eller ordern är en [beställningsvara](/hjalp/tillverkning#tillverkningsorder-for-bestallningsvara), vars förkalkyl hör till konfigurationen och inte till mallartikeln.
- **med ogiltigt antal** — förkalkylen eller efterkalkylen har antalet 0.

En förkalkyl utan efterkalkylerad order räknas inte någonstans; den hör till artikeln och gör ingen order ojämförbar. Intervallet filtrerar på efterkalkylens datum, både för tabellen och för de ej jämförbara. TO-numret länkar till orderkortet.

## Marginal

**Rapporter → Marginal** visar **täckningsbidraget** på fakturerad omsättning, grupperat per **Månad**, **Kund** eller **Artikel**. Underlaget är fakturaraderna (utfärdade och betalda fakturor), så nettoomsättningen stämmer med [Försäljningsstatistiken](#forsaljningsstatistik); kreditfakturor räknas med omvänt tecken.

Självkostnaden hämtas från artikelns **senaste sparade förkalkyl**, självkostnaden per styck. Två saker följer av det, och båda syns i rapporten:

- **Det är dagens kostnadsläge tillämpat på historisk omsättning.** Rapporten säger alltså inte vad marginalen *var* då fakturan skrevs, utan vad samma affär skulle ge med den kalkyl som gäller nu.
- **Rader vars artikel saknar förkalkyl kan inte mätas.** De räknas med i **Nettoomsättning** men inte i **Självkostnad** eller **TB**, och kolumnen **Utan kalkyl** visar hur många de är. En saknad kalkyl behandlas alltså aldrig som kostnad noll — det hade överdrivit marginalen. Saknar en grupp kalkyl helt visas **—** i stället för en siffra. Fakturarader utan artikel (fritextrader) hamnar under **Utan artikel** vid gruppering på artikel.

För en beställningsvara räknas TB mot konfigurationens förkalkyl från kundorderraden, inte mot mallartikelns egen kalkyl; går konfigurationens kostnad inte att räkna fram hamnar raden under **Utan kalkyl**.

Kolumnerna är **Nettoomsättning**, **Självkostnad**, **TB** (täckningsbidrag), **TG** (täckningsgrad i procent, mot den omsättning som har en kalkyl) och **Utan kalkyl**. Negativ täckningsgrad tonas rött. Rapporten kan exporteras som CSV, där totalraden ingår.

## Projektrapport

**Rapporter → Projektrapport** visar **intäkter**, **kostnader** och **resultat** för ett projekt ur bokföringen. Välj **Projekt** (öppna och stängda), och ange vid behov **Från** och **Till** — lämnas de tomma gäller hela projektets bokföring, och texten under nyckeltalen visar då det första och sista bokförda datumet (eller *alla datum* om projektet inte har några bokförda rader än). Filtren ligger i adressen, så vyn går att spara som bokmärke.

Under de tre nyckeltalen visas projektet **per månad** (**Intäkter**, **Kostnader**, **Resultat**), **per konto** och **Kundordrar på projektet** — de kundordrar som har projektet i sitt huvud, med status och värde, klickbara till ordern. Siffrorna är de bokförda verifikatrader som bär projektet; hur projekt sätts på rader beskrivs under [Kostnadsställen och projekt](/hjalp/ekonomi#kostnadsstallen-och-projekt). **Exportera CSV** ger samma rapport. Rapporten kräver rättigheten **Rapporter**.

## Lagervärde

Lagervärdesrapporten är [Lagervärdering](/hjalp/lager#lagervardering) under Lager — Rapporter-sidan länkar dit för administratörer, som är de enda som kan öppna den.

## Exportera till Excel (CSV)

Alla registerlistor (artiklar, ordrar, fakturor, saldon m.fl.) har knappen **Exportera CSV** i verktygsraden — den exporterar **hela** listan med aktuella filter (sök, status osv.), oavsett sidindelning. Även ekonomirapporterna (balans- och resultaträkning, huvudbok, verifikatlista) och rapporterna ovan har **Ladda ner CSV**/**Exportera CSV**.

Filerna är gjorda för svensk Excel: semikolon som avgränsare, decimalkomma och UTF-8 med BOM — dubbelklicka bara på filen så hamnar kolumnerna rätt. En export är begränsad till **10 000 rader**; större uttag avvisas med ett felmeddelande — avgränsa med filter och exportera i delar.
