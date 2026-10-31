# Tillverkning

Tillverkningsmodulen i Nav|ERP driver tillverkningsordrar (TO) genom flödet frisläppt → pågår → klar → stängd (en ny tillverkningsorder frisläpps när den skapas; status planerad finns kvar för äldre ordrar), med materialförbrukning, tidrapportering och efterkalkyl. Menyvalet **Tillverkning** öppnar modulens sida, som samlar modulens funktioner i ett rutnät.

## Översikt

Menyvalet **Tillverkning** öppnar modulens sida, där alla tillverkningsfunktioner ligger grupperade i ett rutnät:

- **Ordrar** — **Tillverkningsordrar**.
- **Verkstad** — **Stämpelterminal**, **Pågående arbete** och **Tidrapporter**.
- **Planering** — **Behovsberäkning**, **Beläggning** och **Scheman**.
- **Resurser** — **Resurser** och **Produktionsgrupper**.

Personal och lön har en egen meny, **Personal & lön** (se kapitlet [Personal & lön](/hjalp/lon)). Nyckeltal för pågående tillverkning finns på **Översikt**, startsidan.

## Resurser

**Tillverkning → Resurser** är register över maskiner och personalresurser som utför operationer. Varje resurs har **nummer (3 siffror)**, namn, typ (Maskin/Personal), **timkostnad**, **TO-påslag (%)** och en produktionsgrupp.

De fält som justeras oftast går att ändra direkt i listan: tryck **Ändra** längst till höger på raden så blir **Produktionsgrupp**, **Veckoschema** (med kapacitetsfaktorn under, efter ×), **Timkostnad** och **TO-påslag** inmatningsfält. **Spara** (eller Enter) skriver ändringarna, **Avbryt** (eller Esc) lämnar raden som den var; bara en rad kan redigeras åt gången. Övriga fält — nummer, namn, typ, status och förvalsfälten — ändras genom att trycka på resursens namn, vilket öppnar hela formuläret.

Under fältet **Nummer (3 siffror)** visas en lista över redan upptagna nummer med resursens namn — maskiner, personal och legoresurser delar samma nummerserie, så listan visar alla tre sorterna oavsett vilket register du står i. Skriver du in ett upptaget nummer byts listan mot en varning, t.ex. "Numret 101 används redan av Svarv (Maskin)", och knappen **Skapa resurs** (**Spara resurs** när du redigerar) går inte att klicka förrän du väljer ett annat nummer. Redigerar du en befintlig resurs räknas dess eget nummer förstås inte som upptaget.

