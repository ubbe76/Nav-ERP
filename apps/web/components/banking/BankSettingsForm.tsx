"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormNotice, FormSaved } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { BankProfileId, BankSettingsView, DebitAccountKind } from "../../lib/types";
import cardStyles from "../system/SettingsForm.module.css";

const KIND_LABEL: Record<DebitAccountKind, string> = { iban: "IBAN", bankgiro: "Bankgiro", plusgiro: "Plusgiro" };

export function BankSettingsForm({ initial }: { initial: BankSettingsView }) {
  const router = useRouter();
  const [profileId, setProfileId] = useState<BankProfileId | "">(initial.profile ?? "");
  const [initiatingPartyId, setInitiatingPartyId] = useState(initial.initiatingPartyId ?? "");
  const [agreementId, setAgreementId] = useState(initial.debtorAgreementId ?? "");
  const [kind, setKind] = useState<DebitAccountKind | "">(initial.debitAccountKind ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const profile = initial.profiles.find((p) => p.id === profileId) ?? null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      const next = await apiFetch<BankSettingsView>("/api/v1/bank-settings", {
        method: "PATCH",
        body: JSON.stringify({
          profile: profileId || null,
          initiatingPartyId: initiatingPartyId.trim() || null,
          debtorAgreementId: agreementId.trim() || null,
          ...(kind ? { debitAccountKind: kind } : {}),
        }),
      });
      // No key= remount (it would drop the "Sparat" notice): show what the
      // server stored, normalized, and let the refreshed props feed the rest.
      setInitiatingPartyId(next.initiatingPartyId ?? "");
      setAgreementId(next.debtorAgreementId ?? "");
      setKind(next.debitAccountKind ?? "");
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Bankinställningarna kunde inte sparas."));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={cardStyles.card}>
      <SectionHeading>Bank</SectionHeading>
      {initial.missing.length > 0 && (
        <FormError>
          Saknas för att kunna skapa betalfiler:
          <ul>
            {initial.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          Kontonummer och adress ändras under <Link href="/system/foretagsinfo">Företagsinformation</Link>.
        </FormError>
      )}
      {profile && !profile.verified && (
        <FormNotice>
          SEB-profilen är inte verifierad mot SEB:s MIG — prova filen i SEB Test Bench innan första skarpa betalningen.
        </FormNotice>
      )}
      <Form onSubmit={submit}>
        <Field label="Bank" htmlFor="bankProfile">
          <Select
            id="bankProfile"
            value={profileId}
            onChange={(e) => {
              const next = e.target.value as BankProfileId | "";
              setProfileId(next);
              const nextProfile = initial.profiles.find((p) => p.id === next);
              if (nextProfile && kind && !nextProfile.debitAccountKinds.includes(kind)) setKind(nextProfile.debitAccountKinds[0]!);
            }}
          >
            <option value="">Välj bank</option>
            {initial.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        {profile && (
          <>
            <Field label={profile.initiatingPartyLabel} htmlFor="initiatingPartyId">
              <Input id="initiatingPartyId" value={initiatingPartyId} onChange={(e) => setInitiatingPartyId(e.target.value)} />
            </Field>
            {profile.debtorAgreementLabel && (
              <Field label={profile.debtorAgreementLabel} htmlFor="agreementId">
                <Input id="agreementId" value={agreementId} onChange={(e) => setAgreementId(e.target.value)} />
              </Field>
            )}
            <Field label="Debiteringskonto" htmlFor="debitAccountKind">
              <Select id="debitAccountKind" value={kind} onChange={(e) => setKind(e.target.value as DebitAccountKind)}>
                {profile.debitAccountKinds.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]} {initial.company[k] ? `· ${initial.company[k]}` : "· saknas i Företagsinformation"}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        )}
        {error && <FormError>{error}</FormError>}
        <FormActions>
          <Button type="submit" disabled={pending}>
            Spara
          </Button>
          {saved && <FormSaved>Sparat</FormSaved>}
        </FormActions>
      </Form>
    </div>
  );
}
