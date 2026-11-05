/**
 * Linking a messaging account now waits for proof (CHOO-3881).
 *
 * "This is me" used to link the account on the spot, so anyone could say any
 * account was theirs. A current server holds the link pending until a one-time
 * code is posted from the account, so the dialog must not close on the claim:
 * it shows the code, how to post it, when it runs out, and waits — offering a
 * new code and a way to cancel — until the link turns up confirmed. A server
 * that predates this links at once, and the dialog behaves as it always did.
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

const listBridges = vi.hoisted(() => vi.fn());
const listMyIdentities = vi.hoisted(() => vi.fn());
const listMyPendingIdentities = vi.hoisted(() => vi.fn());
const searchBridgeDirectory = vi.hoisted(() => vi.fn());
const claimBridgeIdentity = vi.hoisted(() => vi.fn());
const issueIdentityLinkCode = vi.hoisted(() => vi.fn());
const releaseBridgeIdentity = vi.hoisted(() => vi.fn());
const cancelIdentityLinkRequest = vi.hoisted(() => vi.fn());
const reportIdentityConfirmed = vi.hoisted(() => vi.fn());

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    workspaces: {
      listBridges,
      listMyIdentities,
      listMyPendingIdentities,
      searchBridgeDirectory,
      claimBridgeIdentity,
      issueIdentityLinkCode,
      releaseBridgeIdentity,
      cancelIdentityLinkRequest,
      reportIdentityConfirmed,
    },
  },
  events: { on: () => () => {}, emit: () => {} },
}));

import { format } from 'date-fns';
import type { AccountLinkTarget } from '@renderer/features/switch-servers/account-link-confirmation';
import { ClaimIdentityModal } from '@renderer/features/switch-servers/ClaimIdentityModal';
import { myIdentitiesQueryKey } from '@renderer/features/switch-servers/use-my-identities';
import { Dialog } from '@renderer/lib/ui/dialog';
import type {
  ClaimIdentityResult,
  LinkCode,
  LinkedIdentity,
  PendingIdentity,
  RemoteBridge,
} from '@shared/core/switch-servers/switch-servers';

const SLACK: RemoteBridge = {
  id: 'b-slack',
  type: 'slack',
  displayName: 'Acme Slack',
  status: 'active',
  isDefault: false,
  homeUrl: null,
  channelCreationSupported: true,
  canCreateChannels: true,
  directorySearchSupported: true,
  attention: null,
  teamPlacementSupported: false,
  channelIdsRefused: null,
  receivesWebhooks: false,
  webhookUrl: null,
};

const PERSON = {
  externalUserId: 'U1',
  username: 'ada',
  displayName: 'Ada Lovelace',
  email: null,
  knownExternalUserId: 'eu-1',
  claimedBy: [],
};

function inMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

const CODE: LinkCode = {
  code: '7KQ2-M9XD',
  expiresAt: inMinutes(30),
  expiresInSeconds: 1800,
  instructions: 'Run `/link-account 7KQ2-M9XD` from that account in any channel Switch is in.',
};

const LINKED: LinkedIdentity = {
  id: 'eu-1',
  bridgeId: 'b-slack',
  bridgeDisplayName: 'Acme Slack',
  bridgeType: 'slack',
  externalUserId: 'U1',
  externalUsername: 'ada',
  verified: true,
};

const PENDING_RESULT = {
  kind: 'pending' as const,
  pending: {
    id: 'eu-1',
    bridgeId: 'b-slack',
    bridgeDisplayName: 'Acme Slack',
    bridgeType: 'slack',
    externalUserId: 'U1',
    externalUsername: 'ada',
    requestedByName: null,
    codeExpiresAt: CODE.expiresAt,
  },
  code: CODE,
  alreadyLinked: false,
};

const onSuccess = vi.fn();
const onClose = vi.fn();

/** The links the server is holding for a code, as the pending list reports them. */
let pendingOnServer: PendingIdentity[] = [];

