import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ModelChoice } from '@switch-console/shared/session-v1';
import { AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import {
  ProviderSessionError,
  ProviderConversationUnavailableError,
  type McpServerSpec,
  type StdioMcpServerSpec,
  type ModelSelection,
  type ProviderSessionStartInput,
} from '../adapter';
import { readiness } from '../readiness';

const LOGIN = 'openhands login';
const NOT_CONFIGURED = `OpenHands has no model configured on this machine. Run openhands to configure a model and its credentials, or sign in to OpenHands Cloud with ${LOGIN}.`;

function settingsPath(env: Record<string, string>): string {
  return join(
    env.OPENHANDS_PERSISTENCE_DIR || join(env.HOME || homedir(), '.openhands'),
    'agent_settings.json'
  );
}

/** OpenHands ACP runs the model saved by the user's OpenHands CLI. */
export async function configuredModel(env: Record<string, string>): Promise<string | undefined> {
  try {
    const settings = JSON.parse(await readFile(settingsPath(env), 'utf8')) as {
      llm?: { model?: unknown };
    };
    return typeof settings.llm?.model === 'string' && settings.llm.model.trim()
      ? settings.llm.model
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export const openhandsAcp: AcpProviderHooks = {
  provider: 'openhands',
  label: 'OpenHands CLI',
  defaultBinary: 'openhands',
  capabilities: {
    modelSwitchInSession: false,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env, resumeSessionId }) => ({
    command: binaryPath,
    args: ['acp', ...(resumeSessionId ? ['--resume', resumeSessionId] : [])],
    env: { ...env, OPENHANDS_SUPPRESS_BANNER: '1' },
  }),
  loginCommand: LOGIN,
  resumeWithLaunch: true,
  inputByteLimit: 64 * 1024,
  interruptPermissionAsError: true,
  itemType: (call) => (call.rawInput?.kind === 'TaskAction' ? 'subagent' : undefined),
  inheritEnv: ['OPENHANDS_PERSISTENCE_DIR', 'OPENHANDS_CONVERSATIONS_DIR'],
  unsupportedPlatforms: {
    win32: 'OpenHands CLI requires Linux or macOS; on Windows, run it inside WSL.',
  },
  checkSignIn: async ({ env }) => {
    try {
      const model = await configuredModel(env);
      return model
        ? {
            ...readiness('authenticated', `OpenHands is configured to run ${model}.`),
            models: [{ id: model, name: model }],
          }
        : readiness('unauthenticated', NOT_CONFIGURED);
    } catch {
      return readiness('unknown', 'Could not read OpenHands settings on this machine.');
    }
  },
  sessionMode: (runtimeMode) =>
    ({
      'full-access': 'always-approve',
      auto: 'llm-approve',
      'auto-accept-edits': 'always-ask',
      'approval-required': 'always-ask',
    })[runtimeMode],
};

/** Adds the one model OpenHands can actually run to ACP's empty model list. */
export interface OpenHandsAdapterOptions extends AcpAdapterOptions {
  mcpBridge?: StdioMcpServerSpec;
}

class OpenHandsAdapter extends AcpAdapter {
  private readonly selected = new Map<string, string>();

  constructor(private readonly openhandsOptions: OpenHandsAdapterOptions) {
    super(openhandsAcp, openhandsOptions);
    this.subscribe((event) => {
      if (event.type === 'session.exited') this.selected.delete(event.sessionId);
    });
  }

  override async startSession(input: ProviderSessionStartInput) {
    if (this.hasSession(input.sessionId))
      throw new ProviderSessionError(this.provider, input.sessionId, 'session already started');
    if (input.resume) {
      const id = input.resume.nativeSessionId;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
        throw new ProviderConversationUnavailableError(
          this.provider,
          input.sessionId,
          'Invalid OpenHands conversation ID.'
        );
      const directory =
        input.env.OPENHANDS_CONVERSATIONS_DIR ||
        join(dirname(settingsPath(input.env)), 'conversations');
      try {
        await access(join(directory, id.replaceAll('-', ''), 'base_state.json'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw new ProviderSessionError(
            this.provider,
            input.sessionId,
            'Could not read the saved OpenHands conversation.'
          );
        throw new ProviderConversationUnavailableError(
          this.provider,
          input.sessionId,
          'OpenHands conversation is not available on this machine.'
        );
      }
    }
    let configured: string | undefined;
    try {
      configured = await configuredModel(input.env);
    } catch {
      throw new ProviderSessionError(
        this.provider,
        input.sessionId,
        'OpenHands settings are unreadable.'
      );
    }
    if (!configured) throw new ProviderSessionError(this.provider, input.sessionId, NOT_CONFIGURED);
    if (
      input.model &&
      (input.model.id !== configured || Object.keys(input.model.options ?? {}).length > 0)
    )
      throw new ProviderSessionError(
        this.provider,
        input.sessionId,
        `OpenHands will run its configured model (${configured}); select that model in Switch.`
      );
    const mcpServers: Record<string, McpServerSpec> = {};
    for (const [name, spec] of Object.entries(input.mcpServers)) {
      const bridge = this.openhandsOptions.mcpBridge;
      if (!bridge)
        throw new ProviderSessionError(
          this.provider,
          input.sessionId,
          'OpenHands MCP requires the execution-host bridge.'
        );
      const source =
        spec.transport === 'stdio'
          ? {
              ...spec,
              env: {
                ...Object.fromEntries(
                  (spec.envVars ?? [])
                    .filter((key) => input.env[key] !== undefined)
                    .map((key) => [key, input.env[key]])
                ),
                ...spec.env,
              },
            }
          : spec;
      mcpServers[name] = {
        ...bridge,
        env: { ...bridge.env, SWITCH_OPENHANDS_MCP: JSON.stringify(source) },
      };
    }
    this.selected.set(input.sessionId, configured);
    try {
      return await super.startSession({ ...input, model: undefined, mcpServers });
    } catch (error) {
      this.selected.delete(input.sessionId);
      throw error;
    }
  }

  override async listModels(id: string): Promise<ModelChoice[]> {
    await super.listModels(id);
    const model = this.selected.get(id);
    if (!model)
      throw new ProviderSessionError(this.provider, id, 'OpenHands model is unavailable.');
    return [{ id: model, label: model, options: {} }];
  }

  override async setModel(id: string, model: ModelSelection): Promise<void> {
    await super.listModels(id);
    if (model.id !== this.selected.get(id) || Object.keys(model.options ?? {}).length > 0)
      throw new ProviderSessionError(
        this.provider,
        id,
        `OpenHands cannot switch to ${model.id} in a session.`
      );
  }

  override async stopSession(id: string): Promise<void> {
    try {
      await super.stopSession(id);
    } finally {
      this.selected.delete(id);
    }
  }
}

export function createOpenhandsAdapter(options: OpenHandsAdapterOptions = {}): AcpAdapter {
  return new OpenHandsAdapter(options);
}
