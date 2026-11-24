import { checkAcpSignIn, createAcpAdapter } from '../acp/acp-adapter';
import type { AcpProviderHooks } from '../acp/hooks';
import type { ProviderAdapter } from '../adapter';
import { antigravityAcp } from '../antigravity/antigravity-adapter';
import { createClaudeAdapter } from '../claude/claude-adapter';
import { checkClaudeSignIn, CLAUDE_LOGIN } from '../claude/sign-in';
import { clineAcp } from '../cline/cline-adapter';
import { createCodexAdapter } from '../codex/codex-adapter';
import { checkCodexSignIn, CODEX_LOGIN } from '../codex/sign-in';
import { readCodexSubscriptionUsage } from '../codex/subscription-usage';
import { copilotAcp } from '../copilot/copilot-acp';
import { cursorAcp } from '../cursor/cursor-adapter';
import { deepseekHarnessAcp } from '../deepseek-harness/deepseek-harness-acp';
import { droidAcp } from '../droid/droid-adapter';
import { gooseAcp } from '../goose/goose-adapter';
import { junieAcp } from '../junie/junie-adapter';
import { kiroAcp } from '../kiro/kiro-acp';
import { mistralVibeAcp } from '../mistral-vibe/mistral-vibe-acp';
import { checkOpencodeSignInAnyLine, createOpencodeRuntimeAdapter } from '../opencode/runtime';
import { OPENCODE_LOGIN } from '../opencode/sign-in';
import { createPiAdapter } from '../pi/pi-adapter';
import { checkPiSignIn, PI_INHERIT_ENV, PI_LOGIN } from '../pi/sign-in';
import { qwenAcp } from '../qwen/qwen-acp';
import type { ProviderReadiness, SignInCheckInput } from '../readiness';
import type { ReadSubscriptionUsage } from '../subscription-usage';
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
   * The sign-in command for the executable at `binaryPath`, where it is not
   * `loginCommand` for every one. Read it through `loginCommandOf`.
   */
  loginCommandFor?(binaryPath: string): string;
  /**
   * Environment variables the CLI reads (credentials, endpoints) that a
   * session host passes through from the machine's environment.
   */
  inheritEnv: readonly string[];
  /** The platforms the CLI cannot run on, each with the reason a person is told. */
  unsupportedPlatforms: Partial<Record<NodeJS.Platform, string>>;
  /**
   * Whether a new agent on this provider starts in auto mode. False where
   * nothing reviews an action before it runs in auto mode: room text reaches
   * an agent as a prompt, so anyone who can post in its rooms could have
   * commands run on its owner's machine. Such an agent starts
   * approval-required, and its owner can still turn auto mode on. The same as
   * `new_agent_auto_mode` in switch-core's `providers/registry.py`, which a
   * core test holds this to. Read it through `newAgentPermissions`.
   */
  newAgentAutoMode: boolean;
  createAdapter(options: ProviderRuntimeOptions): ProviderAdapter;
  /** Whether the CLI is signed in, answered without signing it in. */
  checkSignIn(input: SignInCheckInput): Promise<ProviderReadiness>;
  readSubscriptionUsage?: ReadSubscriptionUsage;
}

/** An ACP-speaking CLI's runtime, made entirely from its hooks. */
export function acpProviderRuntime(hooks: AcpProviderHooks): ProviderRuntime {
  return {
    id: hooks.provider,
    loginCommand: hooks.loginCommand,
    ...(hooks.loginCommandFor ? { loginCommandFor: hooks.loginCommandFor } : {}),
    inheritEnv: hooks.inheritEnv ?? [],
    unsupportedPlatforms: hooks.unsupportedPlatforms ?? {},
    newAgentAutoMode: true,
    createAdapter: ({ binaryPath, logger }) => createAcpAdapter(hooks, { binaryPath, logger }),
    checkSignIn: (input) => checkAcpSignIn(hooks, input),
    ...(hooks.readSubscriptionUsage ? { readSubscriptionUsage: hooks.readSubscriptionUsage } : {}),
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
    newAgentAutoMode: true,
    createAdapter: ({ binaryPath, logger }) =>
      createClaudeAdapter({ claudeExecutablePath: binaryPath, ...(logger ? { logger } : {}) }),
    checkSignIn: checkClaudeSignIn,
  },
  {
    id: 'codex',
    loginCommand: CODEX_LOGIN,
    inheritEnv: [],
    unsupportedPlatforms: {},
    newAgentAutoMode: true,
    createAdapter: ({ binaryPath, logger }) =>
      createCodexAdapter({ binaryPath, ...(logger ? { logger } : {}) }),
    checkSignIn: checkCodexSignIn,
    readSubscriptionUsage: readCodexSubscriptionUsage,
  },
  {
    id: 'opencode',
    loginCommand: OPENCODE_LOGIN,
    inheritEnv: [],
    unsupportedPlatforms: {},
    // OpenCode's auto mode answers every permission ask itself, as its own
    // `--auto` does: no person and no classifier sees a command first.
    newAgentAutoMode: false,
    createAdapter: ({ binaryPath, logger, skill, serviceSkills }) =>
      createOpencodeRuntimeAdapter({
        binaryPath,
        logger,
        skills: [...(skill ? [{ name: 'switch', content: skill }] : []), ...serviceSkills],
      }),
    checkSignIn: checkOpencodeSignInAnyLine,
  },
  acpProviderRuntime(antigravityAcp),
  acpProviderRuntime(copilotAcp),
  acpProviderRuntime(cursorAcp),
  acpProviderRuntime(deepseekHarnessAcp),
  acpProviderRuntime(kiroAcp),
  acpProviderRuntime(mistralVibeAcp),
  {
    id: 'pi',
    loginCommand: PI_LOGIN,
    inheritEnv: PI_INHERIT_ENV,
    unsupportedPlatforms: {},
    newAgentAutoMode: true,
    createAdapter: ({ binaryPath, logger }) =>
      createPiAdapter({ binaryPath, ...(logger ? { logger } : {}) }),
    checkSignIn: checkPiSignIn,
  },
  acpProviderRuntime(gooseAcp),
  acpProviderRuntime(qwenAcp),
  acpProviderRuntime(droidAcp),
  acpProviderRuntime(clineAcp),
  acpProviderRuntime(junieAcp),
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

/**
 * The permission settings a new agent on `providerId` starts with, wherever it
 * runs: bypass off, and auto mode as its runtime's `newAgentAutoMode` says.
 */
export function newAgentPermissions(providerId: string): {
  autoApprove: false;
  autoMode: boolean;
} {
  return { autoApprove: false, autoMode: providerRuntime(providerId).newAgentAutoMode };
}

export function providerRuntime(id: string): ProviderRuntime {
  const runtime = RUNTIMES.get(id);
  if (!runtime) throw new Error(`Unsupported execution provider: ${id}`);
  return runtime;
}
