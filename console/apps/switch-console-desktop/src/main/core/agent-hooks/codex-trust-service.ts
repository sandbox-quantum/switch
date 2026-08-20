import path from 'node:path';
import * as toml from 'smol-toml';
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

const CODEX_PROVIDER_ID: AgentProviderId = 'codex';
const CODEX_CONFIG_NAME = '.codex/config.toml';

/**
 * Marks a directory trusted for Codex, clearing the "do you trust this
 * workspace?" prompt it raises in the TUI before a session starts.
 *
 * Codex reads this only from `~/.codex/config.toml` — verified against 0.146.0
 * that the equivalent `-c projects."<path>".trust_level` override on argv does
 * not clear the prompt, so there is no way to keep the setting out of the
 * user's own config. Trust is also keyed on the exact path: a directory under
 * an already-trusted parent is still untrusted, so this writes the session's
 * own working directory and never an ancestor.
 */
export class CodexTrustService {
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
    if (providerId !== CODEX_PROVIDER_ID) return;
    if (!force) {
      const { autoTrustWorktrees } = await this.deps.getSessionSettings();
      if (!autoTrustWorktrees) return;
    }

    const normalizedPath = await canonicalTrustPath(cwd);
    const configPath = path.join(homedir, CODEX_CONFIG_NAME);
    await configWriteLock.run(configPath, async () => {
      try {
        const raw = (await readLocalConfig(configPath)) ?? '';
        const next = withCodexTrustedProject(raw, normalizedPath, this.deps.log);
        if (next === null) return;
        await writeLocalConfigAtomic(configPath, next);
      } catch (error: unknown) {
        this.deps.log.warn('CodexTrustService: failed to auto-trust worktree', {
          path: normalizedPath,
          configPath,
          error: String(error),
        });
      }
    });
  }
}

/**
 * Returns the config text with `<worktreePath>` trusted, or null to leave the
 * file alone.
 *
 * The new table is appended to the existing text rather than round-tripped
 * through the parser: `config.toml` is the user's file, hand-edited and
 * commented, and re-serialising it would silently drop all of that on a write
 * they did not ask for.
 */
export function withCodexTrustedProject(
  raw: string,
  worktreePath: string,
  log: TrustLogger
): string | null {
  let config: Record<string, unknown>;
  try {
    config = toml.parse(raw) as Record<string, unknown>;
  } catch (error: unknown) {
    log.warn('CodexTrustService: refusing to edit corrupt Codex config', {
      error: String(error),
    });
    return null;
  }

  const projects = config.projects;
  if (projects !== undefined && !isPlainObject(projects)) {
    log.warn('CodexTrustService: refusing to edit non-table `projects` in Codex config');
    return null;
  }

  const existing = projects?.[worktreePath];
  if (isPlainObject(existing)) {
    // Leave an explicit "untrusted" alone: the user set it, and quietly
    // flipping it is the one thing a trust setting must never do.
    if (existing.trust_level !== undefined) return null;
    // A table without a trust level cannot be appended to a second time
    // without a duplicate-table error, and rewriting it in place means
    // re-serialising the file.
    log.warn(
      'CodexTrustService: Codex config already declares this project without a trust level',
      {
        path: worktreePath,
      }
    );
    return null;
  }

  const section = `[projects.${JSON.stringify(worktreePath)}]\ntrust_level = "trusted"\n`;
  if (raw.trim() === '') return section;
  return `${raw.replace(/\n*$/, '')}\n\n${section}`;
}
