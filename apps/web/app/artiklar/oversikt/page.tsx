import { AppShell } from "../../../components/AppShell";
import { ArticleOverviewPageClient } from "../../../components/articles/ArticleOverviewPageClient";
import { HelpLink } from "../../../components/ui/HelpLink";
import shellStyles from "../../../components/AppShell.module.css";

// Artikelöversikt (planeringsbild) — every open demand and supply for one
// article in date order with a running balance. Fully client-fetched (the
// article can be switched in place); this server component owns the shell.
export default async function ArticleOverviewPage(props: { searchParams: Promise<{ article?: string }> }) {
  const { article } = await props.searchParams;
  return (
    <AppShell active="Artiklar">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Artikelöversikt</div>
          <div className={shellStyles.meta}>
            Alla öppna behov och inkommande för en artikel i datumordning, med löpande disponibelt antal
          </div>
        </div>
        <HelpLink chapter="artiklar" anchor="artikeloversikt" label="Hjälp om artikelöversikten" />
      </div>

      {/* Keyed on the URL's article so a soft navigation to this route with
          another (or no) ?article= resets the client state instead of
          keeping the previous pick. */}
      <ArticleOverviewPageClient key={article ?? ""} initialArticleId={article ?? null} />
    </AppShell>
  );
}
