import type { FastifyInstance } from "fastify";
import {
  createRegisterEntrySchema,
  deleteRegisterEntrySchema,
  deviationReasonInputSchema,
  packageTypeFreightSchema,
  quoteLossReasonInputSchema,
  updateRegisterEntrySchema,
  type AccessRule,
} from "@navet/shared";
import type { z } from "zod";
import type { RegisterService } from "../service/register.service.js";
import {
  DuplicateRegisterEntryError,
  InvalidReplacementError,
  RegisterEntryInUseError,
  RegisterEntryNotFoundError,
} from "../service/register.service.js";
import { requireRole } from "../../auth/middleware/auth.middleware.js";
import { TERMINAL_READ } from "../../auth/middleware/access-rules.js";
import { errorBody } from "../../system/service/error-body.js";

// Base-data registers (grunddata): leveransvillkor, betalningsvillkor,
// speditörer, enheter, kollityper, förlustorsaker. Registered inside app.ts's
// protected route scope.
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

  // Every register: the same five routes over its own service accessor and
  // input schemas. The module default (read office, write any of artiklar/
  // inkop/forsaljning) applies unless `write` names a narrower rule —
  // förlustorsaker belong to Försäljning (the delete stays admin, as on
  // every register).
  type RegisterEntries<TInput> = {
    list(): Promise<unknown>;
    create(input: TInput): Promise<unknown>;
    update(id: string, input: TInput): Promise<unknown>;
    usage(id: string): Promise<unknown>;
    remove(id: string, replacementId: string | null, userId?: string | null): Promise<unknown>;
  };
  function register<TInput>(
    path: string,
    entries: RegisterEntries<TInput>,
    schemas: { create: z.ZodType<TInput, z.ZodTypeDef, unknown>; update: z.ZodType<TInput, z.ZodTypeDef, unknown> },
    write?: { config: { access: AccessRule } },
    read?: { config: { access: AccessRule } }
  ) {
    app.get(path, read ?? {}, async () => entries.list());

    app.post(path, write ?? {}, async (req, reply) => {
      const input = schemas.create.parse(req.body);
      try {
        return reply.code(201).send(await entries.create(input));
      } catch (err) {
        if (err instanceof DuplicateRegisterEntryError) return reply.code(409).send(errorBody(err));
        throw err;
      }
    });

    app.patch<{ Params: { id: string } }>(`${path}/:id`, write ?? {}, async (req, reply) => {
      const input = schemas.update.parse(req.body);
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
        await entries.remove(req.params.id, input.replacementId ?? null, req.user?.id ?? null);
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

  const termSchemas = { create: createRegisterEntrySchema, update: updateRegisterEntrySchema };
  register("/delivery-terms", service.deliveryTerms, termSchemas);
  register("/payment-terms", service.paymentTerms, termSchemas);
  register("/carriers", service.carriers, termSchemas);
  register("/units", service.units, termSchemas);
  register("/package-types", service.packageTypes, termSchemas);
  register(
    "/quote-loss-reasons",
    service.quoteLossReasons,
    { create: quoteLossReasonInputSchema, update: quoteLossReasonInputSchema },
    { config: { access: ["forsaljning"] } }
  );
  // Avvikelseorsaker belong to Kvalitet; the stamp terminal reads them for
  // the scrap reason (applies_scrap), so the list is a terminal read too.
  register(
    "/deviation-reasons",
    service.deviationReasons,
    { create: deviationReasonInputSchema, update: deviationReasonInputSchema },
    { config: { access: ["kvalitet"] } },
    { config: { access: TERMINAL_READ } }
  );
}
