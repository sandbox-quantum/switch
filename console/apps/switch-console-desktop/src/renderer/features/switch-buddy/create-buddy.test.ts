import { beforeEach, describe, expect, it, vi } from 'vitest';

const list = vi.hoisted(() => vi.fn());
const getTemplateDetail = vi.hoisted(() => vi.fn());
const runTemplateDocument = vi.hoisted(() => vi.fn());
const report = vi.hoisted(() => vi.fn());

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    managedAgents: { list },
    workspaces: { getTemplateDetail, runTemplateDocument },
  },
}));
vi.mock('@renderer/lib/telemetry/report', () => ({ report }));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: { idOnServerInScope: () => 'ws-1' },
}));

const { BuddyNotCreated, createBuddy } = await import('./create-buddy');

const input = {
  serverId: 'srv-1',
  workspaceId: 'ws-1',
  machineId: 'm-1',
  provider: 'claude',
  person: { name: 'Max Tam', email: 'max@example.com' },
  entryPoint: 'onboarding' as const,
};

function created(name: string) {
  return { kind: 'created', createdAgents: [{ agentId: `id-${name}`, name }] };
}

function refused(...problems: { code: string; message: string }[]) {
  return { kind: 'refused', problems, message: 'Nothing was created.' };
}

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue([]);
  getTemplateDetail.mockResolvedValue({ name: 'switch-buddy', definition: 'version: 2' });
});

describe('createBuddy', () => {
  it('creates the buddy from the server template, under the person name', async () => {
    runTemplateDocument.mockResolvedValue(created('switch-buddy-max-tam'));

    await expect(createBuddy(input)).resolves.toEqual({
      agentId: 'id-switch-buddy-max-tam',
      name: 'switch-buddy-max-tam',
    });

    expect(getTemplateDetail).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      templateId: 'official:switch-buddy',
    });
    expect(runTemplateDocument).toHaveBeenCalledWith('ws-1', {
      template: 'version: 2',
      inputs: { agent_name: 'switch-buddy-max-tam', provider: 'claude', machine: 'm-1' },
      filled: {},
      templateName: 'switch-buddy',
      templateId: 'official:switch-buddy',
      entryPoint: 'onboarding',
    });
    expect(report).toHaveBeenCalledWith('buddy_step', { action: 'created', provider: 'claude' });
  });

  it('opens the buddy the person already has rather than making a second', async () => {
    list.mockResolvedValue([{ agentId: 'a-old', name: 'switch-buddy-max' }]);

    await expect(createBuddy(input)).resolves.toEqual({
      agentId: 'a-old',
      name: 'switch-buddy-max',
    });
    expect(runTemplateDocument).not.toHaveBeenCalled();
  });

  it('never picks a name the person already uses', async () => {
    list.mockResolvedValue([{ agentId: 'a-1', name: 'switch-buddyish' }]);
    runTemplateDocument.mockResolvedValue(created('switch-buddy-max-tam'));

    await createBuddy({ ...input, person: { name: 'Max Tam', email: null } });

    expect(runTemplateDocument.mock.calls[0]![1].inputs.agent_name).toBe('switch-buddy-max-tam');
  });

  it('tries the next number when someone else in the workspace has the name', async () => {
    runTemplateDocument
      .mockResolvedValueOnce(refused({ code: 'name_taken', message: 'Taken.' }))
      .mockResolvedValueOnce(refused({ code: 'name_taken', message: 'Taken.' }))
      .mockResolvedValueOnce(created('switch-buddy-max-tam-3'));

    await expect(createBuddy(input)).resolves.toMatchObject({ name: 'switch-buddy-max-tam-3' });
    expect(runTemplateDocument.mock.calls.map((call) => call[1].inputs.agent_name)).toEqual([
      'switch-buddy-max-tam',
      'switch-buddy-max-tam-2',
      'switch-buddy-max-tam-3',
    ]);
  });

  it('gives up after five taken names, and says so', async () => {
    runTemplateDocument.mockResolvedValue(refused({ code: 'name_taken', message: 'Taken.' }));

    await expect(createBuddy(input)).rejects.toThrow(/Every name tried/);
    expect(runTemplateDocument).toHaveBeenCalledTimes(5);
    expect(report).toHaveBeenCalledWith('buddy_step', {
      action: 'create_failed',
      provider: 'claude',
    });
  });

  it("fails with the server's own reasons for any other refusal", async () => {
    runTemplateDocument.mockResolvedValue(
      refused(
        { code: 'controller_offline', message: 'Your computer is offline.' },
        { code: 'provider_login_missing', message: 'Sign in to Claude.' }
      )
    );

    const error = await createBuddy(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BuddyNotCreated);
    expect((error as Error).message).toBe('Your computer is offline. Sign in to Claude.');
    expect(runTemplateDocument).toHaveBeenCalledTimes(1);
  });

  it('fails when the server says it created the buddy but returns no agent', async () => {
    runTemplateDocument.mockResolvedValue({ kind: 'created', createdAgents: [] });

    await expect(createBuddy(input)).rejects.toThrow(/created no agent/);
  });

  it('reports a provider telemetry does not know as none', async () => {
    runTemplateDocument.mockResolvedValue(created('switch-buddy-max-tam'));

    await createBuddy({ ...input, provider: 'something-new' });

    expect(report).toHaveBeenCalledWith('buddy_step', { action: 'created', provider: 'none' });
  });
});
