import { describe, expect, it } from 'vitest';
import { RpcError } from '@shared/lib/ipc/rpc-error';
import { describeFailure, failureText } from './describe-failure';

function rpcError(code: string, message: string, data?: Record<string, unknown>): RpcError {
  return new RpcError({
    __switchConsoleRpcError: true,
    code,
    message,
    data,
  } as unknown as ConstructorParameters<typeof RpcError>[0]);
}

describe('describeFailure', () => {
  it('leads with the caller sentence and demotes the raw error to detail', () => {
    const result = describeFailure(
      new Error('EACCES: permission denied, open ...'),
      'Could not save the agent’s settings.'
    );
    expect(result.headline).toBe('Could not save the agent’s settings.');
    expect(result.detail).toBe('EACCES: permission denied, open ...');
  });

  it('never drops the detail — it moves it', () => {
    const result = describeFailure(new Error('socket hang up'), 'Could not reset the agent.');
    expect(result.detail).toContain('socket hang up');
  });

  it('says nothing more than the fallback when there is nothing more to say', () => {
    expect(describeFailure(new Error('   '), 'Could not do the thing.')).toEqual({
      headline: 'Could not do the thing.',
      detail: null,
    });
  });

  it('recognises an expired session and gives the action, not the status', () => {
    const result = describeFailure(
      rpcError('GatewayError', 'GET /rooms failed: 401', { kind: 'unauthorized', status: 401 }),
      'Could not load the rooms.'
    );
    expect(result.headline).toBe(
      'Your session for this server expired. Sign in again, then retry.'
    );
    expect(result.detail).toBeNull();
  });

  it('turns an unreachable gateway into something a user can check', () => {
    const result = describeFailure(
      rpcError('GatewayError', 'fetch failed', { kind: 'network' }),
      'Could not load the rooms.'
    );
    expect(result.headline).toMatch(/Could not reach the server/);
    expect(result.detail).toBe('fetch failed');
  });

  it("prefers the gateway's own explanation when it reads as a sentence", () => {
    const result = describeFailure(
      rpcError('GatewayError', 'POST /rooms failed: 409', {
        kind: 'http',
        status: 409,
        detail: 'A room with that name already exists on this server.',
      }),
      'Could not create the room.'
    );
    expect(result.headline).toBe('A room with that name already exists on this server.');
    expect(result.detail).toBe('HTTP 409');
  });

  it('does not promote a raw exception fragment into the headline', () => {
    const result = describeFailure(
      rpcError('GatewayError', 'boom', {
        kind: 'http',
        status: 500,
        detail: 'TypeError: x is not a function',
      }),
      'Could not create the room.'
    );
    expect(result.headline).toBe('Could not create the room.');
    expect(result.detail).toContain('TypeError: x is not a function');
  });

  it('tells the user an auth-suspended host will not recover on its own', () => {
    const result = describeFailure(
      rpcError('HostUnreachableError', 'SSH authentication to box failed', {
        reachability: {
          sshHost: 'box',
          status: 'suspended',
          lastError: 'All configured authentication methods failed',
        },
      }),
      'Could not reach the host.'
    );
    expect(result.headline).toMatch(/will not keep retrying on its own/);
    expect(result.headline).toContain('box');
    expect(result.detail).toBe('All configured authentication methods failed');
  });

  it('tells the user an unreachable host is still being probed', () => {
    const result = describeFailure(
      rpcError('HostUnreachableError', 'Host box is unreachable', {
        reachability: { sshHost: 'box', status: 'unreachable', lastError: 'ETIMEDOUT' },
      }),
      'Could not reach the host.'
    );
    expect(result.headline).toMatch(/clears on its own/);
    expect(result.headline).not.toMatch(/will not keep retrying/);
  });

  it('passes a modeled sentence straight through', () => {
    const message =
      "prod's Switch stack is not running. Start it from the server's page, then retry.";
    expect(describeFailure(rpcError('ManagedServerStoppedError', message), 'fallback')).toEqual({
      headline: message,
      detail: null,
    });
  });
});

describe('failureText', () => {
  it('parenthesises the detail for surfaces with one slot', () => {
    expect(failureText(new Error('ECONNREFUSED'), 'Could not add the server.')).toBe(
      'Could not add the server. (ECONNREFUSED)'
    );
  });

  it('omits the parenthetical when there is no detail', () => {
    expect(failureText(new Error(''), 'Could not add the server.')).toBe(
      'Could not add the server.'
    );
  });
});
