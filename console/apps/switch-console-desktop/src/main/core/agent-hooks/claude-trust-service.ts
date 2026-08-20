import path from 'node:path';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import {
  canonicalTrustPath,
  configWriteLock,
  isPlainObject,
  readLocalConfig,
  type TrustLogger,
  type TrustServiceDeps,
  writeLocalConfigAtomic,
} from './trust-config-io';

const CLAUDE_PROVIDER_ID: AgentProviderId = 'claude';
const COPILOT_PROVIDER_ID: AgentProviderId = 'copilot';
const CLAUDE_CONFIG_NAME = '.claude.json';
const CLAUDE_LOCAL_SETTINGS_NAME = '.claude/settings.local.json';
const CLAUDE_SKIP_BYPASS_PROMPT_KEY = 'skipDangerousModePermissionPrompt';
const COPILOT_CONFIG_NAME = '.copilot/config.json';

export class ClaudeTrustService {
  constructor(private readonly deps: TrustServiceDeps) {}

  async maybeAutoTrustLocal({
    providerId,
    cwd,
    homedir,
    force = false,
  }: {
    providerId: AgentProviderId;
    cwd?: string;
    homedir: string;
    force?: boolean;
  }): Promise<void> {
    if (!cwd) return;
    if (providerId !== CLAUDE_PROVIDER_ID && providerId !== COPILOT_PROVIDER_ID) return;
    const normalizedPath = await canonicalTrustPath(cwd);
    if (providerId === CLAUDE_PROVIDER_ID && force) {
      await this.acceptBypassPermissionsMode(normalizedPath);
    }
    const trustConfig = await this.getTrustConfig(providerId, force);
    if (!trustConfig) return;
    const configPath = path.join(homedir, trustConfig.configName);
    await configWriteLock.run(configPath, () =>
      this.ensureTrusted(normalizedPath, {
        readConfig: () => readLocalConfig(configPath),
        writeConfig: (content) => writeLocalConfigAtomic(configPath, content),
        trustConfig,
      })
    );
  }

  /**
   * Records acceptance of Claude Code's bypass-permissions warning, the last
   * prompt between a `--dangerously-skip-permissions` launch and a live
   * session.
   *
   * Only reached when the agent's own auto-approve toggle is on, which is where
   * the user accepted that risk; Switch Console does not decide it for them.
   * The warning's default answer is "No, exit", so a detached session left to
   * answer it does not merely stall — the first stray keypress kills it.
   *
   * Written per working directory, not to the user's global settings: one
   * agent's toggle must not quietly waive the warning for every other agent,
   * or for Claude Code run by hand outside Switch Console. Verified against
   * 2.1.234 that `settings.local.json` is the narrowest scope that works —
   * the shared, committable `settings.json` beside it does not clear the
   * prompt at all, which is the right call on Claude Code's part and the
   * reason not to reach for it.
   */
  private async acceptBypassPermissionsMode(worktreePath: string): Promise<void> {
    const settingsPath = path.join(worktreePath, CLAUDE_LOCAL_SETTINGS_NAME);
    await configWriteLock.run(settingsPath, async () => {
      try {
        const settings = parseConfig(
          await readLocalConfig(settingsPath),
          'Claude settings',
          this.deps.log
        );
        if (!settings) return;
        if (settings[CLAUDE_SKIP_BYPASS_PROMPT_KEY] === true) return;
        await writeLocalConfigAtomic(
          settingsPath,
          JSON.stringify({ ...settings, [CLAUDE_SKIP_BYPASS_PROMPT_KEY]: true }, null, 2) + '\n'
        );
      } catch (error: unknown) {
        this.deps.log.warn('ClaudeTrustService: failed to accept bypass-permissions mode', {
          settingsPath,
          error: String(error),
        });
      }
    });
  }