Timkostnaden ger den direkta lönekostnaden i för- och efterkalkylen, och **TO-påslaget** (tillverkningsomkostnad) räknas på den lönekostnaden. Det ingår inte i kalkylens tillverkningskostnad (TVK) eller självkostnad (SVK) utan läggs till sist, direkt på försäljningspriset efter det generella påslaget. TO-påslaget är det enda påslaget som sätts per resurs — övriga påslag (MO, LO, Affo, generellt påslag och materialpåslag) är systemomfattande och ligger under **System → Kalkyler**, se [System & inställningar](/hjalp/system#kalkyler).

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
- **Behovsberäkningen** föreslår en inköpsorder för varje ofärdig lego-operation på frisläppta/pågående tillverkningsordrar — se [Behovsberäkning](#behovsberakning).
- **Inleveransen** av lego-inköpsordern avrapporterar operationen automatiskt. Är lego-operationen inte sist bokförs inget lagersaldo; är den orderns sista operation läggs det mottagna antalet in i lager som färdiga varor, se [Inleverans från sista operationen](#inleverans-fran-sista-operationen). Se [Inleverans](/hjalp/inkop#inleverans).
- **Stämpelterminalen** visar aldrig lego-operationer; **Slutför** på operationsraden i TO-kortets kort **Rapportera** finns kvar som manuell väg.
- **Förkalkylen** räknar in ställpris, transportkostnad och styckpris som legokostnad med LO-påslag; efterkalkylen tar den verkliga inlevererade kostnaden från inköpsordern när en sådan finns.

## Produktionsgrupper

**Tillverkning → Produktionsgrupper** grupperar resurser och personal för planering och tidrapportering. Skapa grupp med kod + namn och bocka i vilka resurser som ingår.

## Importera resurser

**Tillverkning → Resurser → Importera** (`/tillverkning/resurser/import`) öppnar en guide med tre flikar — **Produktionsgrupper**, **Resurser** och **Legoresurser** — som tillsammans tar in en fullständig resursexport. Endast administratörer har åtkomst. Filer läses som CSV (semikolon, komma och tabb känns alla igen — även teckenkodningen identifieras automatiskt) eller Excel (.xlsx, bara det första bladet läses). Varje flik kör sin egen guide i fyra steg: **Fil**, **Kolumner**, **Förhandsgranska** och **Resultat**.

Mallen laddas ned med **Ladda ned mall** i fliken; kolumnerna förklaras i [Importmallar](/hjalp/importmallar#resurser) (legoresurser: [Legoresurser](/hjalp/importmallar#legoresurser), produktionsgrupper: [Produktionsgrupper](/hjalp/importmallar#produktionsgrupper)).

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

**Tillverkning → Ordrar** listar alla TO med sök och statusfilter. Statusfiltret har också **Sen**: frisläppta och pågående ordrar som produktionsplaneringen markerar **Sen** — samma urval som aviseringen [Sena tillverkningsordrar](/hjalp/aviseringar). **Sen** är ingen egen status utan räknas fram när listan visas.

### Läsläge

Den som bara har rättigheten **Tillverkningsorder (läsläge)** (verkstadsprofilen, se [Behörighetsgrupper](/hjalp/system#behorighetsgrupper)) ser tillverkningsorder i läsläge. Listan saknar då **+ Ny tillverkningsorder**, CSV-export, markering och åtgärdskolumn. På kortet finns inga knappar, ingen redigering av **Planerat färdigdatum**, ingen kalkyl och ingen **Historik** (den är bara för administratörer). **Skriv ut TO (PDF)** och pallkorten finns kvar. Legooperationernas priser visas som **–**: priser är kontorsdata, och den som saknar menyrättigheter ser dem inte. Rättigheten **Tillverkning** ger fullt läge.

### Skapa och frisläppa

1. **+ Ny tillverkningsorder**: välj artikel (artikelväljaren) och antal (har artikeln en **Avrundning** på Lager-fliken avrundas antalet uppåt till närmaste multipel när ordern skapas — 12 med Avrundning 10 blir 20; detsamma gäller en TO som skapas från en kundorderrad), samt eventuellt **Planerat färdigdatum** — datumet styr vilken vecka orderns operationstid räknas i i [beläggningen](#belaggning) så länge ordern inte är planerad (en planerad order räknas i sina [planerade veckor](#planerade-veckor); färdigdatumet ändras aldrig av planeringen) och kan sättas eller ändras på TO-kortet i efterhand (med **Spara**, så länge ordern är Planerad/Frisläppt/Pågår). Ordern får ett TO-nummer och **frisläpps direkt** (status **Frisläppt**), så den syns i [stämpelterminalen](/hjalp/terminal) och går att stämpla in på med en gång. Den **planeras också direkt**: operationerna läggs i tur och ordning på resursernas lediga tid från i dag, se [Planerade veckor](#planerade-veckor). När du väljer artikel föreslås färdigdatumet automatiskt, se [Föreslaget färdigdatum](#foreslaget-fardigdatum).
   En konfigurerbar mall i läget Variantartiklar (se [Artiklar](/hjalp/artiklar#varianter)) visas i artikelväljaren med märkningen **Konfigurerbar**. Väljer du den öppnas dialogen **Konfigurera**: gör valen och klicka **Lägg in**, så blir ordern en tillverkningsorder på varianten (den hämtas om den finns och skapas annars). Dialogen visar inget pris här. Mallen själv kan inte tillverkas. En mall i läget Beställningsvara tillverkas däremot med valen på ordern, se [Tillverkningsorder för beställningsvara](#tillverkningsorder-for-bestallningsvara).
2. **Frisläppet sker när ordern skapas** — oavsett om den skapas här, [från en kundorderrad](#skapa-fran-kundorder) eller med behovsberäkningens **Skapa ordrar**. Då snapshotas artikelns struktur till en **materiallista** och rutten till **operationer** — senare ändringar på artikeln påverkar inte en redan frisläppt order. Räcker inte lagersaldot till materialet visas **Varning vid frisläpp** överst på TO-kortet när du kommer dit; ordern skapas och frisläpps ändå. Samma ruta visar planeringens varningar för den nya ordern: en operation som inte rymdes inom två år, att ordern beräknas bli sen, och en operation med [orimligt mycket tid](#planera). Ordrar som skapades innan frisläppet blev automatiskt kan stå kvar som **Planerad** — dem frisläpper du med **Frisläpp** på detaljsidan eller i listan. Fantomartiklar i strukturen löses upp till sina komponenter. Operationer som är märkta **Kalkyl** i beredningen följer inte med (se [Artiklar](/hjalp/artiklar#kalkyloperationer)): de prissätts i förkalkylen men syns aldrig på ordern, i terminalen, i beläggningen eller i efterkalkylen.

### Tillverkningsorder för beställningsvara

En mall i läget **Beställningsvara** (se [Artiklar](/hjalp/artiklar#konfigurator)) tillverkas med valen på ordern:

- **Från kundorderraden.** **Skapa tillverkningsorder** på en konfigurerad rad tar radens val rakt av; dialogen visar valraderna överst (t.ex. *Lås: Lås B*, *Bredd: 1 200 mm*). **Planerat färdigdatum (valfritt)** förifylls alltid med arbetsdagen före kundorderns leveransdatum (idag som tidigast), även om mallen har lager eller andra tillverkningsordrar; saknar kundordern leveransdatum, eller är radens hela antal redan levererat, lämnas fältet tomt. Ändras raden med **Ändra konfiguration** medan tillverkningsordern skapas får du meddelandet "Raden konfigurerades om medan tillverkningsordern skapades — kontrollera raden och försök igen, eller använd Ändra konfiguration". Har mallen tagits bort efter att raden lades skapas ingen tillverkningsorder ("Mallen är inte i läget Beställningsvara.") — en vanlig order skulle byggas på artikelns egen struktur utan radens val; har mallen bytt till läget **Variantartiklar** stoppas den som alla mallar i det läget.
- **Ny tillverkningsorder.** Väljer du mallen i artikelväljaren öppnas dialogen **Konfigurera**; gör valen och klicka **Lägg in**. Valraderna visas under artikelfältet och **Konfigurera om** öppnar dialogen igen. Innan valen är gjorda står "Konfigurera artikeln först" och knappen **Skapa tillverkningsorder** är inaktiv. **Avbryt** (eller Esc) tömmer artikelfältet.
- **Materialet och operationerna skrivs in när tillverkningsordern skapas** ur valen, inte ur mallens egen struktur och rutt. Ordern frisläpps direkt som alla nya tillverkningsordrar. Senare ändringar i mallen (nya villkorade rader, ändrade formler) påverkar inte redan skapade ordrar.
- **Tillverkningsordern visar valen.** Valraderna står under orderhuvudet, och raden **Lagervärde vid inleverans** visar förkalkylens kostnad per styck (*xxx,xx kr/st (förkalkyl)*), eller *saknas* när mallen saknar kostnad. Det är kostnaden som färdigvaran värderas till i lagret vid inleverans; raden visas bara för den som ser priser (inte verkstadsprofilen).
- **Konfigurationen kan inte ändras efteråt.** Vill du ha andra val: makulera tillverkningsordern och skapa en ny. Orderns material och operationer går däremot att ändra som på vilken order som helst, se [Ändra material och operationer](#andra-material-och-operationer).

### Föreslaget färdigdatum

När en tillverkningsorder skapas föreslås **Planerat färdigdatum** utifrån artikelns **skarpa behov** — kundorderrader och materialbehov på andra tillverkningsordrar — så att ordern blir klar **en arbetsdag innan** behovet:

- Ett behov som **redan är täckt** räknas inte. Lagersaldot plus alla öppna inköps- och tillverkningsordrar på artikeln fördelas på behoven i datumordning (samma nettning som [behovsberäkningen](#behovsberakning)) — **oavsett ordrarnas egna datum**. En befintlig tillverkningsorder utan färdigdatum, eller en inköpsorder som kommer för sent, täcker alltså ändå sitt behov; att den ligger fel i tiden är den orderns sak, inte en anledning till en ny tillverkningsorder.
- Förslaget utgår från det **första otäckta behovet** — det första behovet i datumordning som lager och befintliga ordrar inte räcker till (du ser behoven och deras datum i [artikelöversikten](/hjalp/artiklar#artikeloversikt)). Är lagersaldot negativt även efter alla öppna ordrar föreslås idag.
- **Arbetsdag** betyder måndag–fredag som inte är en ledig helgdag i [helgdagsregistret](/hjalp/personal-tid#helgdagar). En helgdag med eget dagschema (t.ex. en kortdag) räknas som arbetsdag. Ett behov på en måndag ger alltså färdigdatum fredagen innan.
- Har den dagen redan passerat föreslås **idag** i stället.
- **Kundorderns behov räknas på avsändningsdagen**, inte på leveransdatumet: har kunden [transportdagar eller avsändningsdagar](/hjalp/forsaljning#leveransdagar) räknas leveransdatumet bakåt till den dag ordern senast måste skickas, och förslaget blir arbetsdagen före den. Utan sådana inställningar är avsändningsdagen detsamma som leveransdatumet.
- Är alla behov täckta, eller saknar det första otäckta behovet datum, lämnas fältet tomt.

Under fältet står varifrån förslaget kommer, t.ex. *Föreslaget: arbetsdagen före första bristen 2030-03-04 (KO-1042).* — "första bristen" är det första otäckta behovet. Förslaget är bara ett förval — skriver du ett eget datum gäller det, även om du byter artikel efteråt.

Förslaget görs i **+ Ny tillverkningsorder**, när en TO skapas [från en kundorderrad](#skapa-fran-kundorder) (där är det radens eget behov på avsändningsdagen som räknas) och när [behovsberäkningens](#orderforslag-och-skapa-ordrar) **Skapa ordrar** skapar tillverkningsordrar.

### Ändra status i listan

Statusen behöver inte ändras order för order på detaljsidan. Kolumnen **Åtgärder** i listan visar de knappar som gäller för radens status: **Frisläpp** och **Makulera order** på en Planerad order, **Makulera order** på en Frisläppt, **Stäng order** på en Klar. En order som Pågår visar i stället **Slutför på kortet** — slutförandet anger lagerplats och antal och bokför inleveransen, så det görs på detaljsidan. **Makulera order** frågar alltid först; en makulerad order kan inte återöppnas, och den går bara att makulera så länge inget är rapporterat på den (se [Makulera order](#makulera-order)).

Kryssa för flera ordrar (kryssrutan i rubrikraden väljer alla på sidan som går att påverka) så visas en rad under listan med **Frisläpp valda**, **Stäng order valda** och **Makulera order valda** — siffran inom parentes är hur många av de valda som just den åtgärden gäller för. Ordrarna behandlas en och en; misslyckas någon listas den i en felruta och förblir markerad så du kan försöka igen, medan de som lyckades avmarkeras. Lagervarningar från frisläppet visas ovanför listan med TO-numret framför varje rad. På en smal skärm (mobil i stående läge) visas listan som staplade kort utan rubrikrad; då ligger kryssrutan **Välj alla på sidan** och knapparna för valda ordrar i stället i en rad ovanför listan som följer med när du skrollar.

### Planerade veckor

Varje operation på en tillverkningsorder kan ha en **planerad vecka** (eller flera, om tiden inte ryms i en): den vecka operationen beräknas börja och den vecka den beräknas bli klar, utifrån resursens lediga tid. Operationstabellen på TO-kortet har kolumnen **Planerad vecka** — till exempel **v.45** eller **v.45–47**. Står det **Ej planerad** har operationen ingen plan än (äldre ordrar, tills du kört **Planera** första gången, eller en operation som inte rymdes inom två år). **Låst** betyder att veckan är flyttad för hand i [beläggningen](#belaggning) och ligger kvar när du kör **Planera**. Klara operationer och legooperationer visar **–**.

En **ny tillverkningsorder planeras direkt när den skapas**, oavsett om den skapas från **+ Ny tillverkningsorder**, från en kundorderrad, med behovsberäkningens **Skapa ordrar** eller via API:t: operationerna läggs i tur och ordning från i dag på ledig kapacitet, mot all annan last. Räcker inte kapaciteten inom två år lämnas operationen oplanerad och ordern visar en varning vid frisläpp. Planen ändrar aldrig **Planerat färdigdatum** — datumet är kundens behov, planen är vår.

Ordern märks **Sen** — på TO-kortet bredvid statusen, och i listan i kolumnen **Planerad** — när den sista operationen beräknas bli klar efter **Planerat färdigdatum**. En order utan plan är **Sen** när färdigdatumet passerat. Listan **Tillverkning → Ordrar** har kolumnen **Planerad** med orderns planerade veckor (från första till sista väntande operation).

### Skapa från kundorder

En tillverkningsorder kan också skapas direkt från en kundorderrad i stället för via **+ Ny tillverkningsorder**. På kundorderkortet (se [Försäljning](/hjalp/forsaljning#kundorder)) visar en rad med en tillverkningsartikel knappen **Skapa tillverkningsorder** så snart ordern är **Bekräftad** eller **Under tillverkning** och raden inte redan är täckt av tillverkningsordrar eller helt levererad. På en konfigurerad beställningsvarurad finns knappen också — se [Tillverkningsorder för beställningsvara](#tillverkningsorder-for-bestallningsvara). Dialogen förifyller fältet **Antal** med det som återstår av radens beställda antal — redan skapade, ej makulerade tillverkningsordrar mot samma rad räknas av — men antalet går att ändra innan **Skapa tillverkningsorder** klickas. Fältet **Planerat färdigdatum (valfritt)** förifylls med arbetsdagen före kundorderns leveransdatum, så länge raden inte redan är täckt av lager eller befintliga inköps-/tillverkningsordrar. Är raden redan täckt — eller saknar kundordern leveransdatum — används artikelns första otäckta behov i stället (se [Föreslaget färdigdatum](#foreslaget-fardigdatum)). Undantaget är en konfigurerad beställningsvarurad: där gäller alltid radens eget leveransdatum (arbetsdagen före, idag som tidigast) — mallens lager och andra raders tillverkningsordrar är andra konfigurationer och täcker den inte — och saknar kundordern leveransdatum lämnas fältet tomt.

Den nya tillverkningsordern frisläpps direkt (status **Frisläppt**) precis som en manuellt skapad TO, med kundorderraden kopplad, och du hamnar direkt på TO-kortet — som visar raden **Kundorder:** med en länk till kundordern och kundens namn. Kundordern får automatiskt status **Under tillverkning** (om den inte redan är det), och kundorderraden visar därefter kolumnen **I tillverkning** med det kopplade antalet och TO-numret som länk med orderns status. Knappen på raden heter sedan **Skapa TO för resten (N st)** och försvinner när raden är helt täckt. En kundorderrad med en kopplad tillverkningsorder kan inte tas bort — även om tillverkningsordern senare makuleras: kopplingen är historik och blockerar borttagning ändå, men en makulerad TO räknas inte längre med i kolumnen **I tillverkning**.

### Under tillverkning

- **Rapportera**: all manuell avrapportering görs i kortet **Rapportera** på TO-kortet (se [Avrapportera operation](#avrapportera-operation)): en rad per operation med dess kopplade material under, gruppen **Vid slutrapportering** för material utan operation, en rad **Rapportera tid** och — på en frisläppt eller pågående order — en rad **Slutför order**.
- **Material**: klicka **Förbruka** på materialraden i kortet **Rapportera**. Välj lagerplats i **Lagerplats för materialuttag** högst upp i kortet (gäller både **Förbruka** och **Slutför**) och ange antal — ett materialuttag bokförs i lagret. **Antal** är förifyllt med det som återstår av radens planerade mängd (planerat − förbrukat); skriv över det om uttaget ska vara ett annat. Överuttag utöver planerat stoppas. Är strukturraden skriven i en alternativ enhet (se [Artiklar](/hjalp/artiklar)) visas och matas materialraden in i den enheten (kolumnen **Enhet**); uttaget bokförs alltid i komponentens grundenhet.
- **Operationer**: personalen stämplar in/ut på operationerna i [stämpelterminalen](/hjalp/terminal), eller så rapporteras tid manuellt på raden **Rapportera tid** (**Anställd**, **Operation**, **Datum**, **Timmar** och en valfri **Anteckning**). **Timmar** är förifyllt med operationens teoretiska tid — ställtid + tid/enhet × orderns antal — minus den tid som redan är rapporterad på operationen; fältet är tomt när allt är rapporterat eller operationen saknar tider. Klicka **Slutför** på operationen när den är klar — se [Avrapportera operation](#avrapportera-operation). Har operationen en **Packinstruktion** visas den i dämpad text under operationsraden i tabellen (se [Artiklar](/hjalp/artiklar#packinstruktion-pa-operationen)). Kolumnen **Tid/enhet** visar Stycktid i den enhet operationen bereddes i (min/st, sek/st eller st/h) — se [Tidsenhet på operationen](/hjalp/artiklar#tidsenhet-pa-operationen).
- Ordern får status **Pågår** automatiskt vid första instämplingen eller inleveransen — det finns ingen knapp för att starta den.

### Ändra material och operationer

Materiallistan och operationerna är en ögonblicksbild från frisläppet, men de går att ändra på TO-kortet så länge ordern är **Frisläppt** eller **Pågår** (rättigheten Tillverkning krävs; i läsläge finns inga knappar). Ändringarna rör **bara den här tillverkningsordern** — artikelns struktur och rutt i beredningen påverkas inte. En tillverkningsorder för en [beställningsvara](#tillverkningsorder-for-bestallningsvara) ändras på samma sätt; förkalkylen på den står kvar. En Planerad, Klar, Stängd eller Makulerad order kan inte ändras ("Material och operationer kan bara ändras när ordern är frisläppt eller pågår").

**Material**

- **+ Lägg till material**: välj artikel, **Antal** med enhet (en av komponentens enheter — antalet räknas om till grundenhet precis som på en strukturrad) och **Operation** (den operation som drar materialet, eller *Ingen — dras vid inleverans*). Orderns egen artikel, en fantomartikel (den lagerhålls aldrig — lägg till dess komponenter) och en mall i läget Variantartiklar kan inte väljas, och samma komponent kan bara finnas en gång per operation. Räcker inte lagersaldot visas en bristvarning ("Komponent: behöver N, tillgängligt M") — raden läggs till ändå.
- **Ändra** på raden: antal, enhet, operation och artikel. Artikeln går bara att byta så länge inget är förbrukat på raden. Antalet får sättas lägre än det redan förbrukade — förbrukat material lämnas aldrig tillbaka av en ändring, och nästa rapportering drar som vanligt upp till det nya planerade antalet (planerat per enhet × rapporterat, minus redan förbrukat). Ett byte av operation påverkar bara kommande uttag.
- **Ta bort** finns bara på en rad utan förbrukning.

**Operationer**

- **+ Lägg till operation**: samma fält som i beredningen (sekvensnummer, beskrivning, resurs, ställtid, stycktid, kommentar, packinstruktion och legofälten på en legoresurs: leverantör, **Ställpris**, **Styckpris** och **Transportkostnad (kr)**), utom **Kalkyl** och **Använd artikelns ritning**. Förvalt sekvensnummer är sista + 10, och ett sekvensnummer som redan finns på ordern avvisas. Operationen får status **Väntar**.
- **Ändra** på en väntande operation: tider och texter går att ändra även när något redan rapporterats. **Resursbyte** vägras när någon är instämplad på operationen, när en inköpsorderrad eller förfrågningsrad pekar på den (lego), och mellan legoresurs och egen resurs när något redan rapporterats. En klar operation kan inte ändras.
- **Ta bort** finns bara på en operation som aldrig haft något: ingen rapportering (inte heller en ångrad), ingen tidrapport, ingen stämpling, ingen kassation och ingen inköps- eller förfrågningsrad. Material som var kopplat till operationen blir okopplat och dras vid inleveransen i stället.
- **Sista operationen** är den vars Antal OK blir färdiga varor. Så snart något levererats in från den kan ingen ändring byta vilken operation som är sist: inte lägga till en efter den, inte ta bort den och inte numrera om så att en annan blir sist ("Varor har levererats in från sista operationen").

Varje operationsändring (lägg till, ta bort, ändrad tid, resurs eller sekvens) **planerar om orderns väntande operationer** med samma regler som **Planera** (se [Planera](#planera)): påbörjade operationer från innevarande vecka, låsta operationer ligger kvar, all annan last räknas som upptagen. En låst operation som byter resurs tappar låset, eftersom veckorna var bokade på den gamla resursen; en låst operation som bara får ny tid behåller låset och veckorna. Planeringens varningar (sen order, kapaciteten räcker inte inom två år, operation i fel ordning, [orimligt mycket tid](#planera)) och materialets bristvarningar visas i en notisruta på kortet efter sparandet.

Alla ändringar loggas i orderns **Historik**: Material tillagt/ändrat/borttaget och Operation tillagd/ändrad/borttagen, med artikel respektive operation och resurs och vad som ändrades.

### Materialbrist vid rapportering

Inställningen **Materialbrist vid rapportering** (System → Inställningar, se [Inställningar](/hjalp/system#installningar)) styr vad som händer när en rapportering skulle dra mer material än vad som finns i lager. Det som jämförs är det material rapporteringen drar mot artikelns **totala saldo på alla lagerplatser**; flera materialrader med samma artikel i en rapportering läggs ihop, och tjänsteartiklar kontrolleras aldrig.

- **Ingen kontroll** — rapporteringen går alltid igenom (standard).
- **Varning** — innan något sparas visas "Det saknas ingående delar: Plåt 2 mm (behöver 8 st, tillgängligt 3 st). Rapportera ändå?". Välj **Rapportera ändå** för att bokföra rapporteringen, eller avbryt — då sparas ingenting och formuläret står kvar som det var.
- **Spärr** — rapporteringen nekas och meddelandet "Det finns inte tillräckligt med ingående delar: …" visas. Fyll på lagret (eller korrigera saldot) och rapportera igen.

Kontrollen gäller utstämpling i [stämpelterminalen](/hjalp/terminal) och på **Pågående arbete**, **Slutför** (operationen), **Slutför order** och **Förbruka** i kortet **Rapportera**, samt inleverans av legorader (se [Inleverans](/hjalp/inkop#inleverans)). **Ångra** påverkas inte — där läggs material tillbaka.

### Avrapportera operation

Kortet **Rapportera** har en rad per operation, sorterade efter sekvensnummer, och högst upp ett kort förklarande stycke. Raden för en operation som **Väntar** visar **Planerat** (orderns antal), **Klart** (antal OK som redan rapporterats, t.ex. från stämpelterminalen), **Kasserat** när något kasserats och **Kvar** (planerat minus klart — kasserade enheter måste göras om och minskar inte Kvar). På samma rad anges **Antal klart** (förifyllt med vad som **återstår** av orderns antal — delrapporter från stämpelterminalen räknas alltså inte dubbelt), **Kasserat** med **kassationsorsak** (obligatorisk när kasserat > 0; finns det [kvalitetsorsaker](/hjalp/kvalitet#kassation-och-orsaker) för kassation väljs en **Orsak** i listan och fritexten blir en valfri **Kommentar**) och eventuell **Faktisk tid**, sedan **Slutför**; fältet **Lagerplats för materialuttag** högst upp i kortet styr varifrån det kopplade materialet dras. En klar operation visas bara som text ("Klart 5 av 5 · Klar"). En lego-operation har samma **Slutför** som manuell väg och texten "Lego — avrapporteras vid inleverans". Operationen markeras **Klar** först när totalt **Antal OK** når orderns antal; rapporterar du färre ligger den kvar som **Väntar** och kan rapporteras vidare här eller i [stämpelterminalen](/hjalp/terminal). Kasserade enheter räknas inte — de måste göras om.

Under varje operation står dess kopplade material med artikelnummer, namn och förbrukat/planerat. Så länge något återstår finns ett fält **Antal** (förifyllt med det som återstår) och knappen **Förbruka** för ett manuellt uttag — även under en klar operation. Material utan operation ligger i gruppen **Vid slutrapportering** och dras när varorna levereras in. Ett fel visas direkt under den rad som misslyckades.

Material som är kopplat till operationen i beredningen (se [Artiklar](/hjalp/artiklar)) **dras automatiskt från lagret** för **antal OK + kasserat** — kasserade enheter förbrukar också komponenter:

- Order på 10 med 10 OK och 4 kasserade drar komponenter för 14 enheter.
- Rapporteras **fler** än orderns antal dras **mer** material — precis så mycket som det rapporterade kräver.
- Rapporteras färre dras materialet proportionellt.
- Har material redan förbrukats manuellt på raden fylls bara mellanskillnaden på — inget dubbeluttag.

Antalen kan också rapporteras löpande vid varje utstämpling i [stämpelterminalen](/hjalp/terminal); allt ackumuleras på operationen. Operationstabellen visar **Antal OK** och **Kasserat**, och varje kassation loggas med tid, antal, orsak och anställd i sektionen **Kassationer** på detaljsidan. Orsaken visas med namn ur kvalitetsorsakerna, följd av kommentaren; äldre kassationer visar sin fritext. Med rättigheten **Kvalitet** finns **Skapa avvikelse** på raden, som öppnar en ny [intern avvikelse](/hjalp/kvalitet#ny-avvikelse) med tillverkningsorder, operation, artikel och antal ifyllda. Tillverkningsordern har också sektionen **Avvikelser** med ärendena som gäller den och knappen **Ny avvikelse**.

### Inleverans från sista operationen

Antal OK som rapporteras på orderns **sista operation** (den med högst sekvensnummer) är färdiga varor och **läggs i lager direkt** — vid varje utstämpling i terminalen, vid **Slutför operation** här och när en lego-operation är sist och avrapporteras av inköpsorderns inleverans. Det gäller bara mellanskillnaden mot det som redan lagts in, så ingenting bokförs två gånger:

- Varorna hamnar på artikelns lagerplats (eller reservplatsen `***`) och värderas som vid **Slutför order**.
- Material som **inte** är kopplat till någon operation dras i samma takt: med 4 av 10 inlevererade är 4/10 av det materialet draget.
- Kasserade enheter ger inget saldo.
- En **Frisläppt** order blir **Pågår** vid första inleveransen.
- När inlevererat antal når orderns antal blir ordern **Klar** av sig själv — historiken får raden **Slutförd** som vid **Slutför order**. Rapporteras fler än orderns antal läggs även de in. Operationer som inte hunnit rapporteras kan [efterrapporteras](#efterrapportera-pa-en-klar-order).
- Orderhuvudet visar **Inlevererat: 4 av 10** så snart något lagts in.

Rapporter på tidigare operationer lägger inte in något i lager.

I **Lagerplats för materialuttag** är standardvalet **"Artikelns lagerplats"** — varje komponent dras då från sin egen artikels lagerplats (eller reservplatsen `***`, se [Lager](/hjalp/lager)); välj en specifik plats för att dra allt därifrån i stället. Materialtabellen visar i kolumnen **Operation** vilken operation som drar varje rad, eller **Vid slutrapportering** för okopplat material.

### Avsluta

- **Slutför order** stänger ordern: ange antal och lagerplats (standard: artikelns) — **Antal** är det som läggs i lager **nu**, utöver det som redan inlevererats från sista operationen, och förifylls med det som återstår av orderns antal. Material som **inte** är kopplat till någon operation dras upp till det totalt inlevererade antalet, och ordern blir **Klar**. Raden **Slutför order** i kortet **Rapportera** finns så snart ordern är **Frisläppt**. Skulle ordern stängas innan hela antalet är inlevererat frågar Nav först ("Ordern stängs med 0 av 5 st inlevererade … Stäng ordern ändå?"). Har kassationer gjort att sista operationen aldrig nådde orderns antal anger du **0** för att stänga ordern utan mer inleverans. En order vars sista operation nått orderns antal är redan **Klar** och behöver inte slutföras. En order som stängts av misstag öppnas igen med **Ångra** på raden **Slutför order** under [Rapporteringar](#rapporteringar-och-angra).
- **Stäng order** avslutar en Klar order; därefter går ingenting att ångra eller [efterrapportera](#efterrapportera-pa-en-klar-order).

### Efterrapportera på en klar order

En order blir **Klar** så snart hela antalet är inlevererat — även om tidigare operationer aldrig rapporterades. Fram till **Stäng order** går det att efterrapportera på den, så att efterkalkylen får med operationernas antal, tid och material:

- Kortet **Rapportera** finns kvar, med **Slutför** på de operationer som fortfarande **Väntar**. Texten överst säger att ordern är klar: antal OK, kasserat och materialet som är kopplat till operationen bokförs som vanligt, men inga fler färdiga varor läggs in i lager — inte heller från sista operationen. Ska fler varor in ångrar du först den rapportering som gjorde ordern klar (se [Rapporteringar och Ångra](#rapporteringar-och-angra)).
- **Förbruka** och **Rapportera tid** fungerar som på en order som pågår; raden **Slutför order** visas inte.
- En lego-operation som inlevereras på inköpsordern efter att tillverkningsordern blivit klar avrapporteras på samma sätt.
- Ordern förblir **Klar**, och efterrapporteringen syns under [Rapporteringar](#rapporteringar-och-angra) och kan ångras som vilken rad som helst.
- [Stämpelterminalen](/hjalp/terminal) visar inte en klar order — efterrapporteringen görs på TO-kortet.

### Rapporteringar och Ångra

Sektionen **Rapporteringar** på detaljsidan listar allt som rapporterats på ordern, senaste först: **Utstämpling** (varje utstämpling i terminalen, även en utan antal), **Slutför operation**, **Inleverans IO-…** (en lego-operation som avrapporterats av inköpsorderns inleverans), **Materialuttag** (**Förbruka** för hand), **Slutför order** och **Automatisk utstämpling** — tiden för någon som stämplades ut när operationen eller ordern blev klar (se [Pågående arbete](#pagaende-arbete)); den kan ångras som en vanlig utstämpling. Varje rad visar operation, **OK**, **Kasserat**, **Inlevererat**, stämplingens **Timmar**, vem som rapporterade och vilket material som drogs.

**Ångra** backar exakt det den raden bokförde, i ett svep — Nav visar först vad som kommer att hända:

- Antal OK och kasserat dras av från operationen och kassationsraden tas bort. Operationen blir **Väntar** igen om den inte längre täcker orderns antal.
- Materialet som drogs läggs tillbaka på den lagerplats det togs från.
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

**Efterkalkylera** på orderns detaljsida räknar fram vad ordern faktiskt kostade: verklig materialförbrukning gånger komponenternas pris, och den tid som verkligen rapporterats på varje operation gånger resursens timkostnad. Den använder samma påslag som förkalkylen men en egen materialkälla, **Materialkostnad i efterkalkylen** — båda ställs in under **System → Kalkyler**, se [System & inställningar](/hjalp/system#kalkyler). Med standardpris eller leverantörspris räknas materialet till priset (och valutakursen) som gällde när det togs ut på ordern, så efterkalkylen ger samma svar om den görs om senare. Har en operation ingen rapporterad tid visas en varning; kalkylen räknar då den operationen som 0 kronor.

**Efterkalkylera** sparar ingenting av sig själv: beräkningen visas i panelen som hela kedjan från direkt material till försäljningspris, tillsammans med eventuella varningar. Klicka **Spara kalkyl** för att lägga den som en ny rad under **Kalkyl** på kortet, med antal, material, lego, lön, självkostnad och försäljningspris — då öppnas **Kalkylspecifikation** automatiskt. Klicka på **Efterkalkyl** i typkolumnen för att öppna specifikationen igen; se avsnittet med samma namn under [Artiklar](/hjalp/artiklar#kalkyl) för vad den innehåller.

En sparad efterkalkyl kan **inte** tas bort — den är orderns facit. Förkalkyler går att ta bort, se [Artiklar](/hjalp/artiklar#kalkyl).

Står materialkällan på **Verklig kostnad** värderas materialet till vad det faktiskt kostade — glidande medelpris vid förbrukningstillfället, härlett ur lagerloggen i stället för läst ur artikelns standardpris. Då mäter [Kalkylutfall](/hjalp/rapporter#kalkylutfall) en äkta avvikelse i både pris, mängd och tid, inte bara i mängd och tid. Se [System & inställningar](/hjalp/system#kalkyler).

Efterkalkylen räknar aldrig om underliggande nivåer. **Räkna om underliggande nivåer** hör till förkalkylen (se [Artiklar](/hjalp/artiklar#kalkyl)): ett halvfabrikat som ordern faktiskt förbrukat är en riktig lagerförd artikel som tagits in till ett pris, och det priset är vad efterkalkylen ska visa.

Kalkylen räknas aldrig om i efterhand: ändrar du inställningar eller timkostnader gäller det från nästa beräkning, och gamla kalkyler står kvar med de påslag de kördes med.

### Skriv ut TO

**Skriv ut TO (PDF)** överst på tillverkningsorderns detaljsida skapar underlaget som lämnas till operatören:

- Företagsuppgifter och logotyp, ordernummer, status, artikel och antal att tillverka samt eventuell anteckning.
- Är ordern skapad från en kundorderrad (se [Skapa från kundorder](#skapa-fran-kundorder) ovan) visas raden **Kundorder:** med kundorderns ordernummer och kundens namn.
- **Operationer** med ställtid, stycktid, beräknad tid och en signaturkolumn att bocka av i. Kolumnen **Operation** visar resursens tresiffriga kod följd av operationens **Beskrivning** — saknas beskrivning står resursens namn där i stället (se [Artiklar](/hjalp/artiklar#beskrivning-pa-operationen)). Har operationen en **Kommentar** som är märkt **Skriv ut på arbetskortet** skrivs texten under sin operationsrad (se [Artiklar](/hjalp/artiklar#kommentar-pa-operationen)). Har operationen en **Packinstruktion** skrivs den **alltid** ut under operationsraden med prefixet "Packning: ", oavsett om **Skriv ut på arbetskortet** är ikryssad (se [Artiklar](/hjalp/artiklar#packinstruktion-pa-operationen)). Beskrivningen, kommentaren och packinstruktionen är de som gällde när ordern frisläpptes. Stycktid visas i den enhet operationen bereddes i — "7 st/h" i stället för "8,5714 min" när beredningen är växlad till **st/h**, och "45 sek" i stället för "0,75 min" när den är växlad till **sek/st** (se [Tidsenhet på operationen](/hjalp/artiklar#tidsenhet-pa-operationen)); beräknad tid är alltid i minuter, eftersom den är en totalsumma, inte en hastighet. Tiderna skrivs med högst två decimaler och utan onödiga nollor — "10 min", "6 min" och "8,57 min".
- **Material** med enhet, planerat och uttaget antal (i radens enhet) plus signaturkolumn, samt en rad för "Utförd av / Datum". Kolumnen **Op** visar sekvensnumret för operationen som drar materialet (motsvarande materialtabellens kolumn **Operation**, se [Avrapportera operation](#avrapportera-operation) ovan) — ett streck ("—") betyder att materialet dras vid slutrapportering i stället. Materialraderna är sorterade efter denna operation, sedan artikelnummer.
- Artikelns **ritningar** (se fliken Filer i [Artiklar](/hjalp/artiklar)) läggs sist i dokumentet — PDF:er som extra sidor, JPEG/PNG som en sida var.

Ordern kan skrivas ut i alla statusar; är den inte frisläppt än står det att operationer och material saknas.

### Pallkort

Ett **pallkort** är lappen som läggs på pallen när en operation rapporterats. Det skrivs ut på **övre halvan** av ett stående A4 så att arket kan vikas på mitten (en streckad viklinje visar var) och hela kortet syns på pallen. Överst står företagets logotyp, under den ett inramat kort med ett svart rubrikband: **PALLKORT** till vänster och till höger **TILL KUND** eller **INTERNT**, beroende på var pallen är på väg:

- **Sista operationen** på en order som är skapad från en kundorderrad (se [Skapa från kundorder](#skapa-fran-kundorder) ovan): pallen är klar för kund (**TILL KUND**). Kortet visar **Artikelnummer**, **Benämning**, **Kund**, **Leveransadress** (när kundordern har en vald leveransadress), **Kundens ordernummer** (ett streck när kundordern saknar sådant), **Vårt kundordernummer** och **Antal**.
- **Övriga operationer** (och sista operationen på en order utan kundorderkoppling): pallen går vidare internt (**INTERNT**). Kortet visar **Artikelnummer**, **Benämning**, **Tillverkningsorder**, **Nästa operation** (sekvensnummer och beskrivning; ett streck när ingen operation följer) och **Antal**.

Längst ner i ramen står **Datum** (när rapporteringen gjordes), **Rapporterad av** (utelämnas när rapportören är okänd) och **Referens** (tillverkningsordern och operationen). Beroende på inställningen **Kod på pallkort** (se [Inställningar](/hjalp/system#installningar) och kundkortets fält **Kod på pallkort**) får artikelnumret och ordernumret även en **Streckkod** (Code 128) eller en **QR-kod**; med **Ingen** trycks inga koder. En streckkod ritas inte för ett nummer med å, ä eller ö.

Pallkortet öppnas **automatiskt i en ny flik** efter en lyckad **Slutför** på en operationsrad i kortet **Rapportera** på orderns detaljsida, med det antal som just rapporterades — och på samma sätt efter en utstämpling **med antal** (**Antal OK** > 0) i [stämpelterminalen](/hjalp/terminal); en utstämpling utan antal öppnar inget kort. Det automatiska kortet är rapporteringens eget och bär därför rapporteringens tid och rapportör. Blockerar webbläsaren fliken, eller behöver du fler kort eller ett annat antal, finns det två vägar för omutskrift:

- Länken **Pallkort** på operationsraden i operationstabellen öppnar dialogen **Pallkort**. **Totalt antal** är förifyllt med operationens **ackumulerade** antal OK (orderns antal när inget är rapporterat än). Ange **Antal kolli** (1–50): totalen fördelas jämnt på en lista **Kolli 1**, **Kolli 2** … där du kan skriva eget antal per kolli (varje kolli blir ett kort, och kortet visar alltid vilket kolli det är, t.ex. "Kolli 2 av 3" — även "Kolli 1 av 1" när bara ett kort skrivs ut, också vid den automatiska utskriften). En rad under listan visar om kollina stämmer med totalen, hur många som är **kvar att fördela** eller hur många som är **för mycket**, och om något kolli saknar antal (*Varje kolli måste ha ett antal*). **Skriv ut** är avstängd när något kolli saknar antal, och även när kollina inte stämmer med totalen — om inte systeminställningen **Tillåt utskrift av pallkort även om kollina inte stämmer med totalt antal** är på (se [Inställningar](/hjalp/system#installningar)). Klicka **Skriv ut** för att öppna PDF:en i en ny flik, eller **Avbryt**.
- Knappen **Pallkort** på en rad i sektionen **Rapporteringar** skriver ut kortet för just den rapporteringen, med rapporteringens antal, tid och rapportör; samma dialog med kolli gäller. Knappen finns på operationsrapporter med **OK** större än 0 som inte är ångrade.

Ordern måste vara frisläppt; en planerad order har inga operationer att skriva kort för. Du kan skriva ut pallkort även med en användare som bara har läsrättighet.

Även utleveransen skriver pallkort — se [Utleverans](/hjalp/forsaljning#utleverans).

Sektionen **Historik** längst ner på orderkortet visar orderns egna händelser (statusövergångar och ändringar av leveransdatum/produktionsgrupp) — se [Händelselogg](/hjalp/system#handelselogg).

## Behovsberäkning

**Tillverkning → Behovsberäkning** räknar fram nettobehovet per artikel och föreslår inköps- och tillverkningsordrar. Allt beräknas ur order- och lagerdata — inget behov lagras i databasen.

Beräkningen omfattar alla artiklar på en gång, så resultatet **återanvänds i upp till en minut**: att bläddra, söka eller filtrera i listan räknar inte om allt. Längst till höger i verktygsraden står när resultatet beräknades (**Beräknad 08:12:03**). Har något ändrats — t.ex. en kundorder eller inleverans som just registrerats — klickar du **Uppdatera** för att räkna om direkt. Efter **Skapa ordrar** och **Skapa förfrågan** räknas listan alltid om automatiskt.

### Vad som räknas

För varje artikel ställs behov mot saldo och inkommande:

- **Behov** är summan av: kundorderrader i status **Bekräftad** eller **Under tillverkning** (beställt minus levererat), materialrader på frisläppta/pågående tillverkningsordrar (planerat minus uttaget), samt material till **Planerad** tillverkningsorder (beräknat ur strukturen, eftersom materialet snapshotas först vid frisläpp). **Offerter räknas inte som behov.**
- **Inkommande** är summan av: inköpsorderrader i status **Bekräftad**/**Delvis mottagen** (beställt minus mottaget), inköpsorder i status **Utkast** (särredovisas som IO-utkast — så att redan skapade orderförslag inte föreslås igen), och tillverkningsordrar i status **Planerad**/**Frisläppt**/**Pågående** (orderns antal minus det som redan inlevererats från sista operationen — det ligger redan i saldot).
- **Netto** = saldo − behov + inkommande. Fantomartiklar och tjänsteartiklar ingår aldrig; inaktiva artiklar visas med märket **Inaktiv** men får inga förslag.

### Beställningspunkt, säkerhetslager, orderkvantitet och avrundning

På artikelkortets **Lager**-flik finns fälten **Beställningspunkt**, **Säkerhetslager**, **Orderkvantitet** och **Avrundning** (sektionen **Planering**). Beställningspunkten och säkerhetslagret jämförs mot **Netto** (det projicerade saldot, inte råsaldot): det **större** av de två är golvet, och faller netto under det föreslås ett antal som fyller upp till just den nivån. Utan någon av dem föreslås bara när netto blir negativt. I kolumnen **BP / SL** visas beställningspunkten överst och säkerhetslagret under. Är **Orderkvantitet** satt avrundas förslaget alltid uppåt till närmaste multipel — den fungerar därmed också som minsta orderkvantitet. **Avrundning** tillämpas **sist**, efter orderkvantiteten, och avrundar förslaget uppåt till närmaste multipel av steget (100 kg med orderkvantitet 100 och avrundning 7,38 blir 103,32 kg = 14 stänger). Det härledda komponentbehovet räknas på det avrundade förslaget. Samma avrundning görs på orderraderna när **Skapa ordrar** skapar inköps- och tillverkningsordrarna — ett förslag du ändrat för hand i kolumnen **Förslag** avrundas alltså igen — se [Artiklar](/hjalp/artiklar#lager).

### Härlett behov i flera nivåer

När en tillverkad artikel får ett förslag räknas förslaget direkt om till komponentbehov (**Härlett** i kolumnen Behov), nivå för nivå genom hela strukturen med fantomartiklar upplösta. En brist på en färdigvara syns alltså som förslag även på komponenterna i samma körning — du behöver inte skapa tillverkningsordern först och köra om.

### Orderförslag och Skapa ordrar

Som standard visar listan bara rader med förslag; kryssa i **Visa alla artiklar** för att se alla artiklar med behov, inkommande, saldo eller beställningspunkt. Kolumnen **Förslag** är redigerbar — justera antalet innan ordrarna skapas. **Ledtid** och leverantör hämtas från huvudleverantören i artikelns leverantörskatalog och visas som information i listan; beräkningen av förslagen är inte tidsfasad. Ledtiden används däremot när **Skapa ordrar** sätter inköpsordrarnas datum, se nedan.

Vill du se **när** behoven infaller finns ikonknappen **Artikelöversikt** efter artikelnumret på varje rad. Den öppnar artikelns planeringsbild i en flyttbar panel — alla öppna behov och inkommande i datumordning med löpande disponibelt antal, se [Artikelöversikt](/hjalp/artiklar#artikeloversikt). Panelen ligger kvar medan du arbetar vidare i listan och byter artikel när du klickar på en annan rads knapp.

Filtret **Alla / Artiklar / Lego** i verktygsraden begränsar listan till antingen vanliga artikelrader eller lego-rader (operationsbehov, se nedan) — praktiskt eftersom lego-raderna alltid sorteras sist i listan.

I tabellhuvudet finns en kryssruta som markerar **alla valbara rader på den sida som visas** (rader märkta **Saknar huvudleverantör**/**Saknar leverantör** eller utan förslag går fortfarande inte att välja). Den visar ett mellanläge när bara några rader på sidan är valda, och avmarkerar allt vid nästa klick. Val på andra sidor påverkas inte — statusraden under tabellen fortsätter räkna dem ("varav X på annan sida"). På en smal skärm (mobil i stående läge) visas listan som staplade kort utan rubrikrad; då ligger kryssrutan **Välj alla på sidan** samt **Skapa förfrågan** och **Skapa ordrar** i stället i en rad ovanför listan som följer med när du skrollar.

Markera raderna och klicka **Skapa ordrar**:

- Inköpsförslag grupperas till **en inköpsorder per huvudleverantör**, i status **Utkast** med **Önskat leveransdatum** satt efter behovet och leverantörens [leveransdagar](/hjalp/inkop#leveransdagar), ledtid och transportdagar (se [Inköp](/hjalp/inkop#onskat-leveransdatum)) och à-pris från leverantörskatalogen — har huvudleverantören staffelsteg används steget för förslagets antal, annars grundpriset (se [Artiklar](/hjalp/artiklar#inkop)); listan i sig visar bara grundpriset, så orderradens à-pris kan vara lägre än det som stod i listan. Granska och skicka den från inköpsorderkortet som vanligt. En rad utan huvudleverantör kan inte väljas (**Saknar huvudleverantör**); lägg upp leverantören på artikelkortets Inköp-flik först.
- Tillverkningsförslag blir en tillverkningsorder per artikel, frisläppt direkt (status **Frisläppt**), med **Planerat färdigdatum** satt till arbetsdagen före artikelns första otäckta behov (se [Föreslaget färdigdatum](#foreslaget-fardigdatum)); utan otäckt behov med datum, t.ex. ett förslag som bara fyller upp till beställningspunkten, lämnas datumet tomt. Föräldrar skapas före sina komponenter — och tillverkningsordrarna före inköpsordrarna — så en komponents tillverkningsorder, eller ett inköpt material, blir klar arbetsdagen före förälderns.
- **Inköpens datum följer leverantören.** **Önskat leveransdatum** blir den senaste möjliga ankomsten **före** behovsdagen enligt leverantörens leveransdagar, men aldrig tidigare än den tidigast möjliga ankomsten med leverantörens ledtid (leverantörskatalogens **Ledtid (dagar)**) och transportdagar. Utan leveransdagar, ledtid och transportdagar blir det arbetsdagen före behovet. Hamnar leveransen efter behovet skapas ordern ändå, och en varning listas i resultatet efter **Skapa ordrar**, t.ex. "IO-1042 · ART-1: Leveransen (2026-11-02) kommer efter behovet (2026-10-21)". Kundorderns behov räknas här på avsändningsdagen, se [Leveransdagar](/hjalp/forsaljning#leveransdagar).
- **Lego-rader** (märkta **Lego**, med tillverkningsorderns nummer och operation under artikeln) är operationsbehov, inte artikelbehov: varje ofärdig lego-operation på en frisläppt/pågående tillverkningsorder föreslås med **orderantal minus redan beställt** (summan på ej makulerade inköpsorderrader mot operationen), utan kvittning mot lagersaldo. Förslagen grupperas till en inköpsorder i status **Utkast** per leverantör, med operationens styckpris som à-pris och ställpriset (ställpris + transportkostnad) på raden. En operation utan leverantör kan inte väljas (**Saknar leverantör**) — sätt leverantören på operationen i beredningen. Planerade tillverkningsordrar ger inga lego-rader (operationerna snapshotas först vid frisläpp).

- **Konfigurerade kundorderrader** (sektionen under artikellistan) blir en frisläppt tillverkningsorder per rad, med radens val, se [Konfigurerade kundorderrader](#konfigurerade-kundorderrader).

Ordrarna skapas i basenhet och utan valutaomräkning (växelkurs 1) — justera på orderkortet vid behov. Efter skapandet är förslagen täckta av de nya ordrarna och försvinner ur listan.

Behovsberäkningen hör till **Tillverkning**, så **Skapa ordrar** kräver bara den rättigheten — även för inköpsordrarna. Det är avsiktligt: den som planerar produktionen ska kunna lägga materialbeställningarna, och de skapas som **Utkast** som inköp sedan granskar och skickar. Att öppna, ändra och skicka inköpsordrarna kräver däremot **Inköp**; utan den visas ordernumren i **Skapade ordrar** som vanlig text.

Bredvid **Skapa ordrar** finns knappen **Skapa förfrågan** — den agerar bara på de markerade **lego-raderna**; övriga markerade rader lämnas orörda (och knappen är inaktiv utan någon markerad lego-rad). Den öppnar en dialog med de valda operationerna listade och en lista med leverantörer att kryssa i, förvalda med operationernas egna leverantörer. Till skillnad från **Skapa ordrar**, som alltid bokar mot operationens huvudleverantör, skickas här en förfrågan **per ikryssad leverantör** — praktiskt för att jämföra pris mellan flera legoleverantörer (samma artikel två gånger för en leverantör ger en andra förfrågan till den). En förfrågan är inget beställt: raden ligger kvar i listan efteråt, nu med hänvisningen **Förfrågan FO-1024 (Skickad)** under sig (status ändras när förfrågan skickas eller besvaras). Se [Legorader på förfrågan](/hjalp/inkop#legorader-pa-forfragan) i Inköp-kapitlet för hur raden drivs vidare.

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

### Vad som räknas

- **Lasten** kommer från tillverkningsordrar i status **Frisläppt** eller **Pågår** (nya ordrar frisläpps när de skapas; en äldre order som står kvar som **Planerad** räknas inte förrän den frisläppts). Per operation räknas den återstående tiden: stycktid × kvarvarande antal, plus ställtiden så länge inget antal avrapporterats. En slutförd operation belastar inte. En **planerad** operation lägger sin tid i sina planerade veckor; har den delvis rapporterats räknas det som är gjort i de tidigaste veckorna, så det som återstår ligger i de senare. En operation som **inte är planerad** räknas i färdigdatumets vecka. Ställtid och stycktid är i **minuter**; beläggningen visar timmar.
- **Tillgänglig tid** per resurs och vecka kommer från resursens **Veckoschema (kapacitet)** — eller, utan schema, **Kapacitet (timmar per dag)** måndag–fredag — × **Kapacitetsfaktor** (se [Resurser](#resurser)), upplöst mot den faktiska kalenderveckan — **röda dagar och halvdagar i helgdagskalendern minskar kapaciteten** den veckan. En resurs utan veckoschema och timmar per dag visar **—** som kapacitet men lasten syns ändå.

### Veckomatrisen

Kolumnerna är innevarande vecka och framåt (välj horisont med **Veckor**: 4/8/13/26), följt av **Senare** (färdigdatum bortom horisonten) och **Odaterat** (ordrar utan **Planerat färdigdatum**). Planerade operationer ligger i sina planerade veckor — en operation som sträcker sig över flera veckor finns i en cell per vecka, med sin andel av tiden. Oplanerade operationer ligger i färdigdatumets vecka; ett passerat färdigdatum rullas in i innevarande vecka och ordern märks **Försenad**. Raderna grupperas per produktionsgrupp med en **Summa**-rad per grupp (resurser utan grupp hamnar under **Ogrupperade resurser**); filtrera med produktionsgruppsvalet.

Varje cell visar last / tillgänglig tid och beläggningsgrad: neutral till 85 %, gul över 85 % och röd över 100 %. Klicka på en cell för att fälla ut vilka ordrar och operationer som utgör lasten, med länk till TO-kortet. Per operation visas **timmar i veckan** och hur många timmar som är kvar totalt, de planerade veckorna (**v.45–47**, eller **Ej planerad**), färdigdatum och märkena **Försenad**, **Sen** och **Låst**, samt knappen **Flytta…**.

Cellerna markerar dessutom med små symboler när de innehåller **sena ordrar** (klocka) eller **låsta operationer** (hänglås). Överbelagda celler är röda.

### Planera

Knappen **Planera** (kräver rättigheten Tillverkning) planerar om alla öppna tillverkningsordrar på ledig kapacitet. Du får först frågan "Planera om alla öppna tillverkningsordrar på ledig kapacitet? Veckor som flyttats för hand ligger kvar." — bekräfta med **Planera**.

- Ordrarna tas i ordning efter **Planerat färdigdatum**, tidigast först (ordrar utan datum sist, sedan ordernummer), och varje orders operationer läggs i tur och ordning: nästa operation får börja samma vecka som föregående blev klar om det finns tid kvar. En operation som redan är påbörjad (rapporterad eller instämplad) planeras från innevarande vecka.
- **Låsta** operationer (se [Flytta och Lås upp](#flytta-och-las-upp)) rörs inte — deras tid räknas som upptagen innan något annat planeras. Klara operationer får sin plan borttagen.
- **Äldre ordrar är oplanerade** och räknas i färdigdatumets vecka tills du kört **Planera** första gången.
- Planen ändrar aldrig något färdigdatum, bara operationernas veckor. Inget mejl eller meddelande skickas.

Efter körningen visas hur många operationer och ordrar som planerats, och eventuella varningar: en order som beräknas bli **sen**, en operation som inte rymdes inom två år ("Kapaciteten räcker inte inom två år"), en operation som kommit före föregående operation, en resurs utan kapacitet, eller en operation med **orimligt mycket tid**. Matrisen läses om.

En operation har orimligt mycket tid när dess återstående tid ensam skulle fylla resursen i mer än gränsen, normalt fyra vanliga veckor (den största veckokapaciteten bland de kommande veckorna, så en helgdagsvecka sänker inte gränsen; för en resurs utan kapacitet räknas 40 timmar per vecka). Det beror oftast på fel i underlaget — tider i fel enhet i beredningen eller ett felskrivet antal på ordern; rätta operationens tider direkt på TO-kortet med **Ändra** (se [Ändra material och operationer](#andra-material-och-operationer)), så planeras ordern om. Varningen visar tillverkningsordern, operationen, resursen och artikeln, hur många timmar som är kvar och hur många veckors kapacitet det motsvarar, samt operationens ställtid, stycktid och orderns antal, till exempel "Op 20 på 110 (1001 Diskbänk) har orimligt mycket tid: 625,5 h kvar, motsvarar 15,6 veckors kapacitet på resursen (40 h/vecka); ställtid 30 min, stycktid 75 min/st, antal 500 st — kontrollera operationens tider och orderns antal". Operationen planeras ändå. Legooperationer kontrolleras inte. Samma varning visas när du flyttar en sådan operation och när en ny tillverkningsorder skapas (i **Varning vid frisläpp** på TO-kortet).

Gränsen — fyra veckor om inget annat valts — ställs in under **System → Inställningar** med **Orimligt mycket tid på en operation (veckor)**. Decimaler går bra; 0 stänger av varningen.

### Flytta och Lås upp

Klicka på en cell och sedan **Flytta…** vid operationen. I dialogen **Flytta operation** väljer du **Vecka** — veckorna i matrisen, med ledig tid per vecka (till exempel "v.45 · 2 nov — ledigt 12 h av 40"); fler veckor nås genom att öka **Veckor** i beläggningen. Innevarande vecka visas som "— innevarande vecka" utan ledig-tid-siffra, eftersom bara dagarna från i dag kan användas; en vecka före innevarande kan inte väljas. Kryssrutan **Flytta även efterföljande operationer** är förvald: orderns senare, olåsta operationer planeras om från den nya veckan. Klicka **Flytta**.

- Operationen **börjar i den valda veckan även om veckan är full** — veckan blir då röd, så överlasten syns. Resten av tiden fortsätter på ledig kapacitet veckorna efter.
- En flyttad operation blir **Låst**: **Planera** låter den ligga kvar. Varningar (sen order, operationer i fel ordning) visas i dialogen innan du stänger den.
- **Lås upp** (i samma dialog, för en låst operation) släpper låset. Veckan ligger kvar tills nästa **Planera**, som då planerar om operationen. Låset försvinner också när operationen blir klar.
- En klar operation, en legooperation, en operation utan tid och en operation på en order som inte är frisläppt eller pågående går inte att flytta.

### Sammanfattningen

Ovanför matrisen står **Senast planerad** (tidpunkten för senaste **Planera**, eller "Inte planerad ännu") och en sammanfattning, till exempel "3 överbelagda celler · 2 sena ordrar · 4 ej planerade". Klicka på ett tal för att fälla ut listan: de överbelagda cellerna (resurs, vecka, belastning), de **sena** ordrarna (färdigdatum och planerat klar) och de **ej planerade** ordrarna — ordernumren länkar till TO-kortet. En order är **Sen** när den sista operationen beräknas bli klar efter färdigdatumet.

[Leveranstidskontrollen](/hjalp/forsaljning#leveranstidskontroll) i Försäljning använder samma beläggning och samma planeringsregel: den lägger en ny orders operationer på resursernas lediga tid per vecka, det vill säga tillgänglig tid minus lasten som visas här — inklusive de planerade veckorna.

Observera att en grupps **Summa**-procent bara ställs mot de medlemmar som har kapacitet (veckoschema eller timmar per dag) — lasten summeras över alla medlemmar, så procenttalet kan överdrivas när någon resurs i gruppen saknar kapacitet.

## Pågående arbete

**Tillverkning → Pågående arbete** visar i realtid vem som jobbar med vad. Sidan uppdateras automatiskt var 30:e sekund och tiderna räknar sekund för sekund. Rubriken visar antalet, t.ex. "3 instämplade · 1 på plats utan arbete".

- **Instämplade på arbete** listar varje öppen stämpling: **Anställd**, **TO** (länk till tillverkningsordern), **Operation**, **Artikel**, **Sedan** (starttid, med datum om det inte är idag), **Tid** (arbetad tid, utan pauser) och **Antal** (planerat / klart / kvar). Äldst stämpling står överst. Har den anställde gått hem och lämnat arbetet öppet märks raden **Pausad** och tiden räknar inte vidare. Har den anställde frånvaro registrerad idag märks raden även **Frånvarande** (bara för administratörer och arbetsledare). Arbetet får ligga kvar pausat; det återupptas när personen stämplar in närvaron igen.
- **På plats utan arbete** listar de som är närvaroregistrerade men inte instämplade på någon operation, med **Sedan** och **Tid** på plats.

När en operation blir klar — någon kryssar **Operationen är klar** vid utstämplingen, **Slutför** på operationen i tillverkningsordern eller inleveransen av en legorad — stämplas alla andra som är instämplade på operationen ut automatiskt, med antal 0. Blir hela ordern klar (inleveransen från sista operationen eller **Slutför order**) gäller det alla operationer på ordern. En pausad stämpling stämplas ut vid tiden då pausen började, övriga vid klarmarkeringen. Det gör att den som kommer tillbaka efter frånvaro inte kan rapportera på en operation som redan är klar.

### Stämpla ut

Administratörer och arbetsledare har en knapp **Stämpla ut** på varje rad, för att stämpla ut någon som glömt det. **Sluttid** är förifylld med när arbetet pausades (om den anställde har gått hem) eller med nu; ändra den till när arbetet faktiskt slutade. Tiden som rapporteras visas under fältet, och tidrapporten dateras på sluttidens dag. En sluttid i en låst löneperiod går inte att spara. Dialogen visar Planerat / Klart / Kvar och frågar efter **Antal OK**, **Kasserat**, **Kassationsorsak** (krävs när kasserat är större än 0; med kvalitetsorsaker för kassation väljs en **Orsak** och fritexten blir **Kommentar**), **Operationen är klar** och **Notering**. Effekten är densamma som när den anställde stämplar ut i [stämpelterminalen](/hjalp/terminal): en tidrapport skapas, material som är kopplat till operationen förbrukas och kassationer loggas.

## Tidrapporter

**Tillverkning → Tidrapporter** listar all rapporterad tid (sök på anställd eller ordernummer) med källa **Stämpling** (från terminalen) eller **Manuell**. **+ Ny tidrapport** registrerar tid manuellt: anställd, order, operation, datum och timmar.