/** Answer the claim with `result`, starting a waiting link when it is one. */
function claimReturns(result: ClaimIdentityResult): void {
  claimBridgeIdentity.mockImplementation(async () => {
    if (result.kind === 'pending' && !result.alreadyLinked) pendingOnServer = [result.pending];
    return result;
  });
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient;

beforeEach(() => {
  for (const mock of [
    listBridges,
    listMyIdentities,
    listMyPendingIdentities,
    searchBridgeDirectory,
    claimBridgeIdentity,
    issueIdentityLinkCode,
    releaseBridgeIdentity,
    cancelIdentityLinkRequest,
    reportIdentityConfirmed,
    onSuccess,
    onClose,
  ]) {
    mock.mockReset();
  }
  listBridges.mockResolvedValue([SLACK]);
  listMyIdentities.mockResolvedValue([]);
  pendingOnServer = [];
  listMyPendingIdentities.mockImplementation(async () => pendingOnServer);
  searchBridgeDirectory.mockResolvedValue({ kind: 'results', users: [PERSON], note: null });
  releaseBridgeIdentity.mockResolvedValue(undefined);
  cancelIdentityLinkRequest.mockResolvedValue({ kind: 'cancelled' });
  reportIdentityConfirmed.mockResolvedValue(undefined);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(confirm?: AccountLinkTarget): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Dialog open onOpenChange={() => {}}>
          <ClaimIdentityModal
            workspaceId="ws-1"
            bridgeId="b-slack"
            {...(confirm ? { confirm } : {})}
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
  return [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
}

async function click(target: HTMLElement | undefined): Promise<void> {
  expect(target).toBeDefined();
  await act(async () => target!.click());
  await settle();
}

/** Search for Ada and press "This is me". */
async function claimAda(el: HTMLElement): Promise<void> {
  const input = el.querySelector('input') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'ada'
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await vi.waitFor(() => expect(button(el, 'This is me')).toBeDefined());
  await click(button(el, 'This is me'));
}

describe('linking an account on a server that wants proof', () => {
  it('stays open on the code rather than closing on the claim', async () => {
    claimReturns(PENDING_RESULT);
    const el = await render();

    await claimAda(el);

    expect(onSuccess).not.toHaveBeenCalled();
    expect(el.querySelector('[data-testid="link-code"]')?.textContent).toBe('7KQ2-M9XD');
    expect(el.textContent).toContain('To finish linking @ada, post this code');
    // The server's instructions, with the command set as code rather than
    // showing its backticks.
    const command = [...el.querySelectorAll('code')].map((c) => c.textContent);
    expect(command).toContain('/link-account 7KQ2-M9XD');
    expect(el.textContent).not.toContain('`');
    expect(el.textContent).toMatch(/It expires at \d\d:\d\d/);
    expect(button(el, 'Copy')).toBeDefined();
  });

  it('gives a new code in place of the old one', async () => {
    claimReturns(PENDING_RESULT);
    issueIdentityLinkCode.mockResolvedValue({
      kind: 'issued',
      code: { ...CODE, code: 'ZZ99-AB12' },
    });
    const el = await render();
    await claimAda(el);

    await click(button(el, 'Get a new code'));

    expect(issueIdentityLinkCode).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      bridgeId: 'b-slack',
      identityId: 'eu-1',
    });
    expect(el.querySelector('[data-testid="link-code"]')?.textContent).toBe('ZZ99-AB12');
  });

  it('says so when the server will not give a new code', async () => {
    claimReturns(PENDING_RESULT);
    issueIdentityLinkCode.mockResolvedValue({
      kind: 'refused',
      message: 'You have not started linking this account. Link it first.',
    });
    const el = await render();
    await claimAda(el);

    await click(button(el, 'Get a new code'));

    expect(el.textContent).toContain('You have not started linking this account.');
  });

  it('cancels the link and goes back to the search', async () => {
    claimReturns(PENDING_RESULT);
    const el = await render();
    await claimAda(el);

    await click(button(el, 'Cancel link'));

    expect(cancelIdentityLinkRequest).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      bridgeId: 'b-slack',
      identityId: 'eu-1',
    });
    expect(releaseBridgeIdentity).not.toHaveBeenCalled();
    expect(el.querySelector('[data-testid="link-code"]')).toBeNull();
    expect(el.textContent).toContain('Search Acme Slack');
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('shows the link confirmed once it turns up, then finishes', async () => {
    claimReturns(PENDING_RESULT);
    const el = await render();
    await claimAda(el);

    // What the poll finds once the code has been posted.
    listMyIdentities.mockResolvedValue([LINKED]);
    await act(async () => client.invalidateQueries({ queryKey: myIdentitiesQueryKey('ws-1') }));
    await settle();

    expect(el.textContent).toContain('Linked to @ada.');
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledWith({ identity: LINKED }), {
      timeout: 3000,
    });
    // Counted once, for the link this screen watched become confirmed.
    expect(reportIdentityConfirmed).toHaveBeenCalledTimes(1);
    expect(reportIdentityConfirmed).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      bridgeId: 'b-slack',
      identityId: 'eu-1',
      kind: 'pending',
    });
  });

  it('notices a link cancelled somewhere else, and offers to start again', async () => {
    claimReturns(PENDING_RESULT);
    const el = await render();
    await claimAda(el);
    await settle();
    expect(el.querySelector('[data-testid="link-code"]')).not.toBeNull();

    // An admin cancels it: it is neither waiting nor linked any more.
    pendingOnServer = [];
    await act(async () => client.invalidateQueries({ queryKey: myIdentitiesQueryKey('ws-1') }));
    await vi.waitFor(() => expect(el.textContent).toContain('was cancelled'));

    expect(el.querySelector('[data-testid="link-code"]')).toBeNull();
    await click(button(el, 'Start again'));
    expect(el.textContent).toContain('Search Acme Slack');
    expect(reportIdentityConfirmed).not.toHaveBeenCalled();
  });

  it('does not mistake a confirmation landing between two reads for a cancel', async () => {
    // The pending list is read after the code is posted and the linked list
    // just before: neither shows the link. A fresh read of the linked list
    // settles it.
    claimReturns(PENDING_RESULT);
    const el = await render();
    await claimAda(el);
    await settle();

    pendingOnServer = [];
    listMyIdentities.mockResolvedValueOnce([]).mockResolvedValue([LINKED]);
    await act(async () => client.invalidateQueries({ queryKey: myIdentitiesQueryKey('ws-1') }));

    await vi.waitFor(() => expect(el.textContent).toContain('Linked to @ada.'));
    expect(el.textContent).not.toContain('was cancelled');
  });

  it('stays on the code when there was nothing left to cancel', async () => {
    claimReturns(PENDING_RESULT);
    cancelIdentityLinkRequest.mockResolvedValue({
      kind: 'refused',
      message: 'Nothing is waiting to be confirmed.',
    });
    const el = await render();
    await claimAda(el);

    await click(button(el, 'Cancel link'));

    expect(el.textContent).toContain('Nothing is waiting to be confirmed.');
    expect(el.querySelector('[data-testid="link-code"]')).not.toBeNull();
  });

  it('treats re-claiming an unconfirmed link as confirming it, which Cancel leaves standing', async () => {
    // The server answers such a claim with a code like any other; the link it
    // already has works meanwhile, so the screen must not talk of finishing a
    // link, and Cancel must withdraw only the code.
    claimReturns({ ...PENDING_RESULT, alreadyLinked: true });
    const el = await render();
    await claimAda(el);

    expect(el.textContent).toContain('Confirm @ada is yours');
    await click(button(el, 'Cancel confirmation'));

    expect(cancelIdentityLinkRequest).toHaveBeenCalledTimes(1);
    expect(releaseBridgeIdentity).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Search Acme Slack');
  });

  it('says when the code has run out, and offers a new one', async () => {
    claimReturns({
      ...PENDING_RESULT,
      code: { ...CODE, expiresInSeconds: 0 },
    });
    const el = await render();
    await claimAda(el);
    await vi.waitFor(() => expect(el.textContent).toContain('This code has expired.'));

    expect(button(el, 'Copy')?.disabled).toBe(true);
    expect(button(el, 'Get a new code')?.disabled).toBe(false);
  });

  it('keeps looking for the link after the code seems to have run out', async () => {
    // The expiry is read off this machine's clock. One running fast would
    // otherwise stop the app noticing a code that was posted in time.
    claimReturns({
      ...PENDING_RESULT,
      code: { ...CODE, expiresInSeconds: 0 },
    });
    const el = await render();
    await claimAda(el);
    await vi.waitFor(() => expect(el.textContent).toContain('This code has expired.'));

    listMyIdentities.mockResolvedValue([LINKED]);

    await vi.waitFor(() => expect(el.textContent).toContain('Linked to @ada.'), {
      timeout: 6000,
    });
  });
});

