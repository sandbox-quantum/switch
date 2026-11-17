import { describe, expect, it } from 'vitest';
import { messageAnchorId, snippetOf, threadChip } from '@renderer/features/chats/chat-threads';
import { messageText } from '@renderer/features/chats/message-text';
import type { ChatMessage } from '@shared/core/chats/chats';

const root = {
  messageId: '$root',
  body: 'Can you check why the controller\ncrash-loops after the upgrade?',
  attachments: [],
} as unknown as ChatMessage;

describe('thread chips', () => {
  it('names the message a reply answers', () => {
    const chip = threadChip({ threadRootId: '$root', messageId: '$reply' }, (id) =>
      id === '$root' ? root : undefined
    );
    expect(chip).toEqual({
      rootId: '$root',
      snippet: 'Can you check why the controller crash-loops after the upgrade?',
      label: '↳ reply to Can you check why the controller crash-loops after the upgrade?',
    });
  });

  it('says so when the root is older than what is loaded', () => {
    expect(
      threadChip({ threadRootId: '$gone', messageId: '$reply' }, () => undefined)
    ).toMatchObject({
      snippet: null,
      label: '↳ reply to an earlier message',
    });
  });

  it('shows no chip for a message outside a thread or for the root itself', () => {
    expect(threadChip({ threadRootId: null, messageId: '$m' }, () => root)).toBeNull();
    expect(threadChip({ threadRootId: '$root', messageId: '$root' }, () => root)).toBeNull();
  });

  it('cuts long text and falls back to the file name', () => {
    expect(snippetOf({ body: 'x'.repeat(200), attachments: [] })).toHaveLength(80);
    expect(
      snippetOf({
        body: '  ',
        attachments: [
          { uri: 'u', filename: 'log.txt', mimetype: 'text/plain', size: 1, msgtype: 'm.file' },
        ],
      })
    ).toBe('log.txt');
    expect(messageAnchorId('$a:b')).toBe('chat-message-_a_b');
  });
});

describe('a file’s name in a message', () => {
  const spoofed = {
    uri: 'mxc://example.test/abc',
    filename: 'invoice\u202Efdp.exe',
    mimetype: 'application/octet-stream',
    size: 13,
    msgtype: 'm.file',
  };

  it('shows a file posted without a caption under its real extension', () => {
    expect(messageText({ body: spoofed.filename, attachments: [spoofed] })).toBe('invoice_fdp.exe');
    expect(snippetOf({ body: spoofed.filename, attachments: [spoofed] })).toBe('invoice_fdp.exe');
    expect(snippetOf({ body: '', attachments: [spoofed] })).toBe('invoice_fdp.exe');
  });

  it('leaves a caption as written', () => {
    expect(messageText({ body: 'Here is the invoice', attachments: [spoofed] })).toBe(
      'Here is the invoice'
    );
  });
});
