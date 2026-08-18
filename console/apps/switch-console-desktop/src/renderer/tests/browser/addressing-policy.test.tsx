import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The control's siblings reach the renderer IPC bridge at import time, which
// only exists inside Electron. Hoisted so it is in place before those modules
// are evaluated. Nothing asserted here calls through it.
vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

/**
 * "Who can talk to your agent", as the person setting it sees it (CHOO-2137).
 *
 * The chooser and the rule editor answer the same question at two levels of
 * detail, and the thing that goes wrong is the seam between them: the owner and
 * the owner's agents are booleans on a rule, but they are offered as entries in
 * the Users and Agents pickers. These pin down that translation in both
 * directions, and that no shortcut quietly loses what the rule said.
 */
import { AddressingPolicyControl } from '@renderer/features/switch-servers/addressing-policy-control';
import { AddressingPolicyEditor } from '@renderer/features/switch-servers/addressing-policy-editor';
import type { AddressingPolicy, AddressingRule } from '@shared/core/switch-servers/switch-servers';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
  return container;
}

const USERS = [{ id: 'ext-1', label: 'alice' }];
const AGENTS = [{ id: 'agent-a', label: 'helper' }];

function rule(patch: Partial<AddressingRule> = {}): AddressingRule {
  return { rooms: '*', room_groups: '*', users: [], agents: [], ...patch };
}

/** Renders the editor on one rule and returns the last policy it emitted. */
async function editing(only: AddressingRule): Promise<{
  el: HTMLDivElement;
  emitted: () => AddressingRule | null;
}> {
  let last: AddressingPolicy | null = null;
  const el = await render(
    <AddressingPolicyEditor
      value={{ rules: [only] }}
      onChange={(next) => {
        last = next;
      }}
      rooms={[]}
      roomGroups={[]}
      users={USERS}
      agents={AGENTS}
    />
  );
  // A rule that arrives already saved opens collapsed; the dimension pickers
  // only exist once it is being edited.
  const edit = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Edit');
  await act(async () => edit!.click());
  return { el, emitted: () => (last === null ? null : (last as AddressingPolicy).rules[0]) };
}

/** Opens a Base UI select and returns its option labels. The listbox is
 * portalled out of the component, so this reads the whole document. */
async function openSelect(trigger: HTMLElement): Promise<string[]> {
  await act(async () => trigger.click());
  return [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent?.trim() ?? '');
}

async function pickOption(label: string): Promise<void> {
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (o) => o.textContent?.trim() === label
  );
  expect(option, `no option labelled ${label}`).toBeDefined();
  await act(async () => option!.click());
}

describe('the chooser', () => {
  async function control(value: AddressingPolicy | null, unlinkedApps: string[] = ['Slack Test']) {
    let last: AddressingPolicy | null | 'unset' = 'unset';
    const el = await render(
      <AddressingPolicyControl
        value={value}
        onChange={(next) => {
          last = next;
        }}
        rooms={[]}
        roomGroups={[]}
        users={USERS}
        agents={AGENTS}
        unlinkedApps={unlinkedApps}
        onOpenMessagingApps={() => {}}
        inlineLabel={null}
      />
    );
    return { el, emitted: () => last };
  }

  it('offers only-me and my-agents as separate answers', async () => {
    const { el } = await control(null);

    const labels = await openSelect(el.querySelector('button')!);
    expect(labels).toEqual([
      'Only me (default)',
      'Only me and my agents',
      'Anyone',
      'Custom rules',
    ]);
  });

  it('shows the answer in the box, not the value stored behind it', async () => {
    // Base UI renders the stored value unless the trigger is given something
    // else, so the box read "ownerAndAgents" — a word that appears nowhere in
    // the list it was picked from.
    const { el } = await control({ rules: [rule({ owner: true, owner_agents: true })] });

    const trigger = el.querySelector('button')!;
    expect(trigger.textContent).toContain('Only me and my agents');
    expect(trigger.textContent).not.toContain('ownerAndAgents');
  });

  it('writes the wider shape when my agents are included', async () => {
    const { el, emitted } = await control(null);
    await openSelect(el.querySelector('button')!);

    await pickOption('Only me and my agents');

    expect(emitted()).toEqual({
      rules: [
        {
          rooms: '*',
          room_groups: '*',
          users: [],
          agents: [],
          owner: true,
          owner_agents: true,
        },
      ],
    });
  });

  it('shuts the owner’s agents out again when only-me is chosen', async () => {
    // The narrowing direction is the one that matters: leaving owner_agents
    // set here would make the stricter choice a no-op.
    const { el, emitted } = await control({
      rules: [rule({ owner: true, owner_agents: true })],
    });
    await openSelect(el.querySelector('button')!);

    await pickOption('Only me (default)');

    expect((emitted() as AddressingPolicy).rules[0].owner_agents).toBe(false);
  });

  it('no longer asks which agents to allow — that is what the wider choice is for', async () => {
    // The picker used to sit under "Only me", which made the option's own
    // label untrue.
    const { el } = await control({ rules: [rule({ owner: true })] });

    expect(el.textContent).not.toContain('Add an agent that may address it');
    expect(el.textContent).not.toContain('Also allow these agents');
  });

  it('says an unlinked owner will be recognised as nobody', async () => {
    const { el } = await control({ rules: [rule({ owner: true })] });

    expect(el.textContent).toContain('you have not linked a messaging account');
  });

  it('warns about the one app with no account, not only about having none at all', async () => {
    // Linking Slack and leaving Mattermost unclaimed leaves an owner rule
    // half-working, and the agent silent in exactly the rooms nobody checked.
    const { el } = await control({ rules: [rule({ owner: true })] }, ['Mattermost']);

    expect(el.textContent).toContain('Mattermost');
  });

  it('stays quiet once every app has an account on it', async () => {
    const { el } = await control({ rules: [rule({ owner: true })] }, []);

    expect(el.textContent).not.toContain('you have not linked a messaging account');
  });

  it('stays quiet when only the owner’s agents are admitted', async () => {
    // Agent senders are recognised by their agent id, so no messaging account
    // has to be linked for this rule to work. Warning here would be a warning
    // nobody can act on.
    const { el } = await control({ rules: [rule({ owner_agents: true })] });

    expect(el.textContent).not.toContain('you have not linked a messaging account');
  });
});

