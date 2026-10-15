"use client";

import { useState } from "react";
import { Card } from "../ui/Card";
import { Field, Select } from "../ui/Field";
import { FormActions, FormError, FormHint, FormStack } from "../ui/Form";
import { Button } from "../ui/Button";
import { API_URL } from "../../lib/api";
import buttonStyles from "../ui/Button.module.css";
import type { FiscalYear } from "../../lib/types";
import { SectionHeading } from "../ui/SectionHeading";

// POST /sie/opening-balances's 201 body (economy.routes.ts's
// "--- SIE (B6b) ---" section / sie.service.ts's importOpeningBalances).
interface OpeningBalanceImportResult {
  verificationId: string;
  displayNumber: string;
  accountsCreated: string[];
  balanceCount: number;
}

export function SiePageClient({ fiscalYears }: { fiscalYears: FiscalYear[] }) {
  // Two independent selections — export and import act on different years.
  const [exportYearId, setExportYearId] = useState(fiscalYears[0]?.id ?? "");
  const [importYearId, setImportYearId] = useState(fiscalYears[0]?.id ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OpeningBalanceImportResult | null>(null);

  async function runImport() {
    if (!importYearId || !file) return;
    setError(null);
    setResult(null);
    setPending(true);
    try {
      const body = new FormData();
      body.append("file", file);
      // Multipart upload — apiFetch sets a JSON content type, so this one
      // goes through fetch directly (same approach as ImportWizard's upload).
      const res = await fetch(`${API_URL}/api/v1/sie/opening-balances?fiscalYearId=${importYearId}`, {
        method: "POST",
        credentials: "include",
        body,
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error ?? "Importen misslyckades");
      }
      setResult(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Importen misslyckades");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Card style={{ marginBottom: "var(--space-5)" }}>
        <SectionHeading>Exportera</SectionHeading>
        <FormStack>
          <Field label="Räkenskapsår" htmlFor="sieExportYear">
            <Select id="sieExportYear" value={exportYearId} onChange={(e) => setExportYearId(e.target.value)}>
              {fiscalYears.length === 0 && <option value="">— Inga räkenskapsår —</option>}
              {fiscalYears.map((year) => (
                <option key={year.id} value={year.id}>
                  {year.label}
                </option>
              ))}
            </Select>
          </Field>
          <FormHint attached>
            Filen innehåller räkenskapsårets kontoplan, saldon och samtliga bokförda verifikat.
          </FormHint>
          {fiscalYears.length > 0 && (
            <FormActions>
              <a
                href={`${API_URL}/api/v1/sie/export?fiscalYearId=${exportYearId}`}
                download
                className={`${buttonStyles.button} ${buttonStyles.ghost}`}
              >
                Ladda ner SIE-fil
              </a>
            </FormActions>
          )}
        </FormStack>
      </Card>

      <Card>
        <SectionHeading>Importera ingående balanser</SectionHeading>
        <FormStack>
          <Field label="Räkenskapsår" htmlFor="sieImportYear">
            <Select id="sieImportYear" value={importYearId} onChange={(e) => setImportYearId(e.target.value)}>
              {fiscalYears.length === 0 && <option value="">— Inga räkenskapsår —</option>}
              {fiscalYears.map((year) => (
                <option key={year.id} value={year.id}>
                  {year.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="SIE-fil" htmlFor="sieImportFile">
            <input
              id="sieImportFile"
              type="file"
              accept=".se,.si,.txt"
              disabled={pending}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </Field>
          <FormHint attached>
            Importen är till för att flytta in bokföring från ett annat system — den avvisas om det
            redan finns bokförda verifikat före räkenskapsårets början.
          </FormHint>

          <FormActions>
            <Button
              type="button"
              variant="primary"
              disabled={pending || !importYearId || !file}
              onClick={() => void runImport()}
            >
              {pending ? "Importerar…" : "Importera"}
            </Button>
          </FormActions>

          {error && <FormError>{error}</FormError>}

          {result && (
            <div
              style={{
                fontFamily: "var(--font-body)",
                fontSize: 13,
                color: "var(--status-running-text)",
                background: "var(--status-running-bg)",
                borderRadius: "var(--radius-control-sm)",
                padding: "9px 12px",
              }}
            >
              <p style={{ margin: 0 }}>Ingående balanser importerade som verifikat {result.displayNumber}</p>
              <p style={{ margin: 0 }}>{result.balanceCount} konton</p>
              {result.accountsCreated.length > 0 && (
                <p style={{ margin: 0 }}>Nya konton skapades: {result.accountsCreated.join(", ")}</p>
              )}
            </div>
          )}
        </FormStack>
      </Card>
    </>
  );
}
