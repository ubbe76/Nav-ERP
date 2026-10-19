import type { FastifyInstance, FastifyReply } from "fastify";
import {
  configuratorReorderSchema, createConfiguratorBomLineSchema, createConfiguratorGroupSchema, createConfiguratorOperationSchema,
  deriveConfigurationSchema, updateConfiguratorBomLineSchema, updateConfiguratorOperationSchema, createConfiguratorRuleSchema, createConfiguratorTemplateSchema,
  createConfiguratorValueSchema, resolveVariantSchema, updateConfiguratorGroupSchema, updateConfiguratorRuleSchema,
  updateConfiguratorTemplateSchema, updateConfiguratorValueSchema, variantRequestSchema,
} from "@navet/shared";
import { CONFIGURE_ROW_WRITE } from "../../auth/middleware/access-rules.js";
import { errorBody } from "../../system/service/error-body.js";
import { WorkCenterNotFoundError } from "../../manufacturing/service/manufacturing.service.js";
import { ArticleNotFoundError } from "../../article/service/article.service.js";
import { CustomerNotFoundError } from "../../sales/service/sales.service.js";
import type { ConfiguratorService } from "../service/configurator.service.js";
import * as E from "../service/configurator.errors.js";

// Registered with registerModule({ read: office, write: ["artiklar"] }) in
// app.ts: the template is article-card data. derive and the variant preview
// are POSTs but READS, so they override the module write rule with office.
// evaluate lives in public-configurator.routes.ts (delprojekt 5: the OAuth
// scope, shared by sessions and client tokens) and uses `run` from here.
type P = { id: string; groupId?: string; valueId?: string; ruleId?: string; lineId?: string; operationId?: string };

function sendError(reply: FastifyReply, err: unknown) {
  // A reorder with a wrong id set is a malformed request, not a conflict.
  if (err instanceof E.ConfiguratorReorderMismatchError) return reply.code(400).send({ error: err.message, code: "validation-failed" });
  // resolveVariant: the engine's messages ride along so the dialog can show them per group.
  if (err instanceof E.ConfiguratorInvalidConfigurationError) return reply.code(400).send({ ...errorBody(err), details: err.details });
  if (err instanceof E.ConfiguratorVariantTooLongError) return reply.code(400).send(errorBody(err));
  if (err instanceof E.ConfiguratorVariantNumberTakenError || err instanceof E.ConfiguratorVariantNotDerivableError) {
    return reply.code(409).send(errorBody(err));
  }
  if (
    err instanceof E.InvalidConfiguratorRuleError || err instanceof E.InvalidConfiguratorGroupError || err instanceof E.ConfiguratorModeNotAllowedError ||
    err instanceof E.InvalidConfiguratorFormulaError || err instanceof E.InvalidConfiguratorLineError || err instanceof E.InvalidConfiguratorOperationError ||
    err instanceof E.ConfiguratorTooManyCombinationsError || err instanceof E.InvalidConfiguratorVariantSetError
  )
    return reply.code(400).send(errorBody(err));
  if (
    err instanceof E.ConfiguratorTemplateNotFoundError || err instanceof E.ConfiguratorGroupNotFoundError ||
    err instanceof E.ConfiguratorValueNotFoundError || err instanceof E.ConfiguratorRuleNotFoundError ||
    err instanceof E.ConfiguratorLineNotFoundError || err instanceof E.ConfiguratorOperationNotFoundError || err instanceof WorkCenterNotFoundError ||
    err instanceof ArticleNotFoundError || err instanceof CustomerNotFoundError || err instanceof E.ConfiguratorVariantNotFoundError
  ) return reply.code(404).send(errorBody(err));
  if (err instanceof E.ConfiguratorTemplateExistsError || err instanceof E.ConfiguratorCodeTakenError || err instanceof E.ConfiguratorReferenceInUseError ||
    err instanceof E.ConfiguratorSequenceTakenError || err instanceof E.ConfiguratorNotVariantModeError ||
    err instanceof E.ConfiguratorTemplateHasVariantsError || err instanceof E.ConfiguratorVariantNotTemplateError ||
    err instanceof E.ConfiguratorCodeLockedError || err instanceof E.ConfiguratorVariantNumberRaceError)
    return reply.code(409).send(errorBody(err));
  // Anything else (incl. the ZodError parseRuleTarget throws) bubbles to the global handler.
  throw err;
}

