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
 * Resetting a managed stack (CHOO-2893): a remote one is shared by everyone
 * with access to its host, so the confirmation has to say the reset is not
 * only for this Console — a local, unshared one says none of that.
 */
import { ServerResetSection } from '@renderer/features/switch-servers/server-reset-section';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(props: {
  shared: boolean;
  affected: string | null;
  disabled?: boolean;
  onConfirm?: () => void;
}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <ServerResetSection
        dialogTitle="Reset “Team Server”?"
        shared={props.shared}
        affected={props.affected}
        disabled={props.disabled ?? false}
        onConfirm={props.onConfirm ?? vi.fn()}
      />
    )
  );
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

function openDialog(): Promise<void> {
  return click(
    [...document.querySelectorAll('button')].find((b) => /^Reset…$/.test(b.textContent ?? ''))!
  );
}

function dialogText(): string {
  return document.querySelector('[role="dialog"]')?.textContent ?? '';
}

describe('resetting a shared remote server', () => {
  it('says it is deleted for everyone who uses it, and names them', async () => {
    await render({
      shared: true,
      affected: 'Also used recently by bob@desk (as bob), 2 hours ago.',
    });

    await openDialog();

    expect(dialogText()).toContain('deleted for everyone who uses it');
    expect(dialogText()).toContain('Also used recently by bob@desk (as bob), 2 hours ago.');
  });

  it('calls onConfirm and closes when the reset is confirmed', async () => {
    const onConfirm = vi.fn();
    await render({ shared: true, affected: null, onConfirm });

    await openDialog();
    await click(
      [...document.querySelectorAll('button')].find((b) =>
        /^Reset and delete all agents$/.test(b.textContent ?? '')
      )!
    );

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')?.hasAttribute('data-closed')).toBe(true);
  });
});

describe('resetting a local, unshared server', () => {
  it('says nothing about being shared with anyone else', async () => {
    await render({ shared: false, affected: null });

    await openDialog();

    expect(dialogText()).not.toContain('everyone who uses it');
  });
});
