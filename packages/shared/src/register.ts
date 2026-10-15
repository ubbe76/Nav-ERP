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

// DELETE /<register>/:id — the replacement (another entry of the same
// register) that every referencing row is moved to first. Optional: an
// entry nothing points at is deleted outright; a referenced one without a
// replacement is refused with 409 + usage.
export const deleteRegisterEntrySchema = z.object({
  replacementId: z.string().uuid().nullable().optional(),
});
export type DeleteRegisterEntryInput = z.infer<typeof deleteRegisterEntrySchema>;
