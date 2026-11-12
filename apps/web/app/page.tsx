import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import styles from "./page.module.css";
import shellStyles from "../components/AppShell.module.css";
import { AppToolbar } from "../components/AppToolbar";
import { StatusBar } from "../components/StatusBar";
import { ReadOnlyBanner } from "../components/ReadOnlyBanner";
import { Nav } from "../components/ui/Nav";
import { PermissionsProvider } from "../components/PermissionsProvider";
import { Button } from "../components/ui/Button";
import { FlowStrip, type FlowStation } from "../components/dashboard/FlowStrip";
import { AttentionCard, type AttentionItem } from "../components/dashboard/AttentionCard";
import { OrdersCard } from "../components/dashboard/OrdersCard";
import { StockActivityCard } from "../components/dashboard/StockActivityCard";
import { CustomizeOverview } from "../components/dashboard/CustomizeOverview";
import { ListCard } from "../components/dashboard/ListCard";
import { FavoritesCard } from "../components/dashboard/FavoritesCard";
import { OnboardingCard } from "../components/onboarding/OnboardingCard";
import { ConfirmDialogHost } from "../components/ui/ConfirmDialogHost";
import { NoticeHost } from "../components/ui/NoticeHost";
import { EmbeddedBridge } from "../components/tabs/EmbeddedBridge";
import { FavoritesProvider } from "../components/FavoritesProvider";
import { getCurrentUser, apiGet } from "../lib/api";
import { loadShellSettings } from "../lib/favorites";
import { UserPrefsProvider } from "../components/UserPrefsProvider";
import { supplierSections, type AlertKind, type AlertsResponse } from "../lib/alerts";
import {
  OVERVIEW_CARDS,
  OVERVIEW_CARD_ALERT_KIND,
  OVERVIEW_CARD_HREF,
  OVERVIEW_CARD_LABELS,
  overviewCardAvailable,
  overviewRows,
  resolveOverviewCards,
  type OverviewCard,
} from "../lib/overviewCards";
import {
  OVERVIEW_CARD_ROWS,
  alertRows,
  capacityRows,
  deliveryRows,
  deviationRows,
  endOfIsoWeek,
} from "../lib/overviewCardRows";
import { DEVIATION_TYPE_LABELS, type DeviationListRow } from "../lib/quality";
import { stockholmToday } from "../lib/date";
import { satisfiesRule } from "../lib/permissions";
import type {
  CapacityResult,
  ManufacturingOrder,
  OnboardingView,
  Paged,
  PurchaseOrder,
  SalesOrder,
  StockTransaction,
} from "../lib/types";

const ROLE_LABELS: Record<string, string> = { admin: "Administratör", supervisor: "Arbetsledare", user: "Användare" };

const MAX_ATTENTION_ROWS = 7;

