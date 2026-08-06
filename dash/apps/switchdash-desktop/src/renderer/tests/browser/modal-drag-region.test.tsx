import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ModalRenderer } from '@renderer/lib/modal/modal-renderer';
import { modalStore } from '@renderer/lib/modal/modal-store';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';

/**
 * Draggable regions are geometric rectangles Chromium derives from layout, not
 * an inherited DOM property. Dialogs portal to `document.body`, so the drag rect
 * a view declares (the home panel since CHOO-1430, plus `page-header`,
 * `page-layout`, `Titlebar` and `sidebar-space`) stays live underneath an open
 * dialog and takes its pointer-down events: the window moves and form text
 * cannot be selected (CHOO-1953).
 *
 * Only Electron acts on a drag region, so — as in `home-drag-region.test.tsx` —
 * these assertions are on the markup rather than on behaviour. They exist to
 * catch a restyle or refactor silently dropping the opt-out again.
 */

const NO_DRAG = '[-webkit-app-region:no-drag]';

let container: HTMLDivElement | null = null;

async function render(node: ReactNode): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
}

// `unsavedChangesModal` stands in for any registry modal: the assertions are on
// the chrome ModalRenderer wraps around the content, not on the content itself,
// and this one renders from its props alone — no query client or store to stub.
async function renderRegistryModal(): Promise<void> {
  modalStore.setModal('unsavedChangesModal', {
    fileName: 'test.txt',
    onSuccess: () => {},
    onClose: () => {},
  });
  await render(<ModalRenderer />);
}

afterEach(() => {
  modalStore.closeModal();
  container?.remove();
  container = null;
});

describe('modal drag region', () => {
  it('opts the registry modal popup out of the drag region', async () => {
    await renderRegistryModal();

    // The popup portals out of `container`, so query the document.
    const popup = document.querySelector('[data-slot="dialog-content"]');

    expect(popup).not.toBeNull();
    expect(popup?.className).toContain(NO_DRAG);
  });

  it('opts the backdrop out so outside clicks dismiss rather than drag', async () => {
    await renderRegistryModal();

    const overlay = document.querySelector('[data-slot="dialog-overlay"]');

    expect(overlay).not.toBeNull();
    expect(overlay?.className).toContain(NO_DRAG);
  });

  it('opts the standalone DialogContent out too', async () => {
    await render(
      <Dialog open>
        <DialogContent>
          <p>Test</p>
        </DialogContent>
      </Dialog>
    );

    const popup = document.querySelector('[data-slot="dialog-content"]');

    expect(popup).not.toBeNull();
    expect(popup?.className).toContain(NO_DRAG);
  });
});
