import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
/**
 * The picture a brand-new agent opens on (CHOO-2203).
 *
 * The form used to start with no icon at all, which left the avatar seeded by
 * the empty name — a single hard-coded bot that every agent, for every user,
 * was first shown as. Pinned here because it is invisible to every other test:
 * a constant icon is a working icon, just the same one every time.
 */
import { useConfigureAgentForm } from '@renderer/features/locations/components/add-agent-modal/modes';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

/** The icon state the creation form starts on, read off the real hook. */
async function initialIcon(): Promise<{ iconUrl: string | null; iconIsGenerated: boolean }> {
  let seen: { iconUrl: string | null; iconIsGenerated: boolean } = {
    iconUrl: null,
    iconIsGenerated: false,
  };
  function Probe() {
    const form = useConfigureAgentForm();
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
    expect(iconUrl).toContain('/bottts/png?');
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
