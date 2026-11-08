import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import styles from "./page.module.css";
import { ThemeToggle } from "../components/ThemeToggle";
import { LogoutButton } from "../components/LogoutButton";
import { ReadOnlyBanner } from "../components/ReadOnlyBanner";
import { Nav } from "../components/ui/Nav";
import { PermissionsProvider } from "../components/PermissionsProvider";
import { Button } from "../components/ui/Button";
import { FlowStrip, type FlowStation } from "../components/dashboard/FlowStrip";
import { AttentionCard, type AttentionItem } from "../components/dashboard/AttentionCard";
import { OrdersCard } from "../components/dashboard/OrdersCard";
import { StockActivityCard } from "../components/dashboard/StockActivityCard";
import { CustomizeOverview } from "../components/dashboard/CustomizeOverview";
import { OnboardingCard } from "../components/onboarding/OnboardingCard";
import { ConfirmDialogHost } from "../components/ui/ConfirmDialogHost";
import { FavoritesProvider } from "../components/FavoritesProvider";
import { getCurrentUser, apiGet } from "../lib/api";
import { loadFavorites } from "../lib/favorites";
import type { AlertKind, AlertsResponse } from "../lib/alerts";
import { OVERVIEW_CARDS, overviewRows, resolveOverviewCards, type OverviewCard } from "../lib/overviewCards";
import { satisfiesRule } from "../lib/permissions";
import type {
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

  // The user's own choice of cards (null = the standard). Fetched first: the
  // page only loads what the visible cards need.
  const settings = await apiGet<{ overviewCards?: unknown; hideOnboarding?: boolean }>(
    "/api/v1/me/settings",
    cookieHeader
  ).catch((): { overviewCards?: unknown; hideOnboarding?: boolean } => ({}));
  const cards: OverviewCard[] = settings.overviewCards == null ? [...OVERVIEW_CARDS] : resolveOverviewCards(settings.overviewCards);
  const has = (card: OverviewCard) => cards.includes(card);

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
    has("flow") || has("attention")
      ? apiGet<AlertsResponse>("/api/v1/alerts", cookieHeader).catch((): AlertsResponse | null => null)
      : null,
    // The sidebar's Favoriter (null on failure — the group then stays hidden).
    loadFavorites(cookieHeader),
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
  const attentionItems: AttentionItem[] = (alerts?.groups ?? [])
    .flatMap((g) => g.items.map((item) => ({ group: g, item })))
    .slice(0, MAX_ATTENTION_ROWS)
    .map(({ group, item }): AttentionItem => ({
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
  };

  const todayLabel = new Date().toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "long" });

  return (
    <FavoritesProvider initial={favorites}>
    <div className={styles.frame}>
      <Nav
        active="Översikt"
        userName={user.name}
        userRole={ROLE_LABELS[user.role] ?? user.role}
        role={user.role}
        permissions={user.permissions}
      />

      <main className={styles.main}>
        <PermissionsProvider role={user.role} permissions={user.permissions}>
        <ReadOnlyBanner readOnly={user.readOnly} />
        <div className={styles.themeRow}>
          <LogoutButton />
          <ThemeToggle />
        </div>

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
            <CustomizeOverview shown={cards} />
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
        </PermissionsProvider>
        <ConfirmDialogHost />
      </main>
    </div>
    </FavoritesProvider>
  );
}
