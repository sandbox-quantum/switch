import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { appSettingsService } from '@main/core/settings/settings-service';
import { log } from '@main/lib/logger';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';

const CLAUDE_PROVIDER_ID: AgentProviderId = 'claude';
const COPILOT_PROVIDER_ID: AgentProviderId = 'copilot';
const CLAUDE_CONFIG_NAME = '.claude.json';
const COPILOT_CONFIG_NAME = '.copilot/config.json';

export class ClaudeTrustService {
  private readonly configLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: {
      getSessionSettings: () => Promise<{ autoTrustWorktrees: boolean }>;
    }
  ) {}

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
    const trustConfig = await this.getTrustConfig(providerId, force);
    if (!trustConfig) return;
    const normalizedPath = path.resolve(cwd);
    const configPath = path.join(homedir, trustConfig.configName);
    await this.withLock(configPath, () =>
      this.ensureTrusted(normalizedPath, {
        readConfig: () => readLocalConfig(configPath),
        writeConfig: (content) => writeLocalConfigAtomic(configPath, content),
        trustConfig,
      })
    );
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
      withTrustedPath: withClaudeTrustedLocation,
    };
  }

  private withLock(configPath: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.configLocks.get(configPath) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.configLocks.set(configPath, next);
    return next;
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
      const config = parseConfig(rawConfig, io.trustConfig.parseWarningName);
      if (!config) return;
      const nextConfig = io.trustConfig.withTrustedPath(config, normalizedPath);
      if (!nextConfig) return;
      await io.writeConfig(JSON.stringify(nextConfig, null, 2) + '\n');
    } catch (error: unknown) {
      log.warn('ClaudeTrustService: failed to auto-trust worktree', {
        path: normalizedPath,
        error: String(error),
      });
    }
  }
}

export const claudeTrustService = new ClaudeTrustService({
  getSessionSettings: () => appSettingsService.get('sessions'),
});

type TrustConfig = {
  configName: string;
  parseWarningName: string;
  withTrustedPath: (
    config: Record<string, unknown>,
    worktreePath: string
  ) => Record<string, unknown> | null;
};

function parseConfig(raw: string | null, warningName: string): Record<string, unknown> | null {
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

function withClaudeTrustedLocation(
  config: Record<string, unknown>,
  worktreePath: string
): Record<string, unknown> | null {
  const locations = isPlainObject(config.locations) ? config.locations : {};
  const existing = isPlainObject(locations[worktreePath]) ? locations[worktreePath] : {};

  const alreadyTrusted =
    existing['hasTrustDialogAccepted'] === true &&
    existing['hasCompletedLocationOnboarding'] === true;
  if (alreadyTrusted) return null;

  return {
    ...config,
    locations: {
      ...locations,
      [worktreePath]: {
        ...existing,
        hasTrustDialogAccepted: true,
        hasCompletedLocationOnboarding: true,
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

async function readLocalConfig(configPath: string): Promise<string | null> {
  try {
    return await fs.readFile(configPath, 'utf8');
  } catch (error: unknown) {
    if (isNodeNotFound(error)) return null;
    throw error;
  }
}

async function writeLocalConfigAtomic(configPath: string, content: string): Promise<void> {
  const tmpPath = `${configPath}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(tmpPath, content, 'utf8');
    await fs.rename(tmpPath, configPath);
  } catch (error: unknown) {
    try {
      await fs.rm(tmpPath, { force: true });
    } catch {}
    throw error;
  }
}

function isNodeNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
