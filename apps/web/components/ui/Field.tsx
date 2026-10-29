import type { ComponentPropsWithRef, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes, ReactNode } from "react";
import styles from "./Field.module.css";

// Content-narrow sizing for short/numeric fields — see CLAUDE.md's numeric
// field conventions. `undefined` keeps the historical width: 100%.
export type FieldSize = "xs" | "sm" | "md";

const sizeClass: Record<FieldSize, string | undefined> = {
  xs: styles.sizeXs,
  sm: styles.sizeSm,
  md: styles.sizeMd,
};

function withSize(base: string | undefined, size: FieldSize | undefined, className: string | undefined) {
  return [base, size ? sizeClass[size] : "", className].filter(Boolean).join(" ");
}

export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label className={styles.label} htmlFor={htmlFor}>
      {children}
    </label>
  );
}

// Ref-capable (React 19 passes `ref` as a prop) so ScanInput can refocus the field.
type InputProps = Omit<ComponentPropsWithRef<"input">, "size"> & { size?: FieldSize };

export function Input({ size, className, ...props }: InputProps) {
  return <input className={withSize(styles.input, size, className)} {...props} />;
}

// Multi-line text with the same chrome as Input. Address fields must be
// textareas: a plain <input> silently strips the newlines that Monitor-
// imported addresses (Adressrad 1–3 joined with \n) carry, so saving a
// card would concatenate the rows into one.
export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={withSize(styles.input, undefined, className)} style={{ resize: "vertical" }} {...props} />;
}

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & { size?: FieldSize };

export function Select({ children, size, className, ...props }: SelectProps) {
  return (
    <div className={withSize(styles.selectWrap, size, className)}>
      <select className={styles.select} {...props}>
        {children}
      </select>
      <span className={styles.chevron}>▾</span>
    </div>
  );
}

// ComponentPropsWithRef rather than InputHTMLAttributes so callers can reach
// the node — SelectAllCheckbox needs a ref to set `indeterminate`, which has
// no JSX attribute. React 19 passes `ref` straight through as a prop.
export function Checkbox(props: ComponentPropsWithRef<"input">) {
  return <input type="checkbox" className={styles.checkbox} {...props} />;
}

export function Toggle({ checked, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={styles.toggle}>
      <input type="checkbox" checked={checked} {...props} />
      <span className={styles.track} data-checked={checked} />
    </label>
  );
}

export function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className={styles.field}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}
