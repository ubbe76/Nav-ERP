# System & inställningar

**System** i sidomenyn är endast synlig för administratörer och samlar systemomfattande inställningar.

## Kom igång

**System → Kom igång** är checklistan för en ny installation. Så länge något steg är kvar visas den också överst på **Översikten** för administratörer, med hur många av de nio stegen som är klara. Stegen bockas av av sig själva när uppgifterna finns i systemet:

- **Företagsinformation** — när företagets namn och organisationsnummer är ifyllda.
- **Användare** — när det finns minst en aktiv användare till.
- **Artiklar**, **Kunder och leverantörer** och **Resurser** — när registren har innehåll. Till dess finns en länk till **Skapa exempeldata** för den som vill prova med ett påhittat företag.
- **Betalnings- och leveransvillkor** — när det finns minst ett av varje (leveransvillkoren kan förifyllas med Combiterms under Grunddata).
- **Nummerserier** — det enda steget du bockar av själv, med **Markera som granskade** när du har kontrollerat prefix och nästa nummer.
- **Räkenskapsår och kontoplan** — när det finns ett räkenskapsår och konton (kontoplanen kan förifyllas med BAS).
- **E-post** — när en SMTP-server är inställd.

**Dölj checklistan** på Översikten gömmer den för dig (andra administratörer ser den fortfarande). Under System → Kom igång tar **Visa på Översikten** fram den igen, och **Dölj på Översikten** gömmer den därifrån. När alla steg är klara försvinner den av sig själv.

## Användare

