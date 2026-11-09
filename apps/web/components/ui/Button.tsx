import type { ButtonHTMLAttributes } from "react";
import styles from "./Button.module.css";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "default" | "small";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export function Button({ variant = "primary", size = "default", className, ...props }: ButtonProps) {
  const classes = [styles.button, styles[variant], size === "small" ? styles.small : "", className]
    .filter(Boolean)
    .join(" ");
  // data-variant: the document toolbar keeps the primary action in view and
  // marks a danger action in its ⋯ menu (documents/DocumentActionBar.tsx).
  return <button className={classes} data-variant={variant} {...props} />;
}
