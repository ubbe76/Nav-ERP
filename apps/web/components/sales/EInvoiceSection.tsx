"use client";

import { useCallback, useEffect, useState } from "react";
import { Table } from "../ui/Table";
import { Button } from "../ui/Button";
import { StatusPill } from "../ui/StatusPill";
import { SectionHeading } from "../ui/SectionHeading";
import { FormError, FormHint, FormNotice } from "../ui/Form";
import { useCan } from "../PermissionsProvider";
import { apiFetch } from "../../lib/api";
import { confirmDialog } from "../../lib/confirm";
import { formatStockholmDateTime } from "../../lib/date";
import {
  EINVOICE_ENVIRONMENT_LABELS,
  EINVOICE_STATUS_LABELS,
  EINVOICE_STATUS_PILL,
  einvoiceErrorText,
  isLiveEInvoiceStatus,
  type EInvoiceTransmission,
  type InvoiceEInvoice,
} from "../../lib/einvoice";

// E-faktura (Peppol) on the invoice card: who it would go to, the send button
// and the transmission history. Client-fetched so a failing provider setup
// never breaks the invoice page; renders nothing while e-invoicing is off.
export function EInvoiceSection({ invoiceId, invoiceNumber }: { invoiceId: string; invoiceNumber: string }) {
  const can = useCan();
  const [data, setData] = useState<InvoiceEInvoice | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiFetch<InvoiceEInvoice>(`/api/v1/invoices/${invoiceId}/einvoice`));
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [invoiceId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadFailed && !data) {
    return (
      <div style={{ marginTop: 28 }}>
        <strong>E-faktura</strong>
        <FormHint>Kunde inte hämta e-fakturastatus.</FormHint>
      </div>
    );
  }
  if (!data || !data.enabled) return null;

  const canWrite = can(["forsaljning"]);
  const peppolId = data.recipient.peppolId;
  // Only the transmissions in the CURRENT environment decide whether the
  // invoice can be sent: a sandbox trial never blocks the real send (the
  // database's live index is per invoice and environment too), and a real
  // send is not resent because a sandbox row failed.
  const inEnvironment = data.transmissions.filter((t) => t.environment === data.environment);
  const hasLive = inEnvironment.some((t) => isLiveEInvoiceStatus(t.status));
  const latest = inEnvironment[0] ?? null;
  const blocked = data.blockedReason !== null;
  // The main button is the first send; after a rejection or failure the
  // row's own Skicka igen takes over.
  const showSend = canWrite && !blocked && !hasLive && inEnvironment.length === 0;
  const preferred = data.invoiceDelivery === "peppol";

  async function send() {
    if (!(await confirmDialog(`Skicka ${invoiceNumber} som e-faktura till ${peppolId ?? "kunden"}?`))) return;
    setError(null);
    setBusyId("send");
    try {
      await apiFetch(`/api/v1/invoices/${invoiceId}/einvoice`, { method: "POST", body: JSON.stringify({}) });
    } catch (err) {
      setError(einvoiceErrorText(err, "Kunde inte skicka e-fakturan"));
    } finally {
      await load();
      setBusyId(null);
    }
  }

  async function refresh(t: EInvoiceTransmission) {
    setError(null);
    setBusyId(t.id);
    try {
      await apiFetch(`/api/v1/einvoice-transmissions/${t.id}/refresh`, { method: "POST" });
    } catch (err) {
      setError(einvoiceErrorText(err, "Kunde inte uppdatera statusen"));
    } finally {
      await load();
      setBusyId(null);
    }
  }

  return (
    <div style={{ marginTop: 28 }}>
      <strong>E-faktura</strong>
      {data.environment === "sandbox" && (
        <FormNotice style={{ marginTop: 10 }}>Sandbox — ingen faktura skickas på riktigt</FormNotice>
      )}
      <div style={{ marginTop: 10 }}>
        {blocked ? (
          <FormHint>{data.blockedMessage}</FormHint>
        ) : (
          peppolId && (
            <span>
              Peppol-id {peppolId} ({data.recipient.source === "customer" ? "angivet på kunden" : "kundens organisationsnummer"})
            </span>
          )
        )}
      </div>
      {showSend && (
        <div style={{ marginTop: 10 }}>
          <Button type="button" variant={preferred ? "primary" : "secondary"} disabled={busyId !== null} onClick={send}>
            Skicka e-faktura
          </Button>
        </div>
      )}
      <FormError margin="above">{error}</FormError>

      {data.transmissions.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <SectionHeading>Sändningar</SectionHeading>
          <Table<EInvoiceTransmission>
            columns={[
              { key: "startedAt", label: "Tid", width: "150px" },
              { key: "status", label: "Status", width: "1.4fr" },
              { key: "environment", label: "Miljö", width: "110px" },
              { key: "id", label: "", width: "250px", align: "right" },
            ]}
            rows={data.transmissions}
            renderCell={(t, key) => {
              switch (key) {
                case "startedAt":
                  return formatStockholmDateTime(t.startedAt);
                case "status":
                  return (
                    <>
                      <StatusPill
                        status={EINVOICE_STATUS_PILL[t.status]}
                        label={t.environment === "sandbox" ? `${EINVOICE_STATUS_LABELS[t.status]} (sandbox)` : EINVOICE_STATUS_LABELS[t.status]}
                        compact
                      />
                      {t.errorMessage && <div>{t.errorMessage}</div>}
                    </>
                  );
                case "environment":
                  return t.environment === "sandbox" ? <strong>{EINVOICE_ENVIRONMENT_LABELS.sandbox}</strong> : EINVOICE_ENVIRONMENT_LABELS[t.environment];
                case "id":
                  return (
                    <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center" }}>
                      <a href={`/api/v1/einvoice-transmissions/${t.id}/document`} download>
                        UBL
                      </a>
                      {canWrite && isLiveEInvoiceStatus(t.status) && (
                        <Button type="button" size="small" variant="ghost" disabled={busyId !== null} onClick={() => refresh(t)}>
                          Uppdatera status
                        </Button>
                      )}
                      {canWrite && !blocked && !hasLive && t.id === latest?.id && !isLiveEInvoiceStatus(t.status) && (
                        <Button type="button" size="small" variant="secondary" disabled={busyId !== null} onClick={send}>
                          Skicka igen
                        </Button>
                      )}
                    </span>
                  );
                default:
                  return null;
              }
            }}
          />
        </div>
      )}
    </div>
  );
}
