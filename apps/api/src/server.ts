import { buildApp } from "./app.js";
import { startScheduler } from "./scheduler.js";

const port = Number(process.env.API_PORT ?? 4000);

const app = buildApp();

// Fastify refuses addHook once listening, so the hook is registered up front
// and reads the scheduler through a reference assigned after listen succeeds.
let scheduler: ReturnType<typeof startScheduler> | null = null;
let pluginScheduler: ReturnType<typeof startScheduler> | null = null;
let recurringScheduler: ReturnType<typeof startScheduler> | null = null;
let invoiceMailScheduler: ReturnType<typeof startScheduler> | null = null;
app.addHook("onClose", async () => {
  app.pluginDispatcher.disableKick();
  await Promise.all([scheduler?.stop(), pluginScheduler?.stop(), recurringScheduler?.stop(), invoiceMailScheduler?.stop()]);
  await app.pluginDispatcher.idle();
});

// A fresh installation: print the one-time code /register asks for. Plain
// console output, not the JSON log, so it reads well in `docker compose logs`.
// A code fixed with SETUP_CODE is already in .env and is not echoed.
// Never fatal: a failed lookup must not take the server down after listen.
async function printSetupCode() {
  try {
    if (!(await app.setup.needsSetup())) return;
  } catch (err) {
    app.log.error(err, "could not check whether the first user exists");
    return;
  }
  const { code, fromEnvironment } = app.setup.code;
  const line = "=".repeat(64);
  console.log(
    [
      line,
      "Nav|ERP har inga användare än. Skapa det första kontot",
      "(administratör) på /register med engångskoden.",
      fromEnvironment
        ? "Engångskoden är SETUP_CODE i .env."
        : `Engångskod: ${code}   (en ny kod skrivs vid varje omstart)`,
      line,
    ].join("\n")
  );
}

app
  .listen({ port, host: "0.0.0.0" })
  .then(() => {
    // Background jobs run only in the real server process, never in tests.
    scheduler = startScheduler(
      [
        { name: "freight_tracking", run: () => app.freightTracking.runTrackingIfDue() },
        // E-faktura: polls the live transmissions at the access point.
        { name: "einvoice_status", run: () => app.einvoiceStatus.runStatusIfDue() },
        // Aviseringar: the daily sammanställning, once per recipient and
        // working day after Skicka sammanställningen klockan.
        { name: "alert_digest", run: () => app.alertDigest.runDigestIfDue() },
      ],
      { log: (msg, extra) => app.log.error(extra ?? {}, msg) }
    );
    // Tillägg: the webhook outbox, on its own 15-second tick; an emit also
    // nudges a run shortly after its commit.
    pluginScheduler = startScheduler(
      [{ name: "plugin_webhooks", run: () => app.pluginDispatcher.run() }],
      { intervalMs: 15_000, firstDelayMs: 15_000, log: (msg, extra) => app.log.error(extra ?? {}, msg) }
    );
    app.pluginDispatcher.enableKick();
    // Återkommande verifikat: once an hour, every active post's due months.
    // The run log's unique (post, month) is the reservation, so a second
    // process ticking at the same time creates nothing twice.
    recurringScheduler = startScheduler(
      [{ name: "recurring_verifications", run: () => app.recurringVerifications.runDue() }],
      { intervalMs: 60 * 60_000, firstDelayMs: 90_000, log: (msg, extra) => app.log.error(extra ?? {}, msg) }
    );
    // Fakturaskanning: the e-mail box, on a one-minute tick so Intervall
    // (1–60 minutes) holds; the job itself checks the interval, whether the
    // box is turned on and its lease (invoice_scan_mail_lease_until).
    invoiceMailScheduler = startScheduler(
      [{ name: "invoice_scan_mail", run: () => app.invoiceScanMail.runMailIfDue() }],
      { intervalMs: 60_000, firstDelayMs: 75_000, log: (msg, extra) => app.log.error(extra ?? {}, msg) }
    );
    return printSetupCode();
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
