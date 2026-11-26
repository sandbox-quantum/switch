import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBuddy, type CreateBuddyDeps, type TemplateRunResult } from './create-buddy';

describe('createBuddy', () => {
  const person = { name: 'Alice', email: 'alice@example.com' };
  const provider = 'claude-code';
  const machine = 'controller-1';
  const template = { content: 'template content', name: 'switch-buddy' };

  let deps: CreateBuddyDeps;

  beforeEach(() => {
    deps = {
      listAgents: vi.fn(),
      getTemplate: vi.fn(),
      runTemplate: vi.fn(),
      recordRun: vi.fn(),
    };
    vi.mocked(deps.getTemplate).mockResolvedValue(template);
  });

  it('returns existing buddy if found', async () => {
    const existing = {
      agentId: 'agent-1',
      name: 'switch-buddy-alice',
      template: { id: 'official:switch-buddy', key: 'buddy' },
    };
    vi.mocked(deps.listAgents).mockResolvedValue([existing]);

    const result = await createBuddy(person, provider, machine, deps);

    expect(result).toEqual({ agentId: 'agent-1', name: 'switch-buddy-alice' });
    expect(deps.runTemplate).not.toHaveBeenCalled();
  });

  it('creates new buddy when none exists', async () => {
    vi.mocked(deps.listAgents).mockResolvedValue([]);
    vi.mocked(deps.runTemplate).mockResolvedValue({
      kind: 'created',
      agentId: 'agent-2',
      name: 'switch-buddy-alice',
    });

    const result = await createBuddy(person, provider, machine, deps);

    expect(result).toEqual({ agentId: 'agent-2', name: 'switch-buddy-alice' });
    expect(deps.runTemplate).toHaveBeenCalledWith({
      content: template.content,
      name: template.name,
      agentName: 'switch-buddy-alice',
      provider,
      machine,
    });
  });

  it('records run after creation', async () => {
    vi.mocked(deps.listAgents).mockResolvedValue([]);
    vi.mocked(deps.runTemplate).mockResolvedValue({
      kind: 'created',
      agentId: 'agent-2',
      name: "Alice's assistant",
    });

    await createBuddy(person, provider, machine, deps);

    expect(deps.recordRun).toHaveBeenCalled();
  });

  it('retries with next name when name is taken', async () => {
    vi.mocked(deps.listAgents).mockResolvedValue([{ agentId: 'agent-other', name: 'Other agent' }]);
    vi.mocked(deps.runTemplate)
      .mockResolvedValueOnce({ kind: 'name_taken' } as TemplateRunResult)
      .mockResolvedValueOnce({
        kind: 'created',
        agentId: 'agent-2',
        name: "Alice's helper",
      } as TemplateRunResult);

    const result = await createBuddy(person, provider, machine, deps);

    expect(result).toEqual({ agentId: 'agent-2', name: "Alice's helper" });
    expect(deps.runTemplate).toHaveBeenCalledTimes(2);
  });

  it('throws when template run fails', async () => {
    vi.mocked(deps.listAgents).mockResolvedValue([]);
    vi.mocked(deps.runTemplate).mockResolvedValue({
      kind: 'failed',
      message: 'Template execution failed',
    });

    await expect(createBuddy(person, provider, machine, deps)).rejects.toThrow(
      'Template execution failed'
    );
  });

  it('rethrows a failed template run as the same error', async () => {
    const failure = Object.assign(new Error('HTTP 401 Unauthorized'), { code: 'GatewayError' });
    vi.mocked(deps.listAgents).mockResolvedValue([]);
    vi.mocked(deps.runTemplate).mockRejectedValue(failure);

    const caught = await createBuddy(person, provider, machine, deps).catch((e: unknown) => e);

    expect(caught).toBe(failure);
  });

  it('throws when all name attempts exhausted', async () => {
    vi.mocked(deps.listAgents).mockResolvedValue([]);
    vi.mocked(deps.runTemplate).mockResolvedValue({ kind: 'name_taken' });

    await expect(createBuddy(person, provider, machine, deps)).rejects.toThrow(
      'Every name tried for switch-buddy is already taken'
    );
    expect(deps.runTemplate).toHaveBeenCalledTimes(5);
  });

  it('works without recordRun', async () => {
    deps.recordRun = undefined;
    vi.mocked(deps.listAgents).mockResolvedValue([]);
    vi.mocked(deps.runTemplate).mockResolvedValue({
      kind: 'created',
      agentId: 'agent-2',
      name: "Alice's assistant",
    });

    const result = await createBuddy(person, provider, machine, deps);

    expect(result).toEqual({ agentId: 'agent-2', name: "Alice's assistant" });
  });

  it('uses email fallback when name is null', async () => {
    const personNoName = { name: null, email: 'bob@example.com' };
    vi.mocked(deps.listAgents).mockResolvedValue([]);
    vi.mocked(deps.runTemplate).mockResolvedValue({
      kind: 'created',
      agentId: 'agent-3',
      name: "bob's assistant",
    });

    const result = await createBuddy(personNoName, provider, machine, deps);

    expect(result.agentId).toBe('agent-3');
    expect(deps.runTemplate).toHaveBeenCalled();
  });

  it('accumulates taken names across retries', async () => {
    vi.mocked(deps.listAgents).mockResolvedValue([{ agentId: 'agent-1', name: 'First taken' }]);
    vi.mocked(deps.runTemplate)
      .mockResolvedValueOnce({ kind: 'name_taken' } as TemplateRunResult)
      .mockResolvedValueOnce({ kind: 'name_taken' } as TemplateRunResult)
      .mockResolvedValueOnce({
        kind: 'created',
        agentId: 'agent-2',
        name: "Alice's helper",
      } as TemplateRunResult);

    const result = await createBuddy(person, provider, machine, deps);

    expect(result.agentId).toBe('agent-2');
    expect(deps.runTemplate).toHaveBeenCalledTimes(3);
    const names = vi.mocked(deps.runTemplate).mock.calls.map((call) => call[0].agentName);
    expect(new Set(names).size).toBe(3);
  });
});
