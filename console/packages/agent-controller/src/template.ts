import { randomUUID } from 'node:crypto';
import {
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
import { SWITCH_SKILL_CONTEXT, SWITCH_SKILL_FILE } from '@switch-console/plugins/switch-skill';
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
 * The configuration a managed agent's room watcher runs from: the same
 * `SharedHostConfig` Console's `buildSharedHostConfig` writes for a watcher, so
 * the sessions it starts behave as Console-started ones do. Validated before it
 * is returned; a template the host would refuse is a bug here, not on the host.
 *
 * Differences from Console, all because v1's definition does not carry them:
 * no provider agent definition file, no per-location environment or shell
 * setup, and no Codex launch profile (Console builds one only from
 * specialisation values the v1 definition has no field for).
 */
export function buildWatcherTemplate(input: {
  agentId: string;
  provider: Provider;
  definition: Pick<AgentDefinition, 'model' | 'instructions' | 'auto_approve'>;
  cwd: string;
  credentialsPath: string;
  binaryPath: string | null;
}): SharedHostConfig {
  const { provider } = input;
  const capabilities = adapterCapabilities(provider);
  const sessionId = watcherSessionId(input.agentId);
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
        ...(input.definition.model ? { model: { id: input.definition.model } } : {}),
      },
    },
    roomConnection: { connectionId: controllerConnectionId(input.agentId) },
    execution: {
      credentialsPath: input.credentialsPath,
      inheritEnv: [...EXECUTION_INHERIT_ENV],
      ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
      codexConfig: '',
      // OpenCode loads the skill as a file through its own skill tool; the
      // others take it as system context, as in Console.
      skill: provider === 'opencode' ? SWITCH_SKILL_FILE : '',
      context: [provider === 'opencode' ? '' : SWITCH_SKILL_CONTEXT, input.definition.instructions]
        .filter(Boolean)
        .join('\n\n'),
    },
  } satisfies SharedHostConfig);
}
