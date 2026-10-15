"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatMoney } from "../../lib/format";
import {
  CONFIGURATOR_MODE_LABELS,
  type ConfiguratorMode,
  type ConfiguratorTemplateView,
} from "../../lib/configurator";
import type { Article, RoutingOperation } from "../../lib/types";
import { useCan } from "../PermissionsProvider";
import { SectionHeading } from "../ui/SectionHeading";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Checkbox } from "../ui/Field";
import { SegmentedToggle } from "../ui/SegmentedToggle";
import { Form, FormActions, FormError, FormHint, FormNotice } from "../ui/Form";
import { HelpLink } from "../ui/HelpLink";
import { GroupSection } from "../configurator/GroupSection";
import { RuleSection } from "../configurator/RuleSection";
import { BomLineSection } from "../configurator/BomLineSection";
import { OperationSection } from "../configurator/OperationSection";
import { TestConfigurationPanel } from "../configurator/TestConfigurationPanel";
import { VariantSection } from "../configurator/VariantSection";
import { VariantOfPanel } from "../configurator/VariantOfPanel";
import { useVariantOf } from "../../lib/useVariantOf";

type ModeDialog = null | "create" | "change" | "delete";

// Konfigurator tab: marks the article as a configurable template and holds its
// option groups, rules and a test panel.
export function KonfiguratorTab({ article, onChanged }: { article: Article; onChanged?: () => void | Promise<void> }) {
  const canEdit = useCan()(["artiklar"]);
  const variantOf = useVariantOf(article.id);
  // undefined = loading, null = not a template.
  const [template, setTemplate] = useState<ConfiguratorTemplateView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ModeDialog>(null);
  const [publishing, setPublishing] = useState(false);
  // The template's own routing, for the operation link in a conditional line.
  const [routing, setRouting] = useState<RoutingOperation[]>([]);

  const reload = useCallback(async () => {
    try {
      setTemplate(await apiFetch<ConfiguratorTemplateView>(`/api/v1/articles/${article.id}/configurator`));
      setError(null);
    } catch (err) {
      if ((err as { code?: string }).code === "configurator-template-not-found") {
        setTemplate(null);
        setError(null);
      } else {
        setError(apiErrorMessage(err, "Kunde inte hämta konfiguratorn"));
      }
    }
  }, [article.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Visa i API saves at once, then reloads the template.
  async function setPublished(published: boolean) {
    setPublishing(true);
    try {
      await apiFetch(`/api/v1/articles/${article.id}/configurator`, { method: "PATCH", body: JSON.stringify({ published }) });
      await reload();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara"));
    } finally {
      setPublishing(false);
    }
  }

  const isTemplate = template != null;
  useEffect(() => {
    if (!isTemplate) return;
    let cancelled = false;
    apiFetch<RoutingOperation[]>(`/api/v1/articles/${article.id}/routing`)
      .then((rows) => {
        if (!cancelled) setRouting(rows);
      })
      .catch(() => {
        // The link select just lacks the template's own operations.
      });
    return () => {
      cancelled = true;
    };
  }, [article.id, isTemplate]);

  const changed = useCallback(async () => {
    await reload();
    await onChanged?.();
  }, [reload, onChanged]);

  // Kalkylantal in the variant dialogs starts at the article's Orderkvantitet.
  const orderQuantity = article.orderQuantity === null ? null : Number(article.orderQuantity);
  const calcQuantity = orderQuantity !== null && orderQuantity > 0 ? orderQuantity : 1;

  const help = <HelpLink chapter="artiklar" anchor="konfigurator" label="Hjälp om konfiguratorn" />;

  // A stocked variant shows its choices read-only and nothing else.
  if (variantOf) return <VariantOfPanel variantOf={variantOf} />;

  if (template === undefined || variantOf === undefined) {
    return (
      <div>
        <SectionHeading actions={help}>Konfigurator</SectionHeading>
        <FormError>{error}</FormError>
        {!error && <p>Hämtar…</p>}
      </div>
    );
  }

  if (template === null) {
    return (
      <div>
        <SectionHeading actions={help}>Konfigurator</SectionHeading>
        <p style={{ marginTop: 0 }}>
          Artikeln är inte konfigurerbar. Gör den konfigurerbar för att kunna sätta upp valgrupper, regler och priser
          som kunden väljer mellan på en offert eller order.
        </p>
        <FormError margin="below">{error}</FormError>
        {canEdit && (
          <Button
            onClick={() => setDialog("create")}
            disabled={article.isPhantom}
            title={article.isPhantom ? "En fantomartikel kan inte vara konfigurerbar" : undefined}
          >
            Gör konfigurerbar
          </Button>
        )}
        <ModeModal
          open={dialog === "create"}
          articleId={article.id}
          articleType={article.type}
          initial="variants"
          create
          onClose={() => setDialog(null)}
          onSaved={changed}
        />
      </div>
    );
  }

  return (
    <div>
      <SectionHeading
        actions={
          <>
            {canEdit && (
              <>
                <Button size="small" variant="secondary" onClick={() => setDialog("change")}>
                  Ändra
                </Button>
                <Button size="small" variant="danger" onClick={() => setDialog("delete")}>
                  Ta bort konfigurator
                </Button>
              </>
            )}
            {help}
          </>
        }
      >
        Konfigurator
      </SectionHeading>
      <FormError margin="below">{error}</FormError>
      <p style={{ marginTop: 0 }}>
        <strong>Läge:</strong> {CONFIGURATOR_MODE_LABELS[template.mode]}
        {template.published && <> · <strong>API</strong></>}
      </p>
      {canEdit && (
        <div style={{ marginBottom: "var(--space-3)" }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}>
            <Checkbox checked={template.published} disabled={publishing} onChange={(e) => void setPublished(e.target.checked)} />
            Visa i API
          </label>
          <FormHint>Mallen syns för externa system via API:t (System → Integrationer)</FormHint>
        </div>
      )}
      {template.basePrice !== null ? (
        <FormHint>Grundpris: {formatMoney(template.basePrice)} (försäljningspriset på fliken Allmänt)</FormHint>
      ) : (
        <FormNotice>Grundpris saknas — ange försäljningspris på artikeln</FormNotice>
      )}

      <GroupSection articleId={article.id} groups={template.groups} canEdit={canEdit} onChanged={changed} />

      <RuleSection
        articleId={article.id}
        groups={template.groups}
        rules={template.rules}
        canEdit={canEdit}
        onChanged={changed}
      />

      <BomLineSection
        articleId={article.id}
        groups={template.groups}
        lines={template.bomLines}
        warnings={template.structureWarnings}
        operations={template.operations}
        routing={routing}
        canEdit={canEdit}
        onChanged={changed}
      />

      <OperationSection
        articleId={article.id}
        groups={template.groups}
        operations={template.operations}
        canEdit={canEdit}
        onChanged={changed}
      />

      {template.mode === "variants" && (
        <VariantSection
          articleId={article.id}
          groups={template.groups}
          defaultQuantity={calcQuantity}
          canEdit={canEdit}
        />
      )}

      <TestConfigurationPanel
        articleId={article.id}
        groups={template.groups}
        mode={template.mode}
        defaultQuantity={calcQuantity}
      />

      <ModeModal
        open={dialog === "change"}
        articleId={article.id}
        articleType={article.type}
        initial={template.mode}
        onClose={() => setDialog(null)}
        onSaved={changed}
      />
      <DeleteModal
        open={dialog === "delete"}
        articleId={article.id}
        onClose={() => setDialog(null)}
        onDeleted={changed}
      />
    </div>
  );
}

function ModeModal({
  open,
  articleId,
  articleType,
  initial,
  create,
  onClose,
  onSaved,
}: {
  open: boolean;
  articleId: string;
  articleType: Article["type"];
  initial: ConfiguratorMode;
  create?: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  return (
    <Modal open={open} onClose={onClose} title={create ? "Gör konfigurerbar" : "Ändra läge"}>
      <ModeForm
        key={initial}
        articleId={articleId}
        articleType={articleType}
        initial={initial}
        create={create}
        onClose={onClose}
        onSaved={onSaved}
      />
    </Modal>
  );
}

function ModeForm({
  articleId,
  articleType,
  initial,
  create,
  onClose,
  onSaved,
}: {
  articleId: string;
  articleType: Article["type"];
  initial: ConfiguratorMode;
  create?: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [mode, setMode] = useState<ConfiguratorMode>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const toOrderBlocked = articleType !== "manufactured";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/articles/${articleId}/configurator`, {
        method: create ? "POST" : "PATCH",
        body: JSON.stringify({ mode }),
      });
      await onSaved();
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara läget"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <SegmentedToggle<ConfiguratorMode>
        value={mode}
        ariaLabel="Läge"
        onChange={setMode}
        options={[
          { value: "variants", label: CONFIGURATOR_MODE_LABELS.variants },
          {
            value: "to_order",
            label: CONFIGURATOR_MODE_LABELS.to_order,
            disabled: toOrderBlocked,
            title: toOrderBlocked ? "Beställningsvara kräver en tillverkad artikel" : undefined,
          },
        ]}
      />
      <FormHint>
        {mode === "variants"
          ? "Varje kombination av val blir en egen artikel (variantartikel), som du skapar med Skapa varianter eller Skapa variant."
          : "Valen följer med orderraden och artikeln tillverkas efter beställning."}
      </FormHint>
      <FormError>{error}</FormError>
      <FormActions>
        <Button type="submit" disabled={pending}>
          {pending ? "Sparar…" : "Spara"}
        </Button>
        <Button type="button" variant="secondary" onClick={onClose}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}

function DeleteModal({
  open,
  articleId,
  onClose,
  onDeleted,
}: {
  open: boolean;
  articleId: string;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Ta bort konfigurator">
      <DeleteForm articleId={articleId} onClose={onClose} onDeleted={onDeleted} />
    </Modal>
  );
}

function DeleteForm({
  articleId,
  onClose,
  onDeleted,
}: {
  articleId: string;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function applyChange() {
    setError(null);
    setPending(true);
    try {
      await apiFetch(`/api/v1/articles/${articleId}/configurator`, { method: "DELETE" });
      await onDeleted();
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte ta bort konfiguratorn"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Form onSubmit={(e) => e.preventDefault()}>
      <p style={{ margin: 0 }}>Valgrupper och regler tas bort. Artikeln blir en vanlig artikel.</p>
      <FormError>{error}</FormError>
      <FormActions>
        <Button type="button" variant="danger" disabled={pending} onClick={() => void applyChange()}>
          Ta bort
        </Button>
        <Button type="button" variant="secondary" onClick={onClose}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}
