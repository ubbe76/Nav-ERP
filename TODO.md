# TODO — Nav-ERP

Aktuella punkter och beslut. Avslutade block är arkiverade utanför det publika repot.

## Aktuellt

- [x] **import-export.md, paket A–D** — **klar 2026-09-06**: Avrundning (`articles.rounding`), tidsenhet i beredningen och operationsimportens **Enhet** med **Uppdatera befintliga operationer**, importentiteterna enheter/inköpspriser/kundpriser plus planeringsfliken, och flerfilsimporten **Alla filer**. Detaljerna står i `CLAUDE.md`.
- [ ] **D3 Spårbarhet batch/serienr** (L) — vid behov, senare.
- [x] **Orderradens 400 vid tom priskedja** (S) — **klar 2026-10-15**: raden behåller sitt pris och sin rabatt när kedjan är tom. — en rad-PATCH som ändrar antalet utan `unitPrice` prisar om raden (C3: en ny kvantitet kan ha passerat en staffelgräns) och kastar `PriceNotFoundError` → 400 om kedjan är **helt tom**, trots att raden redan har ett pris. Motivet "stale-pris vore värre vid staffel" bär inte i just det fallet: finns ingen prisregel alls finns ingen staffel att ha passerat. Kandidatfix: behåll radens befintliga pris och rabatt när kedjan inte ger något, och lämna kastet i `addRow`/`createQuote` orört — där är det både testat (`sales.service.test.ts` "throws PriceNotFoundError when omitted and the chain is empty") och manualdokumenterat ("Saknas pris i alla fyra stegen går det inte att lägga raden"). Webben är opåverkad (skickar alltid pris); det gäller främst konfiguratorn. Fällan syns i testfilen: två tester kringgår den genom att skicka `unitPrice`, och ett tredje förklarar den i en kommentar. Se C3-uppföljningarnas punkt 7.
- [x] **Frivillig onboarding** — **klar 2026-10-15** (System → Kom igång + kortet på Översikten) — en guide för nya användare/installationer som går att hoppa över.
- [ ] **Förbättra produktionsplaneringen** — omfattning ej specad än.
- [ ] **Förbättra kalkylverktygen** — omfattning ej specad än (bygger vidare på Kalkyler och påslag nedan).
- [x] **Frivillig exempeldata** — **klar 2026-10-15** (System → Exempeldata) — en funktion som på begäran skapar exempelprodukter med operationer och strukturer, exempelkunder och exempelleverantörer.
- [ ] **Förbättrad artikel- och strukturimport** — omfattning ej specad än (bygger vidare på import-export.md-paketen ovan).
- [ ] **Förbättrad kundimport** — omfattning ej specad än.
- [ ] **Förbättrad leverantörsimport** — omfattning ej specad än.
- [ ] **Förbättrad lagerplatshantering** — omfattning ej specad än.
- [ ] **Redigerbar Översikt** — användaren ska kunna välja vad startsidan Översikt (dashboarden) visar. Omfattning ej specad än.
- [ ] **Filtrering av arbetslistan i stämpelterminalen** — möjlighet att filtrera listan över arbeten i terminalen (i dag finns bara sökfältet **Sök order**). Omfattning ej specad än.
- [ ] **Pågående arbete när den instämplade är frånvarande** — hur ska en öppen stämpling på ett arbete hanteras när den som är instämplad blir frånvarande (sjuk, ledig, glömt stämpla ut)? Omfattning ej specad än.
- [x] **Kalkyler och påslag** (L) — **klar 2026-09-01** (NOTES.md punkt 1). Fem etapper: (1) halvfabrikatsposten `semi_finished_cost` + `multi_level` genom hela kedjan (migration 0084, som bär HELA featurens schema inkl. fyra enumvärden — parallella grenar får annars konflikt i drizzles journal), plus `cost-figures.ts` som serverns enda TVK/SVK-auktoritet eftersom härledningen låg handrullad på fem ställen; (2) **opt-in flernivåkalkyl** — kryssrutan *Räkna om underliggande nivåer* kostar tillverkade halvfabrikat ur deras egen struktur och rutt, en rad per halvfabrikat till dess **TVK** (inte SVK — Affo och generellt påslag ska träffa en gång, på toppen), utan MO-påslag, med kaskadens antal så ställtiden fördelas rätt; cykel/djup/saknad struktur faller TILLBAKA med varning i stället för att kasta; (3) **materialkällan Verklig kostnad** i efterkalkylen — glidande medelpris vid förbrukningstillfället härlett ur `mo_consumption`-transaktionerna (`mo_material_consumptions.created_at` är frisläppstidpunkten och duger inte); (4) **prisåterföring** — *Sätt standardpris* (TVK/st) och *Sätt försäljningspris* i Kalkylspecifikationen, serverhärledda, avrundade till 4 dec före skrivning så historikraden inte dubbleras; (5) **marginal/TB** på artikelkortet, offert-/orderradsformulären, kundorderkortets summering och nya `/rapporter/marginal`. Genomgående regel: saknad kalkyl = **okänd** kostnad, aldrig 0 — summeringar mäter mot den omsättning som faktiskt har kalkyl. Påslagens granularitet lämnades medvetet global (användarens val).
- [x] **G1 Audit log / status_history** (M) — **klar 2026-08-30.** Audit-loggning i alla moduler: statusövergångar + radändringar (kompakt före/efter) i sales/purchase/invoice/manufacturing/stock-count/auth/system, hemlighetsmaskering i inställningsloggen (bara nyckelnamn), utkastfakturors rader omnycklas till FA-numret vid utfärdande. Läsvyn: admin-sidan **Händelselogg** (`/system/handelselogg`, filter + CSV) och **Historik**-sektioner på KO-/IO-/TO-/faktura-/leverantörsfakturakorten. Medvetet ologgat (kodkommentarer): stämpelvägen (golvbrus) och rena lagertransaktioner (`stock_transactions` är redan sitt eget facit). Kvarvarande minors: detaljformens två varianter (changedFields vs before/after), svagt negativtest för stämpelvägen, fakturaradernas artikelnr-uppslag saknar 403-CSV-test.

Mindre uppföljningar från granskningarna — **alla sex avbetade i städsvepet 2026-08-30** (grenarna `stadsvep-webb`/`stadsvep-lego`/`stadsvep-utleverans`):

- [x] Lego-restbehov: inleveransen sätter operationen klar först när ackumulerat antal täcker TO:ns orderantal — en kortad IO-rad lämnar restbehovet kvar i Behovsberäkningen.
- [x] **Ställpris** redigerbart i IO-kortets radformulär (på lego-rader).
- [x] Filter **Alla/Artiklar/Lego** i Behovsberäkningen.
- [x] Utleveransen fick listan **"Levererbara ordrar"** + artikelsökning + rikare träffrader (spegling av inleveransen).
- [x] Operationsimporten läser kolumnen **Packinstruktion** (>1000 tecken = radfel).
- [x] Fakturaunderlagslistan: ren lego-IO visar orderns uppdateringsdatum som mottagningsdatum (dokumenterad approximation).

## Beslut

- Löneunderlag exporteras som **PAXml** (funkar mot Visma Lön, Hogia, Kontek, Agda, Fortnox Lön).
- Ekonomi = **full redovisning inbyggd** (kontoplan, verifikat, huvudbok, momsrapport — inte bara SIE-export).
