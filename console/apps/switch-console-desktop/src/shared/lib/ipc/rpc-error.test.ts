import type { IpcMain } from 'electron';
import { describe, expect, it } from 'vitest';
import { createRPCClient, createRPCRouter, registerRPCRouter } from './rpc';
import { RpcError } from './rpc-error';

/**
 * A stand-in for the Electron pair, wired the way the real one is: handlers go
 * in through `ipcMain.handle`, calls come out through the client's `invoke`.
 * What it deliberately does NOT do is reproduce Electron's rewriting of a
 * rejected handler — the point of the boundary is that no rejection reaches it.
 */
function harness(router: Record<string, Record<string, unknown>>) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcMain = {
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) {
      handlers.set(channel, (...args: unknown[]) => listener(null, ...args));
    },
  } as unknown as IpcMain;

  registerRPCRouter(router, ipcMain);

  return {
    handlers,
    client: createRPCClient<typeof router>(async (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no handler for ${channel}`);
      return await handler(...args);
    }),
  };
}

describe('RPC error boundary', () => {
  it('resolves rather than rejects, so Electron never rewrites the message', async () => {
    const { handlers } = harness(
      createRPCRouter({
        things: {
          fail: () => {
            throw new Error('the disk is full');
          },
        },
      })
    );

    // Resolving is the whole mechanism: a rejected `ipcMain.handle` is what
    // Electron prefixes with `Error invoking remote method '<channel>'`.
    const settled = await handlers.get('things.fail')!();
    expect(settled).toMatchObject({ message: 'the disk is full' });
  });

  it('rethrows in the renderer with the message the handler threw', async () => {
    const { client } = harness(
      createRPCRouter({
        things: {
          fail: () => {
            throw new Error('the disk is full');
          },
        },
      })
    );

    const error = await (client.things.fail as () => Promise<unknown>)().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).message).toBe('the disk is full');
    // The channel name is ours, not something a user can act on.
    expect((error as RpcError).message).not.toContain('things.fail');
    expect((error as RpcError).message).not.toContain('invoking remote method');
  });

  it('carries the error class through as a discriminator', async () => {
    class GatewayError extends Error {
      constructor(
        readonly kind: string,
        message: string,
        readonly status?: number,
        readonly detail?: string
      ) {
        super(message);
        this.name = 'GatewayError';
      }
    }

    const { client } = harness(
      createRPCRouter({
        gateway: {
          call: () => {
            throw new GatewayError('unauthorized', 'GET /rooms failed: 401', 401, 'token expired');
          },
        },
      })
    );

    const error = (await (client.gateway.call as () => Promise<unknown>)().catch(
      (e: unknown) => e
    )) as RpcError;

    // Before the boundary existed all three of these were lost, and a view had
    // no way to tell a 401 from a 500 from an unreachable host.
    expect(error.code).toBe('GatewayError');
    expect(error.stringField('kind')).toBe('unauthorized');
    expect(error.numberField('status')).toBe(401);
    expect(error.stringField('detail')).toBe('token expired');
  });

  it('trims a message that ends in captured command output', async () => {
    const { client } = harness(
      createRPCRouter({
        host: {
          probe: () => {
            throw new Error('probe failed: TypeError: fetch failed\n');
          },
        },
      })
    );

    const error = (await (client.host.probe as () => Promise<unknown>)().catch(
      (e: unknown) => e
    )) as RpcError;
    expect(error.message).toBe('probe failed: TypeError: fetch failed');
  });

  it('survives an error carrying values that cannot be cloned', async () => {
    const { client } = harness(
      createRPCRouter({
        weird: {
          call: () => {
            throw Object.assign(new Error('nope'), { retry: () => undefined, depth: 3 });
          },
        },
      })
    );

    const error = (await (client.weird.call as () => Promise<unknown>)().catch(
      (e: unknown) => e
    )) as RpcError;
    expect(error.message).toBe('nope');
    expect(error.numberField('depth')).toBe(3);
    expect(error.data.retry).toBeUndefined();
  });

  it('passes a successful result through untouched', async () => {
    const { client } = harness(
      createRPCRouter({
        things: { get: () => ({ id: 'a', nested: { ok: true } }) },
      })
    );

    await expect((client.things.get as () => Promise<unknown>)()).resolves.toEqual({
      id: 'a',
      nested: { ok: true },
    });
  });

  it('does not mistake a plain object result for a failure', async () => {
    const { client } = harness(
      createRPCRouter({
        things: { get: () => ({ message: 'looks error-ish', code: 'Error' }) },
      })
    );

    await expect((client.things.get as () => Promise<unknown>)()).resolves.toEqual({
      message: 'looks error-ish',
      code: 'Error',
    });
  });
});
