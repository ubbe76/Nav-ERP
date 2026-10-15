import { z } from "zod";

// Contacts on customers and suppliers (kontakter på kund-/leverantörskortet).
// At most one contact per partner is the primary contact (huvudkontakt).
export const createContactSchema = z.object({
  name: z.string().min(1).max(255),
  phone: z.string().max(50).optional(),
  mobile: z.string().max(50).optional(),
  email: z.string().email().optional(),
  comment: z.string().optional(),
  isPrimary: z.boolean().default(false),
});
export type CreateContactInput = z.infer<typeof createContactSchema>;

export const updateContactSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    phone: z.string().max(50).nullable().optional(),
    mobile: z.string().max(50).nullable().optional(),
    email: z.string().email().nullable().optional(),
    comment: z.string().nullable().optional(),
    isPrimary: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateContactInput = z.infer<typeof updateContactSchema>;