describe('a clock on this machine that is wrong', () => {
  it('counts a fresh code from when it arrived, not from the server’s clock', async () => {
    // This machine runs 45 minutes fast, so the server's "expires at" is
    // already in its past. The code has its full 30 minutes all the same.
    claimReturns({
      ...PENDING_RESULT,
      code: { ...CODE, expiresAt: inMinutes(-15), expiresInSeconds: 1800 },
    });
    const before = format(Date.now() + 1_800_000, 'HH:mm');
    const el = await render();
    await claimAda(el);
    const after = format(Date.now() + 1_800_000, 'HH:mm');

    expect(el.textContent).not.toContain('This code has expired.');
    expect(button(el, 'Copy')?.disabled).toBe(false);
    // The deadline is shown on the clock the user is looking at.
    const shown = /It expires at (\d\d:\d\d)/.exec(el.textContent ?? '')?.[1];
    expect([before, after]).toContain(shown);
  });

  it('falls back to the server’s expiry from a server that sends no lifetime', async () => {
    claimReturns({
      ...PENDING_RESULT,
      code: { ...CODE, expiresAt: inMinutes(-1), expiresInSeconds: null },
    });
    const el = await render();
    await claimAda(el);

    await vi.waitFor(() => expect(el.textContent).toContain('This code has expired.'));
  });
});

