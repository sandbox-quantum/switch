import { describe, expect, it } from 'vitest';
import { RpcError } from '@shared/lib/ipc/rpc-error';
import { removeHostFailureToast } from './remove-host-failure';

function rpcError(code: string, message: string): RpcError {
  return new RpcError({
    __switchConsoleRpcError: true,
    code,
    message,
  } as unknown as ConstructorParameters<typeof RpcError>[0]);
}

describe('a host removal that did not happen', () => {
  it('says why it was refused, with the way out, when agents moved there still run on it', () => {
    const message =
      'build-box runs builder as managed agents for this Console, so it cannot be removed yet. Delete those agents first.';
    expect(removeHostFailureToast('Build Box', rpcError('MovedAgentsHereError', message))).toEqual({
      title: 'Build Box was not removed',
      description: message,
      variant: 'destructive',
    });
  });

  it('keeps the raw reason of any other failure', () => {
    expect(
      removeHostFailureToast('Build Box', rpcError('Error', 'ssh: Connection refused')).description
    ).toBe('Check that the host is reachable, then try again. (ssh: Connection refused)');
  });
});
