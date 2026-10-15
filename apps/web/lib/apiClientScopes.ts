// Mirror of packages/shared/src/oauth.ts (the web can't import @navet/shared);
// apps/api/test/api-client-scopes.test.ts keeps the two in sync.
export type ApiClientScope = "configurator:read" | "prices:read" | "quotes:create" | "orders:confirm" | "structure:read";

export const API_CLIENT_SCOPES: ApiClientScope[] = [
  "configurator:read",
  "prices:read",
  "quotes:create",
  "orders:confirm",
  "structure:read",
];

export const API_CLIENT_SCOPE_LABELS: Record<ApiClientScope, string> = {
  "configurator:read": "Läsa konfiguratorn",
  "prices:read": "Läsa priser",
  "quotes:create": "Skapa offert",
  "orders:confirm": "Bekräfta order",
  "structure:read": "Läsa struktur",
};

export const API_CLIENT_PRESETS: { key: string; label: string; scopes: ApiClientScope[]; needsCustomer: boolean }[] = [
  { key: "hemsida", label: "Hemsida", scopes: ["configurator:read", "quotes:create"], needsCustomer: true },
  {
    key: "aterforsaljare",
    label: "Återförsäljare",
    scopes: ["configurator:read", "prices:read", "quotes:create", "orders:confirm"],
    needsCustomer: true,
  },
  { key: "intern", label: "Intern", scopes: [...API_CLIENT_SCOPES], needsCustomer: false },
];
