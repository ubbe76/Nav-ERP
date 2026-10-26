import type { FastifyInstance } from "fastify";
import {
  cancelDeviationSchema,
  closeDeviationSchema,
  createDeviationCostSchema,
  createDeviationLinkSchema,
  createDeviationSchema,
  DEVIATION_STATUS_LABELS,
  DEVIATION_TYPE_LABELS,
  deviationPdfQuerySchema,
  listDeviationsQuerySchema,
  sendDeviationEmailSchema,
  updateDeviationSchema,
  type CsvColumn,
} from "@navet/shared";
import { canSeePrices } from "../../auth/middleware/access-rules.js";
import { MailSendError, SmtpNotConfiguredError } from "../../mail/service/mail.service.js";
import { registerListCsvRoute } from "../../system/routes/csv-export.js";
import { contentDisposition } from "../../system/service/content-disposition.js";
import { errorBody } from "../../system/service/error-body.js";
import {
  DeviationCloseRequirementsError,
  DeviationCostNotFoundError,
  DeviationFileNotFoundError,
  DeviationLinkMismatchError,
  DeviationLinkNotAllowedError,
  DeviationLinkNotFoundError,
  DeviationNotEditableError,
  DeviationNotFoundError,
  DeviationReasonNotApplicableError,
  InvalidDeviationFileTypeError,
  InvalidStatusTransitionError,
} from "../service/deviation-errors.js";
import { MAX_DEVIATION_FILE_BYTES, type QualityService } from "../service/quality.service.js";

// Kvalitet → Avvikelser. Registered with registerModule({ read: office,
// write: ["kvalitet"] }) in app.ts: every office user reads the cases (the
// order cards list theirs), Kvalitet writes. Prices (Nettokostnad, the cost
// rows) follow canSeePrices like every other price field.

type Reply = { code: (n: number) => { send: (b: unknown) => unknown } };

type DeviationListRow = Awaited<ReturnType<QualityService["list"]>>["rows"][number];

const CSV_COLUMNS = (seePrices: boolean): CsvColumn<DeviationListRow>[] => [
  { label: "Nr", value: (r) => r.deviationNumber },
  { label: "Datum", value: (r) => r.reportedDate },
  { label: "Typ", value: (r) => DEVIATION_TYPE_LABELS[r.type] },
  { label: "Rubrik", value: (r) => r.title },
  { label: "Motpart", value: (r) => r.counterpartyName },
  { label: "Artikel", value: (r) => (r.articleNumber ? `${r.articleNumber} ${r.articleName ?? ""}`.trim() : null) },
  { label: "Antal", value: (r) => r.quantity, format: "number" },
  { label: "Enhet", value: (r) => r.unitCode },
  { label: "Orsak", value: (r) => r.reasonName },
  { label: "Ansvarig", value: (r) => r.responsibleUserName },
  { label: "Åtgärd senast", value: (r) => r.dueDate },
  { label: "Status", value: (r) => DEVIATION_STATUS_LABELS[r.status] },
  ...(seePrices ? [{ label: "Nettokostnad", value: (r: DeviationListRow) => r.netCost, format: "money" as const }] : []),
  { label: "Er referens", value: (r) => r.counterpartyReference },
  { label: "Kundorder", value: (r) => r.salesOrderNumber },
  { label: "Faktura", value: (r) => r.invoiceNumber },
  { label: "Inköpsorder", value: (r) => r.purchaseOrderNumber },
  { label: "Tillverkningsorder", value: (r) => r.manufacturingOrderNumber },
];

