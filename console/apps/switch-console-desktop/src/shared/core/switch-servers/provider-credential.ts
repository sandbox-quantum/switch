import { z } from 'zod';
export const cloudProviderConnectionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_connected') }),
  z.object({
    status: z.enum(['verifying', 'failed']),
    kind: z.enum(['api-key', 'setup-token', 'auth-json']),
    verification_id: z.string(),
    verified_at: z.string(),
    error: z.string().nullable(),
  }),
  z.object({
    status: z.enum(['connected', 'configured']),
    kind: z.enum(['api-key', 'setup-token', 'auth-json']),
    verified_at: z.string(),
  }),
]);
export type CloudProviderConnection = z.infer<typeof cloudProviderConnectionSchema>;
