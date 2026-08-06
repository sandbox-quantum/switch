import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * The home-side half of an agent's Switch credentials: the API token, and
 * nothing else.
 *
 * Everything else about an agent — its id, its server, the connector's tool
 * rules — stays in `.switch/agents/<slug>.json` in the working tree, where it is
 * readable and diffable and safe to be. The token does not: a working tree gets
 * archived, synced, copied to a colleague and committed with `git add -f`, and a
 * `.gitignore` answers only the last of those. So it lives under `$HOME` at
 * `0600`, on whichever host the agent actually runs on.
 *
 * Files are keyed by **agent id**, not by name. `$HOME` is shared by every
 * project on the machine, so a name-keyed secret would have two agents called
 * `reviewer` — on two Switch deployments, or two checkouts — overwrite each
 * other's token. Ids are unique by construction.
 *
 * The layout is a contract with `@sandbox-quantum/switch-agent-runtime`, which
 * reads these files directly when no credentials reach it through the
 * environment. Changing either side means changing both.
 */

/** Directory, relative to `$HOME`, holding one secret file per agent. */
export const AGENT_SECRETS_DIR_RELATIVE = '.switch/agents';

/** Path, relative to `$HOME`, of one agent's secret. */
export function agentSecretRelativePath(agentId: string): string {
  return `${AGENT_SECRETS_DIR_RELATIVE}/${agentId}.json`;
}

/** Read/write/remove an agent's token on one host. */
export type AgentSecretStore = {
  read(agentId: string): Promise<string | null>;
  write(agentId: string, token: string): Promise<void>;
  delete(agentId: string): Promise<void>;
};

/** The file body. An object rather than a bare string, so it can gain fields. */
function encode(token: string): string {
  return `${JSON.stringify({ token }, null, 2)}\n`;
}

export function decodeAgentSecret(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const token = (parsed as { token?: unknown }).token;
    return typeof token === 'string' && token.trim() !== '' ? token.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The store on this machine's own disk.
 *
 * `writeFile`'s `mode` applies only when it creates the file, so an existing one
 * keeps whatever permissions it had — hence the explicit `chmod`. The directory
 * is created `0700` for the same reason the file is `0600`: a readable directory
 * leaks which agents exist even when their tokens are unreadable.
 */
export function createLocalAgentSecretStore(home: string = homedir()): AgentSecretStore {
  const abs = (agentId: string) => path.join(home, agentSecretRelativePath(agentId));

  return {
    async read(agentId) {
      try {
        return decodeAgentSecret(await fs.readFile(abs(agentId), 'utf8'));
      } catch {
        return null;
      }
    },

    async write(agentId, token) {
      const file = abs(agentId);
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(file, encode(token), { mode: 0o600 });
      await fs.chmod(file, 0o600);
    },

    async delete(agentId) {
      await fs.rm(abs(agentId), { force: true });
    },
  };
}

/** The subset of an execution context this store needs, so tests need no SSH. */
export type SecretExec = {
  exec(command: string, args: string[]): Promise<{ stdout: string }>;
};

/**
 * The store on a remote host, over its shell.
 *
 * Shell rather than SFTP because the path is `$HOME`-relative and only the far
 * side knows where that is — the same reason `createRemoteHomePluginFs` exists.
 * The token travels base64-encoded as a positional argument, so it never appears
 * in the command string and cannot break out of it.
 *
 * `umask 077` runs *before* the redirect, so the file is never briefly
 * world-readable the way a write-then-chmod would leave it. The trailing `chmod`
 * covers the other case, where the file already existed with looser permissions
 * and `>` truncated it without touching them.
 */
export function createRemoteAgentSecretStore(ctx: SecretExec): AgentSecretStore {
  const checked = (agentId: string): string => {
    if (!/^[A-Za-z0-9._-]+$/.test(agentId)) {
      throw new Error(`remote agent secrets: refusing an unsafe agent id: ${agentId}`);
    }
    return agentSecretRelativePath(agentId);
  };

  return {
    async read(agentId) {
      const { stdout } = await ctx.exec('sh', [
        '-c',
        'f="$HOME/$1"; if [ -f "$f" ]; then printf 1; base64 < "$f"; else printf 0; fi',
        'sh',
        checked(agentId),
      ]);
      if (stdout.startsWith('0')) return null;
      if (!stdout.startsWith('1')) {
        throw new Error(`remote agent secrets: unreadable response while reading ${agentId}`);
      }
      return decodeAgentSecret(Buffer.from(stdout.slice(1), 'base64').toString('utf8'));
    },

    async write(agentId, token) {
      await ctx.exec('sh', [
        '-c',
        'set -e; umask 077; mkdir -p "$HOME/$(dirname "$1")"; ' +
          'printf %s "$2" | base64 -d > "$HOME/$1"; chmod 600 "$HOME/$1"',
        'sh',
        checked(agentId),
        Buffer.from(encode(token), 'utf8').toString('base64'),
      ]);
    },

    async delete(agentId) {
      await ctx.exec('sh', ['-c', 'rm -f "$HOME/$1"', 'sh', checked(agentId)]);
    },
  };
}
