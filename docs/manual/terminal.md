# Stämpelterminalen

**Tillverkning → Stämpelterminal** i Nav|ERP är en helskärmsvy avsedd för en delad skärm i verkstaden. Terminalen körs under en vanlig inloggad session; personalen identifierar sig per åtgärd med sitt anställningsnummer.

## Identifiera dig

Knappa in ditt **anställningsnummer** på sifferknappsatsen och tryck Enter/OK. En streckkodsläsare som "skriver" numret + Enter fungerar också. Därefter visas din hemvy med närvarostatus, dagens schema och dina pågående stämplingar.

## Närvaro (kom/gå)

- **Stämpla in närvaro** när du kommer — tiden registreras och du visas som närvarande.
- **Gå hem** när du går för dagen. Är du fortfarande instämplad på arbeten **pausas de** — du är kvar instämplad, men tiden du är borta räknas inte in i rapporterad tid eller efterkalkyler. Arbetena återupptas automatiskt när du stämplar in närvaron nästa gång, och visas som **Pausad** i terminalen under tiden.
- Stämplar du in på arbete utan att ha stämplat in närvaron stämplas närvaron in samtidigt ("Närvaron stämplades in") — och pausade arbeten återupptas precis som vid **Stämpla in närvaro**.
- Har du glömt **Gå hem** frågar terminalen nästa gång du knappar in ditt nummer: "Du stämplade aldrig ut tisdag 14 oktober. När gick du hem?" Tiden är förifylld med den dagens schemaslut (tom om du inte hade schema). **Spara och stämpla in** stänger den gamla närvaron vid den tiden — arbetena räknas som pausade därifrån — och stämplar in dig för idag, så arbetena fortsätter nu. Har du jobbat över midnatt och går hem nu, tryck **Gå hem nu** i stället. **Avbryt** går tillbaka till sifferknappsatsen.

Närvarostämplingarna är underlaget för framtida löneunderlag och jämförs mot ditt schema (se [Personal & tid](/hjalp/personal-tid)).

## Anledning och övertid

Är inställningarna **Kräv anledning vid sen ankomst och tidig hemgång** och **Fråga om övertidsersättning i terminalen** påslagna (administratören ställer in dem under **System → Inställningar → Lön & PAXml**) kan terminalen ställa en eller två frågor innan stämplingen sparas. Vyn visar bara det servern ber om — terminalen räknar inget själv.

- **Sen ankomst.** Stämplar du in närvaron senare än schemats start, med mer än inställningen **Marginal (minuter)**, visas till exempel "Du kom in 12 minuter efter schemat (07:00)". Samma fråga kommer när du stämplar in direkt på ett arbete utan att ha stämplat in närvaron. Den gäller bara den första instämplingen under schemats tider: kommer du tillbaka efter en tidig hemgång behövs ingen ny anledning, medan ett nattpass som slutade före schemats start inte räknas. Stämplar du in först efter schemats slut ställs ingen fråga. Dagar utan schema och röda dagar ger ingen fråga.
- **Tidig hemgång.** Trycker du **Gå hem** mer än marginalen före schemats slut visas till exempel "Du går 40 minuter före schemat (16:00)". Ett pass som slutar innan schemat har börjat, och en närvaro som har stått öppen sedan en tidigare dag (till exempel när du arbetat över midnatt), ger ingen fråga.
- **Övertid.** Ger dagen övertid enligt lönens regel när du trycker **Gå hem** visas "Du har arbetat 45 minuter övertid i dag" med valen **Övertid utbetald** och **Övertid sparad**. Det val som gäller för dagen är förvalt (annars ditt eget förval från personalkortet). Valet gäller precis som när arbetsledaren ändrar **Övertid ersätts som** i Attesteringen. Har du inget schema räknas all arbetad tid som övertid enligt lönens regel, så då kommer frågan vid varje **Gå hem**.

Välj en av anledningarna (stora knappar) och skriv vid behov en **Kommentar (valfritt)**, välj övertidsval om det frågas, och tryck **Spara och stämpla in** eller **Spara och gå hem** — knappen är grå tills en anledning är vald. **Avbryt** stämplar ingenting — utom efter ett ATF-uttag, se nedan.

