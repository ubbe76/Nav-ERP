// Exempeltillägg till Nav ERP — en enda fil, inga beroenden (node:http, node:crypto).
//
// Visar de fyra delarna av ett tillägg:
//   1. nav-plugin.json   – manifestet Nav hämtar vid installationen
//   2. /webhook          – tar emot händelser och verifierar Nav-Signature
//   3. /sida och /flik   – en sida under Lager och en flik på artikelkortet,
//                          visas i en iframe och verifierar kontexttokenet
//   4. API-anrop         – läser lagersaldo med tilläggets API-nyckel
//
// Starta:  NAV_URL=http://localhost:4000 NAV_API_KEY=nav_plg_... NAV_WEBHOOK_SECRET=... node server.mjs
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 4300);
// Navs API (server till server). Nav-adressen webbläsaren använder för CSS:en kan skilja sig.
const NAV_URL = (process.env.NAV_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const NAV_PUBLIC_URL = (process.env.NAV_PUBLIC_URL ?? NAV_URL).replace(/\/+$/, "");
const NAV_API_KEY = process.env.NAV_API_KEY ?? "";
const NAV_WEBHOOK_SECRET = process.env.NAV_WEBHOOK_SECRET ?? "";
// Sätt FAIL_WEBHOOKS=1 för att svara 500 på alla händelser (prova Skicka igen i Nav).
const FAIL_WEBHOOKS = process.env.FAIL_WEBHOOKS === "1";
const PLUGIN_KEY = "exempel";
const MAX_EVENTS = 50;

/** De senaste händelserna, nyast först. Bara i minnet. */
const events = [];

const manifest = {
  format: "nav-plugin",
  version: 1,
  key: PLUGIN_KEY,
  name: "Exempeltillägg",
  description: "Visar händelser och lagersaldo. Ett minimalt tillägg att utgå från.",
  author: "Nav ERP",
  permissions: ["artiklar", "lager"],
  readOnly: true,
  webhook: { path: "/webhook", events: ["article.created", "article.updated", "sales_order.confirmed"] },
  pages: [
    {
      key: "handelser",
      title: "Händelser",
      description: "Senaste händelserna som Nav skickat till exempeltillägget.",
      module: "lager",
      path: "/sida",
    },
  ],
  tabs: [{ key: "saldo", title: "Saldo (exempel)", on: "article", path: "/flik" }],
};

// --- Webhook: Nav-Signature: t=<unix>,v1=<hex hmac-sha256(secret, "<t>.<kropp>")> ---

export function verifySignature(secret, rawBody, header, nowSeconds = Date.now() / 1000, toleranceSeconds = 300) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(",").map((part) => part.split("=", 2)));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) return false;
  // Vägra gamla signaturer (skydd mot återspelning).
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest();
  const given = Buffer.from(parts.v1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// --- Kontexttoken: HS256-JWT signerad med en nyckel härledd ur webbhookshemligheten ---

// Nav signerar inte kontexttokenet med själva hemligheten (den signerar händelserna)
// utan med HMAC-SHA256(hemlighet, "nav-context") som hex-text (64 tecken); texten, som
// UTF-8-byte, är HS256-nyckeln. Händelsernas signatur använder hemligheten direkt.
const contextKey = (secret) => createHmac("sha256", secret).update("nav-context").digest("hex");

const b64urlJson = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

export function verifyContextToken(secret, token, nowSeconds = Date.now() / 1000) {
  if (!secret || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = b64urlJson(parts[0]);
    if (header.alg !== "HS256") return null;
    const expected = createHmac("sha256", contextKey(secret)).update(`${parts[0]}.${parts[1]}`).digest();
    const given = Buffer.from(parts[2], "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const claims = b64urlJson(parts[1]);
    if (claims.aud !== PLUGIN_KEY || typeof claims.exp !== "number" || claims.exp < nowSeconds) return null;
    return claims;
  } catch {
    return null;
  }
}

// --- HTML ---

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Gemensam sidmall: länkar Navs stilmall, sätter tema och talar med Nav via postMessage.
function layout(claims, body) {
  return `<!doctype html>
<html lang="sv" data-theme="${escapeHtml(claims.theme)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Exempeltillägg</title>
<link rel="stylesheet" href="${escapeHtml(NAV_PUBLIC_URL)}/api/v1/plugin-kit.css">
<style>body { padding: 16px; } .nav-card { margin-bottom: 16px; }</style>
</head>
<body>
${body}
<script>
  // Fråga Nav om aktuellt tema, och följ det när användaren byter.
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const msg = event.data;
    if (msg && msg.type === "nav:theme") {
      document.documentElement.setAttribute("data-theme", msg.id);
      let style = document.getElementById("nav-theme-css");
      if (!style) { style = document.createElement("style"); style.id = "nav-theme-css"; document.head.appendChild(style); }
      style.textContent = msg.css;
    }
  });
  window.parent.postMessage({ type: "nav:theme" }, "*");
  // Berätta hur hög sidan är (används av flikar; sidor fyller ytan).
  const report = () => window.parent.postMessage({ type: "nav:resize", height: Math.ceil(document.body.getBoundingClientRect().height) }, "*");
  new ResizeObserver(report).observe(document.body);
  report();
</script>
</body>
</html>`;
}

function eventsTable() {
  if (events.length === 0) return `<p class="nav-muted">Inga händelser ännu.</p>`;
  const rows = events
    .map(
      (e) => `<tr><td>${escapeHtml(e.occurredAt.slice(0, 19).replace("T", " "))}</td><td>${escapeHtml(e.type)}</td><td>${escapeHtml(e.data?.number ?? e.data?.id)}</td></tr>`
    )
    .join("");
  return `<table class="nav-table"><thead><tr><th>Tid (UTC)</th><th>Händelse</th><th>Post</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function pageHtml(claims) {
  return layout(
    claims,
    `<h1>Hej ${escapeHtml(claims.name)}</h1>
<p class="nav-muted">Du har ${claims.readOnly ? "endast läsrätt" : "skrivrätt"} i Nav. Tillägget ser det på kontexttokenet men får inga API-rättigheter av det.</p>
<div class="nav-card"><h2>Senaste händelserna</h2>${eventsTable()}</div>
<p><button class="nav-button" onclick="window.parent.postMessage({ type: 'nav:navigate', path: '/artiklar' }, '*')">Gå till artiklarna</button></p>`
  );
}

async function tabHtml(claims) {
  const entity = claims.entity;
  if (!entity || entity.type !== "article") return layout(claims, `<p class="nav-muted">Fliken gäller artikelkortet.</p>`);
  let content;
  try {
    // API-anropet använder tilläggets nyckel – inte besökarens rättigheter.
    const res = await fetch(`${NAV_URL}/api/v1/stock/balances?articleId=${encodeURIComponent(entity.id)}&limit=100`, {
      headers: { authorization: `Bearer ${NAV_API_KEY}` },
    });
    if (!res.ok) throw new Error(`Nav svarade ${res.status}`);
    const { rows } = await res.json();
    content =
      rows.length === 0
        ? `<p class="nav-muted">Inget saldo på artikeln.</p>`
        : `<table class="nav-table"><thead><tr><th>Lagerplats</th><th>Saldo</th></tr></thead><tbody>${rows
            .map((r) => `<tr><td>${escapeHtml(r.locationName)}</td><td>${escapeHtml(r.quantityOnHand)}</td></tr>`)
            .join("")}</tbody></table>`;
  } catch (err) {
    content = `<p>Kunde inte läsa saldot: ${escapeHtml(err.message)}</p>`;
  }
  return layout(claims, `<div class="nav-card"><h2>Saldo per lagerplats</h2>${content}</div>`);
}

// --- Server ---

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("För stor"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://tillagg.local");
  const send = (status, type, body) => {
    res.writeHead(status, { "content-type": `${type}; charset=utf-8` });
    res.end(body);
  };
  try {
    if (req.method === "GET" && url.pathname === "/nav-plugin.json") {
      return send(200, "application/json", JSON.stringify(manifest));
    }
    if (req.method === "POST" && url.pathname === "/webhook") {
      // Verifiera mot den OBEARBETADE kroppen – inte mot omserialiserad JSON.
      const raw = await readBody(req);
      if (!verifySignature(NAV_WEBHOOK_SECRET, raw, req.headers["nav-signature"])) {
        return send(401, "text/plain", "Ogiltig signatur");
      }
      if (FAIL_WEBHOOKS) return send(500, "text/plain", "Misslyckas med flit (FAIL_WEBHOOKS=1)");
      const event = JSON.parse(raw);
      // Nav kan skicka samma händelse flera gånger – id:t gör det idempotent.
      if (!events.some((e) => e.id === event.id)) {
        events.unshift(event);
        events.length = Math.min(events.length, MAX_EVENTS);
      }
      return send(200, "text/plain", "ok");
    }
    if (req.method === "GET" && (url.pathname === "/sida" || url.pathname === "/flik")) {
      const claims = verifyContextToken(NAV_WEBHOOK_SECRET, url.searchParams.get("nav_context"));
      if (!claims) return send(401, "text/html", "<p>Sidan öppnas från Nav.</p>");
      return send(200, "text/html", url.pathname === "/sida" ? pageHtml(claims) : await tabHtml(claims));
    }
    send(404, "text/plain", "Finns inte");
  } catch (err) {
    send(500, "text/plain", `Fel: ${err.message}`);
  }
});

// Importerad av ett test? Starta bara när filen körs direkt.
if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, () => {
    console.log(`Exempeltillägget lyssnar på http://localhost:${PORT} (manifest: /nav-plugin.json)`);
    if (!NAV_API_KEY || !NAV_WEBHOOK_SECRET) console.log("OBS: NAV_API_KEY och NAV_WEBHOOK_SECRET saknas – ange dem efter installationen och starta om.");
  });
}
