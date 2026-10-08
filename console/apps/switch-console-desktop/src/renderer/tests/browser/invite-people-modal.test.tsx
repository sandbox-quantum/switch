/**
 * Inviting people to a workspace from the switcher.
 *
 * What matters is that the link is always handed over — whether or not the
 * e-mail went out, it is the one moment it can be shown — that the notice says
 * truthfully what happened to the e-mail, and that only live invitations offer
 * Revoke.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listInvitations = vi.hoisted(() => vi.fn());
const createInvitation = vi.hoisted(() => vi.fn());
const revokeInvitation = vi.hoisted(() => vi.fn());
const byId = vi.hoisted(() => vi.fn());
const listJoinDomains = vi.hoisted(() => vi.fn());
const addJoinDomain = vi.hoisted(() => vi.fn());
const removeJoinDomain = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    workspaces: {
      listInvitations,
      createInvitation,
      revokeInvitation,
      listJoinDomains,
      addJoinDomain,
      removeJoinDomain,
    },
  },
  events: { on: () => () => {}, emit: () => {} },
}));

vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: { byId },
}));

import { InvitePeopleModal } from '@renderer/features/workspaces/invite-people-modal';
import { modalStore } from '@renderer/lib/modal/modal-store';
import { Dialog } from '@renderer/lib/ui/dialog';
import { administersWorkspace } from '@shared/core/workspaces/workspaces';

const onClose = vi.fn();

function workspace(role: 'owner' | 'admin' | 'member') {
  return {
    id: 'ws-1',
    serverId: 'srv-1',
    name: 'Acme',
    tenantId: 't1',
    slug: 'acme',
    role,
    createdAt: '',
    updatedAt: '',
  };
}

function invitation(overrides: Record<string, unknown>) {
  return {
    id: 'inv-1',
    role: 'member',
    email: null,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    usesRemaining: 1,
    revokedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  listInvitations.mockReset();
  createInvitation.mockReset();
  revokeInvitation.mockReset();
  byId.mockReset().mockReturnValue(workspace('admin'));
  listJoinDomains.mockReset().mockResolvedValue({ kind: 'unsupported' });
  addJoinDomain.mockReset().mockResolvedValue(undefined);
  removeJoinDomain.mockReset().mockResolvedValue(undefined);
  onClose.mockReset();
  modalStore.closeGuardActive = false;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Dialog open onOpenChange={() => {}}>
          <InvitePeopleModal workspaceId="ws-1" onSuccess={() => {}} onClose={onClose} />
        </Dialog>
      </QueryClientProvider>
    )
  );
  await settle();
  return document.body;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await act(async () => await Promise.resolve());
}

function button(el: HTMLElement, label: string): HTMLButtonElement {
  const found = [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes(label)
  );
  expect(found, `no ${label} button`).toBeDefined();
  return found!;
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the invite-people modal', () => {
  it('is offered to admins and owners, not members', () => {
    expect(administersWorkspace(workspace('owner') as never)).toBe(true);
    expect(administersWorkspace(workspace('admin') as never)).toBe(true);
    expect(administersWorkspace(workspace('member') as never)).toBe(false);
  });

  it('e-mails an addressed invitation and still shows its link', async () => {
    listInvitations.mockResolvedValue({ invitations: [], emailEnabled: true });
    createInvitation.mockResolvedValue({
      invitation: invitation({ email: 'ada@example.com' }),
      link: 'https://switch.example.com/invite#token=tok-1',
      emailDelivery: 'sent',
    });
    const el = await render();

    await type(el.querySelector<HTMLInputElement>('#invite-people-email')!, ' ada@example.com ');
    await act(async () => button(el, 'Send invitation').click());
    await settle();

    expect(createInvitation).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      role: 'member',
      email: 'ada@example.com',
      expiresInHours: 168,
      usesRemaining: 1,
    });
    expect(el.textContent).toContain('Invitation e-mailed to ada@example.com');
    expect(el.querySelector<HTMLInputElement>('#invite-people-link')!.value).toBe(
      'https://switch.example.com/invite#token=tok-1'
    );
  });

  it('says no e-mail went out when the server has no mail, and hands over the link', async () => {
    listInvitations.mockResolvedValue({ invitations: [], emailEnabled: false });
    createInvitation.mockResolvedValue({
      invitation: invitation({ email: 'ada@example.com' }),
      link: 'https://switch.example.com/invite#token=tok-1',
      emailDelivery: 'not_configured',
    });
    const el = await render();

    expect(el.textContent).toContain('This server has no e-mail set up');
    await type(el.querySelector<HTMLInputElement>('#invite-people-email')!, 'ada@example.com');
    await act(async () => button(el, 'Create link').click());
    await settle();

    expect(el.textContent).toContain('No e-mail was sent');
    expect(el.querySelector<HTMLInputElement>('#invite-people-link')!.value).toContain('tok-1');
  });

  it('works against a server older than e-mailed invitations', async () => {
    listInvitations.mockResolvedValue({ invitations: [], emailEnabled: null });
    createInvitation.mockResolvedValue({
      invitation: invitation({ email: 'ada@example.com' }),
      link: 'https://switch.example.com/invite#token=tok-1',
      emailDelivery: 'unsupported',
    });
    const el = await render();

    expect(el.textContent).toContain('This server does not e-mail invitations');
    await type(el.querySelector<HTMLInputElement>('#invite-people-email')!, 'ada@example.com');
    await act(async () => button(el, 'Create link').click());
    await settle();

    expect(el.textContent).toContain(
      'No e-mail was sent — this server does not e-mail invitations'
    );
    expect(el.querySelector<HTMLInputElement>('#invite-people-link')!.value).toContain('tok-1');
  });

  it('makes a link for anyone when no address is given', async () => {
    listInvitations.mockResolvedValue({ invitations: [], emailEnabled: true });
    createInvitation.mockResolvedValue({
      invitation: invitation({}),
      link: 'https://switch.example.com/invite#token=tok-2',
      emailDelivery: 'not_requested',
    });
    const el = await render();

    await act(async () => button(el, 'Create link').click());
    await settle();

    expect(createInvitation).toHaveBeenCalledWith(expect.objectContaining({ email: null }));
    expect(el.textContent).toContain('Send this link to the person you are inviting');
  });

  it("shows the server's refusal and keeps the form", async () => {
    listInvitations.mockResolvedValue({ invitations: [], emailEnabled: true });
    createInvitation.mockRejectedValue(new Error('Not an e-mail address'));
    const el = await render();

    await type(el.querySelector<HTMLInputElement>('#invite-people-email')!, 'nope');
    await act(async () => button(el, 'Send invitation').click());
    await settle();

    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Not an e-mail address');
    expect(el.querySelector('#invite-people-email')).not.toBeNull();
  });

  it('lists invitations and offers Revoke only on live ones', async () => {
    listInvitations.mockResolvedValue({
      emailEnabled: true,
      invitations: [
        invitation({ id: 'live', email: 'ada@example.com' }),
        invitation({ id: 'gone', revokedAt: new Date().toISOString() }),
        invitation({ id: 'lapsed', expiresAt: new Date(Date.now() - 1000).toISOString() }),
        invitation({ id: 'spent', usesRemaining: 0 }),
      ],
    });
    revokeInvitation.mockResolvedValue(invitation({ id: 'live' }));
    const el = await render();

    const rows = [...el.querySelectorAll<HTMLElement>('[data-testid="invitation-row"]')];
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Active'),
      expect.stringContaining('Revoked'),
      expect.stringContaining('Expired'),
      expect.stringContaining('Used'),
    ]);
    expect(
      rows.filter((r) => r.textContent?.includes('Revoke') && !r.textContent.includes('Revoked'))
    ).toHaveLength(1);

    await act(async () => button(rows[0]!, 'Revoke').click());
    await settle();

    expect(revokeInvitation).toHaveBeenCalledWith({ workspaceId: 'ws-1', invitationId: 'live' });
    expect(listInvitations).toHaveBeenCalledTimes(2);
  });

  it('does not let an admin hand out ownership', async () => {
    listInvitations.mockResolvedValue({ invitations: [], emailEnabled: true });
    byId.mockReturnValue(workspace('admin'));
    const el = await render();

    await act(async () => el.querySelector<HTMLElement>('[aria-label="Role"]')!.click());
    await settle();

    const options = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(options).toEqual(['Member', 'Admin']);
  });
});

describe('joining by e-mail domain', () => {
  function section(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[data-testid="join-domains-section"]');
  }

  it("offers only the admin's own domain, and opens the workspace to it", async () => {
    listInvitations.mockResolvedValue({ invitations: [], emailEnabled: true });
    listJoinDomains
      .mockResolvedValueOnce({
        kind: 'listed',
        domains: [],
        ownDomain: 'acme.example',
        ownDomainRefusal: null,
      })
      .mockResolvedValue({
        kind: 'listed',
        domains: ['acme.example'],
        ownDomain: 'acme.example',
        ownDomainRefusal: null,
      });
    await render();

    expect(section()!.textContent).toContain('Let anyone with an @acme.example address join');
    await act(async () => button(section()!, 'Allow').click());
    await settle();

    expect(addJoinDomain).toHaveBeenCalledWith({ workspaceId: 'ws-1', domain: 'acme.example' });
    const rows = section()!.querySelectorAll('[data-testid="join-domain-row"]');
    expect(rows).toHaveLength(1);
    expect(section()!.textContent).not.toContain('Allow');
  });

  it('removes a domain', async () => {
    listInvitations.mockResolvedValue({ invitations: [], emailEnabled: true });
    listJoinDomains.mockResolvedValue({
      kind: 'listed',
      domains: ['acme.example'],
      ownDomain: 'acme.example',
      ownDomainRefusal: null,
    });
    await render();

    await act(async () => button(section()!, 'Remove').click());
    await settle();

    expect(removeJoinDomain).toHaveBeenCalledWith({ workspaceId: 'ws-1', domain: 'acme.example' });
  });

  it("shows why a public provider's domain cannot be added", async () => {
    listInvitations.mockResolvedValue({ invitations: [], emailEnabled: true });
    listJoinDomains.mockResolvedValue({
      kind: 'listed',
      domains: [],
      ownDomain: 'gmail.com',
      ownDomainRefusal:
        'gmail.com is a public e-mail provider, so opening the workspace to it would let anyone with an address there join',
    });
    await render();

    expect(section()!.textContent).toContain('gmail.com is a public e-mail provider');
    expect(section()!.textContent).not.toContain('Allow');
  });

  it('is left out on a server too old to have it', async () => {
    listInvitations.mockResolvedValue({ invitations: [], emailEnabled: true });
    await render();

    expect(section()).toBeNull();
  });
});
