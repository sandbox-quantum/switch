import type { IExecutionContext } from '@main/core/execution-context/types';
import { log } from '@main/lib/logger';
import { GHCR_REGISTRY } from '../constants';
import { getLocalGithubIdentity } from '../ghcr-auth';

/** The GitHub login of an authenticated `gh` on the remote host, or null when
 * `gh` is missing or not signed in (`gh api user` needs an auth token). */
async function remoteGhUsername(ctx: IExecutionContext): Promise<string | null> {
  try {
    const { stdout } = await ctx.exec('gh', ['api', 'user', '--jq', '.login'], { timeout: 15_000 });
    const login = stdout.trim();
    return login.length > 0 ? login : null;
  } catch {
    return null;
  }
}

/** Forward the desktop's GitHub token to the remote `docker login`: write it to
 * a 0600 temp file on the host, `docker login --password-stdin < file`, delete
 * it. Keeps the token out of argv/history on the remote. */
async function loginWithForwardedToken(
  host: {
    ctx: IExecutionContext;
    writeFile: (relPath: string, content: string, mode?: number) => Promise<void>;
  },
  username: string,
  token: string
): Promise<void> {
  const tokenFile = '.ghcr-token';
  await host.writeFile(tokenFile, token, 0o600);
  try {
    await host.ctx.exec('sh', [
      '-c',
      `docker login ${GHCR_REGISTRY} -u ${username} --password-stdin < ${tokenFile}`,
    ]);
  } finally {
    // Remove the token file whether or not the login succeeded.
    await host.ctx.exec('rm', ['-f', tokenFile]).catch(() => {});
  }
}

/**
 * Authenticate a remote host's Docker to GHCR so private release images pull
 * before the public-repo flip (CHOO-1260).
 *
 * Prefers the DESKTOP's `gh` identity (forwarded over the SSH connection): it is
 * the identity the operator already uses to pull these images in local-server
 * mode, so it is known to have read access to every release package. The remote
 * host's own `gh` is only a fallback — a host may have `gh` logged in as a
 * different or less-privileged account that lacks access to some package, which
 * would 403 mid-pull. If neither is available we warn and proceed: a public
 * image is a no-op, and a private one fails loudly on the subsequent pull.
 */
export async function ensureRemoteGhcrLogin(host: {
  ctx: IExecutionContext;
  writeFile: (relPath: string, content: string, mode?: number) => Promise<void>;
  label: string;
}): Promise<void> {
  const { ctx, label } = host;

  const identity = await getLocalGithubIdentity();
  if (identity) {
    await loginWithForwardedToken(host, identity.username, identity.token);
    log.info(
      `remote-switch-server: authenticated ${label} Docker to GHCR via forwarded desktop token`
    );
    return;
  }

  const remoteUser = await remoteGhUsername(ctx);
  if (remoteUser) {
    await ctx.exec('sh', [
      '-c',
      `gh auth token | docker login ${GHCR_REGISTRY} -u ${remoteUser} --password-stdin`,
    ]);
    log.info(`remote-switch-server: authenticated ${label} Docker to GHCR via its own gh login`);
    return;
  }

  log.warn(
    `remote-switch-server: no desktop gh token and no gh login on ${label}; skipping GHCR login (private image pulls will fail)`
  );
}
