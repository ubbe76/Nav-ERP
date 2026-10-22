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

### Helgdagar

Helgdagar gäller alla anställda och slår igenom oavsett schema. En helgdag kan vara **helt ledig** eller peka på ett särskilt dagsschema (t.ex. halvdag). **Förifyll svenska helgdagar** lägger in årets svenska helgdagar (inkl. rörliga som midsommar och påskdagarna); knappen är säker att köra flera gånger och skriver aldrig över egna ändringar.

## Schema per anställd

På personalkortets **Schema**-flik:

- **Standardschema** — det veckoschema som normalt gäller.
- **Veckoöverstyrning** — annat veckoschema för en viss ISO-vecka.
- **Dagöverstyrning** — annat dagsschema (eller helt ledig) för ett enskilt datum.
- **Kommande 4 veckor** visar det upplösta resultatet dag för dag.

Prioritetsordning när en dag avgörs: dagöverstyrning → helgdag → veckoöverstyrning → standardschema → ledig.

## ATF (arbetstidsförkortning)

ATF tjänas in med ett schablonvärde i **minuter per vecka** för varje fullbordad arbetsvecka:

- Systemstandarden sätts under **System → Inställningar** ("ATF-intjäning (minuter per vecka)"); på personalkortets **ATF**-flik kan den överstyras per anställd.
- **Intjäning från** anger från vilket datum intjäningen räknas.
- **Uttagsläge**: **Tidbank** (uttag dras från saldot) eller **Veckouttag** (den anställde tar ut sin ATF varje vecka — ingen bank byggs upp).
- Fliken visar saldot och alla transaktioner (Uttag/Justering). Uttag registreras här eller av den anställde själv i [stämpelterminalen](/hjalp/terminal); justeringar (± timmar) används för korrigeringar. Negativt saldo tillåts men visas rött.

> Ändras intjäningstakten räknas hela historiken om med den nya takten — korrigera i så fall med en justeringstransaktion.

## Tidrapporter

Se [Tillverkning](/hjalp/tillverkning) — tidrapporter skapas automatiskt vid utstämpling i terminalen eller manuellt under **Tillverkning → Tidrapporter**.
