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
import type { ProviderReadiness, SignInCheckInput } from '../readiness';
import type { ProviderLogger } from '../transport/stdio-json-rpc';

export interface ProviderRuntimeOptions {
  /** The provider's executable; the provider's default when undefined. */
  binaryPath: string | undefined;
  logger: ProviderLogger | undefined;
  /**
   * The Switch skill file, for a provider that loads skills from a directory
   * it is given (OpenCode), or '' for none. Codex takes it through its session
   * home instead, and ACP agents through the session's system context.
   */
  skill: string;
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
    createAdapter: ({ binaryPath, logger }) =>
      createClaudeAdapter({ claudeExecutablePath: binaryPath, ...(logger ? { logger } : {}) }),
    checkSignIn: checkClaudeSignIn,
  },
  {
    id: 'codex',
    loginCommand: CODEX_LOGIN,
    inheritEnv: [],
    createAdapter: ({ binaryPath, logger }) =>
      createCodexAdapter({ binaryPath, ...(logger ? { logger } : {}) }),
    checkSignIn: checkCodexSignIn,
  },
  {
    id: 'opencode',
    loginCommand: OPENCODE_LOGIN,
    inheritEnv: [],
    createAdapter: ({ binaryPath, logger, skill }) =>
      createOpencodeAdapter({
        binaryPath,
        ...(logger ? { logger } : {}),
        skills: skill ? [{ name: 'switch', content: skill }] : [],
      }),
    checkSignIn: checkOpencodeSignIn,
  },
  acpProviderRuntime(antigravityAcp),
  acpProviderRuntime(cursorAcp),
];

const RUNTIMES = new Map(PROVIDER_RUNTIMES.map((runtime) => [runtime.id, runtime]));

export function providerRuntimeIds(): string[] {
  return [...RUNTIMES.keys()];
}

export function isProviderRuntime(id: string): boolean {
  return RUNTIMES.has(id);
}

export function providerRuntime(id: string): ProviderRuntime {
  const runtime = RUNTIMES.get(id);
  if (!runtime) throw new Error(`Unsupported execution provider: ${id}`);
  return runtime;
}
