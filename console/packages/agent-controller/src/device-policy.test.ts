import { allowInPolicy, emptyDevicePolicy } from '@switch-console/agent-providers';
import { describe, expect, it } from 'vitest';
import {
  bypassWithheldDetail,
  consentNeeds,
  type DefinitionContext,
  effectiveDefinition,
} from './device-policy';
import type { AgentAssignment } from './schemas';

function agent(definition: Partial<AgentAssignment['definition']>): AgentAssignment {
  return {
    agent_id: 'agent-1',
    revision: 1,
    desired_state: 'running',
    definition: {
      name: 'scout',
      display_name: null,
      icon_url: null,
      provider: 'claude',
      model: null,
      advanced_config: {},
      instructions: '',
      auto_approve: false,
      auto_mode: false,
      directory: null,
      isolation: 'shared',
      ...definition,
    },
  };
}

const context = (policy = emptyDevicePolicy()): DefinitionContext => ({
  dataDir: '/data',
  workspaces: '/data/workspaces',
  policy,
});

describe('a permission mode that bypasses approvals', () => {
  it('is left out of the definition, and asked for, until the device allows bypass', () => {
    const entry = agent({
      advanced_config: { permissionMode: ' bypassPermissions ', maxTurns: 3 },
    });
    expect(effectiveDefinition(entry, context()).advanced_config).toEqual({ maxTurns: 3 });
    expect(consentNeeds([entry], context())).toEqual([
      { agentId: 'agent-1', name: 'scout', displayName: null, bypass: true, directory: null },
    ]);

    const allowed = context(
      allowInPolicy(emptyDevicePolicy(), 'agent-1', { bypass: true, directory: null })
    );
    expect(effectiveDefinition(entry, allowed)).toBe(entry.definition);
    expect(consentNeeds([entry], allowed)).toEqual([]);
    expect(bypassWithheldDetail(entry, allowed)).toBeNull();
  });

  it('says in the status what asked for it, and how to allow it', () => {
    expect(
      bypassWithheldDetail(
        agent({ auto_approve: true, advanced_config: { permissionMode: 'dontAsk' } }),
        context()
      )
    ).toBe(
      'Switch asks for this agent to run without asking for approval (auto_approve; permissionMode dontAsk in its advanced configuration), and this device has not allowed that, so it asks. Allow it on this device: Switch Console asks, or run `switch-agent-controller allow agent-1 --bypass`.'
    );
  });

  it('leaves a permission mode that asks, and every one where the device policy does not apply', () => {
    for (const permissionMode of ['default', 'acceptEdits', 'plan', 'auto']) {
      const entry = agent({ advanced_config: { permissionMode } });
      expect(effectiveDefinition(entry, context())).toBe(entry.definition);
      expect(bypassWithheldDetail(entry, context())).toBeNull();
    }
    const bypassing = agent({ advanced_config: { permissionMode: 'bypassPermissions' } });
    expect(effectiveDefinition(bypassing, { ...context(), policy: null })).toBe(
      bypassing.definition
    );
  });
});
