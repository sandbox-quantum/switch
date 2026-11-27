import { buddyAgentName, findBuddy } from './buddy';

export type BuddyAgent = {
  agentId: string;
  name: string;
  template?: { id: string; key: string; revision?: number | null } | null;
};

export type TemplateRunResult =
  | { kind: 'created'; agentId: string; name: string }
  | { kind: 'name_taken' }
  | { kind: 'failed'; message: string };

export type CreateBuddyDeps = {
  listAgents: () => Promise<readonly BuddyAgent[]>;
  getTemplate: () => Promise<{ content: string; name: string }>;
  runTemplate: (input: {
    content: string;
    name: string;
    agentName: string;
    provider: string;
    machine: string;
  }) => Promise<TemplateRunResult>;
  recordRun?: () => Promise<void>;
};

const NAME_ATTEMPTS = 5;

/**
 * Creates the person's switch-buddy from the template, retrying with the next
 * name when one is taken. Returns the buddy they already have, or the one just
 * created.
 */
export async function createBuddy(
  person: { name: string | null; email: string | null },
  provider: string,
  machine: string,
  deps: CreateBuddyDeps
): Promise<{ agentId: string; name: string }> {
  const existing = await deps.listAgents();
  const mine = findBuddy(existing);
  if (mine) return { agentId: mine.agentId, name: mine.name };
  const template = await deps.getTemplate();
  const taken = new Set(existing.map((agent) => agent.name));
  for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt++) {
    const name = buddyAgentName(person, taken);
    const result = await deps.runTemplate({
      content: template.content,
      name: template.name,
      agentName: name,
      provider,
      machine,
    });
    if (result.kind === 'created') {
      void deps.recordRun?.();
      return { agentId: result.agentId, name: result.name };
    }
    if (result.kind === 'name_taken') {
      taken.add(name);
      continue;
    }
    throw new Error(result.message);
  }
  throw new Error('Every name tried for switch-buddy is already taken in this workspace.');
}
