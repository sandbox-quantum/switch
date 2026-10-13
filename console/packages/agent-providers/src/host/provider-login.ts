import { join } from 'node:path';
import { z } from 'zod';
import { refineVertexCredential } from '../sealed-login';
import { parseVertexLogin, VERTEX_CREDENTIALS_FILE } from '../vertex-login';

/** A provider login Switch holds for an agent, as an agent host applies it (`materializeHostedProvider`). */
export const hostedCredentialSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('revoked') }),
  z
    .object({
      status: z.literal('connected'),
      revision: z.string(),
      provider: z.enum(['claude', 'codex', 'cursor', 'opencode', 'antigravity']),
      kind: z.enum(['api-key', 'setup-token', 'auth-json', 'vertex']),
      credential: z.string().min(1).max(16384),
    })
    .superRefine((login, context) => {
      if (login.kind === 'vertex' && login.provider !== 'claude')
        context.addIssue({
          code: 'custom',
          path: ['kind'],
          message: 'Only Claude signs in through Vertex AI.',
        });
      refineVertexCredential(login, context);
    }),
]);
export type HostedCredential = z.infer<typeof hostedCredentialSchema>;

/**
 * The environment the sessions of an agent host rooted at `root` run with to
 * use `credential`: the provider's token variable, or the directory
 * `materializeHostedProvider` writes its login file into under `root`, or for
 * Claude on Vertex AI the project, the region and that file. What
 * an agents controller puts in the agent's configuration, so the sessions
 * get it whatever environment they would otherwise inherit.
 */
export function providerLoginEnvironment(
  root: string,
  credential: Extract<HostedCredential, { status: 'connected' }>
): Record<string, string> {
  if (credential.kind === 'vertex' && credential.provider !== 'claude')
    throw new Error('Only Claude signs in through Vertex AI.');
  switch (credential.provider) {
    case 'claude': {
      // Blank is unset to Claude Code: a variable the sessions inherit for
      // another way of signing in would otherwise be used instead of this one.
      const cleared = { ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' };
      if (credential.kind === 'vertex') {
        const login = parseVertexLogin(credential.credential);
        return {
          ...cleared,
          CLAUDE_CODE_USE_VERTEX: '1',
          ANTHROPIC_VERTEX_PROJECT_ID: login.project,
          CLOUD_ML_REGION: login.region,
          GOOGLE_APPLICATION_CREDENTIALS: join(root, VERTEX_CREDENTIALS_FILE),
        };
      }
      return {
        ...cleared,
        CLAUDE_CODE_USE_VERTEX: '',
        ...(credential.kind === 'api-key'
          ? { ANTHROPIC_API_KEY: credential.credential }
          : { CLAUDE_CODE_OAUTH_TOKEN: credential.credential }),
      };
    }
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
