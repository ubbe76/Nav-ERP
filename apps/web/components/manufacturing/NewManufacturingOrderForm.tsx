"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { ArticlePicker } from "../ui/ArticlePicker";
import { ConfigureModal } from "../configurator/ConfigureModal";
import { ConfigurationLineList } from "../configurator/ConfigurationLines";
import type { ResolveVariantResult, RowConfigurationDraft } from "../../lib/configurator";
import { apiFetch } from "../../lib/api";
import { stashReleaseWarnings } from "../../lib/releaseWarnings";
import type { Article, ManufacturingOrder } from "../../lib/types";
import { Form, FormActions, FormError, FormHint } from "../ui/Form";
import { SuggestedDueDateField } from "./SuggestedDueDateField";

export function NewManufacturingOrderForm() {
  const router = useRouter();
  const [article, setArticle] = useState<Article | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [dueDate, setDueDate] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [configureTemplate, setConfigureTemplate] = useState<Article | null>(null);
  const [configureKey, setConfigureKey] = useState(0);
  const [variantInfo, setVariantInfo] = useState<{ articleNumber: string; created: boolean } | null>(null);
  // Beställningsvara (to_order): the template stays the TO's article and the choices travel with the order.
  const [rowConfiguration, setRowConfiguration] = useState<RowConfigurationDraft | null>(null);
  const [configureMode, setConfigureMode] = useState<"variants" | "to_order">("variants");

  function handleArticleChange(next: Article | null) {
    setVariantInfo(null);
    setRowConfiguration(null);
    setError(null);
    // variants: Konfigurera hands back the variant article; to_order: the template stays and the choices go on the order.
    if (next?.configuratorMode === "variants" || next?.configuratorMode === "to_order") {
      setArticle(next.configuratorMode === "to_order" ? next : null);
      setConfigureMode(next.configuratorMode);
      setConfigureTemplate(next);
      setConfigureKey((k) => k + 1);
      return;
    }
    setArticle(next);
  }

  function handleConfigured(draft: RowConfigurationDraft) {
    setConfigureTemplate(null);
    setRowConfiguration(draft);
  }

  function handleResolved({ article: variant, created }: ResolveVariantResult) {
    setConfigureTemplate(null);
    setArticle(variant);
    setVariantInfo({ articleNumber: variant.articleNumber, created });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!article) {
      setError("Välj en artikel");
      return;
    }
    if (article.configuratorMode === "to_order" && !rowConfiguration) {
      setError("Konfigurera artikeln först");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const order = await apiFetch<ManufacturingOrder>("/api/v1/manufacturing-orders", {
        method: "POST",
        body: JSON.stringify({
          articleId: article.id,
          quantity: Number(quantity),
          dueDate: dueDate || undefined,
          note: note || undefined,
          ...(rowConfiguration ? { configuration: { selection: rowConfiguration.selection } } : {}),
        }),
      });
      stashReleaseWarnings(order.id, order.releaseWarnings);
      router.push(`/tillverkning/ordrar/${order.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte skapa tillverkningsordern");
      setPending(false);
    }
  }

  return (
    <Form onSubmit={handleSubmit}>
      <FormError>{error}</FormError>

      <Field label="Artikel" htmlFor="articleId">
        <ArticlePicker orderable configurable id="articleId" value={article} onChange={handleArticleChange} />
      </Field>
      {variantInfo && (
        <FormHint>
          Varianten <strong>{variantInfo.articleNumber}</strong> {variantInfo.created ? "skapades" : "fanns redan"}
        </FormHint>
      )}
      {article?.configuratorMode === "to_order" && (
        <>
          {rowConfiguration ? (
            <>
              <ConfigurationLineList lines={rowConfiguration.lines} />
              <Button
                type="button"
                size="small"
                variant="ghost"
                onClick={() => {
                  setConfigureKey((k) => k + 1);
                  setConfigureTemplate(article);
                }}
              >
                Konfigurera om
              </Button>
            </>
          ) : (
            <FormHint>Konfigurera artikeln först</FormHint>
          )}
        </>
      )}
      <ConfigureModal
        open={configureTemplate !== null}
        openKey={configureKey}
        template={configureTemplate}
        customerId={null}
        showPrice={false}
        initialSelection={rowConfiguration?.selection}
        onConfigured={configureMode === "to_order" ? handleConfigured : undefined}
        onResolved={configureMode === "variants" ? handleResolved : undefined}
        onCancel={() => {
          setConfigureTemplate(null);
          if (configureMode === "to_order" && !rowConfiguration) setArticle(null);
        }}
      />

      <Field label="Antal" htmlFor="quantity">
        <Input id="quantity" type="number" min="0" step="any" required size="sm" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      </Field>

      <SuggestedDueDateField id="dueDate" articleId={article?.id ?? null} value={dueDate} onChange={setDueDate} />

      <Field label="Anteckning (valfritt)" htmlFor="note">
        <Input id="note" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>

      <FormActions>
        <Button type="submit" variant="primary" disabled={pending || (article?.configuratorMode === "to_order" && !rowConfiguration)}>
          {pending ? "Skapar…" : "Skapa tillverkningsorder"}
        </Button>
      </FormActions>
    </Form>
  );
}
