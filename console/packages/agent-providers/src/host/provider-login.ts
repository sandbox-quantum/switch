import { join } from 'node:path';
import { z } from 'zod';
import { refineVertexCredential } from '../sealed-login';
import {
  parseVertexLogin,
  signsInThroughVertex,
  VERTEX_CREDENTIALS_FILE,
  VERTEX_PROVIDERS_ONLY,
  vertexEnvironment,
} from '../vertex-login';

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
      if (login.kind === 'vertex' && !signsInThroughVertex(login.provider))
        context.addIssue({
          code: 'custom',
          path: ['kind'],
          message: VERTEX_PROVIDERS_ONLY,
        });
      refineVertexCredential(login, context);
    }),
]);
export type HostedCredential = z.infer<typeof hostedCredentialSchema>;

/**
 * The environment the sessions of an agent host rooted at `root` run with to
 * use `credential`: the provider's token variable, or the directory
 * `materializeHostedProvider` writes its login file into under `root`, or for
 * Claude or Antigravity on Vertex AI the project, the region and that file. What
 * an agent controller puts in the agent's configuration, so the sessions
 * get it whatever environment they would otherwise inherit.
 */
export function providerLoginEnvironment(
  root: string,
  credential: Extract<HostedCredential, { status: 'connected' }>
): Record<string, string> {
  if (credential.kind === 'vertex' && !signsInThroughVertex(credential.provider))
    throw new Error(VERTEX_PROVIDERS_ONLY);
  switch (credential.provider) {
    case 'claude': {
      // Blank is unset to Claude Code: a variable the sessions inherit for
      // another way of signing in would otherwise be used instead of this one.
      const cleared = { ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' };
      if (credential.kind === 'vertex')
        return {
          ...cleared,
          ...vertexEnvironment(
            'claude',
            parseVertexLogin(credential.credential),
            join(root, VERTEX_CREDENTIALS_FILE)
          ),
        };
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
      // Blank, so a Gemini API key the sessions inherit is not signed in with instead.
      return credential.kind === 'vertex'
        ? {
            GEMINI_API_KEY: '',
            ...vertexEnvironment(
              'antigravity',
              parseVertexLogin(credential.credential),
              join(root, VERTEX_CREDENTIALS_FILE)
            ),
          }
        : { GEMINI_HOME: join(root, 'provider-home') };
  }
}
