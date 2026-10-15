import type { FastifyInstance } from "fastify";
import { createQuoteSchema, priceQuoteQuerySchema } from "@navet/shared";
import type { ArticleService } from "../../article/service/article.service.js";
import type { SalesService } from "../../sales/service/sales.service.js";
import {
  DeliveryAddressNotFoundError,
  InvalidStatusTransitionError,
  SalesOrderNotFoundError,
} from "../../sales/service/sales.service.js";
import {
  ConfigurationNotAllowedError,
  ConfigurationRequiredError,
  PriceNotFoundError,
  RowVariantExistsError,
} from "../../sales/service/sales.errors.js";
import { ArticleIsTemplateError, InvalidUnitError } from "../../article/service/article.service.js";
import type { ConfiguratorService } from "../../configurator/service/configurator.service.js";
import {
  ConfiguratorInvalidConfigurationError,
  ConfiguratorNotPublishedError,
  ConfiguratorNotToOrderModeError,
  ConfiguratorNotVariantModeError,
  ConfiguratorTemplateNotFoundError,
  ConfiguratorVariantNotDerivableError,
  ConfiguratorVariantNumberRaceError,
  ConfiguratorVariantNumberTakenError,
  ConfiguratorVariantTooLongError,
} from "../../configurator/service/configurator.errors.js";
import { errorBody } from "../../system/service/error-body.js";
import {
  ClientCustomerMismatchError,
  ClientScopeMissingError,
  clientCustomerAllowed,
  clientHasScope,
} from "../../auth/middleware/permission.middleware.js";

// Registered under app.ts's requireAuthOrClient scope — reachable by both a
// human session (web UI / manual testing) and a scoped OAuth2 client-credentials
// token (external configurator). The first three are exactly what
// architecture.md §5 names for that integration; GET /price-quote (C3) was
// added on top so the configurator can pre-fill customer prices too.
export async function configuratorRoutes(
  app: FastifyInstance,
  opts: { salesService: SalesService; articleService: ArticleService; configuratorService: ConfiguratorService }
) {
  const { salesService, articleService, configuratorService } = opts;

  app.post("/quotes", { config: { clientScope: "quotes:create" } }, async (req, reply) => {
    const input = createQuoteSchema.parse(req.body);
    if (input.confirm && !clientHasScope(req, "orders:confirm")) {
      return reply.code(403).send(errorBody(new ClientScopeMissingError("orders:confirm")));
    }
    if (!clientCustomerAllowed(req, input.customerId)) {
      return reply.code(403).send(errorBody(new ClientCustomerMismatchError()));
    }
    // Delprojekt 5: an API client may only order configurations of templates
    // published for the API (Visa i API); a session (the web's Ny kundorder)
    // is not affected. Checked here, before createQuote — the client flag
    // never reaches the service.
    if (req.apiClient) {
      const ids = [...new Set(input.rows.filter((r) => r.configuration).map((r) => r.articleId))];
      if (ids.length > 0) {
        const [blocked] = await configuratorService.unpublishedTemplates(ids);
        if (blocked) return reply.code(409).send(errorBody(new ConfiguratorNotPublishedError(blocked.articleNumber)));
      }
    }
    try {
      // Konfigurator 4c: the rows come back without their förkalkyl
      // (configuration_cost) — salesService strips it, so the external
      // configurator never sees what a configuration costs us to make.
      const result = await salesService.createQuote(input, req.user?.id ?? null);
      return reply.code(201).send(result);
    } catch (err) {
      // The delivery address must belong to the quote's customer.
      if (err instanceof DeliveryAddressNotFoundError) return reply.code(400).send(errorBody(err));
      // C3: a row's unitPrice was omitted and the price chain came up empty.
      if (err instanceof PriceNotFoundError) return reply.code(400).send(errorBody(err));
      // A row's unitId is neither the article's base unit nor one of its
      // alternative units (for a configured variants row: the VARIANT's units).
      if (err instanceof InvalidUnitError) return reply.code(400).send(errorBody(err));
      // Produktkonfigurator: a row on a template in mode variants WITHOUT a
      // configuration — the integration sends a configuration (delprojekt 5)
      // or the variant's article instead.
      if (err instanceof ArticleIsTemplateError) return reply.code(409).send(errorBody(err));
      // Konfigurator 4b: a beställningsvara row needs `configuration`; an
      // ordinary row may not carry one; an invalid one answers with the
      // engine's messages as details.
      if (err instanceof ConfigurationRequiredError || err instanceof ConfiguratorNotToOrderModeError) return reply.code(409).send(errorBody(err));
      if (err instanceof ConfigurationNotAllowedError) return reply.code(400).send(errorBody(err));
      if (err instanceof ConfiguratorInvalidConfigurationError) return reply.code(400).send({ ...errorBody(err), details: err.details });
      if (err instanceof ConfiguratorTemplateNotFoundError) return reply.code(404).send(errorBody(err));
      // Delprojekt 5: a configuration on a variants template resolves the
      // variant (4a's resolveVariant) — the same mapping as the sales routes.
      // The engine accepts the choices but the variant's structure cannot be
      // derived — a generic message, never the structure's own (spec).
      if (
        err instanceof ConfiguratorVariantNumberTakenError || err instanceof ConfiguratorVariantNumberRaceError ||
        err instanceof ConfiguratorVariantNotDerivableError
      ) {
        return reply.code(409).send(errorBody(err));
      }
      if (err instanceof ConfiguratorVariantTooLongError) return reply.code(400).send(errorBody(err));
      // Two ordinary rows on the same article (e.g. two identical
      // configurations resolving to one variant), or the template left the
      // variants mode between the read and resolveVariant's lock.
      if (err instanceof RowVariantExistsError || err instanceof ConfiguratorNotVariantModeError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  // C3: same price chain the order-row form pre-fills from — okänd artikel
  // (unknown article, resolvePrice's articleId lookup miss) is a 404, an
  // article with no matching price at any chain level is a 200 with
  // price: null (a real answer, just "nothing to charge beyond the base").
  app.get("/price-quote", { config: { clientScope: "prices:read" } }, async (req, reply) => {
    const query = priceQuoteQuerySchema.parse(req.query);
    if (!clientCustomerAllowed(req, query.customerId)) {
      return reply.code(403).send(errorBody(new ClientCustomerMismatchError()));
    }
    const result = await salesService.getPriceQuote(query);
    if (!result) return reply.code(404).send({ error: "Article not found" });
    return result;
  });

  app.get<{ Params: { id: string } }>("/articles/:id/bom", { config: { clientScope: "structure:read" } }, async (req) => {
    return articleService.getBom(req.params.id);
  });

  app.post<{ Params: { id: string } }>("/sales-orders/:id/confirm", { config: { clientScope: "orders:confirm" } }, async (req, reply) => {
    // A client bound to a customer may only confirm that customer's orders;
    // an unknown order still answers 404 below.
    if (req.apiClient?.customerId) {
      const order = await salesService.getSalesOrder(req.params.id);
      if (order && !clientCustomerAllowed(req, order.customerId)) {
        return reply.code(403).send(errorBody(new ClientCustomerMismatchError()));
      }
    }
    try {
      return await salesService.confirm(req.params.id, req.user?.id ?? null);
    } catch (err) {
      if (err instanceof SalesOrderNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });
}
