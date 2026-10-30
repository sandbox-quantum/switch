import { z } from 'zod';

/**
 * Where Switch Console's listener takes a service sign-in's code back, as Core
 * registers it with the vendor (`connections/oauth_clients.py`).
 */
export const SERVICE_CALLBACK_PATH = '/switch-services/callback';

/**
 * `POST /service-connections/{service}/flows`: where the browser goes, how it
 * returns, and, in `core` mode, the server's callback the vendor sends it back
 * to (null from a server that predates saying so).
 */
export const serviceFlowStartSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  url: z.string(),
  mode: z.enum(['loopback', 'core']),
  callback_url: z.string().nullable().default(null),
});
export type ServiceFlowStart = z.infer<typeof serviceFlowStartSchema>;

/**
 * A sign-in this Console started: its flow, and the server's callback the
 * vendor sends the browser back to where it returns through the server, which
 * the vendor may refuse until its admin allow-lists it; null where it returns
 * straight to this Console.
 */
export type ServiceSignInStarted = { id: string; callbackUrl: string | null };

/**
 * `GET /service-connections/{service}/flows/{id}`: `connected` once the server
 * has exchanged the code and kept the connection; `failed` with the reason.
 */
export const serviceFlowSchema = z.object({
  status: z.enum(['pending', 'checking', 'connected', 'failed']),
  /** The connected account as people recognise it, once read. */
  account: z.string().nullable(),
  error: z.string().nullable(),
  /** What the server said as it connected, once each. */
  warning: z.string().nullable(),
});
export type ServiceFlow = z.infer<typeof serviceFlowSchema>;

/** `PUT /service-connections/{service}/key`: the key Switch checked and kept, and whose it is. */
export const serviceKeyConnectedSchema = z.object({
  warning: z.string().nullable(),
  external_identity: z.string(),
});
export type ServiceKeyConnected = z.infer<typeof serviceKeyConnectedSchema>;
