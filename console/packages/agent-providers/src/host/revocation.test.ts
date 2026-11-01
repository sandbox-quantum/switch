import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { connectParent, type ParentPort } from './session-channel';
import { ToolCallQueue } from './tool-queue';

describe('Push IPC Grant Revocation', () => {
  it('receives revoke-grant IPC and terminates queued and active work in <500ms', async () => {
    const port = new EventEmitter() as unknown as ParentPort;
    const sentMessages: unknown[] = [];
    port.send = (msg: unknown) => sentMessages.push(msg);
    port.connected = true;

    const channel = connectParent(port);

    let processTerminated = false;
    const queue = new ToolCallQueue({
      onQuarantineProcess: async () => {
        processTerminated = true;
      },
    });

    const revokedServices: string[] = [];
    const t0 = performance.now();

    channel.onRevokeGrant(async (service) => {
      revokedServices.push(service);
      await queue.terminateAll(new Error(`Service grant ${service} was revoked`));
    });

    // Enqueue an active task and a queued task
    const task1 = queue.enqueue('call-1', () => new Promise<string>(() => {}));
    const task2 = queue.enqueue('call-2', async () => 'pending-output');

    const task1Expectation = expect(task1).rejects.toThrow('Service grant mongodb was revoked');
    const task2Expectation = expect(task2).rejects.toThrow('Service grant mongodb was revoked');

    // Simulate parent sending 'revoke-grant' message over IPC
    port.emit('message', { kind: 'revoke-grant', service: 'mongodb' });

    await task1Expectation;
    await task2Expectation;
    const tDuration = performance.now() - t0;

    expect(revokedServices).toEqual(['mongodb']);
    expect(processTerminated).toBe(true);
    // Target is <500ms
    expect(tDuration).toBeLessThan(500);
  });
});
