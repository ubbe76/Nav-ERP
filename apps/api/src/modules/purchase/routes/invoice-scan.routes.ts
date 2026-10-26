import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createSupplierInvoiceSchema,
  INVOICE_SCAN_MAX_FILE_BYTES,
  INVOICE_SCAN_MAX_FILES_PER_UPLOAD,
  interpretInvoiceScanSchema,
  listInvoiceScanMailLogQuerySchema,
  listInvoiceScansQuerySchema,
  rejectInvoiceScanSchema,
  testInvoiceScanAiSchema,
  testInvoiceScanMailSchema,
  updateInvoiceScanSettingsSchema,
} from "@navet/shared";
import { errorBody } from "../../system/service/error-body.js";
import { contentDisposition } from "../../system/service/content-disposition.js";
import {
  InvoiceScanAiNotConfiguredError,
  InvoiceScanBusyError,
  InvoiceScanDuplicateError,
  InvoiceScanNotFoundError,
  type InvoiceScanService,
  type UploadedFile,
} from "../service/invoice-scan.service.js";
import { InvoiceScanAiTestFailedError, type InvoiceScanSettingsService } from "../service/invoice-scan-settings.service.js";
import { InvoiceScanMailTestFailedError, type InvoiceScanMailService } from "../service/invoice-scan-mail.service.js";
import { InvalidStatusTransitionError } from "../service/purchase.service.js";
import { invoiceError } from "./supplier-invoice.routes.js";

// Fakturaskanning — the Fakturainkorg's routes. Registered with
// registerModule(..., { read: office, write: ["inkop"] }) like the supplier
// invoices; the settings are admin-only overrides. Every path parameter is
// :id (uuid).

const ADMIN = { config: { access: ["admin"] as const } };

function scanError(err: unknown, reply: FastifyReply) {
  if (err instanceof InvoiceScanNotFoundError) return reply.code(404).send(errorBody(err));
  if (err instanceof InvoiceScanDuplicateError) return reply.code(409).send({ ...errorBody(err), existing: err.existing });
  if (err instanceof InvoiceScanAiTestFailedError || err instanceof InvoiceScanMailTestFailedError) {
    return reply.code(409).send({ ...errorBody(err), message: err.message });
  }
  if (
    err instanceof InvoiceScanAiNotConfiguredError ||
    err instanceof InvoiceScanBusyError ||
    err instanceof InvalidStatusTransitionError
  ) {
    return reply.code(409).send(errorBody(err));
  }
  // The conversion creates a supplier invoice: its own refusals as there.
  return invoiceError(err, reply);
}

// Every file in the multipart body (any field name), at most
// INVOICE_SCAN_MAX_FILES_PER_UPLOAD; a file over the size limit is
// truncated (throwFileSizeLimit: false) and reported, never fatal.
async function readFiles(req: FastifyRequest): Promise<UploadedFile[] | "too_many"> {
  const files: UploadedFile[] = [];
  // throwFileSizeLimit is a per-request option of @fastify/multipart's
  // runtime that its typings do not list.
  const options = { limits: { fileSize: INVOICE_SCAN_MAX_FILE_BYTES }, throwFileSizeLimit: false } as Parameters<FastifyRequest["parts"]>[0];
  for await (const part of req.parts(options)) {
    if (part.type !== "file") continue;
    const data = await part.toBuffer();
    if (files.length >= INVOICE_SCAN_MAX_FILES_PER_UPLOAD) return "too_many";
    files.push({ filename: part.filename, contentType: part.mimetype, data, truncated: part.file.truncated });
  }
  return files;
}

