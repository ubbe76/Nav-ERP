import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AppShell } from "../../../../components/AppShell";
import { ManufacturingOrderDetail } from "../../../../components/manufacturing/ManufacturingOrderDetail";
import { apiGet, getCurrentUser } from "../../../../lib/api";
import { satisfiesRule } from "../../../../lib/permissions";
import type {
  CostCalculation,
  EmployeeDirectoryEntry,
  ManufacturingOrder,
  MOMaterialConsumption,
  MOOperation,
  StockLocation,
  MOReport,
  ScrapEntry,
  TimeReport,
} from "../../../../lib/types";
import shellStyles from "../../../../components/AppShell.module.css";
import { HelpLink } from "../../../../components/ui/HelpLink";

export default async function ManufacturingOrderDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;

  const order = await apiGet<ManufacturingOrder>(`/api/v1/manufacturing-orders/${params.id}`, cookieHeader).catch(() => null);
  if (!order) notFound();

  const user = await getCurrentUser(cookieHeader);
  const canEdit = user ? satisfiesRule(user, ["tillverkning"]) : false;

  // Ångra rapportering removes a stamp's time report too — the same roles as
  // deleting a time report (the API enforces it; this only hides the button).
  const canUndoReports = canEdit && (user?.role === "admin" || user?.role === "supervisor");

  const [materials, operations, locations, timeReports, employees, costCalculations, scrap, reports] = await Promise.all([
    apiGet<MOMaterialConsumption[]>(`/api/v1/manufacturing-orders/${params.id}/materials`, cookieHeader),
    apiGet<MOOperation[]>(`/api/v1/manufacturing-orders/${params.id}/operations`, cookieHeader),
    canEdit ? apiGet<StockLocation[]>("/api/v1/stock/locations", cookieHeader) : Promise.resolve([] as StockLocation[]),
    apiGet<TimeReport[]>(`/api/v1/manufacturing-orders/${params.id}/time-reports`, cookieHeader),
    apiGet<EmployeeDirectoryEntry[]>("/api/v1/employees/directory", cookieHeader),
    canEdit
      ? apiGet<CostCalculation[]>(`/api/v1/manufacturing-orders/${params.id}/cost-calculations`, cookieHeader)
      : Promise.resolve([] as CostCalculation[]),
    apiGet<ScrapEntry[]>(`/api/v1/manufacturing-orders/${params.id}/scrap`, cookieHeader),
    apiGet<MOReport[]>(`/api/v1/manufacturing-orders/${params.id}/reports`, cookieHeader),
  ]);

  return (
    <AppShell active="Tillverkning">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{order.orderNumber}</div>
          <div className={shellStyles.meta}>
            {order.articleNumber} — {order.articleName}
          </div>
        </div>
        <HelpLink chapter="tillverkning" anchor="tillverkningsorder" label="Hjälp om tillverkningsorder" />
      </div>

      <ManufacturingOrderDetail
        order={order}
        materials={materials}
        operations={operations}
        locations={locations}
        timeReports={timeReports}
        employees={employees}
        costCalculations={costCalculations}
        scrap={scrap}
        reports={reports}
        canUndoReports={canUndoReports}
      />
    </AppShell>
  );
}
