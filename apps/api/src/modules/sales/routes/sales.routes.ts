import type { FastifyInstance } from "fastify";
import {
  createContactSchema,
  createCustomerSchema,
  createDeliveryAddressSchema,
  createPriceListSchema,
  createSalesOrderRowSchema,
  customerDeliveryDateQuerySchema,
  customerArticleNumberInputSchema,
  customerPriceInputSchema,
  deliverBatchSchema,
  deliveryPalletCardQuerySchema,
  deliverGoodsSchema,
  listPriceListsQuerySchema,
  listQuerySchema,
  listSalesOrdersQuerySchema,
  loseQuoteSchema,
  priceListRowInputSchema,
  salesEmailVariants,
  sendDocumentEmailSchema,
  sendSalesOrderEmailSchema,
  setRowConfigurationSchema,
  setSalesOrderStatusSchema,
  updateContactSchema,
  updateCustomerArticleNumberSchema,
  updateCustomerPriceSchema,
  updateCustomerSchema,
  updateDeliveryAddressSchema,
  updatePriceListRowSchema,
  updatePriceListSchema,
  updateSalesOrderHeaderSchema,
  updateSalesOrderRowSchema,
} from "@navet/shared";
import { z } from "zod";
import { MailSendError, SmtpNotConfiguredError } from "../../mail/service/mail.service.js";
import type { SalesService } from "../service/sales.service.js";
import {
  ContactNotFoundError,
  CustomerNotFoundError,
  DeliveryAddressNotFoundError,
  DeliveryNotFoundError,
  DeliveryOnShipmentError,
  DeliveryRowAlreadyUndoneError,
  DeliveryRowInvoicedError,
  DeliveryRowNotFoundError,
  DeliveryRowNotInDeliveryError,
  DeliveryRowNotUndoableError,
  DeliveryUndoneError,
  DuplicateCustomerNumberError,
  InvalidStatusTransitionError,
  OverDeliveryError,
  QuoteLossReasonInvalidError,
  RowHasDeliveriesError,
  SalesOrderNotFoundError,
  SalesOrderRowNotFoundError,
} from "../service/sales.service.js";
import {
  ConfigurationNotAllowedError,
  ConfigurationRequiredError,
  RowConfigurationOutdatedError,
  CustomerPriceNotFoundError,
  CustomerArticleNumberNotFoundError,
  DuplicateCustomerArticleNumberError,
  DuplicateCustomerPriceError,
  DuplicatePriceListError,
  DuplicatePriceListRowError,
  InvalidFreightProductError,
  PriceListInUseError,
  PriceListNotFoundError,
  PriceListRowNotFoundError,
  PriceNotFoundError,
  RowConfigurationLockedError,
  RowHasManufacturingOrdersError,
  RowVariantExistsError,
  PriceListCurrencyLockedError,
  SalesOrderCurrencyChangedError,
  SalesOrderCurrencyLockedError,
  SalesOrderExchangeRateError,
} from "../service/sales.errors.js";
import { ExchangeRateUnavailableError } from "../../system/service/exchange-rates.js";
import { RegisterEntryNotFoundError } from "../../register/service/register.service.js";
import { LocationUnderStockCountError } from "../../stock/service/stock.service.js";
import { ArticleGroupNotFoundError, ArticleIsTemplateError, ArticleNotFoundError, InvalidUnitError } from "../../article/service/article.service.js";
import {
  ConfiguratorInvalidConfigurationError,
  ConfiguratorNotToOrderModeError,
  ConfiguratorNotVariantModeError,
  ConfiguratorTemplateNotFoundError,
  ConfiguratorVariantNotDerivableError,
  ConfiguratorVariantNumberRaceError,
  ConfiguratorVariantNumberTakenError,
  ConfiguratorVariantTooLongError,
} from "../../configurator/service/configurator.errors.js";
import { requireRole } from "../../auth/middleware/auth.middleware.js";
import { registerListCsvRoute } from "../../system/routes/csv-export.js";
import { contentDisposition } from "../../system/service/content-disposition.js";
import { CostCenterInactiveError, CostCenterNotFoundError, ProjectClosedError, ProjectNotFoundError } from "../../economy/service/dimension-check.js";
import { errorBody } from "../../system/service/error-body.js";
import { SeriesExhaustedError } from "../../system/service/number-series.js";
import { CUSTOMER_CSV_COLUMNS, PRICE_LIST_CSV_COLUMNS, SALES_ORDER_CSV_COLUMNS } from "../service/export-columns.js";

