# Stämpelterminalen

**Tillverkning → Stämpelterminal** i Nav|ERP är en helskärmsvy avsedd för en delad skärm i verkstaden. Terminalen körs under en vanlig inloggad session; personalen identifierar sig per åtgärd med sitt anställningsnummer.

## Identifiera dig

Knappa in ditt **anställningsnummer** på sifferknappsatsen och tryck Enter/OK. En streckkodsläsare som "skriver" numret + Enter fungerar också. Därefter visas din hemvy med närvarostatus, dagens schema och dina pågående stämplingar — eller först ett [meddelande till dig](#meddelanden-pa-terminalen), om du har fått ett. Kräver företaget en kod frågar terminalen efter den först, se [Kod efter anställningsnumret](#kod-efter-anstallningsnumret).

## Kod efter anställningsnumret

Är inställningen **Kräv kod i stämpelterminalen** på (System → Inställningar, se [Inställningar](/hjalp/system#installningar)) frågar terminalen efter din egen kod på 4 siffror när du har knappat in anställningsnumret. Ingenting som är ditt — hemvyn, stämplingarna, rapporteringen eller meddelandena till dig — öppnas före koden, så ingen kan stämpla åt dig eller läsa dina meddelanden genom att kunna ditt nummer. Är inställningen av frågar terminalen bara efter numret.

- **Välj en kod.** Första gången har du ingen kod. Terminalen visar **Välj en kod**: knappa in fyra siffror och tryck **OK**, och sedan samma siffror en gång till när det står **Upprepa koden**. Var siffrorna inte lika får du börja om. När koden är vald står det "Koden är vald." och du kommer vidare. Koden väljer du själv, och ingen annan kan se den — inte heller en administratör. Alla kombinationer är tillåtna, men välj hellre något annat än 0000, 1234 eller ditt anställningsnummer.
- **Ange din kod.** Därefter visar terminalen **Ange din kod** varje gång du har knappat in ditt nummer. Siffrorna visas som prickar. **⌫** raderar en siffra, **OK** bekräftar och **Avbryt** går tillbaka till startvyn. Ett vanligt tangentbord fungerar också.
- **Fel kod.** Terminalen säger hur många försök du har kvar. Efter 5 fel i rad spärras koden i 15 minuter, och terminalen säger vilket klockslag du kan försöka igen. En rätt kod nollställer räkningen.
- **Glömd kod.** Be en administratör eller arbetsledare trycka **Nollställ terminalkoden** på ditt personalkort (se [Terminalkoden](/hjalp/lon#terminalkoden)). Då tas koden och en eventuell spärr bort, och nästa gång du knappar in ditt nummer väljer du en ny kod.

Koden gäller för ett besök vid terminalen: när terminalen går tillbaka till startvyn — med **Klar**, efter en stämpling eller efter en minut utan tryck — får nästa person ange nummer och kod på nytt. Står du kvar längre än en kvart i sträck går terminalen tillbaka till startvyn av sig själv, och du knappar in nummer och kod igen. Också kodstegen går tillbaka till startvyn efter en minut utan tryck.

## Meddelanden på terminalen

Kontoret kan skriva till terminalen och till dig som anställd (se [Meddelanden](/hjalp/komma-igang#meddelanden-till-terminaler-och-anstallda)). Meddelanden till terminalen går inte att svara på — prata med den som skrev. Meddelanden till dig själv kan du svara på.

- **Till terminalen.** Ett meddelande till terminalen står överst på startvyn, ovanför sifferknappsatsen, med ämnet, vem som skrev och när. Alla ser det. Det står kvar till det datum avsändaren har valt, eller tills avsändaren tar bort det, och nya meddelanden visas inom en minut.
- **Till dig.** Har du fått ett meddelande visas det direkt när du har knappat in ditt anställningsnummer, före stämplingsvalen: "du har ett nytt meddelande" med ämnet, vem som skrev, när och texten. Tryck **OK, läst** när du har läst — då kommer din hemvy, och avsändaren ser att du har läst. Meddelandet visas inte igen. Går terminalen tillbaka till startvyn innan du har tryckt **OK, läst** visas meddelandet nästa gång du knappar in ditt nummer.
- **Svara.** Under varje meddelande till dig finns knappen **Svara**. Skriv ditt svar och tryck **Skicka** — svaret står i ditt namn hos dem på kontoret, och meddelandet räknas som läst. Har du fler meddelanden visas de igen efteråt, annars kommer din hemvy. **Tillbaka** går tillbaka till meddelandena utan att skicka. Du skriver på tre sätt:
  - **Snabbsvar** — **OK**, **Tack!**, **Jag kommer** och **Ring mig**. Ett tryck fyller i texten, och du kan ändra den innan du trycker **Skicka**.
  - **Skärmtangentbord** — terminalens eget tangentbord med å, ä och ö, siffror, **mellanslag**, backsteg (⌫), skift (⇧) och ny rad (↵). Första bokstaven i en mening blir stor av sig själv.
  - **Enhetens tangentbord** — surfplattans eller telefonens eget tangentbord. Ett fysiskt tangentbord fungerar i båda lägena.

  Växla mellan **Skärmtangentbord** och **Enhetens tangentbord** under textfältet. Valet sparas på terminalen. Så länge du skriver går terminalen inte tillbaka till startvyn; efter en minut utan tryck gör den det, och det du har skrivit skickas inte.

## Närvaro (kom/gå)

- **Stämpla in närvaro** när du kommer — tiden registreras och du visas som närvarande.
- **Gå hem** när du går för dagen. Är du fortfarande instämplad på arbeten **pausas de** — du är kvar instämplad, men tiden du är borta räknas inte in i rapporterad tid eller efterkalkyler. Arbetena återupptas automatiskt när du stämplar in närvaron nästa gång, och visas som **Pausad** i terminalen under tiden.
- Stämplar du in på arbete utan att ha stämplat in närvaron stämplas närvaron in samtidigt ("Närvaron stämplades in") — och pausade arbeten återupptas precis som vid **Stämpla in närvaro**.
- Har du glömt **Gå hem** frågar terminalen nästa gång du knappar in ditt nummer: "Du stämplade aldrig ut tisdag 14 oktober. När gick du hem?" Tiden är förifylld med den dagens schemaslut (tom om du inte hade schema). **Spara och stämpla in** stänger den gamla närvaron vid den tiden — arbetena räknas som pausade därifrån — och stämplar in dig för idag, så arbetena fortsätter nu. Har du jobbat över midnatt och går hem nu, tryck **Gå hem nu** i stället — knappen visas bara när närvaron började i går; är den äldre måste du ange när du gick hem. **Avbryt** går tillbaka till sifferknappsatsen.

Närvarostämplingarna är underlaget för framtida löneunderlag och jämförs mot ditt schema (se [Personal & tid](/hjalp/personal-tid)).

## Anledning och övertid

Är inställningarna **Kräv anledning vid sen ankomst och tidig hemgång** och **Fråga om övertidsersättning i terminalen** påslagna (administratören ställer in dem under **Personal & lön → Lön, PAXml & schema**) kan terminalen ställa en eller två frågor innan stämplingen sparas. Vyn visar bara det servern ber om — terminalen räknar inget själv.

- **Sen ankomst.** Stämplar du in närvaron senare än schemats start, med mer än inställningen **Marginal (minuter)**, visas till exempel "Du kom in 12 minuter efter schemat (07:00)". Samma fråga kommer när du stämplar in direkt på ett arbete utan att ha stämplat in närvaron. Den gäller bara den första instämplingen under schemats tider: kommer du tillbaka efter en tidig hemgång behövs ingen ny anledning, medan ett nattpass som slutade före schemats start inte räknas. Stämplar du in först efter schemats slut ställs ingen fråga. Dagar utan schema och röda dagar ger ingen fråga.
- **Tidig hemgång.** Trycker du **Gå hem** mer än marginalen före schemats slut visas till exempel "Du går 40 minuter före schemat (16:00)". Ett pass som slutar innan schemat har börjat, och en närvaro som har stått öppen sedan en tidigare dag (till exempel när du arbetat över midnatt), ger ingen fråga.
- **Övertid.** Ger dagen övertid enligt lönens regel när du trycker **Gå hem** visas "Du har arbetat 45 minuter övertid i dag" med valen **Övertid utbetald** och **Övertid sparad**. Det val som gäller för dagen är förvalt (annars ditt eget förval från personalkortet). Valet gäller precis som när arbetsledaren ändrar **Övertid ersätts som** i Attesteringen. Har du inget schema räknas all arbetad tid som övertid enligt lönens regel, så då kommer frågan vid varje **Gå hem**.

Välj en av anledningarna (stora knappar) och skriv vid behov en **Kommentar (valfritt)**, välj övertidsval om det frågas, och tryck **Spara och stämpla in** eller **Spara och gå hem** — knappen är grå tills en anledning är vald. **Avbryt** stämplar ingenting — utom efter ett ATF-uttag, se nedan.

**Ta ut ATF** kräver ingen anledning — ett ATF-uttag samma dag förklarar att du går tidigt, även om uttaget registrerades tidigare — men övertidsfrågan kan komma ändå. Eftersom uttaget redan är registrerat när frågan visas stämplas närvaron ut även om du trycker **Avbryt** eller lämnar terminalen: då gäller det förvalda övertidsvalet. En tid i en redan låst löneperiod ger ingen fråga. Anledningarna syns för arbetsledaren i Attesteringen (se [Lön](/hjalp/lon#detaljer-och-korrigeringar)).

## Stämpla på order

1. Välj **Stämpla in på arbete** i hemvyn. Vyn **Välj operationer** öppnas direkt — en rad per operation som går att stämpla in på, över alla frisläppta och pågående ordrar. Lego-operationer visas aldrig i terminalen (de köps via inköpsorder och avrapporteras automatiskt vid inleverans, se [Tillverkning](/hjalp/tillverkning#legoresurser)).
2. Avgränsa listan med filtren överst:
   - **Station** — knappen under **Station** visar ditt nuvarande val: **Alla stationer**, eller de valda stationerna (`100 Kap, 200 Svets`; vid fler än två de två första och ett antal, t.ex. `100 Kap, 200 Svets +3`). Dina egna **förvalda stationer** (satta på personalkortet under **Förvalda stationer**) är redan valda när vyn öppnas; har du inga visas alla. Tryck på knappen för att öppna panelen **Station**: bocka i de stationer du vill se (`resursnummer · namn`, i nummerordning; du kan välja flera). **Mina stationer** väljer dina förvalda stationer (knappen visas bara om du har några) och **Alla stationer** tar bort urvalet. Finns det många stationer visas fältet **Sök station** överst i panelen — skriv delar av nummer eller namn, alla ord måste matcha. Tryck **Klar** för att använda valet; Esc eller ett tryck utanför panelen stänger den utan att ändra något.
   - **Körplan** — knappen visas bredvid **Station** när du valt **en** station och har behörighet att öppna sidan. Den öppnar [Körplan](/hjalp/tillverkning#korplan) för stationen i en ny flik: de kommande arbetena på resursen dag för dag, med möjlighet att skriva ut.
   - **Dagplan** — knappen visas bredvid **Station** när du har behörighet att öppna sidan, oavsett vilka stationer som är valda. Den öppnar [Dagplan](/hjalp/tillverkning#dagplan) i en ny flik: dagens arbeten för alla resurser i körordning.
   - **Material** — välj ett material för att bara se operationer som drar det. Listan innehåller de material som finns bland operationerna för de valda stationerna; **Alla material** tar bort filtret. Bara material som är kopplat till en operation i beredningen räknas.
   - **Planerad dag** | **Brådskande** | **Material** — sorteringen. **Planerad dag** är förvald: operationerna kommer i den ordning planeraren lagt dem i [beläggningen](/hjalp/tillverkning#belaggning) — tidigast planerade startdag först, operationer som inte är planerade sist, och inom samma dag i den ordning planeraren satt med **Upp**/**Ned** i [Körplan](/hjalp/tillverkning#ordningen-inom-dagen), därefter i brådskande ordning. Raden visar *Planerad 12 nov* eller *12–14 nov*. **Brådskande** sorterar på färdigdatum (tidigast först, ordrar utan datum sist; därefter TO-nummer och operationsnummer). **Material** lägger operationer med samma material intill varandra (sorterat på materialets artikelnummer, operationer utan material sist), och inom samma material i brådskande ordning.
   - **Bara redo** — döljer operationer som är **Inte redo**. Delvis redo operationer visas kvar.
   - **Sök** — filtrerar medan du skriver på TO-nummer, artikelnummer och benämning, resurs (nummer eller namn), operationens beskrivning och material. Skriver du flera ord måste alla matcha, t.ex. `510 disk`.
3. Varje rad visar TO-nummer, artikel, operationens sekvensnummer och **Beskrivning** (saknas den visas resursens namn; resursen står kvar på raden) — se [Artiklar](/hjalp/artiklar#beskrivning-pa-operationen) — samt **Planerat** (tillverkningsorderns antal), **Klart** (antal OK som redan rapporterats på operationen), **Kasserat** när något kasserats, och **Kvar** — planerat minus klart. Kasserade enheter minskar alltså inte Kvar, eftersom de måste göras om. Raden visar också **Färdigdatum** (rött när det passerat), **Planerad** med operationens planerade vecka (**v.45**, eller **v.45–47** om den sträcker sig över flera; inget visas för en operation som inte är planerad), de material som operationen drar, och en **Packinstruktion** med en 📦-symbol om operationen har en — se [Artiklar](/hjalp/artiklar#packinstruktion-pa-operationen).
4. Märket på raden visar om materialet från föregående steg finns att arbeta med:
   - **Redo** — operationen kan göras för hela det som återstår. Orderns första operation är alltid redo; för övriga räknas föregående operations OK-antal (även när den ligger på en annan station eller är en lego-operation).
   - **8 av 20 redo** — föregående operation har rapporterat så många att du kan göra 8 av de 20 som återstår.
   - **Inte redo** — föregående operation har ännu inte rapporterat fler OK än den här.

   Märket är en upplysning och spärrar aldrig: du kan alltid stämpla in. Kasserade enheter räknas inte som redo.
5. Kryssa för en eller flera operationer — tryck på raden, inget stämplas in förrän du bekräftar — och tryck **Starta valda** (inaktiv tills minst en är markerad). Knappen startar de markerade operationer som listan visar: har du markerat en rad och sedan dolt den med **Sök** eller **Bara redo** står *N markerade operationer döljs av filtret och startas inte* ovanför knappen, och raden är fortfarande markerad när filtret släpps. Medan stämplingarna pågår går det inte att byta station eller material. Du kan välja operationer från flera olika ordrar samtidigt; en anställd kan ha flera samtidiga öppna stämplingar. En operation du redan är instämplad på visas med texten **Du är instämplad** och kan inte väljas. Går någon av stämplingarna inte att genomföra visas vilken/vilka det gäller (`TO-nummer op N`); de som lyckades förblir instämplade och de som misslyckades är fortfarande markerade så du kan försöka igen. Misslyckas hämtningen av listan visas felet med knappen **Försök igen**.

   Har planeraren flyttat en operation till en annan resurs efter att listan hämtades stämplas du inte in på den: felet säger *En operation har flyttats till en annan resurs — listan är uppdaterad.*, och operationen står nu under den nya resursens station. Tiden du stämplar räknas alltid på den resurs du stämplade in på.
6. Vid **Stämpla ut** väljer du bland dina pågående stämplingar (en rad per öppen stämpling); utstämplingen skapar automatiskt en tidrapport på operationen med den arbetade tiden. Har operationen en **Packinstruktion** visas den överst i en egen ruta, så den syns innan du packar det du just tillverkat. Under den visas rutorna **Planerat**, **Klart**, **Kasserat** (bara när något kasserats) och **Kvar** — samma räkning som i operationslistan, med det som rapporterats före det här passet — så du ser hur många som är kvar att tillverka innan du fyller i antalen. Vid utstämplingen anges också:
   - **Antal OK** — antal godkända enheter gjorda under passet (0 går bra, t.ex. vid paus). Fältet är tomt som standard. Har administratören markerat **Stämpling** under **Rest som förslag i antalsfältet** i [System → Inställningar](/hjalp/system#installningar) fylls det i med **Kvar**; har någon annan en pågående stämpling på samma operation lämnas det tomt och raden "Antal OK är tomt eftersom någon annan också stämplar på operationen." säger varför — Kvar delas då mellan stämplingarna och du fyller i det du själv gjort.
   - **Kasserat** — antal kasserade enheter, med **kassationsorsak** (obligatorisk när kasserat > 0). Finns det [kvalitetsorsaker](/hjalp/kvalitet#kassation-och-orsaker) för kassation väljs en **Orsak** i en lista och fritexten heter i stället **Kommentar (valfritt)**; utan sådana orsaker skrivs orsaken som fritext.

   Antalen ackumuleras på operationen, och material som är kopplat till operationen i beredningen dras automatiskt från lagret för **OK + kasserat** — kasserade enheter förbrukar alltså också komponenter. Är operationen orderns **sista** läggs **Antal OK** dessutom in i lager direkt som färdiga varor, och när orderns antal är nått blir ordern **Klar** av sig själv — se [Tillverkning](/hjalp/tillverkning#inleverans-fran-sista-operationen). Kassationerna loggas och visas på tillverkningsorderns detaljsida (se [Tillverkning](/hjalp/tillverkning)). Kryssa i **Operationen är klar** när allt är rapporterat.

   Räcker inte lagersaldot för det material utstämplingen skulle dra kan terminalen, beroende på systeminställningen **Materialbrist vid rapportering**, fråga "Det saknas ingående delar: … Rapportera ändå?" (**Rapportera ändå** stämplar ut och rapporterar; avbryter du står du kvar på utstämplingen och ingenting är sparat) eller neka utstämplingen med "Det finns inte tillräckligt med ingående delar: …". Du är då fortfarande instämplad — be arbetsledaren fylla på lagret. Se [Tillverkning](/hjalp/tillverkning#materialbrist-vid-rapportering).

   **Arbetsorder och ritning:** under varje pågående stämpling i hemvyn och i utstämplingen finns knappen **Skriv ut arbetsorder** (med en skrivarikon, se [Skriv ut arbetsorder](#skriv-ut-arbetsorder)) och en knapp per ritning, t.ex. **Ritning R-1002-SVETS rev A** (med en dokumentikon) — operationens valda ritningar och filer, eller alla orderns ritningar och artikelns filer när operationen inte har valt något. En fil utan ritning visas med sitt filnamn. Ritningen är den revision ordern byggs efter (se [Tillverkning](/hjalp/tillverkning#ritningar-och-revisioner)) och öppnas i en ny flik, där den kan skrivas ut. Finns ingen ritning visas ingen ritningsknapp.

   Blev en utstämpling fel — fel antal, fel operation eller fel order — ångrar arbetsledaren den med **Ångra** under **Rapporteringar** på tillverkningsorderns detaljsida; antalen, materialet, inleveransen och stämplingens tid backas då i ett svep (se [Tillverkning](/hjalp/tillverkning#rapporteringar-och-angra)).

### Skriv ut arbetsorder

Arbetsordern är tillverkningsordern med ritningarna som extra sidor — samma utskrift som **Skriv ut TO** på tillverkningsordern (se [Tillverkning](/hjalp/tillverkning#skriv-ut-to)). Knappen **Skriv ut arbetsorder** under varje pågående stämpling skriver ut den när du vill. Knappen visar **Skriver ut…** medan utskriften hämtas.

Inställningen **Skriv ut arbetsorder och ritning vid instämpling** (System → Inställningar, se [Inställningar](/hjalp/system#installningar)) avgör om terminalen också skriver ut arbetsordern av sig själv när du trycker **Starta valda** (eller **Starta ställ**/**Starta produktion**):

- **Första operationen** — när någon stämplar in på ordern första gången, oftast på orderns första operation. Arbetsordern följer sedan med godset genom verkstaden.
- **Alla operationer** — första gången någon stämplar in på varje operation.
- **Manuellt** — aldrig av sig själv, bara med knappen. Det är förvalet.

En andra instämpling på samma operation — en kollega, en ny dag eller **Ställ klart** — skriver aldrig ut igen. Startar du flera ordrar med samma **Starta valda** skrivs deras arbetsordrar ut i en enda utskrift, och en order skrivs bara ut en gång även om du startar flera av dess operationer. Utskriften görs efter instämplingen, så en instämpling som misslyckas skriver inte ut något.

Webbläsaren visar sin vanliga utskriftsdialog, där du väljer skrivare och trycker **Skriv ut** (se [Utskrifter](/hjalp/komma-igang#utskrifter)). Ska utskriften gå direkt till skrivaren utan dialog startar du Chrome eller Edge på terminaldatorn med kioskutskrift (flaggan `--kiosk-printing`), eller sätter `print.always_print_silent` till `true` under `about:config` i Firefox; då används datorns standardskrivare. På en iPad, en iPhone, en Android-enhet och i Safari kan terminalen inte skriva ut av sig själv. Där står det *Arbetsordern skrivs inte ut av sig själv på den här enheten — tryck Skriv ut arbetsorder.*, och knappen öppnar PDF:en i en ny flik.

### Ställ och produktion

Är inställningen **Dela tid i ställ och produktion** på (System → Inställningar, se [Inställningar](/hjalp/system#installningar)) frågar terminalen om tiden är ställ eller produktion, utan något extra tryck:

- I stället för **Starta valda** står två knappar i operationslistan, **Starta ställ** och **Starta produktion**. Knappen du trycker på gäller alla markerade operationer, så välj den typ som passar hela satsen — vill du starta ställ på en operation och produktion på en annan gör du två omgångar.
- Pågående stämplingar märks **Ställ** eller **Produktion**, i hemvyn och i **Stämpla ut**.
- En pågående ställstämpling har en knapp **Ställ klart**, både i hemvyn och i vyn **Stämpla ut**. Den stämplar ut ställtiden och stämplar direkt in dig på produktion på samma operation. Ingen mängd rapporteras och inget material dras, och ordern påverkas inte; bara ställtiden blir en tidrapport. Misslyckas instämplingen på produktion — till exempel för att operationen har flyttats till en annan resurs mellan ställ och produktion — står du utstämplad och felet visas — välj operationen igen och tryck **Starta produktion**.
- När du stämplar ut får tidrapporten samma typ som stämplingen (**Ställ** eller **Produktion**). Det gäller också när arbetsledaren stämplar ut dig från **Pågående arbete** och när systemet stämplar ut dig automatiskt.

Typen används bara för analysen: efterkalkylen och [Kalkylutfall](/hjalp/rapporter#kalkylutfall) kan visa verklig ställtid och stycktid var för sig. Terminalen kräver aldrig någon typ, och lönen läses ur närvaron, så den påverkas inte. Är inställningen av fungerar allt som förut, och tid som registrerats tidigare förblir **Ej uppdelad**.

Att stämpla in på en operation du redan har en öppen stämpling på avvisas — den visas som misslyckad vid **Starta valda** tills du stämplat ut den först. Inställningen **Tillåt flera samtidiga stämplingar** (System → Inställningar) styr bara om knappen **Stämpla in på arbete** visas i hemvyn när du redan har öppna stämplingar sedan tidigare — är den avslagen måste du stämpla ut något innan du kan välja fler operationer.

## Ta ut ATF

1. Välj **Ta ut ATF** i hemvyn.
2. **ATF-tid (tt:mm)** är förifylld med dagens schemalagda tid; ändra vid behov (t.ex. `200` för 2:00 eller `830` för 8:30 — kolonet fylls i medan du skriver, och en eller två siffror är minuter).
3. Bekräfta — uttaget registreras på dagens datum och dras från ditt ATF-saldo, och om du är närvarostämplad stämplas du samtidigt ut ("Din närvarostämpling stämplas ut samtidigt").

ATF-saldot och reglerna hanteras på personalkortet — se [Personal & tid](/hjalp/personal-tid).

## Bra att veta

- Terminalen återgår själv till sifferknappsatsen efter en stunds inaktivitet — aldrig mitt i en stämpling som sparas, och en obesvarad fråga om **Rapportera ändå** försvinner då utan att något sparas. Det du skrivit på utstämplingen (antal, kassation, **Operationen är klar**) töms varje gång utstämplingen öppnas, så nästa person aldrig ärver ett halvifyllt formulär.
- Hemvyn visar vilka som är närvarostämplade just nu.
