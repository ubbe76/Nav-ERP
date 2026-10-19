"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { KpiRow, KpiTile } from "../dashboard/KpiTile";
import { Card } from "../ui/Card";
import { ArticlePicker, type ArticlePickerValue } from "../ui/ArticlePicker";
import { Checkbox, Field, Input, Select } from "../ui/Field";
import { FormError, FormHint, FormRow, FormStack } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { API_URL, apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney } from "../../lib/format";
import {
  PURCHASE_ORDER_STATUS_PILL,
  SALES_ORDER_STATUS_PILL,
  type ArticleGroup,
  type Customer,
  type Paged,
  type Supplier,
} from "../../lib/types";
import buttonStyles from "../ui/Button.module.css";
import { ReportCsvLink } from "./ReportCsvLink";
import styles from "./OrderRegister.module.css";

interface RegisterRow {
  articleNumber: string;
  articleName: string;
  unit: string | null;
  quantity: number;
  done: number;
  rest: number;
  unitPrice: number;
  discountPercent: number;
  setupPrice: number | null;
  amount: number;
  restAmount: number;
  deliveryDate: string | null;
}

interface RegisterOrder {
  id: string;
  orderNumber: string;
  status: string;
  orderDate: string;
  partnerNumber: string;
  partnerName: string;
  currency: string;
  deliveryDate: string | null;
  orderValue: number;
  restValue: number;
  rowCount: number;
  rows?: RegisterRow[];
}

interface RegisterResponse {
  orders: RegisterOrder[];
  totals: {
    orderCount: number;
    rowCount: number;
    orderValueSek: number;
    restValueSek: number;
    converted: boolean;
  };
}

type Pill = {
  status: "running" | "delayed" | "stopped" | "done" | "draft";
  label: string;
};

const SIDES = {
  sales: {
    endpoint: "/api/v1/reports/sales-order-register",
    partnerLabel: "Kund",
    partnersEndpoint: "/api/v1/customers?limit=1000",
    doneLabel: "Levererat",
    orderHref: (id: string) => `/forsaljning/ordrar/${id}`,
    pills: SALES_ORDER_STATUS_PILL as Record<string, Pill>,
  },
  purchase: {
    endpoint: "/api/v1/reports/purchase-order-register",
    partnerLabel: "Leverantör",
    partnersEndpoint: "/api/v1/suppliers?limit=1000",
    doneLabel: "Mottaget",
    orderHref: (id: string) => `/inkop/ordrar/${id}`,
    pills: PURCHASE_ORDER_STATUS_PILL as Record<string, Pill>,
  },
} as const;

const qty = (n: number) => n.toLocaleString("sv-SE", { maximumFractionDigits: 4 });

export interface OrderRegisterDefaults {
  dateBasis?: string;
  from?: string;
  to?: string;
  partnerId?: string;
  status?: string;
  openOnly?: string;
  articleId?: string;
  articleGroupId?: string;
  withRows?: string;
}

