/**
 * switch-buddy's welcome names the messaging apps with their logos, drawn by
 * the chat inline in the text beside each name; an app the chat has no logo
 * for is named without one.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

import { ChatMarkdown } from '@renderer/features/chats/ui/chat-markdown';
import { buddyWelcomeMessage } from '@renderer/features/switch-buddy/buddy-welcome-message';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(markdown: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<ChatMarkdown>{markdown}</ChatMarkdown>));
  // Streamdown renders after a tick.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
}

/** Each app named: its name, whether its logo is drawn, and whether it sits in the text. */
function apps(): string[] {
  return [...container!.querySelectorAll('strong')]
    .filter((name) => name.parentElement?.classList.contains('whitespace-nowrap'))
    .map((name) => {
      const app = name.parentElement!;
      const logo = app.querySelector('svg') !== null ? 'logo' : 'no logo';
      const inline = app.closest('p') !== null ? 'inline' : 'apart';
      return `${name.textContent?.trim()} (${logo}, ${inline})`;
    });
}

describe('messaging-app logos in chat', () => {
  it('draws each app the welcome names inline, with its logo beside its name', async () => {
    await render(buddyWelcomeMessage({ firstName: 'Max', agentName: 'switch-buddy-max' }));
    expect(apps()).toEqual([
      'Slack (logo, inline)',
      'Microsoft Teams (logo, inline)',
      'Discord (logo, inline)',
      'Telegram (logo, inline)',
    ]);
    expect(container!.textContent?.replace(/\s+/g, ' ')).toContain(
      'Slack, Microsoft Teams, Discord and Telegram'
    );
    expect(container!.textContent).not.toContain('switchdash');
  });

  it('names an app it has no logo for without one', async () => {
    await render('Try ![Nowhere](switchdash://logo/nowhere) here.');
    expect(apps()).toEqual(['Nowhere (no logo, inline)']);
    expect(container!.textContent).not.toContain('switchdash');
  });
});
