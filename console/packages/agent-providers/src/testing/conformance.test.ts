import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderAdapter, ProviderSendTurnInput, ProviderSessionStartInput } from '../adapter';
import type { ProviderRuntimeEvent } from '../events';
import { conformanceScenarios, describeConformance, startConformanceSession } from './conformance';

describe('late conformance session startup', () => {
  it('stops an adapter that registers a session after its scenario closes', async () => {
    let finish!: (value: { sessionId: string; nativeSessionId: string; provider: string }) => void;
    const started = new Promise<{ sessionId: string; nativeSessionId: string; provider: string }>(
      (resolve) => {
        finish = resolve;
      }
    );
    const stopAll = vi.fn(async () => {});
    const adapter = {
      startSession: vi.fn(() => started),
      stopAll,
    } as unknown as ProviderAdapter;
    const scope = { closed: false };
    const result = startConformanceSession(scope, adapter, {} as ProviderSessionStartInput);
    scope.closed = true;
    finish({ sessionId: 'late', nativeSessionId: 'late', provider: 'fixture' });
    await expect(result).rejects.toThrow('Conformance scenario already ended');
    expect(stopAll).toHaveBeenCalledOnce();
  });
});

describe('conformance scenario cleanup', () => {
  const completed: Array<{ stopCount: number; cwd: string }> = [];

  describeConformance('cleanup-fixture', {
    unavailableReason: async () => null,
    skip: Object.fromEntries(
      conformanceScenarios
        .filter((name) => name !== 'simple-turn' && name !== 'file-write-full-access')
        .map((name) => [name, 'Not needed for this lifecycle regression'])
    ),
    createAdapter: async () => {
      const previous = completed.at(-1);
      if (previous) {
        // This must already hold when the next scenario starts, rather than
        // only after the entire suite has completed.
        expect(previous.stopCount).toBe(1);
        expect(existsSync(previous.cwd)).toBe(false);
      }

      let cwd = '';
      let sessionId = '';
      let active = false;
      const listeners = new Set<(event: ProviderRuntimeEvent) => void>();
      const emit = (event: Record<string, unknown>) => {
        const full = {
          eventId: 'fixture-event',
          provider: 'cleanup-fixture',
          sessionId,
          createdAt: new Date().toISOString(),
          ...event,
        } as ProviderRuntimeEvent;
        for (const listener of listeners) listener(full);
      };
      const entry = {
        stopCount: 0,
        get cwd() {
          return cwd;
        },
      };
      const stopAll = async () => {
        entry.stopCount++;
        active = false;
      };
      completed.push(entry);
      const adapter = {
        provider: 'cleanup-fixture',
        capabilities: {
          modelSwitchInSession: false,
          steering: false,
          resume: false,
          approvals: false,
          userInput: false,
        },
        subscribe: (listener: (event: ProviderRuntimeEvent) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        startSession: async (input: ProviderSessionStartInput) => {
          cwd = input.cwd;
          sessionId = input.sessionId;
          active = true;
          emit({ type: 'session.started', nativeSessionId: sessionId });
          return { sessionId, nativeSessionId: sessionId, provider: 'cleanup-fixture' };
        },
        sendTurn: async (input: ProviderSendTurnInput) => {
          emit({ type: 'turn.started', turnId: input.turnId });
          if (input.text.startsWith('Create a file')) {
            await writeFile(`${cwd}/marker.txt`, 'SWITCH_CONFORMANCE_OK');
            emit({
              type: 'item.completed',
              turnId: input.turnId,
              item: { id: 'write', type: 'file_change', status: 'completed', title: 'write' },
            });
          } else {
            emit({
              type: 'content.delta',
              turnId: input.turnId,
              itemId: 'answer',
              delta: 'SWITCH_CONFORMANCE_OK',
            });
          }
          emit({ type: 'turn.completed', turnId: input.turnId, outcome: 'completed', usage: [] });
          return { turnId: input.turnId };
        },
        stopSession: async () => {
          active = false;
          emit({ type: 'session.exited', reason: 'stopped' });
        },
        stopAll,
        hasSession: () => active,
      } as unknown as ProviderAdapter;
      return adapter;
    },
  });

  it('cleans the last scenario before returning to its parent suite', () => {
    expect(completed).toHaveLength(2);
    for (const entry of completed) {
      expect(entry.stopCount).toBe(1);
      expect(existsSync(entry.cwd)).toBe(false);
    }
  });
});
