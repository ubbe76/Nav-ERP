# ERP Starter — kom igång med Claude Code CLI

## Innehåll i detta paket

```
dev/
├── CLAUDE.md              # Kontext för Claude Code — läses automatiskt
├── docs/
│   └── architecture.md    # Full kravspec, datamodell, statusflöden, faser
├── db/
│   └── schema_phase1.sql  # Referensschema för Article/BOM/Stock (fas 1)
├── docker-compose.yml
├── .env.example
└── docs/claude-code-getting-started.md   # Denna fil (ursprungligen README.md)
```

> Detta är onboarding-dokumentet för startpaketet, sparat som historik. Se
> [`README.md`](../README.md) i repo-roten för aktuell projektstatus och
> kom-igång-instruktioner för det färdiga projektet.

## Så här kommer du igång

1. Skapa en ny git-repo och lägg dessa filer i roten:
   ```bash
   git init erp
   cd erp
   # kopiera in filerna från detta paket
   git add .
   git commit -m "Initial project scaffolding"
   ```

2. Starta Claude Code i mappen:
   ```bash
   claude
   ```
   Claude Code läser automatiskt `CLAUDE.md` för projektkontext.

3. Första prompten till Claude Code, förslagsvis:
   > "Läs docs/architecture.md och CLAUDE.md. Sätt upp monorepo-strukturen med apps/api (Fastify + TypeScript + Drizzle), apps/web (Next.js), packages/db och packages/shared enligt CLAUDE.md. Använd db/schema_phase1.sql som referens för det första Drizzle-schemat."

4. Fortsätt fas för fas (se `docs/architecture.md` avsnitt 8):
   - Fas 1: Article, BOM, Stock
   - Fas 2: Purchase, Sales
   - Fas 3: Manufacturing orders
   - Fas 4: Time reporting, Costing
   - Fas 5: Publikt API för konfigurator-integration

## Tips för arbetet med Claude Code

- Be Claude Code skapa **en migration i taget** snarare än att skriva om hela schemat — lättare att granska och rulla tillbaka.
- Efter varje fas: be Claude Code skriva Vitest-tester för statusövergångarna innan ni går vidare — det är den logik som är svårast att felsöka i efterhand.
- Håll `docs/architecture.md` uppdaterad när ni fattar beslut på de öppna frågorna i avsnitt 9 — det blir referensen för framtida sessioner.
- Om du vill återanvända detta mot din diskbänkskonfigurator senare: fas 5:s API-design är skriven med det i åtanke (samma mönster som Monitors REST-API/OAuth2).

## Nästa steg efter detta paket

När fas 1 är på plats är ett naturligt nästa steg att skriva en liten seed-script (testdata: några artiklar, en enkel BOM för en diskbänksmodul) så att du kan verifiera lagerlogiken innan ni bygger vidare mot inköp/försäljning.
