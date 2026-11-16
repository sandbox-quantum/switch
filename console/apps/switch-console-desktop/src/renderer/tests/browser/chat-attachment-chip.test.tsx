/**
 * A file in a chat shows under the name it is saved as, so a name built with
 * bidi controls cannot show a fake extension.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { chats: { media: vi.fn() } },
}));

import { ChatAttachments } from '@renderer/features/chats/components/chat-attachments';
import type { ChatAttachment } from '@shared/core/chats/chats';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

const spoofed: ChatAttachment = {
  uri: 'mxc://example.org/invoice',
  filename: 'invoice\u202Efdp.exe',
  mimetype: 'application/octet-stream',
  size: 13,
  msgtype: 'm.file',
};

async function render(attachment: ChatAttachment): Promise<HTMLButtonElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(<ChatAttachments serverId="s" roomId="r" attachments={[attachment]} />)
  );
  return container.querySelector('button')!;
}

it('shows a name built with a right-to-left override under its real extension', async () => {
  const chip = await render(spoofed);
  expect(chip.textContent).toContain('invoice_fdp.exe');
  expect(chip.textContent).not.toContain('\u202E');
  expect(chip.title).toBe('Download invoice_fdp.exe');
});
