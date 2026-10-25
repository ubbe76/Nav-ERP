# Bidra till Nav|ERP

Tack för att du vill hjälpa till! Nav|ERP är en alfaversion, och just nu är återkoppling från den som provar systemet det mest värdefulla.

## Återkoppling

- **Fel:** öppna ett ärende med mallen [Felrapport](https://github.com/ubbe76/Nav-ERP/issues/new/choose).
- **Idéer och önskemål:** öppna ett ärende med mallen **Förslag** — beskriv helst problemet du vill lösa, inte bara lösningen.
- **Säkerhetsbrister:** rapportera privat enligt [SECURITY.md](SECURITY.md), aldrig i ett öppet ärende.

Klistra aldrig in lösenord, nycklar, personnummer eller riktiga kund- och leverantörsuppgifter i ett ärende.

## Kod

Pull requests är välkomna. För något större än en liten rättning — öppna gärna ett ärende först, så att vi kan prata om upplägget innan du lägger tid på det.

### Komma igång

Utvecklingsmiljön beskrivs i README:s [Komma igång](README.md#komma-igång). `CLAUDE.md` beskriver arkitekturen och kodkonventionerna, och `.claude/rules/` har reglerna per modul — läs dem innan du ändrar i en modul.

### Innan du skickar en pull request

- **Tester:** API-testerna körs mot en riktig Postgres i en egen testcontainer:

  ```bash
  docker compose --profile test up -d postgres-test
  npm run test --workspace apps/api
  ```

  Ny funktion eller rättning = ett test som visar den. GitHub kör hela sviten, typkontrollen och bygget på varje pull request.
- **Typkontroll:** `npm run build --workspace apps/api` och i `apps/web`: `../../node_modules/.bin/tsc --noEmit -p tsconfig.json`.
- **Påhittad testdata:** inga riktiga företag, personer, organisationsnummer eller artikelnummer i tester, exempel eller dokumentation.
- **Manualen:** ändras en rutin eller inställning uppdateras motsvarande kapitel i `docs/manual/` i samma pull request, med UI:ts faktiska knapp- och fältnamn.
- **Webben:** bara semantiska färgtokens (se `apps/web/styles/tokens.css`), och bekräftelser via appens egen dialog — aldrig `window.confirm`.
- **Kod och kommentarer på engelska**, gränssnitt och manual på svenska.

## Licens

Nav|ERP är licensierat under [GPL-3.0-or-later](LICENSE). Genom att skicka ett bidrag godkänner du att det licensieras under samma villkor.