// The module's one error mapper, shared by the internal routes and the public
// ones (public-configurator.routes.ts).
export async function run<T>(reply: FastifyReply, fn: () => Promise<T>, code = 200) {
  try {
    const result = await fn();
    return code === 204 ? reply.code(204).send() : reply.code(code).send(result);
  } catch (err) {
    return sendError(reply, err);
  }
}

export async function configuratorRoutes(app: FastifyInstance, opts: { service: ConfiguratorService }) {
  const { service } = opts;

  app.get<{ Params: P }>("/articles/:id/configurator", (req, reply) => run(reply, () => service.getTemplate(req.params.id)));
  app.post<{ Params: P }>("/articles/:id/configurator", (req, reply) =>
    run(reply, () => service.createTemplate(req.params.id, createConfiguratorTemplateSchema.parse(req.body)), 201));
  app.patch<{ Params: P }>("/articles/:id/configurator", (req, reply) =>
    run(reply, () => service.updateTemplate(req.params.id, updateConfiguratorTemplateSchema.parse(req.body))));
  app.delete<{ Params: P }>("/articles/:id/configurator", (req, reply) => run(reply, () => service.deleteTemplate(req.params.id), 204));

  app.post<{ Params: P }>("/articles/:id/configurator/groups", (req, reply) =>
    run(reply, () => service.createGroup(req.params.id, createConfiguratorGroupSchema.parse(req.body)), 201));
  app.post<{ Params: P }>("/articles/:id/configurator/groups/reorder", (req, reply) =>
    run(reply, () => service.reorderGroups(req.params.id, configuratorReorderSchema.parse(req.body).ids), 204));
  app.patch<{ Params: P }>("/articles/:id/configurator/groups/:groupId", (req, reply) =>
    run(reply, () => service.updateGroup(req.params.id, req.params.groupId!, updateConfiguratorGroupSchema.parse(req.body))));
  app.delete<{ Params: P }>("/articles/:id/configurator/groups/:groupId", (req, reply) =>
    run(reply, () => service.deleteGroup(req.params.id, req.params.groupId!), 204));

  app.post<{ Params: P }>("/articles/:id/configurator/groups/:groupId/values", (req, reply) =>
    run(reply, () => service.createValue(req.params.id, req.params.groupId!, createConfiguratorValueSchema.parse(req.body)), 201));
  app.post<{ Params: P }>("/articles/:id/configurator/groups/:groupId/values/reorder", (req, reply) =>
    run(reply, () => service.reorderValues(req.params.id, req.params.groupId!, configuratorReorderSchema.parse(req.body).ids), 204));
  app.patch<{ Params: P }>("/articles/:id/configurator/groups/:groupId/values/:valueId", (req, reply) =>
    run(reply, () => service.updateValue(req.params.id, req.params.groupId!, req.params.valueId!, updateConfiguratorValueSchema.parse(req.body))));
  app.delete<{ Params: P }>("/articles/:id/configurator/groups/:groupId/values/:valueId", (req, reply) =>
    run(reply, () => service.deleteValue(req.params.id, req.params.groupId!, req.params.valueId!), 204));

  app.post<{ Params: P }>("/articles/:id/configurator/rules", (req, reply) =>
    run(reply, () => service.createRule(req.params.id, createConfiguratorRuleSchema.parse(req.body)), 201));
  app.post<{ Params: P }>("/articles/:id/configurator/rules/reorder", (req, reply) =>
    run(reply, () => service.reorderRules(req.params.id, configuratorReorderSchema.parse(req.body).ids), 204));
  app.patch<{ Params: P }>("/articles/:id/configurator/rules/:ruleId", (req, reply) =>
    run(reply, () => service.updateRule(req.params.id, req.params.ruleId!, updateConfiguratorRuleSchema.parse(req.body))));
  app.delete<{ Params: P }>("/articles/:id/configurator/rules/:ruleId", (req, reply) =>
    run(reply, () => service.deleteRule(req.params.id, req.params.ruleId!), 204));

  // Konfigurera på orderraden: fetch-or-create a variant. A write, but one the
  // order forms (sales, manufacturing) make — hence the named rule, not the
  // module's artiklar-only write rule.
  app.post<{ Params: { articleId: string } }>(
    "/configurator/:articleId/variant",
    { config: { access: CONFIGURE_ROW_WRITE } },
    (req, reply) =>
      run(reply, () => service.resolveVariant(req.params.articleId, resolveVariantSchema.parse(req.body ?? {}).selection, req.user?.id ?? null))
  );

  // Static `reorder` segments are registered with their collections; find-my-way ranks them above `:lineId`.
  app.post<{ Params: P }>("/articles/:id/configurator/bom-lines", (req, reply) =>
    run(reply, () => service.createBomLine(req.params.id, createConfiguratorBomLineSchema.parse(req.body)), 201));
  app.post<{ Params: P }>("/articles/:id/configurator/bom-lines/reorder", (req, reply) =>
    run(reply, () => service.reorderBomLines(req.params.id, configuratorReorderSchema.parse(req.body).ids), 204));
  app.patch<{ Params: P }>("/articles/:id/configurator/bom-lines/:lineId", (req, reply) =>
    run(reply, () => service.updateBomLine(req.params.id, req.params.lineId!, updateConfiguratorBomLineSchema.parse(req.body))));
  app.delete<{ Params: P }>("/articles/:id/configurator/bom-lines/:lineId", (req, reply) =>
    run(reply, () => service.deleteBomLine(req.params.id, req.params.lineId!), 204));

  app.post<{ Params: P }>("/articles/:id/configurator/operations", (req, reply) =>
    run(reply, () => service.createOperation(req.params.id, createConfiguratorOperationSchema.parse(req.body)), 201));
  app.patch<{ Params: P }>("/articles/:id/configurator/operations/:operationId", (req, reply) =>
    run(reply, () => service.updateOperation(req.params.id, req.params.operationId!, updateConfiguratorOperationSchema.parse(req.body))));
  app.delete<{ Params: P }>("/articles/:id/configurator/operations/:operationId", (req, reply) =>
    run(reply, () => service.deleteOperation(req.params.id, req.params.operationId!), 204));

  // Stocked variants: list/variant-of are office reads (module read rule), preview is a POST but a read.
  app.get<{ Params: P }>("/articles/:id/configurator/variants", (req, reply) => run(reply, () => service.listVariants(req.params.id)));
  app.post<{ Params: P }>("/articles/:id/configurator/variants/preview", { config: { access: ["office"], readOnlySafe: true } }, (req, reply) =>
    run(reply, () => service.previewVariants(req.params.id, variantRequestSchema.parse(req.body ?? {}))));
  app.post<{ Params: P }>("/articles/:id/configurator/variants", (req, reply) =>
    run(reply, () => service.createVariants(req.params.id, variantRequestSchema.parse(req.body ?? {}), req.user?.id ?? null), 201));
  app.get<{ Params: P }>("/articles/:id/variant-of", (req, reply) => run(reply, () => service.getVariantOf(req.params.id)));

  // derive is a POST but a READ (office), like evaluate.
  app.post<{ Params: { articleId: string } }>(
    "/configurator/:articleId/derive",
    { config: { access: ["office"], readOnlySafe: true } },
    (req, reply) => run(reply, () => service.derive(req.params.articleId, deriveConfigurationSchema.parse(req.body ?? {})))
  );
}
