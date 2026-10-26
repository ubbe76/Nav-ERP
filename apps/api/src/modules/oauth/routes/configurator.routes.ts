import type { FastifyInstance } from "fastify";
import { deviationLinkForbidden } from "../../quality/service/deviation-link-access.js";
import { DeviationLinkNotAllowedError } from "../../quality/service/deviation-errors.js";
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
import { CostCenterInactiveError, CostCenterNotFoundError, ProjectClosedError, ProjectNotFoundError } from "../../economy/service/dimension-check.js";
import { errorBody } from "../../system/service/error-body.js";
import { ExchangeRateUnavailableError } from "../../system/service/exchange-rates.js";
import { SalesOrderExchangeRateError } from "../../sales/service/sales.errors.js";
import {
  ClientCustomerMismatchError,
  ClientPriceNotAllowedError,
  ClientScopeMissingError,
  clientCurrencyAllowed,
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
    // Avvikelser (Skapa ersättningsorder): linking the order to a case is a
    // Kvalitet write — never for an API client.
    const forbidden = deviationLinkForbidden(input.deviationId, req.user);
    if (forbidden) return reply.code(403).send(errorBody(forbidden));
    // A client bound to a customer never sets the price: Nav prices every row
    // from the customer's price chain (customer price, price list, discount,
    // the configurator's own price for configured rows). An unbound internal
    // client may still send its prices.
    // Valuta: the rate prices every row converted from SEK — a bound client
    // takes today's rate like it takes the chain's prices.
    if (
      req.apiClient?.customerId &&
      (input.exchangeRate !== undefined || input.rows.some((r) => r.unitPrice !== undefined || r.discountPercent !== undefined))
    ) {
      return reply.code(403).send(errorBody(new ClientPriceNotAllowedError()));
    }
    // Valuta: nor another currency than the customer's — the särpriser and
    // the customer's rabattregel only apply in its own currency.
    if (req.apiClient?.customerId && input.currency !== undefined) {
      const customer = await salesService.getCustomer(input.customerId);
      if (!clientCurrencyAllowed(req, input.currency, customer?.currency ?? null)) {
        return reply.code(403).send(errorBody(new ClientPriceNotAllowedError()));
      }
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
      // Avvikelser: the case cannot take the link (closed, wrong type, other customer).
      if (err instanceof DeviationLinkNotAllowedError) return reply.code(409).send(errorBody(err));
      // Kostnadsställen och projekt on the header: unknown (404), inactive/closed (400).
      if (err instanceof CostCenterNotFoundError || err instanceof ProjectNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof CostCenterInactiveError || err instanceof ProjectClosedError) return reply.code(400).send(errorBody(err));
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
      // Valuta: no rate for the order's currency today (send exchangeRate),
      // or a rate ≠ 1 on a SEK order.
      if (err instanceof ExchangeRateUnavailableError) {
        return reply.code(409).send({ ...errorBody(err), currency: err.currency, date: err.date });
      }
      if (err instanceof SalesOrderExchangeRateError) return reply.code(400).send(errorBody(err));
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
    // Valuta: a bound client reads its customer's prices in the customer's
    // currency only (another one would show the price lists past them).
    if (req.apiClient?.customerId && query.currency !== undefined) {
      const customer = await salesService.getCustomer(query.customerId);
      if (!clientCurrencyAllowed(req, query.currency, customer?.currency ?? null)) {
        return reply.code(403).send(errorBody(new ClientPriceNotAllowedError()));
      }
    }
    let result;
    try {
      result = await salesService.getPriceQuote(query);
    } catch (err) {
      // Valuta: an unknown salesOrderId, no rate for the currency today, or
      // a rate ≠ 1 for SEK.
      if (err instanceof SalesOrderNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof ExchangeRateUnavailableError) {
        return reply.code(409).send({ ...errorBody(err), currency: err.currency, date: err.date });
      }
      if (err instanceof SalesOrderExchangeRateError) return reply.code(400).send(errorBody(err));
      throw err;
    }
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
