import { z } from "zod";

export const issueTokenSchema = z.object({
  clientId: z.string().uuid(),
  clientSecret: z.string().min(1),
});
export type IssueTokenInput = z.infer<typeof issueTokenSchema>;

export const createApiClientSchema = z.object({
  name: z.string().min(1).max(255),
});
export type CreateApiClientInput = z.infer<typeof createApiClientSchema>;
