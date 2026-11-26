/**
 * An image attachment shows a download button on hover; the button saves the
 * file without opening the lightbox, and clicking the image opens it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

const media = vi.hoisted(() => vi.fn());
import { ChatAttachments } from '@switch-console/chat-ui/components/chat-attachments';
import { withChatHost } from '@switch-console/chat-ui/testing';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.restoreAllMocks();
});

function samplePng(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 400;
  const context = canvas.getContext('2d')!;
  const gradient = context.createLinearGradient(0, 0, 640, 400);
  gradient.addColorStop(0, '#4f46e5');
  gradient.addColorStop(1, '#06b6d4');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 640, 400);
  return canvas.toDataURL('image/png').split(',')[1]!;
}

async function render(): Promise<HTMLElement> {
  media.mockResolvedValue({ mimeType: 'image/png', data: samplePng() });
  container = document.createElement('div');
  container.style.padding = '24px';
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      withChatHost(
        <ChatAttachments
          serverId="s"
          roomId="r"
          attachments={[
            {
              uri: 'mxc://example.org/shot',
              filename: 'shot.png',
              mimetype: 'image/png',
              size: 70,
              msgtype: 'm.image',
            },
          ]}
        />,
        { media: (_serverId, roomId, uri) => media({ roomId, uri }) }
      )
    )
  );
  await expect.poll(() => container!.querySelector('img')).toBeTruthy();
  return container!.querySelector<HTMLElement>('[aria-label="Open shot.png"]')!;
}

const downloadButton = () =>
  container!.querySelector<HTMLButtonElement>('[aria-label="Download shot.png"]')!;
const lightbox = () => document.querySelector('[role="dialog"]');

it('shows the download button on hover', async () => {
  const image = await render();
  const overlay = downloadButton().parentElement!;
  expect(getComputedStyle(overlay).opacity).toBe('0');
  await userEvent.hover(image);
  await expect.poll(() => getComputedStyle(overlay).opacity).toBe('1');
});

it('downloads without opening the lightbox', async () => {
  const image = await render();
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await userEvent.hover(image);
  await userEvent.click(downloadButton());
  await expect.poll(() => click.mock.calls.length).toBe(1);
  const link = click.mock.contexts[0] as HTMLAnchorElement;
  expect(link.download).toBe('shot.png');
  expect(link.href).toMatch(/^blob:/);
  expect(lightbox()).toBeNull();
});

it('opens the lightbox on click and closes it on Escape', async () => {
  const image = await render();
  await userEvent.click(image);
  await expect.poll(lightbox).toBeTruthy();
  expect(lightbox()!.textContent).toContain('shot.png');
  expect(lightbox()!.querySelector('[aria-label="Download shot.png"]')).toBeTruthy();
  await userEvent.keyboard('{Escape}');
  await expect.poll(lightbox).toBeNull();
});
