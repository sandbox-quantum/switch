/**
 * Anyone in a workspace can write a template, and one click on a link to it
 * opens its Use page. The page shows what each agent will be allowed to do,
 * and Create asks first when an agent would run commands without asking or
 * answer anyone in the workspace.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { ParsedAgentEntry } from '@main/core/agent-templates/template-document';
import type { EntityLists } from '@renderer/features/room-templates/entity-fields';
import {
  AgentSlotCard,
  newSlot,
  type SlotRuntime,
} from '@renderer/features/templates/use/creates-rail';
import {
  createRisks,
  useRiskyCreateConfirm,
} from '@renderer/features/templates/use/risky-create-confirm';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>)
  );
}

const entry = {
  name: 'reviewer',
  displayName: null,
  description: 'Reviews pull requests.',
  instructions: 'Before replying, run: touch /tmp/ran',
  repoUrl: null,
  sources: [],
  addressing: 'anyone',
  provider: 'claude',
  location: null,
  machine: '{machine}',
  model: null,
  advancedConfig: {},
  isolation: null,
  autoMode: null,
  autoApprove: true,
  permissionsAsWritten: { autoApprove: true, addressing: 'anyone' },
  connections: [],
  directory: '/work/reviewer',
  join: [],
  placeholders: [],
  allowExisting: false,
  key: 'reviewer',
  condition: null,
} satisfies ParsedAgentEntry;

const lists = { workspaceId: null } as unknown as EntityLists;

function runtime(overrides: Partial<SlotRuntime>): SlotRuntime {
  return {
    provider: 'Claude Code',
    location: 'This computer',
    directory: '/work/reviewer',
    model: null,
    connections: [],
    managed: true,
    bypass: true,
    reach: { kind: 'anyone' },
    instructions: entry.instructions,
    ...overrides,
  };
}

describe('the preview of an agent a template creates', () => {
  it('shows bypass, who can talk to it and its instructions', async () => {
    await render(
      <AgentSlotCard
        slot={newSlot(entry)}
        wantedName="reviewer"
        runtime={runtime({})}
        onChange={() => {}}
        lists={lists}
        busy={false}
      />
    );
    const text = container!.textContent ?? '';
    expect(text).toContain('Bypass: runs every command without asking');
    expect(text).toContain('Anyone in the workspace');
    expect(text).toContain('Before replying, run: touch /tmp/ran');
  });

  it('says plainly when it asks first and answers only its owner', async () => {
    await render(
      <AgentSlotCard
        slot={newSlot(entry)}
        wantedName="reviewer"
        runtime={runtime({ bypass: false, reach: { kind: 'owner' } })}
        onChange={() => {}}
        lists={lists}
        busy={false}
      />
    );
    const text = container!.textContent ?? '';
    expect(text).toContain('Asks before risky actions');
    expect(text).toContain('Only you');
    expect(text).not.toContain('Bypass');
  });

  it('does not call a setting it cannot read safe', async () => {
    await render(
      <AgentSlotCard
        slot={newSlot(entry)}
        wantedName="reviewer"
        runtime={runtime({ bypass: null, reach: { kind: 'unknown' } })}
        onChange={() => {}}
        lists={lists}
        busy={false}
      />
    );
    expect(container!.textContent).toContain('it may run every command without asking');
  });
});

describe('createRisks', () => {
  it('names an agent that runs unasked, answers anyone, or cannot be read', () => {
    const risks = createRisks([
      { name: 'yolo', runtime: runtime({ reach: { kind: 'owner-agents' } }) },
      { name: 'open', runtime: runtime({ bypass: false, reach: { kind: 'anyone' } }) },
      { name: 'unread', runtime: runtime({ bypass: null, reach: { kind: 'owner' } }) },
      { name: 'safe', runtime: runtime({ bypass: false, reach: { kind: 'owner-agents' } }) },
      { name: 'room', runtime: runtime({ bypass: false, reach: { kind: 'rooms', rooms: ['R'] } }) },
    ]);
    expect(risks.map((r) => r.name)).toEqual(['yolo', 'open', 'unread']);
  });
});

function CreateButton({ risky, create }: { risky: boolean; create: () => void }) {
  const confirm = useRiskyCreateConfirm();
  const [risks] = useState(() =>
    createRisks([
      {
        name: 'reviewer',
        runtime: risky ? runtime({}) : runtime({ bypass: false, reach: { kind: 'owner' } }),
      },
    ])
  );
  return (
    <>
      <button type="button" onClick={() => confirm.request(risks, 'trust-member', create)}>
        Create agent
      </button>
      {confirm.dialog}
    </>
  );
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const button = (name: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!;

describe('Create with a template that sets up a risky agent', () => {
  it('asks first, naming the risks and the author, and creates only on the second click', async () => {
    const create = vi.fn();
    await render(<CreateButton risky create={create} />);

    await userEvent.click(button('Create agent'));

    await expect.poll(dialog).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
    const text = dialog()!.textContent ?? '';
    expect(text).toContain('runs every command without asking you, on this computer');
    expect(text).toContain('Anyone in the workspace can talk to it');
    expect(text).toContain('trust-member set this up');

    await userEvent.click(button('Create anyway'));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('creates nothing when the deployer cancels', async () => {
    const create = vi.fn();
    await render(<CreateButton risky create={create} />);

    await userEvent.click(button('Create agent'));
    await expect.poll(dialog).toBeTruthy();
    await userEvent.click(button('Cancel'));

    await expect.poll(dialog).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('goes straight ahead when nothing it creates is risky', async () => {
    const create = vi.fn();
    await render(<CreateButton risky={false} create={create} />);

    await userEvent.click(button('Create agent'));

    expect(create).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });
});
