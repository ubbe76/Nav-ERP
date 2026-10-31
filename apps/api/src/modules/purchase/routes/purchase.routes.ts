import type { FastifyInstance } from "fastify";
import { deviationLinkForbidden } from "../../quality/service/deviation-link-access.js";
import { DeviationLinkNotAllowedError } from "../../quality/service/deviation-errors.js";
import { articleCardWrite } from "../../auth/middleware/access-rules.js";
import {
  createArticleSupplierSchema,
  createContactSchema,
  createDeliveryAddressSchema,
  createInquiryRowSchema,
  createInquirySchema,
  createPurchaseOrderRowSchema,
  createPurchaseOrderSchema,
  createSupplierSchema,
  idListQuerySchema,
  listGoodsReceiptsQuerySchema,
  listInquiriesQuerySchema,
  listPriceHistoryQuerySchema,
  listPurchaseInvoiceBasisQuerySchema,
  listPurchaseOrdersQuerySchema,
  listQuerySchema,
  sendDocumentEmailSchema,
  setPurchaseOrderStatusSchema,
  updateArticleSupplierSchema,
  updateContactSchema,
  updateDeliveryAddressSchema,
  updateInquiryHeaderSchema,
  updateInquiryRowSchema,
  updatePurchaseOrderHeaderSchema,
  updatePurchaseOrderRowSchema,
  updateSupplierSchema,
  receiveGoodsSchema,
} from "@navet/shared";
import { supplierDeliveryDateQuerySchema, supplierPriceQuoteQuerySchema } from "@navet/shared";
import { MailSendError, SmtpNotConfiguredError } from "../../mail/service/mail.service.js";
import type { PurchaseService } from "../service/purchase.service.js";
import {
  ArticleSupplierNotFoundError,
  ContactNotFoundError,
  DeliveryAddressNotFoundError,
  DuplicateArticleSupplierError,
  DuplicateSupplierNumberError,
  InquiryNotFoundError,
  InquiryRowNotFoundError,
  InvalidStatusTransitionError,
  InvalidSupplierPaymentDetailsError,
  MoOperationNotFoundError,
  OverReceiptError,
  PurchaseOrderNotFoundError,
  PurchaseOrderRowNotFoundError,
  PurchaseReceiptAlreadyUndoneError,
  PurchaseReceiptManufacturingOrderLockedError,
  PurchaseReceiptNotFoundError,
  PurchaseReceiptStockMissingError,
  RowHasReceiptsError,
  SupplierInactiveError,
  SupplierNotFoundError,
  LegoOperationNotFoundError,
  LegoOperationArticleMismatchError,
  LegoOperationClosedError,
  NotLegoOperationError,
  InquiryRowPriceNotApplicableError,
  DuplicateInquiryRowError,
  DuplicatePurchaseOrderRowError,
} from "../service/purchase.service.js";
import { ArticleIsTemplateError, ArticleNotFoundError, InvalidUnitError } from "../../article/service/article.service.js";
import { RegisterEntryNotFoundError } from "../../register/service/register.service.js";
import { LocationUnderStockCountError } from "../../stock/service/stock.service.js";
import { materialShortageBody } from "../../manufacturing/service/material-shortage.js";
import { MaterialShortageError } from "../../manufacturing/service/manufacturing.service.js";
import { MoReportStockMissingError } from "../../manufacturing/service/manufacturing.service.js";
import { registerListCsvRoute } from "../../system/routes/csv-export.js";
import { contentDisposition } from "../../system/service/content-disposition.js";
import { CostCenterInactiveError, CostCenterNotFoundError, ProjectClosedError, ProjectNotFoundError } from "../../economy/service/dimension-check.js";
import { errorBody } from "../../system/service/error-body.js";
import { SeriesExhaustedError } from "../../system/service/number-series.js";
import {
  GOODS_RECEIPT_CSV_COLUMNS,
  INQUIRY_CSV_COLUMNS,
  PRICE_HISTORY_CSV_COLUMNS,
  PURCHASE_INVOICE_BASIS_CSV_COLUMNS,
  PURCHASE_ORDER_CSV_COLUMNS,
  SUPPLIER_CSV_COLUMNS,
} from "../service/export-columns.js";
import { InvalidVatCodeError } from "../../economy/service/document-vat-code.js";

