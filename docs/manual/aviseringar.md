# Aviseringar

Aviseringar samlar det som behöver åtgärdas just nu: försenade ordrar, negativa saldon, förfallna fakturor och utskick som misslyckats. Sidan finns under menyvalet **Aviseringar** direkt under **Översikt**, och en sammanfattning med antalet per typ visas på Översikten i kortet **Att bevaka**.

## Aviseringarna försvinner av sig själva

En avisering lagras aldrig. Den är en fråga mot nuläget som ställs varje gång du öppnar sidan eller Översikten. När ordern levereras, fakturan betalas eller saldot fylls på försvinner den. Det finns därför inget att kvittera eller dölja.

## Typerna

Typerna grupperas per område (se [Sidan Aviseringar](#sidan-aviseringar)) och står i fast ordning inom området: röda före gula. Inom en typ står det äldsta eller mest akuta först.

| Typ | Färg | Urval |
|---|---|---|
| **Utgångna batcher** | röd om utgången, annars gul | Batcher med saldo på ospärrade lagerplatser vars utgångsdatum har passerat eller infaller inom så många dagar som inställningen **Batcher som går ut inom (dagar)** (förval 30). Raden länkar till [Spårbarhet](/hjalp/lager#utgangsdatum-och-fefo). |
| **Negativt saldo** | röd | Artikelns totala saldo över alla lagerplatser är mindre än 0. Raden visar artikelnummer, benämning och saldo. |
| **Förfallna kundfakturor** | röd | Utfärdad kundfaktura med belopp kvar att betala och ett förfallodatum som har passerat. |
| **Leverantörsfakturor att betala** | röd om förfallen, annars gul | Attesterad leverantörsfaktura med belopp kvar att betala och förfallodatum senast om så många dagar som inställningen **Leverantörsfakturor att betala inom (dagar)** anger (förval 7). Fakturor som ligger i en pågående betalningsomgång tas inte med, eftersom de redan är på väg att betalas. |
| **Offerter att följa upp** | röd om utgången, annars gul | Offert (status Offert) vars **Giltig t.o.m.** har passerat eller infaller inom så många dagar som inställningen **Offerter att följa upp inom (dagar)** anger (förval 7). Raden visar *Gick ut 2026-10-15* eller *Går ut 2026-10-24 (om 3 dagar)* och länkar till offertkortet; listan är [Offerter](/hjalp/forsaljning#offerter) filtrerad på status Offert. Offerter utan giltighetstid tas inte med. |
| **E-fakturor som inte gick fram** | röd | Fakturor vars senaste sändning i produktion misslyckades eller avvisades och som inte har någon pågående sändning. Sändningar i sandlådan räknas aldrig. |
| **Utskick som misslyckades** | röd | Mejl med status **Misslyckat** de senaste 14 dagarna, utan ett senare lyckat utskick av samma dokument. Testmejl räknas inte. Bara administratörer ser typen. |
| **Tillägg som inte tar emot händelser** | röd | Tillägg som har misslyckade leveranser de senaste 7 dagarna utan en lyckad leverans efter det. Raden länkar till [Tillägg](/hjalp/tillagg#leveranser-och-felsokning). Bara administratörer ser typen. |
| **Återkommande verifikat som misslyckats** | röd | En rad för **varje** månad som en återkommande post inte kunde skapa och som ännu inte rättats — till exempel en låst period (i läget Bokför direkt) eller ett inaktiverat konto i mallen — med orsaken. Månader som hoppats över medan posten var pausad räknas inte. Raden länkar till [Återkommande verifikat](/hjalp/ekonomi#aterkommande-verifikat), där **Kör nu** försöker igen; aviseringen försvinner när månaden skapats eller posten tagits bort. |
| **E-postlådan för fakturor kunde inte läsas** | röd | E-postlådan som läses av [Fakturaskanning](/hjalp/system#fakturaskanning) har inte gått att läsa vid senaste körningen. Raden visar orsaken och länkar till inställningssidan, där **Testa anslutning** kan hjälpa. Aviseringen försvinner när en körning lyckas. Bara administratörer ser typen. |
| **Fakturor i inkorgen att granska** | gul | Fakturor i [Fakturainkorgen](/hjalp/inkop#fakturainkorg) som är **Ny**, **Tolkad** eller **Osäker**, alltså de som visas under **Att granska**. Raden länkar till inkorgen. Menyn **Inköp** krävs. |
| **Avvikelser som passerat Åtgärd senast** | gul | Öppna [avvikelser](/hjalp/kvalitet) (**Registrerad** eller **Utreds**) där **Åtgärd senast** har passerat, äldsta först. Raden visar numret, rubriken, datumet och motparten och länkar till avvikelsen; listan är avvikelserna med rutan **Försenade** ibockad. |
| **Försenade kundordrar** | gul | Order med status bekräftad eller under tillverkning där en rad med rest har ett leveransdatum som har passerat. Offerter och levererade ordrar räknas aldrig. **Öppna listan** öppnar [Kundorder](/hjalp/forsaljning#kundorder) filtrerad på **Sen**, som använder samma regel. |
| **Försenade inköpsordrar** | gul | Order med status utkast, bekräftad eller delvis mottagen där en rad med rest har ett ankomstdatum som har passerat. Bekräftat leveransdatum gäller före önskat. **Öppna listan** öppnar [Inköpsorder](/hjalp/inkop#inkopsorder) filtrerad på **Sen**. |
| **Sena tillverkningsordrar** | gul | Tillverkningsordrar som är Frisläppta eller Pågår som är **Sena** enligt produktionsplaneringen, alltså samma **Sen** som tillverkningsorderlistan och tillverkningsordern visar. **Öppna listan** öppnar listan filtrerad på **Sen**. |
| **Behöver beställas** | gul | Behovsberäkningens rader med förslaget att köpa eller lägga ut på legotillverkning: artikeln ligger under beställningspunkten eller räcker inte till behovet. Raderna grupperas på artikelns **förvalda leverantör**, se [Behöver beställas per leverantör](#behover-bestallas-per-leverantor). |
| **Behöver tillverkas** | gul | Behovsberäkningens rader med förslaget att tillverka, även konfigurerade artiklar. |
| **Bokningar utan kostnadsställe** | gul | Bokförda rader på ett konto med **Kräver kostnadsställe** som saknar kostnadsställe — i praktiken rader som automatkonteringen bokat utan, eftersom manuella verifikat inte kan bokföras utan. Raden länkar till [Verifikat](/hjalp/ekonomi#verifikat). Ekonomi-rättigheten krävs. |
| **Omatchade bankposter** | gul | Poster på ett kontoutdrag som är äldre än 10 dagar och ännu inte är matchade mot bokföringen. Raden visar dag, text, belopp och bankkonto och länkar till [Bankavstämning](/hjalp/ekonomi#bankavstamning) för kontot, där posterna matchas eller bokförs; aviseringen försvinner när posten matchats. |

Datumen för order räknas som på [Översikten och i planeringen](/hjalp/komma-igang#oversikten): radens eget leveransdatum gäller före orderns. För kundorder jämförs radens leveransdatum (annars orderns) med dagens datum.

## Vem ser vad

Du ser bara de typer som din behörighetsgrupp ger:

- **Negativt saldo**: menyn **Lager**.
- **Utgångna batcher**: menyn **Lager**.
- **Förfallna kundfakturor**, **E-fakturor som inte gick fram**, **Offerter att följa upp** och **Försenade kundordrar**: menyn **Försäljning**.
- **Leverantörsfakturor att betala**, **Försenade inköpsordrar**, **Behöver beställas** och **Fakturor i inkorgen att granska**: menyn **Inköp**.
- **Sena tillverkningsordrar** och **Behöver tillverkas**: menyn **Tillverkning**.
- **Återkommande verifikat som misslyckats**, **Bokningar utan kostnadsställe** och **Omatchade bankposter**: menyn **Ekonomi**.
- **Avvikelser som passerat Åtgärd senast**: menyn **Kvalitet**.
- **Utskick som misslyckades** och **E-postlådan för fakturor kunde inte läsas**: bara administratörer.

Administratörer ser allt. Sidan kräver minst en meny. Även ett konto med **Endast läsning** ser aviseringarna.

## Sidan Aviseringar

Sidan är grupperad per område, i samma ordning som sidomenyn: **Inköp**, **Försäljning**, **Tillverkning**, **Lager**, **Kvalitet**, **Ekonomi** och **System**. Varje område har en rubrik med det sammanlagda antalet och en röd prick om någon av dess typer har en röd rad, annars en gul. Under rubriken står en ruta per typ som har något att visa, med rubrik, antal och raderna. Typer och områden utan aviseringar visas inte, och finns ingenting alls står det "Inget att bevaka just nu." Har mer än ett område något att visa finns en rad med områdena överst, och ett klick på ett område hoppar till dess rubrik.

Typerna hör till området där saken åtgärdas, alltså menyn som ger rätt att se dem (se [Vem ser vad](#vem-ser-vad)). Typerna som bara administratörer ser står under **System**.

- Varje ruta visar de fem första raderna. **Visa fler (N)** under raderna fäller ut resten på sidan, och **Visa färre** fäller ihop dem igen. **Öppna listan** öppnar den vanliga listan för typen.
- Varje rad länkar till kortet där saken åtgärdas: kundorder, inköpsorder, tillverkningsorder, faktura eller leverantörsfaktura. Negativt saldo och behovsraderna länkar till artikelöversikten. En rad utan kort, t.ex. ett misslyckat testmejl, är vanlig text. Länkar till sidor du inte får öppna visas också som vanlig text.
- Antalet är alltid det verkliga antalet, men högst 200 rader visas per typ, även utfällt.
- **Beräknad hh:mm** visar när uppgifterna räknades fram (svensk tid). **Uppdatera** räknar om. Behovsberäkningen återanvänds i högst en minut, så **Behöver beställas** och **Behöver tillverkas** kan släpa något efter.
- Går det inte att läsa en typ visas den med ett felmeddelande, medan de övriga visas som vanligt.

## Behöver beställas per leverantör

Rutan **Behöver beställas** är grupperad på artikelns förvalda leverantör, med leverantörens namn (en länk till leverantörskortet) och antalet som rubrik. Leverantörerna står i namnordning, men gruppen **Utan förvald leverantör** står alltid först — där saknas leverantör på artikelkortet, och raden länkar dit; ange leverantör på artikelkortets flik **Inköp**. Förslagen om legotillverkning ligger i samma grupper som köpförslagen, hos operationens leverantör.

Även här visas de fem första raderna, under sina leverantörsrubriker, tills du väljer **Visa fler (N)**. Har du rätt att skapa inköpsorder finns en kryssruta på varje rad (utom i **Utan förvald leverantör**, där det inte finns någon leverantör att beställa från) och **Markera alla** i varje leverantörsgrupp. **Markera alla** markerar leverantörens alla rader och fäller därför ut rutan, så att du ser allt som markeras. När du markerat något visas knappen **Skapa inköpsorder (N)** i rutans rubrik. Den frågar "Skapa inköpsorder för N artiklar? En inköpsorder skapas per leverantör, köp och lego var för sig." och skapar sedan inköpsorder som **Utkast** på samma sätt som **Skapa ordrar** i [behovsberäkningen](/hjalp/tillverkning#orderforslag-och-skapa-ordrar): samma leverantörs- och prisregler, samma datumregler och samma varningar. Resultatet visas överst under **Skapade inköpsorder** med ordernumren som länkar till ordrarna, och fel visas per artikel. En leverantör som har både köp- och legoförslag markerade får **två** inköpsordrar, en för köp och en för lego.

Gruppen hör till menyn **Inköp** (se ovan), så det är den som har Inköp som skapar inköpsorder här; i behovsberäkningen får även **Tillverkning** skapa dem med **Skapa ordrar**. Konton med **Endast läsning** kan inte skapa order. Efter skapandet räknas listan om, och förslagen som blev ordrar försvinner.

Visas högst 200 rader per typ står det **+ N till** under en leverantörsgrupp som har fler när rutan är utfälld; länken öppnar behovsberäkningen. Rubrikens antal är alltid gruppens verkliga antal.

På Översikten visar kortet **Att bevaka** bara typen **Behöver beställas** med antalet, se nedan.

## Att bevaka på Översikten

Kortet **Att bevaka** på Översikten är en sammanfattning av sidan: en rad per typ som har något att visa, med typens namn, en röd eller gul prick och antalet, under samma områdesrubriker som sidan. Ett klick på en rad öppnar sidan Aviseringar vid den typen, med raderna utfällda. **Visa alla (N)** öppnar sidan, där N är det sammanlagda antalet. En typ som inte gick att läsa visas med ett streck i stället för antal.

## Daglig sammanställning via e-post

Längst ned på sidan, under **Daglig sammanställning via e-post**, kan du få aviseringarna som ett mejl. Det är valfritt och slås på för dig själv:

- **Skicka mig en sammanställning varje arbetsdag**: slår på mejlet. Valet sparas direkt.
- Kryssrutorna under **Ta med** väljer vilka typer mejlet innehåller. Du ser bara typerna du får se, och har du kryssat i alla följer mejlet också nya typer.
- Texten under kryssrutan visar vilken e-postadress mejlet går till och, om du får läsa inställningen, klockan hur dags det skickas. Saknar ditt konto e-postadress varnar sidan, och då kan inget mejl skickas (adressen anges under **System → Användare**).
- Är SMTP inte konfigurerat varnar sidan administratörer, eftersom inga mejl skickas då (se [E-post (SMTP)](/hjalp/system#e-post-smtp)).
- Även ett konto med **Endast läsning** kan slå på och ändra sin egen sammanställning.

Så fungerar utskicket:

- Mejlet skickas klockan **Skicka sammanställningen klockan** (förval 07:00, svensk tid) på arbetsdagar, alltså måndag till fredag utom heldagshelger. Har servern varit nere skickas dagens mejl så fort den är igång igen, men aldrig för tidigare dagar.
- Finns inget att bevaka skickas inget mejl.
- Ämnet är t.ex. "Nav: 5 saker att bevaka — tisdag 21 oktober". Mejlet har en rubrik per typ med antal och högst 20 rader, och sist en länk till **Aviseringar** med texten "Ändra vad du får". Raderna länkar till korten om **Navs adress** är angiven, annars står texten "Öppna Nav för att se detaljerna".
- Ett misslyckat mejl försöks inte igen samma dag. Alla sammanställningar loggas i [E-postloggen](/hjalp/system#e-postlogg) med dokumenttypen **Daglig sammanställning**. **Skicka om** finns inte för dem, eftersom innehållet vore inaktuellt, och ett misslyckat mejl syns dagen därpå som **Utskick som misslyckades** för administratörer.

## Inställningar

Administratörer ställer in aviseringarna under **System → Inställningar**, kortet **Aviseringar**. Fälten sparas när du lämnar dem, se [Inställningar](/hjalp/system#installningar).
