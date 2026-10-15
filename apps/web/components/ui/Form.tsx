import type { FormHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import styles from "./Form.module.css";

function cx(...classes: (string | false | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

// <form> with the shared field stack.
export function Form({ className, ...rest }: FormHTMLAttributes<HTMLFormElement>) {
  return <form className={cx(styles.stack, className)} {...rest} />;
}

// The same stack without a <form> — for read-only panels and button groups
// that share the forms' rhythm but submit nothing.
export function FormStack({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx(styles.stack, className)} {...rest} />;
}

// Side-by-side fields. Collapses to a single column on phones. "postal" is
// the Postnummer | Postort | Land row: the two short fields get exactly their
// sized width (sm/xs in Field.module.css) and Postort takes the rest, instead
// of three equal columns that squeeze the city name next to a two-letter code.
export function FormRow({
  columns = 2,
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { columns?: 2 | 3 | 4 | "postal" }) {
  return (
    <div
      className={cx(
        styles.row,
        columns === 3 && styles.row3,
        columns === 4 && styles.row4,
        columns === "postal" && styles.rowPostal,
        className
      )}
      {...rest}
    />
  );
}

// One repeated document line: the article picker on its own line, the numeric
// fields in a FormRow underneath. Consecutive lines get a divider.
export function FormLineRow({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx(styles.lineRow, className)} {...rest} />;
}

// The article-picker line itself — a wide first cell and an auto-width second
// one for the remove button.
export function FormLineRowTop({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx(styles.lineRowTop, className)} {...rest} />;
}

// The button row at the bottom of a form.
export function FormActions({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx(styles.actions, className)} {...rest} />;
}

// Renders nothing when there is no error, so call sites don't need to guard.
// `margin` spaces errors that stand alone in the page flow; `inline` renders a
// <span> for errors that sit inside inline content, such as a table cell.
export function FormError({
  children,
  margin,
  inline,
}: {
  children: ReactNode;
  margin?: "above" | "below";
  inline?: boolean;
}) {
  if (!children) return null;
  const className = cx(
    styles.error,
    inline && styles.errorInline,
    margin === "above" && styles.errorAbove,
    margin === "below" && styles.errorBelow
  );
  if (inline) return <span className={className}>{children}</span>;
  return <div className={className}>{children}</div>;
}

// Amber sibling of FormError — a warning the user must read, not a failure.
export function FormNotice({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx(styles.notice, className)} {...rest} />;
}

// Small muted explanation. `attached` pulls it up under the field it explains.
export function FormHint({
  attached,
  className,
  ...rest
}: HTMLAttributes<HTMLParagraphElement> & { attached?: boolean }) {
  return <p className={cx(styles.hint, attached && styles.hintAttached, className)} {...rest} />;
}

// "Sparat" confirmation next to a save button.
export function FormSaved({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cx(styles.saved, className)} {...rest} />;
}
