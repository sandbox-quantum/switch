import z from 'zod';
import { defineVersionedSchema } from '@shared/lib/versioned-schema/versioned-schema';

const DROID_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDroidProviderSessionId(value: string): boolean {
  return DROID_SESSION_ID_PATTERN.test(value);
}

const initialPromptDeliverySchema = z.object({
  /** The command id this attempt owns. Minted once and kept, because the server
   *  treats an id it has answered as immutable. */
  commandId: z.string(),
  /** `pending` recorded before a submission, `submitted` once the server answered,
   *  `unknown` when a submission failed without a definitive answer, `rejected`
   *  when the server refused the id. */
  state: z.enum(['pending', 'submitted', 'unknown', 'rejected']),
  attemptedAt: z.string().optional(),
  epoch: z.string().optional(),
  /** The server's own code and explanation for a `rejected` delivery. */
  code: z.string().optional(),
  message: z.string().optional(),
  /** Why an `unknown` delivery could not be settled. */
  reason: z.string().optional(),
});

export type InitialPromptDelivery = z.infer<typeof initialPromptDeliverySchema>;

const sessionConfigV0Schema = z.object({
  autoApprove: z.boolean().optional(),
  /** Provider-native session id (e.g. Droid UUID) for resuming the correct chat. */
  providerSessionId: z.string().optional(),
  /** Initial prompt to deliver on the first spawn; cleared from config after the session starts. */
  initialPrompt: z.string().optional(),
  /** Delivery state of `initialPrompt`, so a relaunch can tell "never submitted"
   *  from "already delivered" instead of guessing from the launch result. */
  initialPromptDelivery: initialPromptDeliverySchema.optional(),
});

export const sessionConfig = defineVersionedSchema().unversioned(sessionConfigV0Schema).build();

export type SessionConfig = typeof sessionConfig.Type;
