import type { HTMLAttributes } from "react";
import styles from "./Card.module.css";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  // Form cards are 520px unless the content needs another width; "none"
  // drops the cap for cards that should fill their column.
  maxWidth?: number | "none";
}

// Kort — the shared panel surface. Pass `className` to add spacing or other
// layout that belongs to the specific card, not to every card.
export function Card({ maxWidth = 520, className, style, ...rest }: CardProps) {
  return (
    <div
      className={[styles.card, className].filter(Boolean).join(" ")}
      style={maxWidth === "none" ? style : { maxWidth, ...style }}
      {...rest}
    />
  );
}
