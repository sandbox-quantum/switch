import { describe, expect, it, vi } from 'vitest';
import { type CloudDeleteSteps, deleteMindingBoxLogin, LoginStillOnBoxError } from './cloud-delete';

const onBox = (agentId: string, provider: string, controllerId: string | null = 'c-box') => ({
  agentId,
  label: agentId,
  controllerId,
  provider,
});

/** Steps that record what was asked of the server, in order. */
function steps(
  agents: ReturnType<typeof onBox>[],
  overrides: Partial<CloudDeleteSteps> & { loginsAfter?: string[] } = {}
) {
  const calls: string[] = [];
  const all: CloudDeleteSteps = {
    hostedV2: async () => true,
    boxControllerId: async () => 'c-box',
    agents: async () => {
      calls.push('list agents');
      return agents;
    },
    loginProviders: async (controllerId) => {
      calls.push(`read logins ${controllerId}`);
      return overrides.loginsAfter ?? [];
    },
    withdrawLogin: async (controllerId, provider) => {
      calls.push(`withdraw ${provider} on ${controllerId}`);
      return 'withdrawn';
    },
    deleteAgent: async () => {
      calls.push('delete agent');
    },
    ...overrides,
  };
  return { calls, all };
}

describe('deleteMindingBoxLogin', () => {
  it("withdraws the last agent's login, reads it back, then deletes the agent", async () => {
    const { calls, all } = steps([onBox('a', 'claude'), onBox('b', 'codex')]);
    expect(await deleteMindingBoxLogin('a', all)).toBe('claude');
    expect(calls).toEqual([
      'list agents',
      'withdraw claude on c-box',
      'read logins c-box',
      'delete agent',
    ]);
  });

  it('keeps a login another agent on the box still uses', async () => {
    const { calls, all } = steps([onBox('a', 'claude'), onBox('b', 'claude')]);
    expect(await deleteMindingBoxLogin('a', all)).toBeNull();
    expect(calls).toEqual(['list agents', 'delete agent']);
  });

  it('deletes nothing when the withdraw fails', async () => {
    const { calls, all } = steps([onBox('a', 'claude')], {
      withdrawLogin: async () => {
        throw new Error('Your cloud is resting.');
      },
    });
    await expect(deleteMindingBoxLogin('a', all)).rejects.toThrow('Your cloud is resting.');
    expect(calls).not.toContain('delete agent');
  });

  it('deletes nothing when the login is still listed afterwards', async () => {
    const { calls, all } = steps([onBox('a', 'claude')], { loginsAfter: ['claude'] });
    await expect(deleteMindingBoxLogin('a', all)).rejects.toBeInstanceOf(LoginStillOnBoxError);
    expect(calls).not.toContain('delete agent');
  });

  it('goes on when the login was already gone', async () => {
    const { calls, all } = steps([onBox('a', 'claude')], { withdrawLogin: async () => 'gone' });
    await deleteMindingBoxLogin('a', all);
    expect(calls.at(-1)).toBe('delete agent');
  });

  it('deletes as before, asking nothing else, with hosted agents v2 off', async () => {
    const agents = vi.fn();
    const { calls, all } = steps([onBox('a', 'claude')], {
      hostedV2: async () => false,
      agents,
    });
    await deleteMindingBoxLogin('a', all);
    expect(agents).not.toHaveBeenCalled();
    expect(calls).toEqual(['delete agent']);
  });

  it("never touches a login for an agent that isn't on a cloud box", async () => {
    const { calls, all } = steps([onBox('a', 'claude', 'c-mac')]);
    await deleteMindingBoxLogin('a', all);
    expect(calls).toEqual(['list agents', 'delete agent']);
  });

  it('never touches a login when the owner has no v2 box', async () => {
    const { calls, all } = steps([onBox('a', 'claude')], { boxControllerId: async () => null });
    await deleteMindingBoxLogin('a', all);
    expect(calls).toEqual(['list agents', 'delete agent']);
  });
});
