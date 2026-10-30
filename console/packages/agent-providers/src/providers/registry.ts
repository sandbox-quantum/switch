import { checkAcpSignIn, createAcpAdapter } from '../acp/acp-adapter';
import type { AcpProviderHooks } from '../acp/hooks';
import type { ProviderAdapter } from '../adapter';
import { antigravityAcp } from '../antigravity/antigravity-adapter';
import { createClaudeAdapter } from '../claude/claude-adapter';
import { checkClaudeSignIn, CLAUDE_LOGIN } from '../claude/sign-in';
import { createCodexAdapter } from '../codex/codex-adapter';
import { checkCodexSignIn, CODEX_LOGIN } from '../codex/sign-in';
import { cursorAcp } from '../cursor/cursor-adapter';
import { createOpencodeAdapter } from '../opencode/opencode-adapter';
import { checkOpencodeSignIn, OPENCODE_LOGIN } from '../opencode/sign-in';
import { createPiAdapter, PI_LOGIN } from '../pi/pi-adapter';
import { checkPiSignIn } from '../pi/sign-in';
import type { ProviderReadiness, SignInCheckInput } from '../readiness';
import type { ProviderLogger } from '../transport/stdio-json-rpc';

export interface ProviderRuntimeOptions {
  /** The provider's executable; the provider's default when undefined. */
  binaryPath: string | undefined;
  logger: ProviderLogger | undefined;
  /**
   * The Switch skill file, for a provider that loads skills from a directory
   * it is given (OpenCode), or '' for none. Codex and the ACP agents take it
   * through the session's system context instead (Codex as its
   * `developerInstructions`).
   */
  skill: string;
  /**
   * The skills of the agent's service grants, which OpenCode loads the same
   * way as `skill`; the other providers take them as system context
   * (`prepareSharedConfig`).
   */
  serviceSkills: readonly { name: string; content: string }[];
}

/** What the execution host needs to run one provider. */
export interface ProviderRuntime {
  id: string;
  /** The command a person runs on the execution machine to sign the CLI in. */
  loginCommand: string;
  /**
   * Environment variables the CLI reads (credentials, endpoints) that a
   * session host passes through from the machine's environment.
   */
  inheritEnv: readonly string[];
  /** The platforms the CLI cannot run on, each with the reason a person is told. */
  unsupportedPlatforms: Partial<Record<NodeJS.Platform, string>>;
  createAdapter(options: ProviderRuntimeOptions): ProviderAdapter;
  /** Whether the CLI is signed in, answered without signing it in. */
  checkSignIn(input: SignInCheckInput): Promise<ProviderReadiness>;
}

/** An ACP-speaking CLI's runtime, made entirely from its hooks. */
export function acpProviderRuntime(hooks: AcpProviderHooks): ProviderRuntime {
  return {
    id: hooks.provider,
    loginCommand: hooks.loginCommand,
    inheritEnv: hooks.inheritEnv ?? [],
    unsupportedPlatforms: hooks.unsupportedPlatforms ?? {},
    createAdapter: ({ binaryPath, logger }) => createAcpAdapter(hooks, { binaryPath, logger }),
    checkSignIn: (input) => checkAcpSignIn(hooks, input),
  };
}

/**
 * Every provider the execution host can run. This is the runtime half of
 * registering a provider; the other half is its plugin in
 * `packages/plugins/src/agents/plugin-registry.ts`, and the two must name the
 * same providers.
 */
export const PROVIDER_RUNTIMES: readonly ProviderRuntime[] = [
  {
    id: 'claude',
    loginCommand: CLAUDE_LOGIN,
    inheritEnv: [],
    unsupportedPlatforms: {},
    createAdapter: ({ binaryPath, logger }) =>
      createClaudeAdapter({ claudeExecutablePath: binaryPath, ...(logger ? { logger } : {}) }),
    checkSignIn: checkClaudeSignIn,
  },
  {
    id: 'codex',
    loginCommand: CODEX_LOGIN,
    inheritEnv: [],
    unsupportedPlatforms: {},
    createAdapter: ({ binaryPath, logger }) =>
      createCodexAdapter({ binaryPath, ...(logger ? { logger } : {}) }),
    checkSignIn: checkCodexSignIn,
  },
  {
    id: 'opencode',
    loginCommand: OPENCODE_LOGIN,
    inheritEnv: [],
    unsupportedPlatforms: {},
    createAdapter: ({ binaryPath, logger, skill, serviceSkills }) =>
      createOpencodeAdapter({
        binaryPath,
        ...(logger ? { logger } : {}),
        skills: [...(skill ? [{ name: 'switch', content: skill }] : []), ...serviceSkills],
      }),
    checkSignIn: checkOpencodeSignIn,
  },
  acpProviderRuntime(antigravityAcp),
  acpProviderRuntime(cursorAcp),
  {
    id: 'pi',
    loginCommand: PI_LOGIN,
    // Pi's own directories, and the provider keys it reads that the host does
    // not already pass through.
    inheritEnv: [
      'PI_CODING_AGENT_DIR',
      'PI_CODING_AGENT_SESSION_DIR',
      'AI_GATEWAY_API_KEY',
      'CEREBRAS_API_KEY',
      'COPILOT_GITHUB_TOKEN',
      'DEEPSEEK_API_KEY',
      'FIREWORKS_API_KEY',
      'GOOGLE_CLOUD_API_KEY',
      'GROQ_API_KEY',
      'HF_TOKEN',
      'MINIMAX_API_KEY',
      'NVIDIA_API_KEY',
      'OPENCODE_API_KEY',
      'TOGETHER_API_KEY',
      'ZAI_API_KEY',
    ],
    unsupportedPlatforms: {},
    createAdapter: ({ binaryPath, logger }) =>
      createPiAdapter({ binaryPath, ...(logger ? { logger } : {}) }),
    checkSignIn: checkPiSignIn,
  },
];

const RUNTIMES = new Map(PROVIDER_RUNTIMES.map((runtime) => [runtime.id, runtime]));

export function providerRuntimeIds(): string[] {
  return [...RUNTIMES.keys()];
}

export function isProviderRuntime(id: string): boolean {
  return RUNTIMES.has(id);
}

/** Why the provider cannot run on `platform`, or null when it can. */
export function providerUnsupportedReason(id: string, platform: NodeJS.Platform): string | null {
  return RUNTIMES.get(id)?.unsupportedPlatforms[platform] ?? null;
}

export function providerRuntime(id: string): ProviderRuntime {
  const runtime = RUNTIMES.get(id);
  if (!runtime) throw new Error(`Unsupported execution provider: ${id}`);
  return runtime;
}
