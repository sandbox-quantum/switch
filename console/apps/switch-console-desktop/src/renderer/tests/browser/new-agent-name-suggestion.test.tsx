/**
 * The offer made to someone who typed a name Switch will not accept.
 *
 * A display name — "Switch Dev" — is the obvious thing to type and the one
 * thing the charset rejects, so the field offers the slug instead of leaving
 * the reader to work out the rule. The offer is a button, never an edit: text
 * rewritten under the cursor is worse than an error. Pinned here because the
 * slugifier's own tests say nothing about whether anything on screen uses it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: vi.fn() },
  rpc: {
    switchServers: {
      listRemoteRooms: () => Promise.resolve([]),
      listRemoteRoomGroups: () => Promise.resolve([]),
      listRemoteExternalUsers: () => Promise.resolve([]),
      listRemoteAgents: () => Promise.resolve([]),
      listRemoteBridges: () => Promise.resolve([]),
      listMyIdentities: () => Promise.resolve([]),
    },
  },
}));

import { AgentIdentityFields } from '@renderer/features/locations/components/add-agent-modal/configure-agent-panel';
import { useConfigureAgentForm } from '@renderer/features/locations/components/add-agent-modal/modes';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let form: ReturnType<typeof useConfigureAgentForm> | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
  form = null;
});

function Fields() {
  form = useConfigureAgentForm();
  return <AgentIdentityFields form={form} />;
}

async function renderFields(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Fields />));
  return container;
}

/** Type into the controlled Name input the way React will notice. */
async function typeName(el: HTMLElement, value: string) {
  const field = el.querySelector<HTMLInputElement>('input[placeholder="Name this agent"]');
  expect(field, 'no Name input').not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(field!, value);
    field!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function suggestionButton(el: HTMLElement): HTMLButtonElement | undefined {
  return [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    /^Use\b/.test(b.textContent?.trim() ?? '')
  );
}

const REJECTION = 'Use lowercase letters, digits';

describe('a rejected agent name', () => {
  it('offers the slug of what was typed', async () => {
    const el = await renderFields();
    await typeName(el, 'Switch Dev');

    expect(el.textContent).toContain(REJECTION);
    const button = suggestionButton(el);
    expect(button?.textContent?.trim()).toBe('Use switch-dev');
    // Speech input says what it reads, so the accessible name has to be the
    // visible one rather than a paraphrase of it (WCAG 2.5.3). With no
    // aria-label the text content above is the accessible name.
    expect(button?.getAttribute('aria-label')).toBeNull();
  });

  it('fills the field in when the offer is accepted', async () => {
    const el = await renderFields();
    await typeName(el, 'Switch Dev');
    await act(async () => suggestionButton(el)!.click());

    expect(form?.agentName).toBe('switch-dev');
    expect(form?.nameIsValid).toBe(true);
    expect(el.textContent).not.toContain(REJECTION);
    expect(suggestionButton(el)).toBeUndefined();
  });

  it('keeps focus in the field it repaired', async () => {
    // The offer unmounts on acceptance; without moving focus first it falls to
    // the body and the tab order restarts.
    const el = await renderFields();
    await typeName(el, 'Switch Dev');
    await act(async () => suggestionButton(el)!.click());

    expect(document.activeElement).toBe(
      el.querySelector<HTMLInputElement>('input[placeholder="Name this agent"]')
    );
  });

  it('offers nothing when nothing of the name survives slugging', async () => {
    const el = await renderFields();
    await typeName(el, '@@@');

    expect(el.textContent).toContain(REJECTION);
    expect(suggestionButton(el)).toBeUndefined();
  });

  it('says nothing at all about a name that is already valid', async () => {
    const el = await renderFields();
    await typeName(el, 'switch-dev');

    expect(el.textContent).not.toContain(REJECTION);
    expect(suggestionButton(el)).toBeUndefined();
  });
});
