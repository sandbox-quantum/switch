/**
 * Renaming an agent from Console: one dialog for the name and the display
 * name. The display name follows the name while it is the name written out,
 * the server's refusal is shown in the dialog, and a Console agent's own
 * files are moved only after the server has renamed it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.hoisted(() => ({
  workspaces: { renameAgent: vi.fn() },
  agents: { renameLocal: vi.fn() },
}));

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({ rpc: rpcMock, events: { on: () => () => {} } }));

import {
  RenameAgentModal,
  type RenameAgentResult,
} from '@renderer/features/agent-identity/rename-agent-modal';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  rpcMock.workspaces.renameAgent.mockReset();
  rpcMock.agents.renameLocal.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(props: { displayName: string | null; localAgentId: string | null }) {
  const onSuccess = vi.fn<(result: RenameAgentResult) => void>();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <Dialog open>
        <DialogContent>
          <RenameAgentModal
            workspaceId="workspace-1"
            switchAgentId="agent-1"
            currentName="notes-taker"
            currentDisplayName={props.displayName}
            localAgentId={props.localAgentId}
            onSuccess={onSuccess}
            onClose={() => {}}
          />
        </DialogContent>
      </Dialog>
    )
  );
  return onSuccess;
}

function input(label: string): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!found) throw new Error(`no input ${label}`);
  return found;
}

async function type(target: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function renameButton(): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) =>
    /^Renam/.test(b.textContent?.trim() ?? '')
  );
  if (!found) throw new Error('no Rename button');
  return found;
}

function outcome(name: string, displayName: string | null) {
  return {
    agent: { id: 'agent-1', name, displayName },
    oldName: 'notes-taker',
    bridgeFailures: [],
    templatesMentioningOldName: [],
  };
}

describe('RenameAgentModal', () => {
  it('suggests a display name from the new name when the old one was written out', async () => {
    await render({ displayName: 'Notes Taker', localAgentId: null });

    await type(input('Name'), 'meeting-scribe');

    expect(input('Display name').value).toBe('Meeting Scribe');
    expect(document.body.textContent).toContain('Suggested from the new name');
  });

  it('keeps a display name someone chose', async () => {
    await render({ displayName: 'Scribe', localAgentId: null });

    await type(input('Name'), 'meeting-scribe');

    expect(input('Display name').value).toBe('Scribe');
  });

  it('stops following the name once the display name is edited', async () => {
    await render({ displayName: 'Notes Taker', localAgentId: null });

    await type(input('Display name'), 'The Scribe');
    await type(input('Name'), 'meeting-scribe');

    expect(input('Display name').value).toBe('The Scribe');
  });

  it('sends the name and display name together, and nothing local for a machine’s agent', async () => {
    rpcMock.workspaces.renameAgent.mockResolvedValue(outcome('meeting-scribe', 'Meeting Scribe'));
    const onSuccess = await render({ displayName: 'Notes Taker', localAgentId: null });

    await type(input('Name'), 'meeting-scribe');
    await act(async () => renameButton().click());

    expect(rpcMock.workspaces.renameAgent).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      name: 'meeting-scribe',
      displayName: 'Meeting Scribe',
    });
    expect(rpcMock.agents.renameLocal).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({ localProblem: null }));
  });

  it('sends null for a blank display name', async () => {
    rpcMock.workspaces.renameAgent.mockResolvedValue(outcome('meeting-scribe', null));
    await render({ displayName: null, localAgentId: null });

    await type(input('Name'), 'meeting-scribe');
    await act(async () => renameButton().click());

    expect(rpcMock.workspaces.renameAgent).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: null })
    );
  });

  it('moves a Console agent’s own files after the server renames it', async () => {
    rpcMock.workspaces.renameAgent.mockResolvedValue(outcome('meeting-scribe', 'Meeting Scribe'));
    await render({ displayName: 'Notes Taker', localAgentId: 'local-1' });

    await type(input('Name'), 'meeting-scribe');
    await act(async () => renameButton().click());

    expect(rpcMock.agents.renameLocal).toHaveBeenCalledWith({
      agentId: 'local-1',
      newName: 'meeting-scribe',
    });
  });

  it('shows the server’s refusal and renames nothing locally', async () => {
    rpcMock.workspaces.renameAgent.mockRejectedValue(new Error("Agent already exists: 'helper'."));
    const onSuccess = await render({ displayName: null, localAgentId: 'local-1' });

    await type(input('Name'), 'helper');
    await act(async () => renameButton().click());

    expect(document.body.textContent).toContain('Nothing changed');
    expect(onSuccess).not.toHaveBeenCalled();
    expect(rpcMock.agents.renameLocal).not.toHaveBeenCalled();
  });

  it('cannot submit a name the server would refuse for its format', async () => {
    await render({ displayName: null, localAgentId: null });

    await type(input('Name'), 'Meeting Scribe');

    expect(renameButton().disabled).toBe(true);
  });

  it('cannot submit when nothing changed', async () => {
    await render({ displayName: 'Notes Taker', localAgentId: null });

    expect(renameButton().disabled).toBe(true);
  });
});
