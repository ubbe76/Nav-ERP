import Link from "next/link";
import { loadManualSections } from "../../lib/manual";
import { searchSections, type SnippetPart } from "../../lib/manualSearch";
import styles from "./ManualSearch.module.css";

function Parts({ parts }: { parts: SnippetPart[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className={styles.mark}>
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

// Server-rendered, no JS needed: a GET form to /hjalp?q=… and the hits below.
export async function ManualSearch({ query }: { query: string }) {
  const q = query.trim();
  const hits = q ? searchSections(await loadManualSections(), q) : [];
  return (
    <>
      <form action="/hjalp" method="get" role="search" className={styles.form}>
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Sök i manualen…"
          aria-label="Sök i manualen"
          className={styles.input}
        />
        <button type="submit" className={styles.submit}>
          Sök
        </button>
      </form>
      {q && (
        <>
          <p className={styles.summary}>
            {hits.length === 0 ? `Inga träffar på "${q}".` : `${hits.length} träffar på "${q}"`}
          </p>
          <ul className={styles.results}>
            {hits.map((h) => (
              <li key={`${h.chapter}#${h.id}`}>
                <Link href={`/hjalp/${h.chapter}${h.id ? `#${h.id}` : ""}`} className={styles.hit}>
                  <span className={styles.where}>{h.chapterTitle}</span>
                  <span className={styles.heading}>
                    <Parts parts={h.headingParts} />
                  </span>
                  <span className={styles.snippet}>
                    <Parts parts={h.snippet} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
