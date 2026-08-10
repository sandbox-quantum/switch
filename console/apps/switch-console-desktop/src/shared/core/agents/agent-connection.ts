import z from 'zod';
import { defineVersionedSchema } from '@shared/lib/versioned-schema/versioned-schema';

/**
 * Where an agent's sessions run. `local` (the default) runs every session in
 * the location directory on this machine, exactly as Switch Console always has.
 * `remote` runs them on an SSH-reachable host, so the agent keeps working and
 * listening to its Switch rooms while Switch Console is closed (CHOO-1059).
 */
export type AgentConnectionKind = 'local' | 'remote';

const agentRemoteConfigV0Schema = z.object({
  /**
   * The `~/.ssh/config` Host alias to connect through. Auth (user, port,
   * identity file, jump host) is resolved from the user's SSH config, matching
   * Switch Console's remote stack — Switch Console does not store credentials itself.
   */
  sshHost: z.string().min(1),
  /** Absolute path to the agent's repo / working directory on the remote host. */
  remoteRepoDir: z.string().min(1),
});

export const agentRemoteConfig = defineVersionedSchema()
  .unversioned(agentRemoteConfigV0Schema)
  .build();

export type AgentRemoteConfig = typeof agentRemoteConfig.Type;