  private async getTrustConfig(
    providerId: AgentProviderId,
    force: boolean
  ): Promise<TrustConfig | null> {
    if (providerId !== CLAUDE_PROVIDER_ID && providerId !== COPILOT_PROVIDER_ID) return null;
    if (!force) {
      const { autoTrustWorktrees } = await this.deps.getSessionSettings();
      if (!autoTrustWorktrees) return null;
    }

    if (providerId === COPILOT_PROVIDER_ID) {
      return {
        configName: COPILOT_CONFIG_NAME,
        parseWarningName: 'Copilot',
        withTrustedPath: withCopilotTrustedFolder,
      };
    }

    return {
      configName: CLAUDE_CONFIG_NAME,
      parseWarningName: 'Claude',
      withTrustedPath: withClaudeTrustedProject,
    };
  }

  private async ensureTrusted(
    normalizedPath: string,
    io: {
      readConfig: () => Promise<string | null>;
      writeConfig: (content: string) => Promise<void>;
      trustConfig: TrustConfig;
    }
  ): Promise<void> {
    try {
      const rawConfig = await io.readConfig();
      const config = parseConfig(rawConfig, io.trustConfig.parseWarningName, this.deps.log);
      if (!config) return;
      const nextConfig = io.trustConfig.withTrustedPath(config, normalizedPath);
      if (!nextConfig) return;
      await io.writeConfig(JSON.stringify(nextConfig, null, 2) + '\n');
    } catch (error: unknown) {
      this.deps.log.warn('ClaudeTrustService: failed to auto-trust worktree', {
        path: normalizedPath,
        error: String(error),
      });
    }
  }
}

type TrustConfig = {
  configName: string;
  parseWarningName: string;
  withTrustedPath: (
    config: Record<string, unknown>,
    worktreePath: string
  ) => Record<string, unknown> | null;
};

function parseConfig(
  raw: string | null,
  warningName: string,
  log: TrustLogger
): Record<string, unknown> | null {
  if (!raw || raw.trim() === '') return {};

  try {
    const parsed = JSON.parse(raw);
    if (isPlainObject(parsed)) return parsed;
    log.warn(`ClaudeTrustService: refusing to overwrite non-object ${warningName} config root`);
    return null;
  } catch (error: unknown) {
    log.warn(`ClaudeTrustService: refusing to overwrite corrupt ${warningName} config`, {
      error: String(error),
    });
    return null;
  }
}

/**
 * Clears "is this a project you trust?" for one directory.
 *
 * Deliberately does NOT mark Claude Code's global first-run setup as complete,
 * though doing so would clear another startup prompt. That wizard is where a
 * new install is told to connect an account, and skipping it would replace a
 * prompt that says what is missing with a session that fails later for no
 * visible reason. A session held up by it is reported as stalled instead —
 * which is the honest answer, because setup really is needed.
 *
 * `projects` and the two flags under it are Claude Code's names for its own
 * config, not Switch Console's. They track whatever Claude Code calls them and
 * must not be renamed to follow our vocabulary — CHOO-1426 renamed them
 * alongside our own project→location refactor, which silently disabled
 * auto-trust for every Claude session while the (equally renamed) test kept
 * passing.
 */
function withClaudeTrustedProject(
  config: Record<string, unknown>,
  worktreePath: string
): Record<string, unknown> | null {
  const projects = isPlainObject(config.projects) ? config.projects : {};
  const existing = isPlainObject(projects[worktreePath]) ? projects[worktreePath] : {};

  const alreadyTrusted =
    existing['hasTrustDialogAccepted'] === true &&
    existing['hasCompletedProjectOnboarding'] === true;
  if (alreadyTrusted) return null;

  return {
    ...config,
    projects: {
      ...projects,
      [worktreePath]: {
        ...existing,
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      },
    },
  };
}

function withCopilotTrustedFolder(
  config: Record<string, unknown>,
  worktreePath: string
): Record<string, unknown> | null {
  const trustedFolders = Array.isArray(config.trustedFolders) ? config.trustedFolders : [];
  if (trustedFolders.includes(worktreePath)) return null;

  return {
    ...config,
    trustedFolders: [...trustedFolders, worktreePath],
  };
}
