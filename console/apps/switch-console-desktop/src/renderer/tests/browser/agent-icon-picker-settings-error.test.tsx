/**
 * The icon picker when its server's avatar setting (THIRD_PARTY_AVATARS_ENABLED)
 * cannot be read.
 *
 * An unread setting still counts as "not allowed", so nothing is asked for in
 * the agent's name. What it must not do is look like it is still asking: the
 * reader is told the setting could not be read, and can ask again.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentIconPicker } from '@renderer/lib/components/agent-icon-picker';

const avatarSettings = vi.hoisted(() => vi.fn());
const agentIconChoices = vi.hoisted(() => vi.fn());

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: vi.fn() },
  rpc: { switchServers: { avatarSettings, agentIconChoices } },
}));

const SERVER_ID = 'srv-1';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  avatarSettings.mockReset().mockRejectedValue(new Error('server unreachable'));
  agentIconChoices.mockReset().mockResolvedValue({ choices: [], thirdPartyAvatarsEnabled: true });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function openPicker(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <AgentIconPicker serverId={SERVER_ID} name="worker" iconUrl={null} onChange={() => {}} />
      </QueryClientProvider>
    )
  );
  await vi.waitFor(() => expect(avatarSettings).toHaveBeenCalled());
  const trigger = container.querySelector<HTMLElement>('[aria-label="Change the agent\'s icon"]');
  expect(trigger, 'the picker drew no trigger to open').not.toBeNull();
  await act(async () => trigger!.click());
}

function buttonNamed(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
}

it('says the setting could not be read, rather than that it is still checking', async () => {
  await openPicker();
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain(
      "Couldn't read whether this server allows generated icons"
    )
  );
  expect(document.body.textContent).not.toContain('Checking what this server allows');
});

it('asks for no icons in the agent’s name while the setting is unread', async () => {
  await openPicker();
  await vi.waitFor(() => expect(buttonNamed('Try again')).toBeDefined());
  expect(agentIconChoices).not.toHaveBeenCalled();
});

it('asks the server again from Try again', async () => {
  await openPicker();
  await vi.waitFor(() => expect(buttonNamed('Try again')).toBeDefined());
  const before = avatarSettings.mock.calls.length;
  await act(async () => buttonNamed('Try again')!.click());
  await vi.waitFor(() => expect(avatarSettings.mock.calls.length).toBeGreaterThan(before));
});
