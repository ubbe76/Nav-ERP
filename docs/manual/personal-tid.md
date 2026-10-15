# Personal & tid

Personalregistret, scheman/kalendrar och ATF utgör grunden för närvarohantering och framtida löneunderlag.

## Personal

**Tillverkning → Personal** kräver rollen administratör, eller rollen arbetsledare tillsammans med en behörighetsgrupp som har **Tillverkning** (menyvalet syns inte för andra, se [Behörighetsgrupper](/hjalp/system#behorighetsgrupper)) — personalkortet visar bland annat frånvaro, som räknas som hälsodata. Sidan listar de anställda; klicka på namnet för att öppna **personalkortet** med fem flikar:

- **Allmänt** — anställningsnummer (används i stämpelterminalen), namn, aktiv, telefon, e-post och adress med postnummer/postort.
- **Anställning** — personnummer, anställd från/till, anställningsform (timlön/månadslön), lön och veckoarbetstid.
- **Schema** — standardschema och kalenderöverstyrningar, se nedan.
- **Frånvaro** — registrering av frånvaro (sjukfrånvaro, semester m.m.), se kapitlet [Lön & attestering](/hjalp/lon).
- **ATF** — arbetstidsförkortning, se nedan.

> **Övertidsersättning** anger hur den anställdas övertid ersätts som standard: **Utbetalning** (förvalt) eller **Komptid**. Valet styr vilka tidkoder övertiden får i löneunderlaget och PAXml-exporten, och kan frångås för enskilda dagar i Attesteringens dagdetalj — se kapitlet **Lön**.

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
