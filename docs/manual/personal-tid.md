# Personal & tid

Personalregistret (se [Personal & lön](/hjalp/lon)), scheman/kalendrar och ATF utgör grunden i Nav|ERP för närvarohantering och löneunderlag.

## Personal

Personalregistret och personalkortet finns i menyn **Personal & lön → Anställda** och beskrivs i kapitlet [Personal & lön](/hjalp/lon#anstallda). Scheman och ATF nedan är en del av personalkortet.

## Scheman

**Tillverkning → Planering → Scheman** har tre flikar:

### Dagsscheman

Ett dagsschema är en namngiven arbetsdag: **kod**, namn, **starttid** och **sluttid** (24-timmarsformat HH:MM) samt **avbrott** däremellan. Varje avbrott har typ:

- **Rast** — obetald, räknas bort från nettotiden (t.ex. lunch).
- **Paus** — betald, ingår i nettotiden (t.ex. fikapaus).

Nettotiden beräknas och visas direkt i formuläret.

### Veckoscheman

Ett veckoschema kopplar ett dagsschema till varje veckodag (måndag–söndag); dagar utan schema är lediga.

### ATF och inarbetning i veckoschemat

När inställningen **Tillåt ATF-uttag via schemat** är på (under **System → Inställningar**, se [System](/hjalp/system)) får veckoschemat två fält till:

- **Ordinarie arbetstid per vecka (timmar)** — till exempel 40. Tomt = ingen utjämning: veckan följer då bara sina dagsscheman.
- **ATF per vecka (minuter)** — till exempel 82. Med 0 jämnas bara inarbetningen ut.

Båda delas lika på veckoschemats arbetsdagar — med fem arbetsdagar blir det 8 h ordinarie och 16,4 minuter ATF per arbetsdag. ATF och inarbetning räknas alltså **per arbetsdag**, och **veckans sista arbetsdag** får det som återstår av veckan. Alla andra dagar följer sina dagsscheman som vanligt. Sista arbetsdagens sluttid räknas från dagsschemats starttid, förbi dagens raster — blir dagen längre än dagsschemat fortsätter den efter dess sluttid.

Formuläret visar en förhandsvisning med raden "8 h 00 min ordinarie och 16,4 min ATF per arbetsdag" och två tabeller: **En hel vecka** och **Kort vecka** med helgdag på sista arbetsdagen. Sista arbetsdagen står i fetstil. Går veckan inte ihop — sista arbetsdagen skulle bli 0 minuter eller sluta efter midnatt för någon kombination av helgdagar — visas varför, och veckoschemat går inte att spara. Samma kontroll görs när du ändrar ett dagsschema som används i ett sådant veckoschema. Listan visar **Ordinarie/vecka** och **ATF/vecka**.

**Exempel.** Dagsschemat MAN-TOR är 07:00–16:15 med obetalda raster 09:00–09:20 och 12:00–12:40 (8 h 15 min — 15 minuter inarbetning per dag). Dagsschemat FREDAG är 07:00–12:58 med bara rasten 09:00–09:20. Veckoschemat har MAN-TOR måndag–torsdag och FREDAG på fredag, **Ordinarie arbetstid per vecka** 40 och **ATF per vecka** 82:

| Vecka | Sista arbetsdagen | Slutar |
|---|---|---|
| Hel vecka | fredag 5 h 38 min | 12:58 |
| Röd onsdag (eller måndag) | fredag 6 h 09 min | 13:29 |
| Röd fredag | torsdag 6 h 09 min | 14:09 |
| Röd onsdag–fredag | tisdag 7 h 12 min | 15:12 |
| Sjuk hela onsdagen | fredag 5 h 54 min | 13:14 |

I veckan med röd onsdag ryms både de tre inarbetade kvartarna och fyra dagars ATF — ingen tid "bjuds" på. Fredagen behöver ett eget dagsschema för att den korta dagen har en annan form (ingen lunch): hade fredagen pekat på MAN-TOR hade en hel vecka slutat 13:38, efter lunchrasten.

**Vilka dagar som räknas:**

- **Helgdagar** räknas inte som arbetsdagar — varken röda dagar eller halvdagar med eget dagsschema. En halvdag behåller helgdagens dagsschema och blir aldrig sista arbetsdag.
- **Frånvaro** (semester, utbildning och liknande) ändrar inte veckan — frånvaron täcker dagens schemalagda tid, inklusive inarbetningen.
- **Frånvarokoder som inte tjänar in ATF** — som förval sjukfrånvaro, vård av barn, föräldraledighet och tjänstledighet (se [Lönekoder](/hjalp/lon#franvarokoder)) — gör att dagen inte tjänar in sin ATF-andel. Varje sådan dag före sista arbetsdagen gör sista arbetsdagen så mycket längre; en halv dag ger halva andelen. Frånvaro på själva sista arbetsdagen ändrar inte den dagens längd.
- **Dagöverstyrningar** på personalkortet gäller bara sin egen dag. En dagöverstyrning på sista arbetsdagen vinner över den uträknade tiden.
- **Veckoöverstyrning** till ett annat veckoschema använder det veckoschemats egna fält.

Lönen, attesteringens **Ofördelat** och **Avvikelser**, stämpelterminalens fråga om tidig hemgång och **Hämta ur schema** i frånvaroregistreringen räknar alla med den uträknade sista arbetsdagen. Går någon hem 12:58 en fredag i en vecka med röd onsdag är det alltså 31 minuter tidig hemgång och 31 minuter Ofördelat. Arbete efter sista arbetsdagens sluttid är övertid som vanligt.

> Registrera sjukfrånvaro och vård av barn samma dag eller dagen efter. Då visar terminalen och personalkortet rätt sluttid redan på veckans sista arbetsdag. Registreras frånvaron i efterhand flyttas sista arbetsdagens sluttid bakåt i tiden, och den som redan gått hem får tidig hemgång och Ofördelat i attesteringen.

ATF som tas ut så här dras **inte** från ATF-saldot på personalkortet och skickas inte i löneunderlaget — kontot förs i lönesystemet. Ställ personalens **Uttagsläge** på **Veckouttag** (eller **ATF-intjäning** till 0) så att Nav inte visar ett eget saldo för dem. Stäng av inställningen så följer veckoscheman bara sina dagsscheman igen; de sparade fälten ligger kvar men används inte, och olåsta löneperioder räknas om.

### Helgdagar

Helgdagar gäller alla anställda och slår igenom oavsett schema. En helgdag kan vara **helt ledig** eller peka på ett särskilt dagsschema (t.ex. halvdag). **Förifyll svenska helgdagar** lägger in årets svenska helgdagar (inkl. rörliga som midsommar och påskdagarna); knappen är säker att köra flera gånger och skriver aldrig över egna ändringar.

## Schema per anställd

På personalkortets **Schema**-flik:

- **Standardschema** — det veckoschema som normalt gäller.
- **Veckoöverstyrning** — annat veckoschema för en viss ISO-vecka.
- **Dagöverstyrning** — annat dagsschema (eller helt ledig) för ett enskilt datum.
- **Kommande 4 veckor** visar det upplösta resultatet dag för dag. I ett veckoschema med utjämning visas veckans sista arbetsdag med sin uträknade sluttid, och en not säger när veckan är kort ("kort vecka (4 arbetsdagar)") eller när frånvaro har kostat ATF ("ATF −16 min (frånvaro)").

Prioritetsordning när en dag avgörs: dagöverstyrning → helgdag → veckoöverstyrning → standardschema → ledig.

## ATF (arbetstidsförkortning)

ATF tjänas in med ett schablonvärde i **minuter per vecka** för varje fullbordad arbetsvecka:

- Systemstandarden sätts under **System → Inställningar** ("ATF-intjäning (minuter per vecka)"); på personalkortets **ATF**-flik kan den överstyras per anställd.
- **Intjäning från** anger från vilket datum intjäningen räknas.
- **Uttagsläge**: **Tidbank** (uttag dras från saldot) eller **Veckouttag** (den anställde tar ut sin ATF varje vecka — ingen bank byggs upp). För ATF som tas ut som kortare arbetstid i veckoschemat, se [ATF och inarbetning i veckoschemat](#atf-och-inarbetning-i-veckoschemat).
- Fliken visar saldot och alla transaktioner (Uttag/Justering). Uttag registreras här eller av den anställde själv i [stämpelterminalen](/hjalp/terminal); justeringar (± timmar) används för korrigeringar. Negativt saldo tillåts men visas rött.

> Ändras intjäningstakten räknas hela historiken om med den nya takten — korrigera i så fall med en justeringstransaktion.

## Tidrapporter

Se [Tillverkning](/hjalp/tillverkning) — tidrapporter skapas automatiskt vid utstämpling i terminalen eller manuellt under **Tillverkning → Tidrapporter**.
