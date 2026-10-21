import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  peppolLookupSchema,
  testEinvoiceConnectionSchema,
  updateEinvoiceSettingsSchema,
  validateEinvoiceDocumentSchema,
} from "@navet/shared";
import { InvoiceNotFoundError } from "../../sales/service/invoice.service.js";
import { CustomerNotFoundError } from "../../sales/service/sales.service.js";
import { contentDisposition } from "../../system/service/content-disposition.js";
import { errorBody } from "../../system/service/error-body.js";
import { EInvoiceProviderError } from "../service/einvoice-provider.js";
import type { EinvoiceSettingsService } from "../service/einvoice-settings.service.js";
import type { EinvoiceStatusService } from "../service/einvoice-status.service.js";
import type { EinvoiceService } from "../service/einvoice.service.js";
import {
  EinvoiceAlreadySentError,
  EinvoiceDocumentInvalidError,
  EinvoiceNotAllowedError,
  EinvoiceNotConfiguredError,
  EinvoiceProviderRejectedError,
  EinvoiceProviderUnauthorizedError,
  EinvoiceProviderUnavailableError,
  EinvoiceTransmissionNotFoundError,
  fromProviderError,
} from "../service/einvoice.errors.js";

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
  if (err instanceof EinvoiceNotAllowedError) return reply.code(409).send({ ...errorBody(err), reason: err.reason });
  if (err instanceof EinvoiceAlreadySentError) return reply.code(409).send(errorBody(err));
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
  opts: { settings: EinvoiceSettingsService; service: EinvoiceService; status: EinvoiceStatusService }
) {
  const { settings, service, status } = opts;

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
  app.post("/einvoice-settings/validate", ADMIN, async (req, reply) => {
    const { invoiceId } = validateEinvoiceDocumentSchema.parse(req.body);
    return run(reply, () => service.validateDocument(invoiceId));
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
