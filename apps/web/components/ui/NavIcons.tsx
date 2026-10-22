import type { ReactNode } from "react";

// Stroke icons for the sidebar nav, drawn inline (no icon dependency) in the
// same 24px grid so they read as one set at 18px render size.
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function HomeIcon() {
  return (
    <Icon>
      <path d="m3 11 9-7.5L21 11" />
      <path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" />
    </Icon>
  );
}

export function BellIcon() {
  return (
    <Icon>
      <path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </Icon>
  );
}

export function CubeIcon() {
  return (
    <Icon>
      <path d="M12 2.5 3.5 7v10l8.5 4.5 8.5-4.5V7L12 2.5z" />
      <path d="M3.5 7 12 11.5 20.5 7" />
      <path d="M12 11.5v10" />
    </Icon>
  );
}

export function CartIcon() {
  return (
    <Icon>
      <circle cx="9.5" cy="20" r="1.4" />
      <circle cx="17" cy="20" r="1.4" />
      <path d="M3 4h2.2l2.3 11.5h10.3L20.5 7H6.1" />
    </Icon>
  );
}

export function TrendingUpIcon() {
  return (
    <Icon>
      <path d="m3 17 6-6 4 4 8-8.5" />
      <path d="M15.5 6.5H21V12" />
    </Icon>
  );
}

export function FactoryIcon() {
  return (
    <Icon>
      <path d="M3.5 21V10.5L9 14v-3.5l5.5 3.5V4h6v17" />
      <path d="M2.5 21h19" />
    </Icon>
  );
}

export function UsersIcon() {
  return (
    <Icon>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" />
      <path d="M16 5.2a3.1 3.1 0 0 1 0 5.6" />
      <path d="M17.5 14.6c2 .6 3.5 2.3 3.5 5.4" />
    </Icon>
  );
}

export function CalendarIcon() {
  return (
    <Icon>
      <rect x="4" y="5.5" width="16" height="15" rx="1.8" />
      <path d="M4 10.5h16" />
      <path d="M8.5 3.5v3.5" />
      <path d="M15.5 3.5v3.5" />
    </Icon>
  );
}

export function LayersIcon() {
  return (
    <Icon>
      <path d="M12 3.5 3 8.5l9 5 9-5-9-5z" />
      <path d="m3 13.5 9 5 9-5" />
    </Icon>
  );
}

// Ledger/kontobok — a ruled book for the Ekonomi section (kontoplan,
// verifikat, huvudbok), same spine+rule-lines idea as a physical grundbok.
export function LedgerIcon() {
  return (
    <Icon>
      <rect x="4.5" y="3.5" width="15" height="17" rx="1.5" />
      <path d="M8 3.5v17" />
      <path d="M11.5 8h4" />
      <path d="M11.5 12h4" />
      <path d="M11.5 16h4" />
    </Icon>
  );
}

export function BarChartIcon() {
  return (
    <Icon>
      <path d="M3.5 20.5h17" />
      <path d="M7 20.5v-6" />
      <path d="M12 20.5v-12" />
      <path d="M17 20.5v-9" />
    </Icon>
  );
}

export function MonitorIcon() {
  return (
    <Icon>
      <rect x="3" y="4.5" width="18" height="12.5" rx="1.5" />
      <path d="M12 17v3.5" />
      <path d="M8.5 20.5h7" />
    </Icon>
  );
}

export function ChevronLeftIcon() {
  return (
    <Icon>
      <path d="m14.5 6.5-5.5 5.5 5.5 5.5" />
    </Icon>
  );
}

export function ChevronRightIcon() {
  return (
    <Icon>
      <path d="m9.5 6.5 5.5 5.5-5.5 5.5" />
    </Icon>
  );
}

export function ChevronDownIcon() {
  return (
    <Icon>
      <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />
    </Icon>
  );
}

export function HelpIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.2a2.4 2.4 0 0 1 4.66.8c0 1.6-2.26 2-2.26 3.2" />
      <path d="M12 16.8h.01" />
    </Icon>
  );
}
