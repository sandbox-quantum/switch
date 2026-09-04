import type { ApprovalOption, UserInputQuestion } from '@switch-console/agent-providers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderSessionRuntime } from '@main/core/agent-runtime/types';
import { parseRequestAnswer, providerRoomRelay, renderRequest } from './provider-room-relay';
import type { MessagePayload } from './switch-event-format';

vi.mock('@main/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const creds = { agentId: 'agent-1', apiEndpoint: 'https://switch.test', token: 'tok' };

const APPROVAL_OPTIONS: ApprovalOption[] = [
  { decision: 'accept', label: 'Allow once' },
  { decision: 'acceptForSession', label: 'Allow for the rest of this session' },
  { decision: 'decline', label: 'Deny' },
];

const QUESTION: UserInputQuestion = {
  id: '0',
  header: 'Colour',
  question: 'Which colour?',
  options: [
    { label: 'green', value: 'green' },
    { label: 'blue', value: 'blue' },
  ],
  multiSelect: false,
  allowCustomAnswer: true,
};

function approval() {
  return {
    kind: 'approval' as const,
    requestId: 'r1',
    title: 'rm -rf build',
    options: APPROVAL_OPTIONS,
  };
}

function question(overrides: Partial<UserInputQuestion> = {}) {
  return {
    kind: 'question' as const,
    requestId: 'q1',
    questions: [{ ...QUESTION, ...overrides }],
  };
}

function message(body: string): MessagePayload {
  return {
    addressed: true,
    sender: '@someone:switch',
    sender_name: 'Someone',
    message_id: 'msg-1',
    body,
    timestamp: 1,
    thread_id: null,
    attachments: [],
  } as unknown as MessagePayload;
}

describe('parseRequestAnswer', () => {
  describe('approvals', () => {
    it('takes a bare option number', () => {
      expect(parseRequestAnswer('2', approval())).toMatchObject({
        kind: 'approval',
        decision: 'acceptForSession',
      });
    });

    it('takes a number written the way people write lists', () => {
      expect(parseRequestAnswer('3.', approval())).toMatchObject({ decision: 'decline' });
      expect(parseRequestAnswer('1)', approval())).toMatchObject({ decision: 'accept' });
    });

    it('ignores the mention that addressed the agent', () => {
      expect(parseRequestAnswer('@bot 1', approval())).toMatchObject({ decision: 'accept' });
      expect(parseRequestAnswer('@bot: deny', approval())).toMatchObject({ decision: 'decline' });
    });

    it('takes an option label, whatever the case', () => {
      expect(parseRequestAnswer('ALLOW ONCE', approval())).toMatchObject({ decision: 'accept' });
    });

    it('takes plain English on either side', () => {
      for (const word of ['yes', 'Allow', 'approve', 'ok']) {
        expect(parseRequestAnswer(word, approval())).toMatchObject({ decision: 'accept' });
      }
      for (const word of ['no', 'DENY', 'reject', 'decline']) {
        expect(parseRequestAnswer(word, approval())).toMatchObject({ decision: 'decline' });
      }
      expect(parseRequestAnswer('always', approval())).toMatchObject({
        decision: 'acceptForSession',
      });
    });

    it('refuses a number that is not one of the options', () => {
      expect(parseRequestAnswer('9', approval())).toEqual({ kind: 'unparsed' });
    });

    it('refuses anything it cannot read as a decision', () => {
      expect(parseRequestAnswer('maybe later?', approval())).toEqual({ kind: 'unparsed' });
      expect(parseRequestAnswer('   ', approval())).toEqual({ kind: 'unparsed' });
    });
  });

  describe('questions', () => {
    it('takes an option by number, answering with the option value', () => {
      expect(parseRequestAnswer('1', question())).toEqual({
        kind: 'answers',
        answers: { '0': 'green' },
        summary: 'green',
      });
    });

    it('takes an option by label', () => {
      expect(parseRequestAnswer('Blue', question())).toMatchObject({ answers: { '0': 'blue' } });
    });

    it('takes free text when the question allows one', () => {
      expect(parseRequestAnswer('teal, actually', question())).toEqual({
        kind: 'answers',
        answers: { '0': 'teal, actually' },
        summary: 'teal, actually',
      });
    });

    it('refuses free text when the question does not allow one', () => {
      expect(parseRequestAnswer('teal', question({ allowCustomAnswer: false }))).toEqual({
        kind: 'unparsed',
      });
    });
  });
});

describe('renderRequest', () => {
  it('numbers the approval options and says how to answer', () => {
    const rendered = renderRequest(approval());
    expect(rendered).toContain('1. Allow once');
    expect(rendered).toContain('3. Deny');
    expect(rendered).toContain('rm -rf build');
    expect(rendered).toMatch(/allow \/ deny/);
  });

  it('offers a custom answer only when the question takes one', () => {
    expect(renderRequest(question())).toContain('or type your own answer');
    expect(renderRequest(question({ allowCustomAnswer: false }))).not.toContain(
      'or type your own answer'
    );
  });
});

describe('ProviderRoomRelay', () => {
  let runtime: ProviderSessionRuntime;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    providerRoomRelay.unbind('session-1');
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
    runtime = {
      sendTurn: vi.fn(async () => ({ turnId: 't1' })),
      interrupt: vi.fn(async () => {}),
      respondToRequest: vi.fn(async () => {}),
      respondToUserInput: vi.fn(async () => {}),
      notice: vi.fn(),
      getTranscript: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    } as unknown as ProviderSessionRuntime;
    providerRoomRelay.bind({
      sessionId: 'session-1',
      creds,
      room: () => 'room-1',
      runtime,
    });
  });

  function postedBodies(): string[] {
    return fetchMock.mock.calls.map(
      (call) => JSON.parse((call[1] as RequestInit).body as string).content as string
    );
  }

  it('posts an approval into the room and answers the reply', async () => {
    providerRoomRelay.onRequestOpened('session-1', {
      type: 'request.opened',
      requestId: 'r1',
      title: 'rm -rf build',
      options: APPROVAL_OPTIONS,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(postedBodies()[0]).toContain('I need permission to continue');

    expect(providerRoomRelay.consume('session-1', message('1'))).toBe(true);
    await vi.waitFor(() => expect(runtime.respondToRequest).toHaveBeenCalled());
    expect(runtime.respondToRequest).toHaveBeenCalledWith('r1', 'accept', 'room');
    await vi.waitFor(() => expect(postedBodies()).toContain('✅ Allow once'));
  });

  it('answers a question and acknowledges what it answered', async () => {
    providerRoomRelay.onRequestOpened('session-1', {
      type: 'user-input.requested',
      requestId: 'q1',
      questions: [QUESTION],
    });
    expect(providerRoomRelay.consume('session-1', message('green'))).toBe(true);
    await vi.waitFor(() => expect(runtime.respondToUserInput).toHaveBeenCalled());
    expect(runtime.respondToUserInput).toHaveBeenCalledWith('q1', { '0': 'green' });
    await vi.waitFor(() => expect(postedBodies()).toContain('✅ Answered: green'));
  });

  /**
   * A reply that does not parse is still a reply, not a new instruction: the
   * agent is blocked on the very request it answers, so handing it over as a
   * turn is how a session deadlocks on its own prompt.
   */
  it('keeps waiting after an unreadable reply, and says so in the room', async () => {
    providerRoomRelay.onRequestOpened('session-1', {
      type: 'request.opened',
      requestId: 'r1',
      title: 'rm -rf build',
      options: APPROVAL_OPTIONS,
    });
    expect(providerRoomRelay.consume('session-1', message('what does that do?'))).toBe(true);
    await vi.waitFor(() =>
      expect(postedBodies().some((b) => b.includes("couldn't read"))).toBe(true)
    );
    expect(runtime.respondToRequest).not.toHaveBeenCalled();

    expect(providerRoomRelay.consume('session-1', message('deny'))).toBe(true);
    await vi.waitFor(() =>
      expect(runtime.respondToRequest).toHaveBeenCalledWith('r1', 'decline', 'room')
    );
  });

  it('leaves an ordinary message alone when nothing is pending', () => {
    expect(providerRoomRelay.consume('session-1', message('do the thing'))).toBe(false);
  });

  it('stops intercepting once the request is resolved elsewhere', () => {
    providerRoomRelay.onRequestOpened('session-1', {
      type: 'request.opened',
      requestId: 'r1',
      title: 'rm -rf build',
      options: APPROVAL_OPTIONS,
    });
    providerRoomRelay.onRequestResolved('session-1', 'r1');
    expect(providerRoomRelay.consume('session-1', message('1'))).toBe(false);
  });

  it('does nothing for a session it is not following', () => {
    expect(providerRoomRelay.consume('session-2', message('1'))).toBe(false);
  });

  it('does not post a request for a session that has no room yet', () => {
    providerRoomRelay.bind({ sessionId: 'session-1', creds, room: () => null, runtime });
    providerRoomRelay.onRequestOpened('session-1', {
      type: 'request.opened',
      requestId: 'r1',
      title: 'rm -rf build',
      options: APPROVAL_OPTIONS,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(providerRoomRelay.consume('session-1', message('1'))).toBe(false);
  });
});
