import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
/**
 * The picture a brand-new agent opens on (CHOO-2203), and what happens to it
 * when the chosen server turns out to disable third-party avatars
 * (THIRD_PARTY_AVATARS_ENABLED).
 *
 * The form used to start with no icon at all, which left the avatar seeded by
 * the empty name — a single hard-coded bot that every agent, for every user,
 * was first shown as. Pinned here because it is invisible to every other test:
 * a constant icon is a working icon, just the same one every time.
 */
import { useConfigureAgentForm } from '@renderer/features/locations/components/add-agent-modal/modes';

const avatarSettings = vi.hoisted(() => vi.fn());

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { switchServers: { avatarSettings } },
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
  avatarSettings.mockReset();
});

/** The icon state the creation form starts on, read off the real hook. */
async function initialIcon(
  serverId: string | null = null
): Promise<{ iconUrl: string | null; iconIsGenerated: boolean }> {
  let seen: { iconUrl: string | null; iconIsGenerated: boolean } = {
    iconUrl: null,
    iconIsGenerated: false,
  };
  function Probe() {
    const form = useConfigureAgentForm(serverId);
    seen = { iconUrl: form.iconUrl, iconIsGenerated: form.iconIsGenerated };
    return null;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>
    )
  );
  await act(async () => root!.unmount());
  root = null;
  container.remove();
  container = null;
  return seen;
}

describe('a new agent', () => {
  it('starts on a concrete generated icon', async () => {
    const { iconUrl } = await initialIcon();
    expect(iconUrl).toContain('/gaze/png?');
  });

  it('counts that icon as generated rather than chosen', async () => {
    // Drives the caption under the avatar: the user has not picked anything
    // yet, so it must not claim they have.
    expect((await initialIcon()).iconIsGenerated).toBe(true);
  });

  it('gives two agents created in a row different icons', async () => {
    // The bug: with a name-derived seed and no name yet, every agent opened on
    // the same bot.
    const first = await initialIcon();
    const second = await initialIcon();
    expect(first.iconUrl).not.toBe(second.iconUrl);
  });
});

describe('a new agent on a server that disables third-party avatars', () => {
  /**
   * The icon state once the server's answer has arrived, read off the real
   * hook with its own `QueryClientProvider` so the effect that clears the
   * random DiceBear default actually runs.
   */
  async function settledIcon(thirdPartyAvatarsEnabled: boolean): Promise<{
    iconUrl: string | null;
    iconIsGenerated: boolean;
    thirdPartyAvatarsEnabled: boolean | null;
  }> {
    avatarSettings.mockResolvedValue({ thirdPartyAvatarsEnabled });
    let seen: {
      iconUrl: string | null;
      iconIsGenerated: boolean;
      thirdPartyAvatarsEnabled: boolean | null;
    } = {
      iconUrl: null,
      iconIsGenerated: false,
      thirdPartyAvatarsEnabled: null,
    };
    function Probe() {
      const form = useConfigureAgentForm('srv-1');
      seen = {
        iconUrl: form.iconUrl,
        iconIsGenerated: form.iconIsGenerated,
        thirdPartyAvatarsEnabled: form.thirdPartyAvatarsEnabled,
      };
      return null;
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    await act(async () =>
      root!.render(
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>
      )
    );
    await vi.waitFor(() => expect(avatarSettings).toHaveBeenCalled());
    // Let the server's answer reach the effect that acts on it.
    await act(async () => {});
    return seen;
  }

  it('loses the random DiceBear default once the server says no', async () => {
    expect((await settledIcon(false)).iconUrl).toBeNull();
  });

  it('still counts a cleared icon as generated, not as a custom choice', async () => {
    expect((await settledIcon(false)).iconIsGenerated).toBe(true);
  });

  it('carries the server’s answer, so the caption can say there is no icon', async () => {
    expect((await settledIcon(false)).thirdPartyAvatarsEnabled).toBe(false);
  });

  it('keeps the random DiceBear default when the server allows it', async () => {
    expect((await settledIcon(true)).iconUrl).toContain('/gaze/png?');
  });
});
