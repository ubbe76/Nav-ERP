import Link from "next/link";
import { HUB_ICONS } from "../../lib/hubIcons";
import styles from "./HubSections.module.css";

export interface HubSection {
  title: string;
  items: { href: string; title: string; description: string }[];
}

// Module hub layout: one card per function group, each card a compact list
// of clickable rows. Scales to many functions without the clutter of a flat
// grid of large cards. Rows get an icon from HUB_ICONS (keyed on href) unless
// `icons` is false (the manual's chapter list has none).
export function HubSections({ sections, icons = true }: { sections: HubSection[]; icons?: boolean }) {
  return (
    <div className={styles.grid}>
      {sections.map((section) => (
        <section key={section.title} className={styles.group} aria-label={section.title}>
          <h2 className={styles.groupTitle}>{section.title}</h2>
          <ul className={styles.list}>
            {section.items.map((item) => {
              const Icon = icons ? HUB_ICONS[item.href] : undefined;
              return (
                <li key={item.href}>
                  <Link href={item.href} className={Icon ? `${styles.row} ${styles.rowWithIcon}` : styles.row}>
                    {Icon && (
                      <span className={styles.icon}>
                        <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
                      </span>
                    )}
                    <span className={styles.text}>
                      <span className={styles.rowTitle}>{item.title}</span>
                      <span className={styles.rowDescription}>{item.description}</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