export default async function OverviewPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);
  if (!user) redirect("/login");
  const roleLabel = ROLE_LABELS[user.role] ?? user.role;

  // The user's own choice of cards (null = the standard). Fetched first: the
  // page only loads what the visible cards need.
  const settings = await apiGet<{ overviewCards?: unknown; hideOnboarding?: boolean }>(
    "/api/v1/me/settings",
    cookieHeader
  ).catch((): { overviewCards?: unknown; hideOnboarding?: boolean } => ({}));
  // A newer card is offered and shown only to a user who may open its list
  // (overviewCardAvailable); a card the user lost access to just drops out.
  const available = OVERVIEW_CARDS.filter((card) => overviewCardAvailable(user, card));
  const cards: OverviewCard[] = resolveOverviewCards(settings.overviewCards).filter((card) => available.includes(card));
  const has = (card: OverviewCard) => cards.includes(card);
  const today = stockholmToday();
  const weekEnd = endOfIsoWeek(today);
  // The single-kind alert cards ask only for their kinds — unless Materialflöde
  // or Att bevaka already fetch every kind (which runs the behovsberäkning).
  const needAllAlerts = has("flow") || has("attention");
  const alertCardKinds = (Object.keys(OVERVIEW_CARD_ALERT_KIND) as (keyof typeof OVERVIEW_CARD_ALERT_KIND)[])
    .filter((card) => has(card))
    .map((card) => OVERVIEW_CARD_ALERT_KIND[card]);
  const alertsUrl = needAllAlerts ? "/api/v1/alerts" : alertCardKinds.length > 0 ? `/api/v1/alerts?kinds=${alertCardKinds.join(",")}` : null;
  // The newer cards never take Översikten down: a failing read shows a line.
  const orNull = <T,>(promise: Promise<T>) => promise.catch((): null => null);

  // Open orders are a naturally bounded set: the flow counts come from `total`
  // of a one-row page. The two TO calls of "Pågående tillverkning" (six
  // rows each, oldest first) double as the flow's TO counts when both show.
  const [
    openPurchaseOrdersPage,
    openSalesOrdersPage,
    inProgressOrdersPage,
    releasedOrdersPage,
    articlesInStockSummary,
    recentTransactionsPage,
    alerts,
    favorites,
    deliveriesPage,
    arrivalsPage,
    capacity,
    overdueDeviationsPage,
    openDeviationsPage,
  ] = await Promise.all([
    has("flow")
      ? apiGet<Paged<PurchaseOrder>>("/api/v1/purchase-orders?status=draft,confirmed,partially_received&limit=1", cookieHeader)
      : null,
    has("flow")
      ? apiGet<Paged<SalesOrder>>("/api/v1/sales-orders?status=quote,confirmed,in_production,delivered&limit=1", cookieHeader)
      : null,
    has("orders") || has("flow")
      ? apiGet<Paged<ManufacturingOrder>>(
          `/api/v1/manufacturing-orders?status=in_progress&order=asc&limit=${has("orders") ? 6 : 1}`,
          cookieHeader
        )
      : null,
    has("orders")
      ? apiGet<Paged<ManufacturingOrder>>("/api/v1/manufacturing-orders?status=released&order=asc&limit=6", cookieHeader)
      : has("flow")
        ? apiGet<Paged<ManufacturingOrder>>("/api/v1/manufacturing-orders?status=released&limit=1", cookieHeader)
        : null,
    has("flow") ? apiGet<{ articlesInStock: number }>("/api/v1/stock/summary", cookieHeader) : null,
    has("stock") ? apiGet<Paged<StockTransaction>>("/api/v1/stock/transactions?limit=6", cookieHeader) : null,
    // Aviseringar feed both the flow strip's signals and "Att bevaka" — and
    // drive the behovsberäkning, so they are fetched only when one of those
    // shows; a failing call must not take Översikten down.
    alertsUrl ? apiGet<AlertsResponse>(alertsUrl, cookieHeader).catch((): AlertsResponse | null => null) : null,
    // The sidebar's Favoriter (null on failure — the group then stays hidden).
    loadShellSettings(cookieHeader),
    // Leveranser / Inleveranser denna vecka: open orders whose Nästa
    // leveransdatum is on or before Sunday, earliest (late) first.
    has("deliveries")
      ? orNull(
          apiGet<Paged<SalesOrder>>(
            `/api/v1/sales-orders?status=confirmed,in_production&deliveryTo=${weekEnd}&sort=delivery&limit=${OVERVIEW_CARD_ROWS}`,
            cookieHeader
          )
        )
      : null,
    has("arrivals")
      ? orNull(
          apiGet<Paged<PurchaseOrder>>(
            `/api/v1/purchase-orders?status=confirmed,partially_received&deliveryTo=${weekEnd}&sort=delivery&limit=${OVERVIEW_CARD_ROWS}`,
            cookieHeader
          )
        )
      : null,
    has("capacity") ? orNull(apiGet<CapacityResult>("/api/v1/planning/capacity?weeks=1", cookieHeader)) : null,
    has("deviations")
      ? orNull(apiGet<Paged<DeviationListRow>>(`/api/v1/deviations?overdue=true&limit=${OVERVIEW_CARD_ROWS}`, cookieHeader))
      : null,
    has("deviations")
      ? orNull(apiGet<Paged<DeviationListRow>>(`/api/v1/deviations?status=open&limit=${OVERVIEW_CARD_ROWS}`, cookieHeader))
      : null,
  ]);
  // System → Kom igång: administrators see the setup checklist until it is
  // complete or hidden. Never lets a failing call take Översikten down, and
  // other users never call the admin-only route.
  let onboarding: OnboardingView | null = null;
  if (user.role === "admin") {
    try {
      const view = await apiGet<OnboardingView>("/api/v1/onboarding", cookieHeader);
      if (!view.complete && !settings.hideOnboarding) onboarding = view;
    } catch {
      onboarding = null;
    }
  }

  // A group is missing from the response when the user may not see that kind;
  // its signal is then neutral rather than a (false) "all clear".
  const alertCount = (kind: AlertKind): number | null =>
    alerts?.groups.find((g) => g.kind === kind && !g.error)?.count ?? null;
  const purchaseLate = alertCount("purchase_order_late");
  const salesLate = alertCount("sales_order_late");
  const stockNegative = alertCount("stock_negative");
  const lateSignal = (count: number | null) =>
    count === null ? "Se Aviseringar" : count === 0 ? "Inga försenade" : count === 1 ? "1 försenad" : `${count} försenade`;

  const openPurchaseOrdersCount = openPurchaseOrdersPage?.total ?? 0;
  const openSalesOrdersCount = openSalesOrdersPage?.total ?? 0;
  const inProgressCount = inProgressOrdersPage?.total ?? 0;
  const activeManufacturingCount = inProgressCount + (releasedOrdersPage?.total ?? 0);

  // In progress first, then order number (the list is asked oldest-first).
  const activeManufacturingOrders = [...(inProgressOrdersPage?.rows ?? []), ...(releasedOrdersPage?.rows ?? [])].slice(0, 6);

  const articlesInStock = articlesInStockSummary?.articlesInStock ?? 0;

  const stations: FlowStation[] = [
    {
      label: "Inköp",
      href: "/inkop",
      value: openPurchaseOrdersCount,
      unit: openPurchaseOrdersCount === 1 ? "öppen order" : "öppna ordrar",
      signal: lateSignal(purchaseLate),
      tone: purchaseLate ? "warn" : "neutral",
    },
    {
      label: "Lager",
      // The saldo list, not the module menu: this station's numbers ARE the
      // balance rows ("N artiklar i lager", "N med negativt saldo"), so the
      // drill-down has to land on them. The sibling stations point at their
      // module page on purpose — they summarise orders, not one list.
      href: "/lager/saldon",
      value: articlesInStock,
      unit: articlesInStock === 1 ? "artikel i lager" : "artiklar i lager",
      signal:
        stockNegative === null
          ? "Se Aviseringar"
          : stockNegative === 0
            ? "Inga negativa saldon"
            : `${stockNegative} med negativt saldo`,
      tone: stockNegative ? "alert" : "neutral",
    },
    {
      label: "Tillverkning",
      href: "/tillverkning",
      value: activeManufacturingCount,
      unit: activeManufacturingCount === 1 ? "aktiv order" : "aktiva ordrar",
      signal: inProgressCount === 0 ? "Ingen pågår" : `${inProgressCount} pågår`,
      tone: inProgressCount > 0 ? "ok" : "neutral",
    },
    {
      label: "Försäljning",
      href: "/forsaljning",
      value: openSalesOrdersCount,
      unit: openSalesOrdersCount === 1 ? "öppen order" : "öppna ordrar",
      signal: lateSignal(salesLate),
      tone: salesLate ? "warn" : "neutral",
    },
  ];

  // "Att bevaka" is Aviseringar: the first rows over all groups in their
  // fixed order (red before yellow), the rest behind "Visa alla".
  // Behöver beställas carries a supplier subheading per group.
  const attentionItems: AttentionItem[] = (alerts?.groups ?? [])
    .flatMap((g) => {
      if (g.kind === "purchase_needed" && g.supplierGroups) {
        return supplierSections(g).flatMap((sec) =>
          sec.items.map((item) => ({
            group: g,
            item,
            heading: sec.group.supplierId === null ? "Utan förvald leverantör" : (sec.group.supplierName ?? undefined),
          }))
        );
      }
      return g.items.map((item) => ({ group: g, item, heading: undefined as string | undefined }));
    })
    .slice(0, MAX_ATTENTION_ROWS)
    .map(({ group, item, heading }): AttentionItem => ({
      ...(heading ? { heading } : {}),
      key: `${group.kind}-${item.key}`,
      href: item.href,
      tone: item.severity,
      primary: item.primary,
      secondary: item.secondary ? `${group.label} · ${item.secondary}` : group.label,
    }));
  const attentionTotal = (alerts?.groups ?? []).reduce((sum, g) => sum + g.count, 0);

  // The transactions endpoint is sorted newest-first, so the six rows are
  // already the most recent.
  const recentTransactions = recentTransactionsPage?.rows ?? [];

  const unreadable = (card: OverviewCard) => `Kunde inte läsa ${OVERVIEW_CARD_LABELS[card].toLowerCase()} just nu.`;
  const alertGroup = (card: keyof typeof OVERVIEW_CARD_ALERT_KIND) =>
    alerts?.groups.find((g) => g.kind === OVERVIEW_CARD_ALERT_KIND[card]);
  const alertCard = (card: keyof typeof OVERVIEW_CARD_ALERT_KIND, emptyText: string) => {
    const group = alertGroup(card);
    return (
      <ListCard
        key={card}
        title={OVERVIEW_CARD_LABELS[card]}
        rows={alertRows(group)}
        total={group?.count ?? 0}
        allHref={group?.listHref ?? OVERVIEW_CARD_HREF[card]!}
        emptyText={emptyText}
        errorText={alerts === null || group?.error ? unreadable(card) : null}
      />
    );
  };
  const capacityCard = capacity ? capacityRows(capacity, OVERVIEW_CARD_HREF.capacity!) : null;

  const cardNodes: Record<OverviewCard, ReactNode> = {
    flow: <FlowStrip key="flow" stations={stations} />,
    attention: (
      <AttentionCard
        key="attention"
        items={attentionItems}
        totalCount={attentionTotal}
        emptyText={alerts === null ? "Kunde inte läsa aviseringarna just nu." : undefined}
      />
    ),
    orders: <OrdersCard key="orders" orders={activeManufacturingOrders} />,
    stock: <StockActivityCard key="stock" transactions={recentTransactions} />,
    favorites: <FavoritesCard key="favorites" />,
    deliveries: (
      <ListCard
        key="deliveries"
        title={OVERVIEW_CARD_LABELS.deliveries}
        rows={deliveryRows(
          (deliveriesPage?.rows ?? []).map((o) => ({ ...o, counterpartyName: o.customerName, nextDeliveryDate: o.nextDeliveryDate ?? null })),
          today,
          "/forsaljning/ordrar"
        )}
        total={deliveriesPage?.total ?? 0}
        allHref={OVERVIEW_CARD_HREF.deliveries!}
        emptyText="Inga kundordrar att leverera denna vecka."
        errorText={has("deliveries") && deliveriesPage === null ? unreadable("deliveries") : null}
      />
    ),
    arrivals: (
      <ListCard
        key="arrivals"
        title={OVERVIEW_CARD_LABELS.arrivals}
        rows={deliveryRows(
          (arrivalsPage?.rows ?? []).map((o) => ({ ...o, counterpartyName: o.supplierName, nextDeliveryDate: o.nextDeliveryDate ?? null })),
          today,
          "/inkop/ordrar"
        )}
        total={arrivalsPage?.total ?? 0}
        allHref={OVERVIEW_CARD_HREF.arrivals!}
        emptyText="Inga inköpsordrar väntas in denna vecka."
        errorText={has("arrivals") && arrivalsPage === null ? unreadable("arrivals") : null}
      />
    ),
    capacity: (
      <ListCard
        key="capacity"
        title={OVERVIEW_CARD_LABELS.capacity}
        rows={capacityCard?.rows ?? []}
        total={capacityCard?.total ?? 0}
        allHref={OVERVIEW_CARD_HREF.capacity!}
        emptyText="Ingen planerad beläggning denna vecka."
        errorText={has("capacity") && capacity === null ? unreadable("capacity") : null}
      />
    ),
    receivables: alertCard("receivables", "Inga förfallna kundfakturor."),
    payables: alertCard("payables", "Inga leverantörsfakturor att betala just nu."),
    quotes: alertCard("quotes", "Inga offerter att följa upp."),
    deviations: (
      <ListCard
        key="deviations"
        title={OVERVIEW_CARD_LABELS.deviations}
        rows={deviationRows(overdueDeviationsPage?.rows ?? [], openDeviationsPage?.rows ?? [], DEVIATION_TYPE_LABELS)}
        total={openDeviationsPage?.total ?? 0}
        allHref={OVERVIEW_CARD_HREF.deviations!}
        emptyText="Inga öppna avvikelser."
        errorText={has("deviations") && (openDeviationsPage === null || overdueDeviationsPage === null) ? unreadable("deviations") : null}
      />
    ),
  };

  const todayLabel = new Date().toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Stockholm" });

  return (
    <FavoritesProvider initial={favorites.favorites} initialInSidebar={favorites.inSidebar} initialOnOverview={favorites.onOverview}>
    <UserPrefsProvider
      className={shellStyles.frame}
      initialDensity={favorites.density}
      initialListColumns={favorites.listColumns}
        initialDocumentTabs={favorites.documentTabs}
    >
      <Nav active="Översikt" role={user.role} permissions={user.permissions} />

      <PermissionsProvider role={user.role} permissions={user.permissions}>
      <div className={shellStyles.column}>
      <AppToolbar userName={user.name} userRole={roleLabel} />
      <main className={shellStyles.main} data-app-main="">
        <ReadOnlyBanner readOnly={user.readOnly} />

        <div className={styles.topbar}>
          <div>
            <div className={styles.title}>Översikt</div>
            <div className={styles.meta} style={{ textTransform: "capitalize" }}>
              {todayLabel}
            </div>
          </div>
          {/* Creating an order needs Tillverkning itself — the list page also
              opens in read-only mode (Tillverkningsorder (läsläge)). */}
          <div className={styles.topbarActions}>
            <CustomizeOverview shown={cards} available={available} />
            {satisfiesRule(user, ["tillverkning"]) && (
              <Link href="/tillverkning/ordrar">
                <Button variant="primary">+ Ny order</Button>
              </Link>
            )}
          </div>
        </div>

        {onboarding && <OnboardingCard initial={onboarding} />}

        {cards.length === 0 && (
          <p className={styles.noCards}>
            Inga kort valda. Använd <strong>Anpassa</strong> för att välja vad Översikten visar.
          </p>
        )}

        {overviewRows(cards).map((row) =>
          row.length === 2 ? (
            // Two half cards share a row; a lone one takes the full width.
            <div className={styles.topRow} key={row.join("-")}>
              {row.map((card) => cardNodes[card])}
            </div>
          ) : (
            <div className={styles.fullRow} key={row[0]}>
              {cardNodes[row[0]!]}
            </div>
          )
        )}
        <ConfirmDialogHost />
        <NoticeHost />
        <EmbeddedBridge />
      </main>
      <StatusBar userName={user.name} userRole={roleLabel} />
      </div>
      </PermissionsProvider>
    </UserPrefsProvider>
    </FavoritesProvider>
  );
}
