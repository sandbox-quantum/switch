import { z } from 'zod';

export const openCodeConsoleCredentialSchema = z.object({
  format: z.literal('switch-opencode-console-v1'),
  account: z.object({
    id: z.string().min(1),
    email: z.string().min(1),
    url: z
      .string()
      .url()
      .refine((value) => new URL(value).protocol === 'https:'),
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    token_expiry: z.number().nullable(),
    time_created: z.number(),
    time_updated: z.number(),
  }),
  organization: z.string().min(1),
});
