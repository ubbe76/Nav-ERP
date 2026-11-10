import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  listEinvoiceReceptionLogQuerySchema,
  peppolLookupSchema,
  setEinvoiceReceptionSchema,
  testEinvoiceConnectionSchema,
  updateEinvoiceSettingsSchema,
  validateEinvoiceDocumentSchema,
} from "@navet/shared";
import { InvoiceNotFoundError } from "../../sales/service/invoice.service.js";
import { CustomerNotFoundError } from "../../sales/service/sales.service.js";
import { contentDisposition } from "../../system/service/content-disposition.js";
import { errorBody } from "../../system/service/error-body.js";
import { EInvoiceProviderError } from "../service/einvoice-provider.js";
import { EinvoiceWebhookPublicUrlError, type EinvoiceSettingsService } from "../service/einvoice-settings.service.js";
import type { EinvoiceReceiveService } from "../service/einvoice-receive.service.js";
import type { EinvoiceWebhookService } from "../service/einvoice-webhook.service.js";
import type { EinvoiceStatusService } from "../service/einvoice-status.service.js";
import type { EinvoiceService } from "../service/einvoice.service.js";
import {
  EinvoiceAlreadySentError,
  EinvoiceDocumentInvalidError,
  EinvoiceNotAllowedError,
  EinvoiceOtherEnvironmentError,
  EinvoiceKeyEnvironmentMismatchError,
  EinvoiceNotConfiguredError,
  EinvoiceProviderRejectedError,
  EinvoiceProviderUnauthorizedError,
  EinvoiceProviderUnavailableError,
  EinvoiceReceiveBusyError,
  EinvoiceReceptionNotFoundError,
  EinvoiceReceptionRegisteredElsewhereError,
  EinvoiceTransmissionNotFoundError,
  fromProviderError,
} from "../service/einvoice.errors.js";
import { InvalidStatusTransitionError } from "../../purchase/service/purchase.service.js";

// One mapping for every e-invoice route — domain error → status + envelope
// (with the extra fields the web needs: reason, problems, fieldErrors).
export function mapEinvoiceError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof EInvoiceProviderError) return mapEinvoiceError(reply, fromProviderError(err));
  if (err instanceof EinvoiceProviderRejectedError) {
    return reply.code(400).send({ ...errorBody(err), fieldErrors: err.fieldErrors, requestId: err.requestId });
  }
  if (err instanceof EinvoiceProviderUnauthorizedError) return reply.code(409).send({ ...errorBody(err), requestId: err.requestId });
  if (err instanceof EinvoiceProviderUnavailableError) return reply.code(502).send({ ...errorBody(err), requestId: err.requestId });
  if (err instanceof EinvoiceDocumentInvalidError) return reply.code(400).send({ ...errorBody(err), problems: err.problems });
  if (err instanceof EinvoiceNotConfiguredError) return reply.code(409).send({ ...errorBody(err), reason: err.reason });
  if (err instanceof EinvoiceWebhookPublicUrlError) return reply.code(409).send(errorBody(err));
  // Mottagning: 409 with the Swedish text (the page shows it and opens the
  // Migreringskod field).
  if (err instanceof EinvoiceReceptionRegisteredElsewhereError) return reply.code(409).send({ ...errorBody(err), message: err.message, requestId: err.requestId });
  if (err instanceof EinvoiceReceiveBusyError || err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
  if (err instanceof EinvoiceReceptionNotFoundError) return reply.code(404).send(errorBody(err));
  if (err instanceof EinvoiceNotAllowedError) return reply.code(409).send({ ...errorBody(err), reason: err.reason });
  if (err instanceof EinvoiceAlreadySentError) return reply.code(409).send(errorBody(err));
  if (err instanceof EinvoiceOtherEnvironmentError) return reply.code(409).send({ ...errorBody(err), environment: err.environment });
  if (err instanceof EinvoiceKeyEnvironmentMismatchError) {
    return reply.code(400).send({ ...errorBody(err), keyEnvironment: err.keyEnvironment, environment: err.selected });
  }
  if (err instanceof EinvoiceTransmissionNotFoundError || err instanceof InvoiceNotFoundError || err instanceof CustomerNotFoundError) {
    return reply.code(404).send(errorBody(err));
  }
  return null;
}

const ADMIN = { config: { access: ["admin"] as const } };

const idParams = z.object({ id: z.string().uuid() });

