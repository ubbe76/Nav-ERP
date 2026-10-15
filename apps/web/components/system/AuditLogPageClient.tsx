"use client";

import { useEffect, useState } from "react";
import { Table } from "../ui/Table";
import { ListExportLink, ListFilterSelect, ListToolbar, Pagination, useListNavigation } from "../ui/ListControls";
import { Field, Input } from "../ui/Field";
import { apiFetch } from "../../lib/api";
import { AUDIT_ENTITY_TYPE_LABELS, auditActionLabel, auditEntityTypeLabel, type AdminUser, type AuditLogEntry, type Paged } from "../../lib/types";
import shellStyles from "../../components/AppShell.module.css";
import { HelpLink } from "../ui/HelpLink";
import { AuditDetail } from "./AuditDetail";

// Date-range filter — plain <input type="date"> bound to the ?from=&to=
// query params (same useListNavigation the URL-driven list pages already
// use for search/filter/page), rather than ListFilterSelect (that's a
// dropdown, not a range).
function DateRangeFilter() {
  const { params, setFilter } = useListNavigation();
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
      <Field label="Från" htmlFor="auditFrom">
        <Input
          id="auditFrom"
          type="date"
          size="sm"
          value={params.get("from") ?? ""}
          onChange={(e) => setFilter("from", e.target.value || null)}
        />
      </Field>
      <Field label="Till" htmlFor="auditTo">
        <Input
          id="auditTo"
          type="date"
          size="sm"
          value={params.get("to") ?? ""}
          onChange={(e) => setFilter("to", e.target.value || null)}
        />
      </Field>
    </div>
  );
}

// Bound to ?userId= the same way — a select, but the options come from a
// client-side fetch of the user register rather than a fixed enum.
// includeDeleted=true so a soft-deleted user (whose audit rows still
// resolve a name, see audit.repository.ts) can still be filtered on.
function UserFilter() {
  const { params, setFilter } = useListNavigation();
  const [users, setUsers] = useState<AdminUser[]>([]);

  useEffect(() => {
    apiFetch<AdminUser[]>("/api/v1/auth/users?includeDeleted=true")
      .then(setUsers)
      .catch(() => {});
  }, []);

  return (
    <ListFilterSelect
      param="userId"
      allLabel="Alla användare"
      ariaLabel="Filtrera på användare"
      options={users.map((u) => ({ value: u.id, label: u.name }))}
    />
  );
}

export function AuditLogPageClient({ log, pageSize }: { log: Paged<AuditLogEntry>; pageSize: number }) {
  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Händelselogg</div>
          <div className={shellStyles.meta}>{log.total.toLocaleString("sv-SE")} händelser</div>
        </div>
        <HelpLink chapter="system" anchor="handelselogg" label="Hjälp om händelseloggen" />
      </div>

      <ListToolbar placeholder="Sök på id eller händelse…">
        <ListFilterSelect
          param="entityType"
          allLabel="Alla typer"
          ariaLabel="Filtrera på typ"
          options={Object.entries(AUDIT_ENTITY_TYPE_LABELS).map(([value, label]) => ({ value, label }))}
        />
        <UserFilter />
        <DateRangeFilter />
        <ListExportLink endpoint="/api/v1/audit-log/csv" />
      </ListToolbar>

      <Table<AuditLogEntry>
        columns={[
          { key: "createdAt", label: "Tid", width: "140px" },
          { key: "userName", label: "Användare", width: "160px" },
          { key: "entityType", label: "Typ", width: "160px" },
          { key: "entityId", label: "Id", width: "150px" },
          { key: "action", label: "Händelse", width: "160px" },
          { key: "detail", label: "Detalj", width: "1fr" },
        ]}
        rows={log.rows}
        emptyText="Inga händelser matchar sökningen"
        renderCell={(entry, key) => {
          switch (key) {
            case "createdAt":
              return new Date(entry.createdAt).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });
            case "userName":
              return entry.userName ?? "System";
            case "entityType":
              return auditEntityTypeLabel(entry.entityType);
            case "entityId":
              return entry.entityId ?? "–";
            case "action":
              return auditActionLabel(entry.action);
            case "detail":
              return <AuditDetail detail={entry.detail} />;
            default:
              return null;
          }
        }}
      />

      <Pagination total={log.total} pageSize={pageSize} />
    </>
  );
}
