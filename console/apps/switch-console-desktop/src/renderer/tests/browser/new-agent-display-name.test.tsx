import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
/**
 * What accepting the offered slug does to the text it was slugged from.
 *
 * The create form asks for one name and gets two things out of it: the
 * identifier rooms route by, and the label a chat platform renders. Typing
 * "Switch Dev" and accepting `switch-dev` used to overwrite the field, so the
 * label the user had already written was gone before they could be asked for it.
 */
import { AgentIdentityFields } from '@renderer/features/locations/components/add-agent-modal/configure-agent-panel';
import {
  type ConfigureAgentFormState,
  useConfigureAgentForm,
} from '@renderer/features/locations/components/add-agent-modal/modes';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

/** Mount the real hook and hand the caller its live state to drive. */
async function mountForm(): Promise<() => ConfigureAgentFormState> {
  let latest: ConfigureAgentFormState | null = null;
  function Probe() {
    latest = useConfigureAgentForm();
    return null;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>
    )
  );
  return () => {
    if (latest === null) throw new Error('the form never rendered');
    return latest;
  };
}

describe('the display name on a new agent', () => {
  it('starts empty', async () => {
    const form = await mountForm();
    expect(form().displayName).toBe('');
  });

  it('keeps the typed text as the display name when the slug is accepted', async () => {
    const form = await mountForm();

    await act(async () => form().setAgentName('Switch Dev'));
    expect(form().suggestedName).toBe('switch-dev');

    await act(async () => form().acceptSuggestedName());

    expect(form().agentName).toBe('switch-dev');
    expect(form().displayName).toBe('Switch Dev');
  });

  it('leaves a display name the user typed themselves alone', async () => {
    const form = await mountForm();

    await act(async () => form().setDisplayName('The Dev'));
    await act(async () => form().setAgentName('Switch Dev'));
    await act(async () => form().acceptSuggestedName());

    expect(form().agentName).toBe('switch-dev');
    expect(form().displayName).toBe('The Dev');
  });

  it('treats a display name the user cleared as an answer, not an absence', async () => {
    // Emptying the field is a decision — "show this agent under its
    // identifier" — so the slug must not read it as "never asked" and refill
    // it. A falsy check on the value alone passes every other test here and
    // fails this one.
    const form = await mountForm();

    await act(async () => form().setDisplayName('The Dev'));
    await act(async () => form().setDisplayName(''));
    await act(async () => form().setAgentName('Switch Dev'));
    await act(async () => form().acceptSuggestedName());

    expect(form().agentName).toBe('switch-dev');
    expect(form().displayName).toBe('');
  });

  it('does nothing when there is no suggestion to accept', async () => {
    const form = await mountForm();

    await act(async () => form().setAgentName('switch-dev'));
    expect(form().suggestedName).toBe('');

    await act(async () => form().acceptSuggestedName());

    expect(form().agentName).toBe('switch-dev');
    expect(form().displayName).toBe('');
  });
});

let domContainer: HTMLDivElement | null = null;
let domRoot: Root | null = null;
let domForm: ReturnType<typeof useConfigureAgentForm> | null = null;

afterEach(async () => {
  if (domRoot) await act(async () => domRoot!.unmount());
  domContainer?.remove();
  domContainer = null;
  domRoot = null;
  domForm = null;
});

function Fields() {
  domForm = useConfigureAgentForm();
  return <AgentIdentityFields form={domForm} />;
}

async function renderFields(): Promise<HTMLDivElement> {
  domContainer = document.createElement('div');
  document.body.appendChild(domContainer);
  domRoot = createRoot(domContainer);
  await act(async () => domRoot!.render(<Fields />));
  return domContainer;
}

async function typeName(el: HTMLElement, value: string) {
  const field = el.querySelector<HTMLInputElement>('input[placeholder="Name this agent"]');
  expect(field, 'no Name input').not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(field!, value);
    field!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function typeDisplayName(el: HTMLElement, value: string) {
  const label = [...el.querySelectorAll('label')].find((l) =>
    /^Display name/.test(l.textContent ?? '')
  );
  expect(label, 'no Display name label').not.toBeUndefined();
  const field = el.querySelector<HTMLInputElement>(`#${label!.htmlFor}`);
  expect(field, 'no Display name input').not.toBeNull();
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

describe('the display name field in the DOM', () => {
  it('renders an input labelled Display name', async () => {
    const el = await renderFields();

    const label = [...el.querySelectorAll('label')].find((l) =>
      /^Display name/.test(l.textContent ?? '')
    );
    expect(label, 'no Display name label').not.toBeUndefined();
    const field = el.querySelector<HTMLInputElement>(`#${label!.htmlFor}`);
    expect(field, 'no Display name input').not.toBeNull();
  });

  it('updates form.displayName when typed into', async () => {
    const el = await renderFields();

    await typeDisplayName(el, 'The Dev');

    expect(domForm?.displayName).toBe('The Dev');
  });

  it('shows the name in the Display name input after accepting the slug', async () => {
    const el = await renderFields();
    await typeName(el, 'Switch Dev');
    await act(async () => suggestionButton(el)!.click());

    const label = [...el.querySelectorAll('label')].find((l) =>
      /^Display name/.test(l.textContent ?? '')
    );
    const field = el.querySelector<HTMLInputElement>(`#${label!.htmlFor}`);
    expect(field?.value).toBe('Switch Dev');
  });
});
