# Stämpelterminalen

**Tillverkning → Stämpelterminal** är en helskärmsvy avsedd för en delad skärm i verkstaden. Terminalen körs under en vanlig inloggad session; personalen identifierar sig per åtgärd med sitt anställningsnummer.

## Identifiera dig

Knappa in ditt **anställningsnummer** på sifferknappsatsen och tryck Enter/OK. En streckkodsläsare som "skriver" numret + Enter fungerar också. Därefter visas din hemvy med närvarostatus, dagens schema och dina pågående stämplingar.

## Närvaro (kom/gå)

- **Stämpla in närvaro** när du kommer — tiden registreras och du visas som närvarande.
- **Gå hem** när du går för dagen. Är du fortfarande instämplad på arbeten **pausas de** — du är kvar instämplad, men tiden du är borta räknas inte in i rapporterad tid eller efterkalkyler. Arbetena återupptas automatiskt när du stämplar in närvaron nästa gång, och visas som **Pausad** i terminalen under tiden.
- Stämplar du in på arbete utan att ha stämplat in närvaron stämplas närvaron in samtidigt ("Närvaron stämplades in") — och pausade arbeten återupptas precis som vid **Stämpla in närvaro**.
- Har du glömt **Gå hem** frågar terminalen nästa gång du knappar in ditt nummer: "Du stämplade aldrig ut tisdag 14 oktober. När gick du hem?" Tiden är förifylld med den dagens schemaslut (tom om du inte hade schema). **Spara och stämpla in** stänger den gamla närvaron vid den tiden — arbetena räknas som pausade därifrån — och stämplar in dig för idag, så arbetena fortsätter nu. **Avbryt** går tillbaka till sifferknappsatsen.

Närvarostämplingarna är underlaget för framtida löneunderlag och jämförs mot ditt schema (se [Personal & tid](/hjalp/personal-tid)).

## Stämpla på order

1. Välj **Stämpla in** i hemvyn.
2. Välj order i listan (**Välj order** — frisläppta och pågående ordrar visas, en rad per order med TO-nummer, artikelnummer, benämning, antal och status). Med många ordrar använder du sökfältet **Sök order** ovanför listan: listan filtreras medan du skriver och matchar TO-nummer, artikelnummer, benämning samt **resurs** och **produktionsgrupp** (nummer eller namn). Skriver du flera ord måste alla matcha, t.ex. `510 disk`. Resurs och produktionsgrupp matchar bara operationer som fortfarande går att stämpla in på — en order där arbetet på din resurs redan är klart dyker inte upp. Sökfältet töms när du väljer en order eller går tillbaka. Därefter väljer du en eller flera **operationer**: lego-operationer visas aldrig i terminalen (de köps via inköpsorder och avrapporteras automatiskt vid inleverans, se [Tillverkning](/hjalp/tillverkning#legoresurser)); varje operation har en kryssruta till vänster — tryck på raden för att kryssa för den, inget stämplas in förrän du bekräftar. Varje operation visas med sitt sekvensnummer och sin **Beskrivning** (resursen står kvar på raden under); saknar operationen beskrivning visas resursens namn i stället — se [Artiklar](/hjalp/artiklar#beskrivning-pa-operationen). Under varje operation står också **Planerat** (tillverkningsorderns antal), **Klart** (antal OK som redan rapporterats på operationen), **Kasserat** när något kasserats, och **Kvar** — planerat minus klart. Kasserade enheter minskar alltså inte Kvar, eftersom de måste göras om. Har operationen en **Packinstruktion** visas den under raden med en 📦-symbol — se [Artiklar](/hjalp/artiklar#packinstruktion-pa-operationen).
3. Tryck **Starta valda** (inaktiv tills minst en operation är markerad) för att stämpla in på alla markerade operationer samtidigt — en anställd kan ha flera samtidiga öppna stämplingar, t.ex. på två operationer på samma order. Går någon av dem inte att stämpla in på visas vilken/vilka det gäller; de som lyckades förblir instämplade och de som misslyckades är fortfarande markerade så du kan försöka igen.
4. Vid **Stämpla ut** väljer du bland dina pågående stämplingar (en rad per öppen stämpling); utstämplingen skapar automatiskt en tidrapport på operationen med den arbetade tiden. Har operationen en **Packinstruktion** visas den överst i en egen ruta, så den syns innan du packar det du just tillverkat. Under den visas rutorna **Planerat**, **Klart**, **Kasserat** (bara när något kasserats) och **Kvar** — samma räkning som i operationsvalet, med det som rapporterats före det här passet — så du ser hur många som är kvar att tillverka innan du fyller i antalen. Vid utstämplingen anges också:
   - **Antal OK** — antal godkända enheter gjorda under passet (0 går bra, t.ex. vid paus).
   - **Kasserat** — antal kasserade enheter, med **kassationsorsak** (obligatorisk när kasserat > 0).

   Antalen ackumuleras på operationen, och material som är kopplat till operationen i beredningen dras automatiskt från lagret för **OK + kasserat** — kasserade enheter förbrukar alltså också komponenter. Är operationen orderns **sista** läggs **Antal OK** dessutom in i lager direkt som färdiga varor, och när orderns antal är nått blir ordern **Klar** av sig själv — se [Tillverkning](/hjalp/tillverkning#inleverans-fran-sista-operationen). Kassationerna loggas och visas på tillverkningsorderns detaljsida (se [Tillverkning](/hjalp/tillverkning)). Kryssa i **Operationen är klar** när allt är rapporterat.

   Räcker inte lagersaldot för det material utstämplingen skulle dra kan terminalen, beroende på systeminställningen **Materialbrist vid rapportering**, fråga "Det saknas ingående delar: … Rapportera ändå?" (**Rapportera ändå** stämplar ut och rapporterar; avbryter du står du kvar på utstämplingen och ingenting är sparat) eller neka utstämplingen med "Det finns inte tillräckligt med ingående delar: …". Du är då fortfarande instämplad — be arbetsledaren fylla på lagret. Se [Tillverkning](/hjalp/tillverkning#materialbrist-vid-rapportering).

   Blev en utstämpling fel — fel antal, fel operation eller fel order — ångrar arbetsledaren den med **Ångra** under **Rapporteringar** på tillverkningsorderns detaljsida; antalen, materialet, inleveransen och stämplingens tid backas då i ett svep (se [Tillverkning](/hjalp/tillverkning#rapporteringar-och-angra)).

Att stämpla in på en operation du redan har en öppen stämpling på avvisas — den visas som misslyckad vid **Starta valda** tills du stämplat ut den först. Inställningen **Tillåt flera samtidiga stämplingar** (System → Inställningar) styr bara om knappen **Stämpla in på arbete** visas i hemvyn när du redan har öppna stämplingar sedan tidigare — är den avslagen måste du stämpla ut något innan du kan besöka väljaren igen för ännu fler operationer.

## Ta ut ATF

1. Välj **Ta ut ATF** i hemvyn.
2. Antalet timmar är förifyllt med dagens schemalagda tid; ändra vid behov (t.ex. `2` eller `8,5`).
3. Bekräfta — uttaget registreras på dagens datum och dras från ditt ATF-saldo, och om du är närvarostämplad stämplas du samtidigt ut ("Din närvarostämpling stämplas ut samtidigt").

ATF-saldot och reglerna hanteras på personalkortet — se [Personal & tid](/hjalp/personal-tid).

## Bra att veta

- Terminalen återgår själv till sifferknappsatsen efter en stunds inaktivitet.
- Hemvyn visar vilka som är närvarostämplade just nu.
