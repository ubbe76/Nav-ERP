# Tillägg

## Vad ett tillägg är

Ett **tillägg** är ett externt program som kopplas till Nav utan att Nav ändras. Det kan göra tre saker:

- **Läsa och skriva i Nav via API:t** — med en egen API-nyckel och precis de rättigheter du ger det.
- **Ta emot händelser** — Nav skickar ett litet meddelande (en *webbhook*) när till exempel en kundorder bekräftas eller en artikel ändras.
- **Visa egna sidor och flikar** — en sida i en modulmeny, eller en flik på artikel-, kund- och leverantörskortet. Tilläggets sidor ritas i Nav men körs hos tillägget.

Tillägget körs alltså på en egen adress, hos dig eller hos en leverantör. Nav kör aldrig tilläggets kod. Installation och hantering görs under **System → Tillägg** och är bara till för administratörer.

Ett tillägg ändrar aldrig sig självt: nyckeln kan inte användas mot inloggning, kontoinställningar eller **Tillägg** själva.

## Installera

1. Gå till **System → Tillägg** och välj **Installera tillägg…**.
2. Ange tilläggets **Adress** — den adress där tillägget körs, till exempel `https://tillagg.example.net`. Adressen måste vara en http- eller https-adress (utan användarnamn, frågedel eller fragment) och **ha en annan värd än Nav**. En annan port på samma värd räcker inte: webbläsaren skickar Navs inloggningscookie till alla portar på samma värd, så tillägget skulle kunna agera som den som tittar. Låt tillägget ha en egen domän, inte en underdomän till Navs (se [Säkerhet](#sakerhet)).
3. Välj **Hämta manifest**. Nav hämtar `<adress>/nav-plugin.json`. Kan tillägget inte nås härifrån väljer du i stället **Ladda upp manifest…** och pekar ut manifestfilen (adressen anges ändå).
4. Granska vad tillägget säger om sig självt: namn, beskrivning, utgivare, **Begärda rättigheter**, händelser, sidor och flikar. Eventuella varningar (till exempel okända fält) står överst.
5. Under **Rättigheter att ge tillägget** är kryssrutorna förifyllda med det tillägget begär. Det är du som bestämmer — ta bort det tillägget inte behöver. Kryssa i **Endast läsning** om tillägget inte ska få ändra något.
6. Välj **Installera**. Nav skapar tilläggets behörighetsgrupp, en teknisk användare och själva tillägget i ett svep.
7. Rutan visar nu **API-nyckel** och **Webbhookshemlighet**. **De visas bara den här gången.** Välj **Kopiera** för vardera och lägg in dem i tillägget innan du väljer **Klar**. Stänger du rutan innan frågar Nav om du har kopierat dem.

Har ett tillägg med samma nyckel redan installerats går det inte att installera igen.

## Rättigheter och Endast läsning

Varje tillägg får en egen behörighetsgrupp, **Tillägg: \<namn\>**, och en teknisk användare i den. Gruppen fungerar precis som en vanlig [behörighetsgrupp](/hjalp/system#behorighetsgrupper): en meny (till exempel **Försäljning**) ger tillägget rätt att läsa och ändra i den modulen. Läsa i andra moduler får alla med minst en meny.

På tilläggets kort under **System → Tillägg** ändrar du kryssrutorna under **Rättigheter** och väljer **Spara rättigheter**. Ändringen gäller direkt — även för händelser som redan väntar på leverans.

**Endast läsning** gör att tillägget kan läsa men aldrig ändra något via API:t (det får svaret 403 `read-only-account`), precis som kontot med samma namn under [Användare](/hjalp/system#endast-lasning).

Rättigheterna styr också vad tillägget får se i Nav:

- En **händelse** skickas bara om tilläggets grupp har den rättighet händelsen kräver (se katalogen under [Händelser](#handelser)).
- En **flik** på artikelkortet kräver **Artiklar**, på kundkortet **Försäljning** och på leverantörskortet **Inköp** — både hos tillägget och hos den som tittar.
- En **sida** visas bara för användare som får öppna modulen sidan hör till.

Manifestet *begär* rättigheter, men ger dem aldrig. När du **Uppdatera manifest** och tillägget begär något nytt läggs det inte till av sig självt; kortet visar en notering om vad som begärs men inte har getts, och du kryssar i det själv.

## Pausa och avinstallera

- **Pausa** stänger av tillägget utan att ta bort något. Dess sidor och flikar visas inte, och händelserna köas medan tillägget är pausat och levereras när du väljer **Aktivera** — inget tappas.
- **Uppdatera manifest** hämtar manifestet igen (och låter dig ändra adressen). Nav visar skillnaderna — tillkommande och försvinnande rättigheter, händelser, sidor och flikar — innan du väljer **Spara manifest**.
- **Ny API-nyckel** ersätter nyckeln direkt; den gamla slutar fungera i samma stund. Nav frågar först. Den nya nyckeln visas en gång.
- **Ny webbhookshemlighet** ersätter hemligheten (som signerar händelserna och som kontexttokenets nyckel härleds ur) på samma sätt. Tills tillägget fått den nya kan det inte verifiera något.
- **Avinstallera** tar bort tillägget, dess händelser och leveranser och behörighetsgruppen. Den tekniska användaren tas bort ur användarregistret (händelseloggen behåller dess namn), och nyckeln slutar fungera direkt. Nav frågar först.

Allt detta loggas i [Händelseloggen](/hjalp/system#handelselogg) (`plugin_installed`, `plugin_updated`, `plugin_paused`, `plugin_activated`, `plugin_key_rotated`, `plugin_secret_rotated`, `plugin_uninstalled`).

## Leveranser och felsökning

Listan **Tillägg** visar per tillägg **Status** (**Aktiv** eller **Pausad**), **Senaste leverans** och **Misslyckade (7 dagar)**. Tilläggets kort har sektionen **Leveranser** med de senaste 100 händelserna: händelse, post, tid, status (**Väntar**, **Levererad**, **Misslyckad**), antal försök och det senaste svaret eller felet.

- **Skicka testhändelse** skickar en testhändelse (`plugin.test`) direkt och visar svaret — ett snabbt sätt att se att adress, signatur och hemlighet stämmer. Testhändelsen kräver ingen rättighet och ingår inte i katalogen.
- **Skicka igen** på en misslyckad leverans försöker på nytt direkt.
- Felen är korta och aldrig själva svaret från tillägget: *Svarade 500*, *Tidsgränsen (10 s) överskreds*, *Kunde inte ansluta till tillägget*, *Omdirigering (302) följs inte* eller *Saknar rättighet* (tillägget har inte längre rättigheten till händelsen; sådana leveranser skickas aldrig och ger ingen avisering).

Tillägg som har misslyckade leveranser de senaste 7 dagarna utan en lyckad efteråt syns som aviseringen **Tillägg som inte tar emot händelser** (se [Aviseringar](/hjalp/aviseringar)).

## Manifestet

Manifestet är en JSON-fil som tillägget serverar på `<adress>/nav-plugin.json` (högst 64 kB). Exempel:

```json
{
  "format": "nav-plugin",
  "version": 1,
  "key": "lagerstatistik",
  "name": "Lagerstatistik",
  "description": "Sammanställer lagerrörelser.",
  "author": "Exempel AB",
  "homepage": "https://example.se",
  "permissions": ["artiklar", "lager"],
  "readOnly": true,
  "webhook": {
    "path": "/webhook",
    "events": ["article.updated", "sales_order.confirmed"]
  },
  "pages": [
    { "key": "oversikt", "title": "Översikt", "description": "Lagerrörelser", "module": "lager", "path": "/sida" }
  ],
  "tabs": [
    { "key": "saldo", "title": "Saldo", "on": "article", "path": "/flik" }
  ]
}
```

| Fält | Betydelse |
|---|---|
| `format`, `version` | Alltid `"nav-plugin"` och `1`. En högre version avvisas med *kräver en nyare Nav*. |
| `key` | Tilläggets nyckel: 2–40 tecken, små bokstäver a–z, siffror och bindestreck, börjar med en bokstav. Unik i Nav. |
| `name` | Namnet, högst 60 tecken. |
| `description`, `author`, `homepage` | Valfria. |
| `permissions` | Det tillägget **begär** (menyerna `artiklar`, `inkop`, `forsaljning`, `tillverkning`, `lager`, `personal`, `ekonomi`, `rapporter` och verkstadsrättigheterna). Administratören beslutar. |
| `readOnly` | `true` om tillägget bara behöver läsa. |
| `webhook` | `path` (relativ) och `events` (ur katalogen nedan). Utelämnas om tillägget inte tar emot händelser. |
| `pages` | Högst 10. `key` (unik inom tillägget), `title` (högst 40 tecken), valfri `description`, `module` (en av modulerna ovan) och `path`. |
| `tabs` | Högst 10. `key`, `title`, `on` (`article`, `customer` eller `supplier`) och `path`. |

Alla `path` är **relativa** (börjar med `/`, aldrig `//` eller en hel adress) och läggs efter tilläggets adress. Okända fält ignoreras med en varning.

## API-nyckeln

Tillägget anropar Navs API med nyckeln som huvud:

```
Authorization: Bearer nav_plg_…
```

Anropet utförs som tilläggets tekniska användare, så det kan göra precis det gruppens rättigheter och **Endast läsning** tillåter — ett anrop utanför gruppen får 403. Nyckeln fungerar inte mot `/auth/*`, `/me/*`, `/oauth/*` och `/plugins*` (403 `plugin-route-forbidden`), och ett anrop som också har en inloggningscookie avvisas. Ett pausat tillägg eller en avstängd användare får 401. Kortet visar nyckelns första tecken så att du kan känna igen den; hela nyckeln visas bara när den skapas.

## Händelser

Nav skickar en händelse som en `POST` till `<adress><webhook.path>` när något händer. Händelserna är **tunna**: bara typ, tid och en referens till posten. Hämta posten via API:t.

### Katalogen

| Händelse | Etikett | Rättighet | Sänds när |
|---|---|---|---|
| `article.created` | Artikel skapad | Artiklar | en artikel skapas, även en konfiguratorvariant |
| `article.updated` | Artikel ändrad | Artiklar | en artikel ändras (inte struktur eller beredning) |
| `customer.created` | Kund skapad | Försäljning | |
| `customer.updated` | Kund ändrad | Försäljning | |
| `supplier.created` | Leverantör skapad | Inköp | |
| `supplier.updated` | Leverantör ändrad | Inköp | |
| `quote.created` | Offert skapad | Försäljning | en offert skapas |
| `sales_order.confirmed` | Kundorder bekräftad | Försäljning | varje övergång från offert till order (även från Förlorad), och när en ny kundorder läggs |
| `sales_order.delivered` | Utleverans | Försäljning | varje följesedel (`deliveryId` och `deliveryNumber` finns i `data`) |
| `sales_order.cancelled` | Kundorder makulerad | Försäljning | en order makuleras (inte en offert) |
| `invoice.issued` | Faktura utfärdad | Försäljning | kund- och kreditfaktura |
| `invoice.paid` | Faktura betald | Försäljning | fakturan blir betald |
| `purchase_order.created` | Inköpsorder skapad | Inköp | |
| `purchase_order.received` | Inköpsorder inlevererad | Inköp | inleverans per rad (`receiptId` och `rowId` finns i `data`) |
| `manufacturing_order.created` | Tillverkningsorder skapad | Tillverkning | |
| `manufacturing_order.completed` | Tillverkningsorder klar | Tillverkning | |

Händelsen skrivs i samma transaktion som ändringen, så den skickas aldrig för något som rullades tillbaka och går inte förlorad. Prenumererar inget tillägg på en typ skrivs ingenting, och en leverans skapas bara för tillägg vars rättigheter tillåter händelsen. Importer och exempeldata skickar inga händelser.

### Kroppen

```json
{
  "id": "0b6f2c1e-6a3f-4f0e-9c0f-2f5f0f5a9a11",
  "type": "sales_order.confirmed",
  "occurredAt": "2026-10-23T08:15:00.000Z",
  "plugin": "lagerstatistik",
  "data": { "id": "6f3c…", "number": "KO-1043" }
}
```

`data.id` är postens id och `data.number` dess nummer — artikelnummer, kund- eller leverantörsnummer, ordernummer (offertens OF-nummer för `quote.created`, kundorderns nummer för de övriga `sales_order.*`), fakturanummer eller tillverkningsorderns nummer. Utleverans och inleverans gäller ordern (`id`/`number` är orderns) och har fler referenser: `sales_order.delivered` har `deliveryId` (följesedelns id) och `deliveryNumber` (följesedelns nummer), `purchase_order.received` har `receiptId` (inleveransens id) och `rowId` (orderradens id). Testhändelsen `plugin.test` pekar på tillägget självt. Ingen händelse har belopp eller personuppgifter. Rubrikerna `Nav-Event-Id` och `Nav-Event-Type` upprepar `id` och `type`. Samma händelse kan komma mer än en gång — använd `id` för att hoppa över dubbletter — och ordningen garanteras inte.

### Signaturen

Varje utskick har rubriken `Nav-Signature: t=<unix-sekunder>,v1=<hex>`, där `v1` är HMAC-SHA256 med **webbhookshemligheten** över `<t>.<kroppen>`. Verifiera mot den **obearbetade** kroppen och vägra signaturer äldre än fem minuter:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, rawBody, header, now = Date.now() / 1000) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2)));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1 || Math.abs(now - t) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest();
  const given = Buffer.from(parts.v1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

### Svar och nya försök

Svara med en 2xx-kod inom **10 sekunder**; då är händelsen levererad. Omdirigeringar följs inte. Allt annat räknas som misslyckat och försöks igen efter 1 minut, 5 minuter, 30 minuter, 2 timmar, 6 timmar och 12 timmar. Efter det sjunde försöket ger Nav upp (status **Misslyckad**) och du kan välja **Skicka igen**. Levererade och misslyckade händelser rensas efter 30 dagar.

## Sidor och flikar

Tilläggets **sidor** syns i den modulmeny de hör till, i en egen sektion **Tillägg**, och öppnas på `/tillagg/<tillägg>/<sida>`. Tilläggets **flikar** visas sist på artikel-, kund- eller leverantörskortet. Ett pausat tillägg visas inte.

Innehållet ritas i en iframe hos tillägget:

```html
<iframe src="<adress><path>?nav_context=<token>"
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads"
        referrerpolicy="no-referrer">
```

Att tillägget måste köras på en annan värd än Nav är det som gör att `allow-same-origin` tillsammans med `allow-scripts` ändå är en avskild sandlåda. Nav kontrollerar det tre gånger: när adressen anges (mot **Navs adress** under System → Inställningar och webbens adress), när en sida eller flik öppnas (mot adressen användaren har öppnat Nav på — annars 409 `plugin-same-host`), och i webbläsaren, som vägrar visa iframen om tillägget har samma värd som sidan.

### Kontexttokenet

`nav_context` är en JWT (HS256) signerad med en nyckel som härleds ur **webbhookshemligheten**: `HMAC-SHA256(hemlighet, "nav-context")` skrivet som hex-text (64 tecken) — den texten, som UTF-8, är HS256-nyckeln. I Node: `createHmac("sha256", hemlighet).update("nav-context").digest("hex")`. Händelsernas signatur använder däremot hemligheten direkt. Tokenet berättar vem som tittar — men ger **inga** API-rättigheter; API:t nås bara med tilläggets nyckel. Anspråk:

| Anspråk | Innehåll |
|---|---|
| `iss` | Navs adress (**Navs adress** under System → Inställningar), annars `nav`. |
| `aud` | Tilläggets `key`. Kontrollera den. |
| `sub`, `name` | Användarens id och namn. |
| `permissions`, `readOnly` | Användarens rättigheter och om kontot är Endast läsning. |
| `entity` | Bara på flikar: `{ "type": "article" \| "customer" \| "supplier", "id": "…" }`. |
| `theme` | Användarens tema (id), för `data-theme`. |
| `iat`, `exp` | Utfärdat och utgår (5 minuter). |

Nav hämtar tokenet med `POST /plugins/:id/context` och kroppen `{ page }` för en sida eller `{ tab, entityId }` för en flik.

Verifiera signaturen med den härledda nyckeln och kontrollera `aud` och `exp` innan du litar på något. Nav hämtar ett nytt token när sidan öppnas och skickar sedan ett färskt strax före utgång (se `nav:context` nedan).

### postMessage

Tillägget och Nav pratar via `window.parent.postMessage`. Nav lyssnar bara på meddelanden som kommer från iframens eget fönster **och** tilläggets ursprung. Gör likadant i tillägget: ta bara emot meddelanden där `event.source === window.parent` **och** `event.origin` är Navs ursprung, och skicka med Navs ursprung som mål i stället för `"*"`:

```js
const NAV_ORIGIN = "https://erp.example.se";
window.addEventListener("message", (event) => {
  if (event.source !== window.parent || event.origin !== NAV_ORIGIN) return;
  // …
});
window.parent.postMessage({ type: "nav:theme" }, NAV_ORIGIN);
```

| Tillägget skickar | Nav gör |
|---|---|
| `{ "type": "nav:resize", "height": 640 }` | Sätter flikens höjd (pixlar). Sidor fyller ytan och ignorerar den. |
| `{ "type": "nav:navigate", "path": "/artiklar" }` | Går till en sida i Nav. Bara interna sökvägar som börjar med `/` (aldrig `//`) godtas, och aldrig `/api/` eller `/_next/`. |
| `{ "type": "nav:theme" }` | Svarar `{ "type": "nav:theme", "id": "dark", "css": "…" }` med användarens tema, och skickar samma meddelande igen när temat byts. |
| `{ "type": "nav:context" }` | Svarar `{ "type": "nav:context", "token": "…", "expiresAt": "…" }` med ett giltigt token; Nav skickar också ett nytt strax före utgång. |

### plugin-kit.css

Länka Navs stilmall så ser tillägget ut som Nav i alla teman:

```html
<link rel="stylesheet" href="https://din-nav/api/v1/plugin-kit.css">
```

Sätt `data-theme` på `<html>` från `theme` i tokenet (och uppdatera det vid `nav:theme`). Stilmallen innehåller alla teman och en liten basstil som bara använder Navs färgtokens: klasserna `nav-card`, `nav-button` och `nav-button--primary`, `nav-table`, `nav-field`, `nav-badge` (med `--running`, `--delayed`, `--stopped`, `--done`) och `nav-muted`. Den är offentlig och kräver ingen inloggning.

## Säkerhet

- **Egen värd, helst egen domän.** Tillägget måste köras på en annan värd än Nav — en annan port räcker inte, eftersom webbläsarens cookies inte skiljer på portar. I drift bör tillägget ha en **egen domän** (till exempel `tillagg.example.net` när Nav är `erp.example.se`), inte en underdomän till Navs (`tillagg.example.se`): en underdomän räknas som samma webbplats och kan bland annat sätta cookies för hela domänen. För lokala prov går det att öppna Nav på `http://localhost:3000` och köra tillägget på `http://127.0.0.1:4300` — två olika värdar.
- **Bara Nav får rama in sidorna.** Låt tilläggets sidor skicka `Content-Security-Policy: frame-ancestors <Navs adress>` (till exempel `frame-ancestors https://erp.example.se`), så kan ingen annan webbplats visa dem i en iframe. Exempeltillägget gör det.
- **Kontrollera avsändaren av meddelanden.** Se [postMessage](#postmessage): både `event.source` och `event.origin`, och skicka aldrig till `"*"`.
- **Skrivanrop från andra webbplatser vägras.** Nav vägrar (403 `cross-site-request`) varje ändrande anrop (allt utom GET, HEAD och OPTIONS) som görs med en inloggningscookie och som webbläsaren märkt som kommande från en annan webbplats eller en annan värd på samma webbplats (rubriken `Sec-Fetch-Site` är `same-site` eller `cross-site`), om det inte kommer från webbens egen adress (`WEB_ORIGIN`). Det gäller även inloggning, registrering och utloggning. Ett tillägg på en grannunderdomän kan alltså inte ändra något i Nav i användarens namn. Anrop med tilläggets API-nyckel, OAuth-klienter och anrop utan rubriken (server till server) berörs inte.
- **Kontexttokenet ger inga rättigheter.** Det berättar bara vem som tittar; tillägget når API:t enbart med sin egen nyckel och sina egna rättigheter.

## Exempeltillägget

I repot finns `examples/nav-plugin-exempel/`: en enda fil, `server.mjs`, utan beroenden. Den serverar ett manifest, tar emot och verifierar händelser, visar en sida under **Lager** och en flik på artikelkortet som läser artikelns saldo med tilläggets API-nyckel. Som förval lyssnar den på `http://127.0.0.1:4300` och räknar med att Nav öppnas på `http://localhost:3000` (ändras med `NAV_PUBLIC_URL`); därifrån tar den emot meddelanden och bara den adressen får rama in sidorna. Läs `README.md` där för hur den startas och installeras — den är tänkt som utgångspunkt för ditt eget tillägg.
