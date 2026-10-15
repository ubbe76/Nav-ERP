import { z } from "zod";

export const issueTokenSchema = z.object({
  clientId: z.string().uuid(),
  clientSecret: z.string().min(1),
});
export type IssueTokenInput = z.infer<typeof issueTokenSchema>;

// Behörigheter per OAuth-klient (alfaplanen 4.9). A client reaches only the
// routes whose config.clientScope is in its list; the list is read from the
// database on every request, so a change applies to tokens already issued.
export const API_CLIENT_SCOPES = [
  "configurator:read",
  "prices:read",
  "quotes:create",
  "orders:confirm",
  "structure:read",
] as const;
export type ApiClientScope = (typeof API_CLIENT_SCOPES)[number];
export const apiClientScopeSchema = z.enum(API_CLIENT_SCOPES);

export const API_CLIENT_SCOPE_LABELS: Record<ApiClientScope, string> = {
  "configurator:read": "Läsa konfiguratorn",
  "prices:read": "Läsa priser",
  "quotes:create": "Skapa offert",
  "orders:confirm": "Bekräfta order",
  "structure:read": "Läsa struktur",
};

// Web help only — the server stores scopes and customer, never a preset name.
export const API_CLIENT_PRESETS: {
  key: "hemsida" | "aterforsaljare" | "intern";
  label: string;
  scopes: ApiClientScope[];
  needsCustomer: boolean;
}[] = [
  { key: "hemsida", label: "Hemsida", scopes: ["configurator:read", "quotes:create"], needsCustomer: true },
  {
    key: "aterforsaljare",
    label: "Återförsäljare",
    scopes: ["configurator:read", "prices:read", "quotes:create", "orders:confirm"],
    needsCustomer: true,
  },
  { key: "intern", label: "Intern", scopes: [...API_CLIENT_SCOPES], needsCustomer: false },
];

const scopeListSchema = z.array(apiClientScopeSchema).min(1).transform((list) => [...new Set(list)]);

export const createApiClientSchema = z.object({
  name: z.string().min(1).max(255),
  scopes: scopeListSchema,
  customerId: z.string().uuid().nullable().optional(),
});
export type CreateApiClientInput = z.infer<typeof createApiClientSchema>;

export const updateApiClientSchema = z
  .object({
    scopes: scopeListSchema.optional(),
    customerId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((v) => v.scopes !== undefined || v.customerId !== undefined, { message: "Nothing to update" });
export type UpdateApiClientInput = z.infer<typeof updateApiClientSchema>;
