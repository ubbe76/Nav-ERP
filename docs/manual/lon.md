# Lön & attestering

Löneblocket täcker flödet frånvaro → attestering → låsning → export: frånvaro och OB registreras löpande, varje anställds underlag attesteras för en löneperiod, perioden låses och löneunderlaget exporteras till lönesystemet (PAXml). Kapitlet byggs ut i takt med att rutinerna färdigställs — hittills finns grundregistren löneunderlaget bygger på (**Lönekoder**), frånvaroregistreringen på personalkortet, arbetsledarens månadsvy **Attestering** och rapportsidan **Löneunderlag** med export till PAXml.

## Lönekoder

**Tillverkning → Lön → Lönekoder** har två flikar: **Frånvarokoder** och **OB-tillägg**.

### Frånvarokoder

Frånvarokoder är de typer av frånvaro som kan registreras (t.ex. sjukfrånvaro eller semester) och vilken PAXml-tidkod respektive typ exporteras med. Varje kod har **Kod**, **Namn**, **PAXml-kod** och **Aktiv**. Klicka på en rad för att öppna den för redigering.

**Förifyll standardkoder** lägger in en uppsättning vanliga svenska frånvarokoder (sjukfrånvaro, semester, vård av barn, föräldraledighet, tjänstledighet, permission, utbildning och kompledighet) med en förslags-PAXml-kod var. Knappen är säker att köra flera gånger — koder vars kod eller namn redan finns hoppas över, och resultatet visas som "X skapade, Y fanns redan".

> PAXml-koden måste finnas i lönesystemets löneartstabell — en felaktig kod ger en ogiltig exportfil.

### OB-tillägg

