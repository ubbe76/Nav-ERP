# Tillverkning

Tillverkningsmodulen i Nav|ERP driver tillverkningsordrar (TO) genom flödet frisläppt → pågår → klar → stängd (en ny tillverkningsorder frisläpps när den skapas; status planerad finns kvar för äldre ordrar), med materialförbrukning, tidrapportering och efterkalkyl. Menyvalet **Tillverkning** öppnar modulens sida, som samlar modulens funktioner i ett rutnät.

## Översikt

Menyvalet **Tillverkning** öppnar modulens sida, där alla tillverkningsfunktioner ligger grupperade i ett rutnät:

- **Ordrar** — **Tillverkningsordrar**.
- **Verkstad** — **Stämpelterminal**, **Rapportera**, **Pågående arbete** och **Tidrapporter**.
- **Planering** — **Behovsberäkning**, **Beläggning**, **Körplan** och **Scheman**.
- **Resurser** — **Resurser** och **Produktionsgrupper**.

Personal och lön har en egen meny, **Personal & lön** (se kapitlet [Personal & lön](/hjalp/lon)). Nyckeltal för pågående tillverkning finns på **Översikt**, startsidan.

## Resurser

**Tillverkning → Resurser** är register över maskiner och personalresurser som utför operationer. Varje resurs har **nummer (3 siffror)**, namn, typ (Maskin/Personal), **timkostnad**, **TO-påslag (%)** och en produktionsgrupp.

De fält som justeras oftast går att ändra direkt i listan: tryck **Ändra** längst till höger på raden så blir **Produktionsgrupp**, **Veckoschema** (med kapacitetsfaktorn under, efter ×), **Timkostnad** och **TO-påslag** inmatningsfält. **Spara** (eller Enter) skriver ändringarna, **Avbryt** (eller Esc) lämnar raden som den var; bara en rad kan redigeras åt gången. Övriga fält — nummer, namn, typ, status och förvalsfälten — ändras genom att trycka på resursens namn, vilket öppnar hela formuläret.

Under fältet **Nummer (3 siffror)** visas en lista över redan upptagna nummer med resursens namn — maskiner, personal och legoresurser delar samma nummerserie, så listan visar alla tre sorterna oavsett vilket register du står i. Skriver du in ett upptaget nummer byts listan mot en varning, t.ex. "Numret 101 används redan av Svarv (Maskin)", och knappen **Skapa resurs** (**Spara resurs** när du redigerar) går inte att klicka förrän du väljer ett annat nummer. Redigerar du en befintlig resurs räknas dess eget nummer förstås inte som upptaget.

