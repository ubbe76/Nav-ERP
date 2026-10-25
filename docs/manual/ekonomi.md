# Ekonomi

Ekonomimodulen i Nav|ERP är grundbokföringen: kontoplan, räkenskapsår med löpande perioder, manuella verifikat som bokförs till ett löpnummer, och den härledda huvudboken som visar ett valt kontos rörelser och saldon. Manuella verifikat registreras direkt i en tabell med kontosök, automatisk motrad och momshjälp, och återkommande bokningar och kostnader som ska fördelas över flera månader sköts med **Verifikatmallar** och **Återkommande verifikat**, se [Verifikat](#verifikat), [Verifikatmallar](#verifikatmallar) och [Återkommande verifikat](#aterkommande-verifikat). Utöver de manuella verifikaten bokför **automatkonteringen** kund- och leverantörsfakturor åt dig, se [Automatkontering](#automatkontering) och [Konteringsregler](#konteringsregler) nedan. Hur en rad beskattas — svensk moms, EU-handel, export, omvänd moms eller import — avgörs av **momskoderna**, se [Momskoder](#momskoder), och **momsrapporten** sammanställer momsdeklarationens alla rutor per period och ger dig deklarationen som fil till Skatteverket, se [Momsrapport](#momsrapport) och [Importmoms](#importmoms). Har du sålt till företag i andra EU-länder sammanställer **Periodisk sammanställning** försäljningen per köparens momsnummer och ger dig filen till Skatteverket, se [Periodisk sammanställning](#periodisk-sammanstallning). **Bankavstämning** stämmer av bankkontot mot kontoutdraget från banken och visar vad som saknas i bokföringen, se [Bankavstämning](#bankavstamning). Leverantörsfakturor och utbetalningar i utländsk valuta räknas om till kronor med **valutakurser** från Riksbanken eller egna kurser, se [Valutakurser](#valutakurser). Resultatet kan följas per avdelning och projekt med **kostnadsställen** och **projekt**, se [Kostnadsställen och projekt](#kostnadsstallen-och-projekt). Ovanpå grundbokföringen finns även de härledda ekonomirapporterna **balansräkning** och **resultaträkning**, se [Balansräkning](#balansrakning) och [Resultaträkning](#resultatrakning). Med **Budget** planerar du intäkter och kostnader per konto, månad och kostnadsställe och jämför dem mot utfallet i resultaträkningen, se [Budget](#budget). Hela Ekonomi-sektionen kräver rättigheten **Ekonomi** i användarens behörighetsgrupp (administratörer har den alltid) — varken menyn eller sidorna visas för andra, se [Behörighetsgrupper](/hjalp/system#behorighetsgrupper).

Menyvalet **Ekonomi** öppnar modulens sida, där ekonomifunktionerna ligger grupperade i ett rutnät: **Bokföring** (Verifikat, **Verifikatmallar**, **Återkommande verifikat**, Huvudbok, **Bankavstämning**, Anläggningsregister, Bokslut), **Rapporter** (Balansräkning, Resultaträkning, Momsrapport, **Budget**, **Periodisk sammanställning**, Avskrivningsplan) och **Grunddata** (Kontoplan, Räkenskapsår, Konteringsregler, **Momskoder**, **Bankkonton**, **Bankregler**, **Valutakurser**, **Referensränta**, Anläggningsgrupper, SIE-filer). Hela modulen kräver rättigheten **Ekonomi**.

## Kontoplan

**Ekonomi → Kontoplan** listar företagets konton med sök på kontonummer eller namn, och filtret **Endast aktiva**/**Visa alla (inkl. inaktiva)**. Varje konto har ett fyrsiffrigt **Nummer** och ett **Namn** — till skillnad från de flesta andra register i systemet är namnet inte unikt (BAS-kontoplanen återanvänder samma namn på flera konton), så det är bara numret som måste vara unikt.

Klicka **+ Nytt konto** för att lägga upp ett konto manuellt, eller på en rad i listan för att öppna den till redigering. Kontonumret går inte att ändra i efterhand — fältet är låst på redigeringsvyn — men namnet kan ändras, och kontot kan sättas **Aktiv**/**Inaktiv** när det inte längre ska gå att bokföra mot. Ett inaktivt konto avvisas om det används på en ny verifikatrad eller vid bokföring.

Varje konto har också en **Momsruta** — rutan i momsdeklarationen som kontots rörelser redovisas i (se [Momsrapport](#momsrapport)). Välj en ruta, **Ingen ruta** för konton som medvetet inte ska redovisas (t.ex. påminnelseavgifter och öres- och kronutjämning), eller **Ej angiven**. Ett nytt konto får **Förval enligt BAS**: konton ur BAS-urvalet får sin standardruta, övriga blir **Ej angiven**. Samma förval gäller konton som skapas av SIE-importen. Kolumnen **Momsruta** syns i listan (ett konto utanför kontoklass 3 och 26xx utan ruta visas med ett streck) och i CSV-exporten.

Ett konto kan dessutom ha kryssrutan **Kräver kostnadsställe**: en bokning på kontot utan kostnadsställe vägras då i manuella verifikat (*"Konto 5010 kräver kostnadsställe"*). Automatiskt konterade verifikat bokas ändå, med en varning, se [Kostnadsställen och projekt](#kostnadsstallen-och-projekt). Kolumnen **Kräver kostnadsställe** visar vilka konton som har den.

Knappen **Förifyll BAS-urval** lägger in ett standardurval ur den svenska BAS-kontoplanen i ett enda klick. Den är säker att klicka flera gånger — konton som redan finns (t.ex. ett omdöpt konto 1930) lämnas orörda, och notisen efteråt visar vad som hände: **"X skapade, Y fanns redan"** när något nytt lades till, eller **"Alla poster fanns redan"** om urvalet redan var på plats.

## Räkenskapsår och perioder

**Ekonomi → Räkenskapsår** listar företagets räkenskapsår, nyast först. **+ Nytt räkenskapsår** öppnar en dialog med **Namn**, **Startdatum** och **Slutdatum** — datumfälten är förifyllda med nästa kalenderår, men brutna räkenskapsår (som inte följer kalenderåret) går lika bra. Räkenskapsåret får inte överlappa ett befintligt år och kan inte läggas upp före ett stängt räkenskapsår. Så fort året skapas genererar systemet automatiskt en period per kalendermånad inom intervallet — det finns inget separat steg för att lägga upp perioder.

Klicka **Visa perioder** på ett räkenskapsår för att expandera periodtabellen: **Månad** och **Status** (**Öppen** eller **Låst**), med en åtgärdsknapp per rad.

- **Lås period** fryser perioden. Ett bekräftelsemeddelande beskriver konsekvensen innan låsningen genomförs: **bokföring på datum i den låsta perioden blockeras**, men **utkast går fortfarande att skapa och redigera** — låsningen stoppar bara steget där ett utkast bokförs (Bokför), inte själva utkastarbetet.
- **Lås upp period** öppnar en dialog med ett obligatoriskt fält, **Motivering** (minst 5 tecken). Upplåsning är tillåten så länge räkenskapsåret inte är stängt i bokslutet, men lämnas aldrig spårlös: motiveringen sparas tillsammans med vem som gjorde det i systemets granskningslogg, så det alltid går att se i efterhand varför en stängd månad öppnades igen.

Ett stängt räkenskapsår visas med **Stängt**, och i stället för **Lås upp period** står **Året är stängt** — perioderna öppnas bara genom att året öppnas igen under [Bokslut](#oppna-aret-igen). Länken **Bokslut** på varje räkenskapsår leder till årets bokslutsguide.

## Verifikat

**Ekonomi → Verifikat** listar företagets verifikat, med filter på **räkenskapsår**, **serie** och status (**Utkast**/**Bokförd**) samt fritextsökning på beskrivning. **+ Nytt verifikat** öppnar sidan **Nytt verifikat**, där huvudet och raderna fylls i direkt. Ett verifikat visas som **Utkast** tills det bokförs. Bredvid finns **Ny från mall** (se [Verifikatmallar](#verifikatmallar)) och **Fördela över perioder** (se [Fördela över perioder](#fordela-over-perioder)).

### Nytt verifikat

Sidan **Nytt verifikat** (**Ekonomi → Verifikat → + Nytt verifikat**) har ett huvud med **Serie**, **Datum** (förval i dag) och **Beskrivning**, och under det tabellen **Rader**. Verifikatet skapas först när du sparar:

- **Spara** skapar ett utkast med raderna och tar dig till verifikatkortet.
- **Spara och bokför** skapar och bokför verifikatet i ett steg. Knappen är aktiv först när verifikatet har minst två rader och **Differens** är 0. Går bokföringen inte igenom (till exempel för att perioden är låst) skapas inget verifikat alls.
- **Ny från mall** överst väljer en [mall](#verifikatmallar) och fyller i serie, beskrivning och rader. Beloppen i mallen följer med och kan ändras.
- **Underlag** (PDF, JPEG eller PNG) kan väljas redan här. Filerna laddas upp när verifikatet har skapats, och finns sedan under **Underlag** på verifikatkortet.

### Utkast

Ett utkasts huvud (**Serie**, **Datum**, **Beskrivning**) är redigerbart tills det bokförs — ändra fälten och klicka **Spara verifikat**. Raderna redigeras i tabellen **Rader** och sparas för hela verifikatet på en gång med knappen **Spara** (eller **Ctrl+Enter**). Ändrar du något och lämnar sidan innan du sparat frågar Nav först. **Bokför** sparar osparade rader innan verifikatet bokförs.

Tabellen har kolumnerna **Konto**, **Beskrivning**, **Momskod**, **Debet** och **Kredit**:

- **Konto** är ett sökfält. Skriver du siffror matchas kontonumret från början (**5** visar alla konton som börjar på 5, **5410** går direkt till kontot), skriver du text matchas kontonamnet (**kontor** hittar *Kontorsmaterial*). Bara aktiva konton kan väljas. Piltangenterna flyttar i träfflistan och **Enter** väljer det markerade kontot.
- **Debet** och **Kredit**: fyller du i det ena nollställs det andra, eftersom en rad aldrig får bokföras med belopp i båda samtidigt.
- **Momskod** är valfri, se [Momskod på en rad](#momskod-pa-en-rad).

Tangenterna i tabellen:

| Tangent | Gör |
| --- | --- |
| **Tab** / **Enter** | Går till nästa fält. Från sista fältet på en rad går **Enter** till nästa rad. |
| **Enter** i **Kredit** på sista raden | Lägger till en ny rad (se **Motrad** nedan) och flyttar markören till dess **Konto**. |
| **Ctrl+Enter** | Sparar hela tabellen (**Spara**). |
| **Esc** | Ångrar ändringen i det fält du står i, och stänger kontolistan. |

**Motrad:** så länge verifikatet inte balanserar förifylls en ny rad med differensen på den sida som balanserar — har du bokat 1 000,00 i debet får den nya raden 1 000,00 i **Kredit**. Beloppet kan skrivas över. Inledande tomma rader räknas inte, och en rad utan konto och belopp sparas aldrig.

Tabellen räknar löpande under raderna **∑ Debet**, **∑ Kredit** och **Differens** — differensen visas i rött så länge den inte är noll, i grönt när verifikatet balanserar. På en smal skärm (mobil) staplas varje rad som ett eget kort så att sidan aldrig behöver scrollas i sidled.

Sparar du en tabell med en rad som saknar konto, har både debet och kredit eller saknar belopp visas vilken rad det gäller och ingenting sparas. Ett konto som har inaktiverats sedan raden skrevs visas som *(inaktivt)* och måste bytas innan verifikatet kan sparas.

### Momskod på en rad

Kolumnen **Momskod** låter Nav dela upp ett belopp i netto och moms åt dig. Den visar de aktiva momskoderna som kan delas upp — svensk moms 25, 12 och 6 % samt de omvända inköpskoderna (till exempel *Inköp varor från EU 25 %*). Momsfria koder, försäljningskoder för EU och export samt importmoms har ingen moms att dela upp och erbjuds inte.

- **Svensk moms (Moms 25/12/6 %):** radens belopp tolkas som **inklusive moms**. När du lämnar fältet (eller beloppet) får raden nettot, och en momsrad med momskodens konto läggs direkt under: **ingående moms** i debet om raden står i debet, **utgående moms** i kredit om raden står i kredit. Momsraden tar öresresten, så netto plus moms alltid blir exakt det belopp du skrev. Exempel: 125,00 i debet på 5410 med *Moms 25 %* blir 100,00 på 5410 och 25,00 på ingående moms (2640). Momsraden följer alltså **radens sida**, inte kontots art: en rad i debet ger alltid ingående moms. En kreditering av en försäljning (ett intäktskonto i debet, som ska minska den utgående momsen) delas därför inte rätt av momshjälpen — boka den för hand med en rad på utgående moms i debet.
- **Omvända koder:** radens belopp är **nettot** och står kvar. Nav lägger till både en **utgående** och en **ingående** momsrad på momskodens konton med den beräknade momsen (de tar ut varandra, så verifikatet balanserar som förut).
- Momskoden sparas inte — servern ser bara vanliga rader, och fältet töms när raden har delats. Redigerar du beloppet efteråt delas det inte om; ändra raderna för hand.
- Momskontona kommer från **Ekonomi → Momskoder**. Saknas kontot eller är det inaktivt visas en varning och momsraden måste få ett giltigt konto innan du sparar.

Beloppet delas först när det finns ett belopp på raden: väljer du momskod före beloppet delas raden när du lämnar **Debet** eller **Kredit**.

- **Bokför** är inaktiv tills verifikatet har **minst två rader** och differensen är **0**. Ett bekräftelsemeddelande — **"Verifikatet får nummer och låses. Fortsätt?"** — visas innan bokföringen genomförs. Verifikatet får då sitt löpnummer (t.ex. **A-2026-17**: serie, räkenskapsår och löpnummer), blir **Bokfört** och raderna blir skrivskyddade.
- **Ta bort** raderar utkastet permanent efter bekräftelse (**"Ta bort verifikatet permanent?"**). Bara utkast kan tas bort — ett bokfört verifikat är append-only och kan bara rättas genom en omföring.
- **Kopiera** (finns på alla verifikat, även bokförda) skapar ett nytt **utkast** med samma serie, beskrivning och rader, daterat i dag, och tar dig till det. Har ett konto på en rad inaktiverats sedan dess utelämnas raden och kortet visar en varning om vilken. Bär en rad ett kostnadsställe som inaktiverats eller ett projekt som stängts sedan dess vägras kopian (*"Projektet … är stängt och kan inte väljas på nya rader"*) — kopian är en ny bokning. Kopiera är aktiv först när raderna är sparade.
- **Spara som mall** frågar efter ett **Namn** och sparar verifikatets serie, beskrivning och rader — med belopp — som en [verifikatmall](#verifikatmallar). Namnet måste vara unikt (*"Det finns redan en mall med det namnet"*).

### Kostnadsställe och projekt på raderna

Finns det kostnadsställen eller projekt visar verifikattabellen kryssrutan **Visa kostnadsställe och projekt** under raderna. Kryssar du i den kommer kolumnerna **Kostnadsställe** och **Projekt** — två listor över de aktiva kostnadsställena och de öppna projekten — och valet minns Nav i webbläsaren till nästa gång. Tangenterna fungerar som förut: **Tab** och **Enter** går vidare genom de nya fälten, **Esc** ångrar fältet. Har en rad redan ett kostnadsställe eller projekt visas kolumnerna alltid. Ett bokfört verifikat visar dem skrivskyddat. Mallar, återkommande verifikat och **Bokför** på en kontoutdragspost har samma kolumner, och **Kopiera** tar med dem. Se [Kostnadsställen och projekt](#kostnadsstallen-och-projekt).

### Bokfört

Ett bokfört verifikat visar sitt nummer, när och (om det går att slå upp) av vem det bokfördes, och raderna skrivskyddade.

- **Kopiera** och **Spara som mall** finns även här, liksom **Fördela över perioder**, som gör om verifikatets kostnad eller intäkt till en fördelning över flera månader, se [Fördela över perioder](#fordela-over-perioder).
- **Omför** skapar ett nytt utkast som speglar verifikatet med debet och kredit omvända rad för rad — samma konton och belopp, så källan och omföringen alltid nettar till noll tillsammans. Det nya utkastet bokförs inte automatiskt; du kommer direkt till det nya utkastet och bokför det separat via **Bokför** ovan, precis som vilket annat utkast som helst. En omföring visar **"Omföring av"** med en länk till källverifikatet på sitt eget kort, och källverifikatet visar i sin tur **"Omförd genom"** med en länk tillbaka (till **Utkast** om omföringen själv inte är bokförd än). Ett verifikat kan bara omföras en gång — så fort en omföring finns döljs **Omför**-knappen på källan. Verifikat som bokslutsguiden har bokfört (serie **BS**) kan inte omföras här — kortet visar i stället en länk **Bokslut 2024: Lagerförändring** (eller motsvarande steg), och steget görs om i guiden.

### Underlag på verifikat

Under raderna på verifikatkortet finns avsnittet **Underlag** för verifikatets underlag — kvitto, kontoutdrag, avtal eller liknande — som PDF eller inskannad bild (JPEG/PNG, max 20 MB per fil). Välj en eller flera filer så laddas de upp; klicka på filnamnet för att öppna en fil. Underlaget är **räkenskapsinformation** och sparas i sju år:

- På ett **utkast** kan en fil tas bort med **Ta bort** (om fel fil valdes). Tas utkastet bort försvinner dess underlag med det.
- På ett **bokfört** verifikat kan underlag bara **läggas till** (t.ex. ett kvitto som kom senare), aldrig tas bort.
- Varje uppladdning och borttagning loggas i händelseloggen, och för varje fil sparas en kontrollsumma (SHA-256, syns när du håller muspekaren över filnamnet).

Bokförda verifikat, deras rader och underlag är dessutom skyddade **i själva databasen**: ändringar och borttagningar avvisas där även om de inte kommer från appen — t.ex. från ett skript eller en direkt databasanslutning. Rättelser görs alltid med en omföring. Samma skydd gäller leverantörsfakturornas underlag efter attest och kundfakturornas arkiverade PDF:er.

Verifikat som skapas av automatkonteringen har sitt underlag på källdokumentet: leverantörsfakturans **Underlag** (se [Inköp](/hjalp/inkop#underlag-leverantorens-faktura)) respektive kundfakturans arkiverade PDF (se [Försäljning](/hjalp/forsaljning#arkiverad-faktura)).

| Status | Betydelse |
| --- | --- |
| Utkast | Redigerbart — serie, datum, beskrivning och rader kan ändras fritt, inget nummer är tilldelat än. |
| Bokförd | Låst och nummererat (t.ex. A-2026-17) — endast läsbart; en rättelse görs via **Omför**. |

### Skriv ut verifikatlista

Listan kan filtreras på **Alla kostnadsställen** och **Alla projekt** (filtren syns när det finns objekt), och utskriften och CSV-filen visar kostnadsställe och projekt per rad. Knappen **Skriv ut lista (PDF)** överst på verifikatlistan — och **Ladda ner CSV** bredvid, för samma urval i Excel-vänligt format — skriver ut exakt det urval som råkar vara satt på sidan just då — **räkenskapsår**, **serie**, **status** och fritextsökningen — så en filtrering på **Bokförd** innan utskrift ger en ren grundbok utan utkast. Under varje verifikat listas dess konteringsrader med konto, text, debet och kredit, följt av en summerad debet-/kreditsumma för verifikatet. Utkast tas med om filtret tillåter det och skrivs då ut med numret **Utkast** i stället för ett löpnummer. Långa texter radbryts inom sina kolumner, och blir utskriften längre än en sida numreras varje sida med **Sida X av Y** nere till höger — samma sidnumrering finns på systemets övriga interna utskrifter (huvudbok, balans- och resultaträkning, plocklista, räknelista, TO-utskrift och löneunderlag).

Utskriften skriver ingenting till databasen — den kan tas fram hur många gånger som helst, oavsett om perioden är låst eller ej.

## Verifikatmallar

**Ekonomi → Verifikatmallar** är registret över mallar för verifikat som du bokför ofta — hyra, leasing, avgifter, periodiseringar. En mall har ett **Namn** (unikt), en **Serie**, en **Beskrivning** och rader med konto, beskrivning och valfria belopp. Mallarna används av **Ny från mall** på verifikatlistan och på sidan **Nytt verifikat**, och som underlag för [återkommande verifikat](#aterkommande-verifikat). Ett verifikat kan också sparas som mall direkt från verifikatkortet med **Spara som mall**.

- **+ Ny mall** och **Ändra** öppnar mallen i samma tabell som verifikaten (kontosök, tangenterna, **Spara mall** eller **Ctrl+Enter**). Här får **Debet** och **Kredit** lämnas tomma — beloppen fylls i när mallen används — men en rad kan inte ha belopp i båda, och en mall behöver minst en rad. Momskod och balansindikator finns inte i mallar, men kolumnerna **Kostnadsställe** och **Projekt** finns (visa dem med **Visa kostnadsställe och projekt**) och följer med till verifikaten som skapas ur mallen och de återkommande posterna.
- **Använd** öppnar sidan **Nytt verifikat** ifylld från mallen.
- **Inaktivera** döljer mallen i **Ny från mall** och när en återkommande post skapas; **Aktivera** tar tillbaka den. Posterna lagras med kontonummer, så en mall med ett konto som sedan har tagits bort ur kontoplanen kan inte sparas förrän kontot bytts (*"Konton som inte finns i kontoplanen: …"*).
- **Ta bort** raderar mallen efter bekräftelse. Används mallen av en återkommande post nekas det (*"Mallen används av en återkommande post och kan inte tas bort"*) — ta bort posten först, eller inaktivera mallen. Verifikat som skapats ur mallen påverkas aldrig.

## Återkommande verifikat

**Ekonomi → Återkommande verifikat** skapar ett verifikat varje månad ur en [mall](#verifikatmallar) — hyra, leasing, prenumerationer. Listan visar för varje post **Dag**, **Period**, **Läge**, **Nästa körning**, **Senaste körning** (med månad och om den lyckades) och **Status**.

**+ Ny återkommande post** frågar efter:

- **Mall** — mallen bär kontona och beloppen. Alla rader måste ha belopp och mallen måste balansera, annars nekas posten med vilken rad som saknar belopp (*"Mallens rad för konto 5010 saknar belopp"*) eller med summorna (*"Mallen balanserar inte (debet 8 000, kredit 7 000)"*).
- **Dag i månaden** — 1–28, eller **Sista dagen** (månadens sista dag, även i februari).
- **Startmånad** och **Slutmånad** (valfri — tom betyder tills vidare).
- **Läge** — **Utkast** (förval) skapar ett utkast som du granskar och bokför själv; **Bokför direkt** bokför verifikatet med samma regler som ett manuellt verifikat. Utkast är förvalet eftersom en bokföring ska spegla en verklig händelse — välj **Bokför direkt** först när beloppet är fast.

**Så körs det:** ett jobb kontrollerar posterna en gång i timmen. För varje aktiv post skapas ett verifikat för varje månad vars dag har passerat och som saknar körning, daterat på månadens dag. Hoppar servern över en tid hämtas de missade månaderna ikapp vid nästa körning, och en månad körs aldrig två gånger. Går något fel skapas inget verifikat för månaden, körningen markeras **Misslyckades** med orsaken, och varje sådan månad visas som aviseringen **Återkommande verifikat som misslyckats** (se [Aviseringar](/hjalp/aviseringar)). Vad som räknas som fel beror på läget: ett konto i mallen som har inaktiverats eller tagits bort stoppar båda lägena, och ett **stängt räkenskapsår** stoppar båda — men en **låst period** stoppar bara **Bokför direkt**. I läget **Utkast** skapas utkastet även i en låst period (ett utkast är ingen bokföring), och låset slår till först när du försöker bokföra det. Jobbet försöker inte igen med en misslyckad månad — annars kom samma fel varje timme. Rätta orsaken (lås upp perioden, byt konto i mallen) och klicka **Kör nu**, som försöker igen med de misslyckade månaderna. När du skapar en post (eller en fördelning) skapas månader vars dag redan har passerat direkt, utan att vänta på jobbet.

Knapparna på varje post:

- **Körningar** visar historiken: **Månad**, **Status** (**Skapad**, **Misslyckades** eller **Hoppades över (pausad)**), **Verifikat** (länk till det skapade verifikatet) och **Orsak** för misslyckade körningar.
- **Kör nu** kör posten ikapp direkt, på samma sätt som jobbet (även en pausad post, och även misslyckade månader), och meddelar hur många verifikat som skapades och hur många som misslyckades. Månader som hoppats över vid en aktivering körs däremot inte.
- **Pausa** / **Aktivera** stoppar och återupptar posten. En pausad post skapar inga verifikat, och de månader vars dag passerar medan posten är pausad **hoppas över** — de skapas inte i efterhand när posten aktiveras. Vid **Aktivera** säger bekräftelsen hur många månader som hoppas över (*"Aktivera posten? 3 månader (2026-02 – 2026-04) förföll medan posten var pausad och hoppas över …"*); de får statusen **Hoppades över (pausad)** i historiken och ger ingen avisering. Vill du ha verifikaten för pausen ändå, klicka **Kör nu** medan posten är pausad — det skapar de förfallna månaderna — och aktivera sedan.
- **Ta bort** raderar posten efter bekräftelse; verifikat som redan skapats ligger kvar.

### Fördela över perioder

**Fördela över perioder** (knapp på **Återkommande verifikat**, på verifikatlistan och på ett bokfört verifikat) periodiserar en kostnad eller intäkt som bokförts på en gång — en årsförsäkring, en förutbetald hyra. Dialogen frågar efter:

- **Belopp** — det totala beloppet.
- **Typ** — **Kostnad** eller **Intäkt**.
- **Balanskonto** — förval **1790** (förutbetalda kostnader) för kostnad och **2990** (förutbetalda intäkter) för intäkt.
- **Resultatkonto** — kostnads- respektive intäktskontot som beloppet ska hamna på.
- **Första månad** och **Antal månader** (2–120).
- **Text** — beskrivningen på verifikaten.

**Förhandsvisning** visar beloppet för varje månad: totalbeloppet delat på antalet månader och avrundat till öre, där **sista månaden tar resten** så att delarna alltid summerar till beloppet. **Skapa fördelning** skapar en återkommande post med en egen mall som varje månad flyttar månadens belopp från balanskontot till resultatkontot — för en kostnad debet resultatkontot och kredit balanskontot, för en intäkt tvärtom. Posten körs i läget **Bokför direkt** på månadens sista dag och har en slutmånad, så den upphör av sig själv; den syns på **Återkommande verifikat** som *Fördelning* och kan pausas, köras och tas bort som andra poster. Själva ursprungsverifikatet — där kostnaden bokfördes på balanskontot — bokför du som vanligt; fördelningen gör bara de månatliga flytterna.

## Huvudbok

**Ekonomi → Huvudbok** visar ett valt kontos alla bokförda rader inom ett datumintervall, med ingående och utgående saldo. Välj **Konto** i listan (t.ex. **"1930 · Företagskonto"**) och ange **Från**- och **Till**-datum — fälten är förifyllda med det senaste räkenskapsårets start- och slutdatum (innevarande kalenderår om inget räkenskapsår är upplagt än). Huvudboken hämtas om automatiskt så fort kontot eller intervallet ändras — det finns ingen separat sökknapp.

Radtabellen inleds med raden **Ingående saldo** — kontots saldo före **Från**-datumet; för ett resultatkonto (kontoklass 3–8) räknas det bara från början av det räkenskapsår **Från**-datumet ligger i, eftersom resultatkontona börjar om på 0 varje år (ligger datumet utanför alla räkenskapsår räknas hela historiken) — följt av varje bokförd rad på kontot i datumordning: **Datum**, **Verifikat** (en länk till verifikatkortet), **Text**, **Debet**, **Kredit** och det löpande **Saldo**t efter raden. Tabellen avslutas med raden **Utgående saldo**. Bara bokförda verifikat räknas med — ett utkast syns aldrig i huvudboken. **Ingående saldo** och **Utgående saldo** visas alltid, även när kontot saknar rader i det valda intervallet: ett konto med ett ingående saldo men ingen rörelse är inte ett tomt konto. Först när kontot varken har rader eller något saldo visas texten **"Inga bokförda rader på kontot i intervallet."**

### Alla konton

Fältet **Visa** växlar huvudboken mellan **Ett konto** (beskrivet ovan) och **Kontointervall**, som visar flera konton i samma körning. I intervalläget ersätts kontovalet av **Konto från** och **Konto till** — fyrsiffriga kontonummer, tomma fält betyder "alla konton" — och kryssrutan **Endast konton med rörelse eller saldo**, som döljer konton som varken har bokförda rader i perioden eller ett ingående saldo (ikryssad som standard). Ett balanskonto (kontoklass 1–2) med saldo men utan rörelse, t.ex. lagerkontot mellan två bokslut, visas alltså alltid. Resultatkonton (kontoklass 3–8) visas däremot bara när de har rörelse i intervallet — de för inget saldo vidare mellan åren. Precis som **Ett konto**-läget hämtas resultatet om automatiskt så fort ett fält ändras.

Resultatet visas som ett block per konto, i kontonummerordning, med samma tabellrader som enkontosläget: **Ingående saldo**, de bokförda raderna och **Utgående saldo**. Ingående och utgående saldo visas alltid, även för konton utan en enda rad i perioden. Ett inaktivt konto med bokförd historik går att välja i **Ett konto**-läget, märkt **"(inaktivt)"** i listan.

**Kostnadsställe** och **Projekt** överst begränsar huvudboken till de rader som bär det valda objektet (fälten visas när det finns kostnadsställen eller projekt), och raderna får kolumnerna **Kostnadsställe** och **Projekt** när något av dem har ett. Saldona är då saldon för objektets rader.

**Ladda ner PDF** och **Ladda ner CSV** finns i båda lägena och laddar ner exakt det som visas på skärmen (CSV i Excel-vänligt format, se [Rapporter](/hjalp/rapporter#exportera-till-excel-csv)).

## Balansräkning

**Ekonomi → Balansräkning** visar företagets tillgångar, eget kapital och skulder vid ett givet datum. Kräver rättigheten **Ekonomi**, som resten av modulen.

Sidan har ett enda styrfält, datumfältet **Per datum** — förifyllt med slutdatumet för det senaste räkenskapsåret. Rapporten hämtas om automatiskt så fort datumet ändras, det finns ingen sökknapp. Räkenskapsåret som datumet faller inom härleds och visas som **"Räkenskapsår 2026"** ovanför tabellen.

Tabellen har kolumnerna **Konto**, **Benämning** och **Belopp**. En kontorad länkar till huvudboken med kontot och räkenskapsårets start–**Per datum** förifyllt som intervall.

Raderna grupperas i två huvudrubriker:

- **TILLGÅNGAR** — grupperna **Anläggningstillgångar** och **Omsättningstillgångar**.
- **EGET KAPITAL OCH SKULDER** — grupperna **Eget kapital**, **Obeskattade reserver**, **Avsättningar**, **Långfristiga skulder** och **Kortfristiga skulder**.

Varje grupp listar sina konton och avslutas med en **"Summa …"**-rad.

Tecken: tillgångssidan visas **debetpositiv** — ackumulerade avskrivningar drar alltså ner sin anläggningsgrupp till det bokförda restvärdet — medan eget kapital och skulder visas **kreditpositiva**, så att t.ex. aktiekapital och leverantörsskulder redovisas som positiva belopp.

Under **Eget kapital** finns två rader som inte är konton utan **beräknade** av rapporten: **Årets resultat** och **Balanserat resultat (ej bokslutsfört)**. Rapporten räknar ut resultatet direkt ur kontoklass 3–8 och lägger det som eget kapital, så att balansräkningen går ihop även innan året är bokslutat. När bokslutets resultatöverföring är bokförd (se [Resultatöverföring](#resultatoverforing)) nettar kontoklass 3–8 till noll för året: **Årets resultat** blir 0,00 och resultatet visas i stället på konto 2099 under **Fritt eget kapital**. **Balanserat resultat (ej bokslutsfört)** är 0,00 så länge alla tidigare år är stängda.

Raden **Ej klassificerade konton** visas bara om något bokförts utanför kontoklass 1–8. En röd rad, **Differens**, visas bara om rapporten mot förmodan inte skulle balansera — det kan bara betyda att ett verifikat i sig är obalanserat.

Bara **bokförda** verifikat räknas med, ett utkast syns aldrig. Rapporten skriver ingenting — den kan köras hur många gånger som helst, även på ett datum i en låst period. **Ladda ner PDF** och **Ladda ner CSV** laddar ner rapporten.

## Resultaträkning

**Ekonomi → Resultaträkning** visar rörelsens intäkter och kostnader för en period. Fälten **Från** och **Till** är förifyllda med det senaste räkenskapsårets start- och slutdatum, och rapporten hämtas om automatiskt så fort något av dem ändras.

Raderna kommer i fast ordning med fem delsummerader: **Rörelseresultat**, **Resultat efter finansiella poster**, **Resultat före skatt**, **Årets resultat** och **Beräknat resultat**. Varje delsumma är en löpande summering av **alla** rader ovanför den, inte bara raderna sedan föregående delsumma.

Rapporten är **kreditpositiv**: intäkter visas som positiva belopp, kostnader som negativa, så den sista raden går att läsa direkt som resultatet. Sista raden (**Beräknat resultat**) är alltid samma belopp som balansräkningens **Årets resultat** för samma period.

När året är stängt i bokslutet (se [Resultatöverföring](#resultatoverforing)) visas överföringen på raden **Årets resultat (bokfört)** (konto 8999). **Årets resultat** visar då fortfarande årets resultat, medan **Beräknat resultat** blir 0,00 — resultatet ligger nu på konto 2099 under eget kapital.

**Kostnadsställe** och **Projekt** (visas när det finns objekt) begränsar rapporten till rader som bär det valda objektet, och fältet **Visa** växlar mellan **Totalt**, **Per kostnadsställe** och **Per projekt**. I de två sista lägena får tabellen en kolumn per objekt, en kolumn för rader **utan** objekt och en kolumn **Summa**; på en smal skärm rullar tabellen i sidled i sin egen ruta. Balansräkningen påverkas inte. **Ladda ner PDF** och **Ladda ner CSV** följer samma urval.

**Budget** (visas när det finns budgetar för räkenskapsåret som **Från** ligger i) jämför utfallet med en budget, se [Budget](#budget). Årets **förvalda** budget är förifylld; välj **Ingen** för rapporten utan budget. Med en budget får tabellen kolumnerna **Utfall**, **Budget**, **Avvikelse** och **Avvikelse %** för perioden, och — när perioden inte börjar på räkenskapsårets första dag — även **Utfall ack.**, **Budget ack.**, **Avvikelse ack.** och **Avvikelse ack. %**, som räknas från räkenskapsårets start till och med **Till**. **Avvikelse** är utfall minus budget, så ett positivt tal är bättre än budget och ett negativt (rödmarkerat) sämre, både för intäkter och kostnader. **Avvikelse %** är avvikelsen i procent av budgeten och visas som – när budgeten är 0. Konton som har budget men inget utfall visas med utfall 0,00. Perioden får inte gå utanför budgetens räkenskapsår (*"Perioden ligger utanför budgetens räkenskapsår …"*). Budget kan inte kombineras med **Projekt** eller **Per kostnadsställe**/**Per projekt** — urvalet är då avstängt, med en förklaring. Däremot går det att välja ett **Kostnadsställe**: då jämförs utfallet på kostnadsstället med budgetraderna på det. **Ladda ner PDF** och **Ladda ner CSV** följer samma budgeturval; i CSV-filen finns alla kolumner alltid.

Till skillnad från balansräkningen är resultaträkningen strikt periodavgränsad — intäkter och kostnader från tidigare år läcker aldrig in, även om de bokförts på samma konton.

Bara bokförda verifikat räknas med. Rapporten skriver ingenting och kan köras om obegränsat, även på låsta perioder. **Ladda ner PDF** och **Ladda ner CSV** laddar ner rapporten.

## Budget

**Ekonomi → Budget** är ledningens plan för året: belopp per konto och månad för intäkter och kostnader, som sedan jämförs med utfallet i [Resultaträkning](#resultatrakning). Budgeten är ren planering — den bokför ingenting och påverkar inte bokföringen, och den kan ändras även för stängda år och låsta perioder.

### Budgetlistan

Välj **Räkenskapsår** överst; listan visar årets budgetar med **Namn**, **Förvald**, **Intäkter**, **Kostnader** och **Resultat**. Klicka på namnet för att öppna budgeten.

- **+ Ny budget** — välj **Räkenskapsår** och **Namn** och klicka på **Skapa budget**. Namnet måste vara unikt inom året (*"Det finns redan en budget med det namnet …"*). Den första budgeten för ett år blir automatiskt **förvald**.
- **Kopiera budget** — välj **Räkenskapsår** och **Namn** för kopian, t.ex. nästa år; alla rader kopieras månad för månad (månad 1 till månad 1 och så vidare). Har målåret färre perioder än källan lämnas de överblivna månaderna utanför, och budgeten visar hur många.
- **Gör förvald** — en budget per år kan vara förvald, och det är den som är förvald i resultaträkningen. Att göra en annan förvald flyttar markeringen.
- **Ta bort** — tar bort budgeten och alla dess rader efter en bekräftelse.

### Rutnätet

På budgetens sida kan **Namn** ändras. Rutnätet har ett **Konto** per rad (sök på kontonummer eller namn — bara konton i kontoklass 3–8 utom 8990–8999 går att budgetera), en kolumn per månad i räkenskapsåret med rubriker som *jan 26* och en kolumn **Summa**. Månaderna följer räkenskapsårets perioder, så ett förlängt första år har fler kolumner. På en smal skärm rullar rutnätet i sidled i sin egen ruta.

Belopp skrivs **med kontots naturliga tecken**: en intäkt på ett intäktskonto och en kostnad på ett kostnadskonto skrivs båda som positiva belopp. I resultaträkningen, som är kreditpositiv, visas kostnadsbudgeten ändå som negativ. Ett tomt fält är 0 och 0-belopp sparas inte.

- **Summa** visar radens summa. Skriv ett årsbelopp i **Summa** och klicka på **Fördela** (tooltip *Fördela årsbelopp jämnt*) — eller tryck Enter i fältet, eller lämna det — så delas beloppet jämnt över månaderna i hela kronor, avrundat nedåt per månad, och sista månaden tar resten så att summan stämmer. Negativa belopp delas på samma sätt. Fördelningen kan justeras månad för månad efteråt.
- **✕** tar bort raden. **+ Lägg till rad** lägger till en ny.
- Under rutnätet visas summaraderna **Intäkter**, **Kostnader** och **Resultat** per månad.
- **Kopiera utfall från föregående år** — välj **Räkenskapsår** (förvalt är året före) och **Påslag eller avdrag (%)** och klicka på **Hämta utfall**. Utfallet per konto och månad läggs in i rutnätet, avrundat till hela kronor, uppräknat med procenten och mappat på kalendermånad. Det ersätter flikens rader (efter en bekräftelse om fliken redan har rader) men sparas först när du klickar på **Spara**.
- **Exportera CSV** laddar ner den sparade budgeten med kolumnerna *Konto*, *Kontonamn*, *Kostnadsställe*, en kolumn per månad och *Summa*. **Importera CSV** läser en sådan fil och fyller fliken med den — månadskolumnerna läses på plats och *Summa* ignoreras. Innehåller filen fel (okänt konto eller kostnadsställe) visas raderna med fel och inget läses in. Det som lästs in sparas först med **Spara**.
- **Spara** sparar namnet och flikens rader. Har du osparade ändringar frågar sidan innan du lämnar den, och ett byte av flik kräver en bekräftelse eftersom flikens osparade ändringar då går förlorade.

### Kostnadsställen i budgeten

Finns det kostnadsställen (se [Kostnadsställen och projekt](#kostnadsstallen-och-projekt)) får budgeten en flik per kostnadsställe, och en flik **Ej fördelat** för belopp som inte hör till något kostnadsställe. Hela företagets budget är summan av alla flikar. Så snart något kostnadsställe har budgetrader visas först fliken **Totalt**, som visar summan per konto och månad och inte går att redigera. **Spara** sparar bara den flik du står på; de andra flikarnas rader rörs inte. **Kopiera utfall från föregående år** och **Exportera CSV** gäller också bara aktuell flik (på **Totalt** hela budgeten), och **Kopiera budget** tar med alla flikar. Tas ett kostnadsställe bort med **Flytta och ta bort** flyttas budgetraderna till ersättaren, och har ersättaren redan budget för samma konto och månad läggs beloppen ihop.

Sidan kräver rättigheten **Ekonomi**.

## Momskoder

**Ekonomi → Momskoder** visar de momskoder systemet bokför med. En **momskod** beskriver hur en rad beskattas: vilken sats den har, vilka konton den bokförs mot — och därmed vilken ruta i momsdeklarationen beloppen hamnar i — och vilken text fakturan ska bära. Koderna är en fast katalog, eftersom lagen avgör vilka som finns: du kan inte lägga upp nya koder eller ta bort någon. Det som är företagets eget är **kontonumren**, **fakturatexten**, **benämningen** och om koden är **Aktiv**.

Tabellen har kolumnerna **Kod**, **Benämning**, **Typ**, **Sats**, **Konton**, **Fakturatext** och **Status** (**Aktiv** eller **Inaktiv**, med knappen **Ändra** under). Under benämningen står hur många konteringsregler som använder koden. Kolumnen **Konton** visar varje konto koden bokför mot med sin roll (**Intäkt**, **Utg. moms**, **Ing. moms**, **Kostnad**, **Underlag** och **Motkonto**), kontots namn och den momsruta koden förväntar sig, t.ex. **Intäkt 3108 Försäljning varor till annat EU-land · ruta 35**. Under **Ändra** heter rollerna **Intäktskonto**, **Utgående moms**, **Ingående moms**, **Kostnadskonto**, **Underlag** och **Motkonto underlag**. Stämmer inte kontots momsruta i [kontoplanen](#kontoplan) med den koden förväntar sig visas en varning under kontot — **Kontot har ruta 05 men ska ha ruta 35**, **Kontot är inaktivt** eller **Kontot finns inte i kontoplanen** — och rörelserna skulle då hamna i fel ruta. Klicka på varningen för att öppna kontot i kontoplanen och rätta rutan.

| Kod | Benämning | Sats | Konton (förval) och ruta |
| --- | --- | --- | --- |
| MP25 | Moms 25 % | 25 % | Intäkt 3001 (05), utgående moms 2610 (10), ingående moms 2640 (48) |
| MP12 | Moms 12 % | 12 % | Intäkt 3002 (05), utgående moms 2620 (11), ingående moms 2640 (48) |
| MP6 | Moms 6 % | 6 % | Intäkt 3003 (05), utgående moms 2630 (12), ingående moms 2640 (48) |
| MF | Momsfri | 0 % | Intäkt 3004 (42) |
| EUV | Varor till annat EU-land | 0 % | Intäkt 3108 (35) |
| EUT | Tjänster till annat EU-land | 0 % | Intäkt 3308 (39) |
| EXV | Export av varor | 0 % | Intäkt 3105 (36) |
| EXT | Tjänster till land utanför EU | 0 % | Intäkt 3305 (40) |
| OB | Omvänd betalningsskyldighet, Sverige | 0 % | Intäkt 3231 (41) |
| IEUV25 / IEUV12 / IEUV6 | Inköp varor från EU 25 / 12 / 6 % | 25 / 12 / 6 % | Kostnad 4515 / 4516 / 4517 (20), utgående moms 2614 / 2624 / 2634 (30 / 31 / 32), ingående moms 2645 (48) |
| IEUT | Inköp tjänster från EU 25 % | 25 % | Kostnad 4535 (21), utgående moms 2614 (30), ingående moms 2645 (48) |
| IUTT | Inköp tjänster utanför EU 25 % | 25 % | Kostnad 4531 (22), utgående moms 2614 (30), ingående moms 2645 (48) |
| IOBV | Inköp varor i Sverige, omvänd betalningsskyldighet | 25 % | Kostnad 4415 (23), utgående moms 2614 (30), ingående moms 2647 (48) |
| IOBT | Inköp tjänster i Sverige, omvänd betalningsskyldighet | 25 % | Kostnad 4425 (24), utgående moms 2614 (30), ingående moms 2647 (48) |
| IUTV | Inköp varor utanför EU (importmoms separat) | 0 % | Inga egna konton — kostnadskontot följer konteringsreglerna och standardkontot |
| IMP25 / IMP12 / IMP6 | Importmoms 25 / 12 / 6 % | 25 / 12 / 6 % | Underlag 4545 / 4546 / 4547 (50), motkonto 4549 (ingen ruta), utgående moms 2615 / 2625 / 2635 (60 / 61 / 62), ingående moms 2645 (48) |

Koderna **EUV**, **EUT** och **OB** kräver köparens momsregistreringsnummer på fakturan. Momsrutorna 06, 07, 08, 37 och 38 (uttag, vinstmarginalbeskattning, frivillig skattskyldighet för hyra och trepartshandel) har ingen momskod — de redovisas via konton med rätt momsruta och manuella verifikat. Ruta 37 (mellanmans inköp vid trepartshandel) räknas som ett inköp, på samma sätt som ruta 20–24 och 50: ett belopp debiterat kontot ger ett positivt belopp i rutan. Ruta 38 räknas som försäljning.

**Ändra** öppnar en dialog med:

- **Benämning** — namnet som visas i listor och på fakturan.
- **Fakturatext** — skrivs en gång på fakturan under momssammanställningen när någon rad har koden. Tomt fält betyder ingen text. **Återställ till förvald text** sätter tillbaka katalogens text (t.ex. *Unionsintern leverans (artikel 138 i mervärdesskattedirektivet)* för **EUV**).
- **Aktiv** — en inaktiv kod kan inte väljas på nya fakturarader och leverantörsfakturor (ett dokument som redan har koden behåller den). **Moms 25 %**, **Moms 12 %**, **Moms 6 %** och **Momsfri** kan inte inaktiveras — Nav faller tillbaka på dem varje gång den väljer momskod själv — så reglaget är avstängt med texten *Används när Nav väljer momskod automatiskt — kan inte inaktiveras.* (API:t svarar *Momskoden används när Nav väljer momskod automatiskt och kan inte inaktiveras*). De andra koderna Nav väljer själv — **Varor till annat EU-land**, **Tjänster till annat EU-land**, **Export av varor**, **Tjänster till land utanför EU**, **Omvänd betalningsskyldighet, Sverige**, **Inköp varor från EU 25 %** och **Inköp varor utanför EU** — går att inaktivera, men dialogen varnar efter **Spara**, t.ex. *Momskoden EUV väljs automatiskt för varor till företagskunder i andra EU-länder — nya fakturarader för sådana kunder måste då få en momskod för hand*. Används koden av en konteringsregel får du också en varning (*Momskoden EUV är inaktiv men används av 1 konteringsregel*): regeln fortsätter gälla. I formuläret **Ny konteringsregel** listas bara aktiva koder (en regel som redan har en kod som inaktiverats behåller den i listan, märkt **(inaktiv)**), men API:t tar emot även en inaktiv kod på en regel.
- Ett konto per roll koden använder, som en lista över aktiva konton i formatet **"3108 Försäljning varor till annat EU-land"**. Överst i listan står **Återställ till standard (3108)**, som tar bort ett eget val. Under varje fält står den momsruta kontot förväntas ha.

Kontot måste finnas i kontoplanen och vara aktivt, och en kod får inte använda samma konto för två roller — då skulle bokföringen ta ut sig själv (**"Momskoden använder samma konto för två roller — bokföringen skulle ta ut sig själv. Välj olika konton."**). Efter **Spara** visar dialogen eventuella varningar — t.ex. att ett valt konto har en annan momsruta än koden förväntar sig — innan du stänger den. Varje ändring loggas i händelseloggen som **Momskod ändrad**.

Momsrapporten läser fortfarande **kontona**, inte fakturorna. Momskoden är bara vägen till rätt konto: ett manuellt verifikat på kontot 3108 hamnar i ruta 35 på samma sätt som en EU-faktura.

**Efter uppgraderingen.** Har företaget använt Nav före momskoderna finns tre saker att kontrollera. Öppna **Momskoder** och läs varningarna under kontona (**Kontot har ruta … men ska ha …**, **Kontot är inaktivt**, **Kontot finns inte i kontoplanen**) — konton som redan har bokförda verifikat har inte fått sin momsruta ändrad automatiskt, eftersom det skulle ändra redan deklarerade perioder, så rätta dem själv i kontoplanen. Öppna sedan [Momsrapport](#momsrapport) för en period och läs varningarna överst (**Konton utan momsruta**, **Momskoder med fel momsruta**, **Konteringsregler med fel momsruta**, **Redovisningskonton med momsruta**). Kontrollera till sist **Land** på varje utländsk leverantör (leverantörskortet, fliken **Allmänt**): Nav har försökt läsa landet ur leverantörens momsnummer och annars ur dess IBAN, och står det **SE** på en leverantör som egentligen finns i utlandet får fakturorna svensk moms i stället för omvänd moms. Leverantörskortet varnar när valutan inte är SEK men landet är Sverige.

## Momsrapport

**Ekonomi → Momsrapport** sammanställer momsdeklarationens alla rutor för en vald redovisningsperiod, direkt ur de bokförda verifikaten. Välj **Räkenskapsår** och **Period** — en enskild månad (t.ex. **Januari 2026**), ett helt kalenderkvartal (t.ex. **Kvartal 1 2026 (jan–mar)**) eller hela räkenskapsåret (**Helår 2026**; ett brutet räkenskapsår heter t.ex. **Helår 2025/2026**). Kvartal erbjuds bara när räkenskapsåret innehåller kvartalets alla tre månader. Rapporten hämtas om automatiskt så fort periodvalet ändras, och bara **bokförda** verifikat räknas — utkast syns aldrig.

Under periodvalet står inställningen **Redovisningsperiod för moms** (**Månad**, **Kvartal** eller **Helår**) — den period Skatteverket har bestämt för företaget. Den styr vilken period sidan förväljer när du öppnar den: den senast avslutade månaden eller det senast avslutade kvartalet, eller — för **Helår** — det senast avslutade räkenskapsåret (det pågående året är inte slut och har inget att deklarera än; finns inget avslutat år väljs det pågående). Ändra den och klicka **Spara**.

Rutorna visas grupperade som Skatteverkets blankett, med kolumnerna **Ruta**, **Beskrivning**, **Belopp** och **Att deklarera (hela kr)**. Rutor utan belopp visas nedtonade — de finns kvar så att tabellen är hela deklarationen.

| Grupp | Rutor | Hämtas från |
| --- | --- | --- |
| A · Momspliktig försäljning eller uttag exklusive moms | 05, 06, 07, 08 | Konton med momsruta **05**–**08** |
| B · Utgående moms på försäljning eller uttag i ruta 05–08 | 10, 11, 12 | Konton med momsruta **10**/**11**/**12** (25/12/6 %) |
| C · Momspliktiga inköp vid omvänd skattskyldighet | 20, 21, 22, 23, 24 | Konton med momsruta **20**–**24** |
| D · Utgående moms på inköp i ruta 20–24 | 30, 31, 32 | Konton med momsruta **30**/**31**/**32** (25/12/6 %) |
| H · Import | 50, 60, 61, 62 | Konton med momsruta **50** (beskattningsunderlag) och **60**/**61**/**62** (utgående moms 25/12/6 %) |
| E · Försäljning m.m. som är undantagen från moms | 35, 36, 37, 38, 39, 40, 41, 42 | Konton med momsruta **35**–**42** |
| F · Ingående moms | 48 | Konton med momsruta **48** |
| G · Moms att betala eller få tillbaka | 49 | (10 + 11 + 12 + 30 + 31 + 32 + 60 + 61 + 62) − 48 — negativt belopp visas som **"Moms att få tillbaka"** |

Momsrutorna läser **kontona**, inte fakturorna — varje konto redovisas i den **Momsruta** som är angiven i [kontoplanen](#kontoplan), så även ett manuellt verifikat räknas med. Vilket konto en fakturarad bokförs mot avgörs av dess [momskod](#momskoder). Avyttringsverifikat från [Anläggningsregistret](#avyttring) (serie AV) utesluts ur rapporten på samma sätt som momsomföringarna — försäljningen av en tillgång räknas via kundfakturan, inte via avyttringsverifikatet.

**Hela kronor.** Deklarationen anges i hela kronor. **Belopp** visar öresbeloppen, så att rapporten stämmer mot huvudboken, och **Att deklarera (hela kr)** visar närmaste hela krona per ruta (en halv krona avrundas bort från noll). Ruta 49 räknas på de **avrundade** rutorna — den summa Skatteverket kontrollerar.

**Varningar.** Överst på rapporten visas varningar när något gör att rutorna inte stämmer:

- **Konton utan momsruta** — ett intäktskonto (kontoklass 3), ett momskonto (26xx) eller ett inköpskonto (44xx/45xx) har rörelser i perioden men momsrutan **Ej angiven**. Beloppen ingår inte i någon ruta förrän rutan är angiven; länken öppnar kontot i kontoplanen.
- **Momskoder med fel momsruta** — en aktiv momskods konto har en annan momsruta i kontoplanen än koden förväntar sig (t.ex. *Momskod EUV: konto 3108 har ruta 05 men ska ha ruta 35*), eller kontot saknas. Länkarna öppnar **Momskoder** respektive kontot.
- **Konteringsregler med fel momsruta** — en konteringsregel ersätter momskodens eget konto, så kontot den pekar på måste hamna i rätt ruta: för en regel för exakt en utrikes- eller omvänd momskod kodens egen ruta (intäktskontot för försäljningskoder, kostnadskontot för omvänd moms på inköp); för **Moms 25 %**, **Moms 12 %** och **Moms 6 %** ett intäktskonto med ruta **05**, för **Momsfri** ruta **42**, och för **Alla momskoder** ruta **05** eller **42**; och kostnadskontot i en regel för svensk moms, **Inköp varor utanför EU** eller **Alla momskoder** får inte ha någon av inköpsrutorna **20–24**, **37** eller **50** — då skulle ett vanligt inköp deklareras som ett EU-, omvänd-moms- eller importinköp. Varje konto i en regel är en egen rad i varningen (*Konteringsregel 100 Maskiner / Alla momskoder: intäktskonto 3108 har ruta 35 men ska ha ruta 05 eller ruta 42*). Länkarna öppnar **Konteringsregler** respektive kontot.
- **Redovisningskonton med momsruta** — **Redovisningskonto för moms** eller **Öres- och kronutjämning** (under [Konteringsregler](#standardkonton)) har en momsruta som momsomföringen tömmer. Rapporten visas ändå, men **Bokför momsomföring** är avstängd tills kontot har en annan ruta eller ett annat konto har valts. Länkarna öppnar kontot i kontoplanen och **Konteringsregler**.

**Ladda ned fil till Skatteverket** skapar momsdeklarationen som en XML-fil för periodens rutor i hela kronor (ISO-8859-1, filnamnet **momsdeklaration-ÅÅÅÅMM.xml** där ÅÅÅÅMM är periodens sista månad — för ett kvartal eller helår alltså den sista månaden i det). Filen laddar du själv upp i Skatteverkets e-tjänst för momsdeklaration via fil; Nav skickar ingenting. Rutor utan belopp utelämnas utom ruta 49. Filen kräver att företagets organisationsnummer är ifyllt med tio siffror under **System → Företagsuppgifter** — annars visas **"Företagets organisationsnummer saknas eller har inte tio siffror — ange det under Företagsuppgifter."** med länken **Öppna Företagsuppgifter**.

Knappen **Bokför importmoms** bokför importmomsen på ett tullbeslut, se [Importmoms](#importmoms).

### Bokför momsomföring

Kortet **Momsomföring** visar alla momskonton som rört sig i perioden — konton med momsruta 10, 11, 12, 30, 31, 32, 48, 60, 61 eller 62 — med deras **Ruta**, **Debet**, **Kredit** och **Netto**: underlaget för omföringen. Under tabellen visas hur omföringen avslutas: ruta 49 **i hela kronor** på **Redovisningskonto för moms** (kredit när moms ska betalas, debet vid moms att få tillbaka) och den **öresdifferens** som hela-kronorsavrundningen lämnar på **Öres- och kronutjämning**.

Knappen **Bokför momsomföring** öppnar en bekräftelsedialog som visar exakt vad som kommer att bokföras, rad för rad med **Debet**, **Kredit** och **Summa**: varje momskonto nollställs för perioden, ruta 49 bokförs på redovisningskontot och öresdifferensen på öres- och kronutjämning. Verifikatet bokförs i serien **M** (Momsredovisning) med **periodens sista dag** som datum. Redovisningskontot och öres- och kronutjämning får inte själva ha en momsruta som omföringen tömmer — annars är knappen avstängd (rapporten visar varningen **Redovisningskonton med momsruta**, se ovan) och omföringen nekas även via API:t (**"Redovisningskontot för moms eller Öres- och kronutjämning har en momsruta som momsomföringen tömmer — välj ett konto utan momsruta under Konteringsregler."**). Själva rapporten och filen till Skatteverket påverkas inte.

Arbetsgången är: **granska rapporten → Bokför momsomföring → lås perioden** under Räkenskapsår. Är periodens sista månad redan låst nekas omföringen — lås upp månaden (med motivering) först. En period utan momsrörelser går inte att omföra (**"Ingen moms att omföra i perioden."**).

När omföringen är bokförd visar kortet **Deklarerad** med en länk till verifikatet (**Verifikat M-…**), och perioden kan inte deklareras igen — inte heller som del av ett kvartal eller helår som överlappar den. Rapportens rutor står stilla efter omföringen: själva M-verifikatet räknas aldrig med i rutorna, så deklarationsunderlaget går alltid att ta fram igen i efterhand.

**Ångra:** öppna M-verifikatet via länken och använd **Omför** (se [Bokfört](#bokfort) ovan), och bokför omföringsutkastet. Perioden blir då deklarerbar igen, och en ny momsomföring tar med både de ursprungliga rörelserna och allt som bokförts i perioden sedan dess. Betalningen av momsskulden mot skattekontot (och en eventuell flytt av momsfordran till 1650) bokförs manuellt som vanligt verifikat.

## Importmoms

Vid import av varor från ett land utanför EU (momskoden **IUTV**, *Inköp varor utanför EU (importmoms separat)*) bokförs ingen moms på leverantörsfakturan. Importmomsen är en egen händelse som bokförs på **tullbeslutet**: beskattningsunderlaget är tullvärdet + tull + frakt till gränsen enligt tullbeslutet — inte leverantörens fakturabelopp — och momsen kvittas direkt som ingående moms. Importmomsen kopplas därför inte till någon leverantörsfaktura.

Knappen **Bokför importmoms** på [Momsrapport](#momsrapport) öppnar en dialog med:

- **Datum** — förvalt till i dag; verifikatet får det datumet och datumet måste ligga i en öppen period.
- **Beskrivning** — t.ex. *Tullbeslut 2026-10-01* (obligatorisk).
- En eller flera rader med **Momssats** (**25 %**, **12 %** eller **6 %** — koderna **IMP25**, **IMP12** och **IMP6**) och **Beskattningsunderlag** (större än 0), eftersom ett tullbeslut kan ha flera satser. **+ Lägg till rad** lägger till en rad, **Ta bort rad** tar bort en.

Medan du fyller i visar dialogen **Kontering**: per rad **debet** underlagskontot (4545/4546/4547, ruta 50) och **kredit** motkontot 4549 (ingen ruta) med beskattningsunderlaget, samt **debet** ingående moms 2645 (ruta 48) och **kredit** utgående moms 2615/2625/2635 (ruta 60/61/62) med underlaget gånger satsen, avrundat till ören. Kontona kommer från momskoderna — de ändras under [Momskoder](#momskoder). Finns ingen aktiv importmomskod visar dialogen **"Det finns ingen aktiv importmomskod. Aktivera Importmoms 25, 12 eller 6 % under Momskoder."**

Klicka **Bokför importmoms** så bokförs ett verifikat i serien **IM** (Importmoms) och du kommer direkt till verifikatet. Ladda upp tullbeslutet som underlag där, se [Underlag på verifikat](#underlag-pa-verifikat). Importmomsen hamnar i momsrapporten via kontonas momsrutor: underlaget i ruta 50, utgående moms i ruta 60/61/62 och ingående moms i ruta 48 — de två momsbeloppen tar ut varandra i ruta 49.

## Periodisk sammanställning

**Ekonomi → Periodisk sammanställning** sammanställer företagets försäljning av varor och tjänster till företag i andra EU-länder, per köparens momsnummer — det underlag Skatteverket kräver för all EU-försäljning. Sammanställningen bygger på de **utfärdade** kund- och kreditfakturorna, hämtas om automatiskt när perioden ändras och skriver ingenting.

**Period.** Välj **Period** — en **Månad** (t.ex. **Oktober 2026**) eller ett **Kvartal** (t.ex. **Kvartal 3 2026 (jul–sep)**); en annan avgränsning än exakt en kalendermånad eller ett kalenderkvartal nekas (**"Perioden måste vara exakt en kalendermånad eller ett kalenderkvartal."**). Förvald är **föregående månad**. Varor till företag i andra EU-länder ska redovisas per kalendermånad; kvartal gäller bara om Skatteverket har beviljat det eller om du bara säljer tjänster — sidan påminner om det under periodvalet.

**Vad som räknas.** Fakturor med fakturadatum i perioden. Rader med momskoden **Varor till annat EU-land** hamnar i kolumnen **Varor** och rader med **Tjänster till annat EU-land** i kolumnen **Tjänster** (se [Momskoder](#momskoder)); kreditfakturor räknas negativt. Beloppen summeras per **köparens momsnummer** så som det står på fakturan — versaler, bara bokstäver och siffror, med landsprefixet (Grekland skrivs **EL**; saknar en äldre faktura prefixet läggs kundens land till). Ett momsnummer förekommer bara en gång, även om flera kunder eller fakturor har det. Beloppen anges i hela kronor, avrundade per rad. **Trepartshandel** är alltid tom — Nav har ingen momskod för den.

Tabellen har kolumnerna **Momsnummer**, **Kund** (länk till kundkortet), **Varor**, **Trepartshandel**, **Tjänster** och **Fakturor** (länkar till fakturakorten), med en rad **Summa** längst ner.

**Avstämning mot momsrapporten.** Kortet **Avstämning mot momsrapporten** ställer sammanställningen mot ruta 35 (varor) och ruta 39 (tjänster) i [momsrapporten](#momsrapport) för samma period, med kolumnerna **Ruta**, **Bokfört**, **Sammanställning** och **Skillnad**. Avstämningen görs i **ören**: radernas ören mot rutans ören, så att varken avrundning hittar på en skillnad eller en liten skillnad döljs. Stämmer de exakt står det **Stämmer**; annars visas skillnaden med ören. Varningen **Skillnad mot bokföringen** visar beloppen med ören — t.ex. *Varor: sammanställningen 1 234,50 kr, bokfört i ruta 35 1 234,80 kr (skillnad -0,30 kr) — typiskt ett manuellt verifikat eller en faktura med fel momskod*. Orsaken är oftast ett manuellt verifikat på 3108 eller 3308, en faktura med fel momskod eller en faktura som lämnats utanför sammanställningen för sitt momsnummer.

**Varningar.** Överst visas varningar, med länkar till de fakturor de gäller:

- **Saknat momsnummer** — fakturor med EU-försäljning saknar köparens momsregistreringsnummer och kommer inte med i sammanställningen.
- **Ogiltigt momsnummer** — numret är inte ett momsnummer från något annat EU-land än Sverige (landskoden först, Grekland **EL**); fakturorna kommer inte med. Ett momsnummer från en annan medlemsstat än kundens eget land räknas som giltigt.
- **Kund utanför EU** — en kund med EU-momskod har ett land som inte är ett EU-land; kontrollera momskoden på fakturorna.
- **Skillnad mot bokföringen** — sammanställningen och ruta 35/39 stämmer inte, se avstämningen ovan.

**Kontaktuppgifter i filen.** Kortet **Kontaktuppgifter i filen** visar **Företagets momsregistreringsnummer** (från **System → Företagsuppgifter**, länken **Öppna Företagsuppgifter**) och har fälten **Kontaktperson** (högst 35 tecken), **Telefon** (högst 17 tecken: siffror med bindestreck efter riktnumret, t.ex. 08-1234567, eller inledande + för ett utlandsnummer) och **E-post** (frivillig). **Spara** lägger dem i inställningarna, där de följer med varje fil; rättigheten **Ekonomi** räcker. Uppgifterna kontrolleras redan vid **Spara** mot det filen kan bära — namnet mot *Kontaktpersonens namn får vara högst 35 tecken och bara innehålla tecken som finns i ISO-8859-1 (latin1) — Skatteverkets fil kan inte bära andra tecken* och telefonnumret mot *Telefonnumret ska vara siffror med högst ett bindestreck efter riktnumret (till exempel 08-123456), eller börja med + för ett utländskt nummer — högst 17 tecken utan mellanslag*. Saknas något filen kräver visar kortet **Filen kan inte skapas än:** med vad som återstår — **Företagets momsregistreringsnummer saknas eller har fel form**, **Kontaktperson saknas** eller **Telefon saknas eller har fel form**.

**Ladda ned fil** skapar Skatteverkets fil för periodisk sammanställning (SKV 574008; ISO-8859-1, filnamnet **PeriodiskSammanstallning** följt av periodens kod — **PeriodiskSammanstallning2610.txt** för oktober 2026, **PeriodiskSammanstallning26K3.txt** för tredje kvartalet). Filen laddar du själv upp i Skatteverkets e-tjänst; Nav skickar ingenting. Filen har företagets och kontaktpersonens uppgifter överst och en rad per köpare; en kolumn som inte används lämnas tom, och en köpare som nettar till noll får **0**. Går filen inte att skapa visas orsaken under knappen:

- **"Ingen EU-försäljning i perioden — ingen periodisk sammanställning ska lämnas."** — inga rader, ingen fil.
- **"Alla EU-fakturor i perioden saknar giltigt momsnummer — rätta kunderna."** — det finns EU-försäljning att redovisa, men ingen faktura har ett giltigt köparnummer, så filen skulle bli tom. Rätta kundernas VAT-nummer (se varningarna ovanför tabellen) och ladda ned igen.
- **"Uppgifter saknas för filen — företagets momsregistreringsnummer (Företagsuppgifter) samt kontaktpersonens namn och telefonnummer måste vara ifyllda."**
- **"Ett belopp är för stort för filen (högst 12 tecken inklusive minustecken) — kontrollera fakturorna i perioden."**

Sidan kräver rättigheten **Ekonomi**, som resten av modulen.

## Kostnadsställen och projekt

Med **kostnadsställen** och **projekt** kan du följa resultatet per avdelning (verkstad, montering, kontor) och per projekt (en storköksleverans, ett kundprojekt) i stället för bara för hela företaget. De motsvarar dimension 1 (Kostnadsställe) och 6 (Projekt) i SIE, så revisorn får dem med i SIE-filen. Det finns bara de två dimensionerna.

### Registren

**Ekonomi → Kostnadsställen** och **Ekonomi → Projekt** är registren, under Grunddata. Klicka **+ Nytt kostnadsställe** eller **+ Nytt projekt**, eller på namnet i listan för att redigera.

- **Kod** — 1–20 tecken och unik (*"Koden används redan av ett annat kostnadsställe"*). Koden blir objektkoden i SIE-filen.
- **Namn**.
- **Aktivt** — ett inaktivt objekt kan inte väljas på nya rader men finns kvar på det som redan bokats.
- Ett projekt har dessutom en valfri **Kund**, **Start** och **Slut** och en **Status**: **Öppet** eller **Stängt**. Ett stängt projekt kan inte väljas på nya rader (*"Projektet är stängt …"*) men finns kvar på det som redan bokats och i rapporterna.

**Ta bort** fungerar som i övriga register: används objektet visas vad det är kopplat till, och du väljer ett annat objekt att **Flytta och ta bort** kopplingarna till. Vill du behålla historiken ungefär som den är, inaktivera objektet i stället.

Används objektet på **bokförda** verifikatrader eller på dokument som inte längre är utkast — utfärdade kundfakturor, attesterade eller makulerade leverantörsfakturor, levererade, fakturerade, makulerade eller förlorade kundorder, mottagna, stängda eller makulerade inköpsorder — går det aldrig att ta bort, eftersom bokföringen och dess underlag inte kan ändras. Då visar **Ta bort** i stället listan över kopplingarna (där de står som t.ex. *bokförda verifikatrader*, *kundfakturarader (utfärdade)*, *leverantörsfakturor (attesterade)* eller *avslutade kundorder*) och texten *"… används på bokförda verifikat eller låsta dokument. Bokföringen kan inte ändras, så posten kan inte tas bort eller flyttas — inaktivera den i stället."* Ingen ersättare kan väljas; knappen **Inaktivera** gör objektet inaktivt, så att det inte kan väljas på nya rader men finns kvar på det som redan bokats. Ett projekt kan också sättas till **Stängt**.

### Var objekten sätts

- **Verifikat** — kolumnerna **Kostnadsställe** och **Projekt** i verifikattabellen, se [Kostnadsställe och projekt på raderna](#kostnadsstalle-och-projekt-pa-raderna). Mallar och återkommande verifikat bär dem.
- **Kundfaktura** — varje fakturarad har ett kostnadsställe och ett projekt (kolumnen **Kostnadsställe / projekt**, och i **Lägg till rad**). Förval för kostnadsstället är kundorderns **Kostnadsställe** (sätts på ordern under **Ändra**), annars artikelgruppens **Kostnadsställe (förval)**; förval för projektet är kundorderns **Projekt**. Objekten bokförs på intäktsraden, inte på kundfordran eller momsen.
- **Leverantörsfaktura** — fakturans **Kostnadsställe** och **Projekt** är förval för raderna, och varje rad kan ha egna. Förval är leverantörens **Kostnadsställe (förval)**, annars artikelgruppens, och inköpsorderns **Projekt** när underlaget hämtas från en inköpsorder. Objekten bokförs på kostnadsraden; restraden tar fakturans.
- **Bankavstämning** — en [bankregel](#bankregler) kan bära kostnadsställe och projekt, och raderna i **Bokför posten** har kolumnerna.
- **Anläggningsregister** — en [anläggningsgrupp](#anlaggningsgrupper) har ett **Kostnadsställe (förval)** för avskrivningsraden.
- **SIE-import** — verifikatens objekt importeras, se [Importera verifikat](#importera-verifikat).
- Lager, löner (PAXml) och övriga automatiska bokningar får inga objekt.

### Kräver kostnadsställe

Kryssrutan **Kräver kostnadsställe** på ett konto (se [Kontoplan](#kontoplan)) gör att en bokning på kontot utan kostnadsställe vägras i manuella verifikat — meddelandet nämner kontona. Utkast kan sparas utan; det är vid **Bokför** det kontrolleras. Automatkonteringen bokar raden ändå (en faktura får aldrig stoppas av det) och visar en varning på verifikatet. Dessutom visar [Aviseringar](/hjalp/aviseringar) **Bokningar utan kostnadsställe**.

### Rapporterna

- [Resultaträkningen](#resultatrakning) har urval **Kostnadsställe** och **Projekt** och lägena **Per kostnadsställe** och **Per projekt**, med en kolumn per objekt som har bokningar på resultatkonton i perioden och en för rader **utan** objekt (bara när sådana finns).
- [Huvudboken](#huvudbok) och verifikatlistan har samma urval och visar objekten per rad.
- **Rapporter → Projektrapport** visar intäkter, kostnader och resultat per projekt och månad ur bokföringen, per konto och de kundordrar som har projektet (offerter och makulerade order räknas inte), se [Projektrapport](/hjalp/rapporter#projektrapport).

## Valutakurser

**Ekonomi → Valutakurser** håller de växelkurser Nav räknar om fakturor och utbetalningar i utländsk valuta med. En kurs anges som **kronor per 1 enhet** av valutan — 11,131 för EUR betyder att 1 EUR kostar 11,131 kr. SEK har alltid kurs 1 och behöver ingen kurs.

Listan visar kurserna med den nyaste dagen först: **Datum**, **Valuta**, **Kurs (SEK per enhet)**, **Källa** (**Riksbanken** eller **Manuell**), **Inlagd av** och **Ändrad**. Skriv en valutakod, t.ex. EUR, i sökfältet för att bara se den valutan, och filtrera på **Alla källor**/**Riksbanken**/**Manuell** och på **Från**/**Till** (datum). Texten **Källa: Sveriges Riksbank** står under listan när den visar kurser från Riksbanken, och där Nav hämtar en Riksbankskurs åt dig: under fältet **Kurs** på ny offert/kundorder, i orderhuvudet och på leverantörsfakturan, i hjälptexten när **Belopp i SEK** förifylls vid en betalning (kund, leverantör och **Bekräfta utförd** på en betalfil) och i bokslutets **Valutaomvärdering**. Kundfakturans och kundorderns sparade kurs visas utan källa — dokumenten sparar kursen men inte varifrån den kom — och en egen kurs märks **egen kurs i Valutakurser** eller **manuell**, aldrig med Riksbankens källa.

**Så hittar Nav en kurs.** När ett dokument ska ha en kurs för ett datum letar Nav efter **senaste bankdag före eller på datumet** — helger och helgdagar har ingen kurs hos Riksbanken, och dagens kurs publiceras först ungefär klockan 16.15, så före dess gäller gårdagens. Kurserna sparas i registret när de hämtats och återanvänds därefter, så Riksbanken anropas bara när en dag saknas. Finns en egen kurs (**Manuell**) för exakt den dagen går den före Riksbankens. Svarar inte Riksbanken, eller publicerar den inte valutan, används den senaste egna kursen inom tio dagar före datumet. Finns ingen kurs alls får du *Ingen kurs för EUR 2026-10-24 — ange kursen själv* och skriver kursen på dokumentet eller under **Ny kurs**.

**Hämta från Riksbanken** öppnar en dialog med **Valuta**, **Från** och **Till** (högst 93 dagar åt gången; förvalt är de senaste 30 dagarna). **Hämta kurser** hämtar Riksbankens dagskurser för alla bankdagar i perioden och sparar dem. Notisen berättar hur många kurser som hämtades — *12 kurser för EUR hämtade (2026-09-24 – 2026-10-24). Källa: Sveriges Riksbank.* — eller att Riksbanken inte har några för perioden (inga bankdagar, eller så publicerar Riksbanken inte valutan). Svarar Riksbanken inte, eller tar den inte emot fler anrop, får du ett felmeddelande och kan försöka igen om en stund.

**+ Ny kurs** lägger in en egen kurs med **Valuta**, **Datum** och **Kurs (SEK per 1 enhet)** (högst sex decimaler). Använd den för valutor som Riksbanken inte publicerar, eller när du vill räkna med en annan kurs, t.ex. bankens. En egen kurs för en dag ersätter en tidigare egen kurs samma dag. SEK kan inte få någon kurs.

**Inställningar.** Längst ner på sidan (bara för administratörer) finns:

- **Källa för valutakurser** — **Riksbanken** (förval) eller **Bara manuella**. Med **Bara manuella** använder Nav enbart kurserna du lagt in under **Ny kurs** (den senaste inom tio dagar före datumet) och anropar aldrig Riksbanken.
- **API-nyckel (Riksbanken, valfri)** — utan nyckel tar Riksbanken emot 5 anrop per minut och 1 000 per dag och IP-adress, vilket räcker för vardagsbruk eftersom Nav sparar kurserna. Har du skaffat en nyckel skriver du in den här och klickar **Spara**. Nyckeln visas aldrig igen — fältet säger bara **Nyckel sparad** — och **Ta bort nyckel** raderar den. Godkänner Riksbanken inte nyckeln får du *Riksbanken godkände inte API-nyckeln — kontrollera den under Ekonomi → Valutakurser.*

**Vilken kurs som ska gälla.** Mervärdesskattelagen (8 kap. 21 §) kräver att beloppet räknas om till kronor med den senaste kurs Riksbanken eller ECB har publicerat när den beskattningsgrundande händelsen inträffar — oftast leveransen av varan eller tjänsten, inte alltid fakturadatumet. Nav förväljer kursen för **Fakturadatum**; skiljer sig leveransdagen från fakturadatumet ändrar du **Kurs** på leverantörsfakturan innan du godkänner den, se [Leverantörsfaktura i utländsk valuta](/hjalp/inkop#leverantorsfaktura-i-utlandsk-valuta).

**Bokföring och kursdifferens.** Dokumentet är facit i sin egen valuta — fakturan och reskontran räknas i EUR — och bokföringen sker i SEK med dokumentets kurs. När en utbetalning registreras blir skillnaden mellan kronorna som drogs från bankkontot och kronorna skulden bokades till en **kursvinst** eller **kursförlust** (standardkonton, se [Standardkonton](#standardkonton)), och bankens avgift bokförs som bankkostnad, se [Utbetalning i utländsk valuta](/hjalp/inkop#utbetalning-i-utlandsk-valuta). Försäljningen fungerar likadant åt andra hållet: kundens faktura i EUR bokförs i SEK med kursen vid **Utfärda**, och när betalningen registreras blir skillnaden mellan kronorna som kom in på kontot (med bankavgiften medräknad) och kronorna fordran bokades till en kursvinst eller kursförlust, se [Faktura i utländsk valuta](/hjalp/forsaljning#faktura-i-utlandsk-valuta) och [Betalning i utländsk valuta](/hjalp/forsaljning#betalning-i-utlandsk-valuta) i kapitlet Försäljning. Kundordrarnas kurs påverkar inte bokföringen — den räknar om artikelns SEK-pris till orderns valuta och orderns värde till SEK i rapporterna; det är fakturans kurs som bokförs. Öppna fakturor i utländsk valuta värderas om till balansdagens kurs i bokslutet, se [Valutaomvärdering](#valutaomvardering) nedan under Årsbokslut.

Hela sidan kräver rättigheten **Ekonomi**, som resten av modulen.

## Referensränta

**Ekonomi → Referensränta** håller Riksbankens referensränta per kalenderhalvår — grunden för [dröjsmålsräntan](/hjalp/forsaljning#rantefakturering). Räntan fastställs den 1 januari och den 1 juli, och dröjsmålsräntan är referensräntan för halvåret plus **Räntemarginal (procentenheter)** (8 enligt räntelagen). Sidan öppnas av den som har rättigheten **Ekonomi** eller **Försäljning**; knapparna visas för den som får skriva, alltså **Försäljning**, som för kundfakturorna.

Listan visar halvåren med det senaste först: **Gäller från** (1 januari eller 1 juli), halvåret, **Räntesats** och **Källa** (**Sveriges Riksbank** eller **Manuell**).

**Hämta från Riksbanken** öppnar en dialog med **Från** och **Till** (förvalt de senaste fyra halvåren) och hämtar referensräntan för varje halvår perioden berör. Notisen berättar hur många räntor som hämtades — *2 referensräntor hämtade (2026-01-01 – 2026-10-25). Källa: Sveriges Riksbank.* Svarar Riksbanken inte får du ett felmeddelande och kan försöka igen eller lägga in räntan själv. Räntefakturering hämtar dessutom saknade halvår av sig själv när listan öppnas.

**Lägg till** lägger in en egen ränta med **År**, **Halvår** (**Första halvåret (från 1 januari)** eller **Andra halvåret (från 1 juli)**) och **Räntesats (%)**. En egen ränta går före Riksbankens för samma halvår och ersätter en tidigare egen ränta för halvåret. **Ta bort** finns bara på egna räntor (bekräftas först); en ränta hämtad från Riksbanken kan inte tas bort — lägg in en egen för halvåret om den ska ersättas.

## SIE-filer

**Ekonomi → SIE-filer** hanterar utbyte av bokföring med revisor eller ett annat bokföringsprogram, i det svenska SIE-formatet (typ 4). Sidan har två flikar: **Export och ingående balanser** och **Importera verifikat**. Kräver rättigheten **Ekonomi**, som resten av modulen.

### Exportera

Välj **Räkenskapsår** och klicka **Ladda ner SIE-fil**. Filen innehåller räkenskapsårets kontoplan, ingående och utgående saldon, årets resultat per konto och **samtliga bokförda verifikat** med sina konteringsrader. Utkast följer aldrig med. Finns ett föregående räkenskapsår tas även dess datumintervall med som jämförelseår, vilket många mottagande program vill ha.

Kostnadsställen och projekt följer med: filen innehåller `#DIM 1 "Kostnadsställe"` och `#DIM 6 "Projekt"`, ett `#OBJEKT` per kostnadsställe och projekt och objekten på varje verifikatrad (`{1 "kod" 6 "kod"}` i `#TRANS`).

Filen skrivs i teckenkodningen **CP437**, som SIE-standarden kräver — öppnar du den i en vanlig textredigerare kan svenska tecken därför se konstiga ut, medan bokföringsprogrammet läser den rätt. Filändelsen är `.se` och filnamnet innehåller företagsnamn och räkenskapsårets datum.

### Importera ingående balanser

Rutinen är till för att **flytta in bokföring från ett annat system**: den läser filens ingående balanser (`#IB`) och bokför dem som ett verifikat i serien **I** (Ingående balanser), daterat räkenskapsårets första dag. Därefter syns de som vilken bokföring som helst — i huvudboken, i balansräkningen och i en senare SIE-export.

Välj **Räkenskapsår**, välj filen och klicka **Importera**. Resultatet visar vilket verifikat som skapades, hur många konton som fick en ingående balans, och vilka konton som lades upp automatiskt.

Regler att känna till:

- **Konton som saknas skapas automatiskt** med namnet ur filens `#KONTO`-rader (längre än 100 tecken kortas). Ett konto som inte har fyra siffror kan inte läggas upp — då avvisas filen (*"Kontot 19350 har inte fyra siffror och kan inte skapas"*) och ingenting skrivs.
- **Balanserna måste summera till noll.** Gör de inte det avbryts importen med differensen angiven — systemet uppfinner aldrig en motpost, eftersom det skulle dölja ett fel i källdatat.
- **Filens räkenskapsår måste stämma** med det du valt, annars avbryts importen. Annars skulle fjolårets balanser kunna hamna på fel år utan att någon märkte det.
- **Bara en gång per räkenskapsår.** Ett andra försök avvisas — annars skulle varje balans dubbleras.
- **Finns det redan bokförda verifikat före räkenskapsårets början avvisas importen.** Då räknas den ingående balansen fram automatiskt ur den befintliga bokföringen, och en import ovanpå skulle dubblera den.
- Är räkenskapsårets första period låst går det inte att bokföra — lås upp den under **Räkenskapsår** först.
- Ingenting skrivs förrän hela filen är godkänd: en avvisad import lämnar inga spår.

### Importera verifikat

Fliken **Importera verifikat** läser själva verifikaten (`#VER` med `#TRANS`) ur en SIE-fil — framför allt **lönejournalen** från lönesystemet, som annars måste knappas in för hand varje månad. Välj filen så läser Nav den direkt och visar en **förhandsgranskning** innan något importeras:

- Filens namn, vilket program som skrev den och antalet verifikat.
- Varje verifikat som en rad som kan fällas ut: serie, nummer, datum, text, summa **Debet** och **Kredit** och dess rader med konto, text och belopp. Ett obalanserat verifikat markeras **Obalans**, och varningar (till exempel datum utanför räkenskapsåret eller en låst period) står under raden.
- **Konton som saknas i kontoplanen** och **Kostnadsställen och projekt som saknas** (objekten i filens `#TRANS`-rader som inte finns i Nav, med dimension 1 = kostnadsställe och 6 = projekt), och **Spärrar** — fel som stoppar hela importen — i rött. Har filen redan importerats visas när och av vem.

Välj sedan:

- **Serie** — förvalet är **LÖ — Lönejournal**, som skapas automatiskt första gången den behövs. Du kan välja en annan serie.
- **Läge** — **Utkast** (förval) lägger verifikaten som utkast att granska och bokföra, **Bokför** bokför dem direkt.
- **Skapa saknade konton och objekt** — kryssrutan visas när filen använder konton, kostnadsställen eller projekt som inte finns. Utan den kan filen inte importeras; med den läggs kontona upp med namnen ur filens `#KONTO`-rader (ett namn längre än 100 tecken kortas), och kostnadsställena och projekten med koderna och namnen ur filens `#OBJEKT`-rader. Objekten på verifikatraderna importeras alltid, så resultatet per kostnadsställe och projekt stämmer med filens. Ett konto som inte har **fyra siffror** kan inte läggas upp i Navs kontoplan — det stoppar importen (*"Kontot 12345 har inte fyra siffror och kan inte skapas"*) oavsett kryssrutan; lägg upp det för hand under ett fyrsiffrigt nummer eller rätta filen.

Klicka **Importera**. Resultatet listar de nya verifikaten med länkar.

Regler att känna till:

- **Allt eller inget.** Är något verifikat obalanserat, saknas ett konto eller objekt utan att du valt **Skapa saknade konton och objekt**, eller ligger ett datum i en låst period, importeras ingenting (*"Ingenting importerades: …"* med orsakerna).
- **Samma fil kan bara importeras en gång.** Filen känns igen på sitt innehåll (kontrollsumma), inte på filnamnet — en andra import avvisas med *"Filen har redan importerats … av …"*, så ingen löneperiod bokförs två gånger.
- Varje verifikat får filens text och hänvisningen *(SIE-import ver LÖ 12)* som beskrivning (radtexter längre än 255 tecken kortas), och **filen sparas som underlag** på varje verifikat (se [Underlag på verifikat](#underlag-pa-verifikat)). Är serien eller räkenskapsåret fel kan du ta bort ett utkast och importera om först när du rättat — den redan importerade filen kan inte läsas in igen, så rätta i stället utkasten för hand.
- Eftersom filen sparas en gång per verifikat tar en stor fil med många verifikat plats: förhandsgranskningen varnar när antal verifikat × filens storlek överstiger **50 MB** (*"Filen sparas som underlag på varje verifikat: 60 verifikat × 1 MB ≈ 60 MB lagras i databasen"*), och över **500 MB** stoppas importen — dela då upp filen i mindre delar.
- Ett datum som inte finns i kalendern (till exempel 30 februari) eller ett `#VER` utan sitt `{ … }`-block gör att filen avvisas som felaktig innan något förhandsgranskas.
- `#RTRANS` och `#BTRANS` (rättade och borttagna rader) hoppas över, i enlighet med SIE-standarden.
- Importen läser alltid filens egna belopp: positiva belopp blir debet och negativa kredit.

## Bankavstämning

**Ekonomi → Bankavstämning** stämmer av bankkontot i bokföringen (till exempel 1930) mot **kontoutdraget** från banken. Du importerar kontoutdraget, matchar varje post mot en rad i bokföringen och bokför det som saknas — bankavgifter, ränta, kortköp, överföringar. När allt är matchat och saldona stämmer markerar du kontot som avstämt. Hela sidan kräver rättigheten **Ekonomi**.

Välj **Bankkonto**, **Från** och **Till** överst — valen ligger i adressen, så du kan spara eller skicka länken. Förvalt är det första aktiva bankkontot och innevarande år t.o.m. i dag.

**Sammanställningen** överst jämför de två sidorna:

- **Saldo enligt kontoutdraget** — det senaste utgående saldot på ett importerat kontoutdrag till och med **Till**, med datumet det gäller. Saknas kontoutdrag står det **Saknas**.
- **Saldo i bokföringen** — bankkontots saldo i huvudboken per samma dag.
- **Omatchade poster** och **Omatchade rader** — summan av det som ännu inte är matchat på respektive sida **till och med den dagen** (allt sedan start, inte bara perioden), och antalet i den valda perioden.
- **Skillnad** — kontoutdragets saldo minus bokföringens, per samma dag.

- **I transit** — det matchningar som *korsar* saldodagen bidrar med: en post som banken bokförde på eller före dagen men vars rad i bokföringen är daterad efter (räknas plus), och en rad daterad på eller före dagen vars post på kontoutdraget kom efter (räknas minus). En matchning som ligger helt på ena sidan av dagen räknas inte.

Hela sammanställningen mäts alltså på kontoutdragets saldodag, inte på **Till** — dagen står i rutorna och i omdömet. Skillnaden ska precis motsvara de omatchade posterna minus de omatchade raderna plus det som är i transit: en insättning som står på kontoutdraget men ännu inte är bokförd förklarar skillnaden, och försvinner så fort den matchats eller bokförts; en betalning som banken bokförde den 30:e och bokföringen den 1:a förklaras av **I transit** så länge saldodagen ligger mellan de två. Stämmer det visas **Skillnaden är förklarad**. Stämmer det inte visas en röd **Avvikelse** — oftast saknas ett kontoutdrag för en del av perioden, något har ändrats efter importen, eller så saknar avstämningen en [startpunkt](#startpunkt-for-avstamningen).

### Startpunkt för avstämningen

Bokföringen på bankkontot börjar nästan alltid före det första kontoutdraget: den ingående balansen och allt som bokfördes innan har ingen post på något kontoutdrag och kan aldrig matchas. Därför börjar avstämningen med en **startpunkt**. Så länge kontot inte har någon avstämning visar sidan rutan **Startpunkt för avstämningen**: ange **Startdatum** (vanligtvis dagen före det första kontoutdraget du importerar) och **Kontoutdragets saldo per datumet** som du läser av i internetbanken, och klicka **Skapa startpunkt**.

Startpunkten knyter ihop alla poster och rader på kontot till och med datumet i en enda matchning av typen **Startpunkt**, utan kravet på lika summor, och sparar den som den första avstämningen. Kontoutdragets saldo måste stämma med bokföringens saldo på huvudbokskontot per samma dag — annars vägrar Nav med båda beloppen, så att du bokför skillnaden först. Startpunkten kan bara skapas innan kontots första vanliga avstämning (en senare avstämning bygger redan på allt före den), och den kan ångras under **Matchat** med **Ångra** så länge ingen senare avstämning gjorts: posterna och raderna blir omatchade igen och avstämningsmärket tas bort. Startpunkten visas alltid under **Matchat**, oavsett vald period, och under **Tidigare avstämningar** märkt *Startpunkt*.

### Bankkonton

**Ekonomi → Bankkonton** är registret över bankkonton som kan stämmas av. **+ Nytt bankkonto** öppnar ett formulär med **Namn**, **IBAN eller kontonummer** (versaler och mellanslag spelar ingen roll, numret måste vara unikt) och **Huvudbokskonto** — kontot i kontoplanen som bankens saldo ska stämma mot, vanligtvis 1930. Kontoutdraget känns igen på det nummer du anger här. Listan visar även **Avstämd t.o.m.**, **Senaste kontoutdrag** och antalet **Omatchade** poster, och en länk **Stäm av** som öppnar bankavstämningen för kontot. **Ändra** ändrar uppgifterna och **Inaktivera** tar bort kontot ur valet på avstämningssidan utan att något raderas.

Första gången du öppnar registret läggs ett bankkonto upp åt dig ur IBAN under **Företagsuppgifter** och standardkontot **Bank/betalkonto** under [Konteringsregler](#standardkonton), om IBAN är ifyllt (inte när du är inloggad med ett konto som har **Endast läsning**).

**Huvudbokskonto** och valuta är låsta så snart bankkontot har importerade poster eller matchningar — de är det posterna och matchningarna gjordes mot. Ska saldot stämmas mot ett annat konto lägger du upp ett nytt bankkonto. **IBAN eller kontonummer** kan fortfarande ändras för hand, men ett kontoutdrag för ett okänt konto kan bara läras in på ett bankkonto som ännu inte har några poster; har det valda kontot redan poster under ett annat nummer stoppas importen med en förklaring — lägg upp ett eget bankkonto för filens konto.

### Importera kontoutdrag

Klicka **Importera kontoutdrag** och välj filen. Nav läser den och visar en **förhandsgranskning** — inget sparas förrän du klickar **Importera**.

- **camt.053** är kontoutdraget som XML-fil, som Handelsbanken, SEB, Swedbank och Nordea kan lämna via filöverföring eller internetbanken. Filen innehåller kontots nummer, perioden, **Ingående saldo** och **Utgående saldo** samt varje post. Känner Nav inte igen kontonumret (det är inte angivet på något bankkonto) frågar dialogen **Bankkonto** vilket konto det är, och numret sparas på kontot.
- **CSV** är den export som internetbanken ger för den som inte har något filöverföringsavtal. En CSV-fil saknar kontonummer, så välj **Bankkonto**. Under **Kolumnmappning för CSV-filen** anger du **Avgränsare**, hur många **Rader att hoppa över överst** och vilka kolumner som är **Bokföringsdag**, **Belopp** och **Text** (och valfritt **Saldo**, **Valutadag** och **Referens**), samt om beloppen skrivs med decimalkomma. Ett positivt belopp är en insättning och ett negativt ett uttag. Är avgränsaren fel visas rubrikerna som en enda kolumn — ändra **Avgränsare** och klicka **Läs om rubriker**. Klicka **Förhandsgranska** när mappningen stämmer. Mappningen sparas på bankkontot, så nästa fil från samma bank behöver bara ett klick. Filens ordning (nyaste eller äldsta rad först) avgörs av datumen, och inom en och samma dag av saldokolumnen; följer saldot inte beloppen rad för rad visas en varning. Ett belopp som *1.234* utan angiven decimalkonvention läses som 1,23 och ger en varning — ange decimalkomma eller decimalpunkt i mappningen så blir det entydigt.

Förhandsgranskningen visar per kontoutdrag konto, period, saldon och antalet poster, **nya** och **dubbletter**, och de första posterna med status **Ny** eller **Dubblett** (**Ny · regel** när en [bankregel](#bankregler) känner igen posten). Varningar visas i gult och fel som stoppar importen i rött.

**Dubbletter.** Samma post importeras aldrig två gånger: en post som redan finns på kontot hoppas över och räknas som dubblett. Posten känns igen på bankens egen referens på posten (camt.053) eller, när den saknas (alltid i CSV), på dag, belopp och text — två likadana poster i samma fil räknas som två poster, men samma fil igen ger bara dubbletter. Du kan alltså importera överlappande perioder eller samma fil igen utan risk — är alla poster dubbletter står det **Alla posterna är redan importerade** och **Importera** är avstängd.

Med kryssrutan **Matcha automatiskt efter import** (förvald) matchas posterna direkt när de lagts in; därefter bokförs nya poster som fortfarande är omatchade enligt bankregler med **Bokför direkt**. Efteråt visar sidan hur många poster som importerades, hur många dubbletter som hoppades över, hur många som matchades automatiskt och hur många som bokfördes direkt enligt en bankregel. En post som en regel skulle ha bokfört men inte kunde (till exempel låst period) visas som en varning och ligger kvar omatchad — själva importen påverkas inte, och detsamma gäller om matchningen eller reglerna skulle gå fel efter att posterna lagts in. Kontoutdraget och varje post måste vara i bankkontots valuta; en post i en annan valuta stoppar importen.

### Matchning

En **matchning** knyter ihop en eller flera poster på kontoutdraget med en eller flera rader i bokföringen på bankkontot. Summorna måste vara lika. Tre listor visar läget: **Omatchade poster på kontoutdraget**, **Omatchade rader i bokföringen** och **Matchat**.

**Automatisk matchning** sker vid import och med knappen **Matcha automatiskt**. Den matchar bara när det är entydigt, i den här ordningen:

1. **Referens** — posten bär en betalningsreferens som en inläst bankfil redan har bokfört som kund- eller leverantörsbetalning, och matchas mot betalningens verifikatrad.
2. **Återföring** — en post som banken märkt som återföring nettas mot sin ursprungliga post på kontoutdraget (motsatt belopp): den som delar referens, annars den närmast före. En återföring matchas aldrig mot en rad i bokföringen på belopp och datum; saknas originalet lämnas den till dig.
3. **Belopp och datum** — exakt samma belopp och en verifikatrad vars datum ligger högst tre dagar från bokföringsdagen, och ingen annan omatchad post eller rad med samma belopp i det fönstret.

Är det inte entydigt matchas ingenting automatiskt. Raderna får i stället en markering: **Förslag · referens**, **Förslag · återföring** eller **Förslag · belopp och datum** för ett säkert förslag, och **Flera möjliga** när flera rader eller poster passar. **Markera förslaget** (eller **Markera kandidaterna**) kryssar i de ingående posterna och raderna, så att du kan kontrollera och klicka **Matcha**.

**Manuell matchning.** Kryssa i en eller flera poster och en eller flera rader. Fältet över listorna visar de **Markerade posterna**, **Markerade raderna** och **Skillnad**. När skillnaden är 0,00 aktiveras **Matcha**. En post kan matchas mot flera rader (och tvärtom) — till exempel en utbetalning som bokförts som två leverantörsbetalningar. Ena sidan får vara tom när den markerade sidan summerar till 0,00: en **Återföring** på kontoutdraget nettas mot sin ursprungliga post utan någon rad i bokföringen, och två rader som tar ut varandra nettas på samma sätt.

**Ångra.** Under **Matchat** fäller du ut en matchning och klickar **Ångra**, efter en bekräftelse. Posterna och raderna blir omatchade igen; matchningen raderas aldrig utan sparas som ångrad. Är matchningen **Bokförd från posten** ligger verifikatet kvar — rätta det med en omföring om det var fel.

### Bokföra en post som saknas

Står en post på kontoutdraget utan motsvarighet i bokföringen klickar du **Bokför** på posten. Dialogen **Bokför posten** visar verifikattabellen förifylld:

- rad 1 är bankkontot med postens belopp — debet för en insättning, kredit för ett uttag,
- rad 2 är motkontot från en [bankregel](#bankregler) när någon känner igen texten, annars tom — välj konto själv,
- datumet är bokföringsdagen och beskrivningen är texten på posten.

Tabellen fungerar som när du bokför ett vanligt [verifikat](#nytt-verifikat), inklusive **Momskod** (ett kortköp med moms bokförs med momsraden utbruten) och tangentbordet. Raden på bankkontot måste ha exakt postens belopp på rätt sida. **Bokför** skapar verifikatet i serien **B** (Bank), bokför det och matchar det mot posten i samma steg; verifikatet länkas i bekräftelsen.

Med flera poster som en regel känner igen kryssar du i dem och klickar **Bokför enligt regel**. Det blir ett verifikat per post — aldrig ihopslaget, eftersom varje post har sitt eget underlag i kontoutdraget. Poster som inte kunde bokföras (till exempel för att perioden är låst) listas med orsak och ligger kvar omatchade.

### Bankregler

**Ekonomi → Bankregler** innehåller reglerna som känner igen återkommande poster. Nav lägger upp några förslag första gången: avgifter mot 6570, ränta mot 8310 (in) och 8410 (ut), och Skatteverket/skattekontot mot 1630. Ta bort eller ändra dem som du vill. **+ Ny regel** (eller **Ändra**) har fälten:

- **Texten innehåller** — texten som ska finnas i postens text (skiftläge spelar ingen roll).
- **Riktning** — **In** (insättningar), **Ut** (uttag) eller **Båda**.
- **Konto** — motkontot som föreslås när posten bokförs.
- **Momskod** — valfri, bara en inhemsk kod (**MP25**, **MP12**, **MP6** eller **MF**); beloppet tolkas då som inklusive moms och momsraden läggs till på kodens konto för utgående moms (insättning) eller ingående moms (uttag). MF lägger inte till någon momsrad.
- **Beskrivning** — texten på motkontots rad; tom ⇒ postens egen text.
- **Kostnadsställe** och **Projekt** — valfria (visas när det finns objekt); förifylls på motkontots rad när posten bokförs och sätts på rader som regeln bokför direkt.
- **Bokför direkt** — nya poster som regeln träffar bokförs direkt vid import, efter den automatiska matchningen. Det gäller bara när **exakt en** aktiv regel träffar posten och kontot (och momskodens momskonto) är aktivt; träffar flera regler samma post lämnas den till dig. **Bokför direkt är avstängt som förval** — slå på det först när du litar på regeln.
- **Aktiv** — en inaktiv regel används inte men finns kvar.

I listan över omatchade poster visas regelns förslag under posten (*Regel: konto 6570 …*) — bara när exakt en regel träffar posten; **Bokför enligt regel** gäller samma poster.

### Avstämd t.o.m.

Avstämningen börjar med en [startpunkt](#startpunkt-for-avstamningen). När allt till och med ett datum sedan är matchat och kontoutdragets saldo stämmer med bokföringens kan du markera bankkontot som avstämt. Under **Avstämd t.o.m.** står när kontot senast stämdes av. Välj **Datum** (förvalt är kontoutdragets saldodag) och klicka **Markera som avstämd**. Nav vägrar när det finns omatchade poster eller rader till och med datumet, när kontoutdragets saldo saknas för datumet eller när saldona inte stämmer — meddelandet säger vilket. Saldona jämförs med hänsyn till det som är **I transit**: skillnaden mellan kontoutdragets och bokföringens saldo ska vara exakt det matchningarna som korsar datumet bidrar med. Varje avstämning sparas och syns under **Tidigare avstämningar**; den kan inte ändras i efterhand (bara startpunkten kan ångras, och bara så länge den är den enda avstämningen).

Bokförs något på bankkontot i efterhand med ett datum som redan är avstämt — eller blir en post eller rad till och med datumet omatchad igen, till exempel efter **Ångra** på en matchning eller en ny import — visar sidan en gul varning: **Bokföringen har ändrats efter avstämningen** med datum och antal rader och poster. Matcha eller bokför dem och stäm av igen.

Avstämningen är ingen spärr — du kan fortfarande bokföra — men [årsbokslutet](#kontroller) varnar när bankkontot inte är avstämt till bokslutsdagen.

### Aviseringen

[Aviseringen](/hjalp/aviseringar) **Omatchade bankposter** (gul, rättighet **Ekonomi**) listar poster på kontoutdraget som är äldre än 10 dagar och ännu inte matchade, så att inget glöms bort mellan avstämningarna.

## Anläggningsregister

**Ekonomi → Anläggningsregister** håller företagets anläggningstillgångar (maskiner, inventarier, bilar, datorer, byggnader) och bokför de planenliga avskrivningarna. Registret bokför **inte** själva anskaffningen — den är redan bokförd via leverantörsfakturan eller ett manuellt verifikat på tillgångskontot. Registret bokför avskrivningar och avyttringar, i verifikatserien **AV** (Anläggningar), som skapas automatiskt första gången den behövs.

### Anläggningsgrupper

**Ekonomi → Anläggningsgrupper** är grunddata: varje grupp bär fem konton — **Tillgångskonto** (t.ex. 1220), **Ack. avskrivningar** (1229), **Avskrivningskostnad** (7830), **Vinst vid avyttring** (3973) och **Förlust vid avyttring** (7970) — samt **Förvald nyttjandetid (månader)**, som förifylls på nya anläggningar i gruppen. Tillgångskonto, ack-konto och kostnadskonto måste vara tre olika konton. När någon anläggning i gruppen har bokförd avskrivning eller en **Ingående avskrivning** är de tre kontona låsta i gruppens dialog (*"Tillgångskonto, ack-konto och kostnadskonto är låsta — gruppen har bokförd eller ingående avskrivning"*) — de bär redan bokförda belopp; vinst- och förlustkonto, namn och nyttjandetid kan fortfarande ändras.

En grupp kan också få ett **Kostnadsställe (förval)**, som sätts på avskrivningsraden (kostnadskontot) när gruppens anläggningar skrivs av.

Knappen **Förifyll BAS-grupper** skapar fem grupper ur BAS-kontoplanen: *Maskiner och andra tekniska anläggningar* (1210/1219/7830, 60 mån), *Inventarier och verktyg* (1220/1229/7830, 60 mån), *Bilar och andra transportmedel* (1240/1249/7830, 60 mån), *Datorer* (1250/1259/7830, 36 mån) och *Byggnader* (1110/1119/7820, 600 mån = 2 % per år). Grupper som redan finns hoppas över. Saknas ett av kontona i kontoplanen avbryts förifyllningen — kör **Förifyll BAS-urval** under Kontoplan först. Nyttjandetiderna är bara förval; ändra dem efter företagets egna bedömningar. En grupp kan tas bort så länge den saknar anläggningar.

### Ny anläggning

**+ Ny anläggning** på registersidan: **Benämning**, **Grupp** (sätter förvald nyttjandetid), **Anskaffningsdatum**, **Avskrivningsstart** (förval anskaffningsmånaden — kan flyttas till en senare månad), **Anskaffningsvärde**, **Restvärde** (förval 0; lika med anskaffningsvärdet för t.ex. mark som inte skrivs av), **Nyttjandetid (månader)**, valfri **Leverantörsfaktura** (länk till köpet) och **Anteckning**. Anläggningen får ett nummer i serien **AN-**.

**Anläggningar anskaffade före Nav:** för en tillgång som köptes innan företaget började använda Nav ligger den hittills ackumulerade avskrivningen redan i den ingående balansen (se [SIE-filer](#sie-filer)). Fyll i den som **Ingående avskrivning** (beloppet) och **Avskriven t.o.m. månad** (sista månaden som beloppet täcker). Båda fälten fylls i tillsammans eller inte alls. Anskaffningsvärde, Anskaffningsdatum och Nyttjandetid anges som de ursprungligen var; den första körningen fortsätter från månaden efter **Avskriven t.o.m. månad** och skriver inte av det som redan ligger i balansen. Beloppet får inte överstiga det avskrivningsbara underlaget (anskaffningsvärde − restvärde), och månaden måste vara en passerad månad inom nyttjandetiden, inte före avskrivningsstart. Tillgångskortet visar **Ingående avskrivning** i översikten, och ackumulerad avskrivning och bokfört värde räknar med den. Fälten låses, precis som anskaffningsvärdet, när den första avskrivningen är bokförd.

Avskrivningen är linjär på hela månader: *(anskaffningsvärde − restvärde) / nyttjandetid* per månad, och sista månaden tar resten så summan blir exakt. Tillgångskortet visar den bokförda och den planerade avskrivningen per månad, ackumulerad avskrivning och bokfört värde — allt beräknat ur de bokförda raderna, inget lagrat saldo.

**Ändra i efterhand:** benämning och anteckning kan alltid ändras. När den första avskrivningen är bokförd låses **Anskaffningsdatum**, **Anskaffningsvärde**, **Avskrivningsstart** och **Grupp** (de bestämmer vad som redan bokförts). **Nyttjandetid** och **Restvärde** kan ändras även då — ändringen är framåtverkande: det återstående underlaget fördelas jämnt på de återstående månaderna, och inget bokfört rörs. Nyttjandetiden kan inte göras kortare än att det finns minst en månad kvar efter den senast bokförda (*"Nyttjandetiden kan inte vara kortare än de månader som redan bokförts"*). En anläggning utan bokförda avskrivningar kan tas bort med **Ta bort**; numret återanvänds inte.

### Bokför avskrivningar

Kortet **Avskrivningar** överst på registersidan visar **Senast bokförd t.o.m.** med länk till verifikatet. Välj **T.o.m. månad** (förval förra månaden; en månad som inte passerat kan inte väljas) och klicka **Bokför avskrivningar**. Dialogen visar exakt vad som bokförs: per grupp (kostnadskonto / ack-konto, belopp), per anläggning (vilka månader, belopp), verifikatdatumet (månadens sista dag) och totalsumman. **Bokför avskrivningar** i dialogen bokför ett verifikat i serien **AV** med en debetrad per kostnadskonto och en kreditrad per ack-konto, och meddelar *"Avskrivningar bokförda — Verifikat AV-…"*.

Körningen fyller på **alla saknade månader** från varje anläggnings avskrivningsstart t.o.m. vald månad — en ny anläggning som registrerats i efterhand kommer alltså ikapp automatiskt. Månader som ligger i **låsta** perioder bokförs ändå, på verifikatdatumet i den öppna månaden; dialogen markerar dem *hämtas ikapp*. Är perioden för verifikatdatumet själv låst nekas körningen (*"Perioden för det här datumet är låst för bokföring"*) — lås upp månaden under Räkenskapsår. Finns inget att bokföra visas *"Inget att bokföra — alla månader t.o.m. vald månad är redan avskrivna"*. Har ett av gruppens konton avaktiverats i kontoplanen varnar dialogen (*"Ett av gruppens konton är inaktivt i kontoplanen — aktivera kontot eller byt konto på gruppen"*, med konto och grupp) och körningen nekas tills kontot är aktivt igen. Rutinen per månad är: **Bokför avskrivningar → granska → lås perioden** under Räkenskapsår. Listan under kortet visar tidigare körningar med verifikat, belopp och om de är omförda.

### Ångra senaste körning

**Ångra senaste körning** på kortet omför den senaste körningens verifikat — omföringen bokförs i serien AV **på körningens eget datum**, så månaden nettar till noll — och körningens månader blir obokförda igen; nästa körning bokför dem på nytt (med då gällande nyttjandetid och restvärde). Bara den **senaste** körningen kan ångras; behöver flera körningar backas, ångra dem bakifrån en i taget. En körning som hör till en avyttring kan inte ångras, och därmed inte heller någon körning före en avyttring — avyttringen är slutgiltig. Är körningens period låst nekas ångringen tills perioden låsts upp; ett stängt räkenskapsår kan därför aldrig ändras den här vägen.

**Omför** på verifikatkortet är avstängt för registrets AV-verifikat (*"Verifikatet hör till anläggningsregistret — ångra via Anläggningsregistret"*): en omföring utanför registret skulle nolla huvudboken medan registret fortfarande räknar månaderna som bokförda. Verifikatkortet länkar i stället till registret.

### Avyttring

På tillgångskortet, kortet **Avyttring**, klickar du **Avyttra**. Välj **Typ** — **Försäljning** eller **Utrangering** — och **Datum** (inte i framtiden). En försäljning har dessutom **Försäljningspris exkl. moms** och **Mellankonto**. Klicka **Visa kontering** för att se exakt vad som bokförs, och **Bokför avyttring** för att bokföra.

Avyttringen bokar först avskrivning t.o.m. avyttringsmånaden (om det saknas månader — dialogen visar dem), och därefter ett avyttringsverifikat i serien **AV** som tar bort anskaffningsvärdet (kredit på tillgångskontot) och de ackumulerade avskrivningarna (debet på ack-kontot). Vid försäljning debiteras **Mellankontot** med försäljningspriset och mellanskillnaden mot bokfört värde bokförs som **vinst** (kredit på gruppens vinstkonto) eller **förlust** (debet på gruppens förlustkonto). En utrangering bokar hela bokförda värdet som förlust. Tillgången får status **Avyttrad** och kortet länkar till avyttringsverifikatet. Avyttringen kan **inte ångras**; en felaktig avyttring rättas med ett manuellt verifikat och en ny tillgång.

**Mellankontot och kundfakturan.** Försäljningen faktureras till kunden på vanligt sätt, och fakturans intäktsrad ska konteras på **samma konto** som mellankontot — ge den fakturerade artikeln (eller dess artikelgrupp) en [konteringsregel](#konteringsregler) på det kontot. Fakturan krediterar då mellankontot och avyttringsverifikatet debiterar det, så kontot nettar till noll och vinst eller förlust blir kvar på resultatkontona. Förvalet är gruppens vinstkonto (normalt 3973).

**Momsen.** Avyttringsverifikatet räknas aldrig i [momsrapporten](#momsrapport) — bara kundfakturan gör det. För att försäljningens underlag ska hamna i **ruta 05** måste mellankontot ha **Momsruta 05** i [kontoplanen](#kontoplan). Saknar mellankontot ruta 05 visar dialogen varningen *"Mellankontot saknar momsruta 05 — försäljningen kommer inte med i ruta 05 i momsrapporten"*. Observera att **alla** bokningar på kontot då räknas i ruta 05 — även en manuellt bokförd vinst på 3973. Den som vill hålla 3973 rent väljer ett eget mellankonto med ruta 05.

### Avskrivningsplan

**Ekonomi → Avskrivningsplan** visar, per räkenskapsår (välj under **Räkenskapsår**) och grupp, varje anläggnings **IB ansk.**, **Anskaffningar**, **Avyttringar**, **UB ansk.**, **IB ack.**, **Årets avskr.**, **Avskr. avyttrat**, **UB ack.** och **Bokfört värde**, med summor per grupp och en rad **Summa alla grupper**. **Ladda ner PDF** ger rapporten på företagets A4-mall; **Exportera CSV** ger en rad per anläggning med alla kolumner. En avskrivning hör till det datum körningens verifikat har — en körning t.o.m. juni bokförd den 30 juni räknas i juni, en ikappbokning av januari gjord i juni räknas i juni — precis som i huvudboken.

En anläggnings **Ingående avskrivning** (avskrivningar som bokfördes före Nav och ingår i den ingående balansen) visas alltid i kolumnen **IB ack.** (ingående ackumulerad avskrivning), aldrig som årets avskrivning.

Kortet **Avstämning mot huvudboken** jämför, per konto, registrets anskaffningsvärde med tillgångskontots saldo och registrets ackumulerade avskrivningar med ack-kontots saldo per räkenskapsårets sista dag (samma siffror som balansräkningen). Stämmer allt visas *"Registret stämmer mot huvudboken."*; annars en varning per konto: *"Registret stämmer inte mot konto 1220 …: huvudbok …, register … (skillnad …)"*. En skillnad betyder typiskt att ett köp bokförts på tillgångskontot utan att läggas upp i registret (eller tvärtom), att köpet bokförts på fel konto, eller att ett manuellt verifikat rört 12xx-kontona.

## Årsbokslut

**Ekonomi → Bokslut** är guiden som stänger ett räkenskapsår. Välj **Räkenskapsår** överst — förvalt är det äldsta öppna året vars slutdatum har passerat. Finns inget bokslut för året ännu väljer du **Bokslutsdatum** (förval årets sista dag; datumet måste ligga i årets sista månad) och klickar **Starta bokslut**. Bokslutsdatumet kan ändras i kortet **Bokslutsdatum** (**Spara bokslutsdatum**) tills det första steget har bokförts — även avskrivningarna i steg 3 räknas, eftersom deras verifikat dateras på bokslutsdatumet.

Guiden består av sex steg som alla syns samtidigt, och du kan lämna sidan och fortsätta senare. Mellan steg 4 och 5 ligger dessutom kortet **Valutaomvärdering**, som saknar stegnummer eftersom det bara har något att göra när företaget har öppna fakturor i annan valuta — se [Valutaomvärdering](#valutaomvardering). Varje steg har en status: **Klar**, **Ej gjord**, **Inaktuell** (bokföringen har ändrats efter steget — gör om det) eller **Spärrad** (en kontroll i steg 1 hindrar bokföring). Alla bokslutsverifikat bokförs i serien **BS** (Bokslut) och dateras på bokslutsdatumet. Ett steg kan göras om hur många gånger som helst innan året stängs: blir resultatet detsamma bokförs ingenting, annars omförs det förra stegverifikatet och ett nytt bokförs. Listan **Bokslutsverifikat** längst ned visar allt guiden har bokfört.

### Kontroller

Steg 1 visar spärrar och varningar. **Spärrar** hindrar stegen 2–5: verifikatutkast i året (bokför eller ta bort dem — de första 20 listas som länkar), att föregående räkenskapsår inte är stängt, att bokslutsmånaden är låst (knappen **Lås upp period** öppnar den vanliga upplåsningen med motivering) och att bokslutsdagen inte har passerat. **Varningar** hindrar inget men ska granskas:

- Momsen är inte omförd för alla månader. Omför momsen för december (och övriga månader) *innan* året stängs — efteråt kan den inte bokföras i året.
- Kund- eller leverantörsreskontran stämmer inte mot kundfordrings- respektive leverantörsskuldkontot per räkenskapsårets sista dag (även när bokslutsdatumet ligger tidigare). Vanliga orsaker: ett manuellt verifikat på kontot, ett standardkonto som bytts under året, eller fakturor från innan automatkonteringen. Den bokförda [valutaomvärderingen](#valutaomvardering) räknas med — huvudboken förväntas vara reskontran plus omvärderingen, och meddelandet anger i så fall båda beloppen.
- Anläggningsregistret stämmer inte mot tillgångskontona (samma avstämning som i [Avskrivningsplan](#avskrivningsplan)).
- Bankkontot är inte avstämt t.o.m. bokslutsdagen. Stäm av och markera kontot som avstämt under [Bankavstämning](#bankavstamning) innan året stängs — varningen hindrar inget, men en avstämning är det som visar att bokföringens saldo på bankkontot stämmer med bankens.
- Intäkter på konton utan momsruta.
- Lagerkontots saldo stämmer inte med den bokförda lagervärderingen.
- De öppna valutaposterna har ändrats sedan valutaomvärderingen bokfördes — gör om steget [Valutaomvärdering](#valutaomvardering).

### Lagerförändring

Steg 2 värderar lagret per bokslutsdatumet med vald **Värderingsmetod** (**Standardpris**, **Senaste inköp** eller **Vägt snitt**; förvalt är metoden från förra årets bokslut, annars **Vägt snitt**). **Visa lagervärdering** visar lagervärdet, saldot på lagerkontot, skillnaden och exakt den kontering som bokförs. **Bokför lagerförändring** bokför skillnaden mellan lagervärdet och kontot **Lager** mot **Lagerförändring** (se [Standardkonton](#standardkonton)). Artiklar utan pris räknas som 0 och visas som en varning. Har företaget inget lager — lagervärdet och saldot på **Lager** är båda 0 — blir steget **Klar** utan verifikat, även om kontona **Lager** och **Lagerförändring** saknas i kontoplanen.

Lagret värderas som det var registrerat vid bokslutsdagens slut — inventera och rapportera alla lagerrörelser före årsskiftet. Inkurans och pågående tillverkning bokförs med ett eget manuellt verifikat på egna konton (t.ex. 1469 eller 1440); bokför du på själva lagerkontot efter steget blir steget **Inaktuell** och en omkörning rättar kontot mot lagervärderingen.

Lagervärdet beror på lagerloggen per bokslutsdatumet: sätter du i efterhand ett standardpris på en artikel som tidigare saknade pris kan värdet ändras — kör i så fall om steget (**Bokför lagerförändring** igen) så rättas bokföringen.

### Avskrivningar i bokslutet

Steg 3 kör anläggningsregistrets avskrivningar t.o.m. bokslutsmånaden, daterade på bokslutsdatumet, i registrets serie **AV**. **Visa avskrivningar** visar vad som saknas och **Bokför avskrivningar** bokför det. Är allt redan bokfört står steget som **Klar**. En avskrivningskörning ångras i [Anläggningsregistret](#angra-senaste-korning).

### Periodiseringar

Steg 4 bokför upplupna och förutbetalda kostnader och intäkter. Lägg till en rad per post med **Lägg till rad**: **Typ** (**Förutbetald kostnad**, **Upplupen intäkt**, **Upplupen kostnad** eller **Förutbetald intäkt**), **Balanskonto** (förval 1790 respektive 2990), **Resultatkonto**, **Belopp** och **Text**. Konteringen visas under raderna. **Bokför periodiseringar** bokför alla rader i ett verifikat på bokslutsdatumet och **återför dem automatiskt** med ett spegelvänt verifikat på nästa räkenskapsårs första dag. Finns inget nästa räkenskapsår skapas det. Är första perioden i nästa räkenskapsår låst visar steget en varning — återföringen kan inte bokföras förrän perioden låsts upp under [Räkenskapsår och perioder](#rakenskapsar-och-perioder). Har året inga periodiseringar klickar du **Inga periodiseringar**. Ändrar du raderna och bokför igen omförs både periodiseringen och återföringen innan de nya bokförs. Periodiseringar påverkar inte momsrapporten. En identisk omkörning vägras om ett av kontona i de bokförda raderna har inaktiverats sedan dess — aktivera kontot igen, eller ändra raderna.

### Valutaomvärdering

Kortet **Valutaomvärdering** (mellan steg 4 och 5, utan stegnummer) värderar om **öppna kund- och leverantörsfakturor i annan valuta än SEK** till **balansdagens kurs**. En faktura i EUR är bokförd i kronor med den kurs den hade när den utfärdades eller godkändes; vid bokslutet ska fordran respektive skulden stå i kronor till kursen på bokslutsdagen, och skillnaden bokförs som **Kursvinst** eller **Kursförlust**. Posterna räknas per bokslutsdagen — registrerar du i efterhand en faktura eller betalning som är daterad före bokslutsdagen blir steget **Inaktuell** och ska göras om.

Kortet visar en rad per valuta med fältet **Kurs** (kronor per 1 enhet av valutan) och dess **Källa**. Kursen väljs i den här ordningen:

1. en kurs du själv skriver i fältet **Kurs** — den visas som *Skriven i steget*, gäller bara bokslutet och sparas inte under [Valutakurser](#valutakurser). **Återställ** tar bort din kurs igen;
2. annars **den bokade kursen**, när steget redan är bokfört, så att en omkörning inte tyst byter en kurs du skrev förra gången;
3. annars Navs kurs för bokslutsdatumet enligt [Så hittar Nav en kurs](#valutakurser) — Riksbankens kurs för senaste bankdag före eller på bokslutsdagen (*Riksbanken 2026-12-30*, med texten **Källa: Sveriges Riksbank**) eller en egen kurs i Valutakurser (*egen kurs i Valutakurser*).

Saknas kurs för en valuta visar kortet att kursen saknas och **Bokför valutaomvärdering** är avstängd tills du skrivit kursen.

Under kurserna visas en sammanställning per sida och valuta: **Konto** (Kundfordringar respektive Leverantörsskulder), **Valuta**, **Fakturor**, **Öppet belopp** (i valutan), **Bokfört (SEK)**, **Omvärderat (SEK)**, **Differens (SEK)** och **Resultateffekt** (*Kursvinst* eller *Kursförlust*). Differensen räknas per faktura till öret (öppet belopp × balansdagens kurs minus det SEK-värde fakturan är bokförd till) och summeras sedan per valuta. En växande kundfordran är en kursvinst och en växande leverantörsskuld en kursförlust. **Effekt på årets resultat** summerar kund- och leverantörssidan. Ändrar du en kurs räknas summorna och konteringen om efter en kort stund. Raden **Fakturor som omvärderas** fäller ut varje faktura med länk till fakturan, bokfört värde, kurs och differens — den räknas om direkt när du ändrar kursen.

**Bokför valutaomvärdering** bokför ett verifikat i serien **BS** på bokslutsdatumet. Kundfordringar och Leverantörsskulder (standardkontona, förval 1510 och 2440) tar vardera sin sidas nettodifferens, och resultatsidan bokförs **per valuta**: en valuta med vinst går till **Kursvinst** (förval 3960) och en med förlust till **Kursförlust** (förval 7960), så en EUR-vinst nettas aldrig mot en USD-förlust. Verifikatet **återförs automatiskt** med ett spegelvänt verifikat på nästa räkenskapsårs första dag — kortet visar båda som länkar — så att den bokförda fordran och skulden står till sina ursprungliga värden när fakturorna betalas nästa år. Finns inget nästa räkenskapsår skapas det, och är dess första period låst visar kortet en varning: återföringen kan inte bokföras förrän perioden låsts upp under [Räkenskapsår och perioder](#rakenskapsar-och-perioder). Efter bokningen visas **Bokförda kurser**.

Ändrar du en kurs, eller har de öppna valutaposterna ändrats, och klickar **Bokför igen** omförs både valutaomvärderingen och återföringen (efter en bekräftelse) innan de nya bokförs; blir resultatet detsamma bokförs inget nytt. Verifikaten ägs av guiden: de kan inte omföras för hand på verifikatkortet, steget görs om här.

Steget **spärrar stängningen**: finns öppna valutaposter och steget inte är gjort står *Valutaomvärderingen är inte gjord* som spärr i steg 6, och [Resultatöverföring](#resultatoverforing) kan inte bokföras före steget — årets resultat ändras ju av omvärderingen. Avstämningen av kund- och leverantörsreskontran i [Kontroller](#kontroller) räknar med den bokförda omvärderingen. Har företaget inga öppna fakturor i annan valuta visar kortet **Inga valutaposter**; steget spärrar då ingenting, men **Markera som klar** låter dig kvittera det så att guiden ser komplett ut.

### Resultatöverföring

Steg 5 visar årets resultat (kontoklass 3–8) och bokför det mot eget kapital med **Bokför resultatöverföring**: en vinst bokförs som debet 8999 och kredit 2099, en förlust tvärtom. Stegen 2–4 måste vara gjorda först, liksom [Valutaomvärdering](#valutaomvardering) när det finns öppna fakturor i annan valuta. Efter överföringen visar balansräkningen **Årets resultat** 0,00 och resultatet på 2099, och resultaträkningen visar överföringen på raden **Årets resultat (bokfört)**. Bokförs något i året efteråt blir steget **Inaktuell** — gör om det. Är resultatet 0,00 står steget som **Klar** utan verifikat. Saknas konto 8999 eller 2099 i kontoplanen (eller är något av dem inaktivt) visar steget en hänvisning till [Kontoplan](#kontoplan) i stället för konteringen — lägg upp kontona där, t.ex. med **Förifyll BAS-urval**.

### Stäng året

Steg 6 visar de spärrar som återstår (bland annat att resultatöverföringen inte är gjord, och att [Valutaomvärdering](#valutaomvardering) inte är gjord när det finns öppna valutaposter), varningarna och en avstämning av nästa års ingående balanser mot årets utgående. Den kan bara skilja om ingående balanser har importerats till nästa år via SIE — omför i så fall det importerade verifikatet först. Avstämningen läser bara serien **I** i nästa år. Skulle omföringen hamna i ett senare år (bokslutet görs sent), ändrar du omföringsutkastets datum till ett datum i nästa räkenskapsår innan du bokför det — eller rättar ingående balansen med ett manuellt verifikat i serien **I** i nästa år. En rättelse i en annan serie tar inte bort spärren. Året kan stängas tidigast dagen efter räkenskapsårets sista dag, även om bokslutsdatumet ligger tidigare. Finns varningar kryssar du i **Jag har granskat varningarna**. **Stäng räkenskapsåret** låser alla perioder och markerar året som stängt. Därefter kan inga verifikat bokföras i året — inte heller från ett skript eller direkt i databasen — och perioderna kan inte låsas upp.

### Öppna året igen

På ett stängt år finns **Öppna året igen**, som kräver en **Motivering**. Resultatöverföringen omförs och bokslutsmånaden låses upp; övriga månader förblir låsta och kan låsas upp en i taget under [Räkenskapsår och perioder](#rakenskapsar-och-perioder). Lagerförändring, avskrivningar, periodiseringar och valutaomvärdering ligger kvar. Året kan inte öppnas om nästa räkenskapsår är stängt eller om en vinstdisposition är bokförd — ångra den först (så länge dispositionen är bokförd är **Öppna året igen** avstängd). Händelsen loggas i händelseloggen.

### Vinstdisposition

På ett stängt år bokför du årsstämmans beslut: ange **Stämmodatum** (efter räkenskapsårets slut, i ett öppet räkenskapsår) och eventuell **Utdelning (kr)**, klicka **Visa kontering** och sedan **Bokför vinstdisposition**. Saldot på 2099 flyttas till 2091 Balanserad vinst eller förlust, och utdelningen bokförs på 2898 Outtagen vinstutdelning. Överstiger utdelningen det fria egna kapitalet visas en varning. Utbetalningen av utdelningen bokförs som ett vanligt verifikat. **Ångra** omför dispositionen på stämmodatumet.

## Automatkontering

Kund- och leverantörsfakturor bokförs automatiskt — du behöver aldrig knappa in ett verifikat för hand för dem. Detsamma gäller kund- och leverantörsreskontrans betalningar, kundens betalningspåminnelser och momsrapportens momsomföring. Verifikaten hamnar i egna serier som skapas automatiskt första gången de behövs (ingen separat uppsättning krävs):

- **F** (Kundfakturor) — bokförs när en faktura **utfärdas**. Se [Bokföring av fakturan](/hjalp/forsaljning#bokforing-av-fakturan) i kapitlet Försäljning för hela konteringen, kreditfaktura och vad som händer om bokföringen inte går att genomföra. En faktura i utländsk valuta bokförs i SEK med sin kurs, se [Faktura i utländsk valuta](/hjalp/forsaljning#faktura-i-utlandsk-valuta).
- **L** (Leverantörsfakturor) — bokförs när en leverantörsfaktura **godkänns**, och en **omföring** bokförs i samma serie när en godkänd faktura **avbryts**. En faktura i utländsk valuta bokförs i SEK med sin kurs. Se [Bokföring av leverantörsfakturan](/hjalp/inkop#bokforing-av-leverantorsfakturan) i kapitlet Inköp.
- **K** (Kundreskontra) — bokförs när en **betalning registreras** (bankbeloppet mot betalkontot, kundfordran mot det som stängs, mellanskillnaden mot öres-/kronutjämning vid en avskrivning inom toleransen), när en **betalningspåminnelse** skickas med avgift ikryssad (avgiften mot kundfordran respektive kontot för påminnelseavgifter) och som en **omföring** när en betalning **makuleras**. En betalning i utländsk valuta bokför dessutom bankavgiften (**Bankkostnader**) och skillnaden mot fordrans bokförda värde som **Kursvinst** eller **Kursförlust**, se [Betalning i utländsk valuta](/hjalp/forsaljning#betalning-i-utlandsk-valuta). En ren kvittning mellan en fakturas och en kreditfakturas öppna poster flyttar inget saldo och bokför därför inget verifikat — se [Kvittning av kreditfaktura](/hjalp/forsaljning#registrera-betalning) i kapitlet Försäljning.
- **U** (Leverantörsreskontra) — bokförs när en **utbetalning registreras** i leverantörsreskontran (bankbeloppet mot betalkontot, leverantörsskulden mot det som stängs, mellanskillnaden mot öres-/kronutjämning vid en avskrivning inom toleransen), och som en **omföring** när en betalning **makuleras**. Delar betalkontots standardvärde och betalningstoleransen med kundreskontran. En utbetalning i utländsk valuta bokför dessutom bankavgiften (**Bankkostnader**) och skillnaden mot skuldens bokförda värde som **Kursvinst** eller **Kursförlust**. Se [Leverantörsreskontra](/hjalp/inkop#leverantorsreskontra) i kapitlet Inköp för hela flödet, inklusive kvittning mot leverantörens kreditfaktura och [Utbetalning i utländsk valuta](/hjalp/inkop#utbetalning-i-utlandsk-valuta).
- **M** (Momsredovisning) — bokförs när momsrapportens **momsomföring** bokförs, se [Momsrapport](#momsrapport) ovan.
- **IM** (Importmoms) — bokförs när du **bokför importmoms** på ett tullbeslut, se [Importmoms](#importmoms).
- **AV** (Anläggningar) — avskrivningskörningar, deras omföringar (**Ångra senaste körning**) och avyttringsverifikat från [Anläggningsregistret](#anlaggningsregister).

Serierna skapas bara om de saknas. Finns redan en verifikatserie med koden **F**, **L**, **K**, **U**, **M**, **IM**, **AV** eller **BS** — t.ex. en du lagt upp själv för något annat — återanvänder automatkonteringen den serien utan att säga till, och fakturaverifikaten hamnar alltså i din befintliga serie. Vill du hålla dem åtskilda, använd andra koder än F, L, K, U, M, IM, AV och BS för egna serier.

Fakturanumret/attesten/BET-numret/UTB-numret och verifikatet skapas i ett och samma steg — antingen blir båda av, eller ingetdera. På respektive faktura-/betalningskort visas en länk till verifikatet (**Verifikat F-…** / **Verifikat L-…** / **Verifikat K-…** / **Verifikat U-…**), synlig bara för den som kan öppna Ekonomi.

Kostnadsställe och projekt följer med automatkonteringen: en kundfakturas intäktsrad och en leverantörsfakturas kostnadsrad bokförs med radens kostnadsställe och projekt, se [Kostnadsställen och projekt](#kostnadsstallen-och-projekt). Kräver kontot kostnadsställe men raden saknar det bokas verifikatet ändå — en faktura får aldrig stoppas av det — och en varning visas på verifikatet och i [Aviseringar](/hjalp/aviseringar).

**Vilket konto en rad bokförs mot avgörs i den här ordningen:**

1. En **konteringsregel** för radens artikelgrupp och exakta [momskod](#momskoder).
2. Annars en konteringsregel för artikelgruppen med momskod **"Alla momskoder"** (en katalog-regel som gäller oavsett moms) — men bara för svensk moms, momsfritt och *Inköp varor utanför EU*. En katalog-regel som skickar en artikelgrupp till ett konto med ruta 05 får inte tyst ta en EU-försäljning, som ska till ruta 35.
3. Annars kontot på **momskoden** — intäktskontot för en försäljning, kostnadskontot för ett inköp med omvänd moms — och för en kostnad med svensk moms eller momsfritt standardkontot **Kostnad, standard**.

Momskoden avgör också momsen: utgående moms bokförs på kodens konto för utgående moms, och vid **omvänd moms** på ett inköp (t.ex. **IEUV25**) beräknas momsen på leverantörsfakturan och bokförs både som utgående och ingående moms. Regler, standardkonton och momskoder läggs upp under [Konteringsregler](#konteringsregler) och [Momskoder](#momskoder). Rader utan artikelgrupp (t.ex. artiklar utan grupp, eller fria rader utan artikel på en leverantörsfaktura) hoppar direkt till kontot på momskoden respektive standardkontot.

## Konteringsregler

**Ekonomi → Konteringsregler** styr automatkonteringen: dels **standardkontona** som gäller när ingen regel matchar, dels **konteringsreglerna** som styr enskilda artikelgrupper. Allt på sidan — standardkontona, beloppen under **Kundreskontra**, inställningarna för dröjsmålsränta och reglerna — kan ändras av alla med rättigheten **Ekonomi**; övriga inställningar under **System → Inställningar** är fortfarande bara för administratörer.

### Standardkonton

Sektionen **Standardkonton** listar de tolv konton automatkonteringen faller tillbaka på: **Kundfordringar**, **Leverantörsskulder**, **Kostnad, standard**, **Bank/betalkonto**, **Påminnelseavgifter**, **Öres- och kronutjämning** och **Redovisningskonto för moms** (momsomföringens motkonto, standard 2650), bokslutets två konton **Lager** och **Lagerförändring** (se nedan) samt valutakontona **Kursvinst**, **Kursförlust** och **Bankkostnader** (se nedan). **Intäktskontona och momskontona** (utgående och ingående moms) ligger inte här längre utan på [momskoderna](#momskoder) — en länk till **Momskoder** står under rubriken. De värden som tidigare låg i standardkontona flyttades till momskoderna **MP25**, **MP12**, **MP6** och **MF** när funktionen infördes. Varje fält är en lista över aktiva konton i formatet **"1510 Kundfordringar"**; det förvalda värdet är kontot som gäller just nu (eget val eller BAS-standard). Välj **"Återställ till standard (…)"** överst i listan för att ta bort ett eget val och gå tillbaka till standardkontot. Klicka **Spara** — bara de fält du faktiskt ändrat skickas.

**Öres- och kronutjämning** måste vara ett eget konto, skilt från **Kundfordringar** och **Leverantörsskulder** — pekar det på något av dem nekar betalningsregistreringen (kundreskontran respektive leverantörsreskontran) med ett konfliktfel, eftersom kontot då skulle både öppna och stänga samma post i en och samma bokning.

**Lager** (förval 1460) och **Lagerförändring** (förval 4990) används av bokslutets steg *Lagerförändring* (se [Årsbokslut](#arsbokslut)): skillnaden mellan lagervärdet och saldot på **Lager** bokförs mot **Lagerförändring**. Ett tillverkande företag byter ofta **Lager** till t.ex. 1410 eller 1450. De två fälten får inte vara samma konto.

**Kursvinst** (förval 3960), **Kursförlust** (förval 7960) och **Bankkostnader** (förval 6570) används när en betalning i utländsk valuta bokförs — en utbetalning till en leverantör eller en inbetalning från en kund, se [Valutakurser](#valutakurser): skillnaden mellan kronorna på bankkontot och kronorna skulden respektive fordran bokades till bokförs på **Kursvinst** eller **Kursförlust**, och bankens avgift på **Bankkostnader**. De tre kontona läggs in i en befintlig kontoplan när funktionen tas i bruk; **Förifyll BAS-urval** lägger in dem i en ny. Kontona får inte vara samma konto som **Kundfordringar** eller **Leverantörsskulder**. **Kursvinst** och **Kursförlust** används också av bokslutets [Valutaomvärdering](#valutaomvardering).

### Kundreskontra

Sektionen **Kundreskontra** styr två belopp: **Betalningstolerans (kr)** — hur mycket en kundbetalning får avvika från fakturans resterande belopp och ändå räknas som fullt betald — och **Påminnelseavgift (kr)** — avgiften som läggs på en betalningspåminnelse. Betalningstoleransen gäller även leverantörsreskontrans utbetalningar. På en faktura i utländsk valuta räknas toleransen om till fakturans valuta med fakturans kurs — 5 kr vid kursen 11,13 är 0,44 EUR (avrundat nedåt, så avskrivningen aldrig överstiger inställningen). Till skillnad från standardkontona ovan har fälten inget "Återställ till standard": ett belopp måste alltid anges (0 eller större). Klicka **Spara** — bara de fält du faktiskt ändrat skickas.

### Dröjsmålsränta och förseningsersättning

Sektionen **Dröjsmålsränta och förseningsersättning** styr [Räntefakturering](/hjalp/forsaljning#rantefakturering). Den har kryssrutorna **Debitera dröjsmålsränta** och **Debitera förseningsersättning** (båda av från början), **Räntemarginal (procentenheter)** (förvalt 8,00 — räntelagen 6 §), **Minsta räntebelopp** (förvalt 100 kr, gäller räntan per räntefaktura) och kontona **Dröjsmålsränta** (förval 8313 Ränteintäkter från kortfristiga fordringar) och **Förseningsersättning** (förval 3990). Kontona väljs som standardkontona ovan, med **Återställ till standard** överst i listan. **Debitera dröjsmålsränta** måste vara på för att Räntefakturering ska öppnas, och då skriver fakturornas PDF att dröjsmålsränta debiteras vid betalning efter förfallodagen. Är **Debitera förseningsersättning** av erbjuder Räntefakturering bara ränta. Procentsatsen och beloppen anges med två decimaler. Klicka **Spara** — bara de fält du faktiskt ändrat skickas.

### Regler per artikelgrupp

Sektionen **Konteringsregler** listar reglerna i en tabell: **Artikelgrupp**, **Momskod**, **Intäktskonto** och **Kostnadskonto**. Under varje konto står kontots momsruta i kontoplanen, och en regel vars konto har fel momsruta får en varning med länk till kontot — samma kontroll som [Momsrapport](#momsrapport) gör: ruta 05 för intäktskontot i en regel för **Moms 25 %**, **Moms 12 %** eller **Moms 6 %** (ruta 42 för **Momsfri**, ruta 05 eller 42 för **Alla momskoder**), kodens egen ruta för utrikes- och omvända koder, och ingen av inköpsrutorna 20–24, 37 eller 50 på kostnadskontot i en regel för svensk moms, **Inköp varor utanför EU** eller **Alla momskoder**. **+ Ny regel** öppnar ett formulär med:

- **Artikelgrupp** — obligatorisk.
- **Momskod** — **Alla momskoder** (katalog-regeln, se ovan) eller en av koderna, grupperade som *Svensk moms och momsfritt*, *Försäljning till utlandet och omvänd betalningsskyldighet* och *Inköp från utlandet och omvänd moms*. Importmomskoderna kan inte väljas — importmomsen har ingen artikelgrupp. Listan visar de aktiva koderna; en regel vars kod har inaktiverats behåller den i listan, märkt **(inaktiv)**, och gäller som vanligt. **Alla momskoder** gäller bara svensk moms, momsfritt och *Inköp varor utanför EU*: utrikes- och omvända koder (t.ex. **Varor till annat EU-land**) tar kodens eget konto om det inte finns en regel för exakt den koden.
- **Intäktskonto** och **Kostnadskonto** — samma kontoformat som standardkontona, tom lista visas som **"—"**. Minst ett av de två måste anges — en regel kan styra bara intäkt, bara kostnad, eller båda. Vill du ha ett eget intäktskonto för EU-försäljning av en artikelgrupp lägger du en regel för exakt **EUV**; kontot bör ha ruta 35, annars varnar [momsrapporten](#momsrapport).

En kombination av artikelgrupp och momskod kan bara ha **en** regel — försöker du lägga upp en till för samma kombination avvisas det. Regler som fanns innan momskoderna infördes är flyttade: momssats 25 % blev **Moms 25 %**, 12 % blev **Moms 12 %**, 6 % blev **Moms 6 %**, 0 % blev **Momsfri** och **Alla satser** blev **Alla momskoder**. Klicka **Ändra** på en rad för att redigera regeln, eller **Ta bort** för att radera den (bekräftas innan den tas bort).
