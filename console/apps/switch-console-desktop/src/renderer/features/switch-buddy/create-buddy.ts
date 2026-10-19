import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { rpc } from '@renderer/lib/ipc';
import { BUDDY_TEMPLATE_ID, buddyAgentName, isBuddy } from './buddy-identity';
import { reportBuddyStep } from './buddy-telemetry';

/** How many names to try when someone else in the workspace already has the one picked. */
const NAME_ATTEMPTS = 5;

export class BuddyNotCreated extends Error {}

/**
 * Creates the person's buddy on this computer with `provider`, from the
 * template the server ships, and opens a private chat with it.
 *
 * The person's own agents are known, so a name of theirs is never picked;
 * someone else's buddy may hold the name, which the server refuses as taken,
 * and the next number is tried.
 */
export async function createBuddy(input: {
  serverId: string;
  workspaceId: string;
  machineId: string;
  provider: string;
  person: { name: string | null; email: string | null };
}): Promise<{ agentId: string; name: string }> {
  try {
    const created = await createBuddyAgent(input);
    reportBuddyStep('created', input.provider);
    return created;
  } catch (error) {
    reportBuddyStep('create_failed', input.provider);
    throw error;
  }
}

async function createBuddyAgent(input: {
  serverId: string;
  workspaceId: string;
  machineId: string;
  provider: string;
  person: { name: string | null; email: string | null };
}): Promise<{ agentId: string; name: string }> {
  const existing = (await rpc.managedAgents.list(input.serverId)) ?? [];
  const mine = existing.find(isBuddy);
  if (mine) return { agentId: mine.agentId, name: mine.name };
  const template = await rpc.workspaces.getTemplateDetail({
    workspaceId: input.workspaceId,
    templateId: BUDDY_TEMPLATE_ID,
  });
  const taken = new Set(existing.map((agent) => agent.name));
  for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt++) {
    const name = buddyAgentName(input.person, taken);
    const result = await rpc.workspaces.runTemplateDocument(input.workspaceId, {
      template: template.definition,
      inputs: { agent_name: name, provider: input.provider, machine: input.machineId },
      filled: {},
      templateName: template.name,
    });
    if (result.kind === 'created') {
      const created = result.createdAgents[0];
      if (!created) throw new BuddyNotCreated('The server created no agent for switch-buddy.');
      return { agentId: created.agentId, name: created.name };
    }
    if (result.problems.some((problem) => problem.code === 'name_taken')) {
      taken.add(name);
      continue;
    }
    throw new BuddyNotCreated(
      result.problems.map((problem) => problem.message).join(' ') || result.message
    );
  }
  throw new BuddyNotCreated(
    'Every name tried for switch-buddy is already taken in this workspace.'
  );
}

/** The workspace the buddy belongs to: the one open on the server. */
export function buddyWorkspaceId(serverId: string): string | null {
  return workspacesStore.idOnServerInScope(serverId);
}
