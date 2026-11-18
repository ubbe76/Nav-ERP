// The sidebar's modules in its order, each with its hub page and sections
// from lib/moduleNav.ts — read by the palette (lib/commandPalette.ts) and
// Översikten's Favoriter card (lib/favoriteGroups.ts), so neither keeps its
// own copy. Its own file: hub-icons.test.ts and module-nav-routes.test.ts
// read moduleNav.ts as text and take every `href` there for a hub row.
import {
  ARTIKLAR_SECTIONS,
  EKONOMI_SECTIONS,
  FORSALJNING_SECTIONS,
  INKOP_SECTIONS,
  KVALITET_SECTIONS,
  LAGER_SECTIONS,
  PERSONAL_SECTIONS,
  RAPPORTER_SECTIONS,
  SYSTEM_SECTIONS,
  TILLVERKNING_SECTIONS,
  type ModuleNavSection,
} from "./moduleNav";

export const NAV_MODULES: readonly { title: string; href: string; sections: ModuleNavSection[] }[] = [
  { title: "Artiklar", href: "/artiklar", sections: ARTIKLAR_SECTIONS },
  { title: "Inköp", href: "/inkop", sections: INKOP_SECTIONS },
  { title: "Försäljning", href: "/forsaljning", sections: FORSALJNING_SECTIONS },
  { title: "Tillverkning", href: "/tillverkning", sections: TILLVERKNING_SECTIONS },
  { title: "Lager", href: "/lager", sections: LAGER_SECTIONS },
  { title: "Personal & lön", href: "/personal", sections: PERSONAL_SECTIONS },
  { title: "Kvalitet", href: "/kvalitet", sections: KVALITET_SECTIONS },
  { title: "Ekonomi", href: "/ekonomi", sections: EKONOMI_SECTIONS },
  { title: "Rapporter", href: "/rapporter", sections: RAPPORTER_SECTIONS },
  { title: "System", href: "/system", sections: SYSTEM_SECTIONS },
];
