import { z } from 'zod';

/**
 * Where Switch Console's listener takes a service sign-in's code back, as Core
 * registers it with the vendor (`connections/oauth_clients.py`).
 */
export const SERVICE_CALLBACK_PATH = '/switch-services/callback';

/** `POST /service-connections/{service}/flows`: where the browser goes, and how it returns. */
export const serviceFlowStartSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  url: z.string(),
  mode: z.enum(['loopback', 'core']),
});
export type ServiceFlowStart = z.infer<typeof serviceFlowStartSchema>;

/** `GET /service-connections/{service}/flows/{id}`. */
export const serviceFlowSchema = z.object({
  status: z.enum(['pending', 'checking', 'ready', 'failed']),
  /** The connected account as people recognise it, once read. */
  account: z.string().nullable(),
  error: z.string().nullable(),
});
export type ServiceFlow = z.infer<typeof serviceFlowSchema>;