describe('opening straight on a link that needs its code', () => {
  it('asks for a fresh code on open, once', async () => {
    pendingOnServer = [PENDING_RESULT.pending];
    issueIdentityLinkCode.mockResolvedValue({ kind: 'issued', code: CODE });
    const el = await render({ identityId: 'eu-1', externalUsername: 'ada', kind: 'pending' });

    await vi.waitFor(() =>
      expect(el.querySelector('[data-testid="link-code"]')?.textContent).toBe('7KQ2-M9XD')
    );
    expect(issueIdentityLinkCode).toHaveBeenCalledTimes(1);
    expect(button(el, 'Cancel link')).toBeDefined();
  });

  it('withdraws only the code when confirming a link made before confirming', async () => {
    // That link works today. Cancel takes back the code, never the link.
    listMyIdentities.mockResolvedValue([{ ...LINKED, verified: false }]);
    issueIdentityLinkCode.mockResolvedValue({ kind: 'issued', code: CODE });
    const el = await render({ identityId: 'eu-1', externalUsername: 'ada', kind: 'unverified' });
    await vi.waitFor(() => expect(el.querySelector('[data-testid="link-code"]')).not.toBeNull());

    expect(el.textContent).toContain('Confirm @ada is yours');
    expect(button(el, 'Cancel link')).toBeUndefined();
    await click(button(el, 'Cancel confirmation'));

    expect(cancelIdentityLinkRequest).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      bridgeId: 'b-slack',
      identityId: 'eu-1',
    });
    expect(releaseBridgeIdentity).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    // Requests for links that already exist are not in the pending list, so
    // it is not watched for one.
    expect(listMyPendingIdentities).not.toHaveBeenCalled();
  });

  it('does not count a link that was already confirmed when it opened', async () => {
    listMyIdentities.mockResolvedValue([LINKED]);
    issueIdentityLinkCode.mockResolvedValue({ kind: 'issued', code: CODE });
    const el = await render({ identityId: 'eu-1', externalUsername: 'ada', kind: 'unverified' });

    await vi.waitFor(() => expect(el.textContent).toContain('@ada is confirmed.'));
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalled(), { timeout: 3000 });
    expect(reportIdentityConfirmed).not.toHaveBeenCalled();
  });

  it('closes without cancelling anything', async () => {
    listMyIdentities.mockResolvedValue([{ ...LINKED, verified: false }]);
    issueIdentityLinkCode.mockResolvedValue({ kind: 'issued', code: CODE });
    const el = await render({ identityId: 'eu-1', externalUsername: 'ada', kind: 'unverified' });
    await vi.waitFor(() => expect(el.querySelector('[data-testid="link-code"]')).not.toBeNull());

    await click(button(el, 'Close'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(cancelIdentityLinkRequest).not.toHaveBeenCalled();
    expect(releaseBridgeIdentity).not.toHaveBeenCalled();
  });
});

describe('a server that predates confirming links', () => {
  it('links at once and closes, as before', async () => {
    claimReturns({ kind: 'claimed', identity: LINKED });
    const el = await render();

    await claimAda(el);

    expect(onSuccess).toHaveBeenCalledWith({ identity: LINKED });
    expect(el.querySelector('[data-testid="link-code"]')).toBeNull();
  });
});
