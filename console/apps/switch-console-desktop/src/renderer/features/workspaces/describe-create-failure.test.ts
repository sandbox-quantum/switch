import { describe, expect, it } from 'vitest';
import { RpcError } from '@shared/lib/ipc/rpc-error';
import { createWorkspaceFailureText } from './describe-create-failure';

function gatewayError(status: number, detail: string): RpcError {
  return new RpcError({
    __switchConsoleRpcError: true,
    code: 'GatewayError',
    message: `Gateway returned ${status}: ${detail}`,
    data: { kind: 'http', status, detail },
  } as unknown as ConstructorParameters<typeof RpcError>[0]);
}

const FALLBACK = 'Local dev could not create it.';

describe('creating a workspace, when it fails', () => {
  /**
   * The gateway's own words are `Slug already taken: acme-robotics` — no
   * terminal punctuation, so the shared description does not read it as a
   * sentence and shows it as diagnostics instead. What reached the user was a
   * status code and a slug they never typed, for the one refusal that is
   * entirely about what they did type.
   */
  it('blames the name for a name conflict, and says nothing about slugs', () => {
    const text = createWorkspaceFailureText(
      gatewayError(409, 'Slug already taken: acme-robotics'),
      'Local dev',
      FALLBACK
    );

    expect(text).toContain('already goes by that name');
    expect(text).toContain('Local dev');
    expect(text).not.toContain('acme-robotics');
    expect(text).not.toContain('409');
  });

  // The whole point of the rewrite is that the name is at fault. Saying so over
  // an expired session sends the user to rename a workspace when what they have
  // to do is sign in.
  it('leaves every other gateway refusal to the shared description', () => {
    const expired = new RpcError({
      __switchConsoleRpcError: true,
      code: 'GatewayError',
      message: 'Gateway returned 401',
      data: { kind: 'unauthorized', status: 401 },
    } as unknown as ConstructorParameters<typeof RpcError>[0]);

    expect(createWorkspaceFailureText(expired, 'Local dev', FALLBACK)).toContain('Sign in again');
  });

  it('keeps the caller’s sentence for a failure it cannot place', () => {
    const text = createWorkspaceFailureText(new Error('socket hang up'), 'Local dev', FALLBACK);

    expect(text).toContain(FALLBACK);
    expect(text).toContain('socket hang up');
  });
});
