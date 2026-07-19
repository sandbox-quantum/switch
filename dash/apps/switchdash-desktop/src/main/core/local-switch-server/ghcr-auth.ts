import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { GH_EXECUTABLE, getGithubTokenFromGhCli } from '@main/core/updates/github-token';
import { log } from '@main/lib/logger';
import { GHCR_REGISTRY } from './constants';
import { DOCKER_EXECUTABLE } from './docker';

const execFileAsync = promisify(execFile);

/** The signed-in GitHub username, needed as the `docker login` user for a GHCR
 * personal-access token. Null when `gh` is missing / not authenticated. */
async function getGithubLogin(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(GH_EXECUTABLE, ['api', 'user', '--jq', '.login'], {
      timeout: 10_000,
    });
    const login = stdout.trim();
    return login.length > 0 ? login : null;
  } catch {
    return null;
  }
}

/** `docker login <registry> -u <user> --password-stdin`, feeding the token over
 * stdin so it never lands in the process argv / command history. */
function dockerLoginWithToken(registry: string, username: string, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(DOCKER_EXECUTABLE, ['login', registry, '-u', username, '--password-stdin']);
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker login ${registry} failed (exit ${code}): ${stderr.trim()}`));
    });
    child.stdin.write(token);
    child.stdin.end();
  });
}

/**
 * Authenticate Docker to GHCR using the user's existing `gh` login, so private
 * release images pull before the public-repo flip (CHOO-1260). When no gh token
 * is available we warn and proceed: if the images are already public this is a
 * no-op, and if they are private the subsequent `docker compose up` fails loudly
 * on the pull — which surfaces the real problem rather than hiding it here.
 */
export async function ensureGhcrLogin(): Promise<void> {
  const token = await getGithubTokenFromGhCli();
  if (!token) {
    log.warn(
      'local-switch-server: no gh CLI token; skipping GHCR login (private image pulls will fail)'
    );
    return;
  }
  const username = await getGithubLogin();
  if (!username) {
    log.warn('local-switch-server: could not resolve GitHub login; skipping GHCR login');
    return;
  }
  await dockerLoginWithToken(GHCR_REGISTRY, username, token);
  log.info('local-switch-server: authenticated Docker to GHCR');
}
