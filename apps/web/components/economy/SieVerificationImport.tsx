"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Checkbox, Field, Select } from "../ui/Field";
import { FormActions, FormError, FormHint, FormNotice, FormStack } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { API_URL, ApiError, apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney } from "../../lib/format";
import type {
  SieVerificationImportResult,
  SieVerificationPreview,
  VerificationSeries,
} from "../../lib/types";
import styles from "./Sie.module.css";

// Multipart POST that keeps the API's error code/body (apiFetch sends JSON).
async function postMultipart<T>(path: string, body: FormData): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { method: "POST", credentials: "include", body });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new ApiError(payload.error ?? "Åtgärden misslyckades", res.status, payload.code, payload);
  }
  return (await res.json()) as T;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });
}

// "Importera verifikat": the vouchers (#VER/#TRANS) of a SIE file — typically
// the payroll journal from the payroll system — as drafts or booked
// verifications. All or nothing; the same file twice is refused; the file
// follows each verification as underlag.
export function SieVerificationImport() {
  const [series, setSeries] = useState<VerificationSeries[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<SieVerificationPreview | null>(null);
  const [seriesId, setSeriesId] = useState("");
  const [mode, setMode] = useState<"draft" | "book">("draft");
  const [createMissing, setCreateMissing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SieVerificationImportResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<VerificationSeries[]>("/api/v1/verification-series")
      .then((rows) => {
        if (cancelled) return;
        setSeries(rows);
        // The LÖ series is the default once it exists; until then the empty
        // value lets the server create it.
        setSeriesId(rows.find((s) => s.code === "LÖ")?.id ?? "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const hasLo = series.some((s) => s.code === "LÖ");

  async function runPreview(chosen: File) {
    setError(null);
    setResult(null);
    setPreview(null);
    setPending(true);
    try {
      const body = new FormData();
      body.append("file", chosen);
      setPreview(await postMultipart<SieVerificationPreview>("/api/v1/sie/verifications/preview", body));
      setCreateMissing(false);
    } catch (err) {
      setError(apiErrorMessage(err, "Filen kunde inte läsas"));
    } finally {
      setPending(false);
    }
  }

  async function runImport() {
    if (!file || !preview) return;
    setError(null);
    setPending(true);
    try {
      const body = new FormData();
      body.append("file", file);
      if (seriesId) body.append("seriesId", seriesId);
      body.append("mode", mode);
      body.append("createMissingAccounts", createMissing ? "true" : "false");
      setResult(await postMultipart<SieVerificationImportResult>("/api/v1/sie/verifications/import", body));
      setPreview(null);
      setFile(null);
    } catch (err) {
      setError(apiErrorMessage(err, "Importen misslyckades"));
    } finally {
      setPending(false);
    }
  }

  const blocked = preview !== null && (preview.blockers.length > 0 || preview.alreadyImported !== null);
  const missingObjects = preview?.missingObjects ?? [];
  const needsAccounts =
    preview !== null && (preview.missingAccounts.length > 0 || missingObjects.length > 0) && !createMissing;
  const hasUnbalanced = preview?.verifications.some((v) => !v.balanced) ?? false;
  const canImport =
    preview !== null && preview.verifications.length > 0 && !blocked && !needsAccounts && !hasUnbalanced && !pending;

  return (
    <Card maxWidth="none">
      <SectionHeading>Importera verifikat</SectionHeading>
      <FormStack>
        <Field label="SIE-fil" htmlFor="sieVerificationFile">
          <input
            id="sieVerificationFile"
            type="file"
            accept=".se,.si,.sie,.txt"
            disabled={pending}
            onChange={(e) => {
              const picked = e.target.files?.[0] ?? null;
              setFile(picked);
              setResult(null);
              setPreview(null);
              setError(null);
              if (picked) void runPreview(picked);
            }}
          />
        </Field>
        <FormHint attached>
          Läser verifikaten (#VER med #TRANS) i en SIE 4-fil — till exempel lönejournalen från lönesystemet. Du ser
          verifikaten före importen. Antingen importeras hela filen eller ingenting, och filen sparas som underlag på varje
          verifikat.
        </FormHint>

        {pending && !preview && <span>Läser filen…</span>}
        <FormError>{error}</FormError>

        {result && (
          <FormNotice>
            <div>
              {result.imported} verifikat importerades:{" "}
              {result.verifications.map((v, i) => (
                <span key={v.id}>
                  {i > 0 ? ", " : ""}
                  <Link href={`/ekonomi/verifikat/${v.id}`}>{v.displayNumber ?? "Utkast"}</Link>
                </span>
              ))}
            </div>
          </FormNotice>
        )}
      </FormStack>

      {preview && (
        <div className={styles.preview}>
          <div>
            <strong>{preview.fileName}</strong>
            {preview.program ? ` — ${preview.program}` : ""} · {preview.verifications.length} verifikat
          </div>

          {preview.alreadyImported && (
            <FormError>
              Filen har redan importerats {formatDateTime(preview.alreadyImported.importedAt)}
              {preview.alreadyImported.importedBy ? ` av ${preview.alreadyImported.importedBy}` : ""}.
            </FormError>
          )}
          {preview.blockers.map((b) => (
            <FormError key={b}>{b}</FormError>
          ))}
          {preview.warnings.map((w) => (
            <FormNotice key={w}>{w}</FormNotice>
          ))}
          {preview.missingAccounts.length > 0 && (
            <FormNotice>
              Konton som saknas i kontoplanen:{" "}
              {preview.missingAccounts.map((a) => (a.name ? `${a.number} (${a.name})` : a.number)).join(", ")}.
            </FormNotice>
          )}

          {missingObjects.length > 0 && (
            <FormNotice>
              Kostnadsställen och projekt som saknas:{" "}
              {missingObjects
                .map((o) => `${o.dimension === 1 ? "Kostnadsställe" : "Projekt"} ${o.code}${o.name ? ` (${o.name})` : ""}`)
                .join(", ")}
              .
            </FormNotice>
          )}

          {preview.verifications.map((v) => (
            <details key={v.index} className={styles.verification}>
              <summary>
                {v.series ?? "–"} {v.number ?? ""} · {v.date} · {v.text} — Debet {formatMoney(v.debit)}, Kredit{" "}
                {formatMoney(v.credit)}{" "}
                {v.balanced ? "" : <span className={styles.unbalanced}>· Obalans</span>}
                {v.warnings.length > 0 ? ` · ${v.warnings.length} varning${v.warnings.length === 1 ? "" : "ar"}` : ""}
              </summary>
              <div className={styles.verificationBody}>
                {v.warnings.map((w) => (
                  <div key={w} className={styles.warningLine}>
                    {w}
                  </div>
                ))}
                <div className={styles.rowsGrid}>
                  <div className={styles.rowsGridHead}>Konto</div>
                  <div className={`${styles.rowsGridHead} ${styles.hideOnMobile}`}>Text</div>
                  <div className={`${styles.rowsGridHead} ${styles.num}`}>Debet</div>
                  <div className={`${styles.rowsGridHead} ${styles.num}`}>Kredit</div>
                  {v.rows.map((r, i) => (
                    <RowCells key={i} row={r} />
                  ))}
                </div>
              </div>
            </details>
          ))}

          <Field label="Serie" htmlFor="sieVerificationSeries">
            <Select id="sieVerificationSeries" value={seriesId} onChange={(e) => setSeriesId(e.target.value)}>
              {!hasLo && <option value="">LÖ — Lönejournal (skapas vid behov)</option>}
              {series.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} — {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Läge" htmlFor="sieVerificationMode">
            <Select id="sieVerificationMode" value={mode} onChange={(e) => setMode(e.target.value as "draft" | "book")}>
              <option value="draft">Utkast</option>
              <option value="book">Bokför</option>
            </Select>
          </Field>
          {(preview.missingAccounts.length > 0 || missingObjects.length > 0) && (
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontFamily: "var(--font-body)", fontSize: 13.5 }}>
              <Checkbox checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)} />
              Skapa saknade konton och objekt
            </label>
          )}
          {hasUnbalanced && <FormError>Ett eller flera verifikat balanserar inte — filen kan inte importeras.</FormError>}

          <FormActions>
            <Button type="button" variant="primary" disabled={!canImport} onClick={() => void runImport()}>
              {pending ? "Importerar…" : "Importera"}
            </Button>
          </FormActions>
        </div>
      )}
    </Card>
  );
}

function RowCells({ row }: { row: SieVerificationPreview["verifications"][number]["rows"][number] }) {
  return (
    <>
      <div>
        {row.accountNumber}
        {row.accountName ? ` · ${row.accountName}` : " · (saknas)"}
      </div>
      <div className={styles.hideOnMobile}>{row.description ?? ""}</div>
      <div className={styles.num}>{row.amount > 0 ? formatMoney(row.amount) : ""}</div>
      <div className={styles.num}>{row.amount < 0 ? formatMoney(-row.amount) : ""}</div>
    </>
  );
}
