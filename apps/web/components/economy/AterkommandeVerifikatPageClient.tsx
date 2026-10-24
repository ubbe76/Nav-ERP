"use client";

import { confirmDelete, confirmDialog } from "../../lib/confirm";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { StatusPill } from "../ui/StatusPill";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Modal } from "../ui/Modal";
import { Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormNotice, FormRow, FormStack } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { HelpLink } from "../ui/HelpLink";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney } from "../../lib/format";
import type {
  RecurringRun,
  RecurringVerification,
  RecurringVerificationDetail,
  RecurringVerificationUpdateResult,
  VerificationTemplate,
} from "../../lib/types";
import shellStyles from "../AppShell.module.css";
import { AllocateDialog } from "./AllocateDialog";

const MODE_LABELS = { draft: "Utkast", book: "Bokför direkt" } as const;

// A run's status as the user reads it. `skipped` is a month that fell due
// while the post was paused and was marked on Aktivera — never a problem,
// so it never shows as an alert, only here.
const RUN_STATUS: Record<RecurringRun["status"], { pill: "done" | "stopped" | "draft"; label: string }> = {
  created: { pill: "done", label: "Skapad" },
  failed: { pill: "stopped", label: "Misslyckades" },
  skipped: { pill: "draft", label: "Hoppades över (pausad)" },
};

function dayLabel(day: number | "last"): string {
  return day === "last" ? "Sista dagen" : String(day);
}

// "2031-02" or "2031-02 – 2031-05".
function monthSpan(months: string[]): string {
  if (months.length === 0) return "";
  return months.length === 1 ? months[0]! : `${months[0]} – ${months[months.length - 1]}`;
}

function RunStatus({ run }: { run: RecurringRun | null }) {
  if (!run) return <span>–</span>;
  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <StatusPill status={RUN_STATUS[run.status].pill} label={RUN_STATUS[run.status].label} compact />
      <span>{run.month}</span>
    </span>
  );
}

