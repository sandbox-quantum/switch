import { describe, expect, it, vi } from 'vitest';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

/**
 * What a chat action reports: how the call went, as a closed code, and whom a
 * message named, as a kind. Never a refusal's code or message, and never who.
 */

const { GatewayError } = vi.hoisted(() => ({
  GatewayError: class extends Error {
    constructor(
      readonly kind: 'unauthorized' | 'http' | 'network',
      message: string,
      readonly status?: number
    ) {
      super(message);
    }
  },
}));

vi.mock('@main/core/switch-servers/gateway-client', () => ({
  GatewayError,
  gatewayFetch: vi.fn(),
}));
vi.mock('@main/core/switch-servers/servers-store', () => ({ serverKindOf: () => 'cloud' }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));

const { chatFailureReason, chatMentions, reportingChatCall } = await import('./chat-telemetry');
const { ChatApiError } = await import('./gateway');

const server = { id: 'server' } as SwitchServer;

describe('chatFailureReason', () => {
  it.each([
    [new ChatApiError('NOT_A_MEMBER', 'You are not in this chat.', 403), 'refused'],
    [new ChatApiError('REQUEST_REUSED', 'Already used.', 409), 'request_reused'],
    [new ChatApiError('SLOW_DOWN', 'Too many.', 429), 'rate_limited'],
    [new ChatApiError('UNAVAILABLE', 'Try later.', 503), 'server_error'],
    [new ChatApiError('UNAUTHENTICATED', 'Sign in.', 401), 'unauthenticated'],
    [new GatewayError('unauthorized', 'expired'), 'unauthenticated'],
    [new GatewayError('network', 'offline'), 'network'],
    [new GatewayError('http', '404 Not Found', 404), 'refused'],
    [new GatewayError('http', '401 Unauthorized', 401), 'unauthenticated'],
    [new GatewayError('http', '408 Request Timeout', 408), 'network'],
    [new GatewayError('http', '429 Too Many Requests', 429), 'rate_limited'],
    [new GatewayError('http', '502 Bad Gateway', 502), 'server_error'],
    [new Error('anything else'), 'error'],
  ])('reports %s as %s', (error, reason) => {
    expect(chatFailureReason(error)).toBe(reason);
  });
});

describe('chatMentions', () => {
  it('says whom a message named from ids or spans, never which', () => {
    expect(chatMentions({})).toBe('none');
    expect(chatMentions({ mentionAgentIds: ['a1'] })).toBe('agent');
    expect(chatMentions({ mentionUserIds: ['u1'] })).toBe('person');
    expect(chatMentions({ mentionSpans: [{ kind: 'user', id: 'u1', offset: 0, length: 3 }] })).toBe(
      'person'
    );
    expect(
      chatMentions({
        mentionAgentIds: ['a1'],
        mentionSpans: [{ kind: 'user', id: 'u1', offset: 0, length: 3 }],
      })
    ).toBe('both');
  });
});

describe('reportingChatCall', () => {
  it('reports a success with its result and returns it', async () => {
    const emit = vi.fn();

    await expect(reportingChatCall(server, null, async () => 'posted', emit)).resolves.toBe(
      'posted'
    );

    expect(emit).toHaveBeenCalledExactlyOnceWith(
      { server_kind: 'cloud', outcome: 'success', failure_reason: 'none' },
      'posted'
    );
  });

  it('reports a failure and still throws it to the caller', async () => {
    const emit = vi.fn();
    const refusal = new ChatApiError('NOT_A_MEMBER', 'You are not in this chat.', 403);

    await expect(
      reportingChatCall(
        server,
        null,
        async () => {
          throw refusal;
        },
        emit
      )
    ).rejects.toBe(refusal);

    expect(emit).toHaveBeenCalledExactlyOnceWith(
      { server_kind: 'cloud', outcome: 'failure', failure_reason: 'refused' },
      null
    );
  });

  it('a report that throws changes neither a success nor a failure', async () => {
    const emit = () => {
      throw new Error('telemetry broke');
    };
    const refusal = new ChatApiError('NOT_A_MEMBER', 'You are not in this chat.', 403);

    await expect(reportingChatCall(server, null, async () => 'posted', emit)).resolves.toBe(
      'posted'
    );
    await expect(
      reportingChatCall(
        server,
        null,
        async () => {
          throw refusal;
        },
        emit
      )
    ).rejects.toBe(refusal);
  });

  it('a retry of a request already reported as done is not counted again', async () => {
    const emit = vi.fn();
    const other = { id: 'other' } as SwitchServer;

    await reportingChatCall(server, 'r1', async () => 'posted', emit);
    await reportingChatCall(server, 'r1', async () => 'posted', emit);
    await reportingChatCall(other, 'r1', async () => 'posted', emit);
    await reportingChatCall(server, null, async () => 'posted', emit);
    await reportingChatCall(server, null, async () => 'posted', emit);

    expect(emit).toHaveBeenCalledTimes(4);
  });

  it('a failed attempt does not stop its retry from being reported', async () => {
    const emit = vi.fn();

    await expect(
      reportingChatCall(
        server,
        'r2',
        async () => {
          throw new GatewayError('network', 'offline');
        },
        emit
      )
    ).rejects.toThrow('offline');
    await reportingChatCall(server, 'r2', async () => 'posted', emit);

    expect(emit.mock.calls.map(([outcome]) => outcome.outcome)).toEqual(['failure', 'success']);
  });
});
