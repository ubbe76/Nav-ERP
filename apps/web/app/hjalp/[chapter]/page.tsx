import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "../../../components/AppShell";
import { MANUAL_CHAPTERS, getChapter, loadChapterHtml } from "../../../lib/manual";
import { ManualSearch } from "../../../components/help/ManualSearch";
import shellStyles from "../../../components/AppShell.module.css";
import styles from "./manual.module.css";

export default async function ManualChapterPage(props: { params: Promise<{ chapter: string }> }) {
  const params = await props.params;
  const chapter = getChapter(params.chapter);
  if (!chapter) notFound();

  const html = await loadChapterHtml(chapter);
  const index = MANUAL_CHAPTERS.findIndex((c) => c.slug === chapter.slug);
  const previous = MANUAL_CHAPTERS[index - 1];
  const next = MANUAL_CHAPTERS[index + 1];

  return (
    <AppShell active="Hjälp">
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{chapter.title}</div>
          <div className={shellStyles.meta}>
            <Link href="/hjalp" className={styles.crumb}>
              Hjälp
            </Link>{" "}
            · Användarmanual
          </div>
        </div>
      </div>

      <ManualSearch query="" />

      <article className={styles.article} dangerouslySetInnerHTML={{ __html: html }} />

      <nav className={styles.pager}>
        {previous ? (
          <Link href={`/hjalp/${previous.slug}`} className={styles.pagerLink}>
            ← {previous.title}
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link href={`/hjalp/${next.slug}`} className={styles.pagerLink}>
            {next.title} →
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </AppShell>
  );
}
