import { join } from 'node:path';
import { z } from 'zod';

/** A provider login Switch holds for an agent, as an agent host applies it (`materializeHostedProvider`). */
export const hostedCredentialSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('revoked') }),
  z.object({
    status: z.literal('connected'),
    revision: z.string(),
    provider: z.enum(['claude', 'codex', 'cursor', 'opencode', 'antigravity']),
    kind: z.enum(['api-key', 'setup-token', 'auth-json']),
    credential: z.string().min(1).max(16384),
  }),
]);
export type HostedCredential = z.infer<typeof hostedCredentialSchema>;

/**
 * The environment the sessions of an agent host rooted at `root` run with to
 * use `credential`: the provider's token variable, or the directory
 * `materializeHostedProvider` writes its login file into under `root`. What
 * an agents controller puts in the agent's configuration, so the sessions
 * get it whatever environment they would otherwise inherit.
 */
export function providerLoginEnvironment(
  root: string,
  credential: Extract<HostedCredential, { status: 'connected' }>
): Record<string, string> {
  switch (credential.provider) {
    case 'claude':
      return credential.kind === 'api-key'
        ? { ANTHROPIC_API_KEY: credential.credential }
        : { CLAUDE_CODE_OAUTH_TOKEN: credential.credential };
    case 'cursor':
      return { CURSOR_API_KEY: credential.credential };
    case 'codex':
      return { CODEX_HOME: join(root, 'provider-home') };
    case 'opencode':
      return { XDG_DATA_HOME: join(root, 'provider-data') };
    case 'antigravity':
      return { GEMINI_HOME: join(root, 'provider-home') };
  }
}
