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
});

export const sessionConfig = defineVersionedSchema().unversioned(sessionConfigV0Schema).build();

export type SessionConfig = typeof sessionConfig.Type;
