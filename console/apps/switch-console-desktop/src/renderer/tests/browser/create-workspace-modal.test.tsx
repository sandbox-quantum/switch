/**
 * Making a workspace from the switcher.
 *
 * A workspace belongs to a server, so what this has to get right is which one:
 * the question is only asked where there is a choice, and a server that cannot
 * be asked at all is said to be so rather than allowed to fail on Create.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const create = vi.hoisted(() => vi.fn());
const setActiveWorkspace = vi.hoisted(() => vi.fn());
const connected = vi.hoisted(() => new Set<string>());
/** Ids a status read has answered for. Not asked yet is its own state. */
const statuses = vi.hoisted(() => new Map<string, unknown>());
const unreachable = vi.hoisted(() => new Set<string>());
const refreshStatus = vi.hoisted(() => vi.fn());
const servers = vi.hoisted(() => [] as { id: string; name: string }[]);

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    get servers() {
      return servers;
    },
    statuses,
    isConnected: (id: string) => connected.has(id),
    isUnreachable: (id: string) => unreachable.has(id),
    refreshStatus,
    serverById: (id: string) => servers.find((s) => s.id === id) ?? null,
  },
}));

vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: { create, setActive: setActiveWorkspace },
}));

import { CreateWorkspaceModal } from '@renderer/features/workspaces/create-workspace-modal';
import { modalStore } from '@renderer/lib/modal/modal-store';
import { Dialog } from '@renderer/lib/ui/dialog';
import { RpcError } from '@shared/lib/ipc/rpc-error';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const onSuccess = vi.fn();
const onClose = vi.fn();

function workspace(id: string, serverId: string) {
  return {
    id,
    serverId,
    name: 'Weekend Robotics',
    tenantId: 't1',
    slug: 'weekend-robotics',
    role: 'owner' as const,
    createdAt: '',
    updatedAt: '',
  };
}

beforeEach(() => {
  create.mockReset();
  setActiveWorkspace.mockReset().mockResolvedValue(undefined);
  refreshStatus.mockReset();
  onSuccess.mockReset();
  onClose.mockReset();
  servers.length = 0;
  connected.clear();
  statuses.clear();
  unreachable.clear();
  modalStore.closeGuardActive = false;
});

/**
 * A server the app knows about, in one of the four states the modal tells
 * apart.
 *
 * `unknown` is the one that is not a failure: no status read has answered for
 * it yet, which is a different thing from having answered "not signed in".
 */
function addServer(
  id: string,
  name: string,
  state: 'signedIn' | 'signedOut' | 'unreachable' | 'unknown'
) {
  servers.push({ id, name });
  if (state === 'unknown') return;
  statuses.set(id, { serverId: id, connected: state === 'signedIn', user: null });
  if (state === 'signedIn') connected.add(id);
  if (state === 'unreachable') unreachable.add(id);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(serverId: string): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // The modal renders the dialog's parts and not the dialog itself — the
  // registry supplies that in the app, and this supplies it here.
  await act(async () =>
    root!.render(
      <Dialog open onOpenChange={() => {}}>
        <CreateWorkspaceModal serverId={serverId} onSuccess={onSuccess} onClose={onClose} />
      </Dialog>
    )
  );
  return container;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await act(async () => await Promise.resolve());
}

/** By substring: the confirm button carries its keyboard shortcut in its text. */
function button(el: HTMLElement, label: string): HTMLButtonElement {
  const found = [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes(label)
  );
  expect(found, `no ${label} button`).toBeDefined();
  return found!;
}

