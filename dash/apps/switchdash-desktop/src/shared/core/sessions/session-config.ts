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
   * When set, this session runs as a Claude Code subagent of its (parent) agent:
   * the CLI is launched with `--agent <subagentName>` and the subagent's own
   * Switch credentials file, so it participates in rooms under the subagent's
   * identity. The value is the bare subagent name (the `.claude/agents/<name>.md`
   * file stem), which also names its `.claude/switch-subagents/<name>.settings.json`.
   */
  subagentName: z.string().optional(),
});

export const sessionConfig = defineVersionedSchema().unversioned(sessionConfigV0Schema).build();

export type SessionConfig = typeof sessionConfig.Type;
