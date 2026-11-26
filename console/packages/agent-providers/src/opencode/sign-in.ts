import { z } from 'zod';
import {
  loginWontHelp,
  readiness,
  type ProviderReadiness,
  type SignInCheckInput,
} from '../readiness';
import { startOpencodeServer, stopOpencodeServer } from './server';

export const OPENCODE_LOGIN = 'opencode auth login';

/** OpenCode signs in per backend, so "signed in" means at least one backend is connected. */
export async function checkOpencodeSignIn(input: SignInCheckInput): Promise<ProviderReadiness> {
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