Timkostnaden ger den direkta lönekostnaden i för- och efterkalkylen, och **TO-påslaget** (tillverkningsomkostnad) räknas på den lönekostnaden. Nav sparar timkostnadens historik vid varje ändring, oavsett om den görs i listan, i formuläret eller med [resursimporten](#importera-resurser). Efterkalkylen och [Produkter i arbete](/hjalp/rapporter#produkter-i-arbete) räknar varje dags rapporterade tid till timkostnaden som gällde den dagen, och en ändring gäller hela dagen den görs. Tid som rapporteras för en dag innan historiken började räknas till den timkostnad resursen hade då. En ändrad timkostnad gäller från ändringsdagen; dagarna före behåller den gamla. Rättar du ett felaktigt värde samma dag ersätter rättelsen det för hela dagens tid, men en rättelse en senare dag gäller bara från den dagen — historiken går inte att rätta i efterhand, så kontrollera timkostnaden när resursen läggs upp. TO-påslaget har ingen historik: dagens procent gäller. Det ingår inte i kalkylens tillverkningskostnad (TVK) eller självkostnad (SVK) utan läggs till sist, direkt på försäljningspriset efter det generella påslaget. TO-påslaget är det enda påslaget som sätts per resurs — övriga påslag (MO, LO, Affo, generellt påslag och materialpåslag) är systemomfattande och ligger under **System → Kalkyler**, se [System & inställningar](/hjalp/system#kalkyler).

För [beläggningen](#belaggning) och [Leveranstidskontrollen](/hjalp/forsaljning#leveranstidskontroll) har resursen även **Veckoschema (kapacitet)** — ett veckoschema ur schemaregistret som anger resursens tillgängliga tid — eller, enklare, **Kapacitet per dag (tt:mm)**: så lång tid måndag–fredag, t.ex. 7:30, där en röd dag i helgdagskalendern är ledig och en halvdag följer helgdagens dagschema. Har resursen båda gäller veckoschemat. **Kapacitetsfaktor** multiplicerar tiden (t.ex. 2 = två likadana maskiner eller två personer; 0,5 = halvtid). Utan veckoschema och timmar per dag visar beläggningen ingen kapacitet för resursen, bara dess last. I resurslistan heter kolumnen **Kapacitet** och visar veckoschemat eller t.ex. *7,5 h/dag*.

Resursen kan också bära sex förvalsfält som ännu bara sparas — beredningen läser dem inte än: **Förvald ställtid (min)**, **Förvald operationsbenämning**, **Kalkylpris 1**, **Kalkylpris 2**, **Gäller ställ** och **Gäller styck**.

## Legoresurser

**Tillverkning → Legoresurser** är register över externa leverantörer som utför operationer — legoarbete som ytbehandling, härdning eller lackering. En legoresurs läggs till som operation i [beredningen](/hjalp/artiklar#beredning) precis som en vanlig resurs, men operationen köps i stället för att utföras i egen verkstad.

Varje legoresurs har **Nummer (3 siffror)** (samma nummerserie som vanliga resurser), **Namn**, **Standardleverantör** och **Aktiv**. Standardleverantören förifylls som operationens leverantör när resursen väljs i beredningen, och kan ändras per operation. Legoresurser har ingen produktionsgrupp, timkostnad eller veckoschema — de prissätts per operation med **Ställpris**, **Styckpris** och **Transportkostnad**, och deras kapacitet planeras inte i [beläggningen](#belaggning).

Fältet **Nummer (3 siffror)** visar samma lista över upptagna nummer och samma varning vid krock som i [Resurser](#resurser), eftersom nummerserien delas med maskiner och personal.

Legoresursen bär också tre ledtidsfält som sätts en gång och används i planeringsunderlaget: **Ledtid (dagar)**, **Kötid (dagar)** och **Ledtid beställning (dagar)**.

Så hänger legoflödet ihop:

- **Beredningen**: operationen får leverantör, ställ-/styckpris, transportkostnad, nettoviktsbock och ritningsval — se [Lego-operationer](/hjalp/artiklar#lego-operationer).
- **Frisläpp**: legofälten fryses på tillverkningsorderns operation, precis som tider och kommentarer.
- **Behovsberäkningen** föreslår en inköpsorder för varje ofärdig lego-operation på frisläppta tillverkningsordrar och ordrar som Pågår — se [Behovsberäkning](#behovsberakning).
- **TO-kortet**: samma inköpsorder kan skapas direkt från operationsraden, se [Legoinköp på TO-kortet](#legoinkop-pa-to-kortet).
- **Avsändningen** av gods till leverantören rapporteras i rutinen **Inköp → Avsändning lego**, som ger **Skickat** på inköpsorderraden och ett pallkort till leverantören. Den påverkar inte lagret eller tillverkningsordern — se [Avsändning lego](/hjalp/inkop#avsandning-lego).
- **Inleveransen** av lego-inköpsordern avrapporterar operationen automatiskt. Är lego-operationen inte sist bokförs inget lagersaldo; är den orderns sista operation läggs det mottagna antalet in i lager som färdiga varor, se [Inleverans från sista operationen](#inleverans-fran-sista-operationen). Se [Inleverans](/hjalp/inkop#inleverans).
- **Stämpelterminalen** visar aldrig lego-operationer; **Slutför** på operationsraden i TO-kortets kort **Rapportera** finns kvar som manuell väg.
- **Förkalkylen** räknar in ställpris, transportkostnad och styckpris som legokostnad med LO-påslag; efterkalkylen tar den verkliga inlevererade kostnaden från inköpsordern när en sådan finns.

## Produktionsgrupper

**Tillverkning → Produktionsgrupper** grupperar resurser och personal för planering och tidrapportering. Skapa grupp med kod + namn och bocka i vilka resurser som ingår.

## Importera resurser

**Tillverkning → Resurser → Importera** (`/tillverkning/resurser/import`) öppnar en guide med tre flikar — **Produktionsgrupper**, **Resurser** och **Legoresurser** — som tillsammans tar in en fullständig resursexport. Endast administratörer har åtkomst. Filer läses som CSV (semikolon, komma och tabb känns alla igen — även teckenkodningen identifieras automatiskt) eller Excel (.xlsx, bara det första bladet läses). Varje flik kör sin egen guide i fyra steg: **Fil**, **Kolumner**, **Förhandsgranska** och **Resultat**.

Mallen laddas ned med **Ladda ned mall** i fliken; kolumnerna förklaras i [Importmallar](/hjalp/importmallar#resurser) (legoresurser: [Legoresurser](/hjalp/importmallar#legoresurser), produktionsgrupper: [Produktionsgrupper](/hjalp/importmallar#produktionsgrupper)). **Exportera** bredvid ger det som redan finns i registret i samma kolumner, se [Exportera registren som importfiler](/hjalp/importmallar#exportera-registren-som-importfiler).

**Begreppen skiljer sig mellan exportfilerna och Nav:** filernas **Produktionsgrupp** är det Nav kallar en **resurs** (tresiffrigt nummer — en maskin eller en personalresurs), och filernas **Avdelning** är det Nav kallar en **produktionsgrupp**. Håll isär de två när du läser rubrikerna nedan — en kolumn som heter "Prod.grupp" mappas alltså mot Navs fält **Nummer**, inte mot produktionsgrupp.

Exporten **"Produktionsgruppslista"** består av tre filer — **Lista**, **Kostnader** och **Lego**. Kör flikarna i den här ordningen:

1. **Produktionsgrupper** (filen Kostnader) — skapar/uppdaterar produktionsgrupperna (filernas avdelningar).
2. **Resurser** (filerna Kostnader och Lista) — skapar/uppdaterar maskiner och personal, och skapar automatiskt de produktionsgrupper som saknas.
3. **Legoresurser** (filen Lego) — skapar/uppdaterar legoresurserna; kräver att leverantörerna redan finns (se [Importera leverantörer](/hjalp/inkop#importera-leverantorer)).

1. **Fil** — välj filen med filväljaren, så läses den in direkt. Första raden ska innehålla kolumnrubriker. Max 10 000 rader per fil.
2. **Kolumner** — varje kolumn i filen mappas mot ett fält; kända rubriker föreslås automatiskt (se listorna nedan) och kolumner satta till **Importera inte** hoppas över. Kryssrutan **Hoppa över rader som redan finns** lämnar poster som redan finns helt orörda i stället för att uppdatera/skapa dem — se [Hoppa över befintliga rader](/hjalp/artiklar#hoppa-over-befintliga-rader). Klicka **Förhandsgranska** för att gå vidare.
3. **Förhandsgranska** — varje rad visas som **Ny**, **Uppdateras** eller **Hoppas över** tillsammans med eventuella fel och varningar. En ruta ovanför tabellen listar de produktionsgrupper som kommer att skapas automatiskt (fliken Resurser). Knappen **Importera** är låst tills alla fel är åtgärdade — rätta filen och börja om från steget **Fil**.
4. **Resultat** — visar hur många rader som skapades, uppdaterades och hoppades över. De överhoppade listas i tabellen **Överhoppade rader**, som kan sparas som fil eller skrivas ut. **Klar** går tillbaka till resursregistret.

### Fliken Produktionsgrupper

Läser exportens **Kostnader**-fil. Kolumner som känns igen automatiskt: "Avdelning" → Kod, "Benämning" → Namn.

- Filen har en rad per resurs, så samma avdelning förekommer normalt flera gånger — bara den första raden för en given avdelning importeras, övriga listas som överhoppade med texten "Avdelningen förekommer flera gånger i filen".
- Saknas Benämning (kolumnen omappad eller cellen tom) används koden som namn.
- Finns koden redan i produktionsgruppregistret uppdateras den (eller hoppas över med **Hoppa över rader som redan finns**).

### Fliken Resurser

Läser exportens **Kostnader**- och **Lista**-fil. Kolumner som känns igen automatiskt:

- "Prod.grupp" → **Nummer** — tre siffror; ett nummer med en eller två siffror fylls ut med nollor (7 blir 007), eftersom Excel gör om 007 till talet 7 i en kolumn som inte är textformaterad.
- "Namn" → **Namn**.
- "Typ" → **Typ**: "Maskin" ger maskin, "Manuellt arbete" ger personal. Ett okänt värde ger maskin och en varning på raden; ett värde som innehåller "lego" hoppas över med en hänvisning till fliken **Legoresurser**.
- "Avdelning" → **produktionsgrupp**. Finns produktionsgruppen inte skapas den automatiskt — med namn från "Benämning" när den kolumnen är mappad, annars koden.
- "Aktuell, STD" → **Timkostnad**.
- "Aktuell, K.pris 1" → **Kalkylpris 1** och "Aktuell, K.pris 2" → **Kalkylpris 2**.
- "Förv. ställ" / "Förv. styck" → **Gäller ställ** / **Gäller styck**.
- "Förvald ställtid" → **Förvald ställtid**.
- "Op. benämning" → **Förvald operationsbenämning**.
- Kostnader-filens andra "Namn"-kolumn (visas som **"Namn (2)"** i kolumnväljaren eftersom filen har två kolumner med samma rubrik) → **Kostnadsrad**: bara den rad per resurs vars Kostnadsrad börjar med **Ordinarie** importeras (även t.ex. "Ordinarie 1000") — rader märkta **Undantag 1**/**Undantag 2** hoppas över. Saknar en resurs helt en Ordinarie-rad används dess första kostnadsrad, med en varning på raden.

Kolumner som medvetet lämnas omappade: Lagerställe, Planerare namn, Kategori, Ta med delrapporterade i Körklara, Tidshorisont, Förvald fördelningstid, Med i LTK, Mtrl i std.enhet, Auto rapp. antal, Und. autom. rapp. mtrl, samtliga Kommande-kolumner, Effekt och Öv. utsläpp.

- Ett nummer som redan används av en legoresurs stoppar raden som ett radfel.
- Tomma celler skriver aldrig över befintliga värden vid uppdatering; en ny resurs måste ha ett namn.

### Fliken Legoresurser

Läser exportens **Lego**-fil. Kolumner som känns igen automatiskt: "Prod.grupp" → **Nummer** (tre siffror, en eller två siffror fylls ut med nollor som på fliken Resurser), "Namn" → **Namn**, "Leverantör" → **Leverantörsnummer**, "Ledtid" → **Ledtid (dagar)**, "Kötid" → **Kötid (dagar)**, "Ledtid beställning" → **Ledtid beställning (dagar)**.

Leverantörens namn-/kontaktkolumner ("Namn (2)"/"Namn (3)") samt "Skapa inte fakturaunderlag" och "Skapa I-order" saknar motsvarighet och lämnas omappade.

- Leverantören måste redan finnas i registret (importera fliken **Leverantörer** i inköpsmodulen först, se [Importera leverantörer](/hjalp/inkop#importera-leverantorer)) — annars blir raden ett radfel.
- Ett nummer som redan används av en maskin- eller personalresurs stoppar raden som ett radfel.

### Regler att känna till

- **Allt eller inget.** Innehåller filen ett enda radfel importeras ingenting på den fliken — det som förhandsgranskningen visar som fel måste rättas i filen först. Varningar stoppar däremot aldrig importen.
- **Ingen nummerserie för resurser.** Numret kommer från filen — importen räknar inte upp någon nummerserie, till skillnad från kund-/leverantörsimporten.
- **Rekommenderad ordning:** Produktionsgrupper → Resurser → Legoresurser, se ordningen ovan.

## Tillverkningsorder

**Tillverkning → Ordrar** listar alla TO med sök och statusfilter. Du kan välja flera statusar samtidigt. Klara, stängda och makulerade ordrar visas bara med **Visa avslutade**, se [Lista och kort](/hjalp/komma-igang#lista-och-kort). Statusfiltret har också **Sen**: frisläppta och pågående ordrar som produktionsplaneringen markerar **Sen** — samma urval som aviseringen [Sena tillverkningsordrar](/hjalp/aviseringar). **Sen** är ingen egen status utan räknas fram när listan visas. Filtret har också **Halvfabrikat sent** — ordrar där ett halvfabrikat som ordern behöver blir klart för sent, se [Halvfabrikat sent](#halvfabrikat-sent).

### Läsläge

Den som bara har rättigheten **Tillverkningsorder (läsläge)** (verkstadsprofilen, se [Behörighetsgrupper](/hjalp/system#behorighetsgrupper)) ser tillverkningsorder i läsläge. Listan saknar då **+ Ny tillverkningsorder**, **Exportera**, markering och åtgärdskolumn. På kortet finns inga knappar, ingen redigering av **Planerat färdigdatum**, ingen kalkyl och ingen **Historik** (den är bara för administratörer). **Skriv ut TO** och pallkorten finns kvar. Legooperationernas priser visas som **–**: priser är kontorsdata, och den som saknar menyrättigheter ser dem inte. Rättigheten **Tillverkning** ger fullt läge.

### Skapa och frisläppa

1. **+ Ny tillverkningsorder**: välj artikel (artikelväljaren) och antal (har artikeln en **Avrundning** på Lager-fliken avrundas antalet uppåt till närmaste multipel när ordern skapas — 12 med Avrundning 10 blir 20; detsamma gäller en TO som skapas från en kundorderrad), samt eventuellt **Planerat färdigdatum** — datumet styr vilken vecka orderns operationstid räknas i i [beläggningen](#belaggning) så länge ordern inte är planerad (en planerad order räknas på sina [planerade dagar](#planerade-dagar); färdigdatumet ändras aldrig av planeringen) och kan sättas eller ändras på TO-kortet i efterhand (med **Spara**, så länge ordern är Planerad/Frisläppt/Pågår). Medan ett ändrat datum inte är sparat är **Flytta halvfabrikaten…**, **Skapa saknade halvfabrikat…** och legooperationens **Skapa inköpsorder** avstängda — de räknar från det sparade datumet. Ordern får ett TO-nummer och **frisläpps direkt** (status **Frisläppt**), så den syns i [stämpelterminalen](/hjalp/terminal) och går att stämpla in på med en gång. Den **planeras också direkt**: operationerna läggs i tur och ordning på resursernas lediga tid från i dag, se [Planerade dagar](#planerade-dagar). När du väljer artikel föreslås färdigdatumet automatiskt, se [Föreslaget färdigdatum](#foreslaget-fardigdatum).
   En konfigurerbar mall i läget Variantartiklar (se [Artiklar](/hjalp/artiklar#varianter)) visas i artikelväljaren med märkningen **Konfigurerbar**. Väljer du den öppnas dialogen **Konfigurera**: gör valen och klicka **Lägg in**, så blir ordern en tillverkningsorder på varianten (den hämtas om den finns och skapas annars). Dialogen visar inget pris här. Mallen själv kan inte tillverkas. En mall i läget Beställningsvara tillverkas däremot med valen på ordern, se [Tillverkningsorder för beställningsvara](#tillverkningsorder-for-bestallningsvara).
2. **Frisläppet sker när ordern skapas** — oavsett om den skapas här, [från en kundorderrad](#skapa-fran-kundorder) eller med behovsberäkningens **Skapa ordrar**. Då snapshotas artikelns struktur till en **materiallista** och rutten till **operationer** — senare ändringar på artikeln påverkar inte en redan frisläppt order. Räcker inte lagersaldot (utan [spärrade lagerplatser](/hjalp/lager#sparrade-lagerplatser)) till materialet visas **Varning vid frisläpp** överst på TO-kortet när du kommer dit; ordern skapas och frisläpps ändå. Samma ruta visar planeringens varningar för den nya ordern: en operation som inte rymdes inom två år, att ordern beräknas bli sen, och en operation med [orimligt mycket tid](#planera). Ordrar som skapades innan frisläppet blev automatiskt kan stå kvar som **Planerad** — dem frisläpper du med **Frisläpp** på detaljsidan eller i listan. Fantomartiklar i strukturen löses upp till sina komponenter. Operationer som är märkta **Kalkyl** i beredningen följer inte med (se [Artiklar](/hjalp/artiklar#kalkyloperationer)): de prissätts i förkalkylen men syns aldrig på ordern, i terminalen, i beläggningen eller i efterkalkylen. Strukturrader märkta **Kalkyl** följer inte heller med (se [Kalkylrader i strukturen](/hjalp/artiklar#kalkylrader-i-strukturen)): de ingår i förkalkylen men hamnar aldrig på materiallistan, dras inte och ger ingen materialbrist.

### Tillverkningsorder för beställningsvara

En mall i läget **Beställningsvara** (se [Artiklar](/hjalp/artiklar#konfigurator)) tillverkas med valen på ordern:

- **Från kundorderraden.** **Skapa TO** på en konfigurerad rad tar radens val rakt av; dialogen visar valraderna överst (t.ex. *Lås: Lås B*, *Bredd: 1 200 mm*). **Planerat färdigdatum (valfritt)** förifylls alltid med arbetsdagen före kundorderns leveransdatum (idag som tidigast), även om mallen har lager eller andra tillverkningsordrar; saknar kundordern leveransdatum, eller är radens hela antal redan levererat, lämnas fältet tomt. Ändras raden med **Ändra konfiguration** medan tillverkningsordern skapas får du meddelandet "Raden konfigurerades om medan tillverkningsordern skapades — kontrollera raden och försök igen, eller använd Ändra konfiguration". Har mallen tagits bort efter att raden lades skapas ingen tillverkningsorder ("Mallen är inte i läget Beställningsvara.") — en vanlig order skulle byggas på artikelns egen struktur utan radens val; har mallen bytt till läget **Variantartiklar** stoppas den som alla mallar i det läget.
- **Ny tillverkningsorder.** Väljer du mallen i artikelväljaren öppnas dialogen **Konfigurera**; gör valen och klicka **Lägg in**. Valraderna visas under artikelfältet och **Konfigurera om** öppnar dialogen igen. Innan valen är gjorda står "Konfigurera artikeln först" och knappen **Skapa tillverkningsorder** är inaktiv. **Avbryt** (eller Esc) tömmer artikelfältet.
- **Materialet och operationerna skrivs in när tillverkningsordern skapas** ur valen, inte ur mallens egen struktur och rutt. Ordern frisläpps direkt som alla nya tillverkningsordrar. Senare ändringar i mallen (nya villkorade rader, ändrade formler) påverkar inte redan skapade ordrar.
- **Tillverkningsordern visar valen.** Valraderna står under orderhuvudet, och raden **Lagervärde vid inleverans** visar förkalkylens kostnad per styck (*xxx,xx kr/st (förkalkyl)*), eller *saknas* när mallen saknar kostnad. Det är kostnaden som färdigvaran värderas till i lagret vid inleverans; raden visas bara för den som ser priser (inte verkstadsprofilen).
- **Konfigurationen kan inte ändras efteråt.** Vill du ha andra val: makulera tillverkningsordern och skapa en ny. Orderns material och operationer går däremot att ändra som på vilken order som helst, se [Ändra material och operationer](#andra-material-och-operationer).

### Föreslaget färdigdatum

När en tillverkningsorder skapas föreslås **Planerat färdigdatum** utifrån artikelns **skarpa behov** — kundorderrader och materialbehov på andra tillverkningsordrar — så att ordern blir klar **en arbetsdag innan** behovet:

- Ett behov som **redan är täckt** räknas inte. Lagersaldot plus alla öppna inköps- och tillverkningsordrar på artikeln fördelas på behoven i datumordning (samma nettning som [behovsberäkningen](#behovsberakning)) — **oavsett ordrarnas egna datum**. En befintlig tillverkningsorder utan färdigdatum, eller en inköpsorder som kommer för sent, täcker alltså ändå sitt behov; att den ligger fel i tiden är den orderns sak, inte en anledning till en ny tillverkningsorder.
- Förslaget utgår från det **första otäckta behovet** — det första behovet i datumordning som lager och befintliga ordrar inte räcker till (du ser behoven och deras datum i [artikelöversikten](/hjalp/artiklar#artikeloversikt)). Är lagersaldot negativt även efter alla öppna ordrar föreslås idag.
- **Arbetsdag** betyder måndag–fredag som inte är en ledig helgdag i [helgdagsregistret](/hjalp/personal-tid#helgdagar). En helgdag med eget dagschema (t.ex. en kortdag) räknas som arbetsdag. Ett behov på en måndag ger alltså färdigdatum fredagen innan.
- Förslaget blir aldrig tidigare än **idag plus artikelns ledtid** i arbetsdagar (se **Ledtid (dagar)** under [Artiklar](/hjalp/artiklar#lager)). Hinner ordern därmed inte före behovet föreslås ändå det tidigaste möjliga datumet och en varning visas: *Färdigdatumet hinner inte före behovet (datum) — tidigast möjliga med ledtiden.* Är ledtiden 0 är golvet idag. Ange **Antal** först: ledtiden räknas på antalet när den kommer ur rutten. Ledtiden följer ordningen fältet → rutten med systeminställningen **Kötid mellan operationer (dagar)** → **Standardledtid (dagar)** för en artikel utan rutt (se [Inställningar](/hjalp/system#installningar)).
- **Kundorderns behov räknas på avsändningsdagen**, inte på leveransdatumet: har kunden [transportdagar eller avsändningsdagar](/hjalp/forsaljning#leveransdagar) räknas leveransdatumet bakåt till den dag ordern senast måste skickas, och förslaget blir arbetsdagen före den. Utan sådana inställningar är avsändningsdagen detsamma som leveransdatumet.
- Är alla behov täckta, eller saknar det första otäckta behovet datum, lämnas fältet tomt.

Under fältet står varifrån förslaget kommer, t.ex. *Föreslaget: arbetsdagen före första bristen 2030-03-04 (KO-1042).* — "första bristen" är det första otäckta behovet. Förslaget är bara ett förval — skriver du ett eget datum gäller det, även om du byter artikel efteråt.

Förslaget görs i **+ Ny tillverkningsorder**, när en TO skapas [från en kundorderrad](#skapa-fran-kundorder) (där är det radens eget behov på avsändningsdagen som räknas) och när [behovsberäkningens](#orderforslag-och-skapa-ordrar) **Skapa ordrar** skapar tillverkningsordrar.

### Ändra status i listan

Statusen behöver inte ändras order för order på detaljsidan. Kolumnen **Åtgärder** i listan visar de knappar som gäller för radens status: **Frisläpp** och **Makulera order** på en Planerad order, **Makulera order** på en Frisläppt, **Stäng order** på en Klar. En order som Pågår visar i stället **Slutför på kortet** — slutförandet anger lagerplats och antal och bokför inleveransen, så det görs på detaljsidan. **Makulera order** och **Stäng order** frågar alltid först; en makulerad order kan inte återöppnas, och den går bara att makulera så länge inget är rapporterat på den (se [Makulera order](#makulera-order)).

Kryssa för flera ordrar (kryssrutan i rubrikraden väljer alla på sidan som går att påverka) så visas en rad under listan med **Frisläpp valda**, **Stäng order valda** och **Makulera order valda** — siffran inom parentes är hur många av de valda som just den åtgärden gäller för. Ordrarna behandlas en och en; misslyckas någon listas den i en felruta och förblir markerad så du kan försöka igen, medan de som lyckades avmarkeras. Lagervarningar från frisläppet visas ovanför listan med TO-numret framför varje rad. På en smal skärm (mobil i stående läge) visas listan som staplade kort utan rubrikrad; då ligger kryssrutan **Välj alla på sidan** och knapparna för valda ordrar i stället i en rad ovanför listan som följer med när du skrollar.

### Planerade dagar

Varje operation på en tillverkningsorder kan ha en **planerad dag** (eller flera, om tiden inte ryms i en): den dag operationen beräknas börja och den dag den beräknas bli klar, utifrån resursens lediga tid. **Dagen är planens enhet.** Operationstabellen på TO-kortet har kolumnen **Planerad** — till exempel **12 nov** eller **12–14 nov**. Står det **Ej planerad** har operationen ingen plan än (äldre ordrar, tills du kört **Planera** första gången, eller en operation som inte rymdes inom två år). **Låst** betyder att dagen är flyttad för hand i [beläggningen](#belaggning) och ligger kvar när du kör **Planera**. Klara operationer och legooperationer visar **–**.

En **ny tillverkningsorder planeras direkt när den skapas**, oavsett om den skapas från **+ Ny tillverkningsorder**, från en kundorderrad, med behovsberäkningens **Skapa ordrar** eller via API:t: operationerna läggs i tur och ordning från i dag på ledig kapacitet, mot all annan last. Räcker inte kapaciteten inom två år lämnas operationen oplanerad och ordern visar en varning vid frisläpp. Planen ändrar aldrig **Planerat färdigdatum** — datumet är kundens behov, planen är vår.

- **Nästa operation börjar tidigast arbetsdagen efter att föregående blev klar**, plus **Kötid mellan operationer (dagar)** (se [Systeminställningar](/hjalp/system)) — väntan mellan operationerna. Två operationer som tar en halv dag var ligger alltså på två olika dagar.
- **En påbörjad operation planeras från i dag.**
- **En plan som passerat ligger kvar på i dag tills Planera körs.** Är en operation planerad till i fredags och inte körd har den på måndagen rullats in på i dag: all ogjord last ligger då på dagens dag och dagvyn i [beläggningen](#belaggning) blir röd tills någon kör **Planera**, som lägger om den framåt.

Ordern märks **Sen** — på TO-kortet bredvid statusen, och i listan i kolumnen **Planerad** — när den sista operationen beräknas bli klar efter **Planerat färdigdatum**. En order utan plan är **Sen** när färdigdatumet passerat. Listan **Tillverkning → Ordrar** har kolumnen **Planerad** med orderns planerade dagar (från första till sista väntande operation).

### Skapa från kundorder

En tillverkningsorder kan också skapas direkt från en kundorderrad i stället för via **+ Ny tillverkningsorder**. På kundorderkortet (se [Försäljning](/hjalp/forsaljning#kundorder)) visar en rad med en tillverkningsartikel knappen **Skapa TO** i kolumnen **I tillverkning** så snart ordern är **Bekräftad** eller **Under tillverkning** och raden inte redan är täckt av tillverkningsordrar eller helt levererad. På en konfigurerad beställningsvarurad finns knappen också — se [Tillverkningsorder för beställningsvara](#tillverkningsorder-for-bestallningsvara). Dialogen förifyller fältet **Antal** med det som återstår av radens beställda antal — redan skapade, ej makulerade tillverkningsordrar mot samma rad räknas av — men antalet går att ändra innan **Skapa tillverkningsorder** klickas. Fältet **Planerat färdigdatum (valfritt)** förifylls med arbetsdagen före kundorderns leveransdatum, så länge raden inte redan är täckt av lager eller befintliga inköps-/tillverkningsordrar. Är raden redan täckt — eller saknar kundordern leveransdatum — används artikelns första otäckta behov i stället (se [Föreslaget färdigdatum](#foreslaget-fardigdatum)). Undantaget är en konfigurerad beställningsvarurad: där gäller alltid radens eget leveransdatum (arbetsdagen före, idag som tidigast) — mallens lager och andra raders tillverkningsordrar är andra konfigurationer och täcker den inte — och saknar kundordern leveransdatum lämnas fältet tomt.

Den nya tillverkningsordern frisläpps direkt (status **Frisläppt**) precis som en manuellt skapad TO, med kundorderraden kopplad, och du hamnar direkt på TO-kortet — som visar raden **Kundorder:** med en länk till kundordern och kundens namn. Kundordern får automatiskt status **Under tillverkning** (om den inte redan är det), och kundorderraden visar därefter kolumnen **I tillverkning** med det kopplade antalet och TO-numret som länk med orderns status. Knappen under dem heter sedan **Skapa TO för resten (N st)** och försvinner när raden är helt täckt. En kundorderrad med en kopplad tillverkningsorder kan inte tas bort — även om tillverkningsordern senare makuleras: kopplingen är historik och blockerar borttagning ändå, men en makulerad TO räknas inte längre med i kolumnen **I tillverkning**.

### Under tillverkning

- **Rapportera**: all manuell avrapportering görs i kortet **Rapportera** på TO-kortet (se [Avrapportera operation](#avrapportera-operation)): en rad per operation med dess kopplade material under, gruppen **Vid slutrapportering** för material utan operation, en rad **Rapportera tid** och — på en frisläppt eller pågående order — en rad **Slutför order**. **Makulera order**, **Efterkalkylera** och **Skriv ut TO** ligger i verktygsraden överst på tillverkningsordern.
- **Serienummer**: färdiga styck av en serienummerstyrd artikel (nummer vid inleverans) får löpnummer ur artikelns serie när de inlevereras, även i terminalen; en tillverkad batch får utgångsdatum av artikelns **Hållbarhet (dagar)** — se [Serienummer](/hjalp/lager#serienummer).
- **Batch**: färdiga varor av en batchstyrd artikel får tillverkningsordernumret som batch, och en batchstyrd komponent har ett val **Batch** vid **Förbruka** (förvalt **Automatiskt**, äldsta batch först) — se [Batchnummer och spårbarhet](/hjalp/lager#batchnummer-och-sparbarhet).
- **Material**: klicka **Förbruka** på materialraden i kortet **Rapportera**. Välj lagerplats i **Lagerplats för materialuttag** högst upp i kortet (gäller både **Förbruka** och **Slutför**) och ange antal — ett materialuttag bokförs i lagret. **Antal** är förifyllt med det som återstår av radens planerade mängd (planerat − förbrukat); skriv över det om uttaget ska vara ett annat. Överuttag utöver planerat stoppas. Är strukturraden skriven i en alternativ enhet (se [Artiklar](/hjalp/artiklar)) visas och matas materialraden in i den enheten (kolumnen **Enhet**); uttaget bokförs alltid i komponentens grundenhet.
- **Operationsraderna** har **Ändra** (på en väntande operation) och en **⋯**-meny med **Pallkort**, **Ta bort** och — på en väntande lego-operation — **Skapa inköpsorder** och **Skapa förfrågan** (se [Legoinköp på TO-kortet](#legoinkop-pa-to-kortet)). I läsläge och på en klar eller stängd order finns bara knappen **Pallkort**.
- **Operationer**: personalen stämplar in/ut på operationerna i [stämpelterminalen](/hjalp/terminal), eller så rapporteras tid manuellt på raden **Rapportera tid** (**Anställd**, **Operation**, **Datum**, **Tid** i tt:mm och en valfri **Anteckning**). **Tid** är förifyllt med operationens teoretiska tid — ställtid + tid/enhet × orderns antal — minus den tid som redan är rapporterad på operationen; fältet är tomt när allt är rapporterat eller operationen saknar tider. Med inställningen **Dela tid i ställ och produktion** på har raden också **Typ**, förvald till **Produktion**, och förslaget följer valet: **Produktion** ger stycktid × orderns antal minus den tid som rapporterats som produktion, **Ställ** planerad ställtid minus den tid som redan rapporterats som ställ, och **Ej uppdelad** hela operationen som förut. En tid du själv skrivit in skrivs inte över när du byter **Typ**. Klicka **Slutför** på operationen när den är klar — se [Avrapportera operation](#avrapportera-operation). Har operationen en **Packinstruktion** visas den i dämpad text under operationsraden i tabellen (se [Artiklar](/hjalp/artiklar#packinstruktion-pa-operationen)). Kolumnen **Tid/enhet** visar Stycktid i den enhet operationen bereddes i (min/st, sek/st eller st/h) — se [Tidsenhet på operationen](/hjalp/artiklar#tidsenhet-pa-operationen).
- Ordern får status **Pågår** automatiskt vid första instämplingen eller inleveransen — det finns ingen knapp för att starta den.

### Legoinköp på TO-kortet

En lego-operation köps av en leverantör (se [Legoresurser](#legoresurser)). Under operationens namn i tabellen **Operationer** står vilken leverantör som gör den och vad som redan är köpt: en rad per inköpsorder mot operationen, t.ex. **IO-1042 (Utkast) · 1 000 st · önskat 2026-12-04** (och **mottaget …** när något har levererats in), och en rad per öppen förfrågan, t.ex. **Förfrågan FO-1024 (Skickad)**. Makulerade inköpsordrar och förfrågningar som redan blivit order visas inte. Är inget köpt står det **Ingen inköpsorder än**.

Under inköpsorderraden står även **skickat …** när gods har rapporterats som skickat till leverantören. Operationens **⋯**-meny har dessutom en post **Avsändning IO-…** per öppen inköpsorder (Utkast, Skickad, Bekräftad eller Delvis mottagen) som köper operationen; den öppnar [Avsändning lego](/hjalp/inkop#avsandning-lego) med ordern förvald och visas bara för dig som har rättigheten Inköp.

På en väntande lego-operation i en frisläppt eller pågående order har radens **⋯**-meny två val:

- **Skapa inköpsorder** gör samma sak som **Skapa ordrar** i [behovsberäkningen](#orderforslag-och-skapa-ordrar), men för just den här operationen. Dialogen visar leverantören, styckpriset, ställpriset (med transportkostnaden) och **Redan beställt** av orderns antal. **Antal** är förifyllt med det som återstår att beställa. Är allt redan beställt är fältet tomt, och du kan skriva ett antal om operationen ska köpas en gång till. Inköpsordern skapas som **Utkast** hos operationens leverantör, med styckpriset som à-pris, ställpriset på raden (båda omräknade från kronor med orderns kurs när leverantören har en annan valuta) och **Önskat leveransdatum** när operationen måste vara tillbaka (se [Behovsberäkning](#orderforslag-och-skapa-ordrar)). Valet är avstängt när operationen saknar leverantör — sätt leverantören med **Ändra**. Det kräver rättigheten Tillverkning.
- **Skapa förfrågan** (rättigheten Inköp) öppnar samma dialog som **Skicka förfrågan** i beredningen, men raden kopplas till tillverkningsorderns operation, så **Gör till inköpsorder** på förfrågan tar med kopplingen. Se [Legorader på förfrågan](/hjalp/inkop#legorader-pa-forfragan).

### Ändra material och operationer

Materiallistan och operationerna är en ögonblicksbild från frisläppet, men de går att ändra på TO-kortet så länge ordern är **Frisläppt** eller **Pågår** (rättigheten Tillverkning krävs; i läsläge finns inga knappar). Ändringarna rör **bara den här tillverkningsordern** — artikelns struktur och rutt i beredningen påverkas inte. En tillverkningsorder för en [beställningsvara](#tillverkningsorder-for-bestallningsvara) ändras på samma sätt; förkalkylen på den står kvar. En Planerad, Klar, Stängd eller Makulerad order kan inte ändras ("Material och operationer kan bara ändras när ordern är frisläppt eller pågår").

**Material**

- **+ Lägg till material**: välj artikel, **Antal** med enhet (en av komponentens enheter — antalet räknas om till grundenhet precis som på en strukturrad) och **Operation** (den operation som drar materialet, eller *Ingen — dras vid inleverans*). Orderns egen artikel, en fantomartikel (den lagerhålls aldrig — lägg till dess komponenter) och en mall i läget Variantartiklar kan inte väljas, och samma komponent kan bara finnas en gång per operation. Räcker inte lagersaldot (utan [spärrade lagerplatser](/hjalp/lager#sparrade-lagerplatser)) visas en bristvarning ("Komponent: behöver N, tillgängligt M") — raden läggs till ändå.
- **Ändra** på raden: antal, enhet, operation och artikel. Artikeln går bara att byta så länge inget är förbrukat på raden. Antalet får sättas lägre än det redan förbrukade — förbrukat material lämnas aldrig tillbaka av en ändring, och nästa rapportering drar som vanligt upp till det nya planerade antalet (planerat per enhet × rapporterat, minus redan förbrukat). Ett byte av operation påverkar bara kommande uttag.
- **Material på en klar operation:** kopplat material dras när operationen rapporteras, och en **Klar** operation rapporteras inte mer — därför går en klar operation inte att välja för nytt material. Höjs antalet på en rad som redan ligger på en klar operation sparas ändringen, men notisrutan säger "Operation N är klar — materialet dras inte automatiskt, använd Förbruka." Dra det då med **Förbruka** på raden.
- **Ta bort** finns bara på en rad utan förbrukning.

**Operationer**

- **+ Lägg till operation**: samma fält som i beredningen (sekvensnummer, beskrivning, resurs, ställtid, stycktid, kommentar, packinstruktion och legofälten på en legoresurs: leverantör, **Ställpris**, **Styckpris** och **Transportkostnad (kr)**), utom **Kalkyl**, **Använd artikelns ritning** och **Ritningar och filer**. Förvalt sekvensnummer är sista + 10, och ett sekvensnummer som redan finns på ordern avvisas. Operationen får status **Väntar**.
- **Ändra** på en väntande operation: tider och texter går att ändra även när något redan rapporterats. **Resursbyte** vägras när någon är instämplad på operationen, när en inköpsorderrad eller förfrågningsrad pekar på den (lego), och mellan legoresurs och egen resurs när något redan rapporterats. En klar operation kan inte ändras.
- **Alternativa resurser:** har operationen alternativa resurser i beredningen (se [Alternativa resurser](/hjalp/artiklar#alternativa-resurser)) står de kvar på ordern sedan frisläppet. Operationsraden visar då vilken resurs ordern använder: märket **Alternativ** (med den ordinarie resursen som tips) när det är ett alternativ, och märket **Vald för hand** när resursen har bytts för hand. I dialogen **Ändra** listar **Resurs** först **Operationens resurser** (*110 · Kantpress (ordinarie)*, *120 · Kantpress 2 (alternativ)*) och sedan alla andra. Väljer du en av dem fylls **Ställtid** och **Tid/enhet** i från resursens rad. En tid du själv har skrivit skrivs aldrig över av förifyllningen, och du kan ändra den innan du sparar.
- **Förslag:** när ordinarie resurs är full och en alternativ resurs skulle bli klar en tidigare dag visar operationsraden märket **Förslag: 120**, texten *Kan bli klar 12 nov på 120 (i stället för 14 nov)* och knappen **Byt till 120** (rättigheten Tillverkning krävs; knappen finns bara på en frisläppt eller pågående order). Har operationen ingen plan på nuvarande resurs står det i stället *Kan planeras klar v.47 på 120 (saknar plan på nuvarande resurs)*. **Byt till 120** byter resurs direkt, planerar om ordern och markerar operationen **Vald för hand**, så förslaget försvinner. Se [Förslag på alternativ resurs](#forslag-pa-alternativ-resurs).
- **Vald för hand:** kryssrutan visas när operationen har alternativ och en av dess resurser är vald. Den kryssas i av sig själv när du byter resurs, och märker att bytet är ditt val. Kryssa ur den och spara för att ta bort märket, så att operationen åter kan få förslag. Byter du till en resurs som inte är en av operationens resurser tas alternativen och märket bort från ordern, och dialogen varnar innan du sparar.
- **Vad ett byte påverkar:** bytet gäller bara den här tillverkningsordern. Ordern planeras om, och operationen hamnar på lediga dagar på den nya resursen; ett lås på operationen släpps, eftersom dagarna var bokade på den gamla resursen. Stämpelterminalen visar operationen på den nya resursens station. Har den gamla resursen redan arbetat på operationen planeras den nya resursens ställtid ändå, tills den nya resursen har rapporterat tid på operationen. Tid som redan är rapporterad står kvar på resursen den gjordes på (dialogen säger det när något redan är rapporterat): [efterkalkylen](#efterkalkyl) och [Produkter i arbete](/hjalp/rapporter#produkter-i-arbete) räknar den med den resursens timkostnad, och ny tid räknas på den nya resursen. Avvikelseanalysen räknar bytet som en ny plan: Kalkylerat är den nya resursens tider och timkostnad. Förkalkylen står kvar på den ordinarie resursen. En instämplad operation går inte att byta ("Någon är instämplad på operationen — stämpla ut först"), och spärrarna för inköpsrader och lego gäller som förut.
- **Ta bort** finns bara på en operation som aldrig haft något: ingen rapportering (inte heller en ångrad), ingen tidrapport, ingen stämpling, ingen kassation och ingen inköps- eller förfrågningsrad. Material som var kopplat till operationen blir okopplat och dras vid inleveransen i stället.
- **Sista operationen** är den vars Antal OK blir färdiga varor. Så snart något levererats in från den kan ingen ändring byta vilken operation som är sist: inte lägga till en efter den, inte ta bort den och inte numrera om så att en annan blir sist ("Varor har levererats in från sista operationen").

Varje operationsändring (lägg till, ta bort, ändrad tid, resurs eller sekvens) **planerar om orderns väntande operationer** med samma regler som **Planera** (se [Planera](#planera)): påbörjade operationer från i dag, låsta operationer ligger kvar, all annan last räknas som upptagen. En låst operation som byter resurs tappar låset, eftersom dagarna var bokade på den gamla resursen; en låst operation som bara får ny tid behåller låset och dagarna. Planeringens varningar (sen order, kapaciteten räcker inte inom två år, operation i fel ordning, [orimligt mycket tid](#planera)) och materialets bristvarningar visas i en notisruta på kortet efter sparandet.

Alla ändringar loggas i orderns **Historik**: Material tillagt/ändrat/borttaget och Operation tillagd/ändrad/borttagen, med artikel respektive operation och resurs och vad som ändrades.

### Materialbrist vid rapportering

Inställningen **Materialbrist vid rapportering** (System → Inställningar, se [Inställningar](/hjalp/system#installningar)) styr vad som händer när en rapportering skulle dra mer material än vad som finns i lager. Det som jämförs är det material rapporteringen drar mot artikelns **saldo på alla lagerplatser som inte är spärrade** (se [Spärrade lagerplatser](/hjalp/lager#sparrade-lagerplatser)); flera materialrader med samma artikel i en rapportering läggs ihop, och tjänsteartiklar kontrolleras aldrig.

- **Ingen kontroll** — rapporteringen går alltid igenom (standard).
- **Varning** — innan något sparas visas "Det saknas ingående delar: Plåt 2 mm (behöver 8 st, tillgängligt 3 st). Rapportera ändå?". Välj **Rapportera ändå** för att bokföra rapporteringen, eller avbryt — då sparas ingenting och formuläret står kvar som det var.
- **Spärr** — rapporteringen nekas och meddelandet "Det finns inte tillräckligt med ingående delar: …" visas. Fyll på lagret (eller korrigera saldot) och rapportera igen.

Kontrollen gäller utstämpling i [stämpelterminalen](/hjalp/terminal) och på **Pågående arbete**, **Slutför** (operationen), **Slutför order** och **Förbruka** i kortet **Rapportera**, samt inleverans av legorader (se [Inleverans](/hjalp/inkop#inleverans)). **Ångra** påverkas inte — där läggs material tillbaka.

### Avrapportera operation

Kortet **Rapportera** har en rad per operation, sorterade efter sekvensnummer, och högst upp ett kort förklarande stycke. Kolumnrubrikerna (**Operation**, **Klart/Kvar**, **Antal klart**, **Kasserat**, **Faktisk tid (tt:mm)**) står en gång överst i kortet; på en mobil staplas raderna och varje fält har sin egen etikett. Kolumnen **Klart/Kvar** på en operation som **Väntar** visar **Klart** (antal OK som redan rapporterats, t.ex. från stämpelterminalen) och **Kvar** (orderns antal minus klart — kasserade enheter måste göras om och minskar inte Kvar), samt **Kasserat** när något kasserats; orderns planerade antal visas som tips när du håller muspekaren över siffrorna. På samma rad anges **Antal klart** (förifyllt med vad som **återstår** av orderns antal — delrapporter från stämpelterminalen räknas alltså inte dubbelt; är rutan **Rapportering** under **Rest som förslag i antalsfältet** i [System → Inställningar](/hjalp/system#installningar) omarkerad börjar fältet tomt, och **Slutför** säger då "Fyll i Antal klart innan du slutför operationen." om du lämnar det tomt utan att ange kasserat), **Kasserat** med **kassationsorsak** (obligatorisk när kasserat > 0; finns det [kvalitetsorsaker](/hjalp/kvalitet#kassation-och-orsaker) för kassation väljs en **Orsak** i listan och fritexten blir en valfri **Kommentar**) och eventuell **Faktisk tid**, sedan **Slutför**; fältet **Lagerplats för materialuttag** högst upp i kortet styr varifrån det kopplade materialet dras. En klar operation visas bara som text ("Klart 5 av 5 · Klar"). En lego-operation har samma **Slutför** som manuell väg och texten "Lego — avrapporteras vid inleverans". Operationen markeras **Klar** först när totalt **Antal OK** når orderns antal; rapporterar du färre ligger den kvar som **Väntar** och kan rapporteras vidare här eller i [stämpelterminalen](/hjalp/terminal). Kasserade enheter räknas inte — de måste göras om.

Under varje operation står dess kopplade material med artikelnummer, namn och förbrukat/planerat. Så länge något återstår finns ett fält **Antal** (förifyllt med det som återstår) och knappen **Förbruka** för ett manuellt uttag — även under en klar operation. Material utan operation ligger i gruppen **Vid slutrapportering** och dras när varorna levereras in. Ett fel visas direkt under den rad som misslyckades.

Material som är kopplat till operationen i beredningen (se [Artiklar](/hjalp/artiklar)) **dras automatiskt från lagret** för **antal OK + kasserat** — kasserade enheter förbrukar också komponenter:

- Order på 10 med 10 OK och 4 kasserade drar komponenter för 14 enheter.
- Rapporteras **fler** än orderns antal dras **mer** material — precis så mycket som det rapporterade kräver.
- Rapporteras färre dras materialet proportionellt.
- Har material redan förbrukats manuellt på raden fylls bara mellanskillnaden på — inget dubbeluttag.

Antalen kan också rapporteras löpande vid varje utstämpling i [stämpelterminalen](/hjalp/terminal); allt ackumuleras på operationen. Operationstabellen visar **Antal OK** och **Kasserat**, och varje kassation loggas med tid, antal, orsak och anställd i sektionen **Kassationer** på detaljsidan. Orsaken visas med namn ur kvalitetsorsakerna, följd av kommentaren; äldre kassationer visar sin fritext. Med rättigheten **Kvalitet** finns **Skapa avvikelse** på raden, som öppnar en ny [intern avvikelse](/hjalp/kvalitet#ny-avvikelse) med tillverkningsorder, operation, artikel och antal ifyllda. Tillverkningsordern har också sektionen **Avvikelser** med ärendena som gäller den och knappen **Ny avvikelse**.

### Inleverans från sista operationen

Antal OK som rapporteras på orderns **sista operation** (den med högst sekvensnummer) är färdiga varor och **läggs i lager direkt** — vid varje utstämpling i terminalen, vid **Slutför operation** här och när en lego-operation är sist och avrapporteras av inköpsorderns inleverans. Det gäller bara mellanskillnaden mot det som redan lagts in, så ingenting bokförs två gånger:

- Varorna hamnar på artikelns lagerplats (eller reservplatsen `***`) och värderas som vid **Slutför order**. Är en plats vald i **Lagerplats för materialuttag** läggs de i stället där.
- Material som **inte** är kopplat till någon operation dras i samma takt: med 4 av 10 inlevererade är 4/10 av det materialet draget.
- Kasserade enheter ger inget saldo.
- En **Frisläppt** order blir **Pågår** vid första inleveransen.
- När inlevererat antal når orderns antal blir ordern **Klar** av sig själv — historiken får raden **Slutförd** som vid **Slutför order**. Rapporteras fler än orderns antal läggs även de in. Operationer som inte hunnit rapporteras kan [efterrapporteras](#efterrapportera-pa-en-klar-order).
- Orderhuvudet visar **Inlevererat: 4 av 10** så snart något lagts in.

Rapporter på tidigare operationer lägger inte in något i lager.

I **Lagerplats för materialuttag** är standardvalet **"Automatiskt"** — varje komponent dras då från sin egen artikels lagerplats och sedan från andra platser med saldo; det som ändå inte räcker dras från artikelns lagerplats (eller reservplatsen `***`) och går minus där (se [Uttag med Automatiskt](/hjalp/lager#uttag-med-automatiskt)). Välj en specifik plats för att dra allt därifrån i stället — på den sista operationen tar platsen då även emot de färdiga varorna. En **spärrad** lagerplats visas i listan med *(spärrad)* och tar bara emot de färdiga varorna — materialet tas då med Automatiskt (se [Spärrade lagerplatser](/hjalp/lager#sparrade-lagerplatser)). En komponent som tas från flera platser ger en materialrad per plats i [Rapporteringar](#rapporteringar-och-angra). Materialtabellen visar i kolumnen **Operation** vilken operation som drar varje rad, eller **Vid slutrapportering** för okopplat material.

### Avsluta

- **Slutför order** stänger ordern: ange antal och lagerplats (standard: artikelns — utan val läggs de färdiga varorna på artikelns lagerplats och okopplat material tas enligt **Automatiskt**; väljer du en plats gäller den för båda) — **Antal** är det som läggs i lager **nu**, utöver det som redan inlevererats från sista operationen, och förifylls med det som återstår av orderns antal. Material som **inte** är kopplat till någon operation dras upp till det totalt inlevererade antalet, och ordern blir **Klar**. Raden **Slutför order** i kortet **Rapportera** finns så snart ordern är **Frisläppt**. Skulle ordern stängas innan hela antalet är inlevererat frågar Nav först ("Ordern stängs med 0 av 5 st inlevererade … Stäng ordern ändå?"). Har kassationer gjort att sista operationen aldrig nådde orderns antal anger du **0** för att stänga ordern utan mer inleverans. En order vars sista operation nått orderns antal är redan **Klar** och behöver inte slutföras. En order som stängts av misstag öppnas igen med **Ångra** på raden **Slutför order** under [Rapporteringar](#rapporteringar-och-angra).
- **Stäng order** avslutar en Klar order; därefter går ingenting att ångra eller [efterrapportera](#efterrapportera-pa-en-klar-order). Nav frågar därför först.

### Efterrapportera på en klar order

En order blir **Klar** så snart hela antalet är inlevererat — även om tidigare operationer aldrig rapporterades. Fram till **Stäng order** går det att efterrapportera på den, så att efterkalkylen får med operationernas antal, tid och material:

- Kortet **Rapportera** finns kvar, med **Slutför** på de operationer som fortfarande **Väntar**. Texten överst säger att ordern är klar: antal OK, kasserat och materialet som är kopplat till operationen bokförs som vanligt, men inga fler färdiga varor läggs in i lager — inte heller från sista operationen. Ska fler varor in ångrar du först den rapportering som gjorde ordern klar (se [Rapporteringar och Ångra](#rapporteringar-och-angra)).
- **Förbruka** och **Rapportera tid** fungerar som på en order som pågår; raden **Slutför order** visas inte.
- En lego-operation som inlevereras på inköpsordern efter att tillverkningsordern blivit klar avrapporteras på samma sätt.
- Ordern förblir **Klar**, och efterrapporteringen syns under [Rapporteringar](#rapporteringar-och-angra) och kan ångras som vilken rad som helst.
- [Stämpelterminalen](/hjalp/terminal) visar inte en klar order — efterrapporteringen görs på TO-kortet.

### Rapporteringar och Ångra

Sektionen **Rapporteringar** på detaljsidan listar allt som rapporterats på ordern, senaste först: **Utstämpling** (varje utstämpling i terminalen, även en utan antal), **Slutför operation**, **Inleverans IO-…** (en lego-operation som avrapporterats av inköpsorderns inleverans), **Materialuttag** (**Förbruka** för hand), **Slutför order**, **Automatisk utstämpling** — tiden för någon som stämplades ut när operationen eller ordern blev klar (se [Pågående arbete](#pagaende-arbete)); den kan ångras som en vanlig utstämpling — **Rättad stämpling**, en stämpling som rättats eller lagts till i efterhand under [Personal & lön → Stämplingar](/hjalp/lon#stamplingar), och **Manuell rapport**, tid och antal som rapporterats under [Tillverkning → Rapportera](#rapportera). Varje rad visar operation, **OK**, **Kasserat**, **Inlevererat**, stämplingens **Timmar**, vem som rapporterade och vilket material som drogs, med lagerplats. En **tjänst** i strukturen bokas som förbrukad utan lagerplats och utan att något dras från lagret — [tjänster lagerförs inte](/hjalp/artiklar#artikeltyper) — men räknas i efterkalkylen och i produkter i arbete som annat material.

Direkt efter **Slutför** på en operation i kortet **Rapportera** visar Nav en notis nere till höger, t.ex. *Rapporterat 5 OK på 10 — Laserskärning.* För administratörer och arbetsledare har den **Ångra**, som backar just den rapporteringen utan någon extra fråga. Samma sak gäller de andra raderna i kortet:

- **Förbruka** — *Förbrukat 2 st 1002.*; **Ångra** lägger tillbaka materialet där det togs (och i samma batch om komponenten är batchstyrd).
- **Slutför order** — *Ordern är slutförd — 5 st inlevererade.*; **Ångra** tar ut det som lades in, lägger tillbaka materialet och öppnar ordern igen.
- **Rapportera tid** — *Rapporterat 1,5 h för Anna på 10 — Laserskärning.*; **Ångra** tar bort tidrapporten (inte i en låst löneperiod — då står det i notisen).

**Ångra** backar exakt det den raden bokförde, i ett svep — Nav visar först vad som kommer att hända:

- Antal OK och kasserat dras av från operationen och kassationsraden tas bort. Operationen blir **Väntar** igen om den inte längre täcker orderns antal.
- Materialet som drogs läggs tillbaka på den lagerplats det togs från — drogs en komponent från flera platser läggs varje del tillbaka där den togs.
- Färdiga varor som lades i lager tas ut från samma lagerplats. Finns de inte kvar där — de har t.ex. redan levererats — går raden inte att ångra.
- Utstämplingens tid tas bort. Ligger tiden i en låst löneperiod går raden inte att ångra.
- En **Klar** order öppnas igen (**Pågår**, eller **Frisläppt** om inget längre är rapporterat).

En ångrad rad ligger kvar i listan, överstruken och märkt **Ångrad** med tid och vem som ångrade. **Ångra** kräver rollen admin eller arbetsledare. En **Inleverans IO-…** ångras inte här utan hör till inköpsordern (**Ångras på IO**) — ångra inleveransen på inköpsorderkortet, så backas rapporteringen samtidigt (se [Ångra inleverans](/hjalp/inkop#angra-inleverans)). Det som rapporterades innan loggen fanns (oktober 2026) visas som en samlad rad per operation, **Rapporterat före loggen**, och kan ångras på samma sätt.

### Makulera order

**Makulera order** finns på detaljsidan och i listan så länge ordern är Planerad, Frisläppt eller Pågår. Den går bara att makulera när inget är bokfört på den: finns det rapporteringar med antal, material eller inleverans ångrar du dem först under [Rapporteringar](#rapporteringar-och-angra), och är någon instämplad måste den stämplas ut. Utstämplingar utan antal hindrar inte — tiden har ju lagts ned. En makulerad order kan inte återöppnas.

| Status | Betydelse |
|---|---|
| Planerad | Skapad men inte frisläppt; material/operationer ännu inte snapshotade. Nya ordrar frisläpps när de skapas, så statusen gäller bara äldre ordrar |
| Frisläppt | Materiallista och operationer fastställda |
| Pågår | Arbete pågår |
| Klar | Färdigrapporterad — inlevererad till lager; operationer, material och tid kan [efterrapporteras](#efterrapportera-pa-en-klar-order) |
| Stängd | Avslutad — inget mer kan rapporteras |
| Makulerad | Makulerad — inget tillverkas på ordern |

### Efterkalkyl

**Efterkalkylera** på orderns detaljsida räknar fram vad ordern faktiskt kostade: verklig materialförbrukning gånger komponenternas pris, och den tid som verkligen rapporterats på varje operation gånger timkostnaden den dag tiden arbetades (tidrapportens **Datum**) för resursen tiden gjordes på. Rapporteras tid på flera dagar med olika timkostnad räknas varje dag för sig, och specifikationen visar **Timkostnad** som snittet för operationen. Har operationen [bytt resurs](#andra-material-och-operationer) efter att tid rapporterats får den en rad per resurs: tiden som gjordes på den gamla resursen står kvar där, med dess timkostnad och TO-påslag. Tid som rapporterades innan Nav började spara resursen på tidrapporten räknas på operationens nuvarande resurs. En ändrad timkostnad gäller hela dagen den ändrades och framåt, så tid som redan arbetats behåller sin timkostnad även om du efterkalkylerar om senare (se [Resurser](#resurser)). Den använder samma påslag som förkalkylen men en egen materialkälla, **Materialkostnad i efterkalkylen** — båda ställs in under **System → Kalkyler**, se [System & inställningar](/hjalp/system#kalkyler). Med standardpris eller leverantörspris räknas materialet till priset (och valutakursen) som gällde när det togs ut på ordern, så efterkalkylen ger samma svar om den görs om senare. Har en operation ingen rapporterad tid visas en varning; kalkylen räknar då den operationen som 0 kronor.

**Efterkalkylera** sparar ingenting av sig själv: beräkningen visas i panelen **Efterkalkyl** under verktygsraden som hela kedjan från direkt material till försäljningspris, tillsammans med eventuella varningar. Klicka **Spara kalkyl** för att lägga den som en ny rad under **Kalkyl** på kortet, med antal, material, lego, lön, självkostnad och försäljningspris — då öppnas **Kalkylspecifikation** automatiskt. **Stäng** tar bort panelen utan att spara. Klicka på **Efterkalkyl** i typkolumnen för att öppna specifikationen igen; se avsnittet med samma namn under [Artiklar](/hjalp/artiklar#kalkyl) för vad den innehåller. Kolumnen **Per st** i panelen är delad med det inlevererade antalet och visas först när ordern är klar.

En sparad efterkalkyl kan **inte** tas bort — den är orderns facit. Förkalkyler går att ta bort, se [Artiklar](/hjalp/artiklar#kalkyl).

Står materialkällan på **Verklig kostnad** värderas materialet till vad det faktiskt kostade — glidande medelpris vid förbrukningstillfället, härlett ur lagerloggen i stället för läst ur artikelns standardpris. Då mäter [Kalkylutfall](/hjalp/rapporter#kalkylutfall) hela skillnaden mot förkalkylen i både pris, mängd och tid. I [Avvikelseanalys](#avvikelseanalys) nedan prissätts kalkylerat med förkalkylens materialkälla och utfallet med efterkalkylens, så **Pris** visar också skillnaden mellan de två sätten att värdera materialet. Se [System & inställningar](/hjalp/system#kalkyler).

#### Avvikelseanalys

Under kedjan i panelen visas **Avvikelse mot kalkylerat**: vad ordern kostade jämfört med vad den borde ha kostat, delat i orsaker. Samma analys står sparad med efterkalkylen och visas som avsnittet **Avvikelseanalys** i **Kalkylspecifikation** (se [Artiklar](/hjalp/artiklar#kalkyl)).

- **Kalkylerat** är orderns egna rader — materiallistan och operationerna som de ser ut när du efterkalkylerar — för det antal som faktiskt **inlevererats**. Materialet prissätts som förkalkylen gör det, med förkalkylens materialkälla, per den dag ordern skapades. Den dagen kallas T₀ och står i specifikationen. En senare prisändring på en artikel ger därför ingen avvikelse mot kalkylerat, och en sparad efterkalkyl ändras aldrig i efterhand. Har du ändrat material eller operationer på ordern (se [Ändra material och operationer](#andra-material-och-operationer)) är ändringen den nya planen: kalkylerat räknas på raderna som de är nu. Hur ordern avviker från artikelns förkalkyl visas i [Kalkylutfall](/hjalp/rapporter#kalkylutfall).
- **Utfall** är efterkalkylens rader. **Avvikelse** är Utfall minus Kalkylerat: ett positivt belopp betyder att ordern blev **dyrare** än kalkylerat, ett negativt att den blev billigare. Beloppen visas med tecken och färg, och tecknet säger detsamma som färgen.
- **Pris** är skillnaden i à-pris gånger den förbrukade mängden — för material, tjänsteartiklar och lego (à-pris, ställ- och transportpris och kurs). **Mängd** är skillnaden i förbrukad mängd gånger kalkylerat à-pris, kassation inräknad. **varav kassation** visar den del av Mängd som de kasserade enheterna drog; den ingår i Mängd och läggs inte till en gång till. varav kassation kan vara större än Mängd: förbrukades resten av materialet under det kalkylerade, drar den delen ned Mängd medan kassationen står kvar.
- **Timpris** är skillnaden i timkostnad: lönen till timkostnaden de dagar tiden arbetades mot samma timmar till timkostnaden vid T₀. Den visas bara när någon operation har en sådan skillnad, till exempel när resursens timkostnad har höjts efter att ordern skapades, eller när tid gjordes på en annan resurs än den operationen har nu. Kalkylerat bygger då på den nuvarande resursen (bytet är en ny plan), och raden för den gamla resursen har ingen planerad tid: skillnaden mellan resursernas timkostnad hamnar i Timpris, resten av den tiden i tidsavvikelsen.
- **Ej uppdelad** är tidsavvikelsen: rapporterad tid mot planerad ställ- och stycktid, värderad till timkostnaden vid T₀. Tid som registrerats som **Ställ** och **Produktion** (se [Tidrapporter](#tidrapporter)) delas i **Ställ** och **Stycke** i stället: ställavvikelsen är verklig ställtid mot planerad, och resten av tidsavvikelsen är stycke. Är någon tid på operationen utan typ delas inte operationens tidsavvikelse alls: hela den hamnar under **Ej uppdelad**, och **Ej uppdelad (h)** är då alla timmar på operationen. Specifikationen visar planerad och verklig ställtid och stycktid per operation. Rapporterade timmar är bara **Verklig tid** — fältet **Faktisk tid** på operationen läses inte.
- **Påslag** är skillnaden i MO- och LO-påslag, som följer av materialet och legot. Samma procent gäller på båda sidor, så påslaget har ingen egen orsak och delas inte upp. TO-påslaget ingår inte, eftersom det ligger utanför tillverkningskostnaden.
- Delarna summerar alltid till avvikelsen: **Pris + Mängd + Timpris + Ställ + Stycke + Ej uppdelad + Påslag = Avvikelse** (tidsavvikelsen ligger antingen under Ställ och Stycke eller under Ej uppdelad, per operation). **Utfall** är exakt tillverkningskostnaden (TVK) i kedjan, och **Kalkylerat** räknas fram på samma sätt ur de kalkylerade raderna. Varje rad avrundas till öre för sig, och öresresten mellan radernas summa och tillverkningskostnaden räknas in i **Påslag** på båda sidor. En order som gick exakt som kalkylerat har därför Påslag 0, men när raderna avviker kan Påslag visa några öre även utan MO- och LO-påslag.
- Är ordern inte **Klar**, **Stängd** eller **Makulerad** står *Ordern är inte klar — kalkylerat räknas på klart antal per operation.* Då räknas varje operations tid, lego och kopplade material på antalet som operationen rapporterats klart, så pågående arbete inte syns som avvikelse. Kalkylerat är då inte slutgiltigt.
- En **Makulerad** order räknas som slutlig på det inlevererade antalet, normalt 0. Tid som rapporterats på den finns kvar efter makuleringen, och den syns då som avvikelse: ställtiden räknas som kalkylerad när operationen har arbetats, resten är Ej uppdelad (eller Ställ och Stycke när tiden har typ).
- En legooperation utan inlevererad inköpsorder räknas i efterkalkylen på styckpris gånger klart antal, plus ställ- och transportpris när operationen har arbetats eller ordern är klar med något inlevererat. Kalkylerat tar ställ- och transportpriset efter samma regel. En legooperation som inte har arbetats kostar alltså ingenting och ger ingen avvikelse, inte heller på en makulerad order eller en order som stängts med 0 inlevererade.
- Material som saknas (planerat men aldrig draget) ger en negativ Mängd. En kortstängd order värderas på det som inlevererats, så ett kasserat eller aldrig tillverkat antal blir avvikelse.
- En efterkalkyl som sparades innan analysen fanns saknar den: specifikationen säger *Sparad före avvikelseanalysen — efterkalkylera och spara igen för att få den.* Det går bra, för alla efterkalkyler sparas som nya rader.

Efterkalkylen räknar aldrig om underliggande nivåer. **Räkna om underliggande nivåer** hör till förkalkylen (se [Artiklar](/hjalp/artiklar#kalkyl)): ett halvfabrikat som ordern faktiskt förbrukat är en riktig lagerförd artikel som tagits in till ett pris, och det priset är vad efterkalkylen ska visa.

Kalkylen räknas aldrig om i efterhand: ändrar du inställningar gäller det från nästa beräkning, och gamla kalkyler står kvar med de påslag de kördes med. En ändrad timkostnad gäller från den dag den ändrades, så den påverkar bara tid som arbetas från och med den dagen.

### Efterkalkylera flera

**Tillverkning → Efterkalkylera flera** (`/tillverkning/efterkalkylera`) efterkalkylerar många tillverkningsordrar i ett svep: du väljer ett urval, tittar på hur varje order avviker mot kalkylerat och sparar de efterkalkyler du vill behålla. Varje order räknas exakt som med **Efterkalkylera** på TO-kortet (se [Efterkalkyl](#efterkalkyl)). Sidan kräver behörigheten **Tillverkning**; ett läskonto kan titta på urvalet men inte spara.

#### Urval

- **Senaste inleverans från** och **till** — datumen (inklusive) då ordern senast togs in till lager, räknat som svenska dagar. En ångrad inleverans räknas inte. Ordrar som aldrig fått något inlevererat, till exempel en makulerad, faller utanför ett datumurval.
- **Artikel** — en enskild artikel, eller **Artikelnummer från/till** för ett intervall (båda inklusive, tecken för tecken som i artikelregistret). Välj ett av dem: har du valt en artikel används inte intervallet.
- **Varugrupp**.
- **Status** — kryssrutor för **Planerad**, **Frisläppt**, **Pågår**, **Klar**, **Stängd** och **Makulerad**. Förvalt är **Klar** och **Stängd**, och minst en status måste vara vald. En order som inte är klar får en preliminär efterkalkyl: **Kalkylerat/st** och **Efterkalkyl/st** visas som *Ej klar*, men raden kan sparas.

Högst 500 ordrar kan efterkalkyleras åt gången. Blir urvalet större visas ett felmeddelande och ingenting beräknas — snäva in det med datum, artikel eller varugrupp.

**Visa urval** listar ordrarna som urvalet träffar — **TO-nummer** (länk till ordern), **Artikel**, **Status**, **Senaste inleverans** och om ordern redan har en sparad **Efterkalkyl** — utan att räkna något. Överst står hur många ordrar urvalet har (*Urvalet har 12 ordrar*). Ändrar du urvalet försvinner listan; **Dölj** stänger den.

#### Tabellen

Klicka **Efterkalkylera** (knappen visar **Beräknar…** medan det pågår). Inget sparas ännu. Tabellen har en rad per order:

- **TO-nummer** (länk till TO-kortet), **Artikel**, **Status** och **Senaste inleverans**.
- **Inlevererat** — det antal som per styck-siffrorna delas med.
- **Kalkylerat/st** — ordens kalkylerade kostnad per styck: samma **Kalkylerat** som [Avvikelseanalys](#avvikelseanalys) på TO-kortet visar, alltså ordens egna rader prissatta den dag ordern skapades. Det är alltså inte artikelns senaste förkalkyl.
- **Efterkalkyl/st** — vad ordern faktiskt kostade per styck (tillverkningskostnaden).
- **Avvikelse/st** — Efterkalkyl minus Kalkylerat, i kronor och procent av Kalkylerat. Positivt betyder att ordern blev dyrare än kalkylerat. Saknas någon sida, eller är Kalkylerat 0, står *—* eller bara beloppet.
- **Senaste efterkalkyl** — datum och tid för orderns senaste sparade efterkalkyl, om det finns någon.

En order som inte går att räkna visar felet på raden och kan inte markeras; varningar från efterkalkylen står under artikeln. Alla ordrar är markerade när tabellen visas, utom de som redan har en sparad efterkalkyl — vill du spara en ny för dem markerar du dem själv. Kryssrutan i rubriken markerar eller avmarkerar alla.

#### Spara markerade

**Spara markerade (N)** sparar en ny efterkalkyl för varje markerad order, precis som **Spara kalkyl** på TO-kortet — den räknas om vid sparandet. Resultatet visar hur många som sparades och, för de ordrar som inte gick, vilket fel det blev; övriga sparas ändå. Därefter räknas tabellen om så att **Senaste efterkalkyl** visar det som just sparades, och inget är markerat, så ett andra klick inte sparar samma kalkyler igen. Sparade efterkalkyler kan inte tas bort, se [Efterkalkyl](#efterkalkyl).

**Inga priser sätts.** Spara markerade sparar bara efterkalkylerna under **Kalkyl** på respektive artikel; standardpris och försäljningspris sätts fortfarande från en enskild kalkyl på artikelkortet.

### Täcks av och Går till

I tabellen **Material** på TO-kortet visar kolumnen **Täcks av** vad som täcker varje materialrad, en rad per källa: *Lager*, *IO-123 · 2026-11-20* (en inköpsorder i utkast står som *(utkast)*) eller *TO-456 · 2026-11-18*. Ordernumren är länkar till kortet. Det som ingenting täcker står som *Saknas 12 st*. Täcks raden av flera källor, eller delvis, visas antalet på varje rad. Kommer en källa efter att materialet behövs står *N dagar för sent* i varningsfärg, och saknar den datum står *saknar datum*. Lagret är aldrig sent.

Sektionen **Går till** visar åt andra hållet vilka behov ordern själv täcker: kundorder eller tillverkningsorder, **Behovsdatum**, **Antal** och *N dagar för sent* när ordern inte hinner. Det som blir över står som *Till lager 10 st*, och ett negativt lagersaldo visas som *Negativt lagersaldo*. Sektionen visas så länge ordern har något kvar att tillverka.

Kopplingen är härledd — den räknas fram varje gång kortet visas och ingenting är reserverat. Den kan därför ändras när ett tidigare behov kommer in: lager och ordrar fördelas på behoven i datumordning, det tidigaste behovet först.

Länken **Visa strukturen** vid rubriken **Material** öppnar [Struktur](#struktur): hela trädet under ordern — halvfabrikatens tillverkningsordrar med sitt eget material, nivå för nivå — med de planerade dagarna på en dagaxel.

### Halvfabrikat sent

Märket **Halvfabrikat sent** visas på TO-kortet (bredvid **Sen**), i listan **Tillverkning → Ordrar** och i Beläggningen när en tillverkningsorder för ett halvfabrikat som ordern behöver blir klar efter att behovet uppstår. Det gäller frisläppta och pågående ordrar — samma ordrar som kan bli **Sen**. Halvfabrikatets klardatum är planens slutdatum, annars **Planerat färdigdatum** — samma datum som avgör **Sen**. Lager är aldrig sent, och en sen inköpsorder eller saknat inköpsmaterial ger inget märke (kortet visar dem i **Täcks av**). Filtrera listan med statusvalet **Halvfabrikat sent**.

### Flytta halvfabrikaten

Knappen **Flytta halvfabrikaten…** (behörighet Tillverkning, bara på en öppen order) finns när något halvfabrikat bör få nytt färdigdatum. Dialogen **Flytta halvfabrikaten** listar tillverkningsordrarna med indrag per nivå — halvfabrikatets egna halvfabrikat står under det — med **Nuvarande färdigdatum** och **Föreslaget färdigdatum** och en kort orsak: *Sen för ordern*, *Behövs tidigare*, *Kan bli klar senare* eller *Saknar färdigdatum*.

Förslaget är arbetsdagen före det tidigaste behovet bland alla behov ordern täcker, så en flytt gör aldrig ordern sen för ett annat behov. Går en order också till andra behov står *går också till andra behov* och den är inte förvald. *hinner inte* betyder att förslaget är första möjliga dag med ledtiden och ändå ligger efter behovet. En sen order vars färdigdatum redan ligger före behovet får inget förslag — då är det planen eller kapaciteten som gör den sen.

Avmarkerar du en rad avmarkeras och inaktiveras de ordrar som hör under den. Tryck **Flytta** (avstängd utan markerade rader) och bekräfta. Bara **färdigdatum** ändras: kör **Planera** i Beläggningen för att lägga om dagarna, som dialogen påminner om. Har något datum ändrats under tiden visas ett felmeddelande och raderna läses in på nytt.

### Skapa saknade halvfabrikat

Knappen **Skapa saknade halvfabrikat…** (behörighet Tillverkning) finns när ett tillverkat material ingenting täcker. Dialogen **Skapa saknade halvfabrikat** visar hela trädet med indrag per nivå: artikelnummer och benämning, **Antal** och **Färdigdatum** (*hinner inte* när datumet inte räcker, *saknar datum* när behovet saknar datum). Nedanför står noteringar — till exempel inköpta artiklar som saknas, de skapas inte här utan syns i Behovsberäkningen, och inaktiva artiklar (*… är inaktiv — ingen tillverkningsorder*). [Prognos](/hjalp/lager#prognos) räknas inte som behov här: ett halvfabrikat med saldo på hyllan får ingen ny order bara för att prognosen skulle förbruka saldot.

Antalet nettas som i Behovsberäkningen: lager och befintliga ordrar dras av, ordermultipel och **Avrundning** tillämpas. Bara tillverkade artiklar får en order; hela strukturen skapas i ett svep. **Skapa N tillverkningsordrar** skapar dem, och beskedet listar de nya ordernumren (länkar) och eventuella varningar. Har läget ändrats sedan förhandsvisningen — någon annan skapade en order, eller behovet föll bort — skapas ingenting utan dialogen visar den nya förhandsvisningen.

### Ritningar och revisioner

När ordern frisläpps sparas vilka revisioner den byggs efter: artikelns aktiva revision och varje ritnings aktiva revision med dess fil (se [Revisioner](/hjalp/artiklar#revisioner)). Kortet **Ritningar** på tillverkningsordern visar dem — **Artikelrevision**, en rad per ritning med **Revision** och **Fil** (länken öppnar filen) och artikelns **Övriga filer**. Utskriften, legoinköpets mejl och terminalen använder samma revisioner, även om en nyare aktiveras sedan.

- **Ny revision sedan frisläpp.** Har en ny revision aktiverats, en ritning tillkommit eller tagits bort efter frisläppet står det ovanför tabellen, och kolumnen **Gällande nu** visar den nya revisionen med länk till dess fil (*samma* när inget ändrats).
- **Uppdatera till gällande revisioner** (frisläppt eller pågående order) låter ordern ta de gällande revisionerna efter en bekräftelse. Ändringen loggas i orderns historik som **Revisioner uppdaterade** med raden före och efter.
- En äldre order som redan var klar eller stängd när revisionerna började sparas har inga sparade revisioner och visar de gällande.
- Kortet visas inte när artikeln saknar både revisioner, ritningar och filer.

### Skriv ut TO

**Skriv ut TO** överst på tillverkningsorderns detaljsida öppnar utskriftsdialogen för underlaget som lämnas till operatören (se [Utskrifter](/hjalp/komma-igang#utskrifter)); **Ladda ner PDF** bredvid sparar samma underlag som fil:

- Företagsuppgifter och logotyp, ordernummer, status, artikel och antal att tillverka samt eventuell anteckning.
- Är ordern skapad från en kundorderrad (se [Skapa från kundorder](#skapa-fran-kundorder) ovan) visas raden **Kundorder:** med kundorderns ordernummer och kundens namn.
- **Operationer** med ställtid, stycktid, beräknad tid och en signaturkolumn att bocka av i. Kolumnen **Operation** visar resursens tresiffriga kod följd av operationens **Beskrivning** — saknas beskrivning står resursens namn där i stället (se [Artiklar](/hjalp/artiklar#beskrivning-pa-operationen)). Har operationen en **Kommentar** som är märkt **Skriv ut på arbetskortet** skrivs texten under sin operationsrad (se [Artiklar](/hjalp/artiklar#kommentar-pa-operationen)). Har operationen en **Packinstruktion** skrivs den **alltid** ut under operationsraden med prefixet "Packning: ", oavsett om **Skriv ut på arbetskortet** är ikryssad (se [Artiklar](/hjalp/artiklar#packinstruktion-pa-operationen)). Beskrivningen, kommentaren och packinstruktionen är de som gällde när ordern frisläpptes. Stycktid visas i den enhet operationen bereddes i — "7 st/h" i stället för "8,5714 min" när beredningen är växlad till **st/h**, och "45 sek" i stället för "0,75 min" när den är växlad till **sek/st** (se [Tidsenhet på operationen](/hjalp/artiklar#tidsenhet-pa-operationen)); beräknad tid är alltid i minuter, eftersom den är en totalsumma, inte en hastighet. Tiderna skrivs med högst två decimaler och utan onödiga nollor — "10 min", "6 min" och "8,57 min".
- **Material** med enhet, planerat och uttaget antal (i radens enhet) plus signaturkolumn, samt en rad för "Utförd av / Datum". Kolumnen **Op** visar sekvensnumret för operationen som drar materialet (motsvarande materialtabellens kolumn **Operation**, se [Avrapportera operation](#avrapportera-operation) ovan) — ett streck ("—") betyder att materialet dras vid slutrapportering i stället. Materialraderna är sorterade efter denna operation, sedan artikelnummer.
- Raden med revisionerna ordern byggs efter under artikeln, t.ex. *Revision B · Ritningar: R-1001 rev 2, R-1002-SVETS rev A* (se [Ritningar och revisioner](#ritningar-och-revisioner)), och under en operation med valda ritningar eller filer raden *Ritning: R-1002-SVETS rev A · Fil: monteringsanvisning.pdf*.
- **Ritningarna** läggs sist i dokumentet — PDF:er som extra sidor, JPEG/PNG som en sida var: filerna på de ritningsrevisioner ordern byggs efter och artikelns filer under fliken Filer (se [Artiklar](/hjalp/artiklar#filer)). En äldre revisions fil skrivs inte ut.

I stämpelterminalen heter samma utskrift **Skriv ut arbetsorder**, och terminalen kan skriva ut den av sig själv när någon stämplar in, se [Skriv ut arbetsorder](/hjalp/terminal#skriv-ut-arbetsorder).

Ordern kan skrivas ut i alla statusar. En äldre order som står kvar som **Planerad** har ännu inte fått någon materiallista eller några operationer, och då står det i dokumentet att operationer respektive material saknas (*Inga operationer — ordern är inte frisläppt än.* och *Inget material — ordern är inte frisläppt än.*). En order för en beställningsvara får däremot sina operationer och sitt material redan när den skapas (se [Tillverkningsorder för beställningsvara](#tillverkningsorder-for-bestallningsvara)), så den skrivs ut med dem i alla statusar.

### Pallkort

Ett **pallkort** är lappen som läggs på pallen när en operation rapporterats. Det skrivs ut på **övre halvan** av ett stående A4 så att arket kan vikas på mitten (en streckad viklinje visar var) och hela kortet syns på pallen. Överst står företagets logotyp, under den ett inramat kort med ett svart rubrikband: **PALLKORT** till vänster och till höger **TILL KUND** eller **INTERNT**, beroende på var pallen är på väg:

- **Sista operationen** på en order som är skapad från en kundorderrad (se [Skapa från kundorder](#skapa-fran-kundorder) ovan): pallen är klar för kund (**TILL KUND**). Kortet visar **Artikelnummer**, **Benämning**, **Kund**, **Leveransadress** (när kundordern har en vald leveransadress), **Kundens ordernummer** (ett streck när kundordern saknar sådant), **Vårt kundordernummer** och **Antal**.
- **Övriga operationer** (och sista operationen på en order utan kundorderkoppling): pallen går vidare internt (**INTERNT**). Kortet visar **Artikelnummer**, **Benämning**, **Tillverkningsorder**, **Nästa operation** (sekvensnummer och beskrivning; ett streck när ingen operation följer) och **Antal**.

Längst ner i ramen står **Datum** (när rapporteringen gjordes), **Rapporterad av** (utelämnas när rapportören är okänd) och **Referens** (tillverkningsordern och operationen). Beroende på inställningen **Kod på pallkort** (se [Inställningar](/hjalp/system#installningar) och kundkortets fält **Kod på pallkort**) får artikelnumret och ordernumret även en **Streckkod** (Code 128) eller en **QR-kod**; med **Ingen** trycks inga koder. En streckkod ritas inte för ett nummer med å, ä eller ö.

Pallkortet öppnas **automatiskt i en ny flik** efter en lyckad **Slutför** på en operationsrad i kortet **Rapportera** på orderns detaljsida, med det antal som just rapporterades — och på samma sätt efter en utstämpling **med antal** (**Antal OK** > 0) i [stämpelterminalen](/hjalp/terminal); en utstämpling utan antal öppnar inget kort. Det automatiska kortet är rapporteringens eget och bär därför rapporteringens tid och rapportör. Blockerar webbläsaren fliken, eller behöver du fler kort eller ett annat antal, finns det två vägar för omutskrift:

- **Pallkort** i operationsradens **⋯**-meny i operationstabellen (i läsläge och på en klar order knappen **Pallkort** på raden) öppnar dialogen **Pallkort**. **Totalt antal** är förifyllt med operationens **ackumulerade** antal OK (orderns antal när inget är rapporterat än). Ange **Antal kolli** (1–50): totalen fördelas jämnt på en lista **Kolli 1**, **Kolli 2** … där du kan skriva eget antal per kolli (varje kolli blir ett kort, och kortet visar alltid vilket kolli det är, t.ex. "Kolli 2 av 3" — även "Kolli 1 av 1" när bara ett kort skrivs ut, också vid den automatiska utskriften). En rad under listan visar om kollina stämmer med totalen, hur många som är **kvar att fördela** eller hur många som är **för mycket**, och om något kolli saknar antal (*Varje kolli måste ha ett antal*). **Skriv ut** är avstängd när något kolli saknar antal, och även när kollina inte stämmer med totalen — om inte systeminställningen **Tillåt utskrift av pallkort även om kollina inte stämmer med totalt antal** är på (se [Inställningar](/hjalp/system#installningar)). Klicka **Skriv ut** för att öppna PDF:en i en ny flik, eller **Avbryt**.
- Knappen **Pallkort** på en rad i sektionen **Rapporteringar** skriver ut kortet för just den rapporteringen, med rapporteringens antal, tid och rapportör; samma dialog med kolli gäller. Knappen finns på operationsrapporter med **OK** större än 0 som inte är ångrade.

Ordern måste ha operationer: en äldre, ännu inte frisläppt order som står kvar som **Planerad** har inga att skriva kort för (en order för en beställningsvara har sina operationer redan när den skapas). Du kan skriva ut pallkort även med en användare som bara har läsrättighet.

Även utleveransen skriver pallkort — se [Utleverans](/hjalp/forsaljning#utleverans).

Sektionen **Historik** längst ner på orderkortet visar orderns egna händelser (statusövergångar och ändringar av leveransdatum/produktionsgrupp) — se [Händelselogg](/hjalp/system#handelselogg). Första raden är **Skapad**, med artikelnummer, antal, planerat färdigdatum och kundordern ordern skapades för. Den följs direkt av **Frisläppt**, eftersom en ny tillverkningsorder frisläpps när den skapas. Det gäller alla sätt att skapa en order: **Ny tillverkningsorder**, **Skapa TO** på kundorderraden, **Skapa ordrar** i behovsberäkningen, Leveranstidskontrollens reservation och **Skapa saknade halvfabrikat**. Ordrar som skapades före 2026-11-08 har bara raden **Frisläppt**.

## Behovsberäkning

**Tillverkning → Behovsberäkning** räknar fram nettobehovet per artikel och föreslår inköps- och tillverkningsordrar. Allt beräknas ur order- och lagerdata — inget behov lagras i databasen. Strukturrader märkta **Kalkyl** ger inget behov (se [Kalkylrader i strukturen](/hjalp/artiklar#kalkylrader-i-strukturen)).

Beräkningen omfattar alla artiklar på en gång, så resultatet **återanvänds i upp till en minut**: att bläddra, söka eller filtrera i listan räknar inte om allt. Längst till höger i verktygsraden står när resultatet beräknades (**Beräknad 08:12:03**). Har något ändrats — t.ex. en kundorder eller inleverans som just registrerats — klickar du **Uppdatera** för att räkna om direkt. **Uppdatera** börjar också om rutinen, som om du öppnat den på nytt: korten **Skapade ordrar** och **Skapade förfrågningar** försvinner, medan dina val och antal står kvar enligt nedan. Efter **Skapa ordrar** och **Skapa förfrågan** räknas listan alltid om automatiskt (korten står då kvar), och efter **Skapa saknade halvfabrikat**, **Flytta halvfabrikaten** och Leveranstidskontrollens **Använd datumet** räknas den om nästa gång den öppnas.

### Vad som räknas

För varje artikel ställs behov mot saldo och inkommande:

- **Behov** är summan av: kundorderrader i status **Bekräftad** eller **Under tillverkning** (beställt minus levererat), materialrader på frisläppta tillverkningsordrar och ordrar som Pågår (planerat minus uttaget), samt material till **Planerad** tillverkningsorder (beräknat ur strukturen, eftersom materialet snapshotas först vid frisläpp). **Offerter räknas inte som behov.**
- **Inkommande** är summan av: inköpsorderrader i status **Skickad**/**Bekräftad**/**Delvis mottagen** (beställt minus mottaget), inköpsorder i status **Utkast** (särredovisas som IO-utkast — så att redan skapade orderförslag inte föreslås igen), och tillverkningsordrar i status **Planerad**/**Frisläppt**/**Pågår** (orderns antal minus det som redan inlevererats från sista operationen — det ligger redan i saldot).
- **Netto** = saldo − behov + inkommande. **Saldo** räknar inte lagerplatser som är [spärrade](/hjalp/lager#sparrade-lagerplatser). Fantomartiklar och tjänsteartiklar ingår aldrig; inaktiva artiklar visas med märket **Inaktiv** men får inga förslag.

### Prognos som behov

För en **Prognosstyrd** artikel (se [Prognos](/hjalp/lager#prognos)) räknar behovsberäkningen in prognosbehovet per månad som en egen typ av **Behov**, vid sidan av kundorder och material. I kolumnen **Behov** står då *varav prognos N* under summan, och tipset på siffran listar fördelningen. Prognosen **förbrukas** av kända order och material i månaden och — här i behovsberäkningen — även av härlett behov från förslag på överordnade artiklar, så den läggs bara på det som ännu inte är känt. Prognosbehovet är daterat per vecka (veckans första arbetsdag) och ger tidsfasade förslag som övrigt behov. Ett förslag som bara består av prognos har behovsdatumet *Prognos 2026-11-16*, märks aldrig **Passerat** och ger ingen varning i **Skapa ordrar** — som beställningspunktens förslag. Har veckan också en riktig order är det ett vanligt förslag, daterat och bedömt efter ordern. En tillverkad prognosstyrd artikels förslag ger härlett behov hos komponenterna som vanligt. Prognosen är inget skarpt behov: den flyttar aldrig ett föreslaget färdigdatum eller en leveranstidskontroll.

### Beställningspunkt, säkerhetslager, orderkvantitet och avrundning

På artikelkortets **Lager**-flik finns fälten **Beställningspunkt**, **Säkerhetslager**, **Orderkvantitet** och **Avrundning** (sektionen **Planering**). Beställningspunkten och säkerhetslagret jämförs mot **Netto** (det projicerade saldot, inte råsaldot): det **större** av de två är golvet, och faller netto under det föreslås ett antal som fyller upp till just den nivån. Utan någon av dem föreslås bara när netto blir negativt. I kolumnen **BP / SL** visas beställningspunkten överst och säkerhetslagret under. Är **Orderkvantitet** satt avrundas förslaget alltid uppåt till närmaste multipel — den fungerar därmed också som minsta orderkvantitet. **Avrundning** tillämpas **sist**, efter orderkvantiteten, och avrundar förslaget uppåt till närmaste multipel av steget (100 kg med orderkvantitet 100 och avrundning 7,38 blir 103,32 kg = 14 stänger). Det härledda komponentbehovet räknas på det avrundade förslaget. Samma avrundning görs på orderraderna när **Skapa ordrar** skapar inköps- och tillverkningsordrarna — ett förslag du ändrat för hand i kolumnen **Förslag** avrundas alltså igen — se [Artiklar](/hjalp/artiklar#lager).

### Tidsfasade förslag

Förslagen är **tidsfasade**: behoven dateras och en artikel får ett förslag per behovsvecka i stället för ett enda summerat antal.

- Kolumnen **Behov / senast** visar två datum per förslag. Överst **behovsdatumet** — när behovet infaller: kundorderns avsändningsdag, en tillverkningsorders startdatum för dess material, och för härlett behov förälderförslagets senaste start. Behov före innevarande vecka räknas till innevarande vecka.
- **Ett förslag per behovsvecka.** Det som lager och inkommande (alla öppna inköps- och tillverkningsordrar, oavsett deras datum) inte täcker grupperas per vecka. Ett förslag avrundas efter **Orderkvantitet** och **Avrundning**, och det som blev över i ett förslag bärs vidare och minskar nästa veckas förslag. Utan avrundning är summan av förslagen detsamma som det samlade förslaget förut; med avrundning kan summan bli något större.
- **Säkerhetslagret** ger ett eget förslag med **Säkerhetslager** i kolumnen **Behov / senast** när saldot redan ligger under det: förslaget fyller upp till säkerhetslagret, är daterat idag och märks aldrig **Passerat** — det är en nivå att återställa, inte ett behov som missats — och **Skapa ordrar** varnar inte för det. Har artikeln ett riktigt behov samma vecka ingår påfyllningen i det förslaget i stället, som då dateras och bedöms efter behovet. Materialet till ett säkerhetslagerförslag på en tillverkad artikel märks hos komponenten som beställningspunktens material (**Beställningspunkt**, idag, aldrig **Passerat**).
- **Beställningspunkten** ger ett eget förslag med **Beställningspunkt** i kolumnen **Behov / senast**, daterat idag och aldrig **Passerat**. Materialet till ett sådant förslag på en tillverkad artikel märks likadant hos komponenten (**Beställningspunkt**, idag, aldrig **Passerat**) när det inte ligger i samma vecka som ett vanligt behov, och **Skapa ordrar** varnar aldrig för att ett beställningspunktsförslag blir sent. Behov utan datum ger ett eget förslag sist, märkt **Saknar datum**.
- Under behovsdatumet står **senaste datum** att agera, och cellen säger vad: **beställ** för inköp och lego (så att leveransen hinner före behovet enligt leverantörens [leveransdagar](/hjalp/inkop#leveransdagar), ledtid och transportdagar; för lego legoresursens **Ledtid beställning (dagar)** före operationens behovsdatum, se lego-raderna under [Orderförslag och Skapa ordrar](#orderforslag-och-skapa-ordrar)) och **starta** för tillverkning och konfigurerade rader (arbetsdagen före behovet minus tillverkningens ledtid: artikelns **Ledtid (dagar)**, annars rutten med systeminställningen **Kötid mellan operationer (dagar)** mellan operationerna, annars **Standardledtid (dagar)** — se **Ledtid (dagar)** under [Artiklar](/hjalp/artiklar#lager) och [Inställningar](/hjalp/system#installningar)). Har senaste datum redan passerat markeras raden **Passerat**. Ger inköpet ingen möjlig ankomst visas **—**.
- **Flera förslag för en artikel** visas som artikelns egen rad (saldo, behov och inkommande) med en rad per förslag under sig, märkt med artikelnumret och behovsveckan (t.ex. *↳ 1002 · Förslag vecka 49*). Artikelns typ (**Inköp**, **Tillverkad** eller **Lego**) står under artikelnamnet. Varje förslag har en egen kryssruta och ett eget redigerbart **Förslag**; en artikel med ett enda förslag visar allt på en rad. Val och ändrade antal hör till förslaget och följer med när du byter sida.
- Filtret i verktygsraden (**Senast: Alla**, **Senast: Passerat**, **Senast: Denna vecka**, **Senast: Nästa vecka**, **Senast: Fyra veckor**) visar bara förslag vars senaste datum ligger t.o.m. söndagen i den veckan (respektive fyra veckor framåt) — passerade förslag ingår alltid. Artiklar utan förslag kvar döljs. Sorteringen **Sortering: Artikelnummer** (förval) eller **Sortering: Senaste datum** (tidigaste först, förslag utan datum sist) ändras i samma rad. Ett inköpsförslag som inte längre hinner fram alls — märkt **Passerat** men utan senaste datum — står först. **Exportera** (**CSV** eller **Excel**) följer filtret och sorteringen och ger en rad per förslag med kolumnerna **Behovsdatum**, **Senaste datum** och **Passerat**.
- **Skapa ordrar** visar **Varning vid frisläpp** i resultatet med TO-numret före varje rad när en ny tillverkningsorder saknar material i lager, och samma varning står överst på TO-kortet när du öppnar ordern.
- **Skapa ordrar** arbetar per förslag och skickar förslagets behovsdatum. Tillverkningsorderns **Planerat färdigdatum** blir arbetsdagen före behovsdatumet, men aldrig tidigare än idag plus ledtiden; hinner det inte före behovet skapas ordern ändå och en varning listas i resultatet, t.ex. *Färdigdatumet (2026-11-20) hinner inte före behovet (2026-11-18)*. Inköpsorderns **Önskat leveransdatum** räknas på samma sätt ur förslagets behovsdatum. **Varje leverantör får en inköpsorder** — också när flera veckors förslag för samma artikel är markerade: varje förslag blir en egen orderrad med sitt eget **Önskat leveransdatum**, och ordern får det tidigaste av raddatumen.

### Härlett behov i flera nivåer

När en tillverkad artikel får ett förslag räknas förslaget direkt om till komponentbehov (**Härlett** i kolumnen Behov), nivå för nivå genom hela strukturen med fantomartiklar upplösta. En brist på en färdigvara syns alltså som förslag även på komponenterna i samma körning — du behöver inte skapa tillverkningsordern först och köra om.

### Orderförslag och Skapa ordrar

Som standard visar listan bara rader med förslag; kryssa i **Visa alla artiklar** för att se alla artiklar med behov, inkommande, saldo eller beställningspunkt. Kolumnen **Förslag** är redigerbar — justera antalet innan ordrarna skapas. Kolumnen **Ledtid** visar för inköpta artiklar huvudleverantörens ledtid ur artikelns leverantörskatalog och för tillverkade artiklar tillverkningens ledtid (**Ledtid (dagar)**, annars rutten med kötiden mellan operationerna, annars **Standardledtid (dagar)** — den som förslagens datum räknas med); leverantören är huvudleverantören. Förslagen är [tidsfasade](#tidsfasade-forslag), och **Skapa ordrar** daterar ordrarna med samma ledtider, se nedan.

Vill du se **när** behoven infaller finns ikonknappen **Artikelöversikt** efter artikelnumret på varje rad. Den öppnar artikelns planeringsbild i en flyttbar panel — alla öppna behov och inkommande i datumordning med löpande disponibelt antal, se [Artikelöversikt](/hjalp/artiklar#artikeloversikt). Panelen ligger kvar medan du arbetar vidare i listan och **följer raden du arbetar i**: klicka var som helst på en rad, eller ställ markören i radens fält **Förslag** (**Antal** för de konfigurerade kundorderraderna), så visar panelen den radens artikel. Det gäller bara medan panelen är öppen — en stängd panel öppnas inte av sig själv, utan med ikonknappen. Gör panelen mindre i hörnet nere till höger och flytta den så att raderna syns bredvid den. Här visar panelen också behovsberäkningens förslag (**Visa förslag**): **Material till förslag** är behovet från förslagen på artiklar högre upp i strukturen, och **Orderförslag** är artikelns egna förslag. Antalen du skriver i **Förslag** och **Antal** räknas in direkt, så att du ser om antalet räcker hela vägen. Klicka på artikeln i kolumnen **Kund/Leverantör** för att följa behovet uppåt till kundordern. Se [Visa förslag](/hjalp/artiklar#visa-forslag).

Med rader markerade finns knappen **Kopiera artiklar (N)** bredvid **Skapa ordrar**: den lägger artiklarna på de markerade raderna, en gång var, i din personliga lista **Kopierat** — se [Kopierat](/hjalp/artiklar#kopierat).

Filtret **Alla / Artiklar / Lego** i verktygsraden begränsar listan till antingen vanliga artikelrader eller lego-rader (operationsbehov, se nedan) — praktiskt eftersom lego-raderna alltid sorteras sist i listan.

I tabellhuvudet finns en kryssruta som markerar **alla valbara rader på den sida som visas** (rader märkta **Saknar huvudleverantör**/**Saknar leverantör** eller utan förslag går fortfarande inte att välja). Den visar ett mellanläge när bara några rader på sidan är valda, och avmarkerar allt vid nästa klick. Val på andra sidor påverkas inte — statusraden under tabellen fortsätter räkna dem ("varav X på annan sida"). När listan räknas om (**Uppdatera**, eller när resultatet är äldre än en minut) stäms alla val av mot det nya resultatet: ett förslag som flyttat till en annan vecka eller blivit täckt försvinner ur valen, och ett ändrat behovsdatum följer med — även för rader på andra sidor. Ett antal du själv skrivit står kvar. På en smal skärm (mobil i stående läge) visas listan som staplade kort utan rubrikrad; då ligger kryssrutan **Välj alla på sidan** samt **Skapa förfrågan** och **Skapa ordrar** i stället i en rad ovanför listan som följer med när du skrollar.

Markera raderna och klicka **Skapa ordrar**:

- **Ett förslag som redan täckts skapas inte igen.** Innan ordrarna skapas räknas behovsberäkningen om. Ett markerat förslag som inte längre finns — för att någon just skapat ordrar för det, i en annan flik eller med ett klick till efter ett avbrutet anrop — skapas inte utan listas bland felen: *Förslaget finns inte längre — uppdatera behovsberäkningen*. För förslag som finns kvar gäller antalet du har skrivit. Klickar två personer **Skapa ordrar** samtidigt skapas ordrarna efter varandra, så den andra ser den förstas ordrar. Det kan ta några sekunder längre när listan är stor.
- Inköpsförslag grupperas till **en inköpsorder per huvudleverantör**, i status **Utkast** med **Önskat leveransdatum** satt efter behovet och leverantörens [leveransdagar](/hjalp/inkop#leveransdagar), ledtid och transportdagar (se [Inköp](/hjalp/inkop#onskat-leveransdatum)) och à-pris från leverantörskatalogen — har huvudleverantören staffelsteg används steget för förslagets antal, annars grundpriset (se [Artiklar](/hjalp/artiklar#inkop)); listan i sig visar bara grundpriset, så orderradens à-pris kan vara lägre än det som stod i listan. Granska och skicka den från inköpsorderkortet som vanligt. En rad utan huvudleverantör kan inte väljas (**Saknar huvudleverantör**); lägg upp leverantören på artikelkortets Inköp-flik först.
- Tillverkningsförslag blir en tillverkningsorder per artikel, frisläppt direkt (status **Frisläppt**), med **Planerat färdigdatum** satt till arbetsdagen före artikelns första otäckta behov (se [Föreslaget färdigdatum](#foreslaget-fardigdatum)); utan otäckt behov med datum, t.ex. ett förslag som bara fyller upp till beställningspunkten, lämnas datumet tomt. Föräldrar skapas före sina komponenter — och tillverkningsordrarna före inköpsordrarna — så en komponents tillverkningsorder, eller ett inköpt material, blir klar arbetsdagen före förälderns.
- **Inköpens datum följer leverantören.** **Önskat leveransdatum** blir den senaste möjliga ankomsten **före** behovsdagen enligt leverantörens leveransdagar, men aldrig tidigare än den tidigast möjliga ankomsten med leverantörens ledtid (leverantörskatalogens **Ledtid (dagar)**) och transportdagar. Utan leveransdagar, ledtid och transportdagar blir det arbetsdagen före behovet. Hamnar leveransen efter behovet skapas ordern ändå, och en varning listas i resultatet efter **Skapa ordrar**, t.ex. "IO-1042 · ART-1: Leveransen (2026-11-02) kommer efter behovet (2026-10-21)". Kundorderns behov räknas här på avsändningsdagen, se [Leveransdagar](/hjalp/forsaljning#leveransdagar).
- **Lego-rader** (märkta **Lego**, med tillverkningsorderns nummer och operation under artikeln) är operationsbehov, inte artikelbehov: varje ofärdig lego-operation på en tillverkningsorder som är Frisläppt eller Pågår föreslås med **orderantal minus redan beställt** (summan på ej makulerade inköpsorderrader mot operationen), utan kvittning mot lagersaldo. Förslagen grupperas till en inköpsorder i status **Utkast** per leverantör, med operationens styckpris som à-pris och ställpriset (ställpris + transportkostnad) på raden. Operationens priser är i kronor: har leverantören en annan valuta räknas de om till den med inköpsorderns kurs. En operation utan leverantör kan inte väljas (**Saknar leverantör**) — sätt leverantören på operationen i beredningen. Planerade tillverkningsordrar ger inga lego-rader (operationerna snapshotas först vid frisläpp). Samma inköpsorder kan skapas från TO-kortet, se [Legoinköp på TO-kortet](#legoinkop-pa-to-kortet).
- **Lego-radernas datum räknas bakåt från tillverkningsorderns Planerat färdigdatum**, eftersom en lego-operation aldrig planeras på egen kapacitet. Operationen måste vara **tillbaka** från leverantören arbetsdagen innan operationerna efter den behöver börja för att bli klara till färdigdatumet: deras tid utan kapacitetshänsyn (minst en dag per operation, som i ledtiden) och systeminställningen **Kötid mellan operationer (dagar)** före var och en av dem. Är lego-operationen sist är det färdigdatumet. **Behovsdatumet** är när varorna måste vara **hos** leverantören: legoresursens **Ledtid (dagar)** + **Kötid (dagar)** före det. **Senaste datum** är legoresursens **Ledtid beställning (dagar)** före behovsdatumet. Exempel: färdigdatum fredag 4 december, lego-operationen sist, ledtid 15 + kötid 2 dagar, ledtid beställning 5 dagar ⇒ tillbaka 4 december, hos leverantören 11 november och beställ senast 4 november. Utan färdigdatum räknas behovsdatumet från tillverkningsorderns start.
- **Lego-inköpsorderns Önskat leveransdatum** blir dagen operationen måste vara tillbaka, men aldrig tidigare än den tidigaste möjliga återkomsten om ordern läggs idag (idag + ledtid beställning + ledtid + kötid, i arbetsdagar). Hinner den inte före behovet skapas ordern ändå, och en varning listas i resultatet, t.ex. "IO-1042 · ART-1: Leveransen (2026-12-09) kommer efter behovet (2026-12-04)". Leverantörens fasta leveransdagar och transportdagar läses inte för lego. Har ordern flera lego-rader får ordern det tidigaste datumet, och en rad med senare datum får sitt eget.

- **Konfigurerade kundorderrader** (sektionen under artikellistan) blir en frisläppt tillverkningsorder per rad, med radens val, se [Konfigurerade kundorderrader](#konfigurerade-kundorderrader).

Ordrarna skapas i basenhet och utan valutaomräkning (växelkurs 1) — justera på orderkortet vid behov. Efter skapandet är förslagen täckta av de nya ordrarna och försvinner ur listan.

**Skapa ordrar** kräver rättigheten **Tillverkning**, även för inköpsordrarna, så snart något av förslagen är en tillverkningsorder. Innehåller anropet bara köp- och legoförslag räcker **Inköp** — det är så **Skapa inköpsorder** på [Aviseringar](/hjalp/aviseringar#behover-bestallas-per-leverantor) fungerar. Det är avsiktligt att Tillverkning får lägga materialbeställningarna: den som planerar produktionen ska kunna det, och de skapas som **Utkast** som inköp sedan granskar och skickar. Att öppna, ändra och skicka inköpsordrarna kräver däremot **Inköp**; utan den visas ordernumren i **Skapade ordrar** som vanlig text.

Bredvid **Skapa ordrar** finns knappen **Skapa förfrågan** — den agerar bara på de markerade **lego-raderna**; övriga markerade rader lämnas orörda (och knappen är inaktiv utan någon markerad lego-rad). Den öppnar en dialog med de valda operationerna listade och en lista med leverantörer att kryssa i, förvalda med operationernas egna leverantörer. Till skillnad från **Skapa ordrar**, som alltid bokar mot operationens huvudleverantör, skickas här en förfrågan **per ikryssad leverantör** — praktiskt för att jämföra pris mellan flera legoleverantörer (två förslag för samma artikel hamnar som två rader på leverantörens förfrågan). En förfrågan är inget beställt: raden ligger kvar i listan efteråt, nu med hänvisningen **Förfrågan FO-1024 (Skickad)** under sig (status ändras när förfrågan skickas eller besvaras). Flera förfrågningar står på samma rad, **Förfrågningar FO-1024 (Skickad), FO-1025 (Utkast)**; fler än tre visar de tre första och **+ 2 till**, som visar resten. Se [Legorader på förfrågan](/hjalp/inkop#legorader-pa-forfragan) i Inköp-kapitlet för hur raden drivs vidare.

Resultatet visas i kortet **Skapade förfrågningar**, med en rad per skapad förfrågan (FO-nummer, leverantör och antal rader), knapparna för att ladda ner/skriva ut PDF:en och **Maila** — precis som **Skapade ordrar** nedan, fast förfrågningarna skapas som **Utkast** och att mejla en sätter den till **Skickad**.

Efter **Skapa ordrar** listas de skapade ordrarna i kortet **Skapade ordrar**. Varje rad har, förutom länken till ordern, knapparna **Ladda ner PDF** och **Skriv ut** (öppnar utskriftsdialogen). Inköpsorderrader har dessutom **Maila**, som öppnar samma e-postdialog som inköpsorderkortet med leverantörens e-postadress förifylld (leverantörens huvudkontakt, annars leverantörens egen adress) — skickad order märks **Skickad**. Ordrarna skapas som **Utkast** och blir **Skickad** när de mejlas — **Bekräfta** inköpsordern på kortet när leverantörens ordererkännande har kommit. Kortet visar samma påminnelse. Tillverkningsordrar har bara **Ladda ner PDF** och **Skriv ut**; det finns ingen e-postfunktion för tillverkningsordrar. Kortet står kvar tills du klickar **Uppdatera**, som börjar om rutinen.

Skapades fler än en order av samma sort visas dessutom raden **Alla inköpsorder (n st)** respektive **Alla tillverkningsorder (n st)** under listan, med egna **Ladda ner PDF** och **Skriv ut**. De ger ett enda dokument med alla ordrarna efter varandra i samma ordning som listan — tillverkningsordrarna med sina ritningar precis som vid enskild utskrift — så hela körningen kan skrivas ut på en gång.

### Konfigurerade kundorderrader

En kundorderrad på en mall i läget Beställningsvara (se [Artiklar](/hjalp/artiklar#konfigurator)) har inget lagersaldo att nettas mot — varje rad är en egen konfiguration. Mallen själv får därför aldrig något förslag: på artikelraden står **Beställningsvara** i kolumnen Förslag. I stället listas raderna i sektionen **Konfigurerade kundorderrader** under artikeltabellen, med kolumnerna **Kundorder** (länk till ordern), **Kund**, **Artikel**, **Val** (t.ex. *Lås: Lås B · Avlopp: Ja · Bredd: 1 200 mm*), **Leveransdatum** och **Antal**.

- **Antalet** är det otäckta: beställt minus öppna tillverkningsordrar (Planerad/Frisläppt/Pågår) mot raden, minus det största av levererat antal och färdiga tillverkningsordrar (Klar/Stängd). Makulerade ordrar räknas inte. Antalet kan ändras för hand innan **Skapa ordrar**.
- **En fritt byggd enhet i lager minskar inte förslaget.** Lagret nettas aldrig mot en konfigurerad rad; levererar du raden från en enhet som byggts utanför en tillverkningsorder räknas bara det levererade antalet, och ingen ny tillverkningsorder föreslås för det.
- **Materialet räknas in innan tillverkningsordern finns.** Komponenterna i radens konfiguration visas som härlett behov på artikelraderna (och kaskaden går nivå för nivå), så inköpsförslagen för materialet kommer med redan nu.
- **Skapa ordrar** skapar en tillverkningsorder per vald rad med radens val, och sätter **Planerat färdigdatum** till arbetsdagen före radens avsändningsdag (utan transportdagar är det leveransdatumet). Tillverkningsordrarna skapas före inköpsordrarna.
- **Ogiltig konfiguration.** Är radens val inte längre giltiga (mallen har ändrats efter ordern) står felet i rött under valen och raden går inte att markera. Rätta raden med **Ändra konfiguration** på kundorderkortet.
- **Inaktiv mall.** Är mallen inaktiv får raden, precis som en inaktiv artikel, inget förslag och inget material räknas in för den. Med **Visa alla artiklar** syns den med märket **Inaktiv** och Antal 0 och går inte att markera. Aktivera mallen igen (och klicka **Uppdatera**) så kommer förslaget tillbaka.

Sökrutan matchar även kundordernumret och valen.

## Beläggning

**Tillverkning → Beläggning** visar operationstid per resurs och vecka eller dag från släppta tillverkningsordrar, ställd mot resursens tillgängliga tid. Lasten beräknas i stunden; själva planen — vilka dagar varje operation ligger på — sparas på operationerna (se [Planera](#planera)).

### Vad som räknas i lasten

- **Lasten** kommer från tillverkningsordrar i status **Frisläppt** eller **Pågår** (nya ordrar frisläpps när de skapas; en äldre order som står kvar som **Planerad** räknas inte förrän den frisläppts). Per operation räknas den återstående tiden: stycktid × kvarvarande antal, plus ställtiden så länge inget antal avrapporterats. En slutförd operation belastar inte. En **planerad** operation lägger sin tid på sina planerade dagar; har den delvis rapporterats räknas det som är gjort på de tidigaste dagarna, så det som återstår ligger på de senare. En operation som **inte är planerad** räknas i färdigdatumets vecka (i dagvyn under **Senare**/**Odaterat** om den inte ryms i kolumnerna). Ställtid och stycktid är i **minuter**; beläggningen visar timmar.
- **Tillgänglig tid** per resurs och dag kommer från resursens **Veckoschema (kapacitet)** — eller, utan schema, **Kapacitet per dag (tt:mm)** måndag–fredag — × **Kapacitetsfaktor** (se [Resurser](#resurser)), upplöst mot den faktiska kalendern — **röda dagar och halvdagar i helgdagskalendern minskar kapaciteten** den dagen. En resurs utan veckoschema och timmar per dag visar **—** som kapacitet men lasten syns ändå.

### Matrisen

Verktygsraden har en växel **Vecka** / **Dag**. **Vecka** är förvald.

- **Vecka:** kolumnerna är innevarande vecka och framåt (välj horisont med **Veckor**: 4/8/13/26), följt av **Senare** (färdigdatum bortom horisonten) och **Odaterat** (ordrar utan **Planerat färdigdatum**). Planerade operationer ligger i sina planerade dagar, och en operation som sträcker sig över flera veckor finns i en cell per vecka, med sin andel av tiden. En cell där någon dag i veckan är överbelagd märks med *1 dag överbelagd* eller *N dagar överbelagda* — veckan som helhet kan ändå ha plats.
- **Dag:** en kolumn per dag från i dag, rubriken *mån 16 nov* med veckonumret (*v.47*) vid måndagar och i första kolumnen. Välj hur många dagar som visas med **Dagar**: 7/14/28 (förval 14). Dagvyn visar var i veckan lasten ligger; en plan som passerat har rullats in på i dag (se [Planerade dagar](#planerade-dagar)) och gör dagens kolumn röd tills **Planera** körts.

Oplanerade operationer ligger i färdigdatumets vecka; ett passerat färdigdatum rullas in i innevarande vecka och ordern märks **Försenad**. Raderna grupperas per produktionsgrupp med en **Summa**-rad per grupp (resurser utan grupp hamnar under **Ogrupperade resurser**); filtrera med produktionsgruppsvalet.

Varje cell visar last / tillgänglig tid och beläggningsgrad: neutral till 85 %, gul över 85 % och röd över 100 %. En vecka eller dag där resursen har last men 0 timmar tillgänglig tid (till exempel en stängd vecka eller en röd dag) är också röd och räknas som överbelagd; i stället för procent står **Ingen kapacitet**. Klicka på en cell för att fälla ut vilka ordrar och operationer som utgör lasten, med länk till TO-kortet. Per operation visas **timmar i veckan** (i dagvyn **timmar i dagen**) och hur många timmar som är kvar totalt, de planerade dagarna (**12–14 nov**, eller **Ej planerad**), färdigdatum och märkena **Försenad**, **Sen**, **Halvfabrikat sent** (ett halvfabrikat som ordern behöver blir klart för sent, se [Halvfabrikat sent](#halvfabrikat-sent)) och **Låst**, samt knappen **Flytta…**.

Cellerna markerar dessutom med små symboler när de innehåller **sena ordrar** (klocka), **låsta operationer** (hänglås) eller operationer med **förslag på alternativ resurs** (dubbelpil). Överbelagda celler är röda. Matrisen scrollar i sidled i sin egen ruta; resten av sidan flyttar sig inte.

I utfällningen märks en operation som ligger på en alternativ resurs med **Alternativ (för 110)**, och en operation vars resurs bytts för hand med **Vald för hand**. En operation med förslag får raden **Förslag: 120** med texten *Kan bli klar 12 nov på 120 (i stället för 14 nov)* och knappen **Byt till 120** (utan rättigheten Tillverkning syns förslaget men inte knappen). Efter ett byte läses matrisen om.

### Förslag på alternativ resurs

Har en operation alternativa resurser i beredningen (se [Alternativa resurser](/hjalp/artiklar#alternativa-resurser)) och ordinarie resurs är full, föreslår beläggningen ett alternativ. Förslaget **räknas fram vid varje läsning och sparas aldrig**, och det **byter aldrig resurs av sig självt** — inte heller **Planera**. Lasten ligger kvar på resursen operationen har, så dagen blir röd tills någon byter.

- **När:** bara när lasten skjuter operationens klar-dag på nuvarande resurs, eller operationen inte ryms där inom två år. Det är lasten som den ser ut nu som räknas, inte hur gammal planen är: har resursen blivit ledig sedan senaste **Planera** (en föregående operation blev klar tidigare, en annan order makulerades) ges inget förslag. Då prövas alternativen med sina egna tider, och förslaget ges om något av dem blir klart en **tidigare dag**; blir flera klara samma dag vinner den som står först i beredningens ordning. Blir alternativet inte tidigare behåller operationen sin resurs. Har en tidigare operation på ordern ingen plan får operationerna efter den inget förslag, precis som **Planera** inte planerar dem. Förslaget räknar från där **Planera** skulle lägga de tidigare operationerna nu, inklusive kötiden mellan operationerna — ligger en tidigare operation på en dag som har blivit överbelagd räknas den på den dag den faktiskt hinner bli klar, så att ett byte ger den dag förslaget visar.
- **Vilka operationer:** bara väntande operationer på en frisläppt eller pågående order som är **orörda** (ingen rapportering, tidrapport, stämpling eller kassation), **inte låsta** och **inte Vald för hand**. Inaktiva resurser, legoresurser och resurser utan kapacitet föreslås aldrig.
- **Förslagen ser inte varandra.** Två operationer kan föreslås samma lediga dag på 120. Byter du den ena läses förslagen om, och det andra kan ha försvunnit.
- **Byt till 120** byter operationens resurs, planerar om ordern och märker operationen **Vald för hand**. Förslaget försvinner och operationen hamnar på den föreslagna dagen. Samma byte går att göra med **Ändra** på TO-kortet. Har operationen bytt resurs eller flyttats sedan förslaget visades byts ingenting, och sidan säger det — ladda om sidan för att se det nya läget.

Ovanför matrisen står räknaren *N förslag på alternativ resurs* (bara när det finns några). Klicka på den för att fälla ut listan: ordernummer (länk till TO-kortet), operation, *110 → 120, 14 nov → 12 nov* och **Byt till 120** på varje rad.

### Planera

Knappen **Planera** (kräver rättigheten Tillverkning) planerar om alla öppna tillverkningsordrar på ledig kapacitet. Du får först frågan "Planera om alla öppna tillverkningsordrar på ledig kapacitet? Operationer som flyttats för hand ligger kvar." — bekräfta med **Planera**.

- Ordrarna tas i ordning efter **Planerat färdigdatum**, tidigast först (ordrar utan datum sist, sedan ordernummer), och varje orders operationer läggs i tur och ordning från i dag: nästa operation börjar tidigast arbetsdagen efter att föregående blev klar plus **Kötid mellan operationer (dagar)**. En operation som redan är påbörjad (rapporterad eller instämplad) planeras från i dag.
- **Låsta** operationer (se [Flytta och Lås upp](#flytta-och-las-upp)) rörs inte — deras tid räknas som upptagen innan något annat planeras. Klara operationer får sin plan borttagen.
- **Äldre ordrar är oplanerade** och räknas i färdigdatumets vecka tills du kört **Planera** första gången.
- Planen ändrar aldrig något färdigdatum, bara operationernas dagar. Inget mejl eller meddelande skickas.
- **Ordningen inom dagen** som satts på [Körplan](#korplan) ändrar aldrig vilken dag en operation ligger på. En operation som hamnar på samma startdag igen behåller sin plats; byter den dag tappar den den.

**Planera byter aldrig resurs.** Har en operation alternativa resurser planeras den på den resurs den har, även när den är full. I stället visar resultatet *3 operationer kan bli klara tidigare på en alternativ resurs* med en rad per förslag (*TO-123 op 20: 110 → 120, 14 nov → 12 nov*, ordernumret länkar till TO-kortet) och knappen **Byt till 120** (kräver Tillverkning). Förslaget är samma som i [Förslag på alternativ resurs](#forslag-pa-alternativ-resurs); ett byte tar bort raden ur resultatet.

Efter körningen visas hur många operationer och ordrar som planerats, och eventuella varningar: en order som beräknas bli **sen**, en operation som inte rymdes inom två år ("Kapaciteten räcker inte inom två år"), en operation som kommit före föregående operation, en resurs utan kapacitet, eller en operation med **orimligt mycket tid**. Matrisen läses om.

En operation har orimligt mycket tid när dess återstående tid ensam skulle fylla resursen i mer än gränsen, normalt fyra vanliga veckor (den största veckokapaciteten bland de kommande veckorna, så en helgdagsvecka sänker inte gränsen; för en resurs utan kapacitet räknas 40 timmar per vecka). Det beror oftast på fel i underlaget — tider i fel enhet i beredningen eller ett felskrivet antal på ordern; rätta operationens tider direkt på TO-kortet med **Ändra** (se [Ändra material och operationer](#andra-material-och-operationer)), så planeras ordern om. Varningen visar tillverkningsordern, operationen, resursen och artikeln, hur många timmar som är kvar och hur många veckors kapacitet det motsvarar, samt operationens ställtid, stycktid och orderns antal, till exempel "Op 20 på 110 (1001 Diskbänk) har orimligt mycket tid: 625,5 h kvar, motsvarar 15,6 veckors kapacitet på resursen (40 h/vecka); ställtid 30 min, stycktid 75 min/st, antal 500 st — kontrollera operationens tider och orderns antal". Operationen planeras ändå. Legooperationer kontrolleras inte. Samma varning visas när du flyttar en sådan operation och när en ny tillverkningsorder skapas (i **Varning vid frisläpp** på TO-kortet).

Gränsen — fyra veckor om inget annat valts — ställs in under **System → Inställningar** med **Orimligt mycket tid på en operation (veckor)**. Decimaler går bra; 0 stänger av varningen.

### Flytta och Lås upp

Klicka på en cell och sedan **Flytta…** vid operationen. I dialogen **Flytta operation** väljer du **Dag** — ett datumfält där tidigaste dag är i dag (Stockholmsdagen; en dag som passerat kan inte väljas). Under fältet står den lediga tiden den dagen, till exempel *ledigt 3 h av 8*, eller *ingen kapacitet den dagen* på en helg eller röd dag — bara när dagen finns i den inlästa matrisen och resursen har ett schema eller timmar per dag (öka **Veckor** eller **Dagar** för att nå längre fram; flyttar du ändå går det bra). Kryssrutan **Flytta även efterföljande operationer** är förvald: orderns senare, olåsta operationer planeras om från den nya dagen. Klicka **Flytta**. Har resursen ingen kapacitet alls den valda dagen — en röd dag, ett veckoschema utan timmar den veckodagen eller en helg — flyttas ingenting och dialogen säger till exempel *110 har ingen kapacitet 12 nov — välj en annan dag*. Väljer du en dag som passerat flyttas ingenting heller.

- Operationen **börjar på den valda dagen även om dagen är full** — dagen blir då röd, så överlasten syns. Resten av tiden fortsätter på ledig kapacitet dagarna efter.
- En flyttad operation blir **Låst**: **Planera** låter den ligga kvar. Varningar (sen order, operationer i fel ordning) visas i dialogen innan du stänger den.
- **Lås upp** (i samma dialog, för en låst operation) släpper låset. Dagen ligger kvar tills nästa **Planera**, som då planerar om operationen. Låset försvinner också när operationen blir klar.
- En klar operation, en legooperation, en operation utan tid och en operation på en order som inte är frisläppt eller pågående går inte att flytta.

Länken **Visa strukturen** vid operationen i den utfällda cellen öppnar [Struktur](#struktur) för tillverkningsordern: hela trädet under den, med halvfabrikatens planerade dagar.

### Sammanfattningen

Ovanför matrisen står **Senast planerad** (tidpunkten för senaste **Planera**, eller "Inte planerad ännu") och en sammanfattning, till exempel "3 överbelagda celler · 2 sena ordrar · 4 ej planerade". I veckovyn läggs *N överbelagda dagar* till (resurs × dag över hela perioden, även när veckan som helhet ryms). Klicka på ett tal för att fälla ut listan: de överbelagda cellerna (resurs, vecka eller dag, belastning), de **sena** ordrarna (färdigdatum och planerat klar) och de **ej planerade** ordrarna — ordernumren länkar till TO-kortet. Finns förslag på alternativ resurs läggs räknaren *N förslag på alternativ resurs* till sist i raden, och listan har **Byt till 120** per rad. En order är **Sen** när den sista operationen beräknas bli klar efter färdigdatumet. Finns operationer som flyttats för hand står också *N låsta operationer* i raden — **Planera** låter dem ligga kvar; släpp dem med **Lås upp**, eller en hel order eller struktur på en gång i [Struktur](#planera-om-fran-strukturen).

[Leveranstidskontrollen](/hjalp/forsaljning#leveranstidskontroll) i Försäljning använder samma beläggning och samma planeringsregel: den lägger en ny orders operationer på resursernas lediga tid per dag, det vill säga tillgänglig tid minus lasten som visas här — inklusive de planerade dagarna och kötiden mellan operationerna.

Observera att en grupps **Summa**-procent bara ställs mot de medlemmar som har kapacitet (veckoschema eller timmar per dag) — lasten summeras över alla medlemmar, så procenttalet kan överdrivas när någon resurs i gruppen saknar kapacitet.

## Struktur

Sidan **Struktur** visar **en orders hela träd** med planerade dagar: överst en tillverkningsorder eller en kundorders rader, under varje tillverkningsorder dess material och under varje material det som täcker det — en tillverkningsorder för halvfabrikatet (med sitt eget material under sig), lager, en inköpsorder eller ingenting. Du ser på en gång var i kedjan en försening uppstår och kan flytta det som behöver flyttas, även långt ned i strukturen.

Sidan öppnas från korten, inte från menyn:

- **Visa strukturen** vid rubriken **Material** på TO-kortet,
- **Visa strukturen** på raden **Leveransläge** på kundorderkortet (hela kundordern, en gren per rad),
- **Visa strukturen** vid en operation i [Beläggningens](#belaggning) utfällda cell.

Öppnas sidan utan order finns ett sökfält för **TO- eller KO-nummer**. Strukturen kan läsas av alla som kan öppna en tillverkningsorder; åtgärderna kräver behörigheten Tillverkning. Inga priser visas.

### Vad strukturen visar

Till vänster står trädet, indraget per nivå, och till höger en **dagaxel** med veckonummer och dagar. Lördagar, söndagar och röda dagar är tonade och i dag är markerad. Axeln börjar i dag och går till det senaste datumet i trädet (minst två veckor, högst tolv); den rullar i sin egen ruta och trädets spalt står kvar. Datum som ligger senare än axeln står som text på raden.

- **Tillverkningsorder** — ordernummer (länk till kortet), artikel, *antal*, *färdigt 9 dec* och på axeln en tunn linje från första till sista planerade dag, en **romb** på **Planerat färdigdatum** och ett **streck** på dagen då det behövs av nivån ovanför. Under ordern står **operationerna** med en **stapel** på varje planerad dag (*op 10 Montering · 110*, planerade dagar och timmar kvar). Operationerna är utfällda på trädets två översta nivåer; längre ned fäller du ut dem med **Visa operationer (N)**, eller alla på en gång med **Visa alla operationer**.
- **Legooperationer** har ingen stapel utan texten *Lego · N dagar* (resursens ledtid och kötid). Orderns klardag räknar in dem — står legot sist visas *klar 3 dec* på orderns rad.
- **Material** — artikel, *behov* och ett streck på dagen då materialet behövs (tillverkningsorderns start).
- **Lager** och **inköpsorder** (*IO-1017 · inleverans 5 dec*, en ring på axeln) är trädets löv. Det som ingenting täcker står i rött som **Saknas** med antalet.
- **Kundorderrad** (när en kundorder ligger överst) — artikel, *rest*, en romb på avsändningsdagen och radens märke ur [Leveransläget](/hjalp/forsaljning#leveranslage).

Antalen står i artikelns basenhet. Pilen till vänster om en rad fäller ihop och ut grenen under den.

**Material som täcks helt av lager är dolt** för att trädet ska gå att överblicka — kryssa i **Visa material i lager (N)** för att se även de raderna.

**Samma tillverkningsorder på två ställen.** Täcker en tillverkningsorder två behov i trädet ritas den en gång, på det första stället. På nästa ställe står bara ordernumret, antalet och länken **visas ovan**, som hoppar till det första stället och markerar raden.

Ovanför trädet står en summering — till exempel *3 tillverkningsordrar · 1 sen · 1 med halvfabrikat sent · 2 låsta operationer · 1 saknas* — och, när en tillverkningsorder ligger överst, rutan **Går till** med de behov ordern själv täcker och länken **Öppna strukturen för KO-1234** (eller för tillverkningsordern ovanför). Strukturen visas alltid nedåt från den order du öppnat; uppåt går du en nivå i taget med länken, eftersom ett halvfabrikat kan gå till flera ordrar.

Ett mycket stort träd kortas av: *Trädet är avkortat (fler än 10 nivåer / fler än 600 rader)*. Innehåller strukturen sig själv visas *Strukturen går runt på artikel …* och grenen ritas inte vidare.

### Märkena i strukturen

- **Sen** — orderns plan blir klar efter **Planerat färdigdatum**. Linjen, staplarna och romben får varningsfärg.
- **Halvfabrikat sent** — en tillverkningsorder som ordern behöver blir klar efter att den behövs, se [Halvfabrikat sent](#halvfabrikat-sent).
- *N dagar för sent* (röd text på en tillverkningsorder eller inköpsorder) — den blir klar eller kommer in så många arbetsdagar efter att nivån ovanför behöver den. Strecket för behovet är då rött.
- **N låsta** på ordern och **Låst** på operationen — operationer som flyttats för hand; **Planera** låter dem ligga. En låst operations stapel har en mörk ram.
- **Saknas** — ingenting täcker behovet.

Märkena är samma som på TO-kortet, i listan och i Leveransläget — strukturen har inga egna regler. Kopplingen mellan behov och tillgång är härledd: den räknas fram varje gång sidan visas, ingenting är reserverat, och den kan ändras när ett tidigare behov kommer in.

### Planera om från strukturen

Med behörigheten Tillverkning kan du rätta till planen direkt i trädet. Sidan läses om efter varje ändring.

- **Flytta…** — klicka på en operations stapel, eller välj **Flytta…** i operationens meny **⋯**. Det är samma dialog som i Beläggning, se [Flytta och Lås upp](#flytta-och-las-upp): operationen börjar på den valda dagen och blir **Låst**.
- **Lås upp** (operationens meny) släpper låset på en operation.
- **Lås upp hela ordern** (orderns meny **⋯**) släpper alla låsta operationer på tillverkningsordern, efter en fråga.
- **Lås upp strukturen** (ovanför trädet) släpper alla låsta operationer på alla tillverkningsordrar i trädet, efter frågan *Lås upp N operationer på M tillverkningsordrar?*.
- **Flytta halvfabrikaten…** (orderns meny, när ordern har halvfabrikat under sig) öppnar samma dialog som på TO-kortet, se [Flytta halvfabrikaten](#flytta-halvfabrikaten).
- **Skapa saknade halvfabrikat…** (orderns meny, när ett tillverkat material saknar täckning) öppnar samma dialog som på TO-kortet, se [Skapa saknade halvfabrikat](#skapa-saknade-halvfabrikat).

När ett lås släpps står dagarna kvar tills nästa **Planera** i Beläggning, som då planerar om operationerna.

### Strukturen på telefonen

På en smal skärm visas ingen dagaxel. Trädet är en indragen lista där varje rad har sina datum som text — *planerad 26 nov–2 dec · färdigt 9 dec · behövs 12 dec* — följt av märkena, och operationerna står som underrader (*op 20 Slipning · 120 · 1–2 dec · Låst*). Djupare än fyra nivåer ökar inte indraget; nivån står då som en siffra före raden. Menyn **⋯** har samma åtgärder.

## Dagplan

**Tillverkning → Dagplan** visar **en dag** för **alla resurser**: vad som ska köras på varje maskin eller arbetsplats, i körordning, med last mot kapacitet, om materialet finns och vem som arbetar på vad just nu. Sidan är gjord för avstämningen med verkstaden på morgonen — gå igenom den resurs för resurs, ändra ordningen eller flytta det som inte hinns med.

Överst väljer du dag med pilarna (**Föregående arbetsdag** och **Nästa arbetsdag** — helger och röda dagar hoppas över) och **I dag**. Rubriken visar dagen och veckan, till exempel *tors 26 nov · v.48*. Dagplanen visar i dag och sex veckor framåt, aldrig en dag som passerat. Med **Grupp** visar du bara resurserna i en [produktionsgrupp](#produktionsgrupper); **Alla resurser** tar bort urvalet. Legoresurser finns inte med.

Raden under visar dagens summa, till exempel *18 operationer · 9,42 h*, och när det finns något att se upp med *2 material saknas* och *9 operationer saknar kopplat material*.

Dagplanen räknas fram varje gång den öppnas ur samma plan som [Beläggning](#belaggning) och [Körplan](#korplan) — den sparar ingenting eget. Kör **Planera** i Beläggning när planen behöver läggas om.

### Vad som visas

Varje resurs med arbete den dagen har en egen ruta. Resurser utan arbete räknas upp sist: *Utan arbete den dagen: 130, 140*.

Rubriken visar resursens nummer och namn och:

- **Lasten mot kapaciteten**, till exempel *6,5 h av 8 h*, med en stapel. Är dagen överbelagd står *9 h av 8 h · överbelagd* i rött. *3 h · ingen kapacitet* betyder att resursen inte har någon tid den dagen, och en resurs utan veckoschema eller timmar per dag visar bara lasten. Det är samma tal som dagvyn i [Beläggning](#belaggning).
- **På plats:** de anställda som har resursen som förvald station och är instämplade i närvaron just nu. Visas bara för i dag.
- ***N* ej planerade** — operationer på resursen som varken har plan eller färdigdatum. Länken öppnar [Körplan](#korplan) för resursen.

Under rubriken kommer raderna:

- **Kvar från tidigare** — det som borde varit klart: i dag körplanens **Försenad**, en senare dag de operationer som börjat en tidigare dag och fortfarande ligger på dagen. Raderna har ett streck i stället för nummer och texten *Planerad 24 nov* (eller *Ej planerad*).
- Dagens operationer, numrerade **1, 2, 3 …** i körordning — samma ordning som i [Körplan](#korplan). När det finns rader kvar från tidigare står rubriken **I dag** (eller **Dagens operationer** för en senare dag) före dem.

På varje rad står **Nr**, **TO** (en länk till TO-kortet), **Operation** och **Artikel**, **Antal kvar**, **Tid kvar (h)**, **Färdigdatum** och **Status** — **Redo**, **Väntar på op N** eller *N redo · väntar på op M*, som i [Körplan](#kolumnerna), och märket **Låst** för en operation som är flyttad för hand. Under står **Material** och, när någon är instämplad på operationen, **Pågår** med namnen (*Anna (paus)* för den som har paus).

På en telefon och i ett smalt fönster visas varje operation som ett kort i stället för en tabellrad.

### Material

**Material** visar det **köpta** material som är **kopplat till operationen i beredningen** och som det finns något kvar att ta ut av:

- *finns* — det användbara lagersaldot räcker till radens behov. Saldot räknas mot **varje rad för sig**: två operationer som behöver samma plåt kan båda visa *finns* fast saldot bara räcker till den ena. Saldo på en spärrad lagerplats räknas inte.
- *saknas 4 st* — saldot räcker inte och inget är på väg.
- *kommer 2 dec · IO-88* — saldot räcker inte, men materialet väntas på den inköpsordern (eller tillverkningsordern) det datumet. Numret är en länk till ordern. *kommer, utan datum* betyder att ordern saknar leveransdatum, och *(utkast)* att inköpsordern inte är skickad än.
- *kommer 2 dec · IO-88 · saknas 8 st* — ordern täcker inte hela radens behov: 8 st finns varken på lagret eller på någon order.
- *försenad sedan 25 nov · IO-88* — materialet skulle ha kommit den dagen men är inte inlevererat. Raden står i rött tills ordern är inlevererad eller har fått ett nytt datum.

Ligger samma artikel på flera operationer i ordern gäller *kommer* och *saknas* den operationens egen materialrad, inte orderns hela behov av artikeln.
- *—* — operationen saknar kopplat material. Koppla materialet till operationen i artikelns beredning om det ska synas här.
- *uttaget* — allt kopplat material är redan uttaget.

Halvfabrikat och material som inte är kopplat till en operation visas inte här — se **Täcks av** på TO-kortet.

### Planera efter material

Med **Visa** överst väljer du mellan **Körordning** och **Material**. I läget **Material** grupperas varje resurs operationer efter **ingående material**, så att du lätt ser vilka jobb som tar samma plåt eller profil och kan köra dem ihop.

Som material räknas samma sak som i kolumnen [Material](#material): **köpt** material som är **kopplat till operationen i beredningen** och som det finns något kvar att ta ut av.

- Varje material är en grupp med rubriken artikelnummer och benämning, *behov 14,5 st · användbart saldo 22 st* och antalet operationer. **Behov** är summan av gruppens rader. Räcker inte saldot till gruppen tillsammans står raden i rött med märket **räcker inte**. Klicka på rubriken för att fälla ihop eller fälla ut gruppen.
- Under rubriken står gruppens operationer med **Dag**, **TO**, **Operation** och **Artikel**, **Antal kvar**, **Tid kvar (h)**, **Färdigdatum**, **Status** och **Behov** — radens eget behov av materialet och *finns*, *saknas 4 st*, *kommer 2 dec · IO-88* eller *försenad sedan 25 nov · IO-88* (se [Material](#material)).
- **Saldot räknas per rad, summan visar konkurrensen:** varje rad jämförs för sig mot hela det användbara saldot, så två rader kan båda visa *finns* fast saldot bara räcker till den ena. Det är gruppens summa — *behov* mot *användbart saldo* och märket **räcker inte** — som visar om materialet räcker till alla.
- En operation som tar två material står i båda grupperna.
- Sist kommer **Utan kopplat material (N)** — operationer som saknar kopplat köpt material. Gruppen är hopfälld och har texten *Koppla materialet till operationen i beredningen för att kunna samköra.* Därefter **Materialet uttaget (N)** för operationer där allt kopplat material redan är uttaget. Ingen av de två grupperna går att välja ur.

Mötesläget visar alltid körordningen.

### Samkör

Med rättigheten Tillverkning har varje rad i en materialgrupp en kryssruta. Kryssa i de operationer som ska köras ihop — minst två, på samma resurs — och välj **Samkör valda…** under gruppen. Bredvid knappen står hur många som är valda. En operation som står i två grupper är samma val i båda. En operation utan tid kvar går inte att välja.

Dialogen **Samkör** visar vad som händer **innan** något ändras:

- **Dag** — dagen operationerna ska köras. Förvalet är dagen som dagplanen visar; i [Körplan](#korplan) är det den tidigaste planerade dagen bland de valda, tidigast i dag. Det går inte att välja en dag som passerat. Varje gång du byter dag räknas förhandsvisningen om.
- **Operationer** — de valda, med var de ligger och vart de flyttas: *tors 26 nov → ons 2 dec*, *ligger redan på dagen* eller *ryms inte inom två år*.
- **Dagens last** — resursens last den dagen före och efter, till exempel *4,2 h → 9,8 h av 8 h · överbelagd*. En samkörning får ta dagens hela kapacitet, så dagen kan bli överbelagd.
- **Flyttas också** — efterföljande operationer i samma ordrar som följer med.
- **Blir sena** — ordrar som blir klara efter sitt färdigdatum.
- **Observera** — övriga varningar från planeringen.
- **Material** — de valda operationernas material tillsammans: *behov* mot *användbart saldo*, och *räcker inte* när saldot inte täcker dem. Är material på väg står det också, till exempel *kommer 2 dec · IO-88 · saknas 8 st* — det sista är det som ingen order täcker av de valda operationernas behov.
- **Körordning** — dagens ordning efteråt, med de valda märkta *samkörs*. De läggs **intill varandra**, efter de operationer som redan är ordnade för hand den dagen, i den ordning listan visade dem.

Har resursen ingen kapacitet den dagen (helg, röd dag eller ledig dag i schemat) står det i dialogen och **Samkör** är avstängd — välj en annan dag.

**Samkör** flyttar operationerna till dagen, lägger dem intill varandra i körordningen och **låser** dem. Dialogen visar resultatet och du stänger den med **Stäng**.

- Operationerna får märket **Låst**: **Planera** flyttar dem inte. Vill du släppa en operation igen väljer du **Lås upp** i radens meny **⋯** (läget **Körordning**) eller i **Flytta…** i [Beläggning](#flytta-och-las-upp).
- **Ställtiden räknas per operation** även när jobben körs ihop — planen och kalkylen ändras inte av en samkörning.
- Ingenting sparas om själva gruppen: en samkörning är de flyttade dagarna, låsen och platserna i körordningen. Ordningen ändrar du som vanligt med **Upp** och **Ned**.

Har någon annan ändrat planen sedan listan lästes får du meddelandet *Planen har ändrats sedan listan lästes — den har lästs om. Välj operationerna igen.* Då är inget ändrat. Det gäller också när dialogen öppnas eller du byter dag: dialogen stängs och listan läses om.

### Ordna dagen

Med rättigheten Tillverkning ändrar du körordningen på två sätt:

- **Upp** och **Ned** (pilarna på raden, med hjälptexterna *Flytta upp* och *Flytta ned*) byter plats med grannen.
- **Dra** raden i greppet framför pilarna och släpp den där den ska ligga. Det går bara inom samma resurs, och bara med mus — på en pekskärm används pilarna.

Ordningen sparas direkt och är densamma som i [Körplan](#ordningen-inom-dagen): den styr körplanen, utskrifterna och stämpelterminalens sortering **Planerad dag**, aldrig vilka datum operationerna ligger på. Har någon annan ändrat dagen under tiden får du ett meddelande om att körplanen har ändrats och listan läses om.

Raderna under **Kvar från tidigare** och en operation som inte är planerad (den står på färdigdatumets dag) går inte att ordna.

### Flytta till en annan dag

Menyn **⋯** längst till höger på raden (med rättigheten Tillverkning) har:

- **Flytta…** — öppnar dialogen **Flytta operation**, samma som i [Beläggning](#flytta-och-las-upp): välj **Dag** och om efterföljande operationer ska följa med.
- **I morgon** — flyttar operationen till nästa arbetsdag efter en bekräftelse som nämner dagen: *Flytta op 10 på TO-1050 till fre 27 nov? Efterföljande operationer följer med och operationen låses.* Visar du en annan dag än i dag heter valet **Nästa arbetsdag**.
- **Lägg på i dag** — för en rad under **Kvar från tidigare** när du visar i dag: operationen planeras om med start i dag.
- **Lås upp** — för en operation som är **Låst**: nästa **Planera** får flytta den igen.

En flyttad operation blir **Låst** och får ta dagens hela kapacitet, så dagen kan bli överbelagd. Varningar från flytten — till exempel att ordern blir sen — visas överst på sidan.

### Mötesläge

**Mötesläge** öppnar dagplanen för skärmen på väggen: större text, ingen meny och resurserna bredvid varandra (under varandra på en smal skärm). Läget visar samma dag och grupp som sidan, läser om sig självt varje minut medan fliken syns och har inga knappar som ändrar något.

- Pilarna och **I dag** byter dag.
- **Helskärm** fyller hela skärmen (knappen finns där webbläsaren stöder det; **Lämna helskärm** eller Esc går tillbaka).
- **Stäng** går tillbaka till dagplanen.

Går det inte att läsa om — nätverket är nere — står *Kunde inte läsa om* uppe till höger och den senaste bilden ligger kvar.

Står läget öppet över midnatt på en vald dag går det över till **i dag** när dagen har passerat. En kommande dag ligger kvar.

### Skriv ut dagplanen

**Skriv ut** öppnar utskriftsdialogen för dagen och gruppen som visas: en grupp per resurs med last och kapacitet i rubriken, först raderna kvar från tidigare och sedan dagens operationer numrerade i körordning, med materialet som text (*finns*, *saknas 4 st*, *kommer 2026-12-02 IO-88*, *kommer 2026-12-02 IO-88, saknas 8 st*, *försenad 2026-11-25 IO-88*).

## Körplan

**Tillverkning → Körplan** visar de kommande arbetena på en resurs, dag för dag — det som körs på maskinen eller arbetsplatsen härnäst. Sidan går att skriva ut som underlag till verkstaden. Vill du se **alla** resurser en och samma dag — för morgonmötet — använd [Dagplan](#dagplan).

Välj **Resurs** (produktionsresurserna; legoresurser finns inte med eftersom de inte körs hos er) och **T.o.m.** — ett datum. Förvalet är sista dagen i nästa vecka; listan tar med allt som ligger till och med det datumet. Utan vald resurs står *Välj en resurs*, och finns inget att köra står *Inga kommande arbeten på resursen t.o.m. 21 nov*.

Med **Visa** väljer du mellan **Körordning** och **Material**. Läget **Material** grupperar resursens kommande operationer efter ingående material och har **Samkör valda…** — det fungerar som i dagplanen, se [Planera efter material](#planera-efter-material) och [Samkör](#samkor). Här spänner listan över flera dagar, så det är i Körplan du samlar jobb från olika dagar till en. Rader för en planerad TO, som saknar operationer än, står sist under **Planerad TO (N)** och går inte att välja.

### Vad som tas med

- Väntande operationer i tillverkningsordrar som är **Frisläppt**, **Pågår** eller **Planerad**. Klara och stängda ordrar, makulerade ordrar, klara operationer och legooperationer tas inte med.
- Ordningen är den **planerade dagen** (operationens startdag, se [Planerade dagar](#planerade-dagar)), sedan den ordning du satt med **Upp**/**Ned** (nedan) och därefter färdigdatum. En operation som inte är planerad hör till färdigdatumets dag. Har den varken plan eller färdigdatum hamnar den under **Ej planerad**.
- Operationer som borde varit klara — dagen har passerat — står överst under **Försenad**. Därefter kommer en grupp per dag (*mån 16 nov · v.47*) och sist **Ej planerad**. Varje grupp visar sin summa i timmar och längst ner står **Totalt**.

### Ordningen inom dagen

Med rättigheten Tillverkning har varje **planerad** operation i en dagsgrupp knapparna **Upp** och **Ned** (på skärmen som pilar, med hjälptexterna *Flytta upp* och *Flytta ned*; **Upp** är avstängd för den översta av dagens planerade operationer och **Ned** för den understa). Ett klick byter plats med grannen, sparas direkt och listan läses om. Ingen bekräftelse behövs — det går att göra om. Har någon annan ändrat dagen under tiden får du ett meddelande om att körplanen har ändrats och listan läses om.

- Ordningen styr **bara** körplanen, utskriften och stämpelterminalens sortering **Planerad dag** — aldrig vilka datum operationerna ligger på. Beläggning, förslag, Leveranstidskontroll och behovsberäkning ser den inte.
- Ordningen **nollas** när operationen flyttas till en annan dag eller byter resurs; en operation som hamnar på samma startdag igen behåller sin plats. Nya operationer på dagen hamnar efter de ordnade.
- En operation som sträcker sig över flera dagar ordnas på sin **startdag**.
- Bara operationer som är planerade på dagen går att ordna. En operation som inte är planerad — den står på färdigdatumets dag — saknar knapparna, och likaså en rad för en planerad TO (som saknar operationer än). De raderna står kvar på sin plats i standardordningen, efter de ordnade.
- **Försenad** och **Ej planerad** går inte att ordna.

### Kolumnerna

- **Dag** — operationens planerade startdag (eller färdigdatumets dag för en operation som inte är planerad).
- **TO** — tillverkningsordernumret, en länk till TO-kortet.
- **Artikel** — artikelnummer och namn.
- **Operation** — operationens nummer och beskrivning.
- **Antal kvar** — det som återstår att tillverka i operationen.
- **Tid kvar (h)** — återstående tid i timmar med två decimaler: stycktid × kvarvarande antal plus ställtiden så länge den inte är gjord. Det är samma tal som [Beläggning](#belaggning) räknar med för operationen.
- **Färdigdatum** — tillverkningsorderns färdigdatum.
- **Status** — hur långt operationen kan göras just nu: **Redo** (hela det som återstår kan göras), **Väntar på op N** (föregående operation har inte levererat något ännu), delvis redo visas som *N redo · väntar på op M*, och **Planerad TO** för en order som inte är frisläppt än. Beredskapen räknas som i [stämpelterminalen](/hjalp/terminal). Märket **Låst** betyder att dagen är flyttad för hand i Beläggning och ligger kvar när du kör **Planera**.
- **Material** — det köpta material som är kopplat till operationen och om det finns, som kolumnen [Material](#material) i dagplanen.

### Skriv ut

**Skriv ut** öppnar utskriftsdialogen för körplanen, med samma resurs och samma **T.o.m.** som på sidan. Knappen visas när en resurs är vald.

Från [stämpelterminalen](/hjalp/terminal) finns en länk **Körplan** för den valda stationen.

## Rapportera

**Tillverkning → Rapportera** är till för att rapportera tillverkning för hand, en operation i taget, t.ex. från en arbetslapp. Tiden och antalen rapporteras tillsammans, utan att någon stämplar.

Sidan listar de operationer som går att rapportera: väntande operationer på frisläppta och pågående tillverkningsordrar, samma operationer som i stämpelterminalen. Legooperationer är inte med, eftersom de rapporteras på sin inköpsorder. Listan visar **TO**, **Artikel**, **Operation**, **Resurs**, **Planerad** (planerad startdag), **Klart / Kvar** och **Redo**, och sorteras på planerad dag eller på färdigdatum. Välj en resurs i listan **Alla resurser** för att bara se dess operationer.

Sök på TO-nummer, artikel, resurs eller material i sökfältet. Fältet tar också emot en handskanner: skanna TO-numret på pallkortet eller utskriften, och om sökningen bara lämnar en operation öppnas den direkt (samma sak när du trycker Enter). På en telefon skannar du med **Kamera**.

**Rapportera** på raden öppnar en dialog med artikel, resurs och Planerat / Klart / Kvar:

- **Anställd** och **Datum** (förvalt i dag) står kvar till nästa rapport, så att en hel dags lappar för samma person går fort.
- **Tid (tt:mm)** är den anställdes tid på operationen och krävs. Fältet är förifyllt med det som återstår av operationens planerade tid: ställtid plus stycktid gånger orderns antal, minus den tid som redan rapporterats på operationen. Det är samma förslag som i **Rapportera tid** på tillverkningsordern. Med **Dela tid i ställ och produktion** på finns också **Typ**, förvalt **Produktion**, och förslaget gäller då bara den typen (ställtiden för **Ställ**, stycktiden för **Produktion**). Är allt planerat redan rapporterat är fältet tomt.
- **Antal OK** är förifyllt med det som återstår (**Kvar**) när rutan **Rapportering** under **Rest som förslag i antalsfältet** i [System → Inställningar](/hjalp/system#installningar) är markerad, vilket den är från början. Annars är fältet tomt. **Kasserat** kräver en orsak, som i kortet Rapportera på tillverkningsordern.
- **Operationen är klar** kryssas i av sig själv när antalet OK når orderns antal. Kryssa i den för att klarmarkera med färre (resten görs inte), eller ta bort krysset för att låta operationen vara öppen.
- **Anteckning** följer med tidrapporten.

**Rapportera** i dialogen skapar tidrapporten och rapporterar antalen i ett svep. Material som är kopplat till operationen dras automatiskt för antal OK + kasserat, och antal OK på den sista operationen levereras in i lager, precis som när [en operation avrapporteras](#avrapportera-operation). Saknas material gäller inställningen för [materialbrist](#materialbrist-vid-rapportering). Tiden kan inte rapporteras på en dag i en låst löneperiod.

Efter rapporten visar sidan vad som rapporterades, t.ex. *Rapporterat på TO-1001 op 10: 1:30 för Anna Exempel, 5 st OK.*, och sökfältet är markerat för nästa lapp. Administratörer och arbetsledare har **Ångra** i notisen. Rapporten syns som **Manuell rapport** under [Rapporteringar](#rapporteringar-och-angra) på tillverkningsordern och kan ångras där också. Ångra tar bort både tiden och antalen. Tiden syns under [Tidrapporter](#tidrapporter) med källan **Manuell**.

## Pågående arbete

**Tillverkning → Pågående arbete** visar i realtid vem som jobbar med vad. Sidan uppdateras automatiskt var 30:e sekund och tiderna räknar sekund för sekund. Rubriken visar antalet, t.ex. "3 instämplade · 1 på plats utan arbete".

- **Instämplade på arbete** listar varje öppen stämpling: **Anställd**, **TO** (länk till tillverkningsordern), **Operation** (med märket **Ställ** eller **Produktion** när tiden är uppdelad), **Artikel**, **Sedan** (starttid, med datum om det inte är idag), **Tid** (arbetad tid, utan pauser) och **Antal** (planerat / klart / kvar). Äldst stämpling står överst. Har den anställde gått hem och lämnat arbetet öppet märks raden **Pausad** och tiden räknar inte vidare. Har den anställde frånvaro registrerad idag märks raden även **Frånvarande** (bara för administratörer och arbetsledare). Arbetet får ligga kvar pausat; det återupptas när personen stämplar in närvaron igen.
- **På plats utan arbete** listar de som är närvaroregistrerade men inte instämplade på någon operation, med **Sedan** och **Tid** på plats.

När en operation blir klar — någon kryssar **Operationen är klar** vid utstämplingen, **Slutför** på operationen i tillverkningsordern eller inleveransen av en legorad — stämplas alla andra som är instämplade på operationen ut automatiskt, med antal 0. Blir hela ordern klar (inleveransen från sista operationen eller **Slutför order**) gäller det alla operationer på ordern. En pausad stämpling stämplas ut vid tiden då pausen började, övriga vid klarmarkeringen. Det gör att den som kommer tillbaka efter frånvaro inte kan rapportera på en operation som redan är klar.

### Stämpla ut

Administratörer och arbetsledare har en knapp **Stämpla ut** på varje rad, för att stämpla ut någon som glömt det. **Sluttid** är förifylld med när arbetet pausades (om den anställde har gått hem) eller med nu; ändra den till när arbetet faktiskt slutade. Rör du inte fältet stämplas arbetet ut exakt vid pausen respektive i det ögonblick du sparar (fältet visar bara hela minuter). Tiden som rapporteras visas under fältet, och tidrapporten dateras på sluttidens dag. Ett pausat arbete som stämplas ut utan ändrad sluttid dateras på pausens dag, som vid den automatiska utstämplingen — i dag om den dagen ligger i en låst löneperiod, så att en gammal pausad stämpling alltid går att stämpla ut. En sluttid du själv ändrar till en dag i en låst löneperiod går inte att spara. Dialogen visar Planerat / Klart / Kvar och frågar efter **Antal OK** (förifyllt med **Kvar** när rutan **Stämpling** under **Rest som förslag i antalsfältet** är markerad — men tomt och med raden "Antal OK är tomt eftersom någon annan också stämplar på operationen." om någon annan har en pågående stämpling på samma operation), **Kasserat**, **Kassationsorsak** (krävs när kasserat är större än 0; med kvalitetsorsaker för kassation väljs en **Orsak** och fritexten blir **Kommentar**), **Operationen är klar** och **Notering**. Tidrapporten får stämplingens typ (**Ställ** eller **Produktion**), om den har någon. Effekten är densamma som när den anställde stämplar ut i [stämpelterminalen](/hjalp/terminal): en tidrapport skapas, material som är kopplat till operationen förbrukas och kassationer loggas.

## Tidrapporter

**Tillverkning → Tidrapporter** listar all rapporterad tid (sök på anställd eller ordernummer) med källa **Stämpling** (från terminalen) eller **Manuell**. **+ Ny tidrapport** registrerar tid manuellt: anställd, order, operation, datum och **Tid (tt:mm)**, förifylld med 1:00. Tid kan rapporteras på en order som är frisläppt, pågår eller är klar (efterrapportering), men inte på en planerad, stängd eller makulerad order.

Varje tidrapport sparar resursen tiden gjordes på, och listan visar den. En stämpling får resursen operationen hade när du stämplade in (den kan inte bytas medan någon är instämplad), och en manuell tidrapport får operationens resurs när den registreras — även när den gäller en dag före ett byte. Resursen går inte att ändra i efterhand. Tid som rapporterades innan resursen sparades visar operationens nuvarande resurs.

Är inställningen **Dela tid i ställ och produktion** på (se [Inställningar](/hjalp/system#installningar)) har formuläret också fältet **Typ** (**Ej uppdelad**, **Ställ** eller **Produktion**, förvalt **Produktion**), och listan har kolumnen **Typ** efter **Timmar** (tom när tiden inte är uppdelad). Tid som stämplas i terminalen får typen från stämplingen (se [Ställ och produktion](/hjalp/terminal#stall-och-produktion)). Exportfilen har samma kolumn, **Typ**, efter **Timmar**. En stämplings tid, operation och antal rättas under [Personal & lön → Stämplingar](/hjalp/lon#stamplingar), där också manuella tidrapporter kan ändras och tas bort; servern kräver aldrig någon typ. Bara typen går att rätta även i en låst löneperiod, eftersom lönen läses ur närvaron och inte ur tidrapporterna. Tid som registrerades innan inställningen infördes förblir **Ej uppdelad**.
