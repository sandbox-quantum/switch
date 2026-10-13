import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
/**
 * What the icon picker offers once it knows whether its server allows
 * third-party avatars (THIRD_PARTY_AVATARS_ENABLED).
 *
 * A server that disables them has nothing to generate — offering a Generated
 * tab that always comes back empty would read as broken, not as a choice the
 * operator made, so the tab itself has to go, with a line saying why.
 */
import { AgentIconPicker } from '@renderer/lib/components/agent-icon-picker';
import { avatarSettingsQueryKey } from '@renderer/lib/stores/use-avatar-settings';

// An answer the server never gives, so an unseeded setting stays "not known
// yet" rather than failing; a seeded one is fresh and never asked for.
vi.mock('@renderer/lib/ipc', () => ({
  events: { on: vi.fn() },
  rpc: {
    switchServers: {
      avatarSettings: vi.fn(() => new Promise<never>(() => {})),
      agentIconChoices: vi.fn(() =>
        Promise.resolve({ choices: [], thirdPartyAvatarsEnabled: true })
      ),
    },
  },
}));

const SERVER_ID = 'srv-1';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

/** Renders the picker and opens it, seeding the server's avatar setting —
 * `null` leaves it unseeded, exercising "not known yet". */
async function openPicker(
  thirdPartyAvatarsEnabled: boolean | null,
  onChange: (iconUrl: string | null) => void = () => {}
): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  });
  if (thirdPartyAvatarsEnabled !== null) {
    client.setQueryData(avatarSettingsQueryKey(SERVER_ID), { thirdPartyAvatarsEnabled });
  }

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <AgentIconPicker serverId={SERVER_ID} name="worker" iconUrl={null} onChange={onChange} />
      </QueryClientProvider>
    )
  );

  const trigger = container.querySelector<HTMLElement>('[aria-label="Change the agent\'s icon"]');
  expect(trigger, 'the picker drew no trigger to open').not.toBeNull();
  await act(async () => trigger!.click());
}

describe('the icon picker on a server that disables third-party avatars', () => {
  it('offers no Generated tab', async () => {
    await openPicker(false);
    expect(document.querySelector('[aria-label="Generated"]')).toBeNull();
  });

  it('does not show a tab control for a single remaining option', async () => {
    // One option is no choice at all — a segmented control with one button in
    // it reads as broken, not as "here is the one thing you can do".
    await openPicker(false);
    expect(document.querySelector('[aria-label="How to choose the icon"]')).toBeNull();
  });

  it('explains why, rather than leaving the missing tab a mystery', async () => {
    await openPicker(false);
    expect(document.body.textContent).toContain("doesn't generate icons from a name");
  });

  it('refuses a link to an avatar service, saying why, rather than saving it', async () => {
    const chosen: (string | null)[] = [];
    await openPicker(false, (iconUrl) => chosen.push(iconUrl));
    const input = document.querySelector<HTMLInputElement>(
      'input[placeholder="https://example.com/avatar.png"]'
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'https://api.dicebear.com/10.x/gaze/png?seed=worker'
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    );
    expect(chosen).toEqual([]);
    expect(document.body.textContent).toContain("doesn't show icons from DiceBear");
  });

  it('still offers the Image URL field directly', async () => {
    await openPicker(false);
    expect(
      document.querySelector('input[placeholder="https://example.com/avatar.png"]')
    ).not.toBeNull();
  });
});

describe('the icon picker on a server that allows third-party avatars', () => {
  it('offers both tabs', async () => {
    await openPicker(true);
    expect(document.querySelector('[aria-label="Generated"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Image URL"]')).not.toBeNull();
  });
});

describe('the icon picker before its server has answered', () => {
  it('keeps the Generated tab up rather than reflowing twice', async () => {
    await openPicker(null);
    expect(document.querySelector('[aria-label="Generated"]')).not.toBeNull();
  });

  it('says it is checking, rather than claiming a page of icons', async () => {
    await openPicker(null);
    expect(document.body.textContent).toContain('Checking what this server allows');
  });
});
