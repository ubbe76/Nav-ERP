# Komma igång

Nav|ERP är byggt kring kärnflödet **artikel → lager → inköp/försäljning → tillverkningsorder → tidrapportering → kalkyl**. Den här manualen beskriver alla rutiner; det här kapitlet täcker det som är gemensamt för hela systemet.

## Logga in

Systemet nås i webbläsaren på serverns adress. Logga in med e-post och lösenord.

Efter 10 misslyckade inloggningsförsök på samma konto spärras kontot i 15 minuter — även rätt lösenord avvisas då med *"För många misslyckade inloggningsförsök — försök igen om … min."* En lyckad inloggning nollställer räkningen. Spärren skyddar mot lösenordsgissning; vill en administratör släppa den tidigare räcker det att starta om API:t.

**Första gången:** systemet har inga förinstallerade konton. Gå till `/register` och skapa det första kontot — det blir automatiskt administratör och du loggas in direkt. Fältet **Engångskod** fylls i med koden som API:t skriver i sin logg när det startar (på servern: `docker compose logs api`); på så sätt kan bara den som kommer åt servern skapa administratörskontot. Koden byts vid varje omstart, om den inte är fast satt som `SETUP_CODE` i `.env`. Så fort ett konto finns stängs registreringssidan; fler användare skapas därefter av en administratör under **System → Användare**.

## Navigering

- **Sidomenyn** till vänster har ett menyval per modul och inga undermenyer: Översikt, Artiklar, Inköp, Försäljning, Tillverkning, Lager, Ekonomi, Rapporter, System (endast administratörer) och Hjälp — du ser bara de moduler din behörighetsgrupp ger dig (se [Behörighetsgrupper](/hjalp/system#behorighetsgrupper)). Klickar du på en modul öppnas **modulens egen sida**, där alla dess funktioner ligger grupperade i ett rutnät med en kort förklaring under varje. Därifrån går du vidare till rutinen du ska arbeta i. Funktioner som du inte har behörighet till visas inte i rutnätet.
- **Sök i manualen:** på **Hjälp** finns fältet **Sök i manualen…** (och ovanför varje kapitel). Skriv ett eller flera ord och tryck **Sök**; träffarna visar kapitel, avsnittsrubrik och ett utdrag med sökorden markerade, och ett klick tar dig direkt till avsnittet. Alla ord måste finnas i samma avsnitt, och stora/små bokstäver samt å/ä/ö spelar ingen roll.
- Rutnätet är indelat i grupper med en rubrik över de funktioner som hör ihop. Under **Tillverkning** ligger till exempel **Behovsberäkning**, **Beläggning** och **Scheman** i gruppen **Planering**.
- Längst ned i sidomenyn står ditt namn, din roll och vilken version av Nav|ERP du använder, t.ex. **Version 0.2.4-alpha**. Klickar du på versionen öppnas versionssidan på naverp.se med vad som är nytt i varje version. Versionen syns också i API:ets `GET /health`.
- Med **pilknappen** överst i sidomenyn fäller du ihop menyn till enbart ikoner. Valet sparas i webbläsaren och gäller tills du fäller ut den igen.
- Uppe till höger finns **Logga ut** och väljaren för färgtema: **Ljust**, **Mörkt** och **Dracula** (ett mörkt tema i lila och rosa efter [Dracula](https://draculatheme.com), som används under MIT-licensen). Valet sparas i webbläsaren och gäller på alla sidor, även stämpelterminalen och inloggningen.

## Översikten

Startsidan visar materialflödet i fyra stationer — Inköp, Lager, Tillverkning, Försäljning — med antal öppna ordrar och varningar (försenade ordrar, negativa saldon). Varje station är klickbar: Inköp, Tillverkning och Försäljning öppnar modulens sida, och Lager landar direkt på saldolistan som stationens siffror beskriver. Under den finns:

- **Bevakningslistan** — artiklar med saldo ≤ 0, försenade inköps- och kundordrar, värst först. En order räknas som försenad när någon av raderna som inte är fullt mottagen/levererad har passerat sitt leveransdatum.
- **Aktiva tillverkningsordrar** och de senaste lagertransaktionerna.

Stationerna, raderna och knappen **+ Ny order** följer din behörighetsgrupp: det du inte får öppna visas som vanlig text i stället för som länk, och **+ Ny order** visas bara för den som kan öppna tillverkningsorderlistan.

## Listor: sök, filter och bläddring

Alla registerlistor (artiklar, kunder, leverantörer, ordrar, saldon, transaktioner, tidrapporter…) fungerar likadant:

- **Sökfältet** ovanför tabellen söker medan du skriver — t.ex. på artikelnummer/benämning eller ordernummer/namn beroende på lista.
- **Filterval** (artikeltyp, artikelgrupp, orderstatus…) ligger bredvid sökfältet.
- **Bläddring**: listan visar 50 rader åt gången som standard; under tabellen står "Visar X–Y av Z" med sidknappar.
- **Rader per sida**: bredvid "Visar X–Y av Z" finns valet **Rader per sida** (25/50/100/250). Valet sparas på ditt konto och gäller sedan alla listor du öppnar, tills du ändrar det igen.
- Sökning, filter och sida ligger i sidans adress — du kan bokmärka eller dela en filtrerad vy.

## Artikelväljaren

Där en artikel ska väljas (orderrader, tillverkningsorder, struktur) finns en **sökbar artikelväljare**: klicka i fältet så visas de första träffarna, skriv för att söka på artikelnummer eller benämning, välj med piltangenterna + Enter eller med klick.

## Vanliga knappar

| Knapp | Betydelse |
|---|---|
| **+ Ny …** | Öppnar formulär för att skapa en post |
| **Spara** | Sparar formuläret; "Sparat" visas vid lyckad sparning |
| **Ändra / Ta bort** | Radknappar i tabeller; Ta bort kräver bekräftelse |
| Namn/nummer i en lista | Öppnar postens kort eller detaljsida |

## Licens

Nav|ERP är fri programvara, © 2026 Urban Källefors, och sprids under **GNU General Public License version 3 eller senare** (GPL-3.0-or-later). Du får använda, sprida och ändra programmet enligt licensens villkor; det levereras utan garanti. Den fullständiga licenstexten finns i filen `LICENSE` i källkoden.

Färgtemat **Dracula** bygger på [Dracula-paletten](https://draculatheme.com) (© 2023 Dracula Theme) och används under MIT-licensen — licenstexten finns i `licenses/Dracula-MIT.txt`.
