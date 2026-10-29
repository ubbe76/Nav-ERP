"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input, Select, Textarea, Toggle } from "../ui/Field";
import { freightModeText } from "../../lib/shipping";
import { apiFetch } from "../../lib/api";
import {
  ARTICLE_TYPE_LABELS,
  type Article,
  type ArticleGroup,
  type ArticleUnit,
  type RegisterEntry,
  type StockLocation,
} from "../../lib/types";
import { EnheterSection } from "./EnheterSection";
import { PriceHistoryButton } from "./PriceHistoryButton";
import styles from "./ArticleForm.module.css";
import { Card } from "../ui/Card";
import { Form, FormActions, FormError } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";

export function AllmantTab({ article, groups }: { article: Article; groups: ArticleGroup[] }) {
  const router = useRouter();

  const [articleNumber, setArticleNumber] = useState(article.articleNumber);
  const [type, setType] = useState(article.type);
  const [isPhantom, setIsPhantom] = useState(article.isPhantom);
  const [name, setName] = useState(article.name);
  const [unitId, setUnitId] = useState(article.unitId);
  const [purchaseUnitId, setPurchaseUnitId] = useState(article.purchaseUnitId ?? "");
  const [salesUnitId, setSalesUnitId] = useState(article.salesUnitId ?? "");
  const [salesPrice, setSalesPrice] = useState(article.salesPrice ?? "");
  const [active, setActive] = useState(article.active);
  const [groupId, setGroupId] = useState(article.groupId ?? "");
  const [articleCodeId, setArticleCodeId] = useState(article.articleCodeId ?? "");
  const [articleCodes, setArticleCodes] = useState<RegisterEntry[]>([]);
  const [defaultLocationId, setDefaultLocationId] = useState(article.defaultLocationId ?? "");
  const [weight, setWeight] = useState(article.weight ?? "");
  const [length, setLength] = useState(article.length ?? "");
  const [width, setWidth] = useState(article.width ?? "");
  const [height, setHeight] = useState(article.height ?? "");
  const [surfaceTreatment, setSurfaceTreatment] = useState(article.surfaceTreatment ?? "");
  const [colour, setColour] = useState(article.colour ?? "");
  const [extraDescription, setExtraDescription] = useState(article.extraDescription ?? "");
  const [quantityPerPackage, setQuantityPerPackage] = useState(article.quantityPerPackage ?? "");
  const [packageTypeId, setPackageTypeId] = useState(article.packageTypeId ?? "");
  const [parcelKind, setParcelKind] = useState(article.parcelKind ?? "");
  const [stackable, setStackable] = useState(article.stackable);
  const [palletSpaces, setPalletSpaces] = useState(article.palletSpaces ?? "");
  const [loadingMeters, setLoadingMeters] = useState(article.loadingMeters ?? "");
  const [packageTypes, setPackageTypes] = useState<RegisterEntry[]>([]);
  const [locations, setLocations] = useState<StockLocation[]>([]);
  const [allUnits, setAllUnits] = useState<RegisterEntry[]>([]);
  const [articleUnits, setArticleUnits] = useState<ArticleUnit[]>([]);

  const loadArticleUnits = useCallback(() => {
    apiFetch<ArticleUnit[]>(`/api/v1/articles/${article.id}/units`).then(setArticleUnits).catch(() => setArticleUnits([]));
  }, [article.id]);

  useEffect(() => {
    apiFetch<StockLocation[]>("/api/v1/stock/locations").then(setLocations).catch(() => setLocations([]));
    apiFetch<RegisterEntry[]>("/api/v1/units").then(setAllUnits).catch(() => setAllUnits([]));
    apiFetch<RegisterEntry[]>("/api/v1/package-types").then(setPackageTypes).catch(() => setPackageTypes([]));
    apiFetch<RegisterEntry[]>("/api/v1/article-codes").then(setArticleCodes).catch(() => setArticleCodes([]));
    loadArticleUnits();
  }, [loadArticleUnits]);

  // Momssats is read-only: it comes from the varugrupp (25 % without one).
  const vatRateText = (() => {
    if (groupId === "") return "25 % (ingen varugrupp)";
    const rate =
      groupId === (article.groupId ?? "") ? article.vatRate : groups.find((g) => g.id === groupId)?.vatRate;
    return rate === undefined ? "–" : `${Number(rate)} % (från varugruppen)`;
  })();

  const baseUnitCode = allUnits.find((u) => u.id === unitId)?.code ?? article.unit;
  // The base unit is locked while alternative units exist — changing it
  // would silently change what every factor means.
  const baseUnitLocked = articleUnits.length > 0;
  const [detailsSaved, setDetailsSaved] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [detailsPending, setDetailsPending] = useState(false);

  const [standardCost, setStandardCost] = useState(article.standardCost ?? "");
  const [costSaved, setCostSaved] = useState(false);
  const [costError, setCostError] = useState<string | null>(null);
  const [costPending, setCostPending] = useState(false);

  async function saveDetails(e: FormEvent) {
    e.preventDefault();
    setDetailsError(null);
    setDetailsSaved(false);
    setDetailsPending(true);
    try {
      await apiFetch(`/api/v1/articles/${article.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          articleNumber,
          type,
          isPhantom,
          name,
          unitId,
          purchaseUnitId: purchaseUnitId === "" ? null : purchaseUnitId,
          salesUnitId: salesUnitId === "" ? null : salesUnitId,
          active,
          salesPrice: salesPrice.trim() === "" ? null : Number(salesPrice),
          groupId: groupId === "" ? null : groupId,
          articleCodeId: articleCodeId === "" ? null : articleCodeId,
          defaultLocationId: defaultLocationId === "" ? null : defaultLocationId,
          weight: weight.trim() === "" ? null : Number(weight),
          length: length.trim() === "" ? null : Number(length),
          width: width.trim() === "" ? null : Number(width),
          height: height.trim() === "" ? null : Number(height),
          surfaceTreatment: surfaceTreatment.trim() === "" ? null : surfaceTreatment,
          colour: colour.trim() === "" ? null : colour,
          // "" clears it; the newlines are kept.
          extraDescription: extraDescription.trim() === "" ? "" : extraDescription,
          quantityPerPackage: quantityPerPackage.trim() === "" ? null : Number(quantityPerPackage),
          packageTypeId: packageTypeId === "" ? null : packageTypeId,
          parcelKind: parcelKind === "" ? null : parcelKind,
          stackable,
          palletSpaces: palletSpaces.trim() === "" ? null : Number(palletSpaces),
          loadingMeters: loadingMeters.trim() === "" ? null : Number(loadingMeters),
        }),
      });
      setDetailsSaved(true);
      router.refresh();
    } catch (err) {
      setDetailsError(err instanceof Error ? err.message : "Kunde inte spara");
    } finally {
      setDetailsPending(false);
    }
  }

  async function saveStandardCost(e: FormEvent) {
    e.preventDefault();
    setCostError(null);
    setCostSaved(false);
    setCostPending(true);
    try {
      await apiFetch(`/api/v1/articles/${article.id}/standard-cost`, {
        method: "PATCH",
        body: JSON.stringify({ standardCost: Number(standardCost) }),
      });
      setCostSaved(true);
      router.refresh();
    } catch (err) {
      setCostError(err instanceof Error ? err.message : "Kunde inte spara");
    } finally {
      setCostPending(false);
    }
  }

  return (
    <Card maxWidth={960}>
      <Form className={styles.block} onSubmit={saveDetails}>
        <FormError>{detailsError}</FormError>

        <section className={styles.section}>
          <SectionHeading>Identitet</SectionHeading>
          <div className={styles.grid}>
            <Field label="Artikelnummer" htmlFor="articleNumber">
              <Input
                id="articleNumber"
                size="md"
                required
                value={articleNumber}
                onChange={(e) => setArticleNumber(e.target.value)}
              />
            </Field>
            <Field label="Typ" htmlFor="type">
              <Select id="type" value={type} onChange={(e) => setType(e.target.value as Article["type"])}>
                {(Object.keys(ARTICLE_TYPE_LABELS) as Article["type"][]).map((t) => (
                  <option key={t} value={t}>
                    {ARTICLE_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            </Field>
            <div className={styles.spanAll}>
              <Field label="Benämning" htmlFor="name">
                <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
            </div>
            <div className={styles.spanAll}>
              <Field label="Extra benämning" htmlFor="extraDescription">
                <Textarea
                  id="extraDescription"
                  rows={3}
                  maxLength={2000}
                  value={extraDescription}
                  onChange={(e) => setExtraDescription(e.target.value)}
                />
              </Field>
            </div>
            <Field label="Varugrupp" htmlFor="groupId">
              <Select id="groupId" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                <option value="">Ingen varugrupp</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.code} · {g.name}
                  </option>
                ))}
              </Select>
            </Field>
            {/* The rate follows the varugrupp. For the saved group it is the
                server's own value (article.vatRate); a group picked but not
                yet saved previews that group's rate. */}
            <Field label="Momssats" htmlFor="vatRateInfo">
              <Input id="vatRateInfo" size="md" readOnly value={vatRateText} />
            </Field>
            <Field label="Artikelkod" htmlFor="articleCodeId">
              <Select id="articleCodeId" value={articleCodeId} onChange={(e) => setArticleCodeId(e.target.value)}>
                <option value="">–</option>
                {/* A code that is no longer listed (deleted elsewhere) stays
                    selectable so opening the card doesn't silently reset it. */}
                {articleCodeId && !articleCodes.some((c) => c.id === articleCodeId) && (
                  <option value={articleCodeId}>
                    {article.articleCodeCode ?? "Okänd"} · {article.articleCodeName ?? ""}
                  </option>
                )}
                {articleCodes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} · {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className={styles.toggles}>
              <Field label="Fantomartikel" htmlFor="isPhantom">
                <Toggle id="isPhantom" checked={isPhantom} onChange={(e) => setIsPhantom(e.target.checked)} />
              </Field>
              <Field label="Aktiv" htmlFor="active">
                <Toggle id="active" checked={active} onChange={(e) => setActive(e.target.checked)} />
              </Field>
            </div>
            <div className={styles.spanAll}>
              <div className={styles.grid}>
                <Field label="Ytbehandling" htmlFor="surfaceTreatment">
                  <Input
                    id="surfaceTreatment"
                    maxLength={200}
                    value={surfaceTreatment}
                    onChange={(e) => setSurfaceTreatment(e.target.value)}
                  />
                </Field>
                <Field label="Färg" htmlFor="colour">
                  <Input id="colour" maxLength={200} value={colour} onChange={(e) => setColour(e.target.value)} />
                </Field>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <SectionHeading>Enheter</SectionHeading>
          <div className={styles.grid}>
            <div className={styles.spanAll}>
              <Field
                label={baseUnitLocked ? "Grundenhet (låst — alternativa enheter finns)" : "Grundenhet"}
                htmlFor="unit"
              >
                <Select id="unit" required value={unitId} disabled={baseUnitLocked} onChange={(e) => setUnitId(e.target.value)}>
                  {allUnits.length === 0 && <option value={unitId}>{article.unit}</option>}
                  {allUnits.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.code} · {u.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {/* Pre-filled on purchase/sales order rows; empty = the base unit. */}
            <Field label="Inköpsenhet" htmlFor="purchaseUnitId">
              <Select id="purchaseUnitId" value={purchaseUnitId} onChange={(e) => setPurchaseUnitId(e.target.value)}>
                <option value="">Grundenheten ({baseUnitCode})</option>
                {articleUnits.map((u) => (
                  <option key={u.unitId} value={u.unitId}>
                    {u.unitCode} · {u.unitName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Försäljningsenhet" htmlFor="salesUnitId">
              <Select id="salesUnitId" value={salesUnitId} onChange={(e) => setSalesUnitId(e.target.value)}>
                <option value="">Grundenheten ({baseUnitCode})</option>
                {articleUnits.map((u) => (
                  <option key={u.unitId} value={u.unitId}>
                    {u.unitCode} · {u.unitName}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </section>

        <section className={styles.section}>
          <SectionHeading>Försäljning</SectionHeading>
          <div className={styles.grid}>
            <Field label="Försäljningspris (kr)" htmlFor="salesPrice">
              <Input
                id="salesPrice"
                type="number"
                size="sm"
                min="0"
                step="0.01"
                value={salesPrice}
                onChange={(e) => setSalesPrice(e.target.value)}
              />
            </Field>
          </div>
          <div className={styles.historyAction}>
            <PriceHistoryButton articleId={article.id} kind="salesPrice" />
          </div>
        </section>

        <section className={styles.section}>
          <SectionHeading>Lager</SectionHeading>
          <div className={`${styles.grid} ${styles.gridSingle}`}>
            <Field label="Lagerplats" htmlFor="defaultLocationId">
              {/* The article's default location — transactions without an explicit
                  choice land here; empty = the auto-created "***" location. */}
              <Select id="defaultLocationId" value={defaultLocationId} onChange={(e) => setDefaultLocationId(e.target.value)}>
                <option value="">*** (standard)</option>
                {/* The list only holds active locations. Keep a deactivated one
                    selectable so opening the card doesn't silently reset it. */}
                {defaultLocationId && !locations.some((l) => l.id === defaultLocationId) && (
                  <option value={defaultLocationId}>{article.defaultLocationName ?? "Okänd"} (inaktiv)</option>
                )}
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.warehouseName} — {l.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </section>

        <section className={styles.section}>
          <SectionHeading>Vikt & mått</SectionHeading>
          <div className={styles.grid}>
            <Field label="Vikt (kg)" htmlFor="weight">
              <Input id="weight" type="number" size="xs" min="0" step="0.001" value={weight} onChange={(e) => setWeight(e.target.value)} />
            </Field>
            <Field label="Längd (mm)" htmlFor="length">
              <Input id="length" type="number" size="xs" min="0" step="0.01" value={length} onChange={(e) => setLength(e.target.value)} />
            </Field>
            <Field label="Bredd (mm)" htmlFor="width">
              <Input id="width" type="number" size="xs" min="0" step="0.01" value={width} onChange={(e) => setWidth(e.target.value)} />
            </Field>
            <Field label="Höjd (mm)" htmlFor="height">
              <Input id="height" type="number" size="xs" min="0" step="0.01" value={height} onChange={(e) => setHeight(e.target.value)} />
            </Field>
          </div>
        </section>

        <section className={styles.section}>
          <SectionHeading>Förpackning</SectionHeading>
          <div className={styles.grid}>
            <Field label={`Antal per kolli (${baseUnitCode})`} htmlFor="quantityPerPackage">
              <Input
                id="quantityPerPackage"
                type="number"
                size="sm"
                min="0"
                step="any"
                value={quantityPerPackage}
                onChange={(e) => setQuantityPerPackage(e.target.value)}
              />
            </Field>
            <Field label="Kollityp" htmlFor="packageTypeId">
              <Select id="packageTypeId" size="md" value={packageTypeId} onChange={(e) => setPackageTypeId(e.target.value)}>
                <option value="">— Ingen —</option>
                {packageTypes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} · {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </section>

        <section className={styles.section}>
          <SectionHeading>Frakt</SectionHeading>
          <p style={{ margin: "0 0 10px", fontSize: 13, color: "var(--color-text-secondary)" }}>
            {freightModeText(
              { packageTypeId: packageTypeId || null, quantityPerPackage, length, width, height },
              packageTypes.find((p) => p.id === packageTypeId)?.name ?? null
            )}
          </p>
          <div className={styles.grid}>
            <Field label="Kolliart (egna mått)" htmlFor="parcelKind">
              <Select id="parcelKind" size="sm" value={parcelKind} onChange={(e) => setParcelKind(e.target.value)}>
                <option value="">Paket</option>
                <option value="pallet">Pall</option>
              </Select>
            </Field>
            <Field label="Pallplatser" htmlFor="palletSpaces">
              <Input id="palletSpaces" type="number" size="xs" min="0" step="any" value={palletSpaces} onChange={(e) => setPalletSpaces(e.target.value)} />
            </Field>
            <Field label="Flakmeter" htmlFor="loadingMeters">
              <Input id="loadingMeters" type="number" size="xs" min="0" step="any" value={loadingMeters} onChange={(e) => setLoadingMeters(e.target.value)} />
            </Field>
            <Field label="Stapelbar" htmlFor="stackable">
              <Checkbox id="stackable" checked={stackable} onChange={(e) => setStackable(e.target.checked)} />
            </Field>
          </div>
        </section>

        <FormActions>
          <Button type="submit" variant="primary" disabled={detailsPending}>
            {detailsPending ? "Sparar…" : "Spara"}
          </Button>
          {detailsSaved && !detailsPending && <span>Sparat ✓</span>}
        </FormActions>
      </Form>

      <Form className={styles.block} onSubmit={saveStandardCost}>
        <FormError>{costError}</FormError>

        <section className={styles.section}>
          <SectionHeading>Kalkyl</SectionHeading>
          <div className={`${styles.grid} ${styles.gridSingle}`}>
            <Field label="Standardkostnad" htmlFor="standardCost">
              <Input
                id="standardCost"
                type="number"
                size="sm"
                min="0"
                // A 4-decimal cost (numeric(14,4), the Kalkyl write-back
                // stores 4 decimals) — not a 0.01 price.
                step="any"
                required
                value={standardCost}
                onChange={(e) => setStandardCost(e.target.value)}
              />
            </Field>
          </div>
        </section>

        <FormActions>
          <Button type="submit" variant="secondary" disabled={costPending}>
            {costPending ? "Sparar…" : "Spara standardkostnad"}
          </Button>
          {costSaved && !costPending && <span>Sparat ✓</span>}
          <PriceHistoryButton articleId={article.id} kind="standardCost" />
        </FormActions>
      </Form>

      <EnheterSection
        articleId={article.id}
        baseUnitCode={baseUnitCode}
        allUnits={allUnits}
        articleUnits={articleUnits}
        onChanged={() => {
          loadArticleUnits();
          router.refresh();
        }}
      />
    </Card>
  );
}
