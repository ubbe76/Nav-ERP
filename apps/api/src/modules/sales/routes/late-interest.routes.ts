import type { FastifyInstance } from "fastify";
import { createLateInterestInvoicesSchema, lateInterestCandidatesQuerySchema } from "@navet/shared";
import { InvalidVatCodeError } from "../../economy/service/document-vat-code.js";
import { errorBody } from "../../system/service/error-body.js";
import {
  LateInterestAlreadyChargedError,
  LateInterestDisabledError,
  LateInterestFutureDateError,
  type LateInterestService,
} from "../service/late-interest.service.js";

// Räntefakturering (Försäljning). Registered like the invoices: read office,
// write forsaljning. The candidate GET may fetch referensräntor from
// Riksbanken (reference data, outside any transaction — like GET
// /exchange-rates).
export async function lateInterestRoutes(app: FastifyInstance, opts: { service: LateInterestService }) {
  const { service } = opts;

  function lateInterestError(err: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    if (err instanceof LateInterestDisabledError) return reply.code(409).send(errorBody(err));
    if (err instanceof LateInterestFutureDateError) return reply.code(400).send({ ...errorBody(err), today: err.today });
    if (err instanceof LateInterestAlreadyChargedError) {
      return reply.code(409).send({ ...errorBody(err), invoiceIds: err.invoiceIds });
    }
    // Momskod UTM deactivated — a data problem, reported like on a row.
    if (err instanceof InvalidVatCodeError) return reply.code(400).send({ ...errorBody(err), reason: err.reason });
    throw err;
  }

  app.get("/late-interest/candidates", async (req, reply) => {
    const query = lateInterestCandidatesQuerySchema.parse(req.query);
    try {
      return await service.listCandidates(query);
    } catch (err) {
      return lateInterestError(err, reply);
    }
  });

  app.post("/late-interest/invoices", async (req, reply) => {
    const input = createLateInterestInvoicesSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.createInvoices(input, req.user!.id));
    } catch (err) {
      return lateInterestError(err, reply);
    }
  });
}
