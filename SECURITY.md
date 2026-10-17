# Säkerhet

## Rapportera en säkerhetsbrist

Hittar du en säkerhetsbrist i Nav|ERP — till exempel ett sätt att komma åt data utan behörighet, logga in som någon annan eller köra kod på servern — **rapportera den privat, inte i ett öppet ärende**:

**[Rapportera en sårbarhet](https://github.com/ubbe76/Nav-ERP/security/advisories/new)** (GitHubs privata sårbarhetsrapportering)

Ta gärna med:

- vad bristen är och vad en angripare kan uppnå med den,
- hur man återskapar den, steg för steg,
- vilken version eller commit du testade mot.

Testa bara mot en egen installation, aldrig mot någon annans system, och använd påhittade uppgifter.

## Vad du kan förvänta dig

Nav|ERP utvecklas av en person. Du får ett svar så snart som möjligt, och en bekräftad brist rättas och släpps så fort det går. När rättningen är ute publiceras en säkerhetsrapport på GitHub där du nämns, om du vill.

## Versioner

Nav|ERP är en alfaversion och **inte redo för produktion**. Bara den senaste versionen på `main` får säkerhetsrättningar.

| Version | Får rättningar |
|---|---|
| 0.2.3-alpha (senaste `main`) | Ja |
| Äldre | Nej — uppdatera till senaste |

## Driftsätt säkert

README:s avsnitt [Driftsätta på en annan server](README.md#driftsätta-på-en-annan-server-tex-en-vps) beskriver det viktigaste: egna värden för `POSTGRES_PASSWORD` och `JWT_SECRET`, bara webbens port öppen utåt (helst bakom en omvänd proxy med HTTPS) och att det första kontot skapas direkt efter installationen med engångskoden ur API:ts logg.