// This module is registered inside app.ts's protected route scope, so
// requireAuth has already run and req.user is guaranteed to be set.
export async function salesRoutes(app: FastifyInstance, opts: { service: SalesService }) {
  const { service } = opts;

  app.get("/customers", async (req) => service.listCustomers(listQuerySchema.parse(req.query)));

  registerListCsvRoute(app, {
    path: "/customers/csv",
    querySchema: listQuerySchema,
    filenameBase: "kunder",
    columns: CUSTOMER_CSV_COLUMNS,
    fetch: (q) => service.listCustomers(q),
  });

  // Fasta leveransdagar: the new sales order's suggested date + warning.
  app.get("/customer-delivery-date-suggestion", async (req, reply) => {
    const query = customerDeliveryDateQuerySchema.parse(req.query);
    const result = await service.getCustomerDeliveryDateSuggestion(query);
    if (!result) return reply.code(404).send(errorBody(new CustomerNotFoundError(query.customerId)));
    return result;
  });

  app.get<{ Params: { id: string } }>("/customers/:id", async (req, reply) => {
    const customer = await service.getCustomer(req.params.id);
    if (!customer) return reply.code(404).send({ error: "Customer not found" });
    return customer;
  });

  app.post("/customers", async (req, reply) => {
    const input = createCustomerSchema.parse(req.body);
    try {
      const customer = await service.createCustomer(input);
      return reply.code(201).send(customer);
    } catch (err) {
      if (err instanceof RegisterEntryNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof InvalidFreightProductError) return reply.code(400).send(errorBody(err));
      if (err instanceof DuplicateCustomerNumberError) return reply.code(409).send(errorBody(err));
      // Retry storm on the number series (all five stepped-over numbers taken)
      // is a retryable conflict, not a server fault — without this it fell
      // through to the global 500 and the series-exhausted dictionary entry
      // was dead code.
      if (err instanceof SeriesExhaustedError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>("/customers/:id", async (req, reply) => {
    const input = updateCustomerSchema.parse(req.body);
    try {
      return await service.updateCustomer(req.params.id, input);
    } catch (err) {
      if (err instanceof CustomerNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof RegisterEntryNotFoundError) return reply.code(404).send(errorBody(err));
      // C3: an unknown priceListId is a bad request on the customer's own
      // update, not a 404 like the terms FKs — the list ID isn't a path
      // parameter naming a resource, it's a field value the caller supplied.
      if (err instanceof PriceListNotFoundError) return reply.code(400).send(errorBody(err));
      if (err instanceof InvalidFreightProductError) return reply.code(400).send(errorBody(err));
      if (err instanceof DuplicateCustomerNumberError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/customers/:id/contacts", async (req, reply) => {
    try {
      return await service.listCustomerContacts(req.params.id);
    } catch (err) {
      if (err instanceof CustomerNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/customers/:id/contacts", async (req, reply) => {
    const input = createContactSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.createCustomerContact(req.params.id, input));
    } catch (err) {
      if (err instanceof CustomerNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.patch<{ Params: { id: string; contactId: string } }>(
    "/customers/:id/contacts/:contactId",
    async (req, reply) => {
      const input = updateContactSchema.parse(req.body);
      try {
        return await service.updateCustomerContact(req.params.id, req.params.contactId, input);
      } catch (err) {
        if (err instanceof ContactNotFoundError) return reply.code(404).send(errorBody(err));
        throw err;
      }
    }
  );

  app.delete<{ Params: { id: string; contactId: string } }>(
    "/customers/:id/contacts/:contactId",
    async (req, reply) => {
      try {
        await service.deleteCustomerContact(req.params.id, req.params.contactId);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof ContactNotFoundError) return reply.code(404).send(errorBody(err));
        throw err;
      }
    }
  );

  // --- Delivery addresses (leveransadresser) ---

  app.get<{ Params: { id: string } }>("/customers/:id/delivery-addresses", async (req, reply) => {
    try {
      return await service.listDeliveryAddresses(req.params.id);
    } catch (err) {
      if (err instanceof CustomerNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/customers/:id/delivery-addresses", async (req, reply) => {
    const input = createDeliveryAddressSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.createDeliveryAddress(req.params.id, input));
    } catch (err) {
      if (err instanceof CustomerNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.patch<{ Params: { id: string; addressId: string } }>(
    "/customers/:id/delivery-addresses/:addressId",
    async (req, reply) => {
      const input = updateDeliveryAddressSchema.parse(req.body);
      try {
        return await service.updateDeliveryAddress(req.params.id, req.params.addressId, input);
      } catch (err) {
        if (err instanceof DeliveryAddressNotFoundError) return reply.code(404).send(errorBody(err));
        throw err;
      }
    }
  );

  app.delete<{ Params: { id: string; addressId: string } }>(
    "/customers/:id/delivery-addresses/:addressId",
    async (req, reply) => {
      try {
        await service.deleteDeliveryAddress(req.params.id, req.params.addressId);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof DeliveryAddressNotFoundError) return reply.code(404).send(errorBody(err));
        throw err;
      }
    }
  );

  // --- C3 Kundpriser: kundpriser ---
  // Same contacts/delivery-addresses subresource shape, no admin guard
  // (unlike the price-list register — these are per-customer agreements,
  // not shared pricing policy).

  app.get<{ Params: { id: string } }>("/customers/:id/prices", async (req, reply) => {
    try {
      return await service.listCustomerPrices(req.params.id);
    } catch (err) {
      if (err instanceof CustomerNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/customers/:id/prices", async (req, reply) => {
    const input = customerPriceInputSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.addCustomerPrice(req.params.id, input, req.user!.id));
    } catch (err) {
      if (err instanceof CustomerNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof ArticleNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof ArticleGroupNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof DuplicateCustomerPriceError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.patch<{ Params: { id: string; priceId: string } }>(
    "/customers/:id/prices/:priceId",
    async (req, reply) => {
      const input = updateCustomerPriceSchema.parse(req.body);
      try {
        return await service.updateCustomerPrice(req.params.id, req.params.priceId, input, req.user!.id);
      } catch (err) {
        if (err instanceof CustomerPriceNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof DuplicateCustomerPriceError) return reply.code(409).send(errorBody(err));
        throw err;
      }
    }
  );

  app.delete<{ Params: { id: string; priceId: string } }>(
    "/customers/:id/prices/:priceId",
    async (req, reply) => {
      try {
        await service.deleteCustomerPrice(req.params.id, req.params.priceId, req.user!.id);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof CustomerPriceNotFoundError) return reply.code(404).send(errorBody(err));
        throw err;
      }
    }
  );

  // --- Kundens artikelnummer (customer card) — same shape as the prices ---
  app.get<{ Params: { id: string } }>("/customers/:id/article-numbers", async (req, reply) => {
    try {
      return await service.listCustomerArticleNumbers(req.params.id);
    } catch (err) {
      if (err instanceof CustomerNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/customers/:id/article-numbers", async (req, reply) => {
    const input = customerArticleNumberInputSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.addCustomerArticleNumber(req.params.id, input, req.user!.id));
    } catch (err) {
      if (err instanceof CustomerNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof ArticleNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof DuplicateCustomerArticleNumberError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.patch<{ Params: { id: string; articleNumberId: string } }>(
    "/customers/:id/article-numbers/:articleNumberId",
    async (req, reply) => {
      const input = updateCustomerArticleNumberSchema.parse(req.body);
      try {
        return await service.updateCustomerArticleNumber(
          req.params.id,
          req.params.articleNumberId,
          input.customerArticleNumber,
          req.user!.id
        );
      } catch (err) {
        if (err instanceof CustomerArticleNumberNotFoundError) return reply.code(404).send(errorBody(err));
        throw err;
      }
    }
  );

  app.delete<{ Params: { id: string; articleNumberId: string } }>(
    "/customers/:id/article-numbers/:articleNumberId",
    async (req, reply) => {
      try {
        await service.deleteCustomerArticleNumber(req.params.id, req.params.articleNumberId, req.user!.id);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof CustomerArticleNumberNotFoundError) return reply.code(404).send(errorBody(err));
        throw err;
      }
    }
  );

  // POST /quotes and GET /price-quote (C3) live in
  // modules/oauth/routes/configurator.routes.ts — reachable by both a human
  // session and a scoped API client token.
  app.get("/sales-orders", async (req) => service.listSalesOrders(listSalesOrdersQuerySchema.parse(req.query)));

  registerListCsvRoute(app, {
    path: "/sales-orders/csv",
    querySchema: listSalesOrdersQuerySchema,
    filenameBase: (q) => (q.kind === "quote" ? "offerter" : "kundordrar"),
    columns: SALES_ORDER_CSV_COLUMNS,
    fetch: (q) => service.listSalesOrders(q),
  });

  app.get<{ Params: { id: string } }>("/sales-orders/:id", async (req, reply) => {
    const order = await service.getSalesOrder(req.params.id);
    if (!order) return reply.code(404).send({ error: "Sales order not found" });
    return order;
  });

  // Header fields (customer's PO number/reference/delivery address).
  app.patch<{ Params: { id: string } }>("/sales-orders/:id", async (req, reply) => {
    const input = updateSalesOrderHeaderSchema.parse(req.body);
    try {
      return await service.updateSalesOrderHeader(req.params.id, input, req.user?.id ?? null);
    } catch (err) {
      if (
        err instanceof SalesOrderNotFoundError ||
        err instanceof DeliveryAddressNotFoundError ||
        err instanceof RegisterEntryNotFoundError ||
        err instanceof CostCenterNotFoundError ||
        err instanceof ProjectNotFoundError
      ) {
        return reply.code(404).send(errorBody(err));
      }
      // Kostnadsställen och projekt: an inactive/closed object on the header.
      if (err instanceof CostCenterInactiveError || err instanceof ProjectClosedError) return reply.code(400).send(errorBody(err));
      if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
      // Valuta: a new currency on an order with rows; no rate for the new
      // currency today (the client asks for the rate); a rate ≠ 1 on SEK.
      if (err instanceof SalesOrderCurrencyLockedError) return reply.code(409).send(errorBody(err));
      if (err instanceof ExchangeRateUnavailableError) {
        return reply.code(409).send({ ...errorBody(err), currency: err.currency, date: err.date });
      }
      if (err instanceof SalesOrderExchangeRateError) return reply.code(400).send(errorBody(err));
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/sales-orders/:id/rows", async (req) => {
    return service.listRows(req.params.id);
  });

  // Leveranstillfälle (delivery occasion) history — newest first.
  app.get<{ Params: { id: string } }>("/sales-orders/:id/deliveries", async (req) => {
    return service.listDeliveries(req.params.id);
  });

  app.post<{ Params: { id: string } }>("/sales-orders/:id/rows", async (req, reply) => {
    const input = createSalesOrderRowSchema.parse(req.body);
    try {
      const row = await service.addRow(req.params.id, input, req.user!.id);
      return reply.code(201).send(row);
    } catch (err) {
      if (err instanceof SalesOrderNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
      // C3: unitPrice omitted and the price chain came up empty.
      if (err instanceof PriceNotFoundError) return reply.code(400).send(errorBody(err));
      // The unit is not one of the row article's units (a configured variants
      // row checks the resolved variant's units, not the template's).
      if (err instanceof InvalidUnitError) return reply.code(400).send(errorBody(err));
      // Produktkonfigurator: a template in mode variants on a new row.
      if (err instanceof ArticleIsTemplateError) return reply.code(409).send(errorBody(err));
      // Konfigurator 4b: a beställningsvara row without / an ordinary row
      // with a configuration, an invalid one (the engine's messages ride
      // along as details), or a template that vanished meanwhile.
      if (err instanceof ConfigurationRequiredError || err instanceof ConfiguratorNotToOrderModeError) return reply.code(409).send(errorBody(err));
      if (err instanceof ConfigurationNotAllowedError) return reply.code(400).send(errorBody(err));
      if (err instanceof ConfiguratorInvalidConfigurationError) return reply.code(400).send({ ...errorBody(err), details: err.details });
      if (err instanceof ConfiguratorTemplateNotFoundError) return reply.code(404).send(errorBody(err));
      // Delprojekt 5: a configuration on a variants template resolves the
      // variant here (4a's resolveVariant) — the same mapping as the PUT below.
      // Not derivable = the engine accepts the choices, the structure does not.
      if (
        err instanceof ConfiguratorVariantNumberTakenError || err instanceof ConfiguratorVariantNumberRaceError ||
        err instanceof ConfiguratorVariantNotDerivableError
      ) {
        return reply.code(409).send(errorBody(err));
      }
      if (err instanceof ConfiguratorVariantTooLongError) return reply.code(400).send(errorBody(err));
      // The article (e.g. the resolved variant) is already an ordinary row on
      // the order, or the template left the variants mode meanwhile.
      if (err instanceof RowVariantExistsError || err instanceof ConfiguratorNotVariantModeError) return reply.code(409).send(errorBody(err));
      // Valuta: the order's currency changed while the row was priced.
      if (err instanceof SalesOrderCurrencyChangedError) {
        return reply.code(409).send({ ...errorBody(err), pricedIn: err.pricedIn, currency: err.currency });
      }
      throw err;
    }
  });

  app.patch<{ Params: { id: string; rowId: string } }>("/sales-orders/:id/rows/:rowId", async (req, reply) => {
    const input = updateSalesOrderRowSchema.parse(req.body);
    try {
      return await service.updateRow(req.params.id, req.params.rowId, input, req.user!.id);
    } catch (err) {
      if (err instanceof SalesOrderNotFoundError || err instanceof SalesOrderRowNotFoundError) {
        return reply.code(404).send(errorBody(err));
      }
      if (err instanceof InvalidStatusTransitionError || err instanceof OverDeliveryError) {
        return reply.code(409).send(errorBody(err));
      }
      // C3: quantity changed, unitPrice omitted, and the re-resolved chain
      // came up empty (e.g. the customer's price list has no row for the
      // new quantity's break).
      if (err instanceof PriceNotFoundError) return reply.code(400).send(errorBody(err));
      // The new unit is not one of the row article's units.
      if (err instanceof InvalidUnitError) return reply.code(400).send(errorBody(err));
      // Konfigurator 4b: a configured row repriced at the new quantity — the
      // stored selection no longer validates, or the template left to_order
      // / was removed since the row was created (Avvikelse 3).
      if (err instanceof ConfiguratorInvalidConfigurationError) return reply.code(400).send({ ...errorBody(err), details: err.details });
      if (err instanceof ConfiguratorNotToOrderModeError) return reply.code(409).send(errorBody(err));
      // The stored choices resolve to another configuration (a förval added
      // to the template since): Ändra konfiguration, not a silent reprice.
      if (err instanceof RowConfigurationOutdatedError) return reply.code(409).send(errorBody(err));
      if (err instanceof ConfiguratorTemplateNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  // Ändra konfiguration (4b): new choices on a beställningsvara row, or a new
  // variant on a variant row. Access is the module's write rule (Försäljning),
  // like the row PATCH above.
  app.put<{ Params: { id: string; rowId: string } }>("/sales-orders/:id/rows/:rowId/configuration", async (req, reply) => {
    const input = setRowConfigurationSchema.parse(req.body);
    try {
      return await service.setRowConfiguration(req.params.id, req.params.rowId, input, req.user!.id);
    } catch (err) {
      // The template vanished since the row was created (Avvikelse 3).
      if (err instanceof SalesOrderNotFoundError || err instanceof SalesOrderRowNotFoundError || err instanceof ConfiguratorTemplateNotFoundError) {
        return reply.code(404).send(errorBody(err));
      }
      // The row has moved on, the variant is already a plain row on the
      // order, or the template left to_order (Avvikelse 3).
      if (err instanceof RowConfigurationLockedError || err instanceof RowVariantExistsError || err instanceof ConfiguratorNotToOrderModeError) {
        return reply.code(409).send(errorBody(err));
      }
      // Neither a configured row nor a variant row; or the new configuration
      // / variant has no price.
      if (err instanceof ConfigurationNotAllowedError || err instanceof PriceNotFoundError) return reply.code(400).send(errorBody(err));
      if (err instanceof ConfiguratorInvalidConfigurationError) return reply.code(400).send({ ...errorBody(err), details: err.details });
      // The variant path (4a's resolveVariant) creating the new variant.
      if (
        err instanceof ConfiguratorVariantNumberTakenError || err instanceof ConfiguratorVariantNumberRaceError ||
        err instanceof ConfiguratorVariantNotDerivableError
      ) {
        return reply.code(409).send(errorBody(err));
      }
      if (err instanceof ConfiguratorVariantTooLongError) return reply.code(400).send(errorBody(err));
      throw err;
    }
  });

  // DELETE has no body — ?bumpRevision=false skips the revision bump.
  app.delete<{ Params: { id: string; rowId: string }; Querystring: { bumpRevision?: string } }>(
    "/sales-orders/:id/rows/:rowId",
    async (req, reply) => {
      try {
        await service.deleteRow(req.params.id, req.params.rowId, req.query.bumpRevision !== "false", req.user!.id);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof SalesOrderNotFoundError || err instanceof SalesOrderRowNotFoundError) {
          return reply.code(404).send(errorBody(err));
        }
        if (
          err instanceof InvalidStatusTransitionError ||
          err instanceof OverDeliveryError ||
          err instanceof RowHasDeliveriesError ||
          err instanceof RowHasManufacturingOrdersError
        ) {
          return reply.code(409).send(errorBody(err));
        }
        throw err;
      }
    }
  );

  // POST /sales-orders/:id/confirm lives in configurator.routes.ts (see above).

  app.get<{ Params: { id: string } }>("/sales-orders/:id/pdf", async (req, reply) => {
    // showConfigurationPrices (konfigurator 4b): Visa tilläggspriser on the
    // configured rows' choice lines; omitted ⇒ the customer's setting.
    const { variant, showConfigurationPrices } = z
      .object({
        variant: z.enum(salesEmailVariants).default("quote"),
        showConfigurationPrices: z
          .enum(["true", "false"])
          .transform((v) => v === "true")
          .optional(),
      })
      .parse(req.query);
    try {
      const { filename, content } = await service.getSalesOrderPdf(req.params.id, variant, showConfigurationPrices);
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", contentDisposition(filename));
      return reply.send(content);
    } catch (err) {
      if (err instanceof SalesOrderNotFoundError) return reply.code(404).send(errorBody(err));
      // A lost quote prints nothing (closed like a cancelled order).
      if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/sales-orders/:id/pick-list", async (req, reply) => {
    try {
      const { filename, content } = await service.getPickListPdf(req.params.id);
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", contentDisposition(filename));
      return reply.send(content);
    } catch (err) {
      if (err instanceof SalesOrderNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/sales-orders/:id/send-email", async (req, reply) => {
    const input = sendSalesOrderEmailSchema.parse(req.body);
    try {
      return await service.sendSalesOrderEmail(req.params.id, input);
    } catch (err) {
      if (err instanceof SalesOrderNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof InvalidStatusTransitionError || err instanceof SmtpNotConfiguredError) {
        return reply.code(409).send(errorBody(err));
      }
      if (err instanceof MailSendError) return reply.code(502).send(errorBody(err));
      throw err;
    }
  });

  // The invoice document — available once the order is invoiced (409 before).
  app.get<{ Params: { id: string } }>("/sales-orders/:id/invoice-pdf", async (req, reply) => {
    try {
      const { filename, content } = await service.getInvoicePdf(req.params.id);
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", contentDisposition(filename));
      return reply.send(content);
    } catch (err) {
      if (err instanceof SalesOrderNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/sales-orders/:id/send-invoice-email", async (req, reply) => {
    const input = sendDocumentEmailSchema.parse(req.body);
    try {
      return await service.sendInvoiceEmail(req.params.id, input);
    } catch (err) {
      if (err instanceof SalesOrderNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof InvalidStatusTransitionError || err instanceof SmtpNotConfiguredError) {
        return reply.code(409).send(errorBody(err));
      }
      if (err instanceof MailSendError) return reply.code(502).send(errorBody(err));
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/sales-orders/:id/start-production", async (req, reply) => {
    try {
      return await service.startProduction(req.params.id, req.user!.id);
    } catch (err) {
      if (err instanceof SalesOrderNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/sales-orders/:id/cancel", async (req, reply) => {
    try {
      return await service.cancel(req.params.id, req.user!.id);
    } catch (err) {
      if (err instanceof SalesOrderNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  // Förlorad: quote → lost with a förlustorsak (400 when unknown/inactive).
  app.post<{ Params: { id: string } }>("/sales-orders/:id/lose", async (req, reply) => {
    const input = loseQuoteSchema.parse(req.body);
    try {
      return await service.lose(req.params.id, input, req.user!.id);
    } catch (err) {
      if (err instanceof SalesOrderNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
      if (err instanceof QuoteLossReasonInvalidError) return reply.code(400).send(errorBody(err));
      throw err;
    }
  });

  // Öppna igen: lost → quote.
  app.post<{ Params: { id: string } }>("/sales-orders/:id/reopen", async (req, reply) => {
    try {
      return await service.reopen(req.params.id, req.user!.id);
    } catch (err) {
      if (err instanceof SalesOrderNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  // POST /sales-orders/:id/invoice was removed in C1 — invoices are now
  // created in the invoice module (invoice.routes.ts). GET .../invoice-pdf
  // and POST .../send-invoice-email above stay: they serve the read-only
  // history of orders that were stamped invoiced before this cutover.

  // Manual status override — bypasses the state machine on purpose.
  app.post<{ Params: { id: string } }>("/sales-orders/:id/set-status", async (req, reply) => {
    const input = setSalesOrderStatusSchema.parse(req.body);
    try {
      return await service.setStatus(req.params.id, input.status, req.user!.id);
    } catch (err) {
      if (err instanceof SalesOrderNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.post<{ Params: { id: string; rowId: string } }>(
    "/sales-orders/:id/rows/:rowId/deliver",
    async (req, reply) => {
      const input = deliverGoodsSchema.parse(req.body);
      try {
        const result = await service.deliverGoods(req.params.id, req.params.rowId, input, req.user!.id);
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof SalesOrderNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof SalesOrderRowNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
        if (err instanceof OverDeliveryError) return reply.code(409).send({ ...errorBody(err), ...err.limit });
        if (err instanceof LocationUnderStockCountError) return reply.code(409).send(errorBody(err));
        throw err;
      }
    }
  );

  // Leveranstillfälle (delivery occasion) — delivers several rows in one
  // batch, creating a single delivery record covering all of them.
  app.post<{ Params: { id: string } }>("/sales-orders/:id/deliver", async (req, reply) => {
    const input = deliverBatchSchema.parse(req.body);
    try {
      const result = await service.deliverBatch(req.params.id, input, req.user!.id);
      return reply.code(201).send(result);
    } catch (err) {
      if (err instanceof SalesOrderNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof SalesOrderRowNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
      if (err instanceof OverDeliveryError) return reply.code(409).send({ ...errorBody(err), ...err.limit });
      if (err instanceof LocationUnderStockCountError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  // Ångra utleverans — reverses one delivery row (sales.service.ts's
  // undoDeliveryRow); the module's write rule (forsaljning), same as deliver.
  app.post<{ Params: { id: string; deliveryId: string; deliveryRowId: string } }>(
    "/sales-orders/:id/deliveries/:deliveryId/rows/:deliveryRowId/undo",
    async (req, reply) => {
      try {
        return await service.undoDeliveryRow(req.params.id, req.params.deliveryId, req.params.deliveryRowId, req.user!.id);
      } catch (err) {
        if (err instanceof DeliveryNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof DeliveryRowNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof DeliveryRowAlreadyUndoneError) return reply.code(409).send(errorBody(err));
        if (err instanceof DeliveryRowNotUndoableError) return reply.code(409).send(errorBody(err));
        if (err instanceof DeliveryOnShipmentError) return reply.code(409).send(errorBody(err));
        if (err instanceof DeliveryRowInvoicedError) return reply.code(409).send(errorBody(err));
        if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
        if (err instanceof LocationUnderStockCountError) return reply.code(409).send(errorBody(err));
        throw err;
      }
    }
  );

  // Följesedel — the delivery note for one leveranstillfälle (delivery
  // occasion), not scoped under /sales-orders since a delivery's id is
  // already globally unique (same top-level shape as /deliveries elsewhere).
  app.get<{ Params: { id: string } }>("/deliveries/:id/pdf", async (req, reply) => {
    try {
      const { filename, pdf: content } = await service.deliveryNotePdf(req.params.id);
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", contentDisposition(filename));
      return reply.send(content);
    } catch (err) {
      if (err instanceof DeliveryNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  // Pallkort (Etapp F) — one card page per delivered row, placed on the
  // pallets when the delivery leaves. Same top-level /deliveries/ shape as
  // the delivery note above. Repeated ?row=<deliveryRowId>:<antal>,<antal>,…
  // picks rows and gives each kolli its quantity (deliveryPalletCardQuerySchema);
  // an empty list skips the row, omitted = every row once.
  app.get<{ Params: { id: string } }>("/deliveries/:id/pallet-card", async (req, reply) => {
    const { row } = deliveryPalletCardQuerySchema.parse(req.query);
    try {
      const { filename, pdf: content } = await service.deliveryPalletCardPdf(req.params.id, row);
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", contentDisposition(filename));
      return reply.send(content);
    } catch (err) {
      if (err instanceof DeliveryNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof DeliveryRowNotInDeliveryError) return reply.code(400).send(errorBody(err));
      if (err instanceof DeliveryUndoneError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  // The delivery's rows for the pallet card dialog: { deliveryNumber,
  // rows: [{ id, articleNumber, articleName, quantity, unit }] }, quantity
  // in the row's unit.
  app.get<{ Params: { id: string } }>("/deliveries/:id/rows", async (req, reply) => {
    try {
      return await service.deliveryRows(req.params.id);
    } catch (err) {
      if (err instanceof DeliveryNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  // --- C3 Kundpriser: prislistor ---
  // Writes are admin-only (pricing policy), same split as stock valuation
  // (stock.routes.ts:140); reads are open to any authenticated user.
  const admin = { preHandler: requireRole("admin") };

  app.get("/price-lists", async (req) => service.listPriceLists(listPriceListsQuerySchema.parse(req.query)));

  registerListCsvRoute(app, {
    path: "/price-lists/csv",
    querySchema: listPriceListsQuerySchema,
    filenameBase: "prislistor",
    columns: PRICE_LIST_CSV_COLUMNS,
    fetch: (q) => service.listPriceLists(q),
  });

  app.get<{ Params: { id: string } }>("/price-lists/:id", async (req, reply) => {
    try {
      return await service.getPriceList(req.params.id);
    } catch (err) {
      if (err instanceof PriceListNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.post("/price-lists", admin, async (req, reply) => {
    const input = createPriceListSchema.parse(req.body);
    try {
      const list = await service.createPriceList(input, req.user!.id);
      return reply.code(201).send(list);
    } catch (err) {
      if (err instanceof DuplicatePriceListError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>("/price-lists/:id", admin, async (req, reply) => {
    const input = updatePriceListSchema.parse(req.body);
    try {
      return await service.updatePriceList(req.params.id, input, req.user!.id);
    } catch (err) {
      if (err instanceof PriceListNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof DuplicatePriceListError) return reply.code(409).send(errorBody(err));
      // Valuta: the list has rows in its current currency.
      if (err instanceof PriceListCurrencyLockedError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>("/price-lists/:id", admin, async (req, reply) => {
    try {
      await service.deletePriceList(req.params.id, req.user!.id);
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof PriceListNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof PriceListInUseError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/price-lists/:id/rows", admin, async (req, reply) => {
    const input = priceListRowInputSchema.parse(req.body);
    try {
      const row = await service.addPriceListRow(req.params.id, input, req.user!.id);
      return reply.code(201).send(row);
    } catch (err) {
      if (err instanceof PriceListNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof ArticleNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof DuplicatePriceListRowError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.patch<{ Params: { id: string; rowId: string } }>("/price-lists/:id/rows/:rowId", admin, async (req, reply) => {
    const input = updatePriceListRowSchema.parse(req.body);
    try {
      return await service.updatePriceListRow(req.params.id, req.params.rowId, input, req.user!.id);
    } catch (err) {
      if (err instanceof PriceListRowNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof DuplicatePriceListRowError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.delete<{ Params: { id: string; rowId: string } }>(
    "/price-lists/:id/rows/:rowId",
    admin,
    async (req, reply) => {
      try {
        await service.deletePriceListRow(req.params.id, req.params.rowId, req.user!.id);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof PriceListRowNotFoundError) return reply.code(404).send(errorBody(err));
        throw err;
      }
    }
  );
}
