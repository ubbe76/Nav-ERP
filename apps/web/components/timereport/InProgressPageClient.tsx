"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input } from "../ui/Field";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";
import { HelpLink } from "../ui/HelpLink";
import { Modal } from "../ui/Modal";
import { SectionHeading } from "../ui/SectionHeading";
import { StatusPill } from "../ui/StatusPill";
import { Table } from "../ui/Table";
import { useRole } from "../PermissionsProvider";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { toDateTimeLocalValue } from "../../lib/date";
import { ScrapReasonFields } from "../quality/ScrapReasonFields";
import { useScrapReasons } from "../../lib/useScrapReasons";
import { runWithShortageConfirm } from "../../lib/materialShortage";
import { formatElapsed, formatQuantity, operationProgress } from "../../lib/stampSessions";
import type { AttendanceSession, StampSession } from "../../lib/types";
import shellStyles from "../AppShell.module.css";
import styles from "./InProgressPageClient.module.css";

const REFRESH_MS = 30_000;
const TZ = "Europe/Stockholm";

function dayKey(ms: number) {
  return new Date(ms).toLocaleDateString("sv-SE", { timeZone: TZ });
}

// HH:MM in Stockholm time, prefixed with the date when it isn't today.
function formatSince(iso: string, now: number) {
  const ms = Date.parse(iso);
  const time = new Date(ms).toLocaleTimeString("sv-SE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  if (dayKey(ms) === dayKey(now)) return time;
  const date = new Date(ms).toLocaleDateString("sv-SE", { timeZone: TZ, day: "numeric", month: "short" });
  return `${date} ${time}`;
}

export function InProgressPageClient({
  stamps,
  attendance,
}: {
  stamps: StampSession[];
  attendance: AttendanceSession[];
}) {
  const router = useRouter();
  const role = useRole();
  const canStampOut = role === "admin" || role === "supervisor";
  // null until mounted: the server's clock would differ from the browser's and
  // cause a hydration mismatch in the live times.
  const [mounted, setMounted] = useState(false);
  const [clock, setClock] = useState(0);
  const now = clock;
  const [target, setTarget] = useState<StampSession | null>(null);

  useEffect(() => {
    setClock(Date.now());
    setMounted(true);
    const tick = setInterval(() => setClock(Date.now()), 1000);
    const refresh = setInterval(() => router.refresh(), REFRESH_MS);
    return () => {
      clearInterval(tick);
      clearInterval(refresh);
    };
  }, [router]);

  const sortedStamps = useMemo(
    () => [...stamps].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)),
    [stamps]
  );
  const idle = useMemo(() => {
    const stamped = new Set(stamps.map((s) => s.employeeId));
    return attendance
      .filter((a) => !stamped.has(a.employeeId))
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  }, [stamps, attendance]);

  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Pågående arbete</div>
          <div className={shellStyles.meta}>
            {stamps.length} {stamps.length === 1 ? "instämplad" : "instämplade"} · {idle.length} på plats utan arbete
          </div>
        </div>
        <HelpLink chapter="tillverkning" anchor="pagaende-arbete" label="Hjälp om pågående arbete" />
      </div>

      <SectionHeading>Instämplade på arbete</SectionHeading>
      <Table<StampSession>
        columns={[
          { key: "employee", label: "Anställd", width: "minmax(140px, 1fr)" },
          { key: "order", label: "TO", width: "110px" },
          { key: "operation", label: "Operation", width: "minmax(140px, 1fr)" },
          { key: "article", label: "Artikel", width: "minmax(140px, 1.2fr)" },
          { key: "since", label: "Sedan", width: "110px" },
          { key: "elapsed", label: "Tid", width: "minmax(130px, 1fr)" },
          { key: "quantity", label: "Antal", width: "minmax(180px, 1.2fr)" },
          { key: "action", label: "", width: canStampOut ? "110px" : "0px" },
        ]}
        rows={sortedStamps}
        emptyText="Ingen är instämplad på arbete just nu."
        renderCell={(s, key) => {
          switch (key) {
            case "employee":
              return (
                <>
                  {s.employeeName} <span className={styles.muted}>{s.employeeNumber}</span>
                </>
              );
            case "order":
              return <Link href={`/tillverkning/ordrar/${s.manufacturingOrderId}`}>{s.manufacturingOrderNumber}</Link>;
            case "operation":
              return `${s.operationSequenceNo} · ${s.workCenterName}`;
            case "article":
              return s.articleName;
            case "since":
              return mounted ? formatSince(s.startedAt, now) : "";
            case "elapsed":
              return (
                <span className={styles.elapsed}>
                  <span className="num">{mounted ? formatElapsed(s, now) : ""}</span>
                  {s.pausedAt && <StatusPill status="stopped" label="Pausad" compact />}
                  {s.absentToday && <StatusPill status="delayed" label="Frånvarande" compact />}
                </span>
              );
            case "quantity": {
              const p = operationProgress(s.orderQuantity, s.operationQuantityCompleted, s.operationQuantityScrapped);
              return (
                <span className="num">
                  {formatQuantity(p.planned)} / {formatQuantity(p.ok)} / {formatQuantity(p.remaining)}
                </span>
              );
            }
            case "action":
              return canStampOut ? (
                <Button type="button" variant="secondary" size="small" onClick={() => setTarget(s)}>
                  Stämpla ut
                </Button>
              ) : null;
            default:
              return null;
          }
        }}
      />
      <FormHint>Antal: planerat / klart / kvar.</FormHint>

      <SectionHeading spaced>På plats utan arbete</SectionHeading>
      <Table<AttendanceSession>
        columns={[
          { key: "employee", label: "Anställd", width: "minmax(180px, 1fr)" },
          { key: "since", label: "Sedan", width: "110px" },
          { key: "elapsed", label: "Tid", width: "130px" },
        ]}
        rows={idle}
        emptyText="Alla som är på plats är instämplade på arbete."
        renderCell={(a, key) => {
          if (key === "employee")
            return (
              <>
                {a.employeeName} <span className={styles.muted}>{a.employeeNumber}</span>
              </>
            );
          if (key === "since") return mounted ? formatSince(a.startedAt, now) : "";
          return (
            <span className="num">
              {mounted ? formatElapsed({ startedAt: a.startedAt, pausedAt: null, pausedSeconds: "0" }, now) : ""}
            </span>
          );
        }}
      />

      <Modal
        open={target !== null}
        onClose={() => setTarget(null)}
        title={target ? `Stämpla ut ${target.employeeName} — ${target.manufacturingOrderNumber} op ${target.operationSequenceNo}` : ""}
      >
        {target && (
          <StampOutForm
            session={target}
            onDone={() => {
              setTarget(null);
              router.refresh();
            }}
            onCancel={() => setTarget(null)}
          />
        )}
      </Modal>
    </>
  );
}

