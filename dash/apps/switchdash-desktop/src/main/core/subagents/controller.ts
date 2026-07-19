import type {
  SubagentAttributes,
  SubagentDefinition,
  SubagentField,
} from '@switchdash/core/agents/plugins';
import { createPluginFs } from '@main/core/providers/plugin-fs';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { createSubagent, type CreateSubagentParams } from './create-subagent';
import { deleteSubagent, type DeleteSubagentParams } from './delete-subagent';
import { editSubagent, type EditSubagentParams } from './edit-subagent';
import { listSubagents } from './list-subagents';
import {
  registerSubagents,
  registerSubagentsRemote,
  type RegisterSubagentsParams,
  type RegisterSubagentsRemoteParams,
} from './register-subagents';
import { openRemoteSubagentFs, resolveSubagentFs } from './resolve-subagent-fs';
import {
  getSubagentAutoSession,
  setSubagentAutoSession,
  type SubagentAutoSessionParams,
} from './setSubagentAutoSession';

/** Discover the subagent definitions a provider can onboard from `dir`. */
function listDefinitions(params: {
  dir: string;
  providerId: string;
}): Promise<SubagentDefinition[]> {
  const subagents = getPlugin(params.providerId).behavior.subagents;
  if (!subagents) return Promise.resolve([]);
  return subagents.discoverDefinitions(createPluginFs(params.dir));
}

/** Discover the subagent definitions a provider can onboard from a remote agent's
 * working dir over SSH — the onboarding counterpart of `listDefinitions` for
 * agents that run on an SSH host and have no local directory. */
async function listRemoteDefinitions(params: {
  sshHost: string;
  remoteRepoDir: string;
  providerId: string;
}): Promise<SubagentDefinition[]> {
  const subagents = getPlugin(params.providerId).behavior.subagents;
  if (!subagents) return [];
  const remote = await openRemoteSubagentFs(params.sshHost, params.remoteRepoDir);
  try {
    return await subagents.discoverDefinitions(remote.fs);
  } finally {
    remote.close();
  }
}

/** The attribute fields a provider's subagents support (drives the form). Empty
 * for providers without subagents. */
function attributeFields(providerId: string): Promise<SubagentField[]> {
  const subagents = getPlugin(providerId).behavior.subagents;
  return Promise.resolve(subagents ? subagents.attributeFields() : []);
}

/** The current attribute values of an existing subagent definition, for edit
 * prefill. Resolves the parent's working directory (local or remote) from the
 * agent. Null when the provider has no subagents or the definition is gone. */
async function readDefinition(params: {
  parentAgentId: string;
  name: string;
}): Promise<SubagentAttributes | null> {
  const ctx = await resolveSubagentFs(params.parentAgentId);
  try {
    const subagents = getPlugin(ctx.agent.providerId).behavior.subagents;
    if (!subagents) return null;
    return await subagents.readDefinition(ctx.fs, params.name);
  } finally {
    ctx.close();
  }
}

export const subagentsController = createRPCController({
  list: (parentAgentId: string) => listSubagents(parentAgentId),
  listDefinitions,
  listRemoteDefinitions,
  attributeFields: (providerId: string) => attributeFields(providerId),
  readDefinition,
  register: (params: RegisterSubagentsParams) => registerSubagents(params),
  registerRemote: (params: RegisterSubagentsRemoteParams) => registerSubagentsRemote(params),
  create: (params: CreateSubagentParams) => createSubagent(params),
  edit: (params: EditSubagentParams) => editSubagent(params),
  delete: (params: DeleteSubagentParams) => deleteSubagent(params),
  getAutoSession: (params: { parentAgentId: string; name: string }) =>
    getSubagentAutoSession(params),
  setAutoSession: (params: SubagentAutoSessionParams) => setSubagentAutoSession(params),
});
