/**
 * Home's chat bar takes more than one line: Enter sends, Shift+Enter does not,
 * and the box grows up to ten lines before it scrolls. switch-buddy slides
 * into its tile beside it, or is drawn still with reduced motion.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import '@renderer/index.css';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

const askBuddy = vi.hoisted(() => vi.fn());
vi.mock('@renderer/features/switch-buddy/open-buddy', () => ({
  askBuddy,
  openBuddyChat: vi.fn(),
}));
vi.mock('@renderer/lib/telemetry/report', () => ({ report: vi.fn() }));

import { AskBuddyPanel } from '@renderer/features/switch-servers/home/home-panels';

const BUDDY = { serverId: 'srv', agentId: 'buddy' } as ManagedAgentView;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  askBuddy.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(): Promise<HTMLTextAreaElement> {
  container = document.createElement('div');
  container.style.width = '800px';
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<AskBuddyPanel serverId="srv" buddy={BUDDY} chips={[]} />));
  return container.querySelector('textarea')!;
}

async function type(box: HTMLTextAreaElement, text: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function press(box: HTMLTextAreaElement, init: KeyboardEventInit): Promise<boolean> {
  let sent = true;
  await act(async () => {
    sent = box.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })
    );
  });
  return sent;
}

it('sends on Enter', async () => {
  const box = await render();
  await type(box, 'Set up a room');

  expect(await press(box, {})).toBe(false);
  expect(askBuddy).toHaveBeenCalledWith('srv', BUDDY, 'Set up a room');
});

it('leaves Shift+Enter to start a new line', async () => {
  const box = await render();
  await type(box, 'First line');

  expect(await press(box, { shiftKey: true })).toBe(true);
  expect(askBuddy).not.toHaveBeenCalled();
});

it('sends what spans several lines as it was typed', async () => {
  const box = await render();
  await type(box, 'One\nTwo\nThree');
  await press(box, {});

  expect(askBuddy).toHaveBeenCalledWith('srv', BUDDY, 'One\nTwo\nThree');
});

it('grows to ten lines, then scrolls', async () => {
  const box = await render();
  const oneLine = box.clientHeight;
  await type(box, Array.from({ length: 4 }, (_, i) => `line ${i}`).join('\n'));
  const fourLines = box.clientHeight;
  await type(box, Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'));
  const capped = box.clientHeight;

  const lineHeight = parseFloat(getComputedStyle(box).lineHeight);
  expect(fourLines - oneLine).toBeCloseTo(3 * lineHeight, 0);
  expect(capped - oneLine).toBeCloseTo(9 * lineHeight, 0);
  expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
});

it('draws switch-buddy on its tile beside the bar', async () => {
  await render();

  expect(container!.querySelector('[data-home-buddy] svg')).not.toBeNull();
});
