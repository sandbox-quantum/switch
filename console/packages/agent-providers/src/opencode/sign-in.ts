import { z } from 'zod';
import { readiness, type ProviderReadiness, type SignInCheckInput } from '../readiness';
import { startOpencodeServer, stopOpencodeServer } from './server';

export const OPENCODE_LOGIN = 'opencode auth login';

/** OpenCode signs in per backend, so "signed in" means at least one backend is connected. */
export async function checkOpencodeSignIn(input: SignInCheckInput): Promise<ProviderReadiness> {
  const server = await startOpencodeServer({
    ...input,
    startupTimeoutMs: 15000,
    skills: [],
    config: { $schema: 'https://opencode.ai/config.json', permission: {}, mcp: {} },
  });
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
