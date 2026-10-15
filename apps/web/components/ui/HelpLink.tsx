import Link from "next/link";
import { HelpIcon } from "./NavIcons";
import styles from "./HelpLink.module.css";

interface HelpLinkProps {
  // Manual chapter slug, e.g. "inkop" — see apps/web/lib/manual.ts.
  chapter: string;
  // Heading anchor within the chapter (slugifyHeading of the heading text).
  anchor?: string;
  // Tooltip/aria label, e.g. "Hjälp om förfrågningar".
  label: string;
}

// Contextual help: a discreet ?-button in a routine's topbar linking to the
// matching manual section under /hjalp.
export function HelpLink({ chapter, anchor, label }: HelpLinkProps) {
  return (
    <Link
      href={`/hjalp/${chapter}${anchor ? `#${anchor}` : ""}`}
      className={styles.helpLink}
      title={label}
      aria-label={label}
    >
      <HelpIcon />
    </Link>
  );
}