// E-faktura (Peppol via B2Brouter). Registered under registerModule with
// read: office, write: forsaljning; the settings routes are admin-only
// overrides. /invoices/:id/einvoice and /customers/:id/peppol-lookup are
// served from here (subresource from the owning module, like
// /sales-orders/:id/freight from shipping).
export async function einvoiceRoutes(
  app: FastifyInstance,
  opts: { settings: EinvoiceSettingsService; service: EinvoiceService; status: EinvoiceStatusService; receive: EinvoiceReceiveService }
) {
  const { settings, service, status, receive } = opts;

  async function run<T>(reply: FastifyReply, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (err) {
      const sent = mapEinvoiceError(reply, err);
      if (sent) return sent;
      throw err;
    }
  }

  // --- Inställningar (admin) ---

  app.get("/einvoice-settings", ADMIN, async () => settings.view());
  app.patch("/einvoice-settings", ADMIN, async (req, reply) => {
    const input = updateEinvoiceSettingsSchema.parse(req.body);
    return run(reply, () => settings.update(input, req.user!.id));
  });
  // Saves nothing: the form sends accountId + accountName back on Spara.
  app.post("/einvoice-settings/test", ADMIN, async (req, reply) =>
    run(reply, () => settings.testConnection(testEinvoiceConnectionSchema.parse(req.body ?? {})))
  );
  // Statusbesked direkt: register / remove the access point's web hook.
  app.post("/einvoice-settings/webhook", ADMIN, async (req, reply) => run(reply, () => settings.registerWebhook(req.user!.id)));
  app.delete("/einvoice-settings/webhook", ADMIN, async (req, reply) => run(reply, () => settings.unregisterWebhook(req.user!.id)));
  app.post("/einvoice-settings/validate", ADMIN, async (req, reply) => {
    const { invoiceId } = validateEinvoiceDocumentSchema.parse(req.body);
    return run(reply, () => service.validateDocument(invoiceId));
  });

  // --- Mottagning (admin) ---

  // Ta emot e-faktura: { enabled, migrationCode? } ⇒ the reception view.
  // 409 einvoice-reception-registered-elsewhere (message = the Swedish
  // text), 409 einvoice-not-configured, 502 on a transport failure.
  app.post("/einvoice-settings/reception", ADMIN, async (req, reply) => {
    const input = setEinvoiceReceptionSchema.parse(req.body);
    return run(reply, () => settings.setReception(input, req.user!.id));
  });
  // Hämta nu: one run right away ⇒ { imported, duplicates, unreadable };
  // 409 einvoice-receive-busy while a run holds the lease.
  app.post("/einvoice-settings/receive-now", ADMIN, async (_req, reply) => run(reply, () => receive.receiveNow()));
  // Mottagningslogg: { rows } newest first, never the XML.
  app.get("/einvoice-settings/reception-log", ADMIN, async (req) => ({
    rows: await receive.receptionLog(listEinvoiceReceptionLogQuerySchema.parse(req.query).limit),
  }));
  // Markera som hanterad: an unreadable document is acknowledged at the
  // access point and closed (outcome dismissed) — the invoice is registered
  // another way. 409 invalid-status-transition unless unreadable, 404 when
  // the row is unknown, 502 when the access point cannot be reached.
  app.post("/einvoice-settings/reception-log/:id/dismiss", ADMIN, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    return run(reply, () => receive.dismiss(id, req.user!.id));
  });

  // --- Fakturakortet ---

  app.get("/invoices/:id/einvoice", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    return run(reply, () => service.getInvoiceView(id));
  });

  // Skicka e-faktura
  app.post("/invoices/:id/einvoice", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    return run(reply, async () => reply.code(201).send(await service.send(id, req.user!.id)));
  });

  // Uppdatera status: polls the access point now, answers with the row.
  app.post("/einvoice-transmissions/:id/refresh", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    return run(reply, async () => {
      await status.pollTransmission(id);
      return (await service.getTransmission(id))!;
    });
  });

  app.get("/einvoice-transmissions/:id/document", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    return run(reply, async () => {
      const doc = await service.getDocument(id);
      if (!doc) throw new EinvoiceTransmissionNotFoundError(id);
      reply.header("Content-Type", "application/xml; charset=utf-8");
      reply.header("Content-Disposition", contentDisposition(doc.filename, "attachment"));
      return reply.send(doc.content);
    });
  });

  // --- Kundkortet: Kontrollera mottagaren i Peppol ---

  app.post("/customers/:id/peppol-lookup", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const input = peppolLookupSchema.parse(req.body ?? {});
    return run(reply, () => service.lookup(id, input));
  });
}

// The public receiver of B2Brouter's status changes (spec 2026-11-05):
// registered OUTSIDE the authenticated scope — the signature is the
// authentication. Its own scope parses every body as raw bytes, since the
// HMAC covers the exact bytes sent; 64 kB is far more than a state-change
// event needs.
export const EINVOICE_WEBHOOK_BODY_LIMIT = 64 * 1024;

export async function einvoiceWebhookRoutes(app: FastifyInstance, opts: { webhook: EinvoiceWebhookService }) {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: EINVOICE_WEBHOOK_BODY_LIMIT }, (_req, body, done) => done(null, body));
  app.post("/einvoice/webhook", { bodyLimit: EINVOICE_WEBHOOK_BODY_LIMIT }, async (req, reply) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const header = req.headers["x-b2brouter-signature"];
    const code = await opts.webhook.receive(raw, typeof header === "string" ? header : undefined);
    return reply.code(code).send();
  });
}
