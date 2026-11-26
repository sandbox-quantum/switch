import { createBuddy as createBuddyShared, type TemplateRunResult } from '@switch-console/chat-ui/model/create-buddy';
import { BUDDY_TEMPLATE_ID } from './buddy-identity';
import { rpc } from '@renderer/lib/ipc';
import { reportBuddyStep } from './buddy-telemetry';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';

/**
 * Creates the person's buddy on this computer with `provider`, from the
 * template the server ships.
 */
export async function createBuddy(input: {
  serverId: string;
  workspaceId: string;
  machineId: string;
  provider: string;
  person: { name: string | null; email: string | null };
}): Promise<{ agentId: string; name: string }> {
  try {
    return await createBuddyShared(input.person, input.provider, input.machineId, {
      listAgents: async () => {
        const agents = (await rpc.managedAgents.list(input.serverId)) ?? [];
        return agents.map((agent) => ({
          agentId: agent.agentId,
          name: agent.name,
          template: agent.template,
        }));
      },
      getTemplate: async () => {
        const template = await rpc.workspaces.getTemplateDetail({
          workspaceId: input.workspaceId,
          templateId: BUDDY_TEMPLATE_ID,
        });
        return { content: template.definition, name: template.name };
      },
      runTemplate: async ({ content, name, agentName, provider, machine }): Promise<TemplateRunResult> => {
        const result = await rpc.workspaces.runTemplateDocument(input.workspaceId, {
          template: content,
          inputs: { agent_name: agentName, provider, machine },
          filled: {},
          templateName: name,
          templateId: BUDDY_TEMPLATE_ID,
          entryPoint: 'switch_buddy',
        });
        if (result.kind === 'created') {
          const created = result.createdAgents[0];
          if (!created) return { kind: 'failed', message: 'The server created no agent for switch-buddy.' };
          return { kind: 'created', agentId: created.agentId, name: created.name };
        }
        if (result.problems.some((problem) => problem.code === 'name_taken'))
          return { kind: 'name_taken' };
        return {
          kind: 'failed',
          message: result.problems.map((problem) => problem.message).join(' ') || result.message,
        };
      },
      recordRun: () =>
        rpc.workspaces.recordTemplateRun({
          workspaceId: input.workspaceId,
          templateId: BUDDY_TEMPLATE_ID,
        }),
    });
  } catch (error) {
    reportBuddyStep('create_failed', input.provider);
    throw error;
  }
}

/** The workspace the buddy belongs to: the one open on the server. */
export function buddyWorkspaceId(serverId: string): string | null {
  return workspacesStore.idOnServerInScope(serverId);
}
