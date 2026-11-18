import { z } from "zod";
import { blankSafe, numericMax, numericStep } from "./coerce.js";
import { exchangeRateValueSchema } from "./currency.js";
import type { PriceSource, SalesDocumentKind, SalesOrderStatus, SalesRowPriceOrigin } from "./sales.js";

// Byt kund på en offert eller kundorder (quote/confirmed/in_production,
// nothing delivered, invoiced, shipped or under complaint). The preview
// answers what the change would do; the change itself sends back what the
// user saw (`expected`: the customer the order had, the new currency and
// rate and every row's new price and discount, base unit) and is refused
// with 409 + the fresh preview when that no longer holds. `exchangeRate` is
// the typed rate when today's is missing (as on a new order); it is only
// read when the order changes currency.
export const changeSalesOrderCustomerPreviewSchema = z
  .object({
    customerId: z.string().uuid(),
    exchangeRate: exchangeRateValueSchema.optional(),
  })
  .strict();
export type ChangeSalesOrderCustomerPreviewInput = z.infer<typeof changeSalesOrderCustomerPreviewSchema>;

export const changeSalesOrderCustomerSchema = z
  .object({
    customerId: z.string().uuid(),
    exchangeRate: exchangeRateValueSchema.optional(),
    expected: z
      .object({
        // The customer the order had when the preview was made.
        customerId: z.string().uuid(),
        currency: z.string().length(3),
        exchangeRate: blankSafe(z.coerce.number().min(numericStep(6)).max(numericMax(14, 6))),
        rows: z
          .array(
            z
              .object({
                rowId: z.string().uuid(),
                unitPrice: blankSafe(z.coerce.number().nonnegative().max(numericMax(14, 4))),
                discountPercent: blankSafe(z.coerce.number().min(0).max(100)),
              })
              .strict()
          )
          .max(2000),
      })
      .strict(),
  })
  .strict();
export type ChangeSalesOrderCustomerInput = z.infer<typeof changeSalesOrderCustomerSchema>;

export type CustomerChangeBlockerCode =
  | "invalid-status-transition"
  | "sales-order-has-deliveries"
  | "sales-order-has-invoice-rows"
  | "sales-order-has-shipments"
  | "sales-order-has-deviations";

// What a row is: an ordinary article row, a ställkostnadsrad (follows its
// article row), a configured row / beställningsvara, or the freight row.
export type CustomerChangeRowKind = "article" | "setup" | "configured" | "freight";

// Where a row's price after the change comes from: the new customer's price
// chain, the old price converted to the new currency at the same value in
// kronor, or the old price as it was.
export type CustomerChangePriceOrigin = "chain" | "converted" | "unchanged";

// Why a row kept its price and needs a look: written by hand, a
// ställkostnad the new customer has no ställpris for, configured, the
// freight row (the freight choice is cleared with the address), or the new
// customer's chain has no price for the article.
export type CustomerChangeReview = "manual" | "setup" | "configured" | "freight" | "no-price";

export interface CustomerChangeParty {
  customerId: string;
  customerNumber: string;
  customerName: string;
  currency: string;
  exchangeRate: number;
}

export interface CustomerChangePreview {
  orderId: string;
  orderNumber: string;
  // Offert or kundorder — which document the new customer should be sent.
  documentKind: SalesDocumentKind;
  status: SalesOrderStatus;
  from: CustomerChangeParty;
  to: CustomerChangeParty;
  // What the order takes from the new customer, as a new order would.
  header: {
    deliveryAddress: string | null;
    deliveryTerm: string | null;
    paymentTerm: string | null;
    carrier: string | null;
    customerReference: string | null;
    // "1002 Namn" when the new customer has a Fakturakund.
    invoiceCustomer: string | null;
  };
  // What belonged to the old customer and is cleared: its order and inquiry
  // numbers (the values, null = none), the freight choice with its quote,
  // and the order's own engångsadress.
  clears: {
    customerOrderNumber: string | null;
    customerInquiryNumber: string | null;
    freight: boolean;
    oneOffDeliveryAddress: boolean;
  };
  // Why the customer cannot be changed (Swedish text); empty = allowed.
  blockers: { code: CustomerChangeBlockerCode; message: string }[];
  // Prices in the article's base unit, like the row's own columns.
  rows: {
    rowId: string;
    articleId: string;
    articleNumber: string;
    articleName: string;
    quantity: number;
    unitCode: string;
    unitFactor: number | null;
    kind: CustomerChangeRowKind;
    before: { unitPrice: number; discountPercent: number; priceOrigin: SalesRowPriceOrigin };
    // `source`: the chain step that priced it (null when the price is kept).
    after: { unitPrice: number; discountPercent: number; priceOrigin: SalesRowPriceOrigin; source: PriceSource | null };
    origin: CustomerChangePriceOrigin;
    // null = priced by the new customer's chain; otherwise why it was kept.
    review: CustomerChangeReview | null;
  }[];
}
