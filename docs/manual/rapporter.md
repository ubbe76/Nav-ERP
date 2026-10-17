# Rapporter

**Rapporter** i huvudmenyn samlar de analyserande rapporterna. Hela avsnittet kräver rättigheten **Rapporter** i användarens behörighetsgrupp (administratörer har den alltid) — menyposten syns inte för andra, se [Behörighetsgrupper](/hjalp/system#behorighetsgrupper). Alla rapporter är härledda ur befintliga order-, faktura- och tillverkningsdata i det ögonblick de visas; ingenting lagras separat.

Rapportsidorna filtreras med ett månadsintervall (**Från månad** / **Till månad**); utan val visas de senaste tolv månaderna inklusive innevarande. Varje rapport har **Exportera CSV** — se [Exportera till Excel (CSV)](#exportera-till-excel-csv).

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

## Marginal

**Rapporter → Marginal** visar **täckningsbidraget** på fakturerad omsättning, grupperat per **Månad**, **Kund** eller **Artikel**. Underlaget är fakturaraderna (utfärdade och betalda fakturor), så nettoomsättningen stämmer med [Försäljningsstatistiken](#forsaljningsstatistik); kreditfakturor räknas med omvänt tecken.

Självkostnaden hämtas från artikelns **senaste sparade förkalkyl**, självkostnaden per styck. Två saker följer av det, och båda syns i rapporten:

- **Det är dagens kostnadsläge tillämpat på historisk omsättning.** Rapporten säger alltså inte vad marginalen *var* då fakturan skrevs, utan vad samma affär skulle ge med den kalkyl som gäller nu.
- **Rader vars artikel saknar förkalkyl kan inte mätas.** De räknas med i **Nettoomsättning** men inte i **Självkostnad** eller **TB**, och kolumnen **Utan kalkyl** visar hur många de är. En saknad kalkyl behandlas alltså aldrig som kostnad noll — det hade överdrivit marginalen. Saknar en grupp kalkyl helt visas **—** i stället för en siffra. Fakturarader utan artikel (fritextrader) hamnar under **Utan artikel** vid gruppering på artikel.

För en beställningsvara räknas TB mot konfigurationens förkalkyl från kundorderraden, inte mot mallartikelns egen kalkyl; går konfigurationens kostnad inte att räkna fram hamnar raden under **Utan kalkyl**.

Kolumnerna är **Nettoomsättning**, **Självkostnad**, **TB** (täckningsbidrag), **TG** (täckningsgrad i procent, mot den omsättning som har en kalkyl) och **Utan kalkyl**. Negativ täckningsgrad tonas rött. Rapporten kan exporteras som CSV, där totalraden ingår.

**Rapporter → Kalkylutfall** ställer förkalkyl mot efterkalkyl per tillverkningsorder: senaste förkalkylen jämförs med senaste efterkalkylen, och tillverkningskostnaden (TVK) jämförs **per styck** — för- och efterkalkylens antal kan skilja. **Avvikelse %** är efterkalkylens styck-TVK mot förkalkylens; rapportens nyckeltal är snittavvikelsen. Ordrar med enbart förkalkyl eller enbart efterkalkyl redovisas som ej jämförbara. Intervallet filtrerar på efterkalkylens datum. TO-numret länkar till orderkortet.

## Lagervärde

Lagervärdesrapporten är [Lagervärdering](/hjalp/lager#lagervardering) under Lager — Rapporter-sidan länkar dit för administratörer, som är de enda som kan öppna den.

## Exportera till Excel (CSV)

Alla registerlistor (artiklar, ordrar, fakturor, saldon m.fl.) har knappen **Exportera CSV** i verktygsraden — den exporterar **hela** listan med aktuella filter (sök, status osv.), oavsett sidindelning. Även ekonomirapporterna (balans- och resultaträkning, huvudbok, verifikatlista) och rapporterna ovan har **Ladda ner CSV**/**Exportera CSV**.

Filerna är gjorda för svensk Excel: semikolon som avgränsare, decimalkomma och UTF-8 med BOM — dubbelklicka bara på filen så hamnar kolumnerna rätt. En export är begränsad till **10 000 rader**; större uttag avvisas med ett felmeddelande — avgränsa med filter och exportera i delar.
