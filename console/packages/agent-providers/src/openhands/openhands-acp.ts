import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import {
  ProviderSessionError,
  type ModelSelection,
  type ProviderSessionStartInput,
} from '../adapter';
import { readiness, signInWith, type ProviderReadiness, type SignInCheckInput } from '../readiness';

export const OPENHANDS_LOGIN = 'openhands login';
const SETUP = `${signInWith(OPENHANDS_LOGIN)} For your own LLM provider, run openhands and configure /settings instead.`;
const settingsSchema = z.object({
  llm: z.object({ model: z.string().min(1).refine((model) => model === model.trim()) }),
});

/** ACP loads the saved agent spec, not cloud tokens or ambient vendor API keys. */
export async function openHandsConfiguration(
  input: Pick<SignInCheckInput, 'cwd' | 'env'>
): Promise<ProviderReadiness> {
  let text: string;
  try {
    const directory = resolve(
      await realpath(input.cwd),
      input.env.OPENHANDS_PERSISTENCE_DIR || join(input.env.HOME || homedir(), '.openhands')
    );
    text = await readFile(join(directory, 'agent_settings.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return readiness('unauthenticated', SETUP);
    // Never include file contents or the underlying error: the spec contains credentials.
    return readiness('unknown', 'Cannot read OpenHands agent settings on the execution machine.');
  }
  try {
    const { llm } = settingsSchema.parse(JSON.parse(text));
    return {
      ...readiness('authenticated', 'OpenHands is configured. LLM credentials are not verified.'),
      models: [{ id: llm.model, name: llm.model }],
    };
  } catch {
    return readiness('unconfigured', `OpenHands agent settings are invalid. ${SETUP}`);
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
  loginCommand: OPENHANDS_LOGIN,
  inheritEnv: ['OPENHANDS_PERSISTENCE_DIR', 'OPENHANDS_CONVERSATIONS_DIR'],
  unsupportedPlatforms: {
    win32: 'OpenHands CLI requires Linux or macOS. Run the controller inside WSL on Windows.',
  },
  launch: ({ binaryPath, cwd, env }) => ({
    command: binaryPath,
    args: ['acp'],
    env: { ...env, OPENHANDS_WORK_DIR: cwd, OPENHANDS_SUPPRESS_BANNER: '1' },
  }),
  // Never call ACP authenticate: it starts an interactive OAuth device flow.
  checkSignIn: openHandsConfiguration,
  // Keep requests flowing through Switch, including in full-access mode.
  // OpenHands batches approvals as kind "other", so edit-only approval cannot
  // safely be inferred. Auto mode remains approval-required.
  sessionMode: () => 'always-ask',
};

/**
 * OpenHands 1.16.0 returns success from session/set_model without changing the
 * model and advertises no model catalogue. Expose only the saved model and
 * reject other selections before they can silently run on the wrong model.
 * All session, turn and permission handling remains in the shared ACP adapter.
 */
class OpenHandsAdapter extends AcpAdapter {
  private readonly configuredModels = new Map<string, string>();

  constructor(options: AcpAdapterOptions) {
    super(openhandsAcp, options);
    this.subscribe((event) => {
      if (event.type === 'session.exited') this.configuredModels.delete(event.sessionId);
    });
  }

  override async startSession(input: ProviderSessionStartInput) {
    if (this.hasSession(input.sessionId))
      throw new ProviderSessionError(this.provider, input.sessionId, 'session already started');
    const configuration = await openHandsConfiguration(input);
    const model = configuration.models[0]?.id;
    if (configuration.status !== 'authenticated' || !model)
      throw new ProviderSessionError(this.provider, input.sessionId, configuration.message);
    this.configuredModels.set(input.sessionId, model);
    try {
      if (input.model && input.model.id !== model)
        throw new ProviderSessionError(
          this.provider,
          input.sessionId,
          'OpenHands ACP cannot switch models. Select the configured model or update openhands /settings.'
        );
      return await super.startSession(input);
    } catch (error) {
      this.configuredModels.delete(input.sessionId);
      throw error;
    }
  }

  override async listModels(id: string) {
    await super.listModels(id); // Preserve the shared adapter's session validation.
    const model = this.configuredModels.get(id)!;
    return [{ id: model, label: model, options: {} }];
  }

  override async setModel(id: string, model: ModelSelection): Promise<void> {
    await super.listModels(id);
    if (this.configuredModels.get(id) !== model.id)
      throw new ProviderSessionError(
        this.provider,
        id,
        'OpenHands ACP cannot switch models. Configure the model with openhands /settings on the execution machine, then start a new session.'
      );
  }

  override async stopSession(id: string) {
    try {
      await super.stopSession(id);
    } finally {
      this.configuredModels.delete(id);
    }
  }
}

export function createOpenHandsAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return new OpenHandsAdapter(options);
}
