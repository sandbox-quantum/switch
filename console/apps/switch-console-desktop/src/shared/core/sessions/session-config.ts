import z from 'zod';
import { defineVersionedSchema } from '@shared/lib/versioned-schema/versioned-schema';

const DROID_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDroidProviderSessionId(value: string): boolean {
  return DROID_SESSION_ID_PATTERN.test(value);
}

const sessionConfigV0Schema = z.object({
  autoApprove: z.boolean().optional(),
  /** Provider-native session id (e.g. Droid UUID) for resuming the correct chat. */
  providerSessionId: z.string().optional(),
  /** Initial prompt to deliver on the first spawn; cleared from config after the session starts. */
  initialPrompt: z.string().optional(),
  /**
   * How this session drives its agent, copied from the agent's config when the
   * session was created. A copy rather than a live read: the runtime is chosen
   * once, at spawn, and a session already running through a provider adapter
   * cannot become a PTY session because someone flipped the agent's toggle.
   * Absent means `pty`.
   */
  runtime: z.enum(['pty', 'provider']).optional(),
});

export const sessionConfig = defineVersionedSchema().unversioned(sessionConfigV0Schema).build();

export type SessionConfig = typeof sessionConfig.Type;