OB-tillägg (ersättning för obekväm arbetstid) definierar tidsfönster som ger ett lönetillägg utöver ordinarie arbetstid. Varje regel har **Kod**, **Namn**, **Dagtyp** (Vardag, Lördag, Söndag eller Helgdag — en helgdag räknas alltid som Helgdag, oavsett veckodag), **Från**/**Till** (klockslag i 24-timmarsformat) och **PAXml-kod**.

Ett tidsfönster får inte gå över midnatt. Ett OB-tillägg som ska gälla natten mot nästa dag läggs därför upp som två rader, t.ex. 22:00–23:59 och 00:00–06:00.

### Viktigt om ändringar i efterhand

> Lås perioden innan du ändrar OB-tillägg eller scheman — olåsta perioder räknas alltid om med nuvarande regler.

## Frånvaro på personalkortet

Personalkortets flik **Frånvaro** (se [Personal & tid](/hjalp/personal-tid)) registrerar frånvaro per anställd och datum.

Kortet **Registrera frånvaro** har fälten **Frånvarokod** (en av frånvarokoderna ovan), **Datum**, **Timmar** och en valfri **Anteckning**. Knappen **Hämta ur schema** fyller i Timmar med den schemalagda nettotiden för valt datum — en hel dag frånvaro motsvarar alltså schemats nettotid, inte alltid 8 timmar. Saknas ett schema för dagen visas ett felmeddelande i stället.

Kortet **Registrerad frånvaro** listar registrerade poster med datum, namn och antal timmar; en **Ta bort**-knapp tar bort en post.

Hela personalkortet — inklusive Frånvaro-fliken och listan **Registrerad frånvaro** — kräver rollen arbetsledare eller administratör; övriga användare ser varken sidan eller listan, eftersom frånvaro räknas som hälsodata. Låsta löneperioder blockerar både registrering och borttag av frånvaro i den perioden.

## Attestering

**Tillverkning → Lön → Attestering** är arbetsledarens månadsvy: granska varje anställds underlag, korrigera det som blivit fel, attestera per anställd och låsa perioden. Sidan är öppen för arbetsledare och administratörer.

Sidan öppnas på föregående månad — den period som normalt ska attesteras. Perioden byts med **◀ Föregående** och **Nästa ▶**, och rubriken visar period och status, t.ex. "Juni 2026 · Öppen" eller "Juni 2026 · Låst".

### Granska underlaget

Tabellen har en rad per anställd med kolumnerna **Anställd**, **Schema**, **Arbetat**, **Frånvaro**, **Övertid** (övertid och övertid helg tillsammans), **OB**, **ATF**, **Ofördelat** och **Status**.

**Ofördelat** är schemalagd tid som varken täcks av arbetad tid, frånvaro eller ATF-uttag — den markeras i rött och är det som ska redas ut innan du attesterar. Antingen saknas en stämpling (korrigera närvaron) eller så saknas en frånvaropost (registrera frånvaron).

Statusen visas som en av tre:

- **Ej attesterad** — underlaget är inte granskat klart.
- **Öppen närvaro** — den anställde har en närvarostämpling som aldrig avslutats. Underlaget är ofullständigt och kan inte attesteras förrän stämplingen är åtgärdad.
- **Attesterad** — underlaget är godkänt; vem som attesterade och när visas under statusen.

### Detaljer och korrigeringar

**Detaljer** öppnar dagvyn för en anställd, med en rad per dag (**Datum**, **Schema**, **Arbetat**, **Frånvaro**, **ÖT** och **Ofördelat**). Under varje dag listas dagens närvarostämplingar med klockslag och dagens frånvaroposter.

- **Ändra** på en närvarostämpling visar start- och sluttid som redigerbara fält; **Spara** skriver den korrigerade tiden. Sluttiden måste vara efter starttiden. Töms sluttiden öppnas stämplingen igen — den räknas då som en pågående närvaro och visas som **Öppen närvaro**, vilket blockerar attesteringen tills den avslutas.
- **Ta bort** raderar en felaktig närvarostämpling eller frånvaropost (borttag av stämpling bekräftas i en dialog).
- Kortet **Registrera frånvaro** längst ned har samma fält som personalkortet — **Frånvarokod**, **Datum**, **Timmar** och **Anteckning**. Datum och Timmar är förifyllda med den första dagen som har ofördelad tid och antalet ofördelade timmar, så en hel dags frånvaro registreras med ett klick på **Registrera**.

**Stäng** stänger dagvyn. Varje korrigering räknar om underlaget direkt.

### Attestera

**Attestera** godkänner en anställds underlag för perioden. Har den anställde en öppen närvarostämpling avvisas attesteringen — åtgärda stämplingen i **Detaljer** först. **Ångra attest** tar bort attesteringen igen så länge perioden är öppen.

### Låsa perioden

När alla anställda är attesterade kan en administratör låsa perioden med **Lås period**. Låsningen bekräftas i en dialog och kräver dessutom att månaden är slut — en pågående månad kan inte låsas. Är någon anställd oattesterad visas i stället texten "Alla medarbetare måste attesteras innan perioden kan låsas."

Vid låsningen fryses underlaget i en kopia som alla senare läsningar och exporter utgår från, och alla ändringar bakåt i perioden blockeras: närvarostämplingar, tidrapporter, frånvaro, ATF-transaktioner och schemaändringar för datum i perioden avvisas med att perioden är låst. Under tabellen visas då när perioden låstes.

**Lås upp period** (endast administratör) öppnar perioden igen: den frysta kopian raderas, underlaget räknas om live med nuvarande regler och ändringar släpps in på nytt. Attesteringarna behålls. Arbetsledare ser status och låstidpunkt men har inte knapparna **Lås period** och **Lås upp period**.

## Övertid

Övertid beräknas per dag genom att jämföra arbetad tid mot schemalagd tid. Den överskjutande tiden räknas bara som övertid när den överstiger inställningen **Övertidströskel (minuter per dag)** under **System → Inställningar → Lön & PAXml** — annars ingår den i den vanliga arbetade tiden.

På dagar utan schema (t.ex. arbete en helt ledig dag) räknas i stället all arbetad tid som **övertid helg**, oavsett tröskeln.

I PAXml-exporten är posten för arbetad tid den arbetade tiden minus de övertidsposter (övertid och övertid helg) som redan exporteras som egna poster, så att övertidstimmarna aldrig räknas dubbelt. Har dagen frånvaro eller ett ATF-uttag kan posten för arbetad tid därför hamna under schemalagd tid, och tid inom övertidströskeln — som räknas som vanlig arbetad tid, inte övertid — kan på samma sätt föra den över schemalagd tid.

### Utbetalning eller komptid

Varje anställd har en standard för hur övertid ersätts — fältet **Övertidsersättning** på personalkortets flik **Anställning**, med valen **Utbetalning** (förvalt) och **Komptid**. Valet styr vilka tidkoder övertiden exporteras med: vid **Komptid** används komptidskoderna (förval `ÖK1` för övertid och `ÖK2` för övertid helg) i stället för de vanliga övertidskoderna, så att lönesystemet sätter in timmarna i den anställdas kompbank i stället för att betala ut dem.

Standarden kan frångås för en enskild dag: i Attesteringens dagdetalj visar dagar med övertid raden **Övertid ersätts som** med valen **Utbetalning**/**Komptid**. Ett val där sparas som en avvikelse för just den dagen och ligger fast även om personalkortets standard senare ändras — **Återställ till standard** tar bort avvikelsen igen. Avvikelser kan inte ändras i en låst period.