export async function qualityRoutes(app: FastifyInstance, opts: { service: QualityService }) {
  const { service } = opts;

  function qualityError(err: unknown, reply: Reply) {
    if (
      err instanceof DeviationNotFoundError ||
      err instanceof DeviationCostNotFoundError ||
      err instanceof DeviationLinkNotFoundError ||
      err instanceof DeviationFileNotFoundError
    ) {
      return reply.code(404).send(errorBody(err));
    }
    if (err instanceof DeviationLinkMismatchError) return reply.code(400).send({ ...errorBody(err), field: err.field });
    if (err instanceof DeviationReasonNotApplicableError || err instanceof InvalidDeviationFileTypeError) {
      return reply.code(400).send(errorBody(err));
    }
    if (err instanceof DeviationCloseRequirementsError) return reply.code(409).send({ ...errorBody(err), missing: err.missing });
    if (
      err instanceof DeviationLinkNotAllowedError ||
      err instanceof DeviationNotEditableError ||
      err instanceof InvalidStatusTransitionError ||
      err instanceof SmtpNotConfiguredError
    ) {
      return reply.code(409).send(errorBody(err));
    }
    if (err instanceof MailSendError) return reply.code(502).send(errorBody(err));
    throw err;
  }

  const seePrices = (req: { user?: Parameters<typeof canSeePrices>[0] }) => (req.user ? canSeePrices(req.user) : false);

  app.get("/deviations", async (req) => service.list(listDeviationsQuerySchema.parse(req.query), { seePrices: seePrices(req) }));

  registerListCsvRoute(app, {
    path: "/deviations/csv",
    querySchema: listDeviationsQuerySchema,
    filenameBase: "avvikelser",
    columns: (req) => CSV_COLUMNS(seePrices(req)),
    fetch: (query, req) => service.list(query, { seePrices: seePrices(req) }),
  });

  app.post("/deviations", async (req, reply) => {
    const input = createDeviationSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.create(input, req.user!.id, { seePrices: seePrices(req) }));
    } catch (err) {
      return qualityError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/deviations/:id", async (req, reply) => {
    try {
      return await service.get(req.params.id, { seePrices: seePrices(req) });
    } catch (err) {
      return qualityError(err, reply);
    }
  });

  app.patch<{ Params: { id: string } }>("/deviations/:id", async (req, reply) => {
    const input = updateDeviationSchema.parse(req.body);
    try {
      return await service.update(req.params.id, input, req.user!.id, { seePrices: seePrices(req) });
    } catch (err) {
      return qualityError(err, reply);
    }
  });

  // Status actions — each answers with the card.
  app.post<{ Params: { id: string } }>("/deviations/:id/start", async (req, reply) => {
    try {
      await service.start(req.params.id, req.user!.id);
      return await service.get(req.params.id, { seePrices: seePrices(req) });
    } catch (err) {
      return qualityError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/deviations/:id/close", async (req, reply) => {
    const input = closeDeviationSchema.parse(req.body ?? {});
    try {
      await service.close(req.params.id, input, req.user!.id);
      return await service.get(req.params.id, { seePrices: seePrices(req) });
    } catch (err) {
      return qualityError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/deviations/:id/cancel", async (req, reply) => {
    const input = cancelDeviationSchema.parse(req.body);
    try {
      await service.cancel(req.params.id, input, req.user!.id);
      return await service.get(req.params.id, { seePrices: seePrices(req) });
    } catch (err) {
      return qualityError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/deviations/:id/reopen", async (req, reply) => {
    try {
      await service.reopen(req.params.id, req.user!.id);
      return await service.get(req.params.id, { seePrices: seePrices(req) });
    } catch (err) {
      return qualityError(err, reply);
    }
  });

  // Kostnader — answer with the card (the totals are derived).
  app.post<{ Params: { id: string } }>("/deviations/:id/costs", async (req, reply) => {
    const input = createDeviationCostSchema.parse(req.body);
    try {
      await service.addCost(req.params.id, input, req.user!.id);
      return reply.code(201).send(await service.get(req.params.id, { seePrices: seePrices(req) }));
    } catch (err) {
      return qualityError(err, reply);
    }
  });

  app.delete<{ Params: { id: string; costId: string } }>("/deviations/:id/costs/:costId", async (req, reply) => {
    try {
      await service.removeCost(req.params.id, req.params.costId, req.user!.id);
      return await service.get(req.params.id, { seePrices: seePrices(req) });
    } catch (err) {
      return qualityError(err, reply);
    }
  });

  // Koppla dokument / Ta bort koppling.
  app.post<{ Params: { id: string } }>("/deviations/:id/links", async (req, reply) => {
    const input = createDeviationLinkSchema.parse(req.body);
    try {
      await service.addLink(req.params.id, input, req.user!.id);
      return reply.code(201).send(await service.get(req.params.id, { seePrices: seePrices(req) }));
    } catch (err) {
      return qualityError(err, reply);
    }
  });

  app.delete<{ Params: { id: string; linkId: string } }>("/deviations/:id/links/:linkId", async (req, reply) => {
    try {
      await service.removeLink(req.params.id, req.params.linkId, req.user!.id);
      return await service.get(req.params.id, { seePrices: seePrices(req) });
    } catch (err) {
      return qualityError(err, reply);
    }
  });

  // Bilder och filer.
  app.get<{ Params: { id: string } }>("/deviations/:id/files", async (req, reply) => {
    try {
      return await service.listFiles(req.params.id);
    } catch (err) {
      return qualityError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/deviations/:id/files", async (req, reply) => {
    const file = await req.file({ limits: { fileSize: MAX_DEVIATION_FILE_BYTES } });
    if (!file) return reply.code(400).send({ error: "Ingen fil skickades", code: "validation-failed" });
    const data = await file.toBuffer();
    // fastify-multipart truncates instead of throwing once the limit is hit.
    if (file.file.truncated) return reply.code(400).send({ error: "Filen är för stor — max 20 MB", code: "deviation-file-too-large" });
    try {
      const row = await service.addFile(req.params.id, { filename: file.filename, contentType: file.mimetype, data }, req.user!.id);
      return reply.code(201).send(row);
    } catch (err) {
      return qualityError(err, reply);
    }
  });

  app.get<{ Params: { id: string; fileId: string } }>("/deviations/:id/files/:fileId", async (req, reply) => {
    try {
      const file = await service.downloadFile(req.params.id, req.params.fileId);
      reply.header("Content-Type", file.contentType);
      reply.header("Content-Disposition", contentDisposition(file.filename, "inline"));
      // The type was checked against the file's signature at upload.
      reply.header("X-Content-Type-Options", "nosniff");
      return reply.send(file.data);
    } catch (err) {
      return qualityError(err, reply);
    }
  });

  app.delete<{ Params: { id: string; fileId: string } }>("/deviations/:id/files/:fileId", async (req, reply) => {
    try {
      await service.removeFile(req.params.id, req.params.fileId, req.user!.id);
      return reply.code(204).send();
    } catch (err) {
      return qualityError(err, reply);
    }
  });

  // Reklamationsrapporten: ?details=1 adds Orsaksanalys/Åtgärd/Beslut.
  app.get<{ Params: { id: string } }>("/deviations/:id/pdf", async (req, reply) => {
    const query = deviationPdfQuerySchema.parse(req.query);
    try {
      const { filename, content } = await service.renderPdf(req.params.id, { details: query.details });
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", contentDisposition(filename));
      return reply.send(content);
    } catch (err) {
      return qualityError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/deviations/:id/email", async (req, reply) => {
    const input = sendDeviationEmailSchema.parse(req.body);
    try {
      await service.sendEmail(req.params.id, input, req.user!.id);
      return reply.code(204).send();
    } catch (err) {
      return qualityError(err, reply);
    }
  });
}
