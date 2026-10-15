import { AppShell } from "../../../components/AppShell";
import { BehovsberakningPageClient } from "../../../components/planning/BehovsberakningPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import { getListPageSize } from "../../../lib/listPageSize";
import shellStyles from "../../../components/AppShell.module.css";

// Behovsberäkning (MRP light, E1) — the routine itself fetches and mutates
// client-side (row-level editable proposal quantities, selection state, and
// a refetch after order creation), so this server component only fetches the
// user's "rader per sida" preference and owns the shell/topbar. Not
// admin-gated — any user who can plan production/purchase.
export default async function BehovsberakningPage() {
  const pageSize = await getListPageSize();
  return (
    <AppShell active="Tillverkning">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Behovsberäkning</div>
          <div className={shellStyles.meta}>Nettobehov per artikel — föreslå och skapa inköps- och tillverkningsordrar</div>
        </div>
        <HelpLink chapter="tillverkning" anchor="behovsberakning" label="Hjälp om behovsberäkning" />
      </div>

      <BehovsberakningPageClient pageSize={pageSize} />
    </AppShell>
  );
}
