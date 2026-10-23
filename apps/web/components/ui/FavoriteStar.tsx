"use client";

import { Star } from "lucide-react";
import { useFavorites } from "../FavoritesProvider";

// The star on a module hub row (HubSections): one click adds the function to
// Favoriter under the row's own title, the next removes it. Hidden when the
// list couldn't be read (no FavoritesProvider, or the read failed).
export function FavoriteStar({ href, title, className }: { href: string; title: string; className?: string }) {
  const { favorites, has, add, remove } = useFavorites();
  if (favorites === null) return null;
  const active = has(href);
  const label = active ? `Ta bort ${title} ur favoriter` : `Lägg till ${title} i favoriter`;
  return (
    <button
      type="button"
      className={className}
      aria-pressed={active}
      aria-label={label}
      title={label}
      onClick={() => void (active ? remove(href) : add({ href, title }))}
    >
      <Star size={16} strokeWidth={1.75} fill={active ? "currentColor" : "none"} aria-hidden="true" />
    </button>
  );
}
