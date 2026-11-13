/**
 * Setting up a Slack app of your own: the guide opens Slack with the app filled
 * in, asks for each token in the step that says where to find it, and fills in
 * the workspace once Slack says the pasted tokens work. Saves screenshots under
 * the app's gitignored `build/acceptance/slack-setup/`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { BridgeConfigField } from '@shared/core/switch-servers/switch-servers';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

const workspaces = vi.hoisted(() => ({
  slackOwnAppSetup: vi.fn(),
  checkSlackTokens: vi.fn(),
}));
const openExternalUrl = vi.hoisted(() => vi.fn());
vi.mock('@renderer/lib/ipc', () => ({ rpc: { workspaces } }));
vi.mock('@renderer/lib/open-external', () => ({ openExternalUrl }));

import { OwnAppGuide } from '@renderer/features/switch-servers/own-app-guide';
import '@renderer/index.css';

const SHOTS = '../../../../build/acceptance/slack-setup';

const FIELDS: BridgeConfigField[] = [
  {
    key: 'bot_token',
    label: 'Bot token',
    description: null,
    required: true,
    secret: true,
    kind: 'string',
    default: null,
  },
  {
    key: 'app_token',
    label: 'App-level token',
    description:
      "The xapp-… token with the connections:write scope, from the app's Basic Information page.",
    required: true,
    secret: true,
    kind: 'string',
    default: null,
  },
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

async function render(
  platform: 'slack',
  config: Record<string, string>,
  setField: (key: string, value: string | null) => void,
  setInput: (key: string, value: string | null) => void = () => {}
) {
  container = document.createElement('div');
  container.className = 'bg-background p-6 text-foreground';
  container.style.width = '640px';
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        <OwnAppGuide
          platform={platform}
          workspaceId="ws-1"
          config={config}
          fields={FIELDS}
          setField={setField}
          setInput={setInput}
        />
      </QueryClientProvider>
    )
  );
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 900)));

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(name));
  if (!found) throw new Error(`no button ${name}`);
  return found;
}

describe('the Slack guide', () => {
  it('opens Slack with the app filled in', async () => {
    workspaces.slackOwnAppSetup.mockResolvedValue({ createUrl: 'https://api.slack.com/apps?x' });
    await render('slack', {}, () => {});
    await settle();
    await act(async () => button('Create the Slack app').click());
    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://api.slack.com/apps?x',
      expect.any(String)
    );
  });

  it('fills in the workspace once both tokens work', async () => {
    workspaces.slackOwnAppSetup.mockResolvedValue({ createUrl: 'https://api.slack.com/apps?x' });
    workspaces.checkSlackTokens.mockResolvedValue({
      workspaceId: 'T123',
      workspaceName: 'Acme',
      botName: 'agent_switch',
    });
    const setField = vi.fn();
    await render('slack', { bot_token: 'xoxb-1', app_token: 'xapp-1' }, setField);
    await settle();
    await settle();
    expect(workspaces.checkSlackTokens).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      botToken: 'xoxb-1',
      appToken: 'xapp-1',
    });
    expect(setField).toHaveBeenLastCalledWith('workspace_id', 'T123');
    expect(document.body.textContent).toContain('Both tokens work, for the Acme workspace');
  });

  it('asks for each token in the step that says where to find it', async () => {
    workspaces.slackOwnAppSetup.mockResolvedValue({ createUrl: 'https://api.slack.com/apps?x' });
    const setInput = vi.fn();
    await render('slack', {}, () => {}, setInput);
    await settle();

    const steps = [...container!.querySelectorAll('ol > li')].filter(
      (li) => li.parentElement?.parentElement?.tagName === 'SECTION'
    );
    expect(steps.map((li) => li.querySelector('p')?.textContent)).toEqual([
      'Create a new Slack app',
      'Install the app and copy the bot token',
      'Generate the app-level token',
    ]);
    expect(steps[1].querySelector('label')?.textContent).toBe('Bot token');
    expect(steps[1].querySelector('img')?.getAttribute('alt')).toContain('Install App');
    expect(steps[2].querySelector('label')?.textContent).toBe('App-level token');
    expect(steps[2].querySelector('img')?.getAttribute('alt')).toContain('App-Level Tokens');

    const bot = steps[1].querySelector('input')!;
    expect(bot.type).toBe('password');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(bot, 'xoxb-typed');
      bot.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(setInput).toHaveBeenCalledWith('bot_token', 'xoxb-typed');

    await waitForImages();
    await page.viewport(720, 1200);
    await page.screenshot({ path: `${SHOTS}/slack-setup.png`, element: container! });
  });

  it('ticks every step once Slack says both tokens work', async () => {
    workspaces.slackOwnAppSetup.mockResolvedValue({ createUrl: 'https://api.slack.com/apps?x' });
    workspaces.checkSlackTokens.mockResolvedValue({
      workspaceId: 'T123',
      workspaceName: 'Acme',
      botName: 'agent_switch',
    });
    await render('slack', { bot_token: 'xoxb-1', app_token: 'xapp-1' }, () => {});
    await settle();
    await settle();

    expect(container!.querySelectorAll('[aria-label$=", done"]')).toHaveLength(3);
    await waitForImages();
    await page.viewport(720, 1200);
    await page.screenshot({ path: `${SHOTS}/slack-setup-done.png`, element: container! });
  });
});

async function waitForImages(): Promise<void> {
  await Promise.all(
    [...container!.querySelectorAll('img')].map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete) resolve();
          else img.onload = () => resolve();
        })
    )
  );
}
