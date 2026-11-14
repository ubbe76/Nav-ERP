import { z } from "zod";

// Shared shape for the small base-data registers (leveransvillkor,
// betalningsvillkor, speditörer): code + name, both unique per register,
// plus an optional description (surfaced in the UI only where it carries
// meaning — delivery terms' Combiterms explanations today).
export const createRegisterEntrySchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(300).nullable().optional(),
});
export type CreateRegisterEntryInput = z.infer<typeof createRegisterEntrySchema>;

export const updateRegisterEntrySchema = createRegisterEntrySchema;
export type UpdateRegisterEntryInput = z.infer<typeof updateRegisterEntrySchema>;

// Dokument på engelska (#7): a blank English text is stored as null and the
// document falls back to the Swedish one (localized in document-language.ts).
export const optionalEnglishText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    z.string().trim().max(max).nullable()
  );

// Leveransvillkor and betalningsvillkor: Benämning (engelska) — printed on
// English documents instead of `name`. Not unique (the Swedish name is).
export const termRegisterEntrySchema = createRegisterEntrySchema.extend({
  nameEn: optionalEnglishText(100).optional(),
});
export type TermRegisterEntryInput = z.infer<typeof termRegisterEntrySchema>;

// Enheter: Kod (engelska) — the unit as written on English documents (the
// unit is printed as its code); null = the code is used (kg, m, l …).
export const unitRegisterEntrySchema = createRegisterEntrySchema.extend({
  codeEn: optionalEnglishText(20).optional(),
});
export type UnitRegisterEntryInput = z.infer<typeof unitRegisterEntrySchema>;

// DELETE /<register>/:id — the replacement (another entry of the same
// register) that every referencing row is moved to first. Optional: an
// entry nothing points at is deleted outright; a referenced one without a
// replacement is refused with 409 + usage.
export const deleteRegisterEntrySchema = z.object({
  replacementId: z.string().uuid().nullable().optional(),
});
export type DeleteRegisterEntryInput = z.infer<typeof deleteRegisterEntrySchema>;

// Förlustorsaker (quote_loss_reasons): code = upper-case letters and digits
// (lower case is upper-cased on input), max 10; name; active. No description
// — the register is narrower than the terms registers. PATCH sends the whole
// shape, like the other registers.
export const quoteLossReasonInputSchema = z.object({
  code: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{1,10}$/, "Koden får bara innehålla versaler och siffror, högst 10 tecken")),
  name: z.string().trim().min(1).max(100),
  active: z.boolean().default(true),
});
export type QuoteLossReasonInput = z.infer<typeof quoteLossReasonInputSchema>;
