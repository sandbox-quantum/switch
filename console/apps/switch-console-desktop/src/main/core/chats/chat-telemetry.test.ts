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
    [new ChatApiError('REQUEST_REUSED', 'Already used.', 409), 'refused'],
    [new ChatApiError('UNAVAILABLE', 'Try later.', 503), 'server_error'],
    [new ChatApiError('UNAUTHENTICATED', 'Sign in.', 401), 'unauthenticated'],
    [new GatewayError('unauthorized', 'expired'), 'unauthenticated'],
    [new GatewayError('network', 'offline'), 'network'],
    [new GatewayError('http', '404 Not Found', 404), 'refused'],
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
  it('reports a success and returns the result', async () => {
    const emit = vi.fn();

    await expect(reportingChatCall(server, async () => 'posted', emit)).resolves.toBe('posted');

    expect(emit).toHaveBeenCalledExactlyOnceWith({
      server_kind: 'cloud',
      outcome: 'success',
      failure_reason: 'none',
    });
  });

  it('reports a failure and still throws it to the caller', async () => {
    const emit = vi.fn();
    const refusal = new ChatApiError('NOT_A_MEMBER', 'You are not in this chat.', 403);

    await expect(
      reportingChatCall(
        server,
        async () => {
          throw refusal;
        },
        emit
      )
    ).rejects.toBe(refusal);

    expect(emit).toHaveBeenCalledExactlyOnceWith({
      server_kind: 'cloud',
      outcome: 'failure',
      failure_reason: 'refused',
    });
  });
});
