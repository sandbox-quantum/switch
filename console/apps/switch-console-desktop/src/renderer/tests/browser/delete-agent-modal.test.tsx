import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

/**
 * Removing a remote agent (CHOO-2893): a plain remove leaves it running on its
 * host, removing it from the host is a choice, and deleting it in Switch takes
 * it off the host as well — so that choice follows and cannot be unticked.
 */
import {
  DeleteAgentModal,
  type DeleteAgentModalResult,
} from '@renderer/features/locations/components/delete-agent-modal';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(sshHost: string | null) {
  const onSuccess = vi.fn<(result: DeleteAgentModalResult) => void>();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <Dialog open>
        <DialogContent>
          <DeleteAgentModal
            agentId="agent-1"
            agentLabel="reviewer"
            sshHost={sshHost}
            dir="/srv/reviewer"
            onSuccess={onSuccess}
            onClose={() => {}}
          />
        </DialogContent>
      </Dialog>
    )
  );
  return onSuccess;
}

function checkbox(label: RegExp): HTMLElement {
  const text = [...document.querySelectorAll('label')].find((l) => label.test(l.textContent ?? ''));
  if (!text) throw new Error(`no option matching ${label}`);
  const box = text.querySelector<HTMLElement>('[role="checkbox"], button, input');
  if (!box) throw new Error(`no checkbox in ${label}`);
  return box;
}

function isChecked(box: HTMLElement): boolean {
  return box.getAttribute('aria-checked') === 'true' || box.hasAttribute('data-checked');
}

function isDisabled(box: HTMLElement): boolean {
  return box.getAttribute('aria-disabled') === 'true' || box.hasAttribute('data-disabled');
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

function confirm(): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find((b) =>
    /^Remove/.test(b.textContent ?? '')
  );
  if (!button) throw new Error('no confirm button');
  return button;
}

describe('removing a remote agent', () => {
  it('leaves it running on its host unless asked', async () => {
    const onSuccess = await render('vm-1');

    expect(document.body.textContent).toContain('It keeps running on vm-1');
    await click(confirm());

    expect(onSuccess).toHaveBeenCalledWith({
      deleteInSwitch: false,
      removeProvisionedFiles: false,
    });
  });

  it('removes it from the host when asked', async () => {
    const onSuccess = await render('vm-1');

    await click(checkbox(/Also remove it from vm-1/));
    expect(confirm().textContent).toContain('Remove from Console & vm-1');
    await click(confirm());

    expect(onSuccess).toHaveBeenCalledWith({ deleteInSwitch: false, removeProvisionedFiles: true });
  });

  it('removes it from the host, and holds that choice, when it is deleted in Switch', async () => {
    const onSuccess = await render('vm-1');

    await click(checkbox(/Also delete this agent in Switch/));

    const fromHost = checkbox(/Also remove it from vm-1/);
    expect(isChecked(fromHost)).toBe(true);
    expect(isDisabled(fromHost)).toBe(true);
    expect(document.body.textContent).toContain('Deleting it in Switch removes it from vm-1 too.');
    await click(confirm());

    expect(onSuccess).toHaveBeenCalledWith({ deleteInSwitch: true, removeProvisionedFiles: true });
  });
});

describe('removing an agent on this machine', () => {
  it('offers no host choice, and always removes the files Console provisioned', async () => {
    const onSuccess = await render(null);

    expect(document.body.textContent).not.toContain('Also remove it from');
    await click(confirm());

    expect(onSuccess).toHaveBeenCalledWith({ deleteInSwitch: false, removeProvisionedFiles: true });
  });
});
