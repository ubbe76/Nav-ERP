"use client";

import type { ReactNode } from "react";
import { GatedLink } from "../ui/GatedLink";
import styles from "./ArticleLink.module.css";

// An article number that opens the article card in artikelregistret — on the
// kund- and inköpsorder cards and in the Beredning. GatedLink: plain text for
// a user who can't open /artiklar/[id] (the Artiklar permission).
export function ArticleLink({ articleId, children }: { articleId: string; children: ReactNode }) {
  return (
    <GatedLink href={`/artiklar/${articleId}`} className={styles.link}>
      {children}
    </GatedLink>
  );
}