export async function invoiceScanRoutes(
  app: FastifyInstance,
  opts: { service: InvoiceScanService; settings: InvoiceScanSettingsService; mail: InvoiceScanMailService }
) {
  const { service, settings, mail } = opts;

  async function run<T>(reply: FastifyReply, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (err) {
      return scanError(err, reply);
    }
  }

  app.get("/invoice-scans", async (req) => service.list(listInvoiceScansQuerySchema.parse(req.query)));

  // { created: [listRow…], duplicates: [{ filename, existing: { id,
  // scanNumber, status } }], rejected: [{ filename, reason }] } — 201 when
  // something was created, else 200. Automatic AI (läge Automatiskt) on the
  // created scans starts AFTER the answer, outside any transaction.
  app.post("/invoice-scans", async (req, reply) => {
    if (!req.isMultipart()) return reply.code(400).send({ error: "Ingen fil skickades" });
    const files = await readFiles(req);
    if (files === "too_many") {
      return reply.code(400).send({ error: `Högst ${INVOICE_SCAN_MAX_FILES_PER_UPLOAD} filer per uppladdning` });
    }
    if (files.length === 0) return reply.code(400).send({ error: "Ingen fil skickades" });
    const result = await service.upload(files, req.user!.id);
    await reply.code(result.created.length > 0 ? 201 : 200).send(result);
    if (result.created.length > 0) void service.automaticAi(result.created.map((scan) => scan.id));
    return reply;
  });

  app.get<{ Params: { id: string } }>("/invoice-scans/:id", async (req, reply) => run(reply, () => service.get(req.params.id)));

  app.get<{ Params: { id: string } }>("/invoice-scans/:id/file", async (req, reply) => {
    try {
      const file = await service.readFile(req.params.id);
      reply.header("Content-Type", file.contentType);
      reply.header("Content-Disposition", contentDisposition(file.filename, "inline"));
      return reply.send(file.data);
    } catch (err) {
      return scanError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/invoice-scans/:id/interpret", async (req, reply) => {
    const input = interpretInvoiceScanSchema.parse(req.body ?? {});
    return run(reply, () => service.interpret(req.params.id, input.engine));
  });

  // Skapa leverantörsfaktura: the reviewed proposal as a supplier invoice
  // create body; answers with the supplier invoice draft (201).
  app.post<{ Params: { id: string } }>("/invoice-scans/:id/convert", async (req, reply) => {
    const input = createSupplierInvoiceSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.convert(req.params.id, input, req.user!.id));
    } catch (err) {
      return scanError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/invoice-scans/:id/reject", async (req, reply) => {
    const input = rejectInvoiceScanSchema.parse(req.body);
    return run(reply, () => service.reject(req.params.id, input.reason, req.user!.id));
  });

  app.post<{ Params: { id: string } }>("/invoice-scans/:id/restore", async (req, reply) =>
    run(reply, () => service.restore(req.params.id, req.user!.id))
  );

  app.delete<{ Params: { id: string } }>("/invoice-scans/:id", async (req, reply) => {
    try {
      await service.remove(req.params.id, req.user!.id);
      return reply.code(204).send();
    } catch (err) {
      return scanError(err, reply);
    }
  });

  // --- Inställningar (admin) ---

  app.get("/settings/invoice-scan", ADMIN, async () => settings.view());
  app.patch("/settings/invoice-scan", ADMIN, async (req) =>
    settings.update(updateInvoiceScanSettingsSchema.parse(req.body), req.user!.id)
  );
  // Testa anslutning (AI): { ok: true, model } or 409
  // invoice-scan-ai-test-failed with the Swedish reason. Saves nothing, but
  // calls out with a key — not readOnlySafe.
  app.post("/settings/invoice-scan/test-ai", ADMIN, async (req, reply) =>
    run(reply, () => settings.testAi(testInvoiceScanAiSchema.parse(req.body ?? {})))
  );
  // Testa anslutning (e-postlådan): { ok: true, unseen, processedFolderExists }
  // or 409 invoice-scan-mail-test-failed with the Swedish reason. Saves
  // nothing, but logs in with a password — not readOnlySafe.
  app.post("/settings/invoice-scan/test-mail", ADMIN, async (req, reply) =>
    run(reply, () => mail.testMail(testInvoiceScanMailSchema.parse(req.body ?? {})))
  );
  // Senast lästa brev: { rows } newest first.
  app.get("/settings/invoice-scan/mail-log", ADMIN, async (req) => mail.mailLog(listInvoiceScanMailLogQuerySchema.parse(req.query)));
}
