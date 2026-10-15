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
  return <button className={classes} {...props} />;
}
