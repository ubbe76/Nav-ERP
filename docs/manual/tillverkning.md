# Tillverkning

Tillverkningsmodulen i Nav|ERP driver tillverkningsordrar (TO) genom flödet frisläppt → pågår → klar → stängd (en ny tillverkningsorder frisläpps när den skapas; status planerad finns kvar för äldre ordrar), med materialförbrukning, tidrapportering och efterkalkyl. Menyvalet **Tillverkning** öppnar modulens sida, som samlar modulens funktioner i ett rutnät.

## Översikt

Menyvalet **Tillverkning** öppnar modulens sida, där alla tillverkningsfunktioner ligger grupperade i ett rutnät:

- **Ordrar** — **Tillverkningsordrar**.
- **Verkstad** — **Stämpelterminal**, **Pågående arbete** och **Tidrapporter**.
- **Planering** — **Behovsberäkning**, **Beläggning**, **Körplan** och **Scheman**.
- **Resurser** — **Resurser** och **Produktionsgrupper**.

Personal och lön har en egen meny, **Personal & lön** (se kapitlet [Personal & lön](/hjalp/lon)). Nyckeltal för pågående tillverkning finns på **Översikt**, startsidan.

## Resurser

**Tillverkning → Resurser** är register över maskiner och personalresurser som utför operationer. Varje resurs har **nummer (3 siffror)**, namn, typ (Maskin/Personal), **timkostnad**, **TO-påslag (%)** och en produktionsgrupp.

De fält som justeras oftast går att ändra direkt i listan: tryck **Ändra** längst till höger på raden så blir **Produktionsgrupp**, **Veckoschema** (med kapacitetsfaktorn under, efter ×), **Timkostnad** och **TO-påslag** inmatningsfält. **Spara** (eller Enter) skriver ändringarna, **Avbryt** (eller Esc) lämnar raden som den var; bara en rad kan redigeras åt gången. Övriga fält — nummer, namn, typ, status och förvalsfälten — ändras genom att trycka på resursens namn, vilket öppnar hela formuläret.

Under fältet **Nummer (3 siffror)** visas en lista över redan upptagna nummer med resursens namn — maskiner, personal och legoresurser delar samma nummerserie, så listan visar alla tre sorterna oavsett vilket register du står i. Skriver du in ett upptaget nummer byts listan mot en varning, t.ex. "Numret 101 används redan av Svarv (Maskin)", och knappen **Skapa resurs** (**Spara resurs** när du redigerar) går inte att klicka förrän du väljer ett annat nummer. Redigerar du en befintlig resurs räknas dess eget nummer förstås inte som upptaget.

