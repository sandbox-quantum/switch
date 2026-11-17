import { z } from 'zod';
import { execProvider } from '../provider-process';
import {
  loginWontHelp,
  readiness,
  type ProviderReadiness,
  type SignInCheckInput,
} from '../readiness';
import { startOpencodeServer, stopOpencodeServer } from './server';

export const OPENCODE_LOGIN = 'opencode auth login';

/**
 * The install that gives the OpenCode Switch runs. OpenCode 2 (`@opencode/cli`)
 * serves a different API, so its server is never found and its backends
 * cannot be listed.
 */
export const OPENCODE_SUPPORTED_INSTALL = 'npm install -g opencode-ai';

/** The major version `opencode --version` printed, or null when it printed none. */
export function opencodeMajorVersion(output: string): number | null {
  const match = /(\d+)\.\d+\.\d+/.exec(output);
  return match ? Number(match[1]) : null;
}

/** OpenCode signs in per backend, so "signed in" means at least one backend is connected. */
export async function checkOpencodeSignIn(input: SignInCheckInput): Promise<ProviderReadiness> {
  const version = await execProvider(input.binaryPath, ['--version'], {
    cwd: input.cwd,
    env: input.env,
    timeout: 15000,
  }).then(
    ({ stdout }) => opencodeMajorVersion(stdout),
    () => null
  );
  if (version !== null && version >= 2)
    return loginWontHelp(
      readiness(
        'unconfigured',
        `OpenCode ${version} isn’t supported yet. Install OpenCode 1 instead: ${OPENCODE_SUPPORTED_INSTALL}`
      )
    );
  let server;
  try {
    server = await startOpencodeServer({
      ...input,
      startupTimeoutMs: 15000,
      skills: [],
      config: { $schema: 'https://opencode.ai/config.json', permission: {}, mcp: {} },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const cause = detail.split('\n').find((line) => line.includes('no session table'));
    if (!cause) throw error;
    const chosen = input.env.OPENCODE_DB;
    return loginWontHelp(
      readiness(
        'unconfigured',
        chosen
          ? `OPENCODE_DB points at ${chosen}, which OpenCode 1 cannot open; OpenCode Desktop 2 may have migrated it. Point OPENCODE_DB at a new file, or unset it. (${cause.trim()})`
          : `OpenCode 1 cannot open its database. (${cause.trim()})`
      )
    );
  }
  try {
    const response = await fetch(`${server.url}/provider`, {
      headers: { Authorization: server.authorization },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return readiness('unknown', 'Could not check OpenCode backend connections.');
    const inventory = z.object({ connected: z.array(z.string()) }).parse(await response.json());
    return inventory.connected.length
      ? readiness(
          'authenticated',
          'OpenCode has connected backends. Model access depends on the selected backend.'
        )
      : readiness(
          'unconfigured',
          'No connected OpenCode backends were reported. Configure a backend; local models may need no sign-in.'
        );
  } finally {
    await stopOpencodeServer(server);
  }
}
