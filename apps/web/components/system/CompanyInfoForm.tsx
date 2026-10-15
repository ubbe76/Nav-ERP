"use client";

import { useRef, useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { Field, Input, Toggle } from "../ui/Field";
import { API_URL, apiFetch } from "../../lib/api";
import type { CompanyInfo } from "../../lib/types";
import styles from "./CompanyInfoForm.module.css";

export function CompanyInfoForm({ initial }: { initial: CompanyInfo }) {
  const [name, setName] = useState(initial.name);
  const [orgNumber, setOrgNumber] = useState(initial.orgNumber ?? "");
  const [address, setAddress] = useState(initial.address ?? "");
  const [postalCode, setPostalCode] = useState(initial.postalCode ?? "");
  const [city, setCity] = useState(initial.city ?? "");
  const [phone, setPhone] = useState(initial.phone ?? "");
  const [email, setEmail] = useState(initial.email ?? "");
  const [website, setWebsite] = useState(initial.website ?? "");
  const [bankgiro, setBankgiro] = useState(initial.bankgiro ?? "");
  const [plusgiro, setPlusgiro] = useState(initial.plusgiro ?? "");
  const [bankName, setBankName] = useState(initial.bankName ?? "");
  const [iban, setIban] = useState(initial.iban ?? "");
  const [bic, setBic] = useState(initial.bic ?? "");
  const [vatNumber, setVatNumber] = useState(initial.vatNumber ?? "");
  const [companySeat, setCompanySeat] = useState(initial.companySeat ?? "");
  const [fSkatt, setFSkatt] = useState(initial.fSkatt);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);

  const [hasLogo, setHasLogo] = useState(initial.hasLogo);
  const [logoVersion, setLogoVersion] = useState(0);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      await apiFetch("/api/v1/company-info", {
        method: "PATCH",
        body: JSON.stringify({
          name,
          orgNumber: orgNumber || null,
          address: address || null,
          postalCode: postalCode || null,
          city: city || null,
          phone: phone || null,
          email: email || null,
          website: website || null,
          bankgiro: bankgiro || null,
          plusgiro: plusgiro || null,
          bankName: bankName || null,
          iban: iban || null,
          bic: bic || null,
          vatNumber: vatNumber || null,
          companySeat: companySeat || null,
          fSkatt,
        }),
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte spara företagsinformationen");
    } finally {
      setPending(false);
    }
  }

  // Deliberately not using apiFetch — it always sets Content-Type:
  // application/json, which is wrong for a multipart upload (the browser
  // must set its own boundary).
  async function handleLogoUpload() {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;

    setLogoError(null);
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`${API_URL}/api/v1/company-info/logo`, {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Kunde inte ladda upp logotypen");
      }
      setHasLogo(true);
      setLogoVersion((v) => v + 1);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : "Kunde inte ladda upp logotypen");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className={styles.stack}>
      <form className={styles.card} onSubmit={handleSubmit}>
        {error && <div className={styles.error}>{error}</div>}

        <Field label="Namn" htmlFor="name">
          <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <div className={styles.row}>
          <Field label="Organisationsnummer" htmlFor="orgNumber">
            <Input id="orgNumber" size="md" value={orgNumber} onChange={(e) => setOrgNumber(e.target.value)} />
          </Field>
          <Field label="Webbplats" htmlFor="website">
            <Input id="website" value={website} onChange={(e) => setWebsite(e.target.value)} />
          </Field>
        </div>

        <Field label="Adress" htmlFor="address">
          <Input id="address" value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>

        <div className={styles.row}>
          <Field label="Postnummer" htmlFor="postalCode">
            <Input id="postalCode" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} />
          </Field>
          <Field label="Ort" htmlFor="city">
            <Input id="city" value={city} onChange={(e) => setCity(e.target.value)} />
          </Field>
        </div>

        <div className={styles.row}>
          <Field label="Telefon" htmlFor="phone">
            <Input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <Field label="E-post" htmlFor="email">
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
        </div>

        {/* Payment/registration details — printed in the footer of outgoing
            documents (förfrågan, inköpsorder, offert, orderbekräftelse). */}
        <div className={styles.row}>
          <Field label="VAT-nummer" htmlFor="vatNumber">
            <Input id="vatNumber" maxLength={30} size="md" value={vatNumber} onChange={(e) => setVatNumber(e.target.value)} />
          </Field>
          <Field label="Säte" htmlFor="companySeat">
            <Input id="companySeat" maxLength={100} value={companySeat} onChange={(e) => setCompanySeat(e.target.value)} />
          </Field>
        </div>

        <div className={styles.row}>
          <Field label="Bankgiro" htmlFor="bankgiro">
            <Input id="bankgiro" maxLength={20} size="md" value={bankgiro} onChange={(e) => setBankgiro(e.target.value)} />
          </Field>
          <Field label="Plusgiro" htmlFor="plusgiro">
            <Input id="plusgiro" maxLength={20} size="md" value={plusgiro} onChange={(e) => setPlusgiro(e.target.value)} />
          </Field>
        </div>

        <div className={styles.row}>
          <Field label="Bank" htmlFor="bankName">
            <Input id="bankName" maxLength={100} value={bankName} onChange={(e) => setBankName(e.target.value)} />
          </Field>
          <Field label="BIC/SWIFT" htmlFor="bic">
            <Input id="bic" maxLength={15} size="md" value={bic} onChange={(e) => setBic(e.target.value)} />
          </Field>
        </div>

        <Field label="IBAN" htmlFor="iban">
          <Input id="iban" maxLength={40} size="md" value={iban} onChange={(e) => setIban(e.target.value)} />
        </Field>

        <Field label="Godkänd för F-skatt" htmlFor="fSkatt">
          <Toggle id="fSkatt" checked={fSkatt} onChange={(e) => setFSkatt(e.target.checked)} />
        </Field>

        <div className={styles.actions}>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Sparar…" : "Spara"}
          </Button>
          {saved && <span className={styles.savedHint}>Sparat</span>}
        </div>
      </form>

      <div className={styles.card}>
        <div className={styles.logoTitle}>Logotyp</div>
        <div className={styles.logoHint}>Används på dokument som inköpsorder och ordererkännande.</div>

        {logoError && <div className={styles.error}>{logoError}</div>}

        <div className={styles.logoRow}>
          {hasLogo ? (
            <img
              key={logoVersion}
              src={`${API_URL}/api/v1/company-info/logo?v=${logoVersion}`}
              alt="Företagslogotyp"
              className={styles.logoPreview}
            />
          ) : (
            <div className={styles.logoPlaceholder}>Ingen logotyp</div>
          )}

          <div className={styles.logoActions}>
            <input ref={fileInputRef} type="file" accept="image/*" className={styles.fileInput} />
            <Button type="button" variant="secondary" onClick={handleLogoUpload} disabled={uploading}>
              {uploading ? "Laddar upp…" : "Ladda upp"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
