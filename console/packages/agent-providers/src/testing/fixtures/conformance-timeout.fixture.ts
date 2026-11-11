// Executed only by conformance-timeout.test.ts in a child Vitest process.
// Its first case must time out so the parent can verify real hook behavior.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ProviderAdapter,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
} from '../../adapter';
import type { ProviderRuntimeEvent } from '../../events';
import { conformanceScenarios, describeConformance } from '../conformance';

const sentinel = process.env.CONFORMANCE_TIMEOUT_SENTINEL;
if (!sentinel) throw new Error('Missing timeout fixture sentinel');
let count = 0;

describeConformance('timeout-fixture', {
  timeoutMs: 1000,
  unavailableReason: async () => null,
  skip: Object.fromEntries(
    conformanceScenarios
      .filter((name) => name !== 'simple-turn' && name !== 'file-write-full-access')
      .map((name) => [name, 'Not needed for the timeout cleanup fixture'])
  ),
  createAdapter: async () => {
    const index = ++count;
    let cwd = '';
    let sessionId = '';
    let listener: ((event: ProviderRuntimeEvent) => void) | undefined;
    const emit = (event: Record<string, unknown>) => {
      listener?.({
        eventId: 'fixture',
        provider: 'timeout-fixture',
        sessionId,
        createdAt: new Date().toISOString(),
        ...event,
      } as ProviderRuntimeEvent);
    };
    return {
      provider: 'timeout-fixture',
      capabilities: {
        modelSwitchInSession: false,
        steering: false,
        resume: false,
        approvals: false,
        userInput: false,
      },
      subscribe: (value: (event: ProviderRuntimeEvent) => void) => {
        listener = value;
        return () => appendFileSync(sentinel, `unsubscribe:${index}\n`);
      },
      startSession: async (input: ProviderSessionStartInput) => {
        if (index === 2 && readFileSync(sentinel, 'utf8') !== 'unsubscribe:1\nstop:1\n') {
          throw new Error('Previous timed-out scenario was not cleaned up before the next one');
        }
        cwd = input.cwd;
        sessionId = input.sessionId;
        emit({ type: 'session.started', nativeSessionId: sessionId });
        return { sessionId, nativeSessionId: sessionId, provider: 'timeout-fixture' };
      },
      sendTurn: async (input: ProviderSendTurnInput) => {
        emit({ type: 'turn.started', turnId: input.turnId });
        if (index === 1) {
          // Start the recorder wait after Vitest has started its test deadline.
          // The test times out before that wait's own 1000ms timer can fire.
          await new Promise((resolve) => setTimeout(resolve, 100));
        } else {
          writeFileSync(join(cwd, 'marker.txt'), 'SWITCH_CONFORMANCE_OK');
          emit({
            type: 'item.completed',
            turnId: input.turnId,
            item: { id: 'write', type: 'file_change', status: 'completed', title: 'write' },
          });
          emit({ type: 'turn.completed', turnId: input.turnId, outcome: 'completed', usage: [] });
        }
        return { turnId: input.turnId };
      },
      stopAll: async () => appendFileSync(sentinel, `stop:${index}\n`),
    } as unknown as ProviderAdapter;
  },
});
