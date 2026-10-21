import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
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
import { OnboardingCard } from "../components/onboarding/OnboardingCard";
import { ConfirmDialogHost } from "../components/ui/ConfirmDialogHost";
import { getCurrentUser, apiGet } from "../lib/api";
import type { AlertKind, AlertsResponse } from "../lib/alerts";
import { satisfiesRule } from "../lib/permissions";
import type {
  ManufacturingOrder,
  OnboardingView,
  Paged,
  PurchaseOrder,
  SalesOrder,
  StockBalance,
  StockTransaction,
} from "../lib/types";

const ROLE_LABELS: Record<string, string> = { admin: "Administratör", supervisor: "Arbetsledare", user: "Användare" };

const MAX_ATTENTION_ROWS = 7;

export default async function OverviewPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);
  if (!user) redirect("/login");

  // Open orders are a naturally bounded set, so the dashboard fetches them via
  // status filters instead of pulling the full registers.
  const [
    openPurchaseOrdersPage,
    openSalesOrdersPage,
    activeManufacturingOrdersPage,
    balancesPage,
    recentTransactionsPage,
    alerts,
  ] = await Promise.all([
      apiGet<Paged<PurchaseOrder>>(
        "/api/v1/purchase-orders?status=draft,confirmed,partially_received&limit=1000",
        cookieHeader
      ),
      apiGet<Paged<SalesOrder>>(
        "/api/v1/sales-orders?status=quote,confirmed,in_production,delivered&limit=1000",
        cookieHeader
      ),
      apiGet<Paged<ManufacturingOrder>>(
        "/api/v1/manufacturing-orders?status=released,in_progress&limit=1000",
        cookieHeader
      ),
      apiGet<Paged<StockBalance>>("/api/v1/stock/balances?limit=1000", cookieHeader),
      apiGet<Paged<StockTransaction>>("/api/v1/stock/transactions?limit=6", cookieHeader),
      // Aviseringar feed both the flow strip's signals and "Att bevaka"; a
      // failing call must not take Översikten down.
      apiGet<AlertsResponse>("/api/v1/alerts", cookieHeader).catch((): AlertsResponse | null => null),
    ]);
  // System → Kom igång: administrators see the setup checklist until it is
  // complete or hidden. Never lets a failing call take Översikten down, and
  // other users never call the admin-only route.
  let onboarding: OnboardingView | null = null;
  if (user.role === "admin") {
    try {
      const [view, settings] = await Promise.all([
        apiGet<OnboardingView>("/api/v1/onboarding", cookieHeader),
        apiGet<{ hideOnboarding?: boolean }>("/api/v1/me/settings", cookieHeader),
      ]);
      if (!view.complete && !settings.hideOnboarding) onboarding = view;
    } catch {
      onboarding = null;
    }
  }

  const balances = balancesPage.rows;

  // A group is missing from the response when the user may not see that kind;
  // its signal is then neutral rather than a (false) "all clear".
  const alertCount = (kind: AlertKind): number | null =>
    alerts?.groups.find((g) => g.kind === kind && !g.error)?.count ?? null;
  const purchaseLate = alertCount("purchase_order_late");
  const salesLate = alertCount("sales_order_late");
  const stockNegative = alertCount("stock_negative");
  const lateSignal = (count: number | null) =>
    count === null ? "Se Aviseringar" : count === 0 ? "Inga försenade" : count === 1 ? "1 försenad" : `${count} försenade`;

  const openPurchaseOrders = openPurchaseOrdersPage.rows;

  const openSalesOrders = openSalesOrdersPage.rows;

  const activeManufacturingOrders = [...activeManufacturingOrdersPage.rows]
    .sort((a, b) =>
      a.status === b.status ? a.orderNumber.localeCompare(b.orderNumber) : a.status === "in_progress" ? -1 : 1,
    );
  const inProgressCount = activeManufacturingOrders.filter((o) => o.status === "in_progress").length;

  // Aggregate per article across locations; the balances endpoint is already
  // the aggregation of the append-only stock_transactions log.
  const byArticle = new Map<string, { articleNumber: string; articleName: string; quantity: number }>();
  for (const b of balances) {
    const entry = byArticle.get(b.articleId) ?? {
      articleNumber: b.articleNumber,
      articleName: b.articleName,
      quantity: 0,
    };
    entry.quantity += Number(b.quantityOnHand);
    byArticle.set(b.articleId, entry);
  }
  const articlesInStock = [...byArticle.values()].filter((a) => a.quantity > 0).length;

  const stations: FlowStation[] = [
    {
      label: "Inköp",
      href: "/inkop",
      value: openPurchaseOrders.length,
      unit: openPurchaseOrders.length === 1 ? "öppen order" : "öppna ordrar",
      signal: lateSignal(purchaseLate),
      tone: purchaseLate ? "warn" : "neutral",
    },
    {
      label: "Lager",
      // The saldo list, not the module menu: this station's numbers ARE the
      // balance rows ("N artiklar i lager", "N med saldo ≤ 0"), so the
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
            : `${stockNegative} med saldo ≤ 0`,
      tone: stockNegative ? "alert" : "neutral",
    },
    {
      label: "Tillverkning",
      href: "/tillverkning",
      value: activeManufacturingOrders.length,
      unit: activeManufacturingOrders.length === 1 ? "aktiv order" : "aktiva ordrar",
      signal: inProgressCount === 0 ? "Ingen pågår" : `${inProgressCount} pågår`,
      tone: inProgressCount > 0 ? "ok" : "neutral",
    },
    {
      label: "Försäljning",
      href: "/forsaljning",
      value: openSalesOrders.length,
      unit: openSalesOrders.length === 1 ? "öppen order" : "öppna ordrar",
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
  const recentTransactions = recentTransactionsPage.rows;

  const todayLabel = new Date().toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "long" });

  return (
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
          {satisfiesRule(user, ["tillverkning"]) && (
            <Link href="/tillverkning/ordrar">
              <Button variant="primary">+ Ny order</Button>
            </Link>
          )}
        </div>

        {onboarding && <OnboardingCard initial={onboarding} />}

        <FlowStrip stations={stations} />

        {/* Three cards do not divide evenly into two columns, so the two that
            answer "what needs me now" pair up on top and the log runs full
            width underneath — where the extra room goes to the article names
            it would otherwise ellipsise. */}
        <div className={styles.topRow}>
          <AttentionCard items={attentionItems} totalCount={attentionTotal} />
          <OrdersCard orders={activeManufacturingOrders.slice(0, 6)} />
        </div>

        <StockActivityCard transactions={recentTransactions} />
        </PermissionsProvider>
        <ConfirmDialogHost />
      </main>
    </div>
  );
}
