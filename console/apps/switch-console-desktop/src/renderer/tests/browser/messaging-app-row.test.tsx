import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The row's siblings reach the renderer IPC bridge at import time, which only
// exists inside Electron. Hoisted so it is in place before those modules are
// evaluated. Nothing asserted here calls through it.
vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

/**
 * One messaging app, one line (CHOO-2137).
 *
 * The card used to answer "which account is you here" in two different shapes:
 * a linked app showed bare text plus a stray cross, an unlinked one showed a
 * button. Same column, same question, two visual languages — and the cross put
 * an irreversible unlink one mis-click from the control you press to *change*
 * an account. These pin the shape down: one control in the column either way,
 * the badges tied to the app name, and everything rare or destructive behind
 * the row menu.
 */
import { MessagingAppRow } from '@renderer/features/switch-servers/MessagingAppsCard';
import type { LinkedIdentity, RemoteBridge } from '@shared/core/switch-servers/switch-servers';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
  return container;
}

function bridge(patch: Partial<RemoteBridge> = {}): RemoteBridge {
  return {
    id: 'b-slack',
    type: 'slack',
    displayName: 'Slack Test',
    status: 'active',
    isDefault: false,
    homeUrl: null,
    channelCreationSupported: true,
    canCreateChannels: true,
    directorySearchSupported: true,
    ...patch,
  };
}

const IDENTITY: LinkedIdentity = {
  id: 'eu-1',
  bridgeId: 'b-slack',
  bridgeDisplayName: 'Slack Test',
  bridgeType: 'slack',
  externalUserId: 'U1',
  externalUsername: 'amaudruz.louis',
};

function row(
  overrides: {
    bridge?: RemoteBridge;
    identities?: LinkedIdentity[] | null;
    isAdmin?: boolean;
    onDisconnect?: () => void;
  } = {}
) {
  return (
    <MessagingAppRow
      serverId="srv-1"
      bridge={overrides.bridge ?? bridge()}
      identities={overrides.identities === undefined ? [] : overrides.identities}
      currentUserId="u1"
      onReleased={() => {}}
      showBundledSignIn={false}
      isAdmin={overrides.isAdmin ?? false}
      savingChannelCreation={false}
      onToggleChannelCreation={() => {}}
      onDisconnect={overrides.onDisconnect ?? (() => {})}
    />
  );
}

