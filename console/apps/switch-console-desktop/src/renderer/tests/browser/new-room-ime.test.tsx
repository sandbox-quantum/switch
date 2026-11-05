/**
 * In the New room dialog, an Enter the IME is handling confirms the
 * composition and nothing else: it neither adds a participant nor creates
 * the room. A plain Enter still does both.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomNameInput } from '@renderer/features/switch-servers/room-name-input';
import { ParticipantPicker } from '@renderer/lib/components/participant-picker';
import type { Participant } from '@renderer/lib/components/participant-search';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(node: React.ReactNode): Promise<HTMLInputElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>)
  );
  return container.querySelector('input')!;
}

const enter = (input: HTMLInputElement, init: KeyboardEventInit) =>
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })
  );

const helper: Participant = {
  kind: 'agent',
  id: 'a1',
  name: 'helper',
  iconUrl: null,
  detail: 'Agent · Claude Code',
};

describe('New room IME', () => {
  it('adds no participant on a composition Enter, and adds one on a plain Enter', async () => {
    const onChange = vi.fn();
    const input = await render(
      <ParticipantPicker
        candidates={[helper]}
        picked={[]}
        onChange={onChange}
        serverId={null}
        loading={false}
        inputId="participants"
        autoFocus={false}
        busy={false}
        overlay={false}
      />
    );
    await act(async () => input.focus());
    await act(async () => enter(input, { isComposing: true, keyCode: 13 }));
    await act(async () => enter(input, { keyCode: 229 }));
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => enter(input, { keyCode: 13 }));
    expect(onChange).toHaveBeenCalledWith([helper]);
  });

  it('does not create the room on a composition Enter in the name, and does on a plain one', async () => {
    const onSubmit = vi.fn();
    const input = await render(
      <RoomNameInput id="name" value="会議" onChange={() => {}} onSubmit={onSubmit} />
    );
    await act(async () => enter(input, { isComposing: true, keyCode: 13 }));
    await act(async () => enter(input, { keyCode: 229 }));
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => enter(input, { keyCode: 13 }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // ⌘↩ is left to the dialog's confirm button.
    await act(async () => enter(input, { keyCode: 13, metaKey: true, ctrlKey: true }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe('Participant field while a pick is being added', () => {
  it('takes no second pick until the first is added, and says it is adding', async () => {
    const bob: Participant = { kind: 'person', id: 'u2', name: 'Bob', detail: 'bob@example.com' };
    let finish!: () => void;
    const added: string[] = [];
    function Harness() {
      const [busy, setBusy] = useState(false);
      return (
        <ParticipantPicker
          candidates={[helper, bob]}
          picked={[]}
          onChange={(next) => {
            const pick = next.at(-1)!;
            added.push(pick.id);
            setBusy(true);
            // The first add answers late.
            void new Promise<void>((resolve) => (finish = resolve)).then(() => setBusy(false));
          }}
          serverId={null}
          loading={false}
          inputId="add"
          autoFocus={false}
          busy={busy}
          overlay={false}
        />
      );
    }
    const input = await render(<Harness />);
    await act(async () => input.focus());
    await act(async () => enter(input, { keyCode: 13 }));
    expect(added).toEqual(['a1']);
    expect(input.readOnly).toBe(true);
    expect(container!.textContent).toContain('Adding…');
    await act(async () => enter(input, { keyCode: 13 }));
    expect(added).toEqual(['a1']);
    await act(async () => finish());
    expect(input.readOnly).toBe(false);
    await act(async () => enter(input, { keyCode: 13 }));
    expect(added).toEqual(['a1', 'a1']);
  });
});

describe('Participant field results', () => {
  it('float over what follows when asked to, and push it down otherwise', async () => {
    for (const overlay of [true, false]) {
      const input = await render(
        <ParticipantPicker
          candidates={[helper]}
          picked={[]}
          onChange={() => {}}
          serverId={null}
          loading={false}
          inputId="p"
          autoFocus={false}
          busy={false}
          overlay={overlay}
        />
      );
      await act(async () => input.focus());
      const list = container!.querySelector('[role="listbox"]')!;
      expect(list.classList.contains('absolute')).toBe(overlay);
      await act(async () => root!.unmount());
      root = null;
      container!.remove();
    }
  });
});

describe('Participant field with a confirm button', () => {
  const smiley: Participant = { ...helper, id: 'a2', name: 'smiley' };
  const mod = navigator.platform.toLowerCase().includes('mac')
    ? { metaKey: true }
    : { ctrlKey: true };

  it('lets ⌘↩ confirm the picks instead of taking the highlighted result', async () => {
    const submitted: string[][] = [];
    function Harness() {
      const [picked, setPicked] = useState<Participant[]>([]);
      return (
        <>
          <ParticipantPicker
            candidates={[helper, smiley]}
            picked={picked}
            onChange={setPicked}
            serverId={null}
            loading={false}
            inputId="confirm"
            autoFocus={false}
            busy={false}
            overlay
          />
          <ConfirmButton onClick={() => submitted.push(picked.map((each) => each.id))}>
            Add
          </ConfirmButton>
        </>
      );
    }
    const input = await render(<Harness />);
    await act(async () => input.focus());
    await act(async () => enter(input, { keyCode: 13 }));
    // The results are open again on smiley.
    expect(container!.querySelector('[role="listbox"]')).not.toBeNull();
    await act(async () => enter(input, { keyCode: 13, ...mod }));
    expect(submitted).toEqual([['a1']]);
    expect(container!.querySelectorAll('[aria-label^="Remove"]')).toHaveLength(1);
  });

  it('keeps the picks as they are while they are being added', async () => {
    const onChange = vi.fn();
    const input = await render(
      <ParticipantPicker
        candidates={[helper, smiley]}
        picked={[helper, smiley]}
        onChange={onChange}
        serverId={null}
        loading={false}
        inputId="busy"
        autoFocus={false}
        busy
        overlay
      />
    );
    await act(async () => input.focus());
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
      )
    );
    const remove = container!.querySelector<HTMLButtonElement>('[aria-label="Remove smiley"]')!;
    expect(remove.disabled).toBe(true);
    await act(async () => remove.click());
    expect(onChange).not.toHaveBeenCalled();
  });
});