Timkostnaden ger den direkta lönekostnaden i för- och efterkalkylen, och **TO-påslaget** (tillverkningsomkostnad) räknas på den lönekostnaden. Nav sparar timkostnadens historik vid varje ändring, oavsett om den görs i listan, i formuläret eller med [resursimporten](#importera-resurser). Efterkalkylen och [Produkter i arbete](/hjalp/rapporter#produkter-i-arbete) räknar varje dags rapporterade tid till timkostnaden som gällde den dagen, och en ändring gäller hela dagen den görs. Tid som rapporteras för en dag innan historiken började räknas till den timkostnad resursen hade då. En ändrad timkostnad gäller från ändringsdagen; dagarna före behåller den gamla. Rättar du ett felaktigt värde samma dag ersätter rättelsen det för hela dagens tid, men en rättelse en senare dag gäller bara från den dagen — historiken går inte att rätta i efterhand, så kontrollera timkostnaden när resursen läggs upp. TO-påslaget har ingen historik: dagens procent gäller. Det ingår inte i kalkylens tillverkningskostnad (TVK) eller självkostnad (SVK) utan läggs till sist, direkt på försäljningspriset efter det generella påslaget. TO-påslaget är det enda påslaget som sätts per resurs — övriga påslag (MO, LO, Affo, generellt påslag och materialpåslag) är systemomfattande och ligger under **System → Kalkyler**, se [System & inställningar](/hjalp/system#kalkyler).

För [beläggningen](#belaggning) och [Leveranstidskontrollen](/hjalp/forsaljning#leveranstidskontroll) har resursen även **Veckoschema (kapacitet)** — ett veckoschema ur schemaregistret som anger resursens tillgängliga tid — eller, enklare, **Kapacitet (timmar per dag)**: så många timmar måndag–fredag, där en röd dag i helgdagskalendern är ledig och en halvdag följer helgdagens dagschema. Har resursen båda gäller veckoschemat. **Kapacitetsfaktor** multiplicerar tiden (t.ex. 2 = två likadana maskiner eller två personer; 0,5 = halvtid). Utan veckoschema och timmar per dag visar beläggningen ingen kapacitet för resursen, bara dess last. I resurslistan heter kolumnen **Kapacitet** och visar veckoschemat eller t.ex. *7,5 h/dag*.

Resursen kan också bära sex förvalsfält som ännu bara sparas — beredningen läser dem inte än: **Förvald ställtid**, **Förvald operationsbenämning**, **Kalkylpris 1**, **Kalkylpris 2**, **Gäller ställ** och **Gäller styck**.

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

**Tillverkning → Ordrar** listar alla TO med sök och statusfilter. Statusfiltret har också **Sen**: frisläppta och pågående ordrar som produktionsplaneringen markerar **Sen** — samma urval som aviseringen [Sena tillverkningsordrar](/hjalp/aviseringar). **Sen** är ingen egen status utan räknas fram när listan visas. Filtret har också **Halvfabrikat sent** — ordrar där ett halvfabrikat som ordern behöver blir klart för sent, se [Halvfabrikat sent](#halvfabrikat-sent).

### Läsläge

Den som bara har rättigheten **Tillverkningsorder (läsläge)** (verkstadsprofilen, se [Behörighetsgrupper](/hjalp/system#behorighetsgrupper)) ser tillverkningsorder i läsläge. Listan saknar då **+ Ny tillverkningsorder**, **Exportera**, markering och åtgärdskolumn. På kortet finns inga knappar, ingen redigering av **Planerat färdigdatum**, ingen kalkyl och ingen **Historik** (den är bara för administratörer). **Skriv ut TO (PDF)** och pallkorten finns kvar. Legooperationernas priser visas som **–**: priser är kontorsdata, och den som saknar menyrättigheter ser dem inte. Rättigheten **Tillverkning** ger fullt läge.

### Skapa och frisläppa

1. **+ Ny tillverkningsorder**: välj artikel (artikelväljaren) och antal (har artikeln en **Avrundning** på Lager-fliken avrundas antalet uppåt till närmaste multipel när ordern skapas — 12 med Avrundning 10 blir 20; detsamma gäller en TO som skapas från en kundorderrad), samt eventuellt **Planerat färdigdatum** — datumet styr vilken vecka orderns operationstid räknas i i [beläggningen](#belaggning) så länge ordern inte är planerad (en planerad order räknas i sina [planerade veckor](#planerade-veckor); färdigdatumet ändras aldrig av planeringen) och kan sättas eller ändras på TO-kortet i efterhand (med **Spara**, så länge ordern är Planerad/Frisläppt/Pågår). Medan ett ändrat datum inte är sparat är **Flytta halvfabrikaten…**, **Skapa saknade halvfabrikat…** och legooperationens **Skapa inköpsorder** avstängda — de räknar från det sparade datumet. Ordern får ett TO-nummer och **frisläpps direkt** (status **Frisläppt**), så den syns i [stämpelterminalen](/hjalp/terminal) och går att stämpla in på med en gång. Den **planeras också direkt**: operationerna läggs i tur och ordning på resursernas lediga tid från i dag, se [Planerade veckor](#planerade-veckor). När du väljer artikel föreslås färdigdatumet automatiskt, se [Föreslaget färdigdatum](#foreslaget-fardigdatum).
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

### Planerade veckor

Varje operation på en tillverkningsorder kan ha en **planerad vecka** (eller flera, om tiden inte ryms i en): den vecka operationen beräknas börja och den vecka den beräknas bli klar, utifrån resursens lediga tid. Operationstabellen på TO-kortet har kolumnen **Planerad vecka** — till exempel **v.45** eller **v.45–47**. Står det **Ej planerad** har operationen ingen plan än (äldre ordrar, tills du kört **Planera** första gången, eller en operation som inte rymdes inom två år). **Låst** betyder att veckan är flyttad för hand i [beläggningen](#belaggning) och ligger kvar när du kör **Planera**. Klara operationer och legooperationer visar **–**.

En **ny tillverkningsorder planeras direkt när den skapas**, oavsett om den skapas från **+ Ny tillverkningsorder**, från en kundorderrad, med behovsberäkningens **Skapa ordrar** eller via API:t: operationerna läggs i tur och ordning från i dag på ledig kapacitet, mot all annan last. Räcker inte kapaciteten inom två år lämnas operationen oplanerad och ordern visar en varning vid frisläpp. Planen ändrar aldrig **Planerat färdigdatum** — datumet är kundens behov, planen är vår.

Ordern märks **Sen** — på TO-kortet bredvid statusen, och i listan i kolumnen **Planerad** — när den sista operationen beräknas bli klar efter **Planerat färdigdatum**. En order utan plan är **Sen** när färdigdatumet passerat. Listan **Tillverkning → Ordrar** har kolumnen **Planerad** med orderns planerade veckor (från första till sista väntande operation).

### Skapa från kundorder

En tillverkningsorder kan också skapas direkt från en kundorderrad i stället för via **+ Ny tillverkningsorder**. På kundorderkortet (se [Försäljning](/hjalp/forsaljning#kundorder)) visar en rad med en tillverkningsartikel knappen **Skapa TO** i kolumnen **I tillverkning** så snart ordern är **Bekräftad** eller **Under tillverkning** och raden inte redan är täckt av tillverkningsordrar eller helt levererad. På en konfigurerad beställningsvarurad finns knappen också — se [Tillverkningsorder för beställningsvara](#tillverkningsorder-for-bestallningsvara). Dialogen förifyller fältet **Antal** med det som återstår av radens beställda antal — redan skapade, ej makulerade tillverkningsordrar mot samma rad räknas av — men antalet går att ändra innan **Skapa tillverkningsorder** klickas. Fältet **Planerat färdigdatum (valfritt)** förifylls med arbetsdagen före kundorderns leveransdatum, så länge raden inte redan är täckt av lager eller befintliga inköps-/tillverkningsordrar. Är raden redan täckt — eller saknar kundordern leveransdatum — används artikelns första otäckta behov i stället (se [Föreslaget färdigdatum](#foreslaget-fardigdatum)). Undantaget är en konfigurerad beställningsvarurad: där gäller alltid radens eget leveransdatum (arbetsdagen före, idag som tidigast) — mallens lager och andra raders tillverkningsordrar är andra konfigurationer och täcker den inte — och saknar kundordern leveransdatum lämnas fältet tomt.

Den nya tillverkningsordern frisläpps direkt (status **Frisläppt**) precis som en manuellt skapad TO, med kundorderraden kopplad, och du hamnar direkt på TO-kortet — som visar raden **Kundorder:** med en länk till kundordern och kundens namn. Kundordern får automatiskt status **Under tillverkning** (om den inte redan är det), och kundorderraden visar därefter kolumnen **I tillverkning** med det kopplade antalet och TO-numret som länk med orderns status. Knappen under dem heter sedan **Skapa TO för resten (N st)** och försvinner när raden är helt täckt. En kundorderrad med en kopplad tillverkningsorder kan inte tas bort — även om tillverkningsordern senare makuleras: kopplingen är historik och blockerar borttagning ändå, men en makulerad TO räknas inte längre med i kolumnen **I tillverkning**.

### Under tillverkning

- **Rapportera**: all manuell avrapportering görs i kortet **Rapportera** på TO-kortet (se [Avrapportera operation](#avrapportera-operation)): en rad per operation med dess kopplade material under, gruppen **Vid slutrapportering** för material utan operation, en rad **Rapportera tid** och — på en frisläppt eller pågående order — en rad **Slutför order**. **Makulera order**, **Efterkalkylera** och **Skriv ut TO (PDF)** ligger i verktygsraden överst på tillverkningsordern.
- **Material**: klicka **Förbruka** på materialraden i kortet **Rapportera**. Välj lagerplats i **Lagerplats för materialuttag** högst upp i kortet (gäller både **Förbruka** och **Slutför**) och ange antal — ett materialuttag bokförs i lagret. **Antal** är förifyllt med det som återstår av radens planerade mängd (planerat − förbrukat); skriv över det om uttaget ska vara ett annat. Överuttag utöver planerat stoppas. Är strukturraden skriven i en alternativ enhet (se [Artiklar](/hjalp/artiklar)) visas och matas materialraden in i den enheten (kolumnen **Enhet**); uttaget bokförs alltid i komponentens grundenhet.
- **Operationsraderna** har **Ändra** (på en väntande operation) och en **⋯**-meny med **Pallkort**, **Ta bort** och — på en väntande lego-operation — **Skapa inköpsorder** och **Skapa förfrågan** (se [Legoinköp på TO-kortet](#legoinkop-pa-to-kortet)). I läsläge och på en klar eller stängd order finns bara knappen **Pallkort**.
- **Operationer**: personalen stämplar in/ut på operationerna i [stämpelterminalen](/hjalp/terminal), eller så rapporteras tid manuellt på raden **Rapportera tid** (**Anställd**, **Operation**, **Datum**, **Timmar** och en valfri **Anteckning**). **Timmar** är förifyllt med operationens teoretiska tid — ställtid + tid/enhet × orderns antal — minus den tid som redan är rapporterad på operationen; fältet är tomt när allt är rapporterat eller operationen saknar tider. Med inställningen **Dela tid i ställ och produktion** på har raden också **Typ**, förvald till **Produktion**, och förslaget följer valet: **Produktion** ger stycktid × orderns antal minus den tid som rapporterats som produktion, **Ställ** planerad ställtid minus den tid som redan rapporterats som ställ, och **Ej uppdelad** hela operationen som förut. Ett timtal du själv skrivit in skrivs inte över när du byter **Typ**. Klicka **Slutför** på operationen när den är klar — se [Avrapportera operation](#avrapportera-operation). Har operationen en **Packinstruktion** visas den i dämpad text under operationsraden i tabellen (se [Artiklar](/hjalp/artiklar#packinstruktion-pa-operationen)). Kolumnen **Tid/enhet** visar Stycktid i den enhet operationen bereddes i (min/st, sek/st eller st/h) — se [Tidsenhet på operationen](/hjalp/artiklar#tidsenhet-pa-operationen).
- Ordern får status **Pågår** automatiskt vid första instämplingen eller inleveransen — det finns ingen knapp för att starta den.

### Legoinköp på TO-kortet

En lego-operation köps av en leverantör (se [Legoresurser](#legoresurser)). Under operationens namn i tabellen **Operationer** står vilken leverantör som gör den och vad som redan är köpt: en rad per inköpsorder mot operationen, t.ex. **IO-1042 (Utkast) · 1 000 st · önskat 2026-12-04** (och **mottaget …** när något har levererats in), och en rad per öppen förfrågan, t.ex. **Förfrågan FO-1024 (Skickad)**. Makulerade inköpsordrar och förfrågningar som redan blivit order visas inte. Är inget köpt står det **Ingen inköpsorder än**.

Under inköpsorderraden står även **skickat …** när gods har rapporterats som skickat till leverantören. Operationens **⋯**-meny har dessutom en post **Avsändning IO-…** per öppen inköpsorder (Utkast, Bekräftad eller Delvis mottagen) som köper operationen; den öppnar [Avsändning lego](/hjalp/inkop#avsandning-lego) med ordern förvald och visas bara för dig som har rättigheten Inköp.

På en väntande lego-operation i en frisläppt eller pågående order har radens **⋯**-meny två val:

- **Skapa inköpsorder** gör samma sak som **Skapa ordrar** i [behovsberäkningen](#orderforslag-och-skapa-ordrar), men för just den här operationen. Dialogen visar leverantören, styckpriset, ställpriset (med transportkostnaden) och **Redan beställt** av orderns antal. **Antal** är förifyllt med det som återstår att beställa. Är allt redan beställt är fältet tomt, och du kan skriva ett antal om operationen ska köpas en gång till. Inköpsordern skapas som **Utkast** hos operationens leverantör, med styckpriset som à-pris, ställpriset på raden (båda omräknade från kronor med orderns kurs när leverantören har en annan valuta) och **Önskat leveransdatum** när operationen måste vara tillbaka (se [Behovsberäkning](#orderforslag-och-skapa-ordrar)). Valet är avstängt när operationen saknar leverantör — sätt leverantören med **Ändra**. Det kräver rättigheten Tillverkning, precis som **Skapa ordrar**.
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
- **Förslag:** när ordinarie resurs är full och en alternativ resurs skulle bli klar en tidigare vecka visar operationsraden märket **Förslag: 120**, texten *Kan bli klar v.47 på 120 (i stället för v.49)* och knappen **Byt till 120** (rättigheten Tillverkning krävs; knappen finns bara på en frisläppt eller pågående order). Har operationen ingen plan på nuvarande resurs står det i stället *Kan planeras klar v.47 på 120 (saknar plan på nuvarande resurs)*. **Byt till 120** byter resurs direkt, planerar om ordern och markerar operationen **Vald för hand**, så förslaget försvinner. Se [Förslag på alternativ resurs](#forslag-pa-alternativ-resurs).
- **Vald för hand:** kryssrutan visas när operationen har alternativ och en av dess resurser är vald. Den kryssas i av sig själv när du byter resurs, och märker att bytet är ditt val. Kryssa ur den och spara för att ta bort märket, så att operationen åter kan få förslag. Byter du till en resurs som inte är en av operationens resurser tas alternativen och märket bort från ordern, och dialogen varnar innan du sparar.
- **Vad ett byte påverkar:** bytet gäller bara den här tillverkningsordern. Ordern planeras om, och operationen hamnar i lediga veckor på den nya resursen; ett veckolås på operationen släpps, eftersom veckorna var bokade på den gamla resursen. Stämpelterminalen visar operationen på den nya resursens station. Har den gamla resursen redan arbetat på operationen planeras den nya resursens ställtid ändå, tills den nya resursen har rapporterat tid på operationen. Tid som redan är rapporterad står kvar på resursen den gjordes på (dialogen säger det när något redan är rapporterat): [efterkalkylen](#efterkalkyl) och [Produkter i arbete](/hjalp/rapporter#produkter-i-arbete) räknar den med den resursens timkostnad, och ny tid räknas på den nya resursen. Avvikelseanalysen räknar bytet som en ny plan: Kalkylerat är den nya resursens tider och timkostnad. Förkalkylen står kvar på den ordinarie resursen. En instämplad operation går inte att byta ("Någon är instämplad på operationen — stämpla ut först"), och spärrarna för inköpsrader och lego gäller som förut.
- **Ta bort** finns bara på en operation som aldrig haft något: ingen rapportering (inte heller en ångrad), ingen tidrapport, ingen stämpling, ingen kassation och ingen inköps- eller förfrågningsrad. Material som var kopplat till operationen blir okopplat och dras vid inleveransen i stället.
- **Sista operationen** är den vars Antal OK blir färdiga varor. Så snart något levererats in från den kan ingen ändring byta vilken operation som är sist: inte lägga till en efter den, inte ta bort den och inte numrera om så att en annan blir sist ("Varor har levererats in från sista operationen").

Varje operationsändring (lägg till, ta bort, ändrad tid, resurs eller sekvens) **planerar om orderns väntande operationer** med samma regler som **Planera** (se [Planera](#planera)): påbörjade operationer från innevarande vecka, låsta operationer ligger kvar, all annan last räknas som upptagen. En låst operation som byter resurs tappar låset, eftersom veckorna var bokade på den gamla resursen; en låst operation som bara får ny tid behåller låset och veckorna. Planeringens varningar (sen order, kapaciteten räcker inte inom två år, operation i fel ordning, [orimligt mycket tid](#planera)) och materialets bristvarningar visas i en notisruta på kortet efter sparandet.

Alla ändringar loggas i orderns **Historik**: Material tillagt/ändrat/borttaget och Operation tillagd/ändrad/borttagen, med artikel respektive operation och resurs och vad som ändrades.

### Materialbrist vid rapportering

Inställningen **Materialbrist vid rapportering** (System → Inställningar, se [Inställningar](/hjalp/system#installningar)) styr vad som händer när en rapportering skulle dra mer material än vad som finns i lager. Det som jämförs är det material rapporteringen drar mot artikelns **saldo på alla lagerplatser som inte är spärrade** (se [Spärrade lagerplatser](/hjalp/lager#sparrade-lagerplatser)); flera materialrader med samma artikel i en rapportering läggs ihop, och tjänsteartiklar kontrolleras aldrig.

- **Ingen kontroll** — rapporteringen går alltid igenom (standard).
- **Varning** — innan något sparas visas "Det saknas ingående delar: Plåt 2 mm (behöver 8 st, tillgängligt 3 st). Rapportera ändå?". Välj **Rapportera ändå** för att bokföra rapporteringen, eller avbryt — då sparas ingenting och formuläret står kvar som det var.
- **Spärr** — rapporteringen nekas och meddelandet "Det finns inte tillräckligt med ingående delar: …" visas. Fyll på lagret (eller korrigera saldot) och rapportera igen.

Kontrollen gäller utstämpling i [stämpelterminalen](/hjalp/terminal) och på **Pågående arbete**, **Slutför** (operationen), **Slutför order** och **Förbruka** i kortet **Rapportera**, samt inleverans av legorader (se [Inleverans](/hjalp/inkop#inleverans)). **Ångra** påverkas inte — där läggs material tillbaka.

### Avrapportera operation

Kortet **Rapportera** har en rad per operation, sorterade efter sekvensnummer, och högst upp ett kort förklarande stycke. Kolumnrubrikerna (**Operation**, **Klart/Kvar**, **Antal klart**, **Kasserat**, **Faktisk tid**) står en gång överst i kortet; på en mobil staplas raderna och varje fält har sin egen etikett. Kolumnen **Klart/Kvar** på en operation som **Väntar** visar **Klart** (antal OK som redan rapporterats, t.ex. från stämpelterminalen) och **Kvar** (orderns antal minus klart — kasserade enheter måste göras om och minskar inte Kvar), samt **Kasserat** när något kasserats; orderns planerade antal visas som tips när du håller muspekaren över siffrorna. På samma rad anges **Antal klart** (förifyllt med vad som **återstår** av orderns antal — delrapporter från stämpelterminalen räknas alltså inte dubbelt), **Kasserat** med **kassationsorsak** (obligatorisk när kasserat > 0; finns det [kvalitetsorsaker](/hjalp/kvalitet#kassation-och-orsaker) för kassation väljs en **Orsak** i listan och fritexten blir en valfri **Kommentar**) och eventuell **Faktisk tid**, sedan **Slutför**; fältet **Lagerplats för materialuttag** högst upp i kortet styr varifrån det kopplade materialet dras. En klar operation visas bara som text ("Klart 5 av 5 · Klar"). En lego-operation har samma **Slutför** som manuell väg och texten "Lego — avrapporteras vid inleverans". Operationen markeras **Klar** först när totalt **Antal OK** når orderns antal; rapporterar du färre ligger den kvar som **Väntar** och kan rapporteras vidare här eller i [stämpelterminalen](/hjalp/terminal). Kasserade enheter räknas inte — de måste göras om.

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

Sektionen **Rapporteringar** på detaljsidan listar allt som rapporterats på ordern, senaste först: **Utstämpling** (varje utstämpling i terminalen, även en utan antal), **Slutför operation**, **Inleverans IO-…** (en lego-operation som avrapporterats av inköpsorderns inleverans), **Materialuttag** (**Förbruka** för hand), **Slutför order** och **Automatisk utstämpling** — tiden för någon som stämplades ut när operationen eller ordern blev klar (se [Pågående arbete](#pagaende-arbete)); den kan ångras som en vanlig utstämpling. Varje rad visar operation, **OK**, **Kasserat**, **Inlevererat**, stämplingens **Timmar**, vem som rapporterade och vilket material som drogs, med lagerplats. En **tjänst** i strukturen bokas som förbrukad utan lagerplats och utan att något dras från lagret — [tjänster lagerförs inte](/hjalp/artiklar#artikeltyper) — men räknas i efterkalkylen och i produkter i arbete som annat material.

Direkt efter **Slutför** på en operation i kortet **Rapportera** visar Nav en notis nere till höger, t.ex. *Rapporterat 5 OK på 10 — Laserskärning.* För administratörer och arbetsledare har den **Ångra**, som backar just den rapporteringen utan någon extra fråga. Samma sak gäller de andra raderna i kortet:

- **Förbruka** — *Förbrukat 2 st 1002.*; **Ångra** lägger tillbaka materialet där det togs.
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

### Halvfabrikat sent

Märket **Halvfabrikat sent** visas på TO-kortet (bredvid **Sen**), i listan **Tillverkning → Ordrar** och i Beläggningen när en tillverkningsorder för ett halvfabrikat som ordern behöver blir klar efter att behovet uppstår. Det gäller frisläppta och pågående ordrar — samma ordrar som kan bli **Sen**. Halvfabrikatets klardatum är planens slutdatum, annars **Planerat färdigdatum** — samma datum som avgör **Sen**. Lager är aldrig sent, och en sen inköpsorder eller saknat inköpsmaterial ger inget märke (kortet visar dem i **Täcks av**). Filtrera listan med statusvalet **Halvfabrikat sent**.

### Flytta halvfabrikaten

Knappen **Flytta halvfabrikaten…** (behörighet Tillverkning, bara på en öppen order) finns när något halvfabrikat bör få nytt färdigdatum. Dialogen **Flytta halvfabrikaten** listar tillverkningsordrarna med indrag per nivå — halvfabrikatets egna halvfabrikat står under det — med **Nuvarande färdigdatum** och **Föreslaget färdigdatum** och en kort orsak: *Sen för ordern*, *Behövs tidigare*, *Kan bli klar senare* eller *Saknar färdigdatum*.

Förslaget är arbetsdagen före det tidigaste behovet bland alla behov ordern täcker, så en flytt gör aldrig ordern sen för ett annat behov. Går en order också till andra behov står *går också till andra behov* och den är inte förvald. *hinner inte* betyder att förslaget är första möjliga dag med ledtiden och ändå ligger efter behovet. En sen order vars färdigdatum redan ligger före behovet får inget förslag — då är det planen eller kapaciteten som gör den sen.

Avmarkerar du en rad avmarkeras och inaktiveras de ordrar som hör under den. Tryck **Flytta** (avstängd utan markerade rader) och bekräfta. Bara **färdigdatum** ändras: kör **Planera** i Beläggningen för att lägga om veckorna, som dialogen påminner om. Har något datum ändrats under tiden visas ett felmeddelande och raderna läses in på nytt.

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

**Skriv ut TO (PDF)** överst på tillverkningsorderns detaljsida skapar underlaget som lämnas till operatören:

- Företagsuppgifter och logotyp, ordernummer, status, artikel och antal att tillverka samt eventuell anteckning.
- Är ordern skapad från en kundorderrad (se [Skapa från kundorder](#skapa-fran-kundorder) ovan) visas raden **Kundorder:** med kundorderns ordernummer och kundens namn.
- **Operationer** med ställtid, stycktid, beräknad tid och en signaturkolumn att bocka av i. Kolumnen **Operation** visar resursens tresiffriga kod följd av operationens **Beskrivning** — saknas beskrivning står resursens namn där i stället (se [Artiklar](/hjalp/artiklar#beskrivning-pa-operationen)). Har operationen en **Kommentar** som är märkt **Skriv ut på arbetskortet** skrivs texten under sin operationsrad (se [Artiklar](/hjalp/artiklar#kommentar-pa-operationen)). Har operationen en **Packinstruktion** skrivs den **alltid** ut under operationsraden med prefixet "Packning: ", oavsett om **Skriv ut på arbetskortet** är ikryssad (se [Artiklar](/hjalp/artiklar#packinstruktion-pa-operationen)). Beskrivningen, kommentaren och packinstruktionen är de som gällde när ordern frisläpptes. Stycktid visas i den enhet operationen bereddes i — "7 st/h" i stället för "8,5714 min" när beredningen är växlad till **st/h**, och "45 sek" i stället för "0,75 min" när den är växlad till **sek/st** (se [Tidsenhet på operationen](/hjalp/artiklar#tidsenhet-pa-operationen)); beräknad tid är alltid i minuter, eftersom den är en totalsumma, inte en hastighet. Tiderna skrivs med högst två decimaler och utan onödiga nollor — "10 min", "6 min" och "8,57 min".
- **Material** med enhet, planerat och uttaget antal (i radens enhet) plus signaturkolumn, samt en rad för "Utförd av / Datum". Kolumnen **Op** visar sekvensnumret för operationen som drar materialet (motsvarande materialtabellens kolumn **Operation**, se [Avrapportera operation](#avrapportera-operation) ovan) — ett streck ("—") betyder att materialet dras vid slutrapportering i stället. Materialraderna är sorterade efter denna operation, sedan artikelnummer.
- Raden med revisionerna ordern byggs efter under artikeln, t.ex. *Revision B · Ritningar: R-1001 rev 2, R-1002-SVETS rev A* (se [Ritningar och revisioner](#ritningar-och-revisioner)), och under en operation med valda ritningar eller filer raden *Ritning: R-1002-SVETS rev A · Fil: monteringsanvisning.pdf*.
- **Ritningarna** läggs sist i dokumentet — PDF:er som extra sidor, JPEG/PNG som en sida var: filerna på de ritningsrevisioner ordern byggs efter och artikelns filer under fliken Filer (se [Artiklar](/hjalp/artiklar#filer)). En äldre revisions fil skrivs inte ut.

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

Beräkningen omfattar alla artiklar på en gång, så resultatet **återanvänds i upp till en minut**: att bläddra, söka eller filtrera i listan räknar inte om allt. Längst till höger i verktygsraden står när resultatet beräknades (**Beräknad 08:12:03**). Har något ändrats — t.ex. en kundorder eller inleverans som just registrerats — klickar du **Uppdatera** för att räkna om direkt. Efter **Skapa ordrar** och **Skapa förfrågan** räknas listan alltid om automatiskt, och efter **Skapa saknade halvfabrikat**, **Flytta halvfabrikaten** och Leveranstidskontrollens **Använd datumet** räknas den om nästa gång den öppnas.

### Vad som räknas

För varje artikel ställs behov mot saldo och inkommande:

- **Behov** är summan av: kundorderrader i status **Bekräftad** eller **Under tillverkning** (beställt minus levererat), materialrader på frisläppta tillverkningsordrar och ordrar som Pågår (planerat minus uttaget), samt material till **Planerad** tillverkningsorder (beräknat ur strukturen, eftersom materialet snapshotas först vid frisläpp). **Offerter räknas inte som behov.**
- **Inkommande** är summan av: inköpsorderrader i status **Bekräftad**/**Delvis mottagen** (beställt minus mottaget), inköpsorder i status **Utkast** (särredovisas som IO-utkast — så att redan skapade orderförslag inte föreslås igen), och tillverkningsordrar i status **Planerad**/**Frisläppt**/**Pågår** (orderns antal minus det som redan inlevererats från sista operationen — det ligger redan i saldot).
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

Vill du se **när** behoven infaller finns ikonknappen **Artikelöversikt** efter artikelnumret på varje rad. Den öppnar artikelns planeringsbild i en flyttbar panel — alla öppna behov och inkommande i datumordning med löpande disponibelt antal, se [Artikelöversikt](/hjalp/artiklar#artikeloversikt). Panelen ligger kvar medan du arbetar vidare i listan och byter artikel när du klickar på en annan rads knapp.

Med rader markerade finns knappen **Kopiera artiklar (N)** bredvid **Skapa ordrar**: den lägger artiklarna på de markerade raderna, en gång var, i din personliga lista **Kopierat** — se [Kopierat](/hjalp/artiklar#kopierat).

Filtret **Alla / Artiklar / Lego** i verktygsraden begränsar listan till antingen vanliga artikelrader eller lego-rader (operationsbehov, se nedan) — praktiskt eftersom lego-raderna alltid sorteras sist i listan.

I tabellhuvudet finns en kryssruta som markerar **alla valbara rader på den sida som visas** (rader märkta **Saknar huvudleverantör**/**Saknar leverantör** eller utan förslag går fortfarande inte att välja). Den visar ett mellanläge när bara några rader på sidan är valda, och avmarkerar allt vid nästa klick. Val på andra sidor påverkas inte — statusraden under tabellen fortsätter räkna dem ("varav X på annan sida"). När listan räknas om (**Uppdatera**, eller när resultatet är äldre än en minut) stäms alla val av mot det nya resultatet: ett förslag som flyttat till en annan vecka eller blivit täckt försvinner ur valen, och ett ändrat behovsdatum följer med — även för rader på andra sidor. Ett antal du själv skrivit står kvar. På en smal skärm (mobil i stående läge) visas listan som staplade kort utan rubrikrad; då ligger kryssrutan **Välj alla på sidan** samt **Skapa förfrågan** och **Skapa ordrar** i stället i en rad ovanför listan som följer med när du skrollar.

Markera raderna och klicka **Skapa ordrar**:

- **Ett förslag som redan täckts skapas inte igen.** Innan ordrarna skapas räknas behovsberäkningen om. Ett markerat förslag som inte längre finns — för att någon just skapat ordrar för det, i en annan flik eller med ett klick till efter ett avbrutet anrop — skapas inte utan listas bland felen: *Förslaget finns inte längre — uppdatera behovsberäkningen*. För förslag som finns kvar gäller antalet du har skrivit. Klickar två personer **Skapa ordrar** samtidigt skapas ordrarna efter varandra, så den andra ser den förstas ordrar. Det kan ta några sekunder längre när listan är stor.
- Inköpsförslag grupperas till **en inköpsorder per huvudleverantör**, i status **Utkast** med **Önskat leveransdatum** satt efter behovet och leverantörens [leveransdagar](/hjalp/inkop#leveransdagar), ledtid och transportdagar (se [Inköp](/hjalp/inkop#onskat-leveransdatum)) och à-pris från leverantörskatalogen — har huvudleverantören staffelsteg används steget för förslagets antal, annars grundpriset (se [Artiklar](/hjalp/artiklar#inkop)); listan i sig visar bara grundpriset, så orderradens à-pris kan vara lägre än det som stod i listan. Granska och skicka den från inköpsorderkortet som vanligt. En rad utan huvudleverantör kan inte väljas (**Saknar huvudleverantör**); lägg upp leverantören på artikelkortets Inköp-flik först.
- Tillverkningsförslag blir en tillverkningsorder per artikel, frisläppt direkt (status **Frisläppt**), med **Planerat färdigdatum** satt till arbetsdagen före artikelns första otäckta behov (se [Föreslaget färdigdatum](#foreslaget-fardigdatum)); utan otäckt behov med datum, t.ex. ett förslag som bara fyller upp till beställningspunkten, lämnas datumet tomt. Föräldrar skapas före sina komponenter — och tillverkningsordrarna före inköpsordrarna — så en komponents tillverkningsorder, eller ett inköpt material, blir klar arbetsdagen före förälderns.
- **Inköpens datum följer leverantören.** **Önskat leveransdatum** blir den senaste möjliga ankomsten **före** behovsdagen enligt leverantörens leveransdagar, men aldrig tidigare än den tidigast möjliga ankomsten med leverantörens ledtid (leverantörskatalogens **Ledtid (dagar)**) och transportdagar. Utan leveransdagar, ledtid och transportdagar blir det arbetsdagen före behovet. Hamnar leveransen efter behovet skapas ordern ändå, och en varning listas i resultatet efter **Skapa ordrar**, t.ex. "IO-1042 · ART-1: Leveransen (2026-11-02) kommer efter behovet (2026-10-21)". Kundorderns behov räknas här på avsändningsdagen, se [Leveransdagar](/hjalp/forsaljning#leveransdagar).
- **Lego-rader** (märkta **Lego**, med tillverkningsorderns nummer och operation under artikeln) är operationsbehov, inte artikelbehov: varje ofärdig lego-operation på en tillverkningsorder som är Frisläppt eller Pågår föreslås med **orderantal minus redan beställt** (summan på ej makulerade inköpsorderrader mot operationen), utan kvittning mot lagersaldo. Förslagen grupperas till en inköpsorder i status **Utkast** per leverantör, med operationens styckpris som à-pris och ställpriset (ställpris + transportkostnad) på raden. Operationens priser är i kronor: har leverantören en annan valuta räknas de om till den med inköpsorderns kurs. En operation utan leverantör kan inte väljas (**Saknar leverantör**) — sätt leverantören på operationen i beredningen. Planerade tillverkningsordrar ger inga lego-rader (operationerna snapshotas först vid frisläpp). Samma inköpsorder kan skapas från TO-kortet, se [Legoinköp på TO-kortet](#legoinkop-pa-to-kortet).
- **Lego-radernas datum räknas bakåt från tillverkningsorderns Planerat färdigdatum**, eftersom en lego-operation aldrig planeras på egen kapacitet. Operationen måste vara **tillbaka** från leverantören när operationerna efter den hinner bli klara till färdigdatumet: deras tid utan kapacitetshänsyn och systeminställningen **Kötid mellan operationer (dagar)** före var och en av dem. Är lego-operationen sist är det färdigdatumet. **Behovsdatumet** är när varorna måste vara **hos** leverantören: legoresursens **Ledtid (dagar)** + **Kötid (dagar)** före det. **Senaste datum** är legoresursens **Ledtid beställning (dagar)** före behovsdatumet. Exempel: färdigdatum fredag 4 december, lego-operationen sist, ledtid 15 + kötid 2 dagar, ledtid beställning 5 dagar ⇒ tillbaka 4 december, hos leverantören 11 november och beställ senast 4 november. Utan färdigdatum räknas behovsdatumet från tillverkningsorderns start.
- **Lego-inköpsorderns Önskat leveransdatum** blir dagen operationen måste vara tillbaka, men aldrig tidigare än den tidigaste möjliga återkomsten om ordern läggs idag (idag + ledtid beställning + ledtid + kötid, i arbetsdagar). Hinner den inte före behovet skapas ordern ändå, och en varning listas i resultatet, t.ex. "IO-1042 · ART-1: Leveransen (2026-12-09) kommer efter behovet (2026-12-04)". Leverantörens fasta leveransdagar och transportdagar läses inte för lego. Har ordern flera lego-rader får ordern det tidigaste datumet, och en rad med senare datum får sitt eget.

- **Konfigurerade kundorderrader** (sektionen under artikellistan) blir en frisläppt tillverkningsorder per rad, med radens val, se [Konfigurerade kundorderrader](#konfigurerade-kundorderrader).

Ordrarna skapas i basenhet och utan valutaomräkning (växelkurs 1) — justera på orderkortet vid behov. Efter skapandet är förslagen täckta av de nya ordrarna och försvinner ur listan.

Behovsberäkningen hör till **Tillverkning**, så **Skapa ordrar** kräver bara den rättigheten — även för inköpsordrarna. Det är avsiktligt: den som planerar produktionen ska kunna lägga materialbeställningarna, och de skapas som **Utkast** som inköp sedan granskar och skickar. Att öppna, ändra och skicka inköpsordrarna kräver däremot **Inköp**; utan den visas ordernumren i **Skapade ordrar** som vanlig text.

Bredvid **Skapa ordrar** finns knappen **Skapa förfrågan** — den agerar bara på de markerade **lego-raderna**; övriga markerade rader lämnas orörda (och knappen är inaktiv utan någon markerad lego-rad). Den öppnar en dialog med de valda operationerna listade och en lista med leverantörer att kryssa i, förvalda med operationernas egna leverantörer. Till skillnad från **Skapa ordrar**, som alltid bokar mot operationens huvudleverantör, skickas här en förfrågan **per ikryssad leverantör** — praktiskt för att jämföra pris mellan flera legoleverantörer (två förslag för samma artikel hamnar som två rader på leverantörens förfrågan). En förfrågan är inget beställt: raden ligger kvar i listan efteråt, nu med hänvisningen **Förfrågan FO-1024 (Skickad)** under sig (status ändras när förfrågan skickas eller besvaras). Se [Legorader på förfrågan](/hjalp/inkop#legorader-pa-forfragan) i Inköp-kapitlet för hur raden drivs vidare.

Resultatet visas i kortet **Skapade förfrågningar**, med en rad per skapad förfrågan (FO-nummer, leverantör och antal rader), knapparna för att ladda ner/skriva ut PDF:en och **Maila** — precis som **Skapade ordrar** nedan, fast förfrågningarna skapas som **Utkast** och att mejla en sätter den till **Skickad**.

Efter **Skapa ordrar** listas de skapade ordrarna i kortet **Skapade ordrar**. Varje rad har, förutom länken till ordern, knapparna **Ladda ner PDF** och **Skriv ut** (öppnar PDF:en i en ny flik där webbläsaren sköter utskriften). Inköpsorderrader har dessutom **Maila**, som öppnar samma e-postdialog som inköpsorderkortet med leverantörens e-postadress förifylld (leverantörens huvudkontakt, annars leverantörens egen adress) — skickad order märks **Skickad**. Ordrarna skapas som **Utkast**, och att mejla en inköpsorder skickar den och sätter den samtidigt till **Bekräftad** — kortet visar samma påminnelse. Tillverkningsordrar har bara **Ladda ner PDF** och **Skriv ut**; det finns ingen e-postfunktion för tillverkningsordrar.

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

**Tillverkning → Beläggning** visar operationstid per resurs och vecka från släppta tillverkningsordrar, ställd mot resursens tillgängliga tid. Lasten beräknas i stunden; själva planen — vilka veckor varje operation ligger i — sparas på operationerna (se [Planera](#planera)).

### Vad som räknas i lasten

- **Lasten** kommer från tillverkningsordrar i status **Frisläppt** eller **Pågår** (nya ordrar frisläpps när de skapas; en äldre order som står kvar som **Planerad** räknas inte förrän den frisläppts). Per operation räknas den återstående tiden: stycktid × kvarvarande antal, plus ställtiden så länge inget antal avrapporterats. En slutförd operation belastar inte. En **planerad** operation lägger sin tid i sina planerade veckor; har den delvis rapporterats räknas det som är gjort i de tidigaste veckorna, så det som återstår ligger i de senare. En operation som **inte är planerad** räknas i färdigdatumets vecka. Ställtid och stycktid är i **minuter**; beläggningen visar timmar.
- **Tillgänglig tid** per resurs och vecka kommer från resursens **Veckoschema (kapacitet)** — eller, utan schema, **Kapacitet (timmar per dag)** måndag–fredag — × **Kapacitetsfaktor** (se [Resurser](#resurser)), upplöst mot den faktiska kalenderveckan — **röda dagar och halvdagar i helgdagskalendern minskar kapaciteten** den veckan. En resurs utan veckoschema och timmar per dag visar **—** som kapacitet men lasten syns ändå.

### Veckomatrisen

Kolumnerna är innevarande vecka och framåt (välj horisont med **Veckor**: 4/8/13/26), följt av **Senare** (färdigdatum bortom horisonten) och **Odaterat** (ordrar utan **Planerat färdigdatum**). Planerade operationer ligger i sina planerade veckor — en operation som sträcker sig över flera veckor finns i en cell per vecka, med sin andel av tiden. Oplanerade operationer ligger i färdigdatumets vecka; ett passerat färdigdatum rullas in i innevarande vecka och ordern märks **Försenad**. Raderna grupperas per produktionsgrupp med en **Summa**-rad per grupp (resurser utan grupp hamnar under **Ogrupperade resurser**); filtrera med produktionsgruppsvalet.

Varje cell visar last / tillgänglig tid och beläggningsgrad: neutral till 85 %, gul över 85 % och röd över 100 %. En vecka där resursen har last men 0 timmar tillgänglig tid (till exempel en stängd vecka) är också röd och räknas som överbelagd; i stället för procent står **Ingen kapacitet**. Klicka på en cell för att fälla ut vilka ordrar och operationer som utgör lasten, med länk till TO-kortet. Per operation visas **timmar i veckan** och hur många timmar som är kvar totalt, de planerade veckorna (**v.45–47**, eller **Ej planerad**), färdigdatum och märkena **Försenad**, **Sen**, **Halvfabrikat sent** (ett halvfabrikat som ordern behöver blir klart för sent, se [Halvfabrikat sent](#halvfabrikat-sent)) och **Låst**, samt knappen **Flytta…**.

Cellerna markerar dessutom med små symboler när de innehåller **sena ordrar** (klocka), **låsta operationer** (hänglås) eller operationer med **förslag på alternativ resurs** (dubbelpil). Överbelagda celler är röda.

I utfällningen märks en operation som ligger på en alternativ resurs med **Alternativ (för 110)**, och en operation vars resurs bytts för hand med **Vald för hand**. En operation med förslag får raden **Förslag: 120** med texten *Kan bli klar v.47 på 120 (i stället för v.49)* och knappen **Byt till 120** (utan rättigheten Tillverkning syns förslaget men inte knappen). Efter ett byte läses matrisen om.

### Förslag på alternativ resurs

Har en operation alternativa resurser i beredningen (se [Alternativa resurser](/hjalp/artiklar#alternativa-resurser)) och ordinarie resurs är full, föreslår beläggningen ett alternativ. Förslaget **räknas fram vid varje läsning och sparas aldrig**, och det **byter aldrig resurs av sig självt** — inte heller **Planera**. Lasten ligger kvar på resursen operationen har, så veckan blir röd tills någon byter.

- **När:** bara när lasten skjuter operationens klar-vecka på nuvarande resurs, eller operationen inte ryms där inom två år. Det är lasten som den ser ut nu som räknas, inte hur gammal planen är: har resursen blivit ledig sedan senaste **Planera** (en föregående operation blev klar tidigare, en annan order makulerades) ges inget förslag. Då prövas alternativen med sina egna tider, och förslaget ges om något av dem blir klart en **tidigare vecka**; blir flera klara samma vecka vinner den som står först i beredningens ordning. Blir alternativet inte tidigare behåller operationen sin resurs. Har en tidigare operation på ordern ingen plan får operationerna efter den inget förslag, precis som **Planera** inte planerar dem. Förslaget räknar från där **Planera** skulle lägga de tidigare operationerna nu — ligger en tidigare operation i en vecka som har blivit överbelagd räknas den i veckan den faktiskt hinner bli klar, så att ett byte ger den vecka förslaget visar.
- **Vilka operationer:** bara väntande operationer på en frisläppt eller pågående order som är **orörda** (ingen rapportering, tidrapport, stämpling eller kassation), **inte låsta** och **inte Vald för hand**. Inaktiva resurser, legoresurser och resurser utan kapacitet föreslås aldrig.
- **Förslagen ser inte varandra.** Två operationer kan föreslås samma lediga vecka på 120. Byter du den ena läses förslagen om, och det andra kan ha försvunnit.
- **Byt till 120** byter operationens resurs, planerar om ordern och märker operationen **Vald för hand**. Förslaget försvinner och operationen hamnar i den föreslagna veckan. Samma byte går att göra med **Ändra** på TO-kortet. Har operationen bytt resurs eller flyttats sedan förslaget visades byts ingenting, och sidan säger det — ladda om sidan för att se det nya läget.

Ovanför matrisen står räknaren *N förslag på alternativ resurs* (bara när det finns några). Klicka på den för att fälla ut listan: ordernummer (länk till TO-kortet), operation, *110 → 120, v.49 → v.47* och **Byt till 120** på varje rad.

### Planera

Knappen **Planera** (kräver rättigheten Tillverkning) planerar om alla öppna tillverkningsordrar på ledig kapacitet. Du får först frågan "Planera om alla öppna tillverkningsordrar på ledig kapacitet? Veckor som flyttats för hand ligger kvar." — bekräfta med **Planera**.

- Ordrarna tas i ordning efter **Planerat färdigdatum**, tidigast först (ordrar utan datum sist, sedan ordernummer), och varje orders operationer läggs i tur och ordning: nästa operation får börja samma vecka som föregående blev klar om det finns tid kvar. En operation som redan är påbörjad (rapporterad eller instämplad) planeras från innevarande vecka.
- **Låsta** operationer (se [Flytta och Lås upp](#flytta-och-las-upp)) rörs inte — deras tid räknas som upptagen innan något annat planeras. Klara operationer får sin plan borttagen.
- **Äldre ordrar är oplanerade** och räknas i färdigdatumets vecka tills du kört **Planera** första gången.
- Planen ändrar aldrig något färdigdatum, bara operationernas veckor. Inget mejl eller meddelande skickas.

**Planera byter aldrig resurs.** Har en operation alternativa resurser planeras den på den resurs den har, även när den är full. I stället visar resultatet *3 operationer kan bli klara tidigare på en alternativ resurs* med en rad per förslag (*TO-123 op 20: 110 → 120, v.49 → v.47*, ordernumret länkar till TO-kortet) och knappen **Byt till 120** (kräver Tillverkning). Förslaget är samma som i [Förslag på alternativ resurs](#forslag-pa-alternativ-resurs); ett byte tar bort raden ur resultatet.

Efter körningen visas hur många operationer och ordrar som planerats, och eventuella varningar: en order som beräknas bli **sen**, en operation som inte rymdes inom två år ("Kapaciteten räcker inte inom två år"), en operation som kommit före föregående operation, en resurs utan kapacitet, eller en operation med **orimligt mycket tid**. Matrisen läses om.

En operation har orimligt mycket tid när dess återstående tid ensam skulle fylla resursen i mer än gränsen, normalt fyra vanliga veckor (den största veckokapaciteten bland de kommande veckorna, så en helgdagsvecka sänker inte gränsen; för en resurs utan kapacitet räknas 40 timmar per vecka). Det beror oftast på fel i underlaget — tider i fel enhet i beredningen eller ett felskrivet antal på ordern; rätta operationens tider direkt på TO-kortet med **Ändra** (se [Ändra material och operationer](#andra-material-och-operationer)), så planeras ordern om. Varningen visar tillverkningsordern, operationen, resursen och artikeln, hur många timmar som är kvar och hur många veckors kapacitet det motsvarar, samt operationens ställtid, stycktid och orderns antal, till exempel "Op 20 på 110 (1001 Diskbänk) har orimligt mycket tid: 625,5 h kvar, motsvarar 15,6 veckors kapacitet på resursen (40 h/vecka); ställtid 30 min, stycktid 75 min/st, antal 500 st — kontrollera operationens tider och orderns antal". Operationen planeras ändå. Legooperationer kontrolleras inte. Samma varning visas när du flyttar en sådan operation och när en ny tillverkningsorder skapas (i **Varning vid frisläpp** på TO-kortet).

Gränsen — fyra veckor om inget annat valts — ställs in under **System → Inställningar** med **Orimligt mycket tid på en operation (veckor)**. Decimaler går bra; 0 stänger av varningen.

### Flytta och Lås upp

Klicka på en cell och sedan **Flytta…** vid operationen. I dialogen **Flytta operation** väljer du **Vecka** — veckorna i matrisen, med ledig tid per vecka (till exempel "v.45 · 2 nov — ledigt 12 h av 40"); fler veckor nås genom att öka **Veckor** i beläggningen. Innevarande vecka visas som "— innevarande vecka" utan ledig-tid-siffra, eftersom bara dagarna från i dag kan användas; en vecka före innevarande kan inte väljas. Kryssrutan **Flytta även efterföljande operationer** är förvald: orderns senare, olåsta operationer planeras om från den nya veckan. Klicka **Flytta**. Har resursen ingen kapacitet alls den valda veckan — alla dagar är helgdagar, eller inga arbetsdagar är kvar av innevarande vecka — flyttas ingenting och dialogen säger till exempel *110 har ingen kapacitet kvar vecka 12 — välj en annan vecka*.

- Operationen **börjar i den valda veckan även om veckan är full** — veckan blir då röd, så överlasten syns. Resten av tiden fortsätter på ledig kapacitet veckorna efter.
- En flyttad operation blir **Låst**: **Planera** låter den ligga kvar. Varningar (sen order, operationer i fel ordning) visas i dialogen innan du stänger den.
- **Lås upp** (i samma dialog, för en låst operation) släpper låset. Veckan ligger kvar tills nästa **Planera**, som då planerar om operationen. Låset försvinner också när operationen blir klar.
- En klar operation, en legooperation, en operation utan tid och en operation på en order som inte är frisläppt eller pågående går inte att flytta.

### Sammanfattningen

Ovanför matrisen står **Senast planerad** (tidpunkten för senaste **Planera**, eller "Inte planerad ännu") och en sammanfattning, till exempel "3 överbelagda celler · 2 sena ordrar · 4 ej planerade". Klicka på ett tal för att fälla ut listan: de överbelagda cellerna (resurs, vecka, belastning), de **sena** ordrarna (färdigdatum och planerat klar) och de **ej planerade** ordrarna — ordernumren länkar till TO-kortet. Finns förslag på alternativ resurs läggs räknaren *N förslag på alternativ resurs* till sist i raden, och listan har **Byt till 120** per rad. En order är **Sen** när den sista operationen beräknas bli klar efter färdigdatumet.

[Leveranstidskontrollen](/hjalp/forsaljning#leveranstidskontroll) i Försäljning använder samma beläggning och samma planeringsregel: den lägger en ny orders operationer på resursernas lediga tid per vecka, det vill säga tillgänglig tid minus lasten som visas här — inklusive de planerade veckorna.

Observera att en grupps **Summa**-procent bara ställs mot de medlemmar som har kapacitet (veckoschema eller timmar per dag) — lasten summeras över alla medlemmar, så procenttalet kan överdrivas när någon resurs i gruppen saknar kapacitet.

## Körplan

**Tillverkning → Körplan** visar de kommande arbetena på en resurs, vecka för vecka — det som körs på maskinen eller arbetsplatsen härnäst. Sidan går att skriva ut som underlag till verkstaden.

Välj **Resurs** (produktionsresurserna; legoresurser finns inte med eftersom de inte körs hos er) och **T.o.m. vecka**. Förvalet för **T.o.m. vecka** är nästa vecka; listan tar med allt som ligger till och med den veckan. Utan vald resurs står *Välj en resurs*, och finns inget att köra står *Inga kommande arbeten på resursen t.o.m. vecka N*.

### Vad som tas med

- Väntande operationer i tillverkningsordrar som är **Frisläppt**, **Pågår** eller **Planerad**. Klara och stängda ordrar, makulerade ordrar, klara operationer och legooperationer tas inte med.
- Ordningen är den **planerade veckan** först (se [Planerade veckor](#planerade-veckor)) och därefter färdigdatum. En operation som inte är planerad hör till färdigdatumets vecka. Har den varken plan eller färdigdatum hamnar den under **Ej planerad**.
- Operationer som borde varit klara — veckan har passerat — står överst under **Försenad**. Därefter kommer en grupp per vecka (**Vecka N**) och sist **Ej planerad**. Varje grupp visar sin summa i timmar och längst ner står **Totalt**.

### Kolumnerna

- **Vecka** — operationens planerade vecka (eller färdigdatumets vecka för en operation som inte är planerad).
- **TO** — tillverkningsordernumret, en länk till TO-kortet.
- **Artikel** — artikelnummer och namn.
- **Operation** — operationens nummer och beskrivning.
- **Antal kvar** — det som återstår att tillverka i operationen.
- **Tid kvar (h)** — återstående tid i timmar med två decimaler: stycktid × kvarvarande antal plus ställtiden så länge den inte är gjord. Det är samma tal som [Beläggning](#belaggning) räknar med för operationen.
- **Färdigdatum** — tillverkningsorderns färdigdatum.
- **Status** — hur långt operationen kan göras just nu: **Redo** (hela det som återstår kan göras), **Väntar på op N** (föregående operation har inte levererat något ännu), delvis redo visas som *N redo · väntar på op M*, och **Planerad TO** för en order som inte är frisläppt än. Beredskapen räknas som i [stämpelterminalen](/hjalp/terminal). Märket **Låst** betyder att veckan är flyttad för hand i Beläggning och ligger kvar när du kör **Planera**.

### Skriv ut

**Skriv ut** öppnar körplanen som PDF i en ny flik, med samma resurs och samma **T.o.m. vecka** som på sidan. Knappen visas när en resurs är vald.

Från [stämpelterminalen](/hjalp/terminal) finns en länk **Körplan** för den valda stationen.

## Pågående arbete

**Tillverkning → Pågående arbete** visar i realtid vem som jobbar med vad. Sidan uppdateras automatiskt var 30:e sekund och tiderna räknar sekund för sekund. Rubriken visar antalet, t.ex. "3 instämplade · 1 på plats utan arbete".

- **Instämplade på arbete** listar varje öppen stämpling: **Anställd**, **TO** (länk till tillverkningsordern), **Operation** (med märket **Ställ** eller **Produktion** när tiden är uppdelad), **Artikel**, **Sedan** (starttid, med datum om det inte är idag), **Tid** (arbetad tid, utan pauser) och **Antal** (planerat / klart / kvar). Äldst stämpling står överst. Har den anställde gått hem och lämnat arbetet öppet märks raden **Pausad** och tiden räknar inte vidare. Har den anställde frånvaro registrerad idag märks raden även **Frånvarande** (bara för administratörer och arbetsledare). Arbetet får ligga kvar pausat; det återupptas när personen stämplar in närvaron igen.
- **På plats utan arbete** listar de som är närvaroregistrerade men inte instämplade på någon operation, med **Sedan** och **Tid** på plats.

När en operation blir klar — någon kryssar **Operationen är klar** vid utstämplingen, **Slutför** på operationen i tillverkningsordern eller inleveransen av en legorad — stämplas alla andra som är instämplade på operationen ut automatiskt, med antal 0. Blir hela ordern klar (inleveransen från sista operationen eller **Slutför order**) gäller det alla operationer på ordern. En pausad stämpling stämplas ut vid tiden då pausen började, övriga vid klarmarkeringen. Det gör att den som kommer tillbaka efter frånvaro inte kan rapportera på en operation som redan är klar.

### Stämpla ut

Administratörer och arbetsledare har en knapp **Stämpla ut** på varje rad, för att stämpla ut någon som glömt det. **Sluttid** är förifylld med när arbetet pausades (om den anställde har gått hem) eller med nu; ändra den till när arbetet faktiskt slutade. Rör du inte fältet stämplas arbetet ut exakt vid pausen respektive i det ögonblick du sparar (fältet visar bara hela minuter). Tiden som rapporteras visas under fältet, och tidrapporten dateras på sluttidens dag. Ett pausat arbete som stämplas ut utan ändrad sluttid dateras på pausens dag, som vid den automatiska utstämplingen — i dag om den dagen ligger i en låst löneperiod, så att en gammal pausad stämpling alltid går att stämpla ut. En sluttid du själv ändrar till en dag i en låst löneperiod går inte att spara. Dialogen visar Planerat / Klart / Kvar och frågar efter **Antal OK**, **Kasserat**, **Kassationsorsak** (krävs när kasserat är större än 0; med kvalitetsorsaker för kassation väljs en **Orsak** och fritexten blir **Kommentar**), **Operationen är klar** och **Notering**. Tidrapporten får stämplingens typ (**Ställ** eller **Produktion**), om den har någon. Effekten är densamma som när den anställde stämplar ut i [stämpelterminalen](/hjalp/terminal): en tidrapport skapas, material som är kopplat till operationen förbrukas och kassationer loggas.

## Tidrapporter

**Tillverkning → Tidrapporter** listar all rapporterad tid (sök på anställd eller ordernummer) med källa **Stämpling** (från terminalen) eller **Manuell**. **+ Ny tidrapport** registrerar tid manuellt: anställd, order, operation, datum och timmar. Tid kan rapporteras på en order som är frisläppt, pågår eller är klar (efterrapportering), men inte på en planerad, stängd eller makulerad order.

Varje tidrapport sparar resursen tiden gjordes på, och listan visar den. En stämpling får resursen operationen hade när du stämplade in (den kan inte bytas medan någon är instämplad), och en manuell tidrapport får operationens resurs när den registreras — även när den gäller en dag före ett byte. Resursen går inte att ändra i efterhand. Tid som rapporterades innan resursen sparades visar operationens nuvarande resurs.

Är inställningen **Dela tid i ställ och produktion** på (se [Inställningar](/hjalp/system#installningar)) har formuläret också fältet **Typ** (**Ej uppdelad**, **Ställ** eller **Produktion**, förvalt **Produktion**), och listan har kolumnen **Typ** efter **Timmar** (tom när tiden inte är uppdelad). Tid som stämplas i terminalen får typen från stämplingen (se [Ställ och produktion](/hjalp/terminal#stall-och-produktion)). Exportfilen har samma kolumn, **Typ**, efter **Timmar**. En tidrapport kan rättas via API:t, där typen kan ändras eller tas bort; servern kräver aldrig någon typ. Bara typen går att rätta även i en låst löneperiod, eftersom lönen läses ur närvaron och inte ur tidrapporterna. Tid som registrerades innan inställningen infördes förblir **Ej uppdelad**.