// This module is registered inside app.ts's protected route scope, so
// requireAuth has already run and req.user is guaranteed to be set.
export async function purchaseRoutes(app: FastifyInstance, opts: { service: PurchaseService }) {
  const { service } = opts;

  app.get("/suppliers", async (req) => service.listSuppliers(listQuerySchema.parse(req.query)));

  registerListCsvRoute(app, {
    path: "/suppliers/csv",
    querySchema: listQuerySchema,
    filenameBase: "leverantorer",
    columns: SUPPLIER_CSV_COLUMNS,
    fetch: (q) => service.listSuppliers(q),
  });

  app.get<{ Params: { id: string } }>("/suppliers/:id", async (req, reply) => {
    const supplier = await service.getSupplier(req.params.id);
    if (!supplier) return reply.code(404).send({ error: "Supplier not found" });
    return supplier;
  });

  app.post("/suppliers", async (req, reply) => {
    const input = createSupplierSchema.parse(req.body);
    try {
      const supplier = await service.createSupplier(input);
      return reply.code(201).send(supplier);
    } catch (err) {
      if (err instanceof RegisterEntryNotFoundError || err instanceof CostCenterNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof CostCenterInactiveError) return reply.code(400).send(errorBody(err));
      if (err instanceof DuplicateSupplierNumberError) return reply.code(409).send(errorBody(err));
      // Retry storm on the number series (all five stepped-over numbers taken)
      // is a retryable conflict, not a server fault — without this it fell
      // through to the global 500 and the series-exhausted dictionary entry
      // was dead code.
      if (err instanceof SeriesExhaustedError) return reply.code(409).send(errorBody(err));
      // body.problems: field → Swedish problem (the supplier card marks the fields).
      if (err instanceof InvalidSupplierPaymentDetailsError) return reply.code(400).send({ ...errorBody(err), problems: err.problems });
      // Momskoder: Momskod (förval) unknown, inactive or not a purchase code.
      if (err instanceof InvalidVatCodeError) return reply.code(400).send({ ...errorBody(err), reason: err.reason });
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>("/suppliers/:id", async (req, reply) => {
    const input = updateSupplierSchema.parse(req.body);
    try {
      return await service.updateSupplier(req.params.id, input);
    } catch (err) {
      if (err instanceof SupplierNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof RegisterEntryNotFoundError || err instanceof CostCenterNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof CostCenterInactiveError) return reply.code(400).send(errorBody(err));
      if (err instanceof DuplicateSupplierNumberError) return reply.code(409).send(errorBody(err));
      // body.problems: field → Swedish problem (the supplier card marks the fields).
      if (err instanceof InvalidSupplierPaymentDetailsError) return reply.code(400).send({ ...errorBody(err), problems: err.problems });
      if (err instanceof InvalidVatCodeError) return reply.code(400).send({ ...errorBody(err), reason: err.reason });
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/suppliers/:id/contacts", async (req, reply) => {
    try {
      return await service.listSupplierContacts(req.params.id);
    } catch (err) {
      if (err instanceof SupplierNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/suppliers/:id/contacts", async (req, reply) => {
    const input = createContactSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.createSupplierContact(req.params.id, input));
    } catch (err) {
      if (err instanceof SupplierNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.patch<{ Params: { id: string; contactId: string } }>(
    "/suppliers/:id/contacts/:contactId",
    async (req, reply) => {
      const input = updateContactSchema.parse(req.body);
      try {
        return await service.updateSupplierContact(req.params.id, req.params.contactId, input);
      } catch (err) {
        if (err instanceof ContactNotFoundError) return reply.code(404).send(errorBody(err));
        throw err;
      }
    }
  );

  app.delete<{ Params: { id: string; contactId: string } }>(
    "/suppliers/:id/contacts/:contactId",
    async (req, reply) => {
      try {
        await service.deleteSupplierContact(req.params.id, req.params.contactId);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof ContactNotFoundError) return reply.code(404).send(errorBody(err));
        throw err;
      }
    }
  );

  // --- Delivery addresses (leveransadresser) ---

  app.get<{ Params: { id: string } }>("/suppliers/:id/delivery-addresses", async (req, reply) => {
    try {
      return await service.listSupplierDeliveryAddresses(req.params.id);
    } catch (err) {
      if (err instanceof SupplierNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/suppliers/:id/delivery-addresses", async (req, reply) => {
    const input = createDeliveryAddressSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.createSupplierDeliveryAddress(req.params.id, input));
    } catch (err) {
      if (err instanceof SupplierNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.patch<{ Params: { id: string; addressId: string } }>(
    "/suppliers/:id/delivery-addresses/:addressId",
    async (req, reply) => {
      const input = updateDeliveryAddressSchema.parse(req.body);
      try {
        return await service.updateSupplierDeliveryAddress(req.params.id, req.params.addressId, input);
      } catch (err) {
        if (err instanceof DeliveryAddressNotFoundError) return reply.code(404).send(errorBody(err));
        throw err;
      }
    }
  );

  app.delete<{ Params: { id: string; addressId: string } }>(
    "/suppliers/:id/delivery-addresses/:addressId",
    async (req, reply) => {
      try {
        await service.deleteSupplierDeliveryAddress(req.params.id, req.params.addressId);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof DeliveryAddressNotFoundError) return reply.code(404).send(errorBody(err));
        throw err;
      }
    }
  );

  // --- Inquiries (förfrågningar) ---

  // Shared error mapper for the inquiry routes.
  function inquiryError(err: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    if (
      err instanceof InquiryNotFoundError ||
      err instanceof InquiryRowNotFoundError ||
      err instanceof SupplierNotFoundError ||
      err instanceof LegoOperationNotFoundError
    ) {
      return reply.code(404).send(errorBody(err as Error));
    }
    // InvalidUnitError: a unit that is not one of the article's.
    if (err instanceof LegoOperationArticleMismatchError || err instanceof NotLegoOperationError || err instanceof InvalidUnitError) {
      return reply.code(400).send(errorBody(err));
    }
    if (
      err instanceof InvalidStatusTransitionError ||
      err instanceof SmtpNotConfiguredError ||
      err instanceof InquiryRowPriceNotApplicableError ||
      err instanceof LegoOperationClosedError ||
      err instanceof DuplicateInquiryRowError ||
      // Produktkonfigurator: a template in mode variants on a new row
      // (createInquiry, addInquiryRow).
      err instanceof ArticleIsTemplateError
    ) {
      return reply.code(409).send(errorBody(err));
    }
    // The upstream SMTP server said no — not a client error, not our crash.
    if (err instanceof MailSendError) {
      return reply.code(502).send(errorBody(err));
    }
    throw err;
  }

  app.get("/inquiries", async (req) => service.listInquiries(listInquiriesQuerySchema.parse(req.query)));

  registerListCsvRoute(app, {
    path: "/inquiries/csv",
    querySchema: listInquiriesQuerySchema,
    filenameBase: "forfragningar",
    columns: INQUIRY_CSV_COLUMNS,
    fetch: (q) => service.listInquiries(q),
  });

  app.post("/inquiries", async (req, reply) => {
    const input = createInquirySchema.parse(req.body);
    try {
      return reply.code(201).send(await service.createInquiry(input, req.user!.id));
    } catch (err) {
      return inquiryError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/inquiries/:id", async (req, reply) => {
    const inquiry = await service.getInquiry(req.params.id);
    if (!inquiry) return reply.code(404).send({ error: "Inquiry not found" });
    return inquiry;
  });

  // Terms (leverans-/betalningsvillkor, speditör) on the inquiry header.
  app.patch<{ Params: { id: string } }>("/inquiries/:id", async (req, reply) => {
    const input = updateInquiryHeaderSchema.parse(req.body);
    try {
      return await service.updateInquiryHeader(req.params.id, input);
    } catch (err) {
      if (err instanceof InquiryNotFoundError || err instanceof RegisterEntryNotFoundError) {
        return reply.code(404).send(errorBody(err));
      }
      if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/inquiries/:id/rows", async (req, reply) => {
    try {
      return await service.listInquiryRows(req.params.id);
    } catch (err) {
      return inquiryError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/inquiries/:id/rows", async (req, reply) => {
    const input = createInquiryRowSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.addInquiryRow(req.params.id, input));
    } catch (err) {
      return inquiryError(err, reply);
    }
  });

  app.patch<{ Params: { id: string; rowId: string } }>("/inquiries/:id/rows/:rowId", async (req, reply) => {
    const input = updateInquiryRowSchema.parse(req.body);
    try {
      return await service.updateInquiryRow(req.params.id, req.params.rowId, input);
    } catch (err) {
      return inquiryError(err, reply);
    }
  });

  app.delete<{ Params: { id: string; rowId: string } }>("/inquiries/:id/rows/:rowId", async (req, reply) => {
    try {
      await service.deleteInquiryRow(req.params.id, req.params.rowId);
      return reply.code(204).send();
    } catch (err) {
      return inquiryError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/inquiries/:id/send", async (req, reply) => {
    try {
      return await service.sendInquiry(req.params.id, req.user!.id);
    } catch (err) {
      return inquiryError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/inquiries/:id/pdf", async (req, reply) => {
    try {
      const { filename, content } = await service.getInquiryPdf(req.params.id);
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", contentDisposition(filename));
      return reply.send(content);
    } catch (err) {
      return inquiryError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/inquiries/:id/send-email", async (req, reply) => {
    const input = sendDocumentEmailSchema.parse(req.body);
    try {
      return await service.sendInquiryEmail(req.params.id, input);
    } catch (err) {
      return inquiryError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/inquiries/:id/mark-answered", async (req, reply) => {
    try {
      return await service.markInquiryAnswered(req.params.id, req.user!.id);
    } catch (err) {
      return inquiryError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/inquiries/:id/cancel", async (req, reply) => {
    try {
      return await service.cancelInquiry(req.params.id, req.user!.id);
    } catch (err) {
      return inquiryError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/inquiries/:id/convert-to-order", async (req, reply) => {
    try {
      return reply.code(201).send(await service.convertInquiryToOrder(req.params.id, req.user!.id));
    } catch (err) {
      return inquiryError(err, reply);
    }
  });

  // Prisåterföring: the answered lego price → the article's routing operation.
  app.post<{ Params: { id: string; rowId: string } }>(
    "/inquiries/:id/rows/:rowId/apply-price-to-routing",
    async (req, reply) => {
      try {
        return await service.applyInquiryRowPriceToRouting(req.params.id, req.params.rowId, req.user!.id);
      } catch (err) {
        return inquiryError(err, reply);
      }
    }
  );

  app.get("/purchase-orders", async (req) =>
    service.listPurchaseOrders(listPurchaseOrdersQuerySchema.parse(req.query))
  );

  registerListCsvRoute(app, {
    path: "/purchase-orders/csv",
    querySchema: listPurchaseOrdersQuerySchema,
    filenameBase: "inkopsordrar",
    columns: PURCHASE_ORDER_CSV_COLUMNS,
    fetch: (q) => service.listPurchaseOrders(q),
  });

  app.get<{ Params: { id: string } }>("/purchase-orders/:id", async (req, reply) => {
    const order = await service.getPurchaseOrder(req.params.id);
    if (!order) return reply.code(404).send({ error: "Purchase order not found" });
    return order;
  });

  app.post("/purchase-orders", async (req, reply) => {
    const input = createPurchaseOrderSchema.parse(req.body);
    const forbidden = deviationLinkForbidden(input.deviationId, req.user);
    if (forbidden) return reply.code(403).send(errorBody(forbidden));
    try {
      const order = await service.createPurchaseOrder(input, req.user!.id);
      return reply.code(201).send(order);
    } catch (err) {
      if (err instanceof SupplierNotFoundError || err instanceof ProjectNotFoundError) return reply.code(404).send(errorBody(err));
      // Avvikelser: the case cannot take the link (closed, wrong type, other supplier).
      if (err instanceof DeviationLinkNotAllowedError) return reply.code(409).send(errorBody(err));
      if (err instanceof ProjectClosedError) return reply.code(400).send(errorBody(err));
      throw err;
    }
  });

  // Terms (leverans-/betalningsvillkor, speditör) on the PO header.
  app.patch<{ Params: { id: string } }>("/purchase-orders/:id", async (req, reply) => {
    const input = updatePurchaseOrderHeaderSchema.parse(req.body);
    try {
      return await service.updatePurchaseOrderHeader(req.params.id, input);
    } catch (err) {
      if (err instanceof PurchaseOrderNotFoundError || err instanceof RegisterEntryNotFoundError || err instanceof ProjectNotFoundError) {
        return reply.code(404).send(errorBody(err));
      }
      if (err instanceof ProjectClosedError) return reply.code(400).send(errorBody(err));
      if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/purchase-orders/:id/rows", async (req) => {
    return service.listRows(req.params.id);
  });

  app.post<{ Params: { id: string } }>("/purchase-orders/:id/rows", async (req, reply) => {
    const input = createPurchaseOrderRowSchema.parse(req.body);
    try {
      const row = await service.addRow(req.params.id, input, req.user!.id);
      return reply.code(201).send(row);
    } catch (err) {
      if (err instanceof PurchaseOrderNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof MoOperationNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof InvalidStatusTransitionError || err instanceof DuplicatePurchaseOrderRowError) {
        return reply.code(409).send(errorBody(err));
      }
      // Produktkonfigurator: a template in mode variants on a new row.
      if (err instanceof ArticleIsTemplateError) return reply.code(409).send(errorBody(err));
      // A unit that is not one of the article's.
      if (err instanceof InvalidUnitError) return reply.code(400).send(errorBody(err));
      throw err;
    }
  });

  app.patch<{ Params: { id: string; rowId: string } }>("/purchase-orders/:id/rows/:rowId", async (req, reply) => {
    const input = updatePurchaseOrderRowSchema.parse(req.body);
    try {
      return await service.updateRow(req.params.id, req.params.rowId, input, req.user!.id);
    } catch (err) {
      if (err instanceof PurchaseOrderNotFoundError || err instanceof PurchaseOrderRowNotFoundError) {
        return reply.code(404).send(errorBody(err));
      }
      if (err instanceof InvalidStatusTransitionError || err instanceof OverReceiptError) {
        return reply.code(409).send(errorBody(err));
      }
      if (err instanceof InvalidUnitError) return reply.code(400).send(errorBody(err));
      throw err;
    }
  });

  // DELETE has no body — ?bumpRevision=false skips the revision bump.
  app.delete<{ Params: { id: string; rowId: string }; Querystring: { bumpRevision?: string } }>(
    "/purchase-orders/:id/rows/:rowId",
    async (req, reply) => {
      try {
        await service.deleteRow(req.params.id, req.params.rowId, req.query.bumpRevision !== "false", req.user!.id);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof PurchaseOrderNotFoundError || err instanceof PurchaseOrderRowNotFoundError) {
          return reply.code(404).send(errorBody(err));
        }
        if (
          err instanceof InvalidStatusTransitionError ||
          err instanceof OverReceiptError ||
          err instanceof RowHasReceiptsError
        ) {
          return reply.code(409).send(errorBody(err));
        }
        throw err;
      }
    }
  );

  // Batch printout: ?ids=<uuid>,<uuid> → one PDF with the orders back to
  // back. Static segment, so it never collides with /:id/pdf below.
  app.get("/purchase-orders/pdf", async (req, reply) => {
    const { ids } = idListQuerySchema.parse(req.query);
    try {
      const { filename, content } = await service.getPurchaseOrdersPdf(ids);
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", contentDisposition(filename));
      return reply.send(content);
    } catch (err) {
      if (err instanceof PurchaseOrderNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/purchase-orders/:id/pdf", async (req, reply) => {
    try {
      const { filename, content } = await service.getPurchaseOrderPdf(req.params.id);
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", contentDisposition(filename));
      return reply.send(content);
    } catch (err) {
      if (err instanceof PurchaseOrderNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/purchase-orders/:id/send-email", async (req, reply) => {
    const input = sendDocumentEmailSchema.parse(req.body);
    try {
      return await service.sendPurchaseOrderEmail(req.params.id, input);
    } catch (err) {
      if (err instanceof PurchaseOrderNotFoundError) return reply.code(404).send(errorBody(err));
      return inquiryError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/purchase-orders/:id/confirm", async (req, reply) => {
    try {
      return await service.confirm(req.params.id, req.user!.id);
    } catch (err) {
      if (err instanceof PurchaseOrderNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/purchase-orders/:id/cancel", async (req, reply) => {
    try {
      return await service.cancel(req.params.id, req.user!.id);
    } catch (err) {
      if (err instanceof PurchaseOrderNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/purchase-orders/:id/close", async (req, reply) => {
    try {
      return await service.close(req.params.id, req.user!.id);
    } catch (err) {
      if (err instanceof PurchaseOrderNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  // Manual status override — bypasses the state machine on purpose.
  app.post<{ Params: { id: string } }>("/purchase-orders/:id/set-status", async (req, reply) => {
    const input = setPurchaseOrderStatusSchema.parse(req.body);
    try {
      return await service.setStatus(req.params.id, input.status, req.user!.id);
    } catch (err) {
      if (err instanceof PurchaseOrderNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  // Inleveranser — the IO card's receipt log, undone receipts included.
  app.get<{ Params: { id: string } }>("/purchase-orders/:id/receipts", async (req, reply) => {
    try {
      return await service.listReceipts(req.params.id);
    } catch (err) {
      if (err instanceof PurchaseOrderNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  // Ångra inleverans — reverses one receipt (stock, row quantity, order
  // status; a lego row's TO report too). Same access as receiving.
  app.post<{ Params: { id: string; receiptId: string } }>(
    "/purchase-orders/:id/receipts/:receiptId/undo",
    async (req, reply) => {
      try {
        return await service.undoReceipt(req.params.id, req.params.receiptId, req.user!.id);
      } catch (err) {
        if (err instanceof PurchaseReceiptNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof PurchaseReceiptAlreadyUndoneError) return reply.code(409).send(errorBody(err));
        if (err instanceof PurchaseReceiptStockMissingError || err instanceof MoReportStockMissingError) {
          return reply.code(409).send({ ...errorBody(err), available: err.available, required: err.required });
        }
        if (err instanceof PurchaseReceiptManufacturingOrderLockedError) return reply.code(409).send(errorBody(err));
        if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
        if (err instanceof LocationUnderStockCountError) return reply.code(409).send(errorBody(err));
        throw err;
      }
    }
  );

  app.post<{ Params: { id: string; rowId: string } }>(
    "/purchase-orders/:id/rows/:rowId/receive",
    async (req, reply) => {
      const input = receiveGoodsSchema.parse(req.body);
      try {
        const result = await service.receiveGoods(req.params.id, req.params.rowId, input, req.user!.id);
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof PurchaseOrderNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof PurchaseOrderRowNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
        if (err instanceof OverReceiptError) return reply.code(409).send({ ...errorBody(err), ...err.limit });
        if (err instanceof LocationUnderStockCountError) return reply.code(409).send(errorBody(err));
        // Materialbrist on a lego row in mode "warn": refused before the
        // goods were booked (a refusal in mode "block" comes AFTER the
        // receipt, as the operationReport warning on the 201).
        if (err instanceof MaterialShortageError) return reply.code(409).send(materialShortageBody(err));
        throw err;
      }
    }
  );

  // --- Article supplier catalog (leverantörskatalog per artikel) ---

  // Shared error mapper for the catalog routes.
  function catalogError(err: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    if (
      err instanceof ArticleNotFoundError ||
      err instanceof SupplierNotFoundError ||
      err instanceof ArticleSupplierNotFoundError
    ) {
      return reply.code(404).send(errorBody(err as Error));
    }
    if (err instanceof SupplierInactiveError) return reply.code(400).send(errorBody(err));
    if (err instanceof DuplicateArticleSupplierError) return reply.code(409).send(errorBody(err));
    throw err;
  }

  app.get<{ Params: { id: string } }>("/articles/:id/suppliers", async (req, reply) => {
    try {
      return await service.listArticleSuppliers(req.params.id);
    } catch (err) {
      return catalogError(err, reply);
    }
  });

  // Prishistorik for the catalog (price, currency, staffel, primary), newest
  // first.
  app.get<{ Params: { id: string } }>("/articles/:id/supplier-price-history", async (req, reply) => {
    try {
      return await service.listArticleSupplierPriceHistory(req.params.id);
    } catch (err) {
      return catalogError(err, reply);
    }
  });

  // Stafflat leverantörspris for the IO card's à-pris prefill. Quantity is
  // in the article's base unit (like /price-quote); `price: null` is a 200.
  app.get("/supplier-price-quote", async (req, reply) => {
    const query = supplierPriceQuoteQuerySchema.parse(req.query);
    const result = await service.getSupplierPriceQuote(query);
    if (!result) return reply.code(404).send(errorBody(new ArticleNotFoundError(query.articleId)));
    return result;
  });

  // Fasta leveransdagar: the IO header's/row's suggested date + warning.
  app.get("/supplier-delivery-date-suggestion", async (req, reply) => {
    const query = supplierDeliveryDateQuerySchema.parse(req.query);
    const result = await service.getSupplierDeliveryDateSuggestion(query);
    if (!result) return reply.code(404).send(errorBody(new SupplierNotFoundError(query.supplierId)));
    return result;
  });

  app.post<{ Params: { id: string } }>(
    "/articles/:id/suppliers",
    { config: { access: articleCardWrite(["inkop"]) } },
    async (req, reply) => {
      const input = createArticleSupplierSchema.parse(req.body);
      try {
        return reply.code(201).send(await service.addArticleSupplier(req.params.id, input));
      } catch (err) {
        return catalogError(err, reply);
      }
    }
  );

  app.patch<{ Params: { id: string; rowId: string } }>(
    "/articles/:id/suppliers/:rowId",
    { config: { access: articleCardWrite(["inkop"]) } },
    async (req, reply) => {
      const input = updateArticleSupplierSchema.parse(req.body);
      try {
        return await service.updateArticleSupplier(req.params.id, req.params.rowId, input);
      } catch (err) {
        return catalogError(err, reply);
      }
    }
  );

  app.delete<{ Params: { id: string; rowId: string } }>(
    "/articles/:id/suppliers/:rowId",
    { config: { access: articleCardWrite(["inkop"]) } },
    async (req, reply) => {
      try {
        await service.removeArticleSupplier(req.params.id, req.params.rowId);
        return reply.code(204).send();
      } catch (err) {
        return catalogError(err, reply);
      }
    }
  );

  // --- Per-article purchase logs (read-only, keyed by ?articleId=) ---

  app.get("/goods-receipts", async (req) => {
    const query = listGoodsReceiptsQuerySchema.parse(req.query);
    return service.listArticleGoodsReceipts(query.articleId, query);
  });

  registerListCsvRoute(app, {
    path: "/goods-receipts/csv",
    querySchema: listGoodsReceiptsQuerySchema,
    filenameBase: "inleveranser",
    columns: GOODS_RECEIPT_CSV_COLUMNS,
    fetch: (q) => service.listArticleGoodsReceipts(q.articleId, q),
  });

  app.get("/price-history", async (req) => {
    const query = listPriceHistoryQuerySchema.parse(req.query);
    return service.listArticlePriceHistory(query.articleId, query);
  });

  registerListCsvRoute(app, {
    path: "/price-history/csv",
    querySchema: listPriceHistoryQuerySchema,
    filenameBase: "prislogg",
    columns: PRICE_HISTORY_CSV_COLUMNS,
    fetch: (q) => service.listArticlePriceHistory(q.articleId, q),
  });

  // Fakturaunderlag — inlevererade order som väntar på leverantörsfaktura.
  app.get("/purchase-invoice-basis", async (req) =>
    service.listInvoiceBasis(listPurchaseInvoiceBasisQuerySchema.parse(req.query))
  );

  registerListCsvRoute(app, {
    path: "/purchase-invoice-basis/csv",
    querySchema: listPurchaseInvoiceBasisQuerySchema,
    filenameBase: "fakturaunderlag",
    columns: PURCHASE_INVOICE_BASIS_CSV_COLUMNS,
    fetch: (q) => service.listInvoiceBasis(q),
  });
}
