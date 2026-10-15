import type { FastifyInstance } from "fastify";
import {
  addPaymentBatchItemsSchema,
  confirmPaymentBatchSchema,
  createPaymentBatchSchema,
  listPaymentBatchesQuerySchema,
  rejectPaymentBatchItemSchema,
  updatePaymentBatchItemSchema,
} from "@navet/shared";
import { requirePermission } from "../../auth/middleware/permission.middleware.js";
import { InvalidStatusTransitionError } from "../../purchase/service/purchase.service.js";
import { SupplierInvoiceInPaymentBatchError } from "../../purchase/service/supplier-invoice.service.js";
import { contentDisposition } from "../../system/service/content-disposition.js";
import { errorBody } from "../../system/service/error-body.js";
import {
  BankSettingsIncompleteError,
  InvalidPaymentBatchItemError,
  InvalidPaymentDateError,
  PaymentBatchItemNotConfirmableError,
  PaymentBatchItemNotFoundError,
  PaymentBatchNotFoundError,
  PaymentFileInvalidError,
  SupplierInvoicesNotPayableError,
} from "../service/banking.errors.js";
import type { PaymentBatchService } from "../service/payment-batch.service.js";

type Reply = { code: (n: number) => { send: (b: unknown) => unknown } };

function batchError(err: unknown, reply: Reply) {
  if (err instanceof PaymentBatchNotFoundError || err instanceof PaymentBatchItemNotFoundError) return reply.code(404).send(errorBody(err));
  if (err instanceof InvalidPaymentBatchItemError || err instanceof InvalidPaymentDateError) return reply.code(400).send(errorBody(err));
  if (err instanceof SupplierInvoicesNotPayableError) return reply.code(409).send({ ...errorBody(err), details: err.details });
  if (err instanceof PaymentFileInvalidError) return reply.code(409).send({ ...errorBody(err), details: err.violations });
  if (
    err instanceof BankSettingsIncompleteError ||
    err instanceof InvalidStatusTransitionError ||
    err instanceof SupplierInvoiceInPaymentBatchError ||
    err instanceof PaymentBatchItemNotConfirmableError
  ) {
    return reply.code(409).send(errorBody(err as Error));
  }
  throw err;
}

// registerModule({ read: ["inkop", "ekonomi"], write: ["inkop"] }) in app.ts;
// every route also carries requirePermission (mini-app tests).
export async function paymentBatchRoutes(app: FastifyInstance, opts: { service: PaymentBatchService }) {
  const { service } = opts;
  const read = { preHandler: requirePermission("inkop", "ekonomi") };
  const write = { preHandler: requirePermission("inkop") };

  app.get("/payment-batches", read, async (req) => service.list(listPaymentBatchesQuerySchema.parse(req.query)));

  app.post("/payment-batches", write, async (req, reply) => {
    const input = createPaymentBatchSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.create(input, req.user!.id));
    } catch (err) {
      return batchError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/payment-batches/:id", read, async (req, reply) => {
    try {
      return await service.get(req.params.id);
    } catch (err) {
      return batchError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/payment-batches/:id/items", write, async (req, reply) => {
    const input = addPaymentBatchItemsSchema.parse(req.body);
    try {
      return await service.addItems(req.params.id, input, req.user!.id);
    } catch (err) {
      return batchError(err, reply);
    }
  });

  app.patch<{ Params: { id: string; itemId: string } }>("/payment-batches/:id/items/:itemId", write, async (req, reply) => {
    const input = updatePaymentBatchItemSchema.parse(req.body);
    try {
      return await service.updateItem(req.params.id, req.params.itemId, input, req.user!.id);
    } catch (err) {
      return batchError(err, reply);
    }
  });

  app.delete<{ Params: { id: string; itemId: string } }>("/payment-batches/:id/items/:itemId", write, async (req, reply) => {
    try {
      await service.removeItem(req.params.id, req.params.itemId, req.user!.id);
      return reply.code(204).send();
    } catch (err) {
      return batchError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/payment-batches/:id/export", write, async (req, reply) => {
    try {
      return await service.export(req.params.id, req.user!.id);
    } catch (err) {
      return batchError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/payment-batches/:id/file", read, async (req, reply) => {
    try {
      const file = await service.getFile(req.params.id);
      return reply.header("content-type", file.contentType).header("content-disposition", contentDisposition(file.filename)).send(file.data);
    } catch (err) {
      return batchError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/payment-batches/:id/confirm", write, async (req, reply) => {
    const input = confirmPaymentBatchSchema.parse(req.body);
    try {
      return await service.confirm(req.params.id, input, req.user!.id);
    } catch (err) {
      return batchError(err, reply);
    }
  });

  app.post<{ Params: { id: string; itemId: string } }>("/payment-batches/:id/items/:itemId/reject", write, async (req, reply) => {
    const input = rejectPaymentBatchItemSchema.parse(req.body);
    try {
      return await service.rejectItem(req.params.id, req.params.itemId, input, req.user!.id);
    } catch (err) {
      return batchError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/payment-batches/:id/cancel", write, async (req, reply) => {
    try {
      return await service.cancel(req.params.id, req.user!.id);
    } catch (err) {
      return batchError(err, reply);
    }
  });
}