function StampOutForm({
  session,
  onDone,
  onCancel,
}: {
  session: StampSession;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [stopAt, setStopAt] = useState(() =>
    toDateTimeLocalValue(session.pausedAt ?? new Date().toISOString())
  );
  // Sluttid is prefilled to the minute. Untouched, the exact instant is sent
  // instead: the pause start for a paused session, otherwise nothing (the
  // server stamps "now") — never the prefill's rounded-down minute.
  const [stopTouched, setStopTouched] = useState(false);
  const stopMs = Date.parse(stopAt);
  const [quantityOk, setQuantityOk] = useState("");
  const [quantityScrapped, setQuantityScrapped] = useState("");
  const [scrapReason, setScrapReason] = useState("");
  // Kassationsorsaker from Kvalitetsorsaker: Orsak is chosen, scrapReason holds the Kommentar.
  const scrapReasonOptions = useScrapReasons();
  const [scrapReasonId, setScrapReasonId] = useState("");
  const reasonRegister = scrapReasonOptions !== null && scrapReasonOptions.length > 0;
  const [markDone, setMarkDone] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const p = operationProgress(session.orderQuantity, session.operationQuantityCompleted, session.operationQuantityScrapped);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (Number.isNaN(stopMs)) {
      setError("Ange sluttid");
      return;
    }
    const scrapped = Number(quantityScrapped) || 0;
    if (scrapped > 0 && reasonRegister && !scrapReasonId) {
      setError("Välj en orsak när kasserat antal är större än 0");
      return;
    }
    if (scrapped > 0 && !reasonRegister && !scrapReason.trim()) {
      setError("Ange en kassationsorsak när kasserat antal är större än 0");
      return;
    }
    setBusy(true);
    try {
      const result = await runWithShortageConfirm((allowMaterialShortage) =>
        apiFetch(`/api/v1/stamp-sessions/${session.id}/stop`, {
          method: "POST",
          body: JSON.stringify({
            ...(stopTouched
              ? { stoppedAt: new Date(stopAt).toISOString() }
              : session.pausedAt
                ? { stoppedAt: session.pausedAt }
                : {}),
            quantityOk: Number(quantityOk) || 0,
            quantityScrapped: scrapped,
            ...(scrapped > 0 && reasonRegister ? { scrapReasonId } : {}),
            scrapReason: scrapReason.trim() || undefined,
            markOperationDone: markDone,
            note: note.trim() || undefined,
            allowMaterialShortage,
          }),
        })
      );
      if (result === null) {
        setBusy(false);
        return;
      }
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte stämpla ut"));
      setBusy(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormHint>
        Planerat {formatQuantity(p.planned)} · Klart {formatQuantity(p.ok)}
        {p.scrapped > 0 && <> · Kasserat {formatQuantity(p.scrapped)}</>} · Kvar {formatQuantity(p.remaining)}
      </FormHint>
      <Field label="Sluttid" htmlFor="so-stop">
        <Input
          id="so-stop"
          type="datetime-local"
          value={stopAt}
          min={toDateTimeLocalValue(session.startedAt)}
          onChange={(e) => {
            setStopTouched(true);
            setStopAt(e.target.value);
          }}
        />
      </Field>
      <FormHint>
        Tid som rapporteras: <span className="num">{Number.isNaN(stopMs) ? "–" : formatElapsed(session, stopMs)}</span>
      </FormHint>
      <Field label="Antal OK" htmlFor="so-ok">
        <Input id="so-ok" type="number" min="0" step="any" value={quantityOk} onChange={(e) => setQuantityOk(e.target.value)} />
      </Field>
      <Field label="Kasserat" htmlFor="so-scrap">
        <Input
          id="so-scrap"
          type="number"
          min="0"
          step="any"
          value={quantityScrapped}
          onChange={(e) => setQuantityScrapped(e.target.value)}
        />
      </Field>
      <ScrapReasonFields
        idPrefix="so"
        reasons={scrapReasonOptions}
        reasonId={scrapReasonId}
        text={scrapReason}
        onReasonId={setScrapReasonId}
        onText={setScrapReason}
        required={(Number(quantityScrapped) || 0) > 0}
      />
      <label className={styles.checkRow}>
        <Checkbox checked={markDone} onChange={(e) => setMarkDone(e.target.checked)} />
        Operationen är klar
      </label>
      <Field label="Notering" htmlFor="so-note">
        <Input id="so-note" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <FormError>{error}</FormError>
      <FormActions>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Avbryt
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Stämplar ut…" : "Stämpla ut"}
        </Button>
      </FormActions>
    </Form>
  );
}