// Ekonomi → Återkommande verifikat: posts that create a verification from a
// template every month (the jobb runs once an hour), plus the allocations that
// Fördela över perioder created.
export function AterkommandeVerifikatPageClient({
  recurring,
  templates,
}: {
  recurring: RecurringVerification[];
  templates: VerificationTemplate[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [allocateOpen, setAllocateOpen] = useState(false);
  const [selected, setSelected] = useState<RecurringVerificationDetail | null>(null);

  async function loadDetail(id: string) {
    try {
      setSelected(await apiFetch<RecurringVerificationDetail>(`/api/v1/recurring-verifications/${id}`));
    } catch (err) {
      setError(apiErrorMessage(err, "Körningarna kunde inte hämtas"));
    }
  }

  async function act(fn: () => Promise<void>, failure: string) {
    setError(null);
    setMessage(null);
    setPending(true);
    try {
      await fn();
    } catch (err) {
      setError(apiErrorMessage(err, failure));
    } finally {
      setPending(false);
    }
  }

  // Aktivera skips the months that fell due during the pause (the server
  // marks them in the same transaction as the flag); the user is told how
  // many before it happens, and Kör nu is the way to create them instead.
  async function toggleActive(post: RecurringVerification) {
    const toSkip = post.active ? [] : post.skippedOnActivate;
    if (toSkip.length > 0) {
      const count = toSkip.length === 1 ? "1 månad" : `${toSkip.length} månader`;
      const ok = await confirmDialog(
        `Aktivera posten? ${count} (${monthSpan(toSkip)}) förföll medan posten var pausad och hoppas över — inga verifikat skapas för dem. Vill du ha dem skapade, välj Kör nu i stället innan du aktiverar.`,
        { confirmLabel: "Aktivera" }
      );
      if (!ok) return;
    }
    await act(async () => {
      const result = await apiFetch<RecurringVerificationUpdateResult>(`/api/v1/recurring-verifications/${post.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !post.active }),
      });
      if (result.skippedMonths.length > 0) {
        setMessage(
          `Posten aktiverades. ${result.skippedMonths.length === 1 ? "1 månad" : `${result.skippedMonths.length} månader`} (${monthSpan(result.skippedMonths)}) hoppades över.`
        );
      }
      router.refresh();
    }, "Åtgärden misslyckades");
  }

  async function remove(post: RecurringVerification) {
    if (!(await confirmDelete("Ta bort den återkommande posten? Verifikat som redan skapats ligger kvar.")))
      return;
    await act(async () => {
      await apiFetch(`/api/v1/recurring-verifications/${post.id}`, { method: "DELETE" });
      if (selected?.id === post.id) setSelected(null);
      router.refresh();
    }, "Posten kunde inte tas bort");
  }

  function runNow(post: RecurringVerification) {
    return act(async () => {
      const result = await apiFetch<{ created: RecurringRun[]; failed: RecurringRun[] }>(
        `/api/v1/recurring-verifications/${post.id}/run`,
        { method: "POST" }
      );
      if (result.created.length === 0 && result.failed.length === 0) {
        setMessage("Inget att köra just nu — alla förfallna månader är redan körda.");
      } else {
        const parts = [];
        if (result.created.length > 0) parts.push(`${result.created.length} skapades`);
        if (result.failed.length > 0) parts.push(`${result.failed.length} misslyckades`);
        setMessage(`Körningen klar: ${parts.join(", ")}.`);
      }
      router.refresh();
      await loadDetail(post.id);
    }, "Körningen misslyckades");
  }

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Återkommande verifikat</div>
          <div className={shellStyles.meta}>{recurring.length} poster</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Button type="button" variant="ghost" onClick={() => setAllocateOpen(true)}>
            Fördela över perioder
          </Button>
          <Button type="button" variant="primary" onClick={() => setNewOpen(true)}>
            + Ny återkommande post
          </Button>
          <HelpLink chapter="ekonomi" anchor="aterkommande-verifikat" label="Hjälp om återkommande verifikat" />
        </div>
      </div>

      <FormError>{error}</FormError>
      {message && <FormNotice style={{ marginBottom: 12 }}>{message}</FormNotice>}

      <Table<RecurringVerification>
        columns={[
          { key: "name", label: "Post", width: "1.4fr" },
          { key: "day", label: "Dag", width: "100px" },
          { key: "period", label: "Period", width: "150px" },
          { key: "mode", label: "Läge", width: "110px" },
          { key: "next", label: "Nästa körning", width: "120px" },
          { key: "last", label: "Senaste körning", width: "190px" },
          { key: "status", label: "Status", width: "90px" },
          { key: "id", label: "", width: "300px", align: "right" },
        ]}
        rows={recurring}
        emptyText="Det finns inga återkommande verifikat än"
        renderCell={(post, key) => {
          switch (key) {
            case "name":
              return post.kind === "allocation" && post.allocation ? (
                <span>
                  {post.description}
                  <br />
                  <span style={{ color: "var(--color-text-secondary)", fontSize: 12.5 }}>
                    Fördelning: {formatMoney(post.allocation.amount)} över {post.allocation.months} månader,{" "}
                    {post.allocation.balanceAccount} → {post.allocation.resultAccount}
                  </span>
                </span>
              ) : (
                <span>
                  {post.templateName}
                  {post.description && post.description !== post.templateName ? (
                    <>
                      <br />
                      <span style={{ color: "var(--color-text-secondary)", fontSize: 12.5 }}>{post.description}</span>
                    </>
                  ) : null}
                </span>
              );
            case "day":
              return dayLabel(post.dayOfMonth);
            case "period":
              return `${post.startMonth} – ${post.endMonth ?? "tills vidare"}`;
            case "mode":
              return MODE_LABELS[post.mode];
            case "next":
              return post.active ? (post.nextRunDate ?? "–") : "–";
            case "last":
              return (
                <span>
                  <RunStatus run={post.lastRun} />
                  {post.failedCount > 0 && (
                    <>
                      <br />
                      <span style={{ color: "var(--status-stopped-text)", fontSize: 12.5 }}>
                        {post.failedCount} misslyckade
                      </span>
                    </>
                  )}
                </span>
              );
            case "status":
              return <StatusPill status={post.active ? "running" : "draft"} label={post.active ? "Aktiv" : "Pausad"} compact />;
            case "id":
              return (
                <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <Button type="button" size="small" variant="ghost" onClick={() => void loadDetail(post.id)}>
                    Körningar
                  </Button>
                  <Button type="button" size="small" variant="ghost" disabled={pending} onClick={() => void runNow(post)}>
                    Kör nu
                  </Button>
                  <Button type="button" size="small" variant="ghost" disabled={pending} onClick={() => void toggleActive(post)}>
                    {post.active ? "Pausa" : "Aktivera"}
                  </Button>
                  <Button type="button" size="small" variant="danger" disabled={pending} onClick={() => void remove(post)}>
                    Ta bort
                  </Button>
                </span>
              );
            default:
              return null;
          }
        }}
      />

      {selected && <RunHistory post={selected} onClose={() => setSelected(null)} />}

      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="Ny återkommande post">
        <NewRecurringForm
          templates={templates}
          onCreated={() => {
            setNewOpen(false);
            router.refresh();
          }}
        />
      </Modal>
      <AllocateDialog
        open={allocateOpen}
        onClose={() => setAllocateOpen(false)}
        onCreated={() => {
          setAllocateOpen(false);
          router.refresh();
        }}
      />
    </>
  );
}

function RunHistory({ post, onClose }: { post: RecurringVerificationDetail; onClose: () => void }) {
  return (
    <Card maxWidth="none" style={{ marginTop: 24 }}>
      <SectionHeading
        actions={
          <Button type="button" size="small" variant="ghost" onClick={onClose}>
            Stäng
          </Button>
        }
      >
        Körningar — {post.kind === "allocation" ? post.description : post.templateName}
      </SectionHeading>
      {post.allocation && (
        <FormHint>
          Belopp per månad: {post.allocation.scheduleAmounts.map((a) => formatMoney(a)).join(" · ")}
        </FormHint>
      )}
      <Table<RecurringRun>
        columns={[
          { key: "month", label: "Månad", width: "100px" },
          { key: "status", label: "Status", width: "130px" },
          { key: "verification", label: "Verifikat", width: "160px" },
          { key: "error", label: "Orsak", width: "1.6fr" },
        ]}
        rows={post.runs}
        emptyText="Inga körningar än"
        renderCell={(run, key) => {
          switch (key) {
            case "month":
              return run.month;
            case "status":
              return <StatusPill status={RUN_STATUS[run.status].pill} label={RUN_STATUS[run.status].label} compact />;
            case "verification":
              return run.verificationId ? (
                <Link href={`/ekonomi/verifikat/${run.verificationId}`}>{run.verificationDisplayNumber ?? "Verifikat"}</Link>
              ) : (
                "–"
              );
            case "error":
              return run.error ?? "–";
            default:
              return null;
          }
        }}
      />
    </Card>
  );
}

function currentMonth(): string {
  return new Date().toLocaleDateString("sv-SE").slice(0, 7);
}

function NewRecurringForm({ templates, onCreated }: { templates: VerificationTemplate[]; onCreated: () => void }) {
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [day, setDay] = useState("1");
  const [startMonth, setStartMonth] = useState(currentMonth);
  const [endMonth, setEndMonth] = useState("");
  const [mode, setMode] = useState<"draft" | "book">("draft");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!templateId) return setError("Välj en mall.");
    setError(null);
    setPending(true);
    try {
      await apiFetch("/api/v1/recurring-verifications", {
        method: "POST",
        body: JSON.stringify({
          templateId,
          dayOfMonth: day === "last" ? "last" : Number(day),
          startMonth,
          endMonth: endMonth || null,
          mode,
        }),
      });
      onCreated();
    } catch (err) {
      setError(apiErrorMessage(err, "Posten kunde inte skapas"));
      setPending(false);
    }
  }

  if (templates.length === 0) {
    return (
      <FormStack>
        <p style={{ margin: 0 }}>
          Det finns inga aktiva mallar. Skapa en under <Link href="/ekonomi/verifikatmallar">Verifikatmallar</Link> — mallen
          bär kontona och beloppen som bokas varje månad.
        </p>
      </FormStack>
    );
  }

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>
      <Field label="Mall" htmlFor="recurringTemplate">
        <Select id="recurringTemplate" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </Field>
      <FormRow>
        <Field label="Dag i månaden" htmlFor="recurringDay">
          <Select id="recurringDay" value={day} onChange={(e) => setDay(e.target.value)}>
            {Array.from({ length: 28 }, (_, i) => String(i + 1)).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
            <option value="last">Sista dagen</option>
          </Select>
        </Field>
        <Field label="Läge" htmlFor="recurringMode">
          <Select id="recurringMode" value={mode} onChange={(e) => setMode(e.target.value as "draft" | "book")}>
            <option value="draft">Utkast</option>
            <option value="book">Bokför direkt</option>
          </Select>
        </Field>
      </FormRow>
      <FormRow>
        <Field label="Startmånad" htmlFor="recurringStart">
          <Input id="recurringStart" type="month" required size="md" value={startMonth} onChange={(e) => setStartMonth(e.target.value)} />
        </Field>
        <Field label="Slutmånad (valfritt)" htmlFor="recurringEnd">
          <Input id="recurringEnd" type="month" size="md" value={endMonth} onChange={(e) => setEndMonth(e.target.value)} />
        </Field>
      </FormRow>
      <FormHint attached>
        {mode === "draft"
          ? "Utkast: verifikatet skapas som ett utkast som du granskar och bokför själv."
          : "Bokför direkt: verifikatet bokförs med samma regler som ett manuellt verifikat — ett fel (till exempel en låst period) visas här och som avisering."}{" "}
        Mallen måste ha belopp på alla rader och balansera.
      </FormHint>
      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Skapar…" : "Skapa post"}
        </Button>
      </FormActions>
    </Form>
  );
}
