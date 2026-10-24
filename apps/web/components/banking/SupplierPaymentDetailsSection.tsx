"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormNotice, FormRow, FormSaved } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { ApiError, apiFetch } from "../../lib/api";
import {
  CHARGE_BEARERS,
  CHARGE_BEARER_LABELS,
  CLEARING_SYSTEMS,
  CLEARING_SYSTEM_CODES,
  DEFAULT_PAYMENT_REPORTING_CODE,
  PAYMENT_REPORTING_THRESHOLD_SEK,
  SUPPLIER_PAYMENT_METHODS,
  SUPPLIER_PAYMENT_METHOD_LABELS,
  isForeignPayee,
  type ChargeBearer,
  type ClearingSystem,
  type SupplierPaymentMethod,
} from "../../lib/banking";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { Supplier } from "../../lib/types";

// What the server's `problems` (400 invalid-supplier-payment-details, field →
// Swedish text) say about the supplier's own address, which is edited on the
// Allmänt tab, not in this section.
const ADDRESS_PROBLEM_KEYS = new Set(["address", "city", "country"]);

// Bankfiler: how the supplier is paid. All numbers may be stored; the method
// picks the one a payment file uses. The server normalizes and checks the
// check digits (InvalidSupplierPaymentDetailsError → field-specific text).
//
// Utlandsbetalningar (valuta steg 2): IBAN takes every country's IBAN, and
// Utländskt kontonummer is an account without IBAN (USA, Kanada, Australien …)
// identified by BIC and/or a national bank id. A payee abroad also needs
// street, town and country on the Allmänt tab, and carries Avgiftsfördelning
// and Skatteverkets betalningskod.
export function SupplierPaymentDetailsSection({
  supplier,
  onSavedChange,
  saved,
}: {
  supplier: Supplier;
  // The parent keeps "Sparat" outside the keyed form, which remounts when the
  // server's normalized numbers come back through router.refresh().
  onSavedChange: (saved: boolean) => void;
  saved: boolean;
}) {
  const router = useRouter();
  const [method, setMethod] = useState<SupplierPaymentMethod | "">(supplier.paymentMethod ?? "");
  const [bankgiro, setBankgiro] = useState(supplier.bankgiro ?? "");
  const [plusgiro, setPlusgiro] = useState(supplier.plusgiro ?? "");
  const [clearing, setClearing] = useState(supplier.bankClearing ?? "");
  const [account, setAccount] = useState(supplier.bankAccountNumber ?? "");
  const [iban, setIban] = useState(supplier.iban ?? "");
  const [bic, setBic] = useState(supplier.bic ?? "");
  const [foreignAccount, setForeignAccount] = useState(supplier.foreignAccountNumber ?? "");
  const [clearingSystem, setClearingSystem] = useState<ClearingSystem | "">((supplier.clearingSystem as ClearingSystem | null) ?? "");
  const [clearingMemberId, setClearingMemberId] = useState(supplier.clearingMemberId ?? "");
  const [bankName, setBankName] = useState(supplier.bankName ?? "");
  const [chargeBearer, setChargeBearer] = useState<ChargeBearer>(supplier.chargeBearer ?? "SHAR");
  const [reportingCode, setReportingCode] = useState(supplier.paymentReportingCode ?? DEFAULT_PAYMENT_REPORTING_CODE);
  const [error, setError] = useState<string | null>(null);
  // Field → Swedish problem from the server, shown at the field (or at the top
  // when the field is not on screen for the chosen method).
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);

  // A payment abroad: the Avgiftsfördelning and Betalningskod fields apply
  // (whether a single payment is SEPA or international follows the invoice's
  // currency and the payee's IBAN — the batch says which).
  const showAbroad = method === "foreign_account" || (method === "iban" && !iban.trim().toUpperCase().startsWith("SE"));
  const foreignPayee = isForeignPayee(method, iban.replace(/\s/g, "") || null);
  const addressMissing = !supplier.address?.trim() || !supplier.city?.trim();

  const visibleKeys = new Set<string>(["paymentMethod"]);
  if (method === "bankgiro") visibleKeys.add("bankgiro");
  if (method === "plusgiro") visibleKeys.add("plusgiro");
  if (method === "bank_account") ["bankClearing", "bankAccountNumber"].forEach((k) => visibleKeys.add(k));
  if (method === "iban") ["iban", "bic"].forEach((k) => visibleKeys.add(k));
  if (method === "foreign_account") ["foreignAccountNumber", "bic", "clearingSystem", "clearingMemberId"].forEach((k) => visibleKeys.add(k));
  if (showAbroad) ["chargeBearer", "paymentReportingCode"].forEach((k) => visibleKeys.add(k));
  // Everything else the server complains about is listed at the top.
  const topProblems = Object.entries(problems).filter(([key]) => !visibleKeys.has(key));

  async function save(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setProblems({});
    onSavedChange(false);
    try {
      await apiFetch(`/api/v1/suppliers/${supplier.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          paymentMethod: method || null,
          bankgiro: bankgiro.trim() || null,
          plusgiro: plusgiro.trim() || null,
          bankClearing: clearing.trim() || null,
          bankAccountNumber: account.trim() || null,
          iban: iban.trim() || null,
          bic: bic.trim() || null,
          foreignAccountNumber: foreignAccount.trim() || null,
          clearingSystem: clearingSystem || null,
          clearingMemberId: clearingMemberId.trim() || null,
          bankName: bankName.trim() || null,
          chargeBearer,
          paymentReportingCode: reportingCode.trim() || DEFAULT_PAYMENT_REPORTING_CODE,
        }),
      });
      onSavedChange(true);
      router.refresh();
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as { problems?: Record<string, string> } | undefined) : undefined;
      if (body?.problems && Object.keys(body.problems).length > 0) setProblems(body.problems);
      else setError(apiErrorMessage(err, "Betalningsuppgifterna kunde inte sparas."));
    } finally {
      setPending(false);
    }
  }

  const selectedClearing = clearingSystem ? CLEARING_SYSTEMS[clearingSystem] : null;

  return (
    <>
      <SectionHeading spaced>Betalning</SectionHeading>
      <Card>
        <Form onSubmit={save}>
          <Field label="Betalningssätt" htmlFor="paymentMethod">
            <Select id="paymentMethod" value={method} onChange={(e) => setMethod(e.target.value as SupplierPaymentMethod | "")}>
              <option value="">Inget (kan inte betalas via betalfil)</option>
              {SUPPLIER_PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {SUPPLIER_PAYMENT_METHOD_LABELS[m]}
                </option>
              ))}
            </Select>
            <FormError>{problems.paymentMethod}</FormError>
          </Field>
          {method === "bankgiro" && (
            <Field label="Bankgiro" htmlFor="bankgiro">
              <Input id="bankgiro" value={bankgiro} onChange={(e) => setBankgiro(e.target.value)} placeholder="5050-1055" />
              <FormError>{problems.bankgiro}</FormError>
            </Field>
          )}
          {method === "plusgiro" && (
            <Field label="Plusgiro" htmlFor="plusgiro">
              <Input id="plusgiro" value={plusgiro} onChange={(e) => setPlusgiro(e.target.value)} placeholder="489216-2" />
              <FormError>{problems.plusgiro}</FormError>
            </Field>
          )}
          {method === "bank_account" && (
            <>
              <FormRow>
                <Field label="Clearingnummer" htmlFor="bankClearing">
                  <Input id="bankClearing" value={clearing} onChange={(e) => setClearing(e.target.value)} placeholder="8327-9" />
                  <FormError>{problems.bankClearing}</FormError>
                </Field>
                <Field label="Kontonummer" htmlFor="bankAccountNumber">
                  <Input id="bankAccountNumber" value={account} onChange={(e) => setAccount(e.target.value)} />
                  <FormError>{problems.bankAccountNumber}</FormError>
                </Field>
              </FormRow>
              <FormHint>Clearingnummer i 8-serien (Swedbank) ska vara 5 siffror, t.ex. 8327-9. Övriga banker har 4 siffror.</FormHint>
            </>
          )}
          {method === "iban" && (
            <>
              <FormRow>
                <Field label="IBAN" htmlFor="iban">
                  <Input id="iban" value={iban} onChange={(e) => setIban(e.target.value)} />
                  <FormError>{problems.iban}</FormError>
                </Field>
                <Field label="BIC" htmlFor="bic">
                  <Input id="bic" value={bic} onChange={(e) => setBic(e.target.value)} />
                  <FormError>{problems.bic}</FormError>
                </Field>
              </FormRow>
              <FormHint>
                IBAN från alla länder kan betalas via betalfil. BIC är frivillig inom SEPA-området och krävs för IBAN i övriga länder.
                Betalningstypen (inrikes, SEPA eller utland) avgörs per faktura av fakturans valuta och mottagarens IBAN.
              </FormHint>
            </>
          )}
          {method === "foreign_account" && (
            <>
              <FormRow>
                <Field label="Kontonummer" htmlFor="foreignAccountNumber">
                  <Input id="foreignAccountNumber" value={foreignAccount} onChange={(e) => setForeignAccount(e.target.value)} />
                  <FormError>{problems.foreignAccountNumber}</FormError>
                </Field>
                <Field label="BIC" htmlFor="bic">
                  <Input id="bic" value={bic} onChange={(e) => setBic(e.target.value)} />
                  <FormError>{problems.bic}</FormError>
                </Field>
              </FormRow>
              <FormRow>
                <Field label="Bank-id (typ)" htmlFor="clearingSystem">
                  <Select id="clearingSystem" value={clearingSystem} onChange={(e) => setClearingSystem(e.target.value as ClearingSystem | "")}>
                    <option value="">Inget bank-id</option>
                    {CLEARING_SYSTEM_CODES.map((code) => (
                      <option key={code} value={code}>
                        {CLEARING_SYSTEMS[code].label}
                      </option>
                    ))}
                  </Select>
                  <FormError>{problems.clearingSystem}</FormError>
                </Field>
                <Field label="Bank-id" htmlFor="clearingMemberId">
                  <Input id="clearingMemberId" value={clearingMemberId} onChange={(e) => setClearingMemberId(e.target.value)} />
                  <FormError>{problems.clearingMemberId}</FormError>
                </Field>
              </FormRow>
              <Field label="Bankens namn" htmlFor="bankName">
                <Input id="bankName" value={bankName} maxLength={70} onChange={(e) => setBankName(e.target.value)} />
              </Field>
              <FormHint>
                Ett utländskt kontonummer identifieras med BIC och/eller ett nationellt bank-id (t.ex. ABA routing number i USA).
                {selectedClearing ? ` Bank-id för ${clearingSystem}: ${selectedClearing.format}.` : ""} Bankens namn behövs hos vissa
                banker (t.ex. Nordea) när bara bank-id anges. Mottagare i SEPA-området betalas med IBAN.
              </FormHint>
            </>
          )}
          {showAbroad && (
            <>
              <FormRow>
                <Field label="Avgiftsfördelning" htmlFor="chargeBearer">
                  <Select id="chargeBearer" value={chargeBearer} onChange={(e) => setChargeBearer(e.target.value as ChargeBearer)}>
                    {CHARGE_BEARERS.map((c) => (
                      <option key={c} value={c}>
                        {CHARGE_BEARER_LABELS[c]}
                      </option>
                    ))}
                  </Select>
                  <FormError>{problems.chargeBearer}</FormError>
                </Field>
                <Field label="Betalningskod (Skatteverket)" htmlFor="paymentReportingCode">
                  <Input
                    id="paymentReportingCode"
                    value={reportingCode}
                    inputMode="numeric"
                    maxLength={3}
                    onChange={(e) => setReportingCode(e.target.value.replace(/\D/g, ""))}
                  />
                  <FormError>{problems.paymentReportingCode}</FormError>
                </Field>
              </FormRow>
              <FormHint>
                Avgiftsfördelningen gäller utlandsbetalningar utanför SEPA; en betalning i EUR inom SEPA-området skickas alltid med
                SEPA-avgifter. Betalningskoden skrivs i betalfilen för betalningar över {PAYMENT_REPORTING_THRESHOLD_SEK.toLocaleString("sv-SE")} kr,
                som banken rapporterar till Skatteverket (KU81) — {DEFAULT_PAYMENT_REPORTING_CODE} är varuexport/varuimport.
              </FormHint>
            </>
          )}
          {foreignPayee && addressMissing && (
            <FormNotice>
              En utländsk mottagare kräver gatuadress och ort — fyll i dem under Adress och Postort på fliken Allmänt, annars kan
              betalfilen inte exporteras.
            </FormNotice>
          )}
          {method === "foreign_account" && supplier.country.toUpperCase() === "SE" && (
            <FormNotice>
              Ett utländskt kontonummer kräver att leverantörens Land inte är Sverige — ändra Land på fliken Allmänt.
            </FormNotice>
          )}
          {error && <FormError>{error}</FormError>}
          {Object.keys(problems).length > 0 && (
            <FormError>
              Betalningsuppgifterna kunde inte sparas{topProblems.length < Object.keys(problems).length ? " — rätta de markerade fälten" : ""}.
              {topProblems.map(([key, text]) => (
                <div key={key}>
                  {text}
                  {ADDRESS_PROBLEM_KEYS.has(key) ? " (ändras på fliken Allmänt)" : ""}
                </div>
              ))}
            </FormError>
          )}
          <FormActions>
            <Button type="submit" disabled={pending}>
              Spara betalningsuppgifter
            </Button>
            {saved && <FormSaved>Sparat</FormSaved>}
          </FormActions>
        </Form>
      </Card>
    </>
  );
}