function buttonLabels(el: HTMLElement): string[] {
  return [...el.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
}

/** Opens the row's overflow menu and returns the menu item labels. Base UI
 * portals the menu outside the row, so this reads the whole document. */
async function openMenu(el: HTMLElement): Promise<string[]> {
  const trigger = el.querySelector<HTMLButtonElement>('button[aria-label$="actions"]');
  expect(trigger).not.toBeNull();
  await act(async () => trigger!.click());
  return [...document.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')].map(
    (i) => i.textContent?.trim() ?? ''
  );
}

describe('the identity column', () => {
  it('states the handle without hanging a control off it', async () => {
    // The control that was removed is the unlink cross, and its absence is
    // still the point. The handle now reads as a fact about the app; both
    // things you can do to it — change it, drop it — are in the menu, where
    // neither sits a mis-click from the other.
    const el = await render(row({ identities: [IDENTITY] }));

    expect(el.textContent).toContain('@amaudruz.louis');
    expect(buttonLabels(el).filter((l) => l.includes('amaudruz.louis'))).toEqual([]);
  });

  it('cannot unlink straight from the row', async () => {
    const el = await render(row({ identities: [IDENTITY] }));

    const unlinkOnRow = [...el.querySelectorAll('button')].filter((b) =>
      (b.getAttribute('aria-label') ?? '').startsWith('Unlink')
    );
    expect(unlinkOnRow).toEqual([]);
  });

  it('asks for the account when there is none', async () => {
    const el = await render(row({ identities: [] }));

    expect(buttonLabels(el)).toContain('Link');
  });

  it('says nothing at all until the claimed accounts have loaded', async () => {
    // "Not linked" and "not known yet" look identical, and inviting someone to
    // link an account they already have is the more confusing of the two.
    const el = await render(row({ identities: null }));

    expect(buttonLabels(el)).not.toContain('Link');
  });

  it('adds the sigil only when the platform has not already', async () => {
    const el = await render(
      row({ identities: [{ ...IDENTITY, externalUsername: '@already.sigilled' }] })
    );

    expect(el.textContent).toContain('@already.sigilled');
    expect(el.textContent).not.toContain('@@already.sigilled');
  });
});

describe('the app name and its badges', () => {
  it('keeps Default beside the name rather than adrift in the row', async () => {
    // With the name set to grow, the badge was pushed away from what it
    // qualifies and ended up floating mid-row against the identity column.
    const el = await render(row({ bridge: bridge({ isDefault: true }) }));

    const label = [...el.querySelectorAll('span')].find(
      (s) => s.textContent?.trim() === 'Slack Test'
    );
    expect(label).toBeDefined();
    expect(label!.parentElement!.textContent).toContain('Default');
  });

  it('shows a bridge that is down, since a new room cannot use it', async () => {
    const el = await render(row({ bridge: bridge({ status: 'error' }) }));

    expect(el.textContent).toContain('error');
  });
});

describe('the row menu', () => {
  it('is where unlinking lives, and only when there is a link to undo', async () => {
    const el = await render(row({ identities: [IDENTITY] }));

    expect(await openMenu(el)).toContain('Unlink @amaudruz.louis');
  });

  it('offers no unlink when nothing is linked', async () => {
    const el = await render(row({ identities: [] }));

    expect(await openMenu(el)).not.toContain('Unlink @amaudruz.louis');
  });

  it('offers disconnecting the app to an admin', async () => {
    const el = await render(row({ isAdmin: true }));

    expect(await openMenu(el)).toContain('Disconnect app…');
  });

  it('does not offer it to anyone else — the endpoint would refuse them', async () => {
    const el = await render(row({ isAdmin: false }));

    expect(await openMenu(el)).not.toContain('Disconnect app…');
  });

  it('opens on a platform that cannot create channels at all', async () => {
    // Telegram. The explanation used to be a menu *label*, which Base UI
    // requires to sit inside a group — so opening this menu threw and took the
    // page down with it. Every other case here has a platform that supports
    // channel creation, which is how it got through. The toggle has since moved
    // out to a column of its own; the menu must still open.
    const el = await render(
      row({ bridge: bridge({ channelCreationSupported: false, canCreateChannels: false }) })
    );

    expect(await openMenu(el)).toContain('Link my account…');
  });

  it('asks before disconnecting rather than doing it on the click', async () => {
    // The server deletes every room on the bridge first, so the menu item may
    // only ever open a confirmation.
    const onDisconnect = vi.fn();
    const el = await render(row({ isAdmin: true, onDisconnect }));
    await openMenu(el);

    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (i) => i.textContent?.trim() === 'Disconnect app…'
    );
    await act(async () => item!.click());

    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });
});

/**
 * Whether Switch may open channels on an app.
 *
 * It has been in both places. CHOO-2158 pulled it onto the row as a column, so
 * it could be read down the page; the card is a list rather than a table of
 * controls now, and it is back in the menu — read far less often than the app
 * name and the account under it, and a switch in a list of names reads as the
 * loudest thing there.
 *
 * What it has to say did not change with either move, and that is what these
 * are for.
 */
describe('channel creation', () => {
  /** Opens the row menu and returns the item with this label. Base UI portals
   * the menu, so this reads the whole document. */
  async function menuItem(el: HTMLElement, label: string): Promise<HTMLElement> {
    await openMenu(el);
    const found = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]'),
    ].find((i) => i.textContent?.trim() === label);
    expect(found, `no menu item labelled ${label}`).toBeDefined();
    return found!;
  }

  it('is in the menu, not on the row', async () => {
    const el = await render(row({ isAdmin: true }));

    expect(el.querySelector('[role="switch"]')).toBeNull();
    expect(await openMenu(el)).toContain('Create channels on Slack');
  });

  it('shows the current answer', async () => {
    const el = await render(row({ isAdmin: true }));

    expect((await menuItem(el, 'Create channels on Slack')).getAttribute('aria-checked')).toBe(
      'true'
    );
  });

  it('says a platform cannot create channels rather than just showing it off', async () => {
    // An unticked box reads as "switched off", which is a different claim from
    // "this platform has no such thing". Telegram is the case: it never gets a
    // box at all, only a line saying so.
    const el = await render(
      row({ bridge: bridge({ channelCreationSupported: false, canCreateChannels: false }) })
    );

    const labels = await openMenu(el);
    expect(labels).toContain('Channels not supported on Slack');
    expect(document.querySelector('[role="menuitemcheckbox"]')).toBeNull();
  });

  it('leaves it alone for a non-admin', async () => {
    const el = await render(row({ isAdmin: false }));

    expect(
      (await menuItem(el, 'Create channels on Slack')).getAttribute('data-disabled')
    ).not.toBeNull();
  });

  it('lets an admin move it', async () => {
    const el = await render(row({ isAdmin: true }));

    expect(
      (await menuItem(el, 'Create channels on Slack')).getAttribute('data-disabled')
    ).toBeNull();
  });
});
