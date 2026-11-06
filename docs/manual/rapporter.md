# Rapporter

**Rapporter** i Nav|ERP:s huvudmeny samlar de analyserande rapporterna. Hela avsnittet kräver rättigheten **Rapporter** i användarens behörighetsgrupp (administratörer har den alltid) — menyposten syns inte för andra, se [Behörighetsgrupper](/hjalp/system#behorighetsgrupper). Alla rapporter är härledda ur befintliga order-, faktura- och tillverkningsdata i det ögonblick de visas; ingenting lagras separat.

Statistikrapporterna filtreras med ett månadsintervall (**Från månad** / **Till månad**); utan val visas de senaste tolv månaderna inklusive innevarande. Orderförteckningarna har egna urval med datum, se nedan. Varje rapport har **Exportera CSV** — se [Exportera till Excel (CSV)](#exportera-till-excel-csv).

## Orderförteckning

**Rapporter → Orderförteckning kundorder** och **Rapporter → Orderförteckning inköp** listar ordrarna med **Ordervärde** och **Restvärde** — som en rad per order, eller med kryssrutan **Visa rader** som order med sina rader (artikel, antal, **Levererat**/**Mottaget**, rest, à-pris, belopp, restbelopp och leveransdatum).

Urvalet:

- **Datum avser** — **Orderdatum** (dagen ordern skapades) eller **Leveransdatum**, med **Från** och **Till**. Leveransdatum är radens eget datum, annars orderns; på inköpsordrar går **Bekräftat leveransdatum** före **Önskat leveransdatum**, samma regel som planeringen använder. Tomma datum = inget datumurval.
- **Kund** / **Leverantör**, **Status** (förvalt **Öppna ordrar**: Offert, Bekräftad och Under tillverkning för kundordrar; Utkast, Bekräftad och Delvis mottagen för inköpsordrar), **Varugrupp**, **Artikelkod** och **Artikel**.
- **Bara rader med rest** — bara rader som inte är fullt levererade eller mottagna.

Urvalet gäller **orderraderna**: leveransdatum, artikel, varugrupp, artikelkod och rest väljer rader, och en order visas med de rader som kom med — dess ordervärde och restvärde summerar bara dem. Ordrar utan rader visas inte.

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

### Gruppera per motpart

Urvalet **Gruppera** väljer mellan **Månad** (som ovan) och **Motpart**. Med **Motpart** visas en rad per kund (under **Kundordrar**) respektive leverantör (under **Inköpsordrar**) med kolumnerna **Order**, **I tid**, **Sena**, **Precision** och **Snittförsening** samt kvalitetskolumnerna ur [avvikelserna](/hjalp/kvalitet):

- **Avvikelser** — antal ärenden av motsvarande typ (kundreklamationer för kunder, leverantörsavvikelser för leverantörer) med rapporteringsdatum i perioden. Makulerade räknas inte.
- **Order med avvikelse** och **Andel felfria** — av motpartens mätta ordrar, hur många som har ett kopplat ärende och andelen som saknar ett.
- **Reklamerat antal** — summan av ärendenas antal. Har ärendena olika enheter går de inte att summera: kolumnen visar **—**, och klickar du på den ser du antalet per artikel.
- **Avvikelsekostnad** — ärendenas nettokostnad (bara för den som får se priser).

**Exportera CSV** följer valet.

## Försäljningsstatistik

**Rapporter → Försäljningsstatistik** summerar fakturerad nettoomsättning ur kundfakturorna (status **Utfärdad** eller **Betald**; utkast och makulerade räknas inte). Kreditfakturor dras av. Gruppera per **Månad** (fakturadatum), **Kund** eller **Artikel** — varugrupperingen visar även fakturerat antal, och fritextrader utan artikel samlas under **(Fritextrader)**.

## Inköpsstatistik

**Rapporter → Inköpsstatistik** summerar leverantörsfakturorna (status **Attesterad** eller **Betald**). Per **Månad** och **Leverantör** summeras fakturornas **nettobelopp från huvudet** — det är fakturans facit. Per **Artikel** summeras i stället radbeloppen; eftersom huvudbeloppet matas från pappersfakturan kan artikeluppdelningens summa avvika från huvudtotalerna, vilket sidan påpekar. Rader utan artikel samlas under **(Rader utan artikel)**.

## Kassationsstatistik

**Rapporter → Kassationsstatistik** summerar kassationerna från tillverkningens avrapporteringar. Gruppera per **Månad**, **Artikel** (tillverkningsorderns artikel), **Resurs** eller **Orsak**. Kolumnerna visar **Antal kasserade** och **Antal rapporter**.

Orsaken är den som valts ur [Kvalitetsorsaker](/hjalp/kvalitet#kvalitetsorsaker) vid avrapporteringen, så gruppen följer orsakens namn. Äldre kassationer som rapporterades med fritext grupperas på exakt text och märks **(fritext)** — "Materialfel (fritext)" och "materialfel (fritext)" blir två rader. Installationer utan kassationsorsaker fortsätter med fritext.

## Kalkylutfall

**Rapporter → Kalkylutfall** ställer kalkylen mot utfallet per tillverkningsorder, i två vyer som du väljer med **Vy**: **Mot förkalkyl** (förval) och **Avvikelseanalys**. Valen ligger i adressen (`?view=&groupBy=&from=&to=`), så vyn går att spara som bokmärke. Intervallet filtrerar på efterkalkylens datum. Varje vy har egen **Exportera CSV** med samma val.

### Mot förkalkyl

Varje order med en sparad [efterkalkyl](/hjalp/tillverkning#efterkalkyl) jämförs med sin senaste efterkalkyl. En förkalkyl sparas däremot på artikeln, inte på ordern (se [Artiklar](/hjalp/artiklar#kalkyl)), så ordern jämförs med artikelns **senaste förkalkyl som sparades före efterkalkylen** — den kalkyl som gällde när ordern efterkalkylerades. En förkalkyl som sparas senare ändrar alltså inte utfallet för en order som redan är efterkalkylerad, och två ordrar på samma artikel kan jämföras mot olika förkalkyler. Tas den förkalkyl bort som en order jämfördes mot, jämförs ordern i stället med närmast tidigare förkalkyl.

Tillverkningskostnaden (TVK — utan TO-påslag, som ligger utanför tillverkningskostnaden) jämförs **per styck**. **Avvikelse %** är efterkalkylens styck-TVK mot förkalkylens; rapportens nyckeltal är snittavvikelsen. Kolumnerna är **Förkalkyl TVK/st**, **Kalkylerat TVK/st**, **Efterkalkyl TVK/st**, **Avvikelse/st** och **Avvikelse %**:

- **Kalkylerat TVK/st** är orderns egen kalkyl (se [Avvikelseanalys](/hjalp/tillverkning#avvikelseanalys)) per inlevererat antal, och binder ihop vyerna: Förkalkyl → Kalkylerat → Efterkalkyl. Kolumnen är **—** på en order som inte är klar eller vars efterkalkyl sparades före avvikelseanalysen.
- **Nämnaren.** När efterkalkylens analys är slutlig räknas kostnad per styck på **inlevererat antal**, inte på orderns antal; under **Antal** står då *inlev.* med det antalet. En order som stängdes på 8 av 10 visar alltså kostnaden per levererad enhet. Är ordern **Ej klar**, eller saknar efterkalkylen analys, räknas styck-TVK på orderns antal som förut.
- **Ej klar** märker en order som inte är avslutad (Frisläppt eller Pågår). Dess efterkalkyl är preliminär, så avvikelsen visar pågående arbete och inte ett utfall.
- **konfiguration** märker en [beställningsvara](/hjalp/tillverkning#tillverkningsorder-for-bestallningsvara). Den jämförs mot konfigurationens kostnad från kundorderraden, inte mot mallartikelns förkalkyl. Den kostnaden är räknad i flera nivåer, så samma förbehåll som för flernivå gäller.
- **flernivå** märker en förkalkyl som gjordes med **Räkna om underliggande nivåer**: den räknar halvfabrikaten till deras egen tillverkningskostnad medan efterkalkylen tar det pris de levererades in till, så en stor avvikelse där kan bero på metoden snarare än på tillverkningen.

Under tabellen redovisas ordrar som **ej jämförbara**:

- **utan jämförbar förkalkyl** — artikeln hade ingen sparad förkalkyl när efterkalkylen sparades, eller konfigurationens kostnad går inte att räkna fram.
- **med ogiltigt antal** — förkalkylen eller efterkalkylen har antalet 0.
- **utan inlevererat antal** — efterkalkylens analys är slutlig men inget levererades (ordern stängdes på 0 eller makulerades), så det finns ingen enhet att dela kostnaden på.

En förkalkyl utan efterkalkylerad order räknas inte någonstans; den hör till artikeln och gör ingen order ojämförbar. TO-numret länkar till orderkortet.

### Avvikelseanalys

**Avvikelseanalys** summerar orderns [avvikelse mot kalkylerat](/hjalp/tillverkning#avvikelseanalys) över alla ordrar vars senaste efterkalkyl ligger i intervallet. Välj **Gruppera** per **Order**, **Artikel** eller **Resurs**. Plus betyder dyrare än kalkylerat och minus billigare; beloppen är röda respektive gröna, men tecknet står alltid i talet.

Fyra rutor överst gäller alla analyserade ordrar, oavsett gruppering: **Total avvikelse** (med procent mot kalkylerat), **Pris**, **Mängd** (med *varav kassation*) och **Tid**. Pris + Mängd + Tid + Påslag är exakt Total avvikelse; **Påslag** (som följer av material och lego) står som en rad under rutorna när det inte är noll. *Varav kassation* ingår i Mängd och läggs inte till en gång till — den kan vara större än Mängd när resten av mängden ligger under plan.

- **Order** och **Artikel** visar **Inlevererat**, **Kalkylerat**, **Utfall**, **Avvikelse**, **Avvikelse %**, **Pris**, **Mängd** (med *varav kassation* under beloppet), **Ställ**, **Stycke**, **Ej uppdelad** och **Påslag**. Per artikel finns dessutom **Antal TO**, och Inlevererat är summan över ordrarna. **Timpris** visas bara när något skiljer sig: den är skillnaden mellan timkostnaden de dagar tiden arbetades och timkostnaden när ordern skapades. **Ställ** och **Stycke** visas bara när någon rad har tid som registrerats uppdelad; annars visas **Ej uppdelad**, där hela tidsavvikelsen ligger. Raden **Totalt** summerar tabellen.
- **Resurs** visar bara operationerna, eftersom material och påslag inte hör till någon resurs. Varje resurs får en rad per slag, **Tid** eller **Lego**; en resurs som byter slag mellan två ordrar får alltså två rader. En tidsresurs visar **Planerad ställ (h)**, **Planerad stycke (h)**, **Ej uppdelad (h)**, **Rapporterat (h)** och **Tidsavvikelse (kr)** (verklig ställ- och stycktid visas när tiden är registrerad som **Ställ** och **Produktion**, se [Tidrapporter](/hjalp/tillverkning#tidrapporter); annars står de som **—**). En operation där bara en del av tiden har typ räknas med alla sina timmar under **Ej uppdelad (h)**, eftersom hela dess tidsavvikelse ligger under Ej uppdelad; timmarna och kronorna går då att stämma av mot varandra. **Tidsavvikelse (kr)** är Timpris, Ställ, Stycke och Ej uppdelad tillsammans. En legoresurs visar **Kalkylerat**, **Utfall**, **Pris** och **Mängd**, med kalkylerat och mottaget antal under beloppen.

Under tabellen står räknarna **N analyserade ordrar**, **N preliminära (Ej klar)** och **N utan analys**. De två sista ingår inte i summorna: en preliminär order är inte färdig, och en efterkalkyl som sparades före avvikelseanalysen har ingen bas att räknas mot (efterkalkylera ordern och spara igen för att få den). En order räknas i den månad då dess *senaste* efterkalkyl sparades, och aldrig i två perioder. Rapporten har ingen PDF — tabellen är för bred för A4 — men CSV-filen innehåller alla kolumner, med *varav kassation* som egen kolumn.

## Marginal

**Rapporter → Marginal** visar **täckningsbidraget** på fakturerad omsättning, grupperat per **Månad**, **Kund** eller **Artikel**. Underlaget är fakturaraderna (utfärdade och betalda fakturor), så nettoomsättningen stämmer med [Försäljningsstatistiken](#forsaljningsstatistik); kreditfakturor räknas med omvänt tecken.

Självkostnaden hämtas från artikelns **senaste sparade förkalkyl**, självkostnaden per styck. Två saker följer av det, och båda syns i rapporten:

- **Det är dagens kostnadsläge tillämpat på historisk omsättning.** Rapporten säger alltså inte vad marginalen *var* då fakturan skrevs, utan vad samma affär skulle ge med den kalkyl som gäller nu.
- **Rader vars artikel saknar förkalkyl kan inte mätas.** De räknas med i **Nettoomsättning** men inte i **Självkostnad** eller **TB**, och kolumnen **Utan kalkyl** visar hur många de är. En saknad kalkyl behandlas alltså aldrig som kostnad noll — det hade överdrivit marginalen. Saknar en grupp kalkyl helt visas **—** i stället för en siffra. Fakturarader utan artikel (fritextrader) hamnar under **Utan artikel** vid gruppering på artikel.

För en beställningsvara räknas TB mot konfigurationens förkalkyl från kundorderraden, inte mot mallartikelns egen kalkyl; går konfigurationens kostnad inte att räkna fram hamnar raden under **Utan kalkyl**.

Kolumnerna är **Nettoomsättning**, **Självkostnad**, **TB** (täckningsbidrag), **TG** (täckningsgrad i procent, mot den omsättning som har en kalkyl) och **Utan kalkyl**. Negativ täckningsgrad tonas rött. Rapporten kan exporteras som CSV, där totalraden ingår.

## Produkter i arbete

**Rapporter → Produkter i arbete** visar värdet av de tillverkningsordrar (TO) som är öppna ett visst datum — det som bokslutet bokför som produkter i arbete (PIA). Välj **Datum** (förval i dag) och **Underlag** och klicka **Visa**; **Skriv ut** ger samma rapport som PDF. Valen ligger i adressen (`?asOf=&basis=`), så vyn går att spara som bokmärke. Rapporten kräver administratörsrollen.

Varje rad är en TO med kolumnerna **TO** (länk till orderkortet), **Artikel**, **Inlevererat** (till exempel *0 av 10*), **Upparbetat**, **Avräknat** och **PIA**. Kryssrutan **Visa kostnadsslag** lägger till **Material**, **Lön**, **Lego** och **Påslag** (Påslag bara med Tillverkningskostnad) före **Upparbetat**; valet ligger i adressen som `?kostnadsslag=1`. **Upparbetat** är det som lagts ner på ordern per datumet; **Avräknat** är det som ordern redan har tagit in i lager; **PIA** är skillnaden. Sist står en summarad.

- **Vad som räknas.** En TO räknas om den är öppen per datumet och har upparbetat något eller tagit in något i lager. En TO som var **klar** per datumet ingår inte; dess skillnad är en avvikelse i resultatet, inte en tillgång. Klar betyder att ordern hade avslutats med **Slutför** (och det inte var ångrat då) eller att allt orderantal var inlevererat per datumet. Ångras en inleverans senare så att ordern öppnas igen, räknas den från dagen för ångrandet. En stängd TO som avslutades med ett mindre antal innan rapporteringsloggen fanns räknas aldrig. Material räknas per uttagsdatum, lön på **arbetsdagen** tiden gäller (inte dagen den registrerades) till resursens timkostnad den dagen, och lego på inleveransen från legoleverantören.
- **Makulerad TO.** En makulerad TO räknas som andra ordrar för datum före makuleringen. Från makuleringsdagen räknas den inte: uttag och inleveranser måste ha ångrats för att ordern ska kunna makuleras, och tid som rapporterats på den är en kostnad, inte en tillgång.
- **Underlag.** **Tillverkningskostnad** tar med **Påslag** (material- och legopåslag, samma uppbyggnad som ett standardpris); **Direkta kostnader** är bara material, lön och lego, och kolumnen **Påslag** (under **Visa kostnadsslag**) döljs. TO-påslaget (resursens omkostnad) ingår aldrig. Med **Direkta kostnader** avräknas de inlevererade varorna ändå till lagerpriset, så sätt då standardpriserna på samma sätt — annars blir skillnaden mellan upparbetat och avräknat missvisande.
- **Avräknat** är det pris varorna hade när de kom in i lager, så en senare ändring av standardpriset flyttar inte det som redan är avräknat. En inleverans som har ångrats räknas bara för datum före ångrandet.
- **PIA blir aldrig negativ per TO.** Överstiger avräknat upparbetat — oftast för att tid inte är rapporterad än — räknas PIA som 0, raden märks ▼ och rapporten visar notisen *Avräknat överstiger upparbetat — PIA räknas som 0*.
- **Inlevererat utan pris.** Saknar en inleverans pris vet rapporten inte vad som är avräknat: raden visar **ovärderad**, ingår inte i summan och notisen *N ordrar har inlevererat utan pris och räknas inte* visas. Pristexter från efterkalkylen (till exempel saknade priser) visas under notiserna.
- **Ångrad rapportering försvinner även bakåt.** Ångras en tidrapportering som gällde ett tidigare datum försvinner den också ur rapporten för det datumet, eftersom ångrad tid raderas. Uttag, inleveranser och legoinleveranser som ångrats räknas däremot kvar för datum före ångrandet.
- **Timkostnad per dag.** Lönen räknas som i efterkalkylen: varje arbetsdags timmar till den timkostnad resursen hade den dagen (se [Resurser](/hjalp/tillverkning#resurser)). En timkostnad som ändras efter datumet flyttar därför inte PIA per datumet, och ett bokfört bokslutssteg blir inte inaktuellt av den. Tid som rapporteras i efterhand för en dag före datumet ändrar däremot PIA.

Pågående tillverkning bokförs i årsbokslutet av steget [Produkter i arbete](/hjalp/ekonomi#produkter-i-arbete-i-bokslutet).

## Projektrapport

**Rapporter → Projektrapport** visar **intäkter**, **kostnader** och **resultat** för ett projekt ur bokföringen. Välj **Projekt** (öppna och stängda), och ange vid behov **Från** och **Till** — lämnas de tomma gäller hela projektets bokföring, och texten under nyckeltalen visar då det första och sista bokförda datumet (eller *alla datum* om projektet inte har några bokförda rader än). Filtren ligger i adressen, så vyn går att spara som bokmärke.

Under de tre nyckeltalen visas projektet **per månad** (**Intäkter**, **Kostnader**, **Resultat**), **per konto** och **Kundordrar på projektet** — de kundordrar som har projektet i sitt huvud (offerter, förlorade offerter och makulerade order räknas inte), med status och värde, klickbara till ordern. Siffrorna är de bokförda verifikatrader som bär projektet; hur projekt sätts på rader beskrivs under [Kostnadsställen och projekt](/hjalp/ekonomi#kostnadsstallen-och-projekt). **Exportera CSV** ger samma rapport. Rapporten kräver rättigheten **Rapporter**.

## Lagervärde

Lagervärdesrapporten är [Lagervärdering](/hjalp/lager#lagervardering) under Lager — Rapporter-sidan länkar dit för administratörer, som är de enda som kan öppna den.

## Exportera till Excel (CSV)

Alla registerlistor (artiklar, ordrar, fakturor, saldon m.fl.) har knappen **Exportera CSV** i verktygsraden — den exporterar **hela** listan med aktuella filter (sök, status osv.), oavsett sidindelning. Även ekonomirapporterna (balans- och resultaträkning, huvudbok, verifikatlista) och rapporterna ovan har **Ladda ner CSV**/**Exportera CSV**.

Filerna är gjorda för svensk Excel: semikolon som avgränsare, decimalkomma och UTF-8 med BOM — dubbelklicka bara på filen så hamnar kolumnerna rätt. En export är begränsad till **10 000 rader**; större uttag avvisas med ett felmeddelande — avgränsa med filter och exportera i delar.