Byte av **Övertidsersättning** på personalkortet slår igenom direkt på alla olåsta månader (samma regel som för scheman och OB-regler); låsta perioder behåller det val som gällde när perioden låstes. Något kompsaldo förs inte i systemet — det ägs av lönesystemet, och uttag av komptid registreras som frånvaro med koden för kompledighet.

## Löneunderlag

**Tillverkning → Lön → Löneunderlag** visar samma underlag som Attestering, men som en läsbar rapport med nedladdningsbara filer i stället för en granskningsvy — sidan är öppen för arbetsledare och administratörer.

Sidan öppnas på föregående månad och byts precis som Attestering med **◀ Föregående** och **Nästa ▶**; rubriken visar period och status.

Tabellen delas upp i två grupper efter anställningsformen på personalkortet:

- **Timlön** — anställda som betalas per arbetad timme. Hela den rapporterade tiden (arbetat, övertid, OB, frånvaro) ligger till grund för lönen.
- **Månadslön** — anställda med fast månadslön. Underlaget handlar här i stället om **avvikelser** från den fasta lönen: frånvaro som ska dras av, övertid och OB som ska läggas till.

Anställda utan angiven anställningsform hamnar i en egen grupp, **Ej angiven anställningsform**, med en varning om att anställningsformen behöver kompletteras på personalkortet innan löneunderlaget blir korrekt. Varje grupp har en summeringsrad längst ned med gruppens totala timmar per kolumn.

Till skillnad från Attesteringens tabell, där övertid och övertid helg visas ihopslagna i en kolumn, delas övertiden här upp i **Övertid utbet.** och **Övertid komp** — samma dagvisa val (se [Utbetalning eller komptid](#utbetalning-eller-komptid) ovan) avgör vilken av de två en dags övertid hamnar i. **Ladda ner CSV** och **Ladda ner PDF** ger underlaget som en kalkylarksfil respektive en utskriftsvänlig rapport och delar upp övertiden på samma sätt (CSV:n och PDF:n särredovisar dessutom övertid och övertid helg var för sig), oavsett om perioden är låst. **Exportera PAXml** är inaktiv med texten "Perioden måste vara låst innan PAXml kan exporteras" tills perioden är låst — se nästa avsnitt.

## PAXml-export

PAXml-filen är importfilen till lönesystemet och kan bara exporteras för en **låst period** — lås perioden på **Attestering**-sidan med **Lås period** innan export.

Vilka PAXml-tidkoder som används styrs av flera register:

- De fasta tidkoderna för arbetad tid, övertid, övertid helg, ATF och de två komptidskoderna (övertid – komptid, övertid helg – komptid) ställs in under **System → Inställningar → Lön & PAXml**.
- Varje frånvarokod har en egen PAXml-kod, satt i registret **Lönekoder → Frånvarokoder** (se [Lönekoder](#lonekoder) ovan).
- Varje OB-tillägg har en egen PAXml-kod, satt i registret **Lönekoder → OB-tillägg**.

De sex fasta tidkoderna läses från inställningarna först vid själva exporten, medan frånvarokodernas och OB-tilläggens tidkoder frystes i periodens underlag redan när den låstes. Ändrar du en fast tidkod slår det alltså igenom även på en redan låst periods nästa export, men en ändrad frånvaro- eller OB-kod kräver att perioden låses upp och låses igen för att synas i exporten.

> Stäm av tidkoderna mot lönesystemets löneartstabell innan första importen — en kod som inte finns i löneartstabellen ger en ogiltig import i lönesystemet.