async function typeName(el: HTMLElement, value: string): Promise<void> {
  const input = el.querySelector('input')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** A label that is present in the dialog, ignoring the select's own portal. */
function hasLabel(el: HTMLElement, text: string): boolean {
  return [...el.querySelectorAll('label')].some((l) => l.textContent?.trim() === text);
}

describe('the create-workspace modal', () => {
  it('creates on the server the window is in, and goes there', async () => {
    addServer('srv-1', 'Acme prod', 'signedIn');
    const made = workspace('ws-9', 'srv-1');
    create.mockResolvedValue(made);

    const el = await render('srv-1');
    await typeName(el, '  Weekend Robotics  ');
    await act(async () => button(el, 'Create workspace').click());
    await settle();

    expect(create).toHaveBeenCalledWith('srv-1', 'Weekend Robotics');
    expect(setActiveWorkspace).toHaveBeenCalledWith('ws-9');
    expect(onSuccess).toHaveBeenCalledWith(made);
  });

  it('does not ask which server when there is only one to ask about', async () => {
    addServer('srv-1', 'Acme prod', 'signedIn');

    const el = await render('srv-1');

    expect(hasLabel(el, 'Server')).toBe(false);
    expect(el.textContent).toContain('Acme prod');
  });

  it('asks which server once there are two you are signed in to', async () => {
    addServer('srv-1', 'Acme prod', 'signedIn');
    addServer('srv-2', 'Acme staging', 'signedIn');

    const el = await render('srv-1');

    expect(hasLabel(el, 'Server')).toBe(true);
  });

  // The failure would otherwise arrive as an authentication error on Create,
  // which reads as the name being refused.
  it('refuses to ask a server you are not signed in to', async () => {
    addServer('srv-1', 'Acme prod', 'signedOut');

    const el = await render('srv-1');
    await typeName(el, 'Weekend Robotics');

    expect(el.textContent).toContain('not signed in to Acme prod');
    expect(button(el, 'Create workspace').disabled).toBe(true);
  });

  it('will not create a workspace with no name', async () => {
    addServer('srv-1', 'Acme prod', 'signedIn');

    const el = await render('srv-1');
    await typeName(el, '   ');

    expect(button(el, 'Create workspace').disabled).toBe(true);
  });

  it('keeps the form and says why when the server refuses the name', async () => {
    addServer('srv-1', 'Acme prod', 'signedIn');
    create.mockRejectedValue(new Error('A workspace with that name already exists.'));

    const el = await render('srv-1');
    await typeName(el, 'Weekend Robotics');
    await act(async () => button(el, 'Create workspace').click());
    await settle();

    expect(el.textContent).toContain('already exists');
    expect(onSuccess).not.toHaveBeenCalled();
    expect(button(el, 'Create workspace').disabled).toBe(false);
  });

  /**
   * The refusal the gateway actually sends, rather than a plain Error. Its
   * words are `Slug already taken: weekend-robotics` — no terminal punctuation,
   * so the shared description does not read it as a sentence and demotes it to
   * diagnostics. What reached the user was a status code and a slug they never
   * typed, for the likeliest failure of this form and the only one they can fix.
   */
  it('blames the name for a name conflict, not the status code and the slug', async () => {
    addServer('srv-1', 'Acme prod', 'signedIn');
    create.mockRejectedValue(
      new RpcError({
        __switchConsoleRpcError: true,
        code: 'GatewayError',
        message: 'Gateway returned 409: Slug already taken: weekend-robotics',
        data: { kind: 'http', status: 409, detail: 'Slug already taken: weekend-robotics' },
      } as unknown as ConstructorParameters<typeof RpcError>[0])
    );

    const el = await render('srv-1');
    await typeName(el, 'Weekend Robotics');
    await act(async () => button(el, 'Create workspace').click());
    await settle();

    expect(el.textContent).toContain('already goes by that name');
    expect(el.textContent).not.toContain('weekend-robotics');
    expect(el.textContent).not.toContain('409');
    // Still typeable: a different name is the whole of the remedy.
    expect(el.querySelector('input')!.disabled).toBe(false);
  });

  /**
   * "Not signed in" and "cannot be reached" want different things from the
   * user, and only one of them is a password. Sending someone to re-authenticate
   * for a network outage is the same misattribution this modal exists to avoid,
   * pointing the other way.
   */
  it('says a server is unreachable rather than telling you to sign in again', async () => {
    addServer('srv-1', 'Acme prod', 'unreachable');

    const el = await render('srv-1');

    expect(el.textContent).toContain('can’t be reached');
    expect(el.textContent).not.toContain('not signed in');
  });

  it('does not claim you are signed out before it has looked', async () => {
    addServer('srv-1', 'Acme prod', 'unknown');

    const el = await render('srv-1');

    expect(el.textContent).toContain('Checking whether you’re signed in');
    expect(el.textContent).not.toContain('not signed in to');
    // Nothing else on screen is watching this server, so the modal has to ask
    // or the sentence above is what it says forever.
    expect(refreshStatus).toHaveBeenCalledWith('srv-1');
  });

  /**
   * The hidden default was the window's own server, which may be the one that
   * cannot be asked — leaving Create permanently off with the usable server
   * offered nowhere.
   */
  it('opens on a server it can ask when the window’s own cannot be', async () => {
    addServer('srv-1', 'Acme prod', 'signedOut');
    addServer('srv-2', 'Acme staging', 'signedIn');
    create.mockResolvedValue(workspace('ws-9', 'srv-2'));

    const el = await render('srv-1');
    await typeName(el, 'Weekend Robotics');
    await act(async () => button(el, 'Create workspace').click());
    await settle();

    expect(el.textContent).toContain('Acme staging');
    expect(create).toHaveBeenCalledWith('srv-2', 'Weekend Robotics');
  });

  /**
   * `dismissOnOutsideClick: false` stops the backdrop but not Escape, so
   * without the guard a keypress mid-create leaves the window re-scoped and
   * `onSuccess` firing on a modal the user believed they had cancelled.
   */
  it('holds itself shut while the create is in flight', async () => {
    addServer('srv-1', 'Acme prod', 'signedIn');
    const creating = deferred<ReturnType<typeof workspace>>();
    create.mockReturnValue(creating.promise);

    const el = await render('srv-1');
    await typeName(el, 'Weekend Robotics');
    await act(async () => button(el, 'Create workspace').click());

    expect(modalStore.closeGuardActive).toBe(true);

    creating.resolve(workspace('ws-9', 'srv-1'));
    await settle();

    expect(modalStore.closeGuardActive).toBe(false);
  });

  /**
   * The workspace exists on the server from the moment Create returns.
   * Offering Create again would send the same name back and earn a conflict
   * that reads as the name being refused — on the first-run page with no way
   * back, that is the end of the road.
   */
  it('offers to open the workspace it already made rather than creating it twice', async () => {
    addServer('srv-1', 'Acme prod', 'signedIn');
    create.mockResolvedValue(workspace('ws-9', 'srv-1'));
    setActiveWorkspace.mockRejectedValueOnce(new Error('could not switch'));

    const el = await render('srv-1');
    await typeName(el, 'Weekend Robotics');
    await act(async () => button(el, 'Create workspace').click());
    await settle();

    expect(el.textContent).toContain('could not be moved into it');

    await act(async () => button(el, 'Open workspace').click());
    await settle();

    expect(create).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({ id: 'ws-9' }));
  });

  // Creating it and then leaving the window in the old workspace would look
  // like nothing happened, so a switch that fails is not reported as success.
  it('does not report success when the new workspace cannot be entered', async () => {
    addServer('srv-1', 'Acme prod', 'signedIn');
    create.mockResolvedValue(workspace('ws-9', 'srv-1'));
    setActiveWorkspace.mockRejectedValue(new Error('could not switch'));

    const el = await render('srv-1');
    await typeName(el, 'Weekend Robotics');
    await act(async () => button(el, 'Create workspace').click());
    await settle();

    expect(onSuccess).not.toHaveBeenCalled();
    expect(el.textContent).toContain('could not switch');
  });
});