// Orderförteckning kundorder / inköp — one client for both sides. Every
// filter lives in the URL so a selection can be bookmarked or sent on, and
// the same query string drives the screen, the PDF and the CSV.
export function OrderRegisterPageClient({
  kind,
  defaults,
}: {
  kind: "sales" | "purchase";
  defaults: OrderRegisterDefaults;
}) {
  const side = SIDES[kind];
  const router = useRouter();
  const pathname = usePathname();

  const [dateBasis, setDateBasis] = useState(defaults.dateBasis === "delivery" ? "delivery" : "order");
  const [from, setFrom] = useState(defaults.from ?? "");
  const [to, setTo] = useState(defaults.to ?? "");
  const [partnerId, setPartnerId] = useState(defaults.partnerId ?? "");
  // "open" unless the URL says otherwise; "" = alla statusar.
  const [status, setStatus] = useState(defaults.status ?? "open");
  const [openOnly, setOpenOnly] = useState(defaults.openOnly === "true");
  const [article, setArticle] = useState<ArticlePickerValue | null>(null);
  const [articleId, setArticleId] = useState(defaults.articleId ?? "");
  const [articleGroupId, setArticleGroupId] = useState(defaults.articleGroupId ?? "");
  const [withRows, setWithRows] = useState(defaults.withRows === "true");

  const [partners, setPartners] = useState<{ id: string; label: string }[]>([]);
  const [groups, setGroups] = useState<ArticleGroup[]>([]);
  const [data, setData] = useState<RegisterResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<Paged<Customer | Supplier>>(side.partnersEndpoint)
      .then((page) =>
        setPartners(
          page.rows.map((p) => ({
            id: p.id,
            label: `${"customerNumber" in p ? p.customerNumber : p.supplierNumber} ${p.name}`,
          })),
        ),
      )
      .catch(() => setPartners([]));
    apiFetch<ArticleGroup[]>("/api/v1/article-groups")
      .then(setGroups)
      .catch(() => setGroups([]));
  }, [side.partnersEndpoint]);

  // An article chosen in the URL is shown by number once it is looked up.
  useEffect(() => {
    if (!defaults.articleId) return;
    apiFetch<ArticlePickerValue>(`/api/v1/articles/${defaults.articleId}`)
      .then((a) => setArticle({ id: a.id, articleNumber: a.articleNumber, name: a.name }))
      .catch(() => setArticle(null));
  }, [defaults.articleId]);

  const qs = new URLSearchParams();
  qs.set("dateBasis", dateBasis);
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  if (partnerId) qs.set("partnerId", partnerId);
  qs.set("status", status);
  if (openOnly) qs.set("openOnly", "true");
  if (articleId) qs.set("articleId", articleId);
  if (articleGroupId) qs.set("articleGroupId", articleGroupId);
  if (withRows) qs.set("withRows", "true");
  const qsString = qs.toString();

  useEffect(() => {
    router.replace(`${pathname}?${qsString}`, { scroll: false });
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<RegisterResponse>(`${side.endpoint}?${qsString}`)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setData(null);
        setError(apiErrorMessage(err, "Kunde inte hämta orderförteckningen"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- router/pathname are stable
  }, [qsString]);

  const statusCell = (order: RegisterOrder) => {
    const pill = side.pills[order.status];
    return pill ? <StatusPill status={pill.status} label={pill.label} compact /> : order.status;
  };
  const orderLink = (order: RegisterOrder) => (
    <GatedLink href={side.orderHref(order.id)} className={styles.orderLink}>
      {order.orderNumber}
    </GatedLink>
  );
  const money = (amount: number, currency: string) =>
    `${formatMoney(amount)}${currency !== "SEK" ? ` ${currency}` : ""}`;

  return (
    <>
      <Card maxWidth="none" style={{ marginBottom: 20 }}>
        <FormStack>
          <FormRow columns={3}>
            <Field label="Datum avser" htmlFor="registerDateBasis">
              <Select id="registerDateBasis" value={dateBasis} onChange={(e) => setDateBasis(e.target.value)}>
                <option value="order">Orderdatum</option>
                <option value="delivery">Leveransdatum</option>
              </Select>
            </Field>
            <Field label="Från" htmlFor="registerFrom">
              <Input id="registerFrom" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="Till" htmlFor="registerTo">
              <Input id="registerTo" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </FormRow>
          <FormRow columns={3}>
            <Field label={side.partnerLabel} htmlFor="registerPartner">
              <Select id="registerPartner" value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
                <option value="">{kind === "sales" ? "Alla kunder" : "Alla leverantörer"}</option>
                {partners.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Status" htmlFor="registerStatus">
              <Select id="registerStatus" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="open">Öppna ordrar</option>
                <option value="">Alla statusar</option>
                {Object.entries(side.pills).map(([value, pill]) => (
                  <option key={value} value={value}>
                    {pill.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Artikelgrupp" htmlFor="registerGroup">
              <Select id="registerGroup" value={articleGroupId} onChange={(e) => setArticleGroupId(e.target.value)}>
                <option value="">Alla artikelgrupper</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.code} {g.name}
                  </option>
                ))}
              </Select>
            </Field>
          </FormRow>
          <FormRow columns={3}>
            <Field label="Artikel" htmlFor="registerArticle">
              <ArticlePicker
                id="registerArticle"
                value={article}
                onChange={(a) => {
                  setArticle(a);
                  setArticleId(a?.id ?? "");
                }}
              />
            </Field>
          </FormRow>
          <div className={styles.toggles}>
            <label className={styles.toggle}>
              <Checkbox checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
              <span>Bara rader med rest</span>
            </label>
            <label className={styles.toggle}>
              <Checkbox checked={withRows} onChange={(e) => setWithRows(e.target.checked)} />
              <span>Visa rader</span>
            </label>
          </div>
        </FormStack>
      </Card>

      <FormError margin="below">{error}</FormError>
      {loading && <FormHint>Hämtar orderförteckningen…</FormHint>}

      {data && !loading && (
        <>
          <KpiRow>
            <KpiTile label="Ordrar" value={data.totals.orderCount.toLocaleString("sv-SE")} />
            <KpiTile label="Rader" value={data.totals.rowCount.toLocaleString("sv-SE")} />
            <KpiTile
              label={`Ordervärde${data.totals.converted ? " (SEK)" : ""}`}
              value={`${formatMoney(data.totals.orderValueSek)} kr`}
            />
            <KpiTile
              label={`Restvärde${data.totals.converted ? " (SEK)" : ""}`}
              value={`${formatMoney(data.totals.restValueSek)} kr`}
            />
          </KpiRow>
          {data.totals.converted && (
            <FormHint>
              Ordrar i annan valuta visas i sin valuta; summorna är omräknade till SEK med orderns växelkurs.
            </FormHint>
          )}

          <Card maxWidth="none" style={{ margin: "16px 0" }}>
            <div className={styles.actions}>
              <a
                href={`${API_URL}${side.endpoint}/pdf?${qsString}`}
                target="_blank"
                rel="noreferrer"
                className={`${buttonStyles.button} ${buttonStyles.secondary}`}
              >
                Skriv ut
              </a>
              <ReportCsvLink path={`${side.endpoint}/csv?${qsString}`} />
            </div>

            {!withRows && (
              <Table<RegisterOrder>
                columns={[
                  { key: "orderNumber", label: "Order", width: "100px" },
                  { key: "orderDate", label: "Orderdatum", width: "95px" },
                  {
                    key: "partner",
                    label: side.partnerLabel,
                    width: "minmax(140px, 1fr)",
                  },
                  { key: "status", label: "Status", width: "130px" },
                  {
                    key: "deliveryDate",
                    label: "Leveransdatum",
                    width: "105px",
                  },
                  {
                    key: "orderValue",
                    label: "Ordervärde",
                    width: "115px",
                    align: "right",
                  },
                  {
                    key: "restValue",
                    label: "Restvärde",
                    width: "115px",
                    align: "right",
                  },
                ]}
                rows={data.orders}
                emptyText="Inga ordrar matchar urvalet."
                renderCell={(order, key) => {
                  switch (key) {
                    case "orderNumber":
                      return orderLink(order);
                    case "orderDate":
                      return <span className="num">{order.orderDate}</span>;
                    case "partner":
                      return `${order.partnerNumber} ${order.partnerName}`;
                    case "status":
                      return statusCell(order);
                    case "deliveryDate":
                      return <span className="num">{order.deliveryDate ?? "—"}</span>;
                    case "orderValue":
                      return <span className="num">{money(order.orderValue, order.currency)}</span>;
                    case "restValue":
                      return <span className="num">{money(order.restValue, order.currency)}</span>;
                    default:
                      return null;
                  }
                }}
              />
            )}

            {withRows && data.orders.length === 0 && <FormHint>Inga ordrar matchar urvalet.</FormHint>}
            {withRows &&
              data.orders.map((order) => (
                <section key={order.id} className={styles.order}>
                  <div className={styles.orderHead}>
                    <div className={styles.orderTitle}>
                      {orderLink(order)}
                      <span>{`${order.partnerNumber} ${order.partnerName}`}</span>
                      {statusCell(order)}
                    </div>
                    <div className={styles.orderMeta}>
                      <span>Orderdatum {order.orderDate}</span>
                      <span>
                        Ordervärde <span className="num">{money(order.orderValue, order.currency)}</span>
                      </span>
                      <span>
                        Restvärde <span className="num">{money(order.restValue, order.currency)}</span>
                      </span>
                    </div>
                  </div>
                  <Table<RegisterRow & { id: string }>
                    columns={[
                      {
                        key: "article",
                        label: "Artikel",
                        width: "minmax(160px, 1fr)",
                      },
                      {
                        key: "quantity",
                        label: "Antal",
                        width: "70px",
                        align: "right",
                      },
                      {
                        key: "done",
                        label: side.doneLabel,
                        width: "80px",
                        align: "right",
                      },
                      {
                        key: "rest",
                        label: "Rest",
                        width: "70px",
                        align: "right",
                      },
                      {
                        key: "unitPrice",
                        label: "À-pris",
                        width: "90px",
                        align: "right",
                      },
                      {
                        key: "amount",
                        label: "Belopp",
                        width: "100px",
                        align: "right",
                      },
                      {
                        key: "restAmount",
                        label: "Restbelopp",
                        width: "100px",
                        align: "right",
                      },
                      {
                        key: "deliveryDate",
                        label: "Leveransdatum",
                        width: "100px",
                      },
                    ]}
                    rows={(order.rows ?? []).map((row, index) => ({
                      ...row,
                      id: `${order.id}-${index}`,
                    }))}
                    renderCell={(row, key) => {
                      switch (key) {
                        case "article":
                          return (
                            <div>
                              <div className="num">{row.articleNumber}</div>
                              <div className={styles.muted}>{row.articleName}</div>
                            </div>
                          );
                        case "quantity":
                          return <span className="num">{`${qty(row.quantity)}${row.unit ? ` ${row.unit}` : ""}`}</span>;
                        case "done":
                          return <span className="num">{qty(row.done)}</span>;
                        case "rest":
                          return <span className="num">{qty(row.rest)}</span>;
                        case "unitPrice":
                          return (
                            <div>
                              <div className="num">{formatMoney(row.unitPrice)}</div>
                              {row.discountPercent > 0 && (
                                <div className={styles.muted}>Rabatt {qty(row.discountPercent)} %</div>
                              )}
                            </div>
                          );
                        case "amount":
                          return <span className="num">{formatMoney(row.amount)}</span>;
                        case "restAmount":
                          return <span className="num">{formatMoney(row.restAmount)}</span>;
                        case "deliveryDate":
                          return <span className="num">{row.deliveryDate ?? "—"}</span>;
                        default:
                          return null;
                      }
                    }}
                  />
                </section>
              ))}
          </Card>
        </>
      )}
    </>
  );
}
