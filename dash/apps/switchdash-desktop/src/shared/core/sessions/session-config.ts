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
   * When set, this session runs as the repository-defined agent of this name: the
   * provider launches its CLI to run as that agent (Claude Code → `--agent <name>`)
   * with the agent's own Switch credentials, so it joins rooms under that identity.
   * The value is the agent's definition name (its `.switch/agents/<name>.json`
   * credentials key). switchdash has no "subagent" concept — how the provider runs
   * a named agent is the provider's business (CHOO-1440).
   */
  agentName: z.string().optional(),
  /** Legacy key for {@link agentName}, kept so sessions persisted before the
   * rename still resolve their identity after an upgrade; coalesced into
   * `agentName` when read (CHOO-1440). */
  subagentName: z.string().optional(),
});

export const sessionConfig = defineVersionedSchema().unversioned(sessionConfigV0Schema).build();

export type SessionConfig = typeof sessionConfig.Type;
