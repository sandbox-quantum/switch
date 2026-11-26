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
    latest = useConfigureAgentForm(null, 'claude');
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

  it('follows a name changed after the suggestion was taken (bug 18)', async () => {
    // The display name is not on the form, so one left behind by an earlier
    // name is invisible: the agent would be created labelled as the name it
    // no longer has, and read as a twin of any agent that does have it.
    const form = await mountForm();

    await act(async () => form().setAgentName('Mo Scratch Helper'));
    await act(async () => form().acceptSuggestedName());
    expect(form().agentName).toBe('mo-scratch-helper');
    expect(form().displayName).toBe('Mo Scratch Helper');

    await act(async () => form().setAgentName('mo-second-helper'));

    expect(form().agentName).toBe('mo-second-helper');
    expect(form().displayName).toBe('Mo Second Helper');
  });

  it('takes the typed text again when a second suggestion is taken', async () => {
    const form = await mountForm();

    await act(async () => form().setAgentName('Mo Scratch Helper'));
    await act(async () => form().acceptSuggestedName());
    await act(async () => form().setAgentName('Mo Second Helper'));
    expect(form().displayName).toBe('Mo Second Helper');
    await act(async () => form().acceptSuggestedName());

    expect(form().agentName).toBe('mo-second-helper');
    expect(form().displayName).toBe('Mo Second Helper');
  });

  it('keeps a display name the user wrote when the name changes', async () => {
    const form = await mountForm();

    await act(async () => form().setAgentName('Mo Scratch Helper'));
    await act(async () => form().acceptSuggestedName());
    await act(async () => form().setDisplayName('Scratch'));
    await act(async () => form().setAgentName('mo-second-helper'));

    expect(form().displayName).toBe('Scratch');
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
  domForm = useConfigureAgentForm(null, 'claude');
  return <AgentIdentityFields form={domForm} serverId={null} nameTaken={false} />;
}

async function renderFields(): Promise<HTMLDivElement> {
  domContainer = document.createElement('div');
  document.body.appendChild(domContainer);
  domRoot = createRoot(domContainer);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    domRoot!.render(
      <QueryClientProvider client={client}>
        <Fields />
      </QueryClientProvider>
    )
  );
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

function suggestionButton(el: HTMLElement): HTMLButtonElement | undefined {
  return [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    /^Use\b/.test(b.textContent?.trim() ?? '')
  );
}

describe('the identity fields in the DOM', () => {
  it('ask for no display name: what was typed before the slug becomes it', async () => {
    const el = await renderFields();
    expect(
      [...el.querySelectorAll('label')].some((l) => /^Display name/.test(l.textContent ?? ''))
    ).toBe(false);

    await typeName(el, 'Switch Dev');
    await act(async () => suggestionButton(el)!.click());

    expect(domForm?.agentName).toBe('switch-dev');
    expect(domForm?.displayName).toBe('Switch Dev');
  });

  it('carry the display name along when the name is edited after the suggestion', async () => {
    const el = await renderFields();

    await typeName(el, 'Mo Scratch Helper');
    await act(async () => suggestionButton(el)!.click());
    await typeName(el, 'mo-second-helper');

    expect(domForm?.agentName).toBe('mo-second-helper');
    expect(domForm?.displayName).toBe('Mo Second Helper');
  });
});
