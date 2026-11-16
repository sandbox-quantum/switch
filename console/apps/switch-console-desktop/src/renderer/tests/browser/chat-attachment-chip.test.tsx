/**
 * A file in a chat shows under the name it is saved as, so a name built with
 * bidi controls cannot show a fake extension, and clicking it saves the file
 * through the main process rather than as a page in the app.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

const media = vi.hoisted(() => vi.fn());
const saveAttachment = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { chats: { media, saveAttachment } },
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast }));

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
  vi.restoreAllMocks();
});

const spoofed: ChatAttachment = {
  uri: 'mxc://example.org/invoice',
  filename: 'invoice\u202Efdp.exe',
  mimetype: 'application/octet-stream',
  size: 13,
  msgtype: 'm.file',
};

const page: ChatAttachment = {
  uri: 'mxc://example.org/report',
  filename: 'report.html',
  mimetype: 'text/html',
  size: 51,
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

it('saves a page as a file through the main process, without fetching it into the app', async () => {
  saveAttachment.mockResolvedValue('/Users/me/Downloads/report.html');
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
  const chip = await render(page);

  await userEvent.click(chip);

  await expect.poll(() => saveAttachment.mock.calls.length).toBe(1);
  expect(saveAttachment).toHaveBeenCalledWith({
    serverId: 's',
    roomId: 'r',
    uri: 'mxc://example.org/report',
    filename: 'report.html',
  });
  expect(media).not.toHaveBeenCalled();
  expect(click).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
});

it('says why a download failed', async () => {
  saveAttachment.mockRejectedValue(new Error('Switch gateway returned 404: not in this room'));
  const chip = await render(page);

  await userEvent.click(chip);

  await expect.poll(() => toast.mock.calls.length).toBe(1);
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({
      title: expect.stringContaining('not in this room'),
      variant: 'destructive',
    })
  );
});
