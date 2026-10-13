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
  // A conflict is a deployment that keeps to one workspace, or a create racing
  // another — never the name, which may repeat. Telling the user to rename sent
  // them round in circles on a server that would refuse every name.
  it('says what the server said for a conflict, not that the name is taken', () => {
    const text = createWorkspaceFailureText(
      gatewayError(
        409,
        'This server is not isolating tenants: it runs only because DB_REQUIRE_RESTRICTED_ROLE is false, which allows a single workspace.'
      ),
      'Local dev',
      FALLBACK
    );

    expect(text).toContain('Local dev could not create it');
    expect(text).toContain('allows a single workspace');
    expect(text).not.toContain('already goes by that name');
    expect(text).not.toContain('409');
  });

  // Only the conflict is the server's own sentence; an expired session still
  // says to sign in again.
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
