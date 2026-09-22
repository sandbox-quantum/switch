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
    isConnected: (id: string) => connected.has(id),
    serverById: (id: string) => servers.find((s) => s.id === id) ?? null,
  },
}));

vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: { create, setActive: setActiveWorkspace },
}));

import { CreateWorkspaceModal } from '@renderer/features/workspaces/create-workspace-modal';
import { Dialog } from '@renderer/lib/ui/dialog';

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
  onSuccess.mockReset();
  onClose.mockReset();
  servers.length = 0;
  connected.clear();
});

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
    servers.push({ id: 'srv-1', name: 'Acme prod' });
    connected.add('srv-1');
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
    servers.push({ id: 'srv-1', name: 'Acme prod' });
    connected.add('srv-1');

    const el = await render('srv-1');

    expect(hasLabel(el, 'Server')).toBe(false);
    expect(el.textContent).toContain('Acme prod');
  });

  it('asks which server once there are two you are signed in to', async () => {
    servers.push({ id: 'srv-1', name: 'Acme prod' }, { id: 'srv-2', name: 'Acme staging' });
    connected.add('srv-1');
    connected.add('srv-2');

    const el = await render('srv-1');

    expect(hasLabel(el, 'Server')).toBe(true);
  });

  // The failure would otherwise arrive as an authentication error on Create,
  // which reads as the name being refused.
  it('refuses to ask a server you are not signed in to', async () => {
    servers.push({ id: 'srv-1', name: 'Acme prod' });

    const el = await render('srv-1');
    await typeName(el, 'Weekend Robotics');

    expect(el.textContent).toContain('not signed in to Acme prod');
    expect(button(el, 'Create workspace').disabled).toBe(true);
  });

  it('will not create a workspace with no name', async () => {
    servers.push({ id: 'srv-1', name: 'Acme prod' });
    connected.add('srv-1');

    const el = await render('srv-1');
    await typeName(el, '   ');

    expect(button(el, 'Create workspace').disabled).toBe(true);
  });

  it('keeps the form and says why when the server refuses the name', async () => {
    servers.push({ id: 'srv-1', name: 'Acme prod' });
    connected.add('srv-1');
    create.mockRejectedValue(new Error('A workspace with that name already exists.'));

    const el = await render('srv-1');
    await typeName(el, 'Weekend Robotics');
    await act(async () => button(el, 'Create workspace').click());
    await settle();

    expect(el.textContent).toContain('already exists');
    expect(onSuccess).not.toHaveBeenCalled();
    expect(button(el, 'Create workspace').disabled).toBe(false);
  });

  // Creating it and then leaving the window in the old workspace would look
  // like nothing happened, so a switch that fails is not reported as success.
  it('does not report success when the new workspace cannot be entered', async () => {
    servers.push({ id: 'srv-1', name: 'Acme prod' });
    connected.add('srv-1');
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
