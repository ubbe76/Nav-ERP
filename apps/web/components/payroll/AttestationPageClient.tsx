"use client";

import { confirmDialog } from "../../lib/confirm";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Button } from "../ui/Button";
import buttonStyles from "../ui/Button.module.css";
import { Card } from "../ui/Card";
import { FormError, FormHint } from "../ui/Form";
import { ApiError, apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { MONTH_NAMES_SV, type PeriodEmployeeSummary, type PeriodSummary, type UserRole } from "../../lib/types";
import { formatHours } from "../timereport/SchedulesPageClient";
import { EmployeePeriodModal } from "./EmployeePeriodModal";

// The Table needs an `id`; the summary rows are keyed by employeeId.
type EmployeeRow = PeriodEmployeeSummary & { id: string };

// Shifts a (year, month) pair by whole months, wrapping the year — used by the
// "◀ Föregående"/"Nästa ▶" links, which are plain URLs so the server refetches
// the period (no client fetch for the summary).
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

function sumMinutes(entries: { minutes: number }[]): number {
  return entries.reduce((total, entry) => total + entry.minutes, 0);
}

// already-attested/attestation-not-found mean "the UI is just out of date" —
// the caller refreshes instead of showing an error, so those two codes are
// swallowed to null ahead of the shared dictionary lookup.
function attestErrorMessage(err: unknown): string | null {
  if (err instanceof ApiError && (err.code === "already-attested" || err.code === "attestation-not-found")) {
    return null;
  }
  return apiErrorMessage(err, "Kunde inte attestera");
}

function lockErrorMessage(err: unknown): string {
  return apiErrorMessage(err, "Kunde inte låsa perioden");
}

export function AttestationPageClient({
  summary,
  userRole,
  year,
  month,
}: {
  summary: PeriodSummary;
  userRole: UserRole;
  year: number;
  month: number;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [lockPending, setLockPending] = useState(false);
  const [details, setDetails] = useState<PeriodEmployeeSummary | null>(null);

  const locked = summary.status === "locked";
  const isAdmin = userRole === "admin";
  const monthName = MONTH_NAMES_SV[month - 1]!;
  const rows = useMemo<EmployeeRow[]>(
    () => summary.employees.map((employee) => ({ ...employee, id: employee.employeeId })),
    [summary.employees]
  );
  const allAttested = rows.length > 0 && rows.every((employee) => employee.attested);
  const previous = shiftMonth(year, month, -1);
  const next = shiftMonth(year, month, 1);

  async function attest(employeeId: string) {
    setError(null);
    setPendingId(employeeId);
    try {
      await apiFetch(`/api/v1/periods/${year}/${month}/attest`, {
        method: "POST",
        body: JSON.stringify({ employeeId }),
      });
      router.refresh();
    } catch (err) {
      setError(attestErrorMessage(err));
      router.refresh();
    } finally {
      setPendingId(null);
    }
  }

  async function unattest(employeeId: string) {
    setError(null);
    setPendingId(employeeId);
    try {
      await apiFetch(`/api/v1/periods/${year}/${month}/attest/${employeeId}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError(attestErrorMessage(err));
      router.refresh();
    } finally {
      setPendingId(null);
    }
  }

  async function lockPeriod() {
    if (
      !(await confirmDialog(`Låser ${monthName} ${year} — underlaget fryses och ändringar blockeras. Fortsätt?`))
    ) {
      return;
    }
    setError(null);
    setLockPending(true);
    try {
      await apiFetch(`/api/v1/periods/${year}/${month}/lock`, { method: "POST" });
      router.refresh();
    } catch (err) {
      setError(lockErrorMessage(err));
    } finally {
      setLockPending(false);
    }
  }

  async function unlockPeriod() {
    if (!(await confirmDialog("Låser upp perioden — snapshotten raderas och underlaget räknas om live. Fortsätt?"))) {
      return;
    }
    setError(null);
    setLockPending(true);
    try {
      await apiFetch(`/api/v1/periods/${year}/${month}/unlock`, { method: "POST" });
      router.refresh();
    } catch (err) {
      setError(lockErrorMessage(err));
    } finally {
      setLockPending(false);
    }
  }

  function statusCell(employee: EmployeeRow) {
    if (!locked && employee.openAttendance) return <StatusPill status="stopped" label="Öppen närvaro" compact />;
    if (!employee.attested) return <StatusPill status="draft" label="Ej attesterad" compact />;
    return (
      <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
        <StatusPill status="done" label="Attesterad" compact />
        {employee.attestedByName && (
          <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
            {employee.attestedByName}
            {employee.attestedAt && ` · ${new Date(employee.attestedAt).toLocaleDateString("sv-SE")}`}
          </span>
        )}
      </span>
    );
  }

  return (
    <>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        <Link
          href={`/personal/attestering?year=${previous.year}&month=${previous.month}`}
          className={`${buttonStyles.button} ${buttonStyles.ghost}`}
        >
          ◀ Föregående
        </Link>
        <Link
          href={`/personal/attestering?year=${next.year}&month=${next.month}`}
          className={`${buttonStyles.button} ${buttonStyles.ghost}`}
        >
          Nästa ▶
        </Link>
      </div>

      <FormError margin="below">{error}</FormError>

      <Table<EmployeeRow>
        columns={[
          { key: "name", label: "Anställd", width: "minmax(120px, 1fr)" },
          { key: "scheduledMinutes", label: "Schema", width: "72px", align: "right" },
          { key: "workedMinutes", label: "Arbetat", width: "72px", align: "right" },
          { key: "absence", label: "Frånvaro", width: "72px", align: "right" },
          { key: "overtime", label: "Övertid", width: "72px", align: "right" },
          { key: "ob", label: "OB", width: "56px", align: "right" },
          { key: "atfMinutes", label: "ATF", width: "56px", align: "right" },
          { key: "unaccountedMinutes", label: "Ofördelat", width: "84px", align: "right" },
          { key: "deviations", label: "Avvikelser", width: "110px" },
          { key: "status", label: "Status", width: "120px" },
          { key: "actions", label: "", width: "150px", align: "right" },
        ]}
        rows={rows}
        emptyText="Inga medarbetare med underlag i perioden"
        renderCell={(employee, key) => {
          switch (key) {
            case "name":
              return (
                <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <strong>{employee.name}</strong>
                  <span className="num" style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                    {employee.employeeNumber}
                  </span>
                </span>
              );
            case "scheduledMinutes":
            case "workedMinutes":
            case "atfMinutes":
              return <span className="num">{formatHours(employee[key])}</span>;
            case "absence":
              return <span className="num">{formatHours(sumMinutes(employee.absence))}</span>;
            case "overtime":
              return (
                <span className="num">
                  {formatHours(employee.overtimeMinutes + employee.overtimeOffScheduleMinutes)}
                </span>
              );
            case "ob":
              return <span className="num">{formatHours(sumMinutes(employee.ob))}</span>;
            case "unaccountedMinutes":
              return (
                <span
                  className="num"
                  style={
                    employee.unaccountedMinutes > 0
                      ? { color: "var(--status-stopped-text)", fontWeight: 600 }
                      : undefined
                  }
                >
                  {formatHours(employee.unaccountedMinutes)}
                </span>
              );
            case "deviations": {
              const days = employee.deviationDays ?? 0;
              if (days === 0) return <span>–</span>;
              const missing = employee.missingReasonDays ?? 0;
              return (
                <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span className="num">{days === 1 ? "1 dag" : `${days} dagar`}</span>
                  {missing > 0 && (
                    <span style={{ color: "var(--status-stopped-text)", fontWeight: 600, fontSize: 12 }}>
                      {missing} utan anledning
                    </span>
                  )}
                </span>
              );
            }
            case "status":
              return statusCell(employee);
            case "actions":
              return (
                <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <Button type="button" variant="ghost" size="small" onClick={() => setDetails(employee)}>
                    Detaljer
                  </Button>
                  {!locked &&
                    (employee.attested ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="small"
                        disabled={pendingId === employee.employeeId}
                        onClick={() => unattest(employee.employeeId)}
                      >
                        Ångra attest
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="primary"
                        size="small"
                        disabled={pendingId === employee.employeeId}
                        onClick={() => attest(employee.employeeId)}
                      >
                        Attestera
                      </Button>
                    ))}
                </span>
              );
            default:
              return null;
          }
        }}
      />

      <Card maxWidth="none" style={{ marginTop: 16 }}>
        {locked ? (
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span>
              Perioden låstes{" "}
              <span className="num">
                {summary.lockedAt
                  ? new Date(summary.lockedAt).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" })
                  : "–"}
              </span>
            </span>
            {isAdmin && (
              <Button type="button" variant="danger" disabled={lockPending} onClick={unlockPeriod}>
                {lockPending ? "Låser upp…" : "Lås upp period"}
              </Button>
            )}
          </div>
        ) : allAttested ? (
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span>Alla medarbetare är attesterade — perioden kan låsas.</span>
            {isAdmin && (
              <Button type="button" variant="primary" disabled={lockPending} onClick={lockPeriod}>
                {lockPending ? "Låser…" : "Lås period"}
              </Button>
            )}
          </div>
        ) : (
          <FormHint>Alla medarbetare måste attesteras innan perioden kan låsas.</FormHint>
        )}
      </Card>

      <EmployeePeriodModal
        employee={details}
        year={year}
        month={month}
        periodLocked={locked}
        onClose={() => setDetails(null)}
      />
    </>
  );
}
