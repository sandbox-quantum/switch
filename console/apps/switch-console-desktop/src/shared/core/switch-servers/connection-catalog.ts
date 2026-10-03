import { z } from 'zod';

export const connectionCatalogEntrySchema = z.object({
  slug: z.string(),
  name: z.string(),
  category: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  auth_type: z.enum(['oauth', 'api_key']),
  status: z.enum(['connected', 'not_connected', 'coming_soon']),
});
export type ConnectionCatalogEntry = z.infer<typeof connectionCatalogEntrySchema>;
export const connectionCatalogSchema = z.object({
  connections: z.array(connectionCatalogEntrySchema),
});
