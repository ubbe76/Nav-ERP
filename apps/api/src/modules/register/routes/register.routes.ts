import type { FastifyInstance } from "fastify";
import {
  createRegisterEntrySchema,
  deleteRegisterEntrySchema,
  packageTypeFreightSchema,
  updateRegisterEntrySchema,
} from "@navet/shared";
import type { RegisterService } from "../service/register.service.js";
import {
  DuplicateRegisterEntryError,
  InvalidReplacementError,
  RegisterEntryInUseError,
  RegisterEntryNotFoundError,
} from "../service/register.service.js";
import { requireRole } from "../../auth/middleware/auth.middleware.js";
import { errorBody } from "../../system/service/error-body.js";

// Base-data registers (grunddata): leveransvillkor, betalningsvillkor,
// speditörer. Registered inside app.ts's protected route scope.
export async function registerRoutes(app: FastifyInstance, opts: { service: RegisterService }) {
  const { service } = opts;
  const admin = { preHandler: requireRole("admin") };

  // Pre-fill delivery terms with Combiterms (idempotent — existing entries
  // are skipped, same pattern as the Swedish-holidays seeding).
  app.post("/delivery-terms/generate-combiterms", async () => service.seedCombiterms());

  // Pre-fill the units register with the standard Swedish units (idempotent).
  app.post("/units/generate-standard", async () => service.seedStandardUnits());

  // Pre-fill the package-types register with the standard kollityper (idempotent).
  app.post("/package-types/generate-standard", async () => service.seedStandardPackageTypes());

  // Kollitypens fraktfält (frakt) — the whole set, see packageTypeFreightSchema.
  app.patch<{ Params: { id: string } }>("/package-types/:id/freight", async (req, reply) => {
    const input = packageTypeFreightSchema.parse(req.body);
    try {
      return await service.updatePackageTypeFreight(req.params.id, input);
    } catch (err) {
      if (err instanceof RegisterEntryNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  const registers = [
    { path: "/delivery-terms", entries: service.deliveryTerms },
    { path: "/payment-terms", entries: service.paymentTerms },
    { path: "/carriers", entries: service.carriers },
    { path: "/units", entries: service.units },
    { path: "/package-types", entries: service.packageTypes },
  ] as const;

  for (const { path, entries } of registers) {
    app.get(path, async () => entries.list());

    app.post(path, async (req, reply) => {
      const input = createRegisterEntrySchema.parse(req.body);
      try {
        return reply.code(201).send(await entries.create(input));
      } catch (err) {
        if (err instanceof DuplicateRegisterEntryError) return reply.code(409).send(errorBody(err));
        throw err;
      }
    });

    app.patch<{ Params: { id: string } }>(`${path}/:id`, async (req, reply) => {
      const input = updateRegisterEntrySchema.parse(req.body);
      try {
        return await entries.update(req.params.id, input);
      } catch (err) {
        if (err instanceof RegisterEntryNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof DuplicateRegisterEntryError) return reply.code(409).send(errorBody(err));
        throw err;
      }
    });

    // What still points at the entry — the web decides from this whether
    // the delete needs a replacement.
    app.get<{ Params: { id: string } }>(`${path}/:id/usage`, async (req, reply) => {
      try {
        return await entries.usage(req.params.id);
      } catch (err) {
        if (err instanceof RegisterEntryNotFoundError) return reply.code(404).send(errorBody(err));
        throw err;
      }
    });

    // Delete with reassignment (admin, like the price-list delete): body
    // { replacementId } is required once anything references the entry —
    // the 409 carries the usage so the client can show what is linked.
    app.delete<{ Params: { id: string } }>(`${path}/:id`, admin, async (req, reply) => {
      const input = deleteRegisterEntrySchema.parse(req.body ?? {});
      try {
        await entries.remove(req.params.id, input.replacementId ?? null);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof RegisterEntryNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof InvalidReplacementError) return reply.code(400).send(errorBody(err));
        if (err instanceof RegisterEntryInUseError) {
          return reply.code(409).send({ ...errorBody(err), usage: err.usage });
        }
        throw err;
      }
    });
  }
}
