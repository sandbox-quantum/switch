/**
 * Confirming that a messaging app's older links must be confirmed (CHOO-3881).
 *
 * Every one of them stops counting at once, which locks its owner out of
 * their own owner-only agents until they post a code. So the dialog names
 * everyone affected and says what it costs before anything moves.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

const listUnconfirmedLinks = vi.hoisted(() => vi.fn());
const requireLinkConfirmation = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { workspaces: { listUnconfirmedLinks, requireLinkConfirmation } },
  events: { on: () => () => {}, emit: () => {} },
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast }));

import { RequireLinkConfirmationModal } from '@renderer/features/switch-servers/RequireLinkConfirmationModal';
import { unconfirmedLinksQueryKey } from '@renderer/features/switch-servers/unconfirmed-links';
import { myIdentitiesQueryKey } from '@renderer/features/switch-servers/use-my-identities';
import { Dialog } from '@renderer/lib/ui/dialog';

const LINKS = [
  { id: 'eu-1', externalUserId: 'U1', externalUsername: 'ada', userId: 'u1', userName: 'Ada' },
  { id: 'eu-2', externalUserId: 'U2', externalUsername: '@grace', userId: 'u2', userName: 'Grace' },
];

const onSuccess = vi.fn();
const onClose = vi.fn();

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient;

beforeEach(() => {
  for (const mock of [listUnconfirmedLinks, requireLinkConfirmation, toast, onSuccess, onClose]) {
    mock.mockReset();
  }
  listUnconfirmedLinks.mockResolvedValue(LINKS);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
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
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Dialog open onOpenChange={() => {}}>
          <RequireLinkConfirmationModal
            workspaceId="ws-1"
            bridgeId="b-acme"
            bridgeDisplayName="Acme Slack"
            onSuccess={onSuccess}
            onClose={onClose}
          />
        </Dialog>
      </QueryClientProvider>
    )
  );
  await settle();
  return document.body;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await act(async () => await Promise.resolve());
}

function button(el: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...el.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(label));
}

describe('requiring confirmation for older links', () => {
  it('names everyone affected and what it costs them', async () => {
    const el = await render();

    expect(el.textContent).toContain('made before links had to be confirmed');
    const rows = [...el.querySelectorAll('[data-testid="unconfirmed-links"] li')].map(
      (li) => li.textContent
    );
    expect(rows).toEqual(['Ada@ada', 'Grace@grace']);
    expect(el.textContent).toContain('Until each person posts the code Console shows them');
    expect(button(el, 'Cancel')).toBeDefined();
  });

  it('moves them, says how many, refreshes the lists and closes', async () => {
    requireLinkConfirmation.mockResolvedValue({ kind: 'required', moved: 2 });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const el = await render();

    await act(async () => button(el, 'Require confirmation')!.click());
    await settle();

    expect(requireLinkConfirmation).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      bridgeId: 'b-acme',
    });
    expect(toast).toHaveBeenCalledWith({ title: '2 links now need confirming' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: myIdentitiesQueryKey('ws-1') });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: unconfirmedLinksQueryKey('ws-1', 'b-acme'),
    });
    expect(onSuccess).toHaveBeenCalledWith({ moved: 2 });
  });

  it('shows a refusal inline and stays open', async () => {
    requireLinkConfirmation.mockResolvedValue({
      kind: 'refused',
      message: 'Workspace admin access required',
    });
    const el = await render();

    await act(async () => button(el, 'Require confirmation')!.click());
    await settle();

    expect(el.textContent).toContain('Workspace admin access required');
    expect(onSuccess).not.toHaveBeenCalled();
    expect(button(el, 'Require confirmation')?.disabled).toBe(false);
  });

  it('has nothing to confirm when no older links are left', async () => {
    listUnconfirmedLinks.mockResolvedValue([]);
    const el = await render();

    expect(el.textContent).toContain('No older links are left in Acme Slack.');
    expect(button(el, 'Require confirmation')?.disabled).toBe(true);
  });

  it('cancels without moving anything', async () => {
    const el = await render();

    await act(async () => button(el, 'Cancel')!.click());

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(requireLinkConfirmation).not.toHaveBeenCalled();
  });
});
