"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "../ui/Card";
import { ArticleOverviewContent } from "./ArticleOverviewContent";

// /artiklar/oversikt — the same content as the floating panel, inline on its
// own page. The chosen article lives in the URL (?article=) so the view can
// be bookmarked and linked from the panel's "Öppna sida".
export function ArticleOverviewPageClient({ initialArticleId }: { initialArticleId: string | null }) {
  const router = useRouter();
  const [articleId, setArticleId] = useState<string | null>(initialArticleId);

  return (
    <Card maxWidth="none">
      <ArticleOverviewContent
        articleId={articleId}
        pickerId="article-overview-page-picker"
        onChangeArticle={(id) => {
          setArticleId(id);
          router.replace(`/artiklar/oversikt?article=${id}`);
        }}
      />
    </Card>
  );
}
