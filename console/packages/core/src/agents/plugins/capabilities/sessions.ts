import z from 'zod';
import { definePluginCapability } from '../../../lib/plugins/capability';
import type { RepoAgentField } from './repo-agents';

export type ISessionsBehavior = {
  /** Per-agent defaults passed directly to the SDK when starting a session. */
  configFields?(): RepoAgentField[];
  /** Return true when a stored provider session id looks valid and should be used for resume. */
  validateSessionId?(id: string): boolean;
};

export const sessionsCapability = definePluginCapability<ISessionsBehavior>()(
  'sessions',
  z.object({
    kind: z.enum(['resumable', 'stateless']),
  })
);