**System → Användare** hanterar inloggningskonton. Det första kontot skapas via `/register` (se [Komma igång](/hjalp/komma-igang)); därefter skapar en administratör nya konton här med namn, e-post, lösenord och roll (**Administratör** eller **Användare**) och **Behörighetsgrupp** (se [Behörighetsgrupper](#behorighetsgrupper)). Endast administratörer ser System-menyn. Listans kolumn **Behörighetsgrupp** visar gruppens namn, **Alla (administratör)** för administratörer och **Ingen åtkomst** för den som saknar grupp.

Att stänga av ett konto (status **Avstängd**) räcker för de flesta fall — kontot kan inte logga in men syns kvar i listan. För att helt bli av med ett konto finns knappen **Ta bort användare** längst ned när man redigerar en användare (dold för det egna kontot — man kan inte ta bort sig själv). Ett bekräftelsemeddelande visas: "Ta bort användaren \<namn\>? Kontot försvinner ur listan och kan inte logga in, men historiken (ordrar, verifikat m.m.) behåller sin signatur." Raderingen är mjuk: kontot försvinner ur listan och kan inte längre logga in, men allt kontot en gång skapat eller attesterat behåller sin signatur, och e-postadressen kan återanvändas för ett nytt konto. Den sista aktiva administratören kan varken stängas av eller tas bort.

## Behörighetsgrupper

**System → Behörighetsgrupper** styr vilka delar av systemet en användare kommer åt. En grupp har en **Kod**, ett **Namn** och en lista **Rättigheter**; varje användare tillhör högst en grupp, som väljs i fältet **Behörighetsgrupp** på användaren. Administratörer har alltid allt och behöver ingen grupp, och **System** är bara för administratörer — ingen grupp kan ge åtkomst dit. Skapa en grupp med **+ Ny behörighetsgrupp**, ändra den genom att klicka på raden och spara med **Spara grupp**.

Rättigheterna är en fast lista:

- Under **Menyer**: **Artiklar**, **Inköp**, **Försäljning**, **Tillverkning**, **Lager**, **Ekonomi** och **Rapporter**. En meny ger rätt att ändra i hela modulen. Dessutom kan alla som har minst en meny *läsa* i andra moduler när de behöver det — artikelval, kunder, leverantörer och uppgifter på andra modulers ordrar. Sidorna i en annan modul öppnas däremot bara med den modulens meny: en länk till en sida du inte får öppna (t.ex. ett ordernummer från en annan modul på ett kort eller på **Översikt**) visas som vanlig text, och knappar som skulle ändra i en annan modul — t.ex. **Skapa tillverkningsorder** på kundorderraden, som kräver **Tillverkning** — visas inte. **Ekonomi** och **Rapporter** kan därmed ges till andra än administratörer, och länkarna **Verifikat F-…**/**L-…** på faktura- och betalningskort visas för den som kan öppna Ekonomi.
- Under **Verkstad**: **Stämpelterminal**, **Artikelöversikt** och **Tillverkningsorder (läsläge)**. De är verkstadsprofilen — för den som bara ska stämpla och titta. Den som enbart har verkstadsrättigheter ser inga priser: standardkostnad, försäljningspris och legopriser döljs. Den som har minst en meny ser dem som vanligt.

Vissa rättigheter ingår i en meny: **Tillverkning** innefattar **Stämpelterminal** och **Tillverkningsorder (läsläge)**, och **Artiklar** innefattar **Artikelöversikt**. Formuläret visar dem som "ingår i ...".

Vid uppgraderingen skapades två grupper. **Alla moduler** (kod ALLA: Artiklar, Inköp, Försäljning, Tillverkning och Lager) fick alla befintliga användare som inte är administratörer, så ingen tappade åtkomst. **Verkstad** (kod VERKSTAD) är den färdiga verkstadsprofilen med de tre verkstadsrättigheterna.

En ändring av en grupp gäller direkt — användarna behöver inte logga in igen.

En användare utan grupp (**Ingen åtkomst**) når bara hjälpen och sidan **Ingen behörighet**. Rollen **Arbetsledare** ger inte i sig åtkomst till modulerna: för att nå **Attestering** och **Löneunderlag** måste arbetsledaren också ha en grupp med **Tillverkning**. Personalregistret (**Tillverkning → Personal**) och dess uppgifter är bara för administratörer och för arbetsledare vars grupp har **Tillverkning**; terminalen och TO-kortet ser bara anställningsnummer och namn.

### Ta bort grupp

**Ta bort grupp** finns längst ned när man redigerar en grupp. Används gruppen inte av någon användare visas inget extra fält — efter bekräftelsen "Ta bort behörighetsgruppen \<kod\>?" tas gruppen bort direkt. Används gruppen av någon användare visas fältet **Flytta användarna till (vid borttagning)**, och du måste först välja en grupp där; användarna flyttas då dit. Utan val avvisas borttagningen.

## Företagsinformation

**System → Företagsinformation** innehåller företagets namn, organisationsnummer, adress/postnummer, kontaktuppgifter och webbplats, samt **företagslogotyp** (uppladdning, max 2 MB). Uppgifterna används på dokument som inköpsorder och ordererkännande.

Här finns också betalnings- och registreringsuppgifterna **VAT-nummer**, **Säte**, **Bankgiro**, **Plusgiro**, **Bank**, **BIC/SWIFT**, **IBAN** och kryssrutan **Godkänd för F-skatt**. De ifyllda uppgifterna skrivs ut i **sidfoten på alla utgående dokument** — förfrågan, inköpsorder, offert och orderbekräftelse — tillsammans med organisationsnumret, telefonen, e-posten och webbplatsen; tomma fält utelämnas. Interna dokument (plocklistan och TO-utskriften) får ingen sidfot.

Längst ner finns **Speditörer** — företagets egna kundnummer hos olika speditörer (t.ex. "vårt DHL-konto 12345"). **+ Ny speditör** väljer en speditör ur [speditörsregistret](/hjalp/grunddata) och anger företagets kundnummer där; varje speditör kan bara läggas till en gång. Numret används på inköpssidan: när **Frakt på vårt konto** är ikryssad på en inköpsorder eller förfrågan och den valda speditören finns i listan, skrivs "Vårt kundnr" ut bredvid speditören på dokumentet (se [Inköp](/hjalp/inkop)).

## Fraktinställningar

**System → Frakt** (bara administratörer) styr transportbokningen via Sendify, som används på [Försändelser](/hjalp/forsaljning#frakt). Kortet **Sendify** har fälten:

- **Aktiverad** — slår på funktionen; utan den visas ingen **Boka transport**.
- **Miljö** — **Sandlåda** (test) eller **Produktion**.
- **API-nyckel** — skapas i Sendify under Settings → API. Nyckeln visas aldrig igen: ett tomt fält behåller den sparade (fältet visar **Nyckel sparad**) och **Ta bort nyckel** raderar den.
- **Avsändarkontakt**, **Telefon** och **E-post** — avsändarens kontaktuppgifter. Adressen hämtas från [Företagsinformation](#foretagsinformation); har adressen flera rader skickas den andra raden som avsändarens adressrad 2; tom telefon eller e-post ger företagets.
- **Påslag (%)** och **Påslag (kr)** — läggs på Sendifys pris och bildar **Kundpris** på försändelsen.
- **Bekräfta prisändring över (%)** — standard 5. Har priset ändrats mer än så sedan valet sparades krävs en bekräftelse vid bokning.
- **Fraktartikel** — artikeln (normalt av typen Tjänst) som frakten faktureras som: på fakturans fraktrader, se [Frakt på fakturan](/hjalp/forsaljning#frakt-pa-fakturan), och som fraktraden **Lägg till frakt** lägger på offerten/kundordern, se [Frakt på offert och order](/hjalp/forsaljning#frakt-pa-offert-och-order). Utan fraktartikel går det att hämta priser men inte att lägga till frakten, och inga fraktrader föreslås i fakturadialogen.
- **Spårningsintervall** — hur ofta spårningen körs automatiskt: **Varje timme**, **Var fjärde timme** eller **Dagligen**, se [Spårning](/hjalp/forsaljning#sparning). Under fältet visas **Senaste spårningskörning** (eller **Spårningen har inte körts ännu**).

Spara med **Spara**. Under **Upphämtningstider** kryssas varje veckodag som har upphämtning med tider **Från**/**Till**; en dag utan kryss har ingen upphämtning. Röda dagar i helgdagslistan har aldrig upphämtning, medan en kortdag räknas som en vanlig dag. Spara med **Spara upphämtningstider**.

Under **Fraktprodukter** testar **Testa anslutning** nyckeln i fältet **API-nyckel** mot vald **Miljö** utan att spara den; är fältet tomt testas den sparade nyckeln. **Hämta transportörsprodukter** fyller listan över transportörer och produkter (**Transportör**, **Produkt**). Listan fylls också på när priser hämtas på en försändelse.

## Bank

Under **System → Bank** väljer du företagets bank och fyller i uppgifterna banken kräver i betalfilerna. Nav gör betalfiler (pain.001) för leverantörsbetalningar och läser bankens avier (camt.054) för inbetalningar och bekräftade utbetalningar. Filerna laddas upp och ner i internetbankens filöverföring. Ett avtal om filöverföring med banken krävs.

- **Bank** — Handelsbanken, SEB, Swedbank eller Nordea. Varje bank har sin variant av ISO 20022, och Nav anpassar filen efter den.
- **Avtals-ID / kund-ID** — fältets namn följer banken: Swedbank *Avtals-ID för betalfil (t.ex. 123456789123B001)*; Handelsbanken *Organisationsnummer eller Handelsbankens kundnummer* (lämnas fältet tomt används organisationsnumret); SEB *Avtals-ID / kund-ID hos SEB*; Nordea *Signer-ID (högst 13 siffror)* och, om banken begär det, *CCM-avtals-ID (frivilligt)*. Mellanslag och bindestreck tas bort när du sparar.
- **Debiteringskonto** — kontot betalningarna dras från, ur **Företagsinformation**. Swedbank tar bara företagets **bankgiro** (debitering från IBAN utan bankgiro är inte dokumenterad av Swedbank, så den vägen finns inte). Handelsbanken tar IBAN, Nordea IBAN eller plusgiro och SEB IBAN eller bankgiro.

Listan *Saknas för att kunna skapa betalfiler* visar vad som fattas — även ett debiteringskonto i Företagsinformation som är ogiltigt (fel kontrollsiffra, eller IBAN som inte är svenskt) samt t.ex. **Ort saknas i Företagsinformation** (Swedbank kräver ort från november 2026).

Prova den första betalfilen i bankens testverktyg innan den skarpa betalningen: Swedbank Validex eller SEB Test Bench. SEB-profilen är inte verifierad mot SEB:s egen specifikation och visar en varning tills den är det.

**Kända begränsningar hos Swedbank.** Betalningar till andra konton än bankgiro (bankkonto, plusgiro, IBAN) som saknar OCR- eller meddelandereferens får en nyckel som Nav räknar ut ur innehållet (en kontrollsumma) i stället för bankens referens, och förhandsgranskningen av avin visar en varning för raden.

## Nummerserier

**System → Nummerserier** styr numreringen av ordrar, förfrågningar och fakturor:

| Serie | Prefix (standard) |
|---|---|
| Inköpsorder | IO- |
| Kundorder | KO- |
| Tillverkningsorder | TO- |
| Förfrågan | FO- |
| Faktura | FA- |
| Följesedel | FS- |
| Försändelse | FR- |
| Leverantörsfaktura | LF- |
| Betalning | BET- |
| Utbetalning | UTB- |
| Inventering | INV- |
| Anläggning | AN- |
| Betalfil | BO- |
| Kundnummer | (inget prefix) |
| Leverantörsnummer | (inget prefix) |

Prefix, **nästa nummer** och antal siffror (nollutfyllnad) kan ändras per serie. Nästa nummer delas ut när posten skapas — utom fakturanumret, som delas ut när fakturan **utfärdas** (se [Fakturor](/hjalp/forsaljning#fakturor)), inte när den skapas som utkast.

Serien **Kundnummer** (startar på 1001, utan prefix) används av kundregistret: en ny kund utan manuellt ifyllt kundnummer får nästa nummer härifrån. Serien **Leverantörsnummer** (startar på 5001, utan prefix) fungerar likadant för leverantörsregistret: en ny leverantör utan manuellt ifyllt leverantörsnummer får nästa nummer härifrån. Manuellt satta nummer stäms inte av mot respektive serie — sätter du t.ex. 1050 eller 5050 för hand kan serien så småningom hinna ikapp numret. Den stegar då automatiskt vidare till nästa lediga nummer i stället för att krocka, förbi upp till fem tagna nummer i rad. Är sex eller fler tagna i en obruten följd behöver du justera seriens **nästa nummer** för hand här.

## Exempeldata

**System → Exempeldata** skapar ett påhittat företag att prova systemet med: en tillverkare av rostfri storköksinredning. Knappen **Skapa exempeldata** lägger in

- fem resurser (Laserskärning, Kantpressning, Svetsning, Slipning, Montering) i produktionsgrupperna Plåtverkstad och Montering,
- tre leverantörer med leverantörskatalog och ett staffelpris, och fyra kunder — en med leveransadress och en med kontaktperson,
- råvaror och köpkomponenter med lagersaldo i lagerplatserna Råvarulager och Komponentlager,
- halvfabrikaten Bänkskiva, Underrede och Hyllplan och fantomartikeln Benpaket med struktur och operationer, och tre arbetsbord med försäljningspris.

Alla artiklar har standardpris, så kalkylen och marginalen ger rimliga siffror direkt. Inga ordrar skapas — lägg en kundorder på ett arbetsbord, skapa en tillverkningsorder eller kör behovsberäkningen för att prova flödena.

Exempeldata kan bara skapas på en tom installation: så fort det finns artiklar, kunder, leverantörer eller resurser är knappen avstängd och sidan säger vilket register som inte är tomt. Betalningsvillkor, artikelgrupper och enheter som redan finns med samma kod eller samma namn återanvänds, liksom produktionsgrupper med samma kod och lagerplatser med samma namn. Exempeldatan kan inte tas bort automatiskt — vill du börja om från en tom databas installerar du om.

## Integrationer

**System → Integrationer** hanterar **API-klienter** för externa system, t.ex. en produktkonfigurator som skapar offerter programmatiskt. Skapa en klient så genereras klient-ID och en **hemlighet som bara visas en gång** — kopiera den direkt. Klienten autentiserar med OAuth2 client credentials mot API:t.

### Rättigheter och kund

Varje klient får bara göra det du ger den rätt till. Välj rättigheter med kryssrutorna när du skapar klienten (**+ Ny klient**) eller med **Ändra** i listan:

| Rättighet | Ger klienten |
|---|---|
| **Läsa konfiguratorn** | Läsa publicerade mallar och räkna fram pris på ett val |
| **Läsa priser** | Fråga vad en artikel kostar för en kund (`GET /price-quote`), och räkna fram en konfiguration med kundens pris (`customerId` i `…/evaluate`) — utan den rättigheten räknar konfiguratorn bara mallens eget pris |
| **Skapa offert** | Lägga offerter (`POST /quotes`) |
| **Bekräfta order** | Lägga bekräftade order (`confirm: true`) och bekräfta en offert (`POST /sales-orders/{id}/confirm`) |
| **Läsa struktur** | Läsa en artikels struktur (`GET /articles/{id}/bom`) |

Tre **förval** fyller i rättigheterna:

- **Hemsida** — Läsa konfiguratorn och Skapa offert. Välj också en **kund**, t.ex. en kund "Webbförfrågningar", så hamnar hemsidans offerter där.
- **Återförsäljare** — Läsa konfiguratorn, Läsa priser, Skapa offert och Bekräfta order. Välj återförsäljarens egen kund.
- **Intern** — alla rättigheter och ingen kund, för ett eget system.

En klient som är knuten till en **kund** får bara skapa offert, fråga pris (även i konfiguratorn) och bekräfta order för den kunden; allt annat nekas. Den får heller **aldrig sätta priset själv**: Nav räknar à-pris och rabatt för varje rad ur kundens priskedja (kundpris, prislista, rabatt och, för konfigurerade rader, konfiguratorns pris), och en rad med `unitPrice` eller `discountPercent` avvisas. En intern klient utan kund får skicka egna priser. **Hemsida** och **Återförsäljare** går inte att spara utan kund. Utan kund får klienten agera för alla kunder. Ändringar gäller direkt, även för token klienten redan har hämtat.

Klienter som skapades före 2026-10-15 har alla rättigheter och ingen kund och markeras **Full åtkomst** i listan — begränsa dem med **Ändra** till det de behöver.

### Konfigurator-API

Ett externt system (t.ex. en produktkonfigurator på webben) kan läsa artikelmallar och lägga offerter med konfigurerade rader. Alla anrop går mot `/api/v1` och kräver en token.

**Token.** Skapa en API-klient ovan och hämta en token med klient-ID och hemlighet. Skicka sedan `Authorization: Bearer <accessToken>` på varje anrop:

```
POST /api/v1/oauth/token
{ "clientId": "…", "clientSecret": "…" }
→ { "accessToken": "…", "tokenType": "Bearer", "expiresIn": 3600 }
```

**Vilka mallar syns.** Bara mallar där kryssrutan **Visa i API** är ikryssad på artikelns flik [Konfigurator](/hjalp/artiklar#konfigurator) — och bara på aktiva artiklar. En opublicerad eller inaktiv mall svarar 404 `configurator-template-not-found` på mallanropet och på `evaluate` (samma svar som för en mall som inte finns), och en offertrad med `configuration` på den svarar 409 `configurator-not-published` (*Mallen 63000 är inte publicerad för API:t*). Regeln gäller bara externa klienter; inloggade användare i webben påverkas inte.

**1. Lista mallar** — `GET /api/v1/configurator/templates?search=&limit=&offset=` ger `{ rows, total }`, sorterat på artikelnummer:

```
{ "rows": [ { "articleId": "…", "articleNumber": "63000", "name": "Diskbänksskåp",
              "mode": "variants", "basePrice": 1000,
              "groups": [ { "code": "LOCK", "name": "Lås", "kind": "choice", "required": true } ] } ],
  "total": 1 }
```

**2. Hämta en mall** — `GET /api/v1/configurator/{artikel-id}` ger valgrupperna med det en kundvy behöver. Regler, strukturrader, operationer, kostnader och interna id:n lämnar aldrig systemet; vilka alternativ som är valbara och vilka gränser som gäller får du av `evaluate`.

```
{ "articleId": "…", "articleNumber": "63000", "name": "Diskbänksskåp", "mode": "variants", "basePrice": 1000,
  "groups": [
    { "code": "FARG", "name": "Färg", "kind": "choice", "required": false, "unit": null,
      "min": null, "max": null, "step": null, "default": "RD", "priceAdd": 0, "pricePerUnit": 0, "priceBaseValue": 0,
      "values": [ { "code": "RD", "name": "Röd", "priceAdd": 0 }, { "code": "BL", "name": "Blå", "priceAdd": 100 } ] },
    { "code": "BREDD", "name": "Bredd", "kind": "number", "required": true, "unit": "mm",
      "min": 500, "max": 2000, "step": null, "default": null, "priceAdd": 0, "pricePerUnit": 0.5, "priceBaseValue": 500, "values": [] } ] }
```

**3. Utvärdera ett val** — `POST /api/v1/configurator/{artikel-id}/evaluate` med `{ "selection": { "FARG": "BL", "BREDD": 1200 }, "customerId": "…", "quantity": 2 }` (`customerId` och `quantity` är valfria, antal 1 om det utelämnas; med kund räknas kundens priser och rabatter, och en okänd kund ger 404 `customer-not-found`). Svaret säger om valet är giltigt och vad det kostar:

```
{ "valid": true, "key": "…",
  "groups": [ { "code": "FARG", "value": "BL", "defaulted": false, "availableValueCodes": ["RD","BL"], "errors": [] },
              { "code": "BREDD", "value": 1200, "min": 500, "max": 2000, "errors": [] } ],
  "errors": [],
  "price": { "base": 1000, "additions": [ { "groupCode": "FARG", "label": "Blå", "amount": 100 } ],
             "unitPrice": 1450, "discountPercent": 0, "source": "…" },
  "warnings": [] }
```

Ett ogiltigt val ger `valid: false` med meddelanden i `errors` och per grupp — samma meddelanden som dialogen **Konfigurera** visar.

**Förval, tomma val och `null`.** I `selection` gäller: en **saknad nyckel** betyder att gruppens förval används (finns inget förval är gruppen tom). `null` betyder att gruppen medvetet lämnas **tom** — förvalet används inte. För en obligatorisk grupp ger det felet att gruppen måste fyllas i; för en ja/nej-grupp betyder `null` Nej. Det är samma sak som att välja **— Välj —** i dialogen **Konfigurera**.

**4. Lägg en offert** — `POST /api/v1/quotes` är det vanliga offertanropet, men en rad kan ha `configuration` i stället för (eller utöver) ett eget à-pris:

```
POST /api/v1/quotes
{ "customerId": "…", "rows": [ { "articleId": "<mallens id>", "quantity": 2,
                                  "configuration": { "selection": { "FARG": "BL", "BREDD": 1200 } } } ] }
```

- Mall i läget **Variantartiklar**: systemet hämtar variantartikeln för valet eller skapar den (med mallens grundenhet och alternativa enheter, så `unitId` kan vara en av mallens enheter) och raden blir en vanlig rad på varianten, med variantens pris. Samma val igen återanvänder samma artikel. Två rader med samma variant på en order ger 409 `row-variant-exists`.
- Mall i läget **Beställningsvara**: raden ligger kvar på mallen och sparar valen, etiketterna och prisuppdelningen. Samma mall kan ligga flera gånger med olika val.
- Pris och rabatt kommer ur utvärderingen (kundens priser och staffel räknas in) om raden inte anger eget `unitPrice`. Ett val som lämnade en valfri grupp tom behåller den tom även om mallen senare får ett förval; blir gruppen obligatorisk måste raden ändras med **Ändra konfiguration**.

**Felkoder.**

| Kod | Status | Betyder |
|---|---|---|
| `validation-failed` | 400 | Anropet har fel form (fältfelen ligger i `issues`), eller `{artikel-id}` i adressen är inte ett uuid |
| `configurator-template-not-found` | 404 | Mallen finns inte, eller är inte publicerad/aktiv för en extern klient |
| `configurator-not-published` | 409 | Offertraden pekar på en opublicerad eller inaktiv mall |
| `configurator-invalid-configuration` | 400 | Valet är ogiltigt; meddelandena ligger i `details` |
| `configurator-variant-not-derivable` | 409 | Valet är giltigt men varianten kan inte byggas ur mallens struktur (*Kombinationen kan inte tillverkas — kontrollera mallens struktur i Nav*); rättas i Nav, se förhandsgranskningen under [Varianter](/hjalp/artiklar#varianter) |
| `configurator-variant-too-long` | 400 | Variantens artikelnummer eller benämning blir för lång |
| `configurator-not-variant-mode` / `configurator-not-to-order-mode` | 409 | Mallen bytte läge under anropet — hämta mallen igen |
| `article-is-template` | 409 | En rad utan `configuration` pekar på en mall i läget **Variantartiklar** (*63000 är en mall — välj en variant*) |
| `configuration-required` | 409 | En rad utan `configuration` pekar på en mall i läget **Beställningsvara** |
| `configuration-not-allowed` | 400 | En rad har `configuration` men artikeln är ingen mall |
| `price-not-found` | 400 | Raden saknar `unitPrice` och inget pris hittades (mallen saknar grundpris och kunden har inget eget pris) |
| `invalid-unit` | 400 | `unitId` är varken artikelns grundenhet eller en av dess alternativa enheter |
| `delivery-address-not-found` | 400 | `deliveryAddressId` hör inte till kunden |
| `row-variant-exists` | 409 | Samma variant ligger redan på ordern |
| `configurator-variant-number-taken` / `configurator-variant-number-race` | 409 | Variantens artikelnummer är upptaget (nu eller av ett samtidigt anrop) — försök igen |
| `customer-not-found` | 404 | `customerId` finns inte |
| `client-scope-missing` | 403 | Klienten saknar rättigheten för anropet (se [Rättigheter och kund](#rattigheter-och-kund)) |
| `client-customer-mismatch` | 403 | Klienten är knuten till en annan kund än den i anropet |
| `client-price-not-allowed` | 403 | En klient knuten till en kund skickade `unitPrice` eller `discountPercent` — utelämna dem, Nav räknar priset |

**Prisets källa.** `price.source` i `evaluate` säger var grundpriset kommer ifrån: `customer_article` (kundpris på artikeln), `customer_group` (kundpris på artikelgruppen), `price_list` (kundens prislista), `customer_discount` (kundens rabatt på grundpriset) eller `article` (artikelns försäljningspris). `null` betyder att mallen saknar grundpris och att inget kundpris finns — då är `unitPrice` också `null` och offertraden måste ange eget `unitPrice`.

## Inställningar

**System → Inställningar** styr systembeteenden:

- **Tillåt flera samtidiga stämplingar** — styr bara om knappen **Stämpla in på arbete** erbjuds i hemvyn när personen redan har en öppen stämpling sedan tidigare. Av: "hemvyn i stämpelterminalen erbjuder inte att stämpla in på ännu ett arbete så länge en stämpling redan är öppen — stämpla ut den först". På: "knappen erbjuds ändå". Markerar man flera operationer och trycker **Starta valda** i operationsväljaren blir man instämplad på alla samtidigt oavsett detta läge (se [Stämpelterminalen](/hjalp/terminal)).
- **Visa revisioner på dokument** — på: aktiv artikelrevision och ritningsnummer med aktiv ritningsrevision (från artikelkortets flik Revisioner, se [Artiklar](/hjalp/artiklar)) skrivs ut per orderrad på offert, orderbekräftelse, inköpsorder och förfrågan. Av som standard.
- **Visa orderns revision på dokument** — på: orderns revision skrivs ut direkt efter ordernumret (t.ex. **Inköpsorder IO-1024 / 2**) på offert, orderbekräftelse och inköpsorder. På som standard.
- **ATF-intjäning (minuter per vecka)** — systemstandarden för ATF-intjäning; kan överstyras per anställd på personalkortet (se [Personal & tid](/hjalp/personal-tid)).
- **Tillåten överleverans på inköpsorder (%)** — hur mycket mer än beställt antal som får tas emot på en inköpsorderrad, i procent av radens beställda antal. Med 10 får en rad på 100 st ta emot högst 110 st totalt. **0** = aldrig mer än beställt (standard). **Tomt fält** = ingen gräns. Fältet sparas när du lämnar det. Se [Inleverans](/hjalp/inkop#inleverans).
- **Materialbrist vid rapportering** — vad som händer när en rapportering drar mer ingående material än vad som finns. Tillgängligt är artikelns **totala saldo på alla lagerplatser**; tjänsteartiklar kontrolleras aldrig. Valet sparas direkt när du ändrar det. **Ingen kontroll** (standard) — ingen kontroll görs, saldot kan bli negativt. **Varning** — du får frågan "Det saknas ingående delar: … Rapportera ändå?" innan något sparas; svarar du **Rapportera ändå** bokförs rapporteringen, annars sparas ingenting. **Spärr** — rapporteringen nekas med en lista över de delar som saknas. Gäller utstämpling i terminalen, **Slutför operation**, **Slutför order** och **Förbruka** på tillverkningsordern samt inleverans av legorader. Se [Materialbrist vid rapportering](/hjalp/tillverkning#materialbrist-vid-rapportering).

### Lön & PAXml

I panelen **Lön & PAXml** ställs tidkoderna som skrivs ut i löneunderlagsexporten (PAXml) och den dagliga övertidströskeln:

- **Tidkod arbetad tid** — löneartskoden för vanlig arbetad tid. Standard: **TID**.
- **Tidkod övertid** — löneartskoden för övertid på schemalagd arbetsdag. Standard: **ÖT1**.
- **Tidkod övertid helg** — löneartskoden för övertid utanför schemat, t.ex. helgarbete. Standard: **ÖT2**.
- **Tidkod ATF-uttag** — löneartskoden för uttag ur ATF-banken. Standard: **ATF**.
- **Tidkod övertid – komptid** — löneartskoden för övertid på schemalagd arbetsdag som ersätts som komptid i stället för utbetalning. Standard: **ÖK1**.
- **Tidkod övertid helg – komptid** — löneartskoden för övertid utanför schemat som ersätts som komptid. Standard: **ÖK2**.
- **Övertidströskel (minuter per dag)** — hur många minuter arbetad tid får överstiga schemat innan det räknas som övertid en schemalagd dag. 0 = varje minut utöver schemat räknas som övertid.

Tidkoderna måste matcha lönesystemets egen löneartstabell — stäm av dem med er lönekonsult innan första löneunderlagsexporten. Ett tomt fält sparas som systemets standardkod.

## Kalkyler

**System → Kalkyler** styr hur för- och efterkalkylen räknar. Inställningarna är systemomfattande och gäller alla artiklar. Kalkylerna körs från artikelkortets flik **Kalkyl** och från tillverkningsordern (se [Artiklar](/hjalp/artiklar) och [Tillverkning](/hjalp/tillverkning)).

### Materialkostnad hämtas från

- **Standardpris** — artikelns **Standardkostnad** på fliken Allmänt. Leverantörspriser påverkar inte kalkylen. Detta är standardvalet.
- **Aktiv leverantörs pris** — priset hos **huvudleverantören** i artikelns leverantörskatalog på fliken Inköp. Saknar komponenten huvudleverantör, eller saknar huvudleverantören pris, används artikelns standardkostnad i stället och kalkylen visar en varning om vilka rader som föll tillbaka. Saknas båda räknas raden som 0 kr, också med varning.
- **Verklig kostnad** — vad materialet **faktiskt kostade**: glidande medelpris vid förbrukningstillfället, härlett ur lagertransaktionerna på samma sätt som metoden *Vägt snitt* i [Lagervärdering](/hjalp/lager#lagervardering). Varje uttag värderas till medelpriset just innan det gjordes, och orderns uttag av samma artikel vägs ihop efter antal — en senare inleverans till annat pris ändrar alltså inte vad ett redan gjort uttag kostade.
  - Valet gäller **bara efterkalkylen**. Förkalkylen har inga förbrukningar att prissätta och använder standardpriset, med en varning som säger det.
  - Material som förbrukats innan artikeln fått någon prissatt inleverans har inget medelpris att räkna på. Sådana rader faller tillbaka på standardpriset, med varning.
  - Samma artikel uttagen vid flera operationer får **ett gemensamt** à-pris: lagerloggen registrerar vilken tillverkningsorder uttaget hörde till, inte vilken operation.

### Leverantörspris vid staffel

Gäller bara när materialkostnaden hämtas från **Aktiv leverantörs pris** och huvudleverantören har staffelsteg i leverantörskatalogen (se [Artiklar](/hjalp/artiklar#inkop)):

- **Grundpris** — katalogradens **Pris**, priset för antal 1, används oavsett hur mycket kalkylen behöver av komponenten. Detta är standardvalet.
- **Staffelpris för kalkylantalet** — steget som matchar komponentens **totala antal i kalkylen** används: kalkylantalet × antal per styck i strukturen (i flernivåkalkylen antalet på den nivån), och i efterkalkylen det antal som faktiskt förbrukades på ordern. Under lägsta steget gäller grundpriset.

### Påslagen

Påslagen anges i procent och får ha decimaler. Alla är 0 % från början, vilket innebär att försäljningspriset blir exakt lika med självkostnaden tills du fyller i något.

- **MO-påslag (%)** — materialomkostnader. Läggs på det direkta materialet.
- **LO-påslag (%)** — legoomkostnader. Läggs på legokostnaden. **Artiklar av typen Tjänst i artikelns struktur räknas som legoarbete** och hamnar alltså under Legokostnad i stället för under Direkt material.
- **Affo-påslag (%)** — affärsomkostnader. Läggs på tillverkningskostnaden.
- **Generellt påslag (%)** — läggs sist, på självkostnaden, och ger försäljningspriset.

**TO-påslaget sätts inte här.** Tillverkningsomkostnaden är knuten till resursen som utför operationen och anges som **TO-påslag (%)** per arbetsplats under **Tillverkning → Resurser**.

**Halvfabrikat bär inget påslag.** Kör du en förkalkyl med **Räkna om underliggande nivåer** (se [Artiklar](/hjalp/artiklar#kalkyl)) kostas varje tillverkat halvfabrikat ur sin egen struktur och rutt, och kommer in i kedjan som en egen post **Halvfabrikat**. Den posten får varken MO- eller LO-påslag: påslagen är redan pålagda en nivå ned, inne i halvfabrikatets egen tillverkningskostnad. Affo-påslaget och det generella påslaget träffar den däremot — de är företagsgemensamma och ska ligga på den färdiga artikeln exakt en gång.

### Så räknas försäljningspriset

Panelen **Så räknas försäljningspriset** längst ned på sidan visar hela kedjan med ett räkneexempel som uppdateras medan du skriver:

```
  Direkt material (dM)
+ MO-påslag  %  × dM
+ Direkt lön (dL)
+ TO-påslag     × dL   (per arbetsplats)
+ Legokostnad
+ LO-påslag  %  × legokostnaden
+ Halvfabrikat        (inget påslag)
─────────────────────────────────
= Tillverkningskostnad (TVK)
+ Affo-påslag %  × TVK
─────────────────────────────────
= Självkostnad (SVK)
+ Generellt påslag % × SVK
─────────────────────────────────
= Försäljningspris
```

Samma kedja visas som **Kalkylspecifikation** på artikelkortets flik Kalkyl efter varje beräkning.

Spara med **Spara**. Ändrade inställningar gäller från nästa beräkning — redan sparade kalkyler räknas aldrig om.

Varje kalkyl sparar dessutom de inställningar den kördes med, och visar dem överst i **Kalkylspecifikation**. En kalkyl från i våras går alltså att förstå även efter att du ändrat påslagen sedan dess.

## E-post (SMTP)

Under **E-post (SMTP)** på inställningssidan anges den externa SMTP-server som används för utgående e-post — förfrågningar, inköpsordrar, offerter och orderbekräftelser skickas som PDF-bilagor direkt från respektive kort (se [Inköp](/hjalp/inkop) och [Försäljning](/hjalp/forsaljning)).

Fälten är:

- **Server (host)** och **Port** — SMTP-serverns adress och port.
- **Anslutning** — **STARTTLS (port 587)** eller **SSL/TLS (port 465)**; följ e-postleverantörens anvisningar.
- **Användarnamn** och **Lösenord** — inloggningen hos leverantören. Lösenordet visas aldrig efter att det sparats; lämna fältet tomt för att behålla det sparade. Observera att lösenordet lagras i klartext i databasen.
- **Avsändarnamn** och **Avsändaradress** — hur avsändaren visas hos mottagaren, t.ex. "Företaget AB" och order@foretaget.se. Lämnas avsändaradressen tom används användarnamnet.

Spara med **Spara** och kontrollera sedan inställningarna med **Skicka testmejl** — ange en mottagaradress och klicka på knappen; resultatet visas direkt.

## E-postlogg

**System → E-postlogg** listar alla utgående mejl med tid, dokument, mottagare, ämne och status (**Skickat** eller **Misslyckat** — håll muspekaren över statusen för felmeddelandet). Varje utskick loggas, även misslyckade. Sök på mottagare eller ämne och filtrera på dokumenttyp och status.

Misslyckade utskick får knappen **Skicka om**, som gör om utskicket med samma mottagare, ämne och meddelande men med dokumentets aktuella innehåll — rätta först SMTP-inställningarna (eller orsaken till felet) och skicka sedan om. Dokumentkolumnen länkar till respektive order/förfrågan/faktura (en betalningspåminnelse länkar till fakturan den gäller), och varje kort visar också sina egna utskick under rubriken **E-post**. Ett omskick av en **betalningspåminnelse** är alltid avgiftsfritt, se [Försäljning → Skicka påminnelse](/hjalp/forsaljning#skicka-paminnelse).

## Säkerhetskopiering

**System → Säkerhetskopiering** (endast administratörer). Knappen **Ladda ner säkerhetskopia** skapar och laddar ner en **komplett** kopia av hela databasen som en komprimerad SQL-fil (`.sql.gz`). Kopian innehåller allt i systemet — artiklar, lager, ordrar, förfrågningar, leverantörsfakturor, kunder/leverantörer, uppladdade ritningar, leverantörsfakturornas underlag, företagslogotypen och inställningar (all data ligger i databasen, inget lagras separat på disk).

Använd den för att ta en kopia innan du gör något riskabelt, eller för att flytta hela ERP:en till en annan server. Filen innehåller alla uppgifter, inklusive lösenord och andra hemligheter — **förvara den säkert**.

Utöver knappen körs en **automatisk säkerhetskopia varje natt** på servern. Den ligger på samma disk som databasen, så bokföringslagens krav på att räkenskapsinformationen bevaras betryggande i sju år uppfylls av den **krypterade externa säkerhetskopian** med årsarkiv — den sätts upp på servern, se [Krypterad extern backup](/hjalp/drift-utveckling#krypterad-extern-backup-bokforingslagen). Att **återställa** en kopia (eller flytta systemet till en ny server) görs på servern enligt drift-guiden — se [Drift & utveckling](/hjalp/drift-utveckling).

## Händelselogg

**System → Händelselogg** (endast administratörer) listar statusövergångar och radändringar i hela systemet — vem gjorde vad och när. Varje rad visar tid, användare, typ (t.ex. Kundorder, Inköpsorder, Tillverkningsorder, Faktura, Leverantörsfaktura, Verifikat, Användare, Inställningar), id (dokumentets nummer, t.ex. KO2500123 eller LF2500045), händelse (t.ex. Bekräftad, Ändrad, Borttagen, Bokförd) och en kort detalj — en radändring visas som **fält: gammalt värde → nytt värde**.

Sök på id eller händelse, och filtrera på typ, användare och tidsperiod (Från/Till). **Exportera CSV** laddar ner den filtrerade listan. En rad utan användare (kolumnen visar **System**) kommer från en systemhändelse utan inloggad användare bakom sig; en användare som senare tagits bort visas fortfarande med sitt namn.

Varje kort (kundorder, inköpsorder, tillverkningsorder, faktura, leverantörsfaktura) har också en egen sektion **Historik** längst ner som visar just den ordningens/fakturans egna händelser — samma information, förfiltrerad till kortet. Precis som händelseloggen visas sektionen bara för administratörer.

Ändringar av **Inställningar** loggas med vilka fält som ändrades, aldrig värdena — ett SMTP-lösenord loggas bara som att fältet ändrades, aldrig med det gamla eller nya lösenordet.
