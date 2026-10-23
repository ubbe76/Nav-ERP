import Link from "next/link";
import { HUB_ICONS, PLUGIN_PAGE_ICON } from "../../lib/hubIcons";
import { FavoriteStar } from "./FavoriteStar";
import styles from "./HubSections.module.css";

export interface HubSection {
  title: string;
  items: { href: string; title: string; description: string }[];
}

// Module hub layout: one card per function group, each card a compact list
// of clickable rows. Scales to many functions without the clutter of a flat
// grid of large cards. Rows get an icon from HUB_ICONS (keyed on href) unless
// `icons` is false (the manual's chapter list has none), and a star that adds
// the function to Favoriter unless `favorites` is false (the manual again).
export function HubSections({
  sections,
  icons = true,
  favorites = true,
}: {
  sections: HubSection[];
  icons?: boolean;
  favorites?: boolean;
}) {
  return (
    <div className={styles.grid}>
      {sections.map((section) => (
        <section key={section.title} className={styles.group} aria-label={section.title}>
          <h2 className={styles.groupTitle}>{section.title}</h2>
          <ul className={styles.list}>
            {section.items.map((item) => {
              // Tillägg pages (/tillagg/<plugin>/<page>) are not in the static table.
              const Icon = icons ? (HUB_ICONS[item.href] ?? (item.href.startsWith("/tillagg/") ? PLUGIN_PAGE_ICON : undefined)) : undefined;
              return (
                <li key={item.href} className={styles.item}>
                  <Link
                    href={item.href}
                    className={[styles.row, Icon && styles.rowWithIcon, favorites && styles.rowWithStar].filter(Boolean).join(" ")}
                  >
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
                  {/* Beside the link, not inside it: a button within <a> is invalid. */}
                  {favorites && <FavoriteStar href={item.href} title={item.title} className={styles.star} />}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
