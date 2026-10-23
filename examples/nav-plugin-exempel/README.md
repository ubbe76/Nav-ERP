# Exempeltillägg för Nav ERP

Ett litet tillägg i en enda fil (`server.mjs`, bara Nodes inbyggda moduler) som visar hur ett tillägg ser ut:

- **Manifest** — `/nav-plugin.json`: en sida **Händelser** under Lager, en flik **Saldo (exempel)** på artikelkortet och prenumeration på `article.created`, `article.updated` och `sales_order.confirmed`.
- **Händelser** — `/webhook` kontrollerar `Nav-Signature` (HMAC-SHA256, max fem minuter gammal) och sparar de senaste 50 händelserna i minnet.
- **Sida och flik** — `/sida` och `/flik` kontrollerar kontexttokenet (`nav_context`), använder Navs stilmall `plugin-kit.css`, följer användarens tema och berättar sin höjd för Nav. Fliken läser artikelns lagersaldo med tilläggets API-nyckel.
- **Avskild från Nav** — sidorna skickar `Content-Security-Policy: frame-ancestors <Navs adress>` så att bara Nav kan rama in dem, tar bara emot `postMessage` som kommer från `window.parent` **och** Navs ursprung, och skickar bara till Navs ursprung (aldrig `"*"`).

Ingen riktig data används; allt ligger i minnet och försvinner när programmet stoppas.

## Starta

Kräver Node 20 eller nyare.

```sh
cd examples/nav-plugin-exempel
NAV_URL=http://localhost:4000 NAV_PUBLIC_URL=http://localhost:3000 node server.mjs
```

Tillägget måste köras på en **annan värd** än Nav — en annan port räcker inte, eftersom webbläsaren skickar Navs inloggningscookie till alla portar på samma värd (Nav vägrar installera en sådan adress och vägrar öppna tilläggets sidor). Lokalt går det att öppna Nav på `http://localhost:3000` och låta tillägget lyssna på `http://127.0.0.1:4300`, vilket är förvalen här. I drift ska tillägget ha en **egen domän**, inte en underdomän till Navs (t.ex. `tillagg.example.net` när Nav är `erp.example.se`, inte `tillagg.example.se`).

| Variabel | Betydelse |
| --- | --- |
| `HOST` | Adressen servern lyssnar på (`127.0.0.1`). |
| `PORT` | Port (4300). |
| `NAV_URL` | Navs API, som tillägget når server-till-server (`http://localhost:4000`). |
| `NAV_PUBLIC_URL` | Navs adress i webbläsaren (`http://localhost:3000`): stilmallen hämtas därifrån, och bara den adressen får rama in sidorna och skicka meddelanden till dem. |
| `NAV_API_KEY` | API-nyckeln som visades vid installationen. |
| `NAV_WEBHOOK_SECRET` | Webbhookshemligheten som visades vid installationen. |
| `FAIL_WEBHOOKS` | `1` svarar 500 på alla händelser — för att prova **Skicka igen**. |

## Installera i Nav

1. Starta tillägget (utan nycklarna först).
2. Gå till **System → Tillägg** och välj **Installera tillägg…**.
3. Ange **Adress**, t.ex. `http://127.0.0.1:4300`, och välj **Hämta manifest**. Adressen måste ha en annan värd än Nav.
4. Granska rättigheterna och välj **Installera**.
5. Kopiera **API-nyckel** och **Webbhookshemlighet** — de visas bara nu.
6. Starta om tillägget med `NAV_API_KEY` och `NAV_WEBHOOK_SECRET` satta.
7. Välj **Skicka testhändelse** på tilläggets kort för att se att leveransen fungerar. Sidan **Händelser** finns nu under **Lager**, och fliken **Saldo (exempel)** på artikelkorten.

Mer om manifest, signatur, kontexttoken och `postMessage` finns i manualens kapitel **Tillägg**.