**Ta ut ATF** kräver ingen anledning — ett ATF-uttag samma dag förklarar att du går tidigt, även om uttaget registrerades tidigare — men övertidsfrågan kan komma ändå. Eftersom uttaget redan är registrerat när frågan visas stämplas närvaron ut även om du trycker **Avbryt** eller lämnar terminalen: då gäller det förvalda övertidsvalet. En tid i en redan låst löneperiod ger ingen fråga. Anledningarna syns för arbetsledaren i Attesteringen (se [Lön](/hjalp/lon#detaljer-och-korrigeringar)).

## Stämpla på order

1. Välj **Stämpla in på arbete** i hemvyn. Vyn **Välj operationer** öppnas direkt — en rad per operation som går att stämpla in på, över alla frisläppta och pågående ordrar. Lego-operationer visas aldrig i terminalen (de köps via inköpsorder och avrapporteras automatiskt vid inleverans, se [Tillverkning](/hjalp/tillverkning#legoresurser)).
2. Avgränsa listan med filtren överst:
   - **Station** — knappen under **Station** visar ditt nuvarande val: **Alla stationer**, eller de valda stationerna (`100 Kap, 200 Svets`; vid fler än två de två första och ett antal, t.ex. `100 Kap, 200 Svets +3`). Dina egna **förvalda stationer** (satta på personalkortet under **Förvalda stationer**) är redan valda när vyn öppnas; har du inga visas alla. Tryck på knappen för att öppna panelen **Station**: bocka i de stationer du vill se (`resursnummer · namn`, i nummerordning; du kan välja flera). **Mina stationer** väljer dina förvalda stationer (knappen visas bara om du har några) och **Alla stationer** tar bort urvalet. Finns det många stationer visas fältet **Sök station** överst i panelen — skriv delar av nummer eller namn, alla ord måste matcha. Tryck **Klar** för att använda valet; Esc eller ett tryck utanför panelen stänger den utan att ändra något.
   - **Material** — välj ett material för att bara se operationer som drar det. Listan innehåller de material som finns bland operationerna för de valda stationerna; **Alla material** tar bort filtret. Bara material som är kopplat till en operation i beredningen räknas.
   - **Planerad vecka** | **Brådskande** | **Material** — sorteringen. **Planerad vecka** är förvald: operationerna kommer i den ordning planeraren lagt dem i [beläggningen](/hjalp/tillverkning#belaggning) — tidigast planerad vecka först, operationer som inte är planerade sist, och inom samma vecka i brådskande ordning. **Brådskande** sorterar på färdigdatum (tidigast först, ordrar utan datum sist; därefter TO-nummer och operationsnummer). **Material** lägger operationer med samma material intill varandra (sorterat på materialets artikelnummer, operationer utan material sist), och inom samma material i brådskande ordning.
   - **Bara redo** — döljer operationer som är **Inte redo**. Delvis redo operationer visas kvar.
   - **Sök** — filtrerar medan du skriver på TO-nummer, artikelnummer och benämning, resurs (nummer eller namn), operationens beskrivning och material. Skriver du flera ord måste alla matcha, t.ex. `510 disk`.
3. Varje rad visar TO-nummer, artikel, operationens sekvensnummer och **Beskrivning** (saknas den visas resursens namn; resursen står kvar på raden) — se [Artiklar](/hjalp/artiklar#beskrivning-pa-operationen) — samt **Planerat** (tillverkningsorderns antal), **Klart** (antal OK som redan rapporterats på operationen), **Kasserat** när något kasserats, och **Kvar** — planerat minus klart. Kasserade enheter minskar alltså inte Kvar, eftersom de måste göras om. Raden visar också **Färdigdatum** (rött när det passerat), **Planerad** med operationens planerade vecka (**v.45**, eller **v.45–47** om den sträcker sig över flera; inget visas för en operation som inte är planerad), de material som operationen drar, och en **Packinstruktion** med en 📦-symbol om operationen har en — se [Artiklar](/hjalp/artiklar#packinstruktion-pa-operationen).
4. Märket på raden visar om materialet från föregående steg finns att arbeta med:
   - **Redo** — operationen kan göras för hela det som återstår. Orderns första operation är alltid redo; för övriga räknas föregående operations OK-antal (även när den ligger på en annan station eller är en lego-operation).
   - **8 av 20 redo** — föregående operation har rapporterat så många att du kan göra 8 av de 20 som återstår.
   - **Inte redo** — föregående operation har ännu inte rapporterat fler OK än den här.

   Märket är en upplysning och spärrar aldrig: du kan alltid stämpla in. Kasserade enheter räknas inte som redo.
5. Kryssa för en eller flera operationer — tryck på raden, inget stämplas in förrän du bekräftar — och tryck **Starta valda** (inaktiv tills minst en är markerad). Du kan välja operationer från flera olika ordrar samtidigt; en anställd kan ha flera samtidiga öppna stämplingar. En operation du redan är instämplad på visas med texten **Du är instämplad** och kan inte väljas. Går någon av stämplingarna inte att genomföra visas vilken/vilka det gäller (`TO-nummer op N`); de som lyckades förblir instämplade och de som misslyckades är fortfarande markerade så du kan försöka igen. Misslyckas hämtningen av listan visas felet med knappen **Försök igen**.
6. Vid **Stämpla ut** väljer du bland dina pågående stämplingar (en rad per öppen stämpling); utstämplingen skapar automatiskt en tidrapport på operationen med den arbetade tiden. Har operationen en **Packinstruktion** visas den överst i en egen ruta, så den syns innan du packar det du just tillverkat. Under den visas rutorna **Planerat**, **Klart**, **Kasserat** (bara när något kasserats) och **Kvar** — samma räkning som i operationslistan, med det som rapporterats före det här passet — så du ser hur många som är kvar att tillverka innan du fyller i antalen. Vid utstämplingen anges också:
   - **Antal OK** — antal godkända enheter gjorda under passet (0 går bra, t.ex. vid paus).
   - **Kasserat** — antal kasserade enheter, med **kassationsorsak** (obligatorisk när kasserat > 0).

   Antalen ackumuleras på operationen, och material som är kopplat till operationen i beredningen dras automatiskt från lagret för **OK + kasserat** — kasserade enheter förbrukar alltså också komponenter. Är operationen orderns **sista** läggs **Antal OK** dessutom in i lager direkt som färdiga varor, och när orderns antal är nått blir ordern **Klar** av sig själv — se [Tillverkning](/hjalp/tillverkning#inleverans-fran-sista-operationen). Kassationerna loggas och visas på tillverkningsorderns detaljsida (se [Tillverkning](/hjalp/tillverkning)). Kryssa i **Operationen är klar** när allt är rapporterat.

   Räcker inte lagersaldot för det material utstämplingen skulle dra kan terminalen, beroende på systeminställningen **Materialbrist vid rapportering**, fråga "Det saknas ingående delar: … Rapportera ändå?" (**Rapportera ändå** stämplar ut och rapporterar; avbryter du står du kvar på utstämplingen och ingenting är sparat) eller neka utstämplingen med "Det finns inte tillräckligt med ingående delar: …". Du är då fortfarande instämplad — be arbetsledaren fylla på lagret. Se [Tillverkning](/hjalp/tillverkning#materialbrist-vid-rapportering).

   Blev en utstämpling fel — fel antal, fel operation eller fel order — ångrar arbetsledaren den med **Ångra** under **Rapporteringar** på tillverkningsorderns detaljsida; antalen, materialet, inleveransen och stämplingens tid backas då i ett svep (se [Tillverkning](/hjalp/tillverkning#rapporteringar-och-angra)).

Att stämpla in på en operation du redan har en öppen stämpling på avvisas — den visas som misslyckad vid **Starta valda** tills du stämplat ut den först. Inställningen **Tillåt flera samtidiga stämplingar** (System → Inställningar) styr bara om knappen **Stämpla in på arbete** visas i hemvyn när du redan har öppna stämplingar sedan tidigare — är den avslagen måste du stämpla ut något innan du kan välja fler operationer.

## Ta ut ATF

1. Välj **Ta ut ATF** i hemvyn.
2. Antalet timmar är förifyllt med dagens schemalagda tid; ändra vid behov (t.ex. `2` eller `8,5`).
3. Bekräfta — uttaget registreras på dagens datum och dras från ditt ATF-saldo, och om du är närvarostämplad stämplas du samtidigt ut ("Din närvarostämpling stämplas ut samtidigt").

ATF-saldot och reglerna hanteras på personalkortet — se [Personal & tid](/hjalp/personal-tid).

## Bra att veta

- Terminalen återgår själv till sifferknappsatsen efter en stunds inaktivitet.
- Hemvyn visar vilka som är närvarostämplade just nu.
