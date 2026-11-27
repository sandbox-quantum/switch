import { describe, expect, it } from 'vitest';
import { ViewableReplica } from './viewable-replica';

/** Upstream's example initial snapshot (`shared/src/session-v1/examples.json`). */
const initial = (): never =>
  structuredClone({
    contractVersion: 1,
    throughSequence: 10,
    session: {
      sessionId: 'session-demo',
      agentId: 'agent-demo',
      provider: 'claude',
      hostId: 'host-demo',
      epoch: 'epoch-demo',
      status: 'running',
      connectivity: 'online',
      capabilities: {
        input: 'queue',
        approvals: true,
        questions: true,
        interrupt: true,
        reset: false,
        compact: false,
        modelChange: false,
        attachmentMimeTypes: [],
      },
      pendingRequestIds: ['request-demo'],
    },
    turns: [
      {
        type: 'turn.upsert',
        turnId: 'turn-demo',
        status: 'running',
        commandId: 'message-demo',
      },
    ],
    items: [],
    requests: [
      {
        requestId: 'request-demo',
        turnId: 'turn-demo',
        revision: 1,
        state: 'open',
        content: {
          kind: 'approval',
          title: 'Run project tests',
          detail: 'pnpm test',
          options: [
            {
              optionId: 'allow-once',
              label: 'Allow once',
              decision: 'accept',
            },
            {
              optionId: 'deny',
              label: 'Deny',
              decision: 'decline',
            },
          ],
        },
        expiresAt: null,
        result: null,
        decidedBy: null,
      },
    ],
    commandStatuses: [],
    nextPageToken: null,
  }) as never;

describe('ViewableReplica', () => {
  it('gives a view of the current state without copying it', () => {
    const replica = new ViewableReplica(initial());
    const view = replica.view();
    expect(replica.view()).toBe(view);
    expect(view).toEqual(replica.snapshot());
    replica.advanceCursor(30);
    expect(replica.view().throughSequence).toBe(30);
  });
});
