import { headers } from "next/headers";
import { AppShell } from "../../../../components/AppShell";
import { NewDeviationForm } from "../../../../components/quality/NewDeviationForm";
import { emptyDraft, type DeviationDraft } from "../../../../components/quality/deviationDraft";
import { HelpLink } from "../../../../components/ui/HelpLink";
import { apiGet } from "../../../../lib/api";
import type { PageSearchParams } from "../../../../lib/listQuery";
import {
  DEVIATION_TYPES,
  getResponsibleCandidates,
  reasonAppliesToType,
  type DeviationReason,
  type DeviationType,
} from "../../../../lib/quality";
import type {
  Article,
  Customer,
  Invoice,
  ManufacturingOrder,
  PurchaseOrder,
  PurchaseOrderRow,
  SalesOrder,
  SalesOrderRow,
  Supplier,
} from "../../../../lib/types";
import shellStyles from "../../../../components/AppShell.module.css";

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// Ny avvikelse. The documents' "Ny reklamation"/"Ny avvikelse" buttons link
// here with the context in the query string (type, customerId, salesOrderId,
// salesOrderRowId, invoiceId, supplierId, purchaseOrderId, purchaseOrderRowId,
// manufacturingOrderId, moOperationId, articleId, quantity, reasonId, title);
// the ids are resolved to names here so the form opens already filled in.
export default async function NewDeviationPage(props: { searchParams: Promise<PageSearchParams> }) {
  const sp = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const get = <T,>(path: string | null) => (path ? apiGet<T>(path, cookieHeader).catch(() => null) : Promise.resolve(null));

  const customerId = single(sp.customerId);
  const supplierId = single(sp.supplierId);
  const salesOrderId = single(sp.salesOrderId);
  const invoiceId = single(sp.invoiceId);
  const purchaseOrderId = single(sp.purchaseOrderId);
  const manufacturingOrderId = single(sp.manufacturingOrderId);
  const articleId = single(sp.articleId);
  const salesOrderRowId = single(sp.salesOrderRowId);
  const purchaseOrderRowId = single(sp.purchaseOrderRowId);

  const [reasons, responsible, customer, supplier, salesOrder, salesRows, invoice, purchaseOrder, purchaseRows, mo, article] =
    await Promise.all([
      apiGet<DeviationReason[]>("/api/v1/deviation-reasons", cookieHeader),
      getResponsibleCandidates(cookieHeader),
      get<Customer>(customerId ? `/api/v1/customers/${customerId}` : null),
      get<Supplier>(supplierId ? `/api/v1/suppliers/${supplierId}` : null),
      get<SalesOrder>(salesOrderId ? `/api/v1/sales-orders/${salesOrderId}` : null),
      get<SalesOrderRow[]>(salesOrderId && salesOrderRowId ? `/api/v1/sales-orders/${salesOrderId}/rows` : null),
      get<Invoice>(invoiceId ? `/api/v1/invoices/${invoiceId}` : null),
      get<PurchaseOrder>(purchaseOrderId ? `/api/v1/purchase-orders/${purchaseOrderId}` : null),
      get<PurchaseOrderRow[]>(purchaseOrderId && purchaseOrderRowId ? `/api/v1/purchase-orders/${purchaseOrderId}/rows` : null),
      get<ManufacturingOrder>(manufacturingOrderId ? `/api/v1/manufacturing-orders/${manufacturingOrderId}` : null),
      get<Article>(articleId ? `/api/v1/articles/${articleId}` : null),
    ]);

  // The type: given, else implied by what the link points at, else chosen in the form.
  const givenType = DEVIATION_TYPES.find((t) => t === single(sp.type));
  const type: DeviationType | null =
    givenType ??
    (customerId || salesOrderId || invoiceId ? "customer" : supplierId || purchaseOrderId ? "supplier" : manufacturingOrderId ? "internal" : null);

  const draft: DeviationDraft = emptyDraft(type ?? "internal");
  const salesRow = salesRows?.find((r) => r.id === salesOrderRowId) ?? null;
  const purchaseRow = purchaseRows?.find((r) => r.id === purchaseOrderRowId) ?? null;

  if (customer) draft.customer = { id: customer.id, label: `${customer.customerNumber} — ${customer.name}` };
  else if (salesOrder) draft.customer = { id: salesOrder.customerId, label: salesOrder.customerName };
  else if (invoice) draft.customer = { id: invoice.customerId, label: invoice.customerName };
  if (supplier) draft.supplier = { id: supplier.id, label: `${supplier.supplierNumber} — ${supplier.name}` };
  else if (purchaseOrder) draft.supplier = { id: purchaseOrder.supplierId, label: purchaseOrder.supplierName };
  if (salesOrder) draft.salesOrder = { id: salesOrder.id, label: `${salesOrder.orderNumber} — ${salesOrder.customerName}` };
  if (salesRow) draft.salesOrderRowId = salesRow.id;
  if (invoice) draft.invoice = { id: invoice.id, label: `${invoice.invoiceNumber ?? "Utkast"} — ${invoice.customerName}` };
  if (purchaseOrder) draft.purchaseOrder = { id: purchaseOrder.id, label: `${purchaseOrder.orderNumber} — ${purchaseOrder.supplierName}` };
  if (purchaseRow) draft.purchaseOrderRowId = purchaseRow.id;
  if (mo) {
    draft.manufacturingOrder = { id: mo.id, label: `${mo.orderNumber} — ${mo.articleNumber} ${mo.articleName}` };
    draft.moOperationId = single(sp.moOperationId) ?? "";
  }
  // The article: given, else the row's, else the TO's.
  if (article) {
    draft.article = { id: article.id, articleNumber: article.articleNumber, name: article.name };
    draft.articleUnit = article.unit;
  } else if (salesRow) {
    draft.article = { id: salesRow.articleId, articleNumber: salesRow.articleNumber, name: salesRow.articleName };
  } else if (purchaseRow) {
    draft.article = { id: purchaseRow.articleId, articleNumber: purchaseRow.articleNumber, name: purchaseRow.articleName };
  } else if (mo) {
    draft.article = { id: mo.articleId, articleNumber: mo.articleNumber, name: mo.articleName };
    draft.articleUnit = mo.articleUnitCode ?? "";
  }
  const quantity = Number(single(sp.quantity));
  if (Number.isFinite(quantity) && quantity > 0) draft.quantity = String(quantity);
  draft.title = single(sp.title) ?? "";
  // A reason that does not apply to the type would only be refused.
  const reasonId = single(sp.reasonId);
  const reason = reasons.find((r) => r.id === reasonId);
  if (type && reason && reason.active && reasonAppliesToType(reason, type)) draft.reasonId = reason.id;

  return (
    <AppShell active="Kvalitet">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Ny avvikelse</div>
          <div className={shellStyles.meta}>Kundreklamation, leverantörsavvikelse eller intern avvikelse</div>
        </div>
        <HelpLink chapter="kvalitet" anchor="ny-avvikelse" label="Hjälp om ny avvikelse" />
      </div>

      <NewDeviationForm initial={draft} typeChosen={type !== null} reasons={reasons} responsible={responsible} />
    </AppShell>
  );
}
