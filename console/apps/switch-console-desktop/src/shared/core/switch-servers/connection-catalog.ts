import { z } from 'zod';

export const connectionCatalogEntrySchema = z.object({
  slug: z.string(),
  name: z.string(),
  category: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  auth_type: z.enum(['oauth', 'api_key']),
  /** Whether it can be connected on this server: there is something to connect it to. */
  connectable: z.boolean(),
  status: z.enum(['connected', 'not_connected', 'needs_reauthorization', 'error', 'coming_soon']),
  /** Why the service cannot be granted to agents on this server; null when it can. */
  unavailable_reason: z.string().nullable(),
});
export type ConnectionCatalogEntry = z.infer<typeof connectionCatalogEntrySchema>;

/** `GET /provider-connections/catalog`, which servers before service connections answer. */
export const connectionCatalogSchema = z.object({
  connections: z.array(
    connectionCatalogEntrySchema
      .omit({ status: true, connectable: true, unavailable_reason: true })
      .extend({ status: z.enum(['connected', 'not_connected', 'coming_soon']) })
  ),
});

/** `GET /service-connections`: every catalog service, with the person's connection to it. */
export const serviceConnectionsSchema = z.object({
  connections: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      category: z.string(),
      description: z.string(),
      enabled: z.boolean(),
      auth_type: z.enum(['oauth', 'api_key']),
      connectable: z.boolean(),
      configured: z.boolean(),
      unavailable_reason: z.string().nullable(),
      status: z.enum(['not_connected', 'active', 'needs_reauthorization', 'error']),
    })
  ),
});
