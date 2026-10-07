import { randomUUID } from 'node:crypto';
import {
  agentLaunchDefinitionSchema,
  controllerConnectionId,
  createAntigravityAdapter,
  createClaudeAdapter,
  createCodexAdapter,
  createCursorAdapter,
  createOpencodeAdapter,
  EXECUTION_INHERIT_ENV,
  type ProviderCapabilities,
  type SharedHostConfig,
  sharedConfigSchema,
} from '@switch-console/agent-providers';
import { advancedConfigProblem, sessionLaunchConfig } from '@switch-console/plugins/agents';
import type { AgentDefinition, Provider } from './schemas';

const capabilityCache = new Map<Provider, ProviderCapabilities>();

/** What the provider's adapter says it can do; the session record advertises the same. */
function adapterCapabilities(provider: Provider): ProviderCapabilities {
  const cached = capabilityCache.get(provider);
  if (cached) return cached;
  const adapter =
    provider === 'claude'
      ? createClaudeAdapter()
      : provider === 'codex'
        ? createCodexAdapter()
        : provider === 'opencode'
          ? createOpencodeAdapter()
          : provider === 'antigravity'
            ? createAntigravityAdapter()
            : createCursorAdapter();
  capabilityCache.set(provider, adapter.capabilities);
  return adapter.capabilities;
}

/** The session id the watcher's template carries, as Console names it. */
export function watcherSessionId(agentId: string): string {
  return `watcher-${agentId}`;
}

/**
 * What keeps an agent's advanced configuration from being applied as defined,
 * naming the field, or null when nothing does. A field this build does not
 * know is refused rather than ignored: a newer server may send one an older
 * controller cannot apply.
 */
export function advancedConfigDefinitionProblem(
  provider: Provider,
  definition: Pick<AgentDefinition, 'name' | 'model' | 'advanced_config' | 'instructions'>
): string | null {
  const problem = advancedConfigProblem(provider, definition.advanced_config);
  if (problem) return problem;
  const agent = launchFor(provider, definition, '').agent;
  if (!agent) return null;
  const parsed = agentLaunchDefinitionSchema.safeParse(agent.definition);
  if (parsed.success) return null;
  const problems = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'definition'}: ${issue.message}`)
    .join('; ');
  return `The advanced configuration has settings a session cannot start with (${problems}).`;
}

function launchFor(
  provider: Provider,
  definition: Pick<AgentDefinition, 'name' | 'model' | 'advanced_config' | 'instructions'>,
  cwd: string
) {
  return sessionLaunchConfig({
    provider,
    slug: definition.name,
    description: '',
    cwd,
    model: definition.model,
    advancedConfig: definition.advanced_config,
    instructions: definition.instructions,
  });
}

/**
 * The configuration a managed agent's room watcher runs from: the same
 * `SharedHostConfig` Console's `buildSharedHostConfig` writes for a watcher, so
 * the sessions it starts behave as Console-started ones do. The model, the
 * advanced configuration and the instructions are applied as Console applies
 * its own agents' (`sessionLaunchConfig`). Validated before it is returned; a
 * template the host would refuse is a bug here, not on the host.
 *
 * Differences from Console, all because v1's definition does not carry them:
 * no per-location environment or shell setup, and no description for the
 * agent definition Claude Code runs as, which takes the agent's name instead.
 */
export function buildWatcherTemplate(input: {
  agentId: string;
  provider: Provider;
  definition: Pick<
    AgentDefinition,
    'name' | 'model' | 'advanced_config' | 'instructions' | 'auto_approve'
  >;
  cwd: string;
  credentialsPath: string;
  binaryPath: string | null;
}): SharedHostConfig {
  const { provider } = input;
  const capabilities = adapterCapabilities(provider);
  const sessionId = watcherSessionId(input.agentId);
  const launch = launchFor(provider, input.definition, input.cwd);
  return sharedConfigSchema.parse({
    session: {
      sessionId,
      agentId: input.agentId,
      hostId: randomUUID(),
      epoch: randomUUID(),
      provider,
      status: 'starting',
      connectivity: 'online',
      pendingRequestIds: [],
      capabilities: {
        input: 'queue',
        approvals: capabilities.approvals,
        questions: capabilities.userInput,
        interrupt: true,
        reset: true,
        compact: false,
        modelChange: false,
        attachmentMimeTypes: [],
      },
    },
    start: {
      provider,
      input: {
        sessionId,
        cwd: input.cwd,
        runtimeMode: input.definition.auto_approve ? 'full-access' : 'approval-required',
        env: {},
        mcpServers: {},
        ...(launch.agent
          ? {
              agentName: launch.agent.name,
              agentDefinition: agentLaunchDefinitionSchema.parse(launch.agent.definition),
            }
          : {}),
        ...(launch.model ? { model: launch.model } : {}),
      },
    },
    roomConnection: { connectionId: controllerConnectionId(input.agentId) },
    execution: {
      credentialsPath: input.credentialsPath,
      inheritEnv: [...EXECUTION_INHERIT_ENV],
      ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
      codexConfig: launch.codexConfig,
      skill: launch.skill,
      context: launch.context,
      instructions: launch.instructions,
    },
  } satisfies SharedHostConfig);
}
