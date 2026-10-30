/**
 * With the participant suggestions open, a real click on a button below them
 * does what it says the first time: the list closing must not move the button
 * out from under the pointer before the click lands.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { ParticipantPicker } from '@renderer/lib/components/participant-picker';
import type { Participant } from '@renderer/lib/components/participant-search';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

const candidates: Participant[] = Array.from({ length: 6 }, (_, i) => ({
  kind: 'agent',
  id: `a${i}`,
  name: `helper-${i}`,
  iconUrl: null,
  detail: 'Agent · Claude Code',
}));

it.each(['Cancel', 'Create'])(
  'runs %s on the first click while the suggestions are open, once',
  async (label) => {
    const onCancel = vi.fn();
    const onCreate = vi.fn();
    container = document.createElement('div');
    container.style.width = '400px';
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <QueryClientProvider client={new QueryClient()}>
          <ParticipantPicker
            candidates={candidates}
            picked={[]}
            onChange={() => {}}
            serverId={null}
            loading={false}
            inputId="participants"
            autoFocus={false}
            busy={false}
            // As in the New room dialog: the list pushes the buttons down.
            overlay={false}
          />
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onClick={onCreate}>
            Create
          </button>
        </QueryClientProvider>
      )
    );
    const input = container.querySelector('input')!;
    await userEvent.click(input);
    await userEvent.type(input, 'helper');
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();

    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;
    await userEvent.click(button);
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 20)));

    expect((label === 'Cancel' ? onCancel : onCreate).mock.calls).toHaveLength(1);
    expect((label === 'Cancel' ? onCreate : onCancel).mock.calls).toHaveLength(0);
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  }
);
