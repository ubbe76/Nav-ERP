import { materialDocumentHref, materialText, materialTone } from "../../lib/dayPlan";
import type { RunPlanRow } from "../../lib/types";
import { GatedLink } from "../ui/GatedLink";
import styles from "./RunPlanMaterials.module.css";

// The material cell of a körplan row (Dagplan; Körplan in etapp 2): one line
// per purchased material linked to the operation with something left to draw
// — "finns", "saknas 4 st", "kommer 2 dec · IO-88 · saknas 8 st" or
// "försenad sedan 25 nov · IO-88". The status is the API's: usable stock
// against this row alone.
export function RunPlanMaterials({
  row,
  // false in Mötesläget: no links on a wall screen.
  links = true,
}: {
  row: Pick<RunPlanRow, "materials" | "materialLinked">;
  links?: boolean;
}) {
  // No purchased material is linked to the operation in the routing.
  if (!row.materialLinked) {
    return (
      <span className={styles.none} title="Operationen saknar kopplat material">
        —
      </span>
    );
  }
  // Linked, and everything is already drawn.
  if (row.materials.length === 0) return <span className={styles.none}>uttaget</span>;
  return (
    <ul className={styles.list}>
      {row.materials.map((m) => {
        const t = materialText(m);
        return (
          <li key={m.articleId} className={styles.item} title={`${m.articleNumber} ${m.articleName}`}>
            <span className={styles.article}>
              <span className="num">{m.articleNumber}</span> <span className={styles.name}>{m.articleName}</span>
            </span>
            <span className={styles.state} data-tone={materialTone(t)}>
              {t.text}
              {t.document && (
                <>
                  {" · "}
                  {links ? (
                    <GatedLink href={materialDocumentHref(t.document)} className={styles.document}>
                      {t.document.number}
                    </GatedLink>
                  ) : (
                    t.document.number
                  )}
                  {t.document.draft ? " (utkast)" : ""}
                </>
              )}
              {t.rest ? ` · ${t.rest}` : ""}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
