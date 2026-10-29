"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { LabelPrintDialog } from "../stock/LabelPrintDialog";
import { ArticlePicker } from "../ui/ArticlePicker";
import { ArticleOverviewButton } from "./ArticleOverviewButton";
import { Card } from "../ui/Card";
import { HelpLink } from "../ui/HelpLink";
import { GatedLink } from "../ui/GatedLink";
import { useVariantOf } from "../../lib/useVariantOf";
import { ARTICLE_TYPE_LABELS, type Article } from "../../lib/types";
import styles from "./ArticleCardHeader.module.css";

// Persistent article-card header (artikelhuvudet): the four fields that
// identify the article — number, benämning, type and stock balance — laid out
// like the order/invoice cards' document header. It lives outside ArticleTabs,
// so it stays put across tab changes; the number field doubles as the article
// switcher.
export function ArticleCardHeader({ article, totalOnHand }: { article: Article; totalOnHand: number }) {
  const router = useRouter();
  const variantOf = useVariantOf(article.id);
  const [labelOpen, setLabelOpen] = useState(false);

  return (
    <Card maxWidth="none" className={styles.card}>
      <div className={styles.main}>
      <div className={styles.grid}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="article-switcher">
            Artikelnummer
          </label>
          <ArticlePicker
            id="article-switcher"
            value={article}
            excludeId={article.id}
            // The benämning has its own field beside this one, so the closed
            // input shows the number alone.
            formatLabel={(picked) => picked.articleNumber}
            onChange={(next) => {
              // null = the user cleared/started typing; only navigate on a pick.
              if (next && next.id !== article.id) router.push(`/artiklar/${next.id}`);
            }}
          />
        </div>

        <div className={styles.field}>
          <div className={styles.label}>Benämning</div>
          <div className={styles.name}>{article.name}</div>
        </div>

        <div className={styles.field}>
          <div className={styles.label}>Artikeltyp</div>
          <div className={styles.value}>
            {ARTICLE_TYPE_LABELS[article.type]}
            {article.isPhantom && <span className={styles.tag}>Fantom</span>}
            {!article.active && <span className={styles.tag}>Inaktiv</span>}
          </div>
        </div>

        <div className={styles.field}>
          <div className={styles.label}>Lagersaldo</div>
          <div className={`${styles.value} num`}>
            {totalOnHand.toLocaleString("sv-SE", { maximumFractionDigits: 3 })}{" "}
            <span className={styles.unit}>{article.unit}</span>
          </div>
        </div>
      </div>
      {variantOf && (
        <div className={styles.variantOf}>
          Variant av{" "}
          <GatedLink href={`/artiklar/${variantOf.templateArticleId}`}>{variantOf.templateArticleNumber}</GatedLink>{" "}
          {variantOf.templateName}
        </div>
      )}
      </div>

      <div className={styles.help}>
        <Button type="button" size="small" variant="secondary" onClick={() => setLabelOpen(true)}>
          Skriv ut etikett
        </Button>
        <ArticleOverviewButton articleId={article.id} articleNumber={article.articleNumber} size="toolbar" />
        <HelpLink chapter="artiklar" anchor="artikelkortet" label="Hjälp om artikelkortet" />
      </div>
      <LabelPrintDialog
        open={labelOpen}
        onClose={() => setLabelOpen(false)}
        endpoint="/api/v1/articles/labels"
        idsKey="articleIds"
        ids={[article.id]}
        title="Skriv ut artikeletikett"
      />
    </Card>
  );
}