describe('the rule editor', () => {
  it('has no separate checkbox for the owner', async () => {
    // It was a third control answering the same question as the Users row,
    // sitting between Room groups and Users where nothing else about senders
    // was.
    const { el } = await editing(rule({ users: '*', agents: '*' }));

    expect(el.textContent).not.toContain('The agent’s owner');
    expect(el.querySelector('[role="checkbox"]')).toBeNull();
  });

  it('names each dimension’s mode rather than showing the stored word', async () => {
    // Same defect as the chooser's, in the row below it: the boxes read "any"
    // and "specific".
    const { el } = await editing(rule({ users: '*', agents: '*' }));

    const triggers = [...el.querySelectorAll<HTMLElement>('button')].filter((b) =>
      b.hasAttribute('aria-haspopup')
    );
    // The trailing chevron is part of the trigger's text.
    for (const trigger of triggers) expect(trigger.textContent).toContain('Any');
  });

  it('shows the owner as an entry in the Users list', async () => {
    const { el } = await editing(rule({ owner: true, agents: '*' }));

    expect(el.querySelector('[aria-label^="Remove Me"]')).not.toBeNull();
  });

  it('shows the owner’s agents as an entry in the Agents list', async () => {
    const { el } = await editing(rule({ users: '*', owner_agents: true }));

    expect(el.querySelector('[aria-label^="Remove My agents"]')).not.toBeNull();
  });

  it('takes the owner back out when that entry is removed', async () => {
    const { el, emitted } = await editing(rule({ owner: true, users: ['ext-1'], agents: '*' }));

    const remove = el.querySelector<HTMLElement>('[aria-label^="Remove Me"]');
    await act(async () => remove!.click());

    // The named user survives: the symbolic entry is one member of the list,
    // not a mode the whole row is in.
    expect(emitted()).toMatchObject({ owner: false, users: ['ext-1'] });
  });

  it('drops the owner when Users is set to None', async () => {
    // "No humans at all" and "the owner may" are contradictory, and the row
    // that was just set is the one that should win.
    const { el, emitted } = await editing(rule({ owner: true, agents: '*' }));

    const rows = [...el.querySelectorAll<HTMLElement>('button')].filter((b) =>
      b.hasAttribute('aria-haspopup')
    );
    // Rooms, Room groups, Users, Agents — in the order the rows are laid out.
    await openSelect(rows[2]);
    await pickOption('None');

    expect(emitted()).toMatchObject({ owner: false, users: [] });
  });

  it('calls a rule with only the owner in it live, not dead', async () => {
    // The empty `users` list is what dead-rule detection looks at, and the
    // owner is not in it — so the default policy read as a rule that never
    // applies unless the symbolic entries are counted.
    const { el } = await editing(rule({ owner: true }));

    expect(el.textContent).not.toContain('no sender can match');
  });

  it('still calls a rule with no sender at all dead', async () => {
    const { el } = await editing(rule());

    expect(el.textContent).toContain('no sender can match');
  });
});
