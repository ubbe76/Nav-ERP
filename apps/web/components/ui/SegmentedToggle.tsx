"use client";

import styles from "./SegmentedToggle.module.css";

export interface SegmentedToggleOption<V extends string> {
  value: V;
  label: string;
  disabled?: boolean;
  /** Tooltip — used to explain WHY an option is disabled. */
  title?: string;
}

interface SegmentedToggleProps<V extends string> {
  value: V;
  options: SegmentedToggleOption<V>[];
  onChange: (value: V) => void;
  /** "small" fits inside a table row; "medium" (default) matches an input. */
  size?: "small" | "medium";
  /** Disables every option — e.g. while a save is pending. */
  disabled?: boolean;
  ariaLabel?: string;
}

// The segmented-button control first built for the operation dialog's
// min/st | st/h switch (and ThemeToggle before it). One control, two sizes:
// the dialog keeps the medium size, the beredning list uses the small one
// per row. Clicking the active option is a no-op — the caller never sees a
// change event for the value it already has.
export function SegmentedToggle<V extends string>({
  value,
  options,
  onChange,
  size = "medium",
  disabled = false,
  ariaLabel,
}: SegmentedToggleProps<V>) {
  return (
    <div className={`${styles.segmented} ${size === "small" ? styles.small : ""}`} role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          data-active={option.value === value}
          disabled={disabled || option.disabled}
          title={option.title}
          aria-pressed={option.value === value}
          onClick={() => {
            if (option.value !== value) onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
