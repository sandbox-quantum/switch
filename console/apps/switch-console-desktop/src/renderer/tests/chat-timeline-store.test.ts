import { describe, expect, it, vi } from 'vitest';
import {
  ChatTimeline,
  type ChatFile,
  type TimelineApi,
} from '@renderer/features/chats/stores/chat-timeline-store';
import type { ChatMessage } from '@shared/core/chats/chats';
import { RpcError } from '@shared/lib/ipc/rpc-error';

function message(seq: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    messageId: `m${seq}`,
    seq,
    roomId: 'room-1',
    sentAt: '2026-01-01T00:00:00Z',
    sender: { clientId: 'c', name: 'Ada', kind: 'human', agentId: null, userId: 'u' },
    source: 'console',
    body: `body ${seq}`,
    format: null,
    threadRootId: null,
    attachments: [],
    clientTxn: null,
    ...extra,
  };
}

const apiError = (apiCode: string, message: string) =>
  new RpcError({
    __switchConsoleRpcError: true,
    code: 'ChatApiError',
    message,
    data: { apiCode, status: 409 },
  });
const networkError = () =>
  new RpcError({
    __switchConsoleRpcError: true,
    code: 'GatewayError',
    message: 'Could not reach the server',
    data: { kind: 'network' },
  });

function api(overrides: Partial<TimelineApi> = {}) {
  let id = 0;
  const calls = { send: [] as Parameters<TimelineApi['send']>[1][], upload: [] as string[] };
  const value: TimelineApi = {
    messages: async () => ({ messages: [], headSeq: 0, hasMore: false }),
    upload: async (_room, file) => {
      calls.upload.push(file.uploadId);
      return {
        uploadId: file.uploadId,
        uri: 'mxc://x',
        filename: file.name,
        mimetype: file.mimeType,
        size: 1,
      };
    },
    send: async (_room, input) => {
      calls.send.push(input);
      return [message(10, { clientTxn: `${input.requestId}:0` })];
    },
    newId: () => `id-${++id}`,
    ...overrides,
  };
  return { value, calls };
}

const file = (name: string): ChatFile => ({
  name,
  type: 'text/plain',
  size: 1,
  read: async () => 'eA==',
});
const input = (files: ChatFile[] = []) => ({
  body: 'hello',
  threadRootId: null,
  mentionAgentId: null,
  files,
});

describe('ChatTimeline', () => {
  it('orders by sequence and keeps one copy of each message', () => {
    const timeline = new ChatTimeline('room-1', api().value);
    timeline.apply(message(3));
    timeline.apply(message(1));
    timeline.apply(message(2));
    timeline.apply(message(2));
    timeline.apply(message(4, { roomId: 'other' }));
    expect(timeline.messages.map((each) => each.seq)).toEqual([1, 2, 3]);
  });

  it('retires a send when its echo arrives', async () => {
    const { value } = api();
    const timeline = new ChatTimeline('room-1', value);
    const requestId = timeline.send(input());
    expect(timeline.pending[0]).toMatchObject({ requestId, state: 'sending' });
    await vi.waitFor(() => expect(timeline.pending).toHaveLength(0));
    expect(timeline.messages.map((each) => each.clientTxn)).toEqual([`${requestId}:0`]);
  });

  it('reconciles on the feed echo before the send answers', async () => {
    let answer!: (messages: ChatMessage[]) => void;
    const { value } = api({ send: () => new Promise((resolve) => (answer = resolve)) });
    const timeline = new ChatTimeline('room-1', value);
    const requestId = timeline.send(input());
    await vi.waitFor(() => expect(answer).toBeDefined());
    timeline.apply(message(7, { clientTxn: `${requestId}:0` }));
    expect(timeline.pending).toHaveLength(0);
    answer([message(7, { clientTxn: `${requestId}:0` })]);
    await Promise.resolve();
    expect(timeline.messages).toHaveLength(1);
  });

  it('keeps an uncertain send as failed and retries it with the same request id', async () => {
    let fail = true;
    const sent: string[] = [];
    const { value } = api({
      send: async (_room, request) => {
        sent.push(request.requestId);
        if (fail) throw networkError();
        return [message(11, { clientTxn: `${request.requestId}:0` })];
      },
    });
    const timeline = new ChatTimeline('room-1', value);
    const requestId = timeline.send(input());
    await vi.waitFor(() => expect(timeline.pending[0]?.state).toBe('failed'));
    expect(timeline.pending[0]).toMatchObject({ uncertain: true, posted: true });
    fail = false;
    timeline.retry(requestId);
    await vi.waitFor(() => expect(timeline.pending).toHaveLength(0));
    expect(sent).toEqual([requestId, requestId]);
  });

  it('marks a reused request id as a conflict', async () => {
    const { value } = api({
      send: async () => {
        throw apiError('REQUEST_REUSED', 'This request id was used for another message.');
      },
    });
    const timeline = new ChatTimeline('room-1', value);
    timeline.send(input());
    await vi.waitFor(() => expect(timeline.pending[0]?.state).toBe('conflict'));
    expect(timeline.pending[0]?.uncertain).toBe(false);
  });

  it('reports each refused file and sends the rest once they are dropped', async () => {
    const { value, calls } = api({
      upload: async (_room, upload) => {
        if (upload.name === 'big.bin') throw apiError('FILE_TOO_LARGE', 'Too large');
        return {
          uploadId: upload.uploadId,
          uri: 'mxc://x',
          filename: upload.name,
          mimetype: 'text/plain',
          size: 1,
        };
      },
    });
    const timeline = new ChatTimeline('room-1', value);
    const requestId = timeline.send(input([file('ok.txt'), file('big.bin')]));
    await vi.waitFor(() => expect(timeline.pending[0]?.state).toBe('failed'));
    expect(timeline.pending[0]?.error).toBe('big.bin could not be attached: Too large');
    expect(timeline.pending[0]?.files.map((each) => each.state)).toEqual(['uploaded', 'refused']);
    expect(timeline.pending[0]?.posted).toBe(false);
    expect(calls.send).toHaveLength(0);

    timeline.dropRefusedFiles(requestId);
    await vi.waitFor(() => expect(timeline.pending).toHaveLength(0));
    expect(calls.send).toHaveLength(1);
    expect(calls.send[0]!.requestId).toBe(requestId);
    expect(calls.send[0]!.uploadIds).toHaveLength(1);
  });

  it('drops everything and locks when access is lost', async () => {
    const { value } = api({
      send: async () => {
        throw apiError('NOT_A_MEMBER', 'Not a member');
      },
    });
    const timeline = new ChatTimeline('room-1', value);
    timeline.apply(message(1));
    timeline.send(input());
    await vi.waitFor(() => expect(timeline.accessLost).toBe(true));
    expect(timeline.messages).toHaveLength(0);
    expect(timeline.pending).toHaveLength(0);
  });

  it('says a non-member cannot read the room', async () => {
    const { value } = api({
      messages: async () => {
        throw apiError('NOT_A_MEMBER', 'Not a member');
      },
    });
    const timeline = new ChatTimeline('room-1', value);
    await timeline.load();
    expect(timeline.notMember).toBe(true);
    expect(timeline.loadError).toBeNull();
  });
});
