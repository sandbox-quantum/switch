import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';

/**
 * The v1 managed agent definition, as Switch's agent management takes it
 * (`DefinitionV1` in Core). It has no field for anything else, so whatever
 * else an agent's Console configuration says is listed rather than dropped
 * silently.
 */
export type ManagedDefinition = {
  provider: AgentProviderId;
  model: string | null;
  instructions: string;
  auto_session: boolean;
  auto_approve: boolean;
  directory: string | null;
};

/** The longest instructions Core takes (`MAX_INSTRUCTIONS_BYTES`). */
export const MAX_INSTRUCTIONS_BYTES = 32 * 1024;

/** The specialisation keys the definition carries, or names as lost on their own. */
const CARRIED_KEYS = new Set(['model', 'instructions']);

export type DefinitionSource = {
  providerId: AgentProviderId;
  /** The agent's launch specialisation (`agentLaunchConfig`), or undefined when it sets none. */
  specialization: Record<string, string | undefined> | undefined;
  /** Whether the agent launches as a provider agent definition (Claude Code's `--agent`). */
  providerDefinition: boolean;
  autoApprove: boolean;
  /** The agent's working directory, as an absolute path on its machine. */
  directory: string;
  /** Somebody stopped the agent's watcher by hand: it moves stopped, and stays stopped. */
  stoppedByHand: boolean;
  /** A shell setup the location runs before each session. */
  shellSetup: boolean;
  /** The provider CLI Console was told to use, when it is not simply the one on PATH. */
  chosenBinary: string | null;
  /**
   * For a subagent watched under its parent: the body of its provider
   * definition file, which today shapes every session it runs.
   */
  subagentDefinition: { name: string; body: string | null } | null;
};

export type BuiltDefinition = {
  definition: ManagedDefinition;
  desiredState: 'running' | 'stopped';
  /** What the managed agent will not have, said for a person. */
  notCarried: string[];
};

/** The body of a definition file, without its front matter. */
export function definitionBody(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return (match ? text.slice(match[0].length) : text).trim();
}

/**
 * The managed definition an agent's Console configuration amounts to, and
 * what it leaves behind. Pure.
 *
 * Automatic sessions are always on: Console starts a session for every agent
 * addressed with none running, unless its watcher was stopped by hand, which
 * moves as the desired state `stopped` rather than as sessions turned off.
 */
export function buildManagedDefinition(source: DefinitionSource): BuiltDefinition {
  const specialization = source.specialization ?? {};
  const notCarried: string[] = [];
  const optionKey = source.providerId === 'opencode' ? 'variant' : 'effort';
  const option = specialization[optionKey];
  if (option)
    notCarried.push(
      optionKey === 'variant'
        ? `The model variant “${option}”: the managed agent runs the model's default variant.`
        : `The reasoning effort “${option}”: the managed agent runs at the provider's default effort.`
    );
  const unused = Object.keys(specialization)
    .filter((key) => key !== optionKey && !CARRIED_KEYS.has(key) && specialization[key])
    .sort();
  if (unused.length)
    notCarried.push(
      `Launch settings with no managed equivalent: ${unused.join(', ')}${source.providerId === 'codex' ? ' (Codex launch profile)' : ''}.`
    );
  if (source.providerDefinition && !source.subagentDefinition)
    notCarried.push(
      'The provider agent definition this agent launches as (its tools and permission settings): the managed agent gets its instructions as system context instead.'
    );
  if (source.shellSetup)
    notCarried.push('The location’s shell setup: managed sessions start without running it first.');
  if (source.chosenBinary)
    notCarried.push(
      `The provider CLI chosen in Console (${source.chosenBinary}): the managed agent uses the one on the machine's PATH.`
    );
  const parts = [specialization.instructions ?? ''];
  if (source.subagentDefinition) {
    if (source.subagentDefinition.body) parts.push(source.subagentDefinition.body);
    notCarried.push(
      `${source.subagentDefinition.name}’s definition file settings other than its prompt (its tools and model, say): the managed subagent gets the prompt as instructions.`
    );
  }
  const instructions = parts.filter(Boolean).join('\n\n');
  if (Buffer.byteLength(instructions, 'utf8') > MAX_INSTRUCTIONS_BYTES)
    throw new Error(
      `The instructions are longer than the ${MAX_INSTRUCTIONS_BYTES / 1024} KiB a managed agent takes; shorten them before moving it.`
    );
  return {
    definition: {
      provider: source.providerId,
      model: specialization.model || null,
      instructions,
      auto_session: true,
      auto_approve: source.autoApprove,
      directory: source.directory,
    },
    desiredState: source.stoppedByHand ? 'stopped' : 'running',
    notCarried,
  };
}
