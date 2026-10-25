---
paths:
  - "apps/web/styles/**"
  - "apps/web/**/*.css"
  - "apps/web/lib/themes.ts"
  - "apps/web/lib/themeCore.ts"
  - "apps/web/lib/hubIcons.tsx"
  - "apps/web/lib/moduleNav.ts"
  - "apps/web/app/system/teman/**"
  - "packages/shared/src/theme-core.ts"
  - "packages/shared/src/themes.ts"
  - "apps/api/test/theme*"
  - "apps/api/test/hub-icons*"
---

# Färgteman och tokens (arkitekturprincip 8)

- Varje färg (inklusive skuggor och överlägg) är en temaberoende token i `apps/web/styles/tokens.css` som definieras i **varje** `:root[data-theme="<id>"]`-block — aldrig i det delade `:root`-blocket, där bara temaoberoende saker bor (radier, spacing, `--neutral-*`-primitiverna).
- Komponenter använder **bara semantiska tokens**: inga hex/rgb/hsl-värden, inga `--neutral-*`, inga `var(--x, fallback)` som döljer en saknad token.
- Bakgrundstokens har ett textpar (`--status-*-bg`/`-text`, `--accent`/`--accent-text`) — text på en tonad yta tar paret eller temats egna texttokens.
- **Roller:** `--accent` är fyllnad/linje (knappar, aktiv meny, flikar, fokusringar) och `--accent-fg` accenten som **textfärg** (länkar, rubriker) — de skiljer sig i mörkt tema. De rena `--status-*` är bara prickar/staplar/linjer; statustext använder alltid `--status-*-text`.
- Radikonerna på modulsidorna (`HubSections`) kommer från `apps/web/lib/hubIcons.tsx` (lucide-react, nycklat på adress; `/hjalp` skickar `icons={false}`), och `apps/api/test/hub-icons.test.ts` kräver en ikon för varje ny rad i `moduleNav.ts`.
- **Ett nytt tema** = ett nytt token-block + en rad i `apps/web/lib/themes.ts` (registret som väljaren och `<head>`-skriptet läser; temat sätts före första ritningen på alla sidor).
- **En ny färg:** lägg till en semantisk token i alla temablock **och** en post i katalogen `THEME_TOKENS` (med `fallback`, så sparade egna teman fortsätter fungera) i `packages/shared/src/theme-core.ts` — importfri, kopieras byte för byte till `apps/web/lib/themeCore.ts` (`theme-core-copy.test.ts`), med de inbyggda temanas värden i `BUILTIN_THEME_VALUES` och text-/ytlistorna och kontrastparen (`THEME_CONTRAST_PAIRS`) som testet, servern och temaredigeraren delar.
- `apps/api/test/theme-tokens.test.ts` vaktar alltihop: samma tokenuppsättning i alla teman, registret i synk med blocken, katalogen och blocken exakt lika, inga råa färger eller odefinierade tokens i `components/`/`app/`, och **WCAG AA (4,5:1)** för varje texttoken mot varje yta och för bakgrund/text-paren i varje tema.
