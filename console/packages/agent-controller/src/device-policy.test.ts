import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allowInPolicy,
  disallowInPolicy,
  emptyDevicePolicy,
  writeDevicePolicy,
} from '@switch-console/agent-providers';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bypassWithheldDetail,
  consentNeeds,
  type DefinitionContext,
  DevicePolicySource,
  effectiveDefinition,
  unallowedDirectory,
} from './device-policy';
import { silentLogger } from './log';
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

describe('a directory outside the workspaces folder', () => {
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  function layout(): { dir: DefinitionContext; home: string; workspaces: string } {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'controller-policy-')));
    const workspaces = join(root, 'workspaces');
    const home = join(root, 'home');
    mkdirSync(join(workspaces, 'scout', 'repo'), { recursive: true });
    mkdirSync(home, { recursive: true });
    return {
      dir: { dataDir: join(root, 'data'), workspaces, policy: emptyDevicePolicy() },
      home,
      workspaces,
    };
  }

  it.skipIf(process.platform === 'win32')(
    'is refused when a link inside the workspaces folder leads to it, naming where it leads',
    () => {
      const { dir, home, workspaces } = layout();
      symlinkSync(home, join(workspaces, 'scout', 'repo', 'docs'));
      const linked = join(workspaces, 'scout', 'repo', 'docs');
      expect(unallowedDirectory(agent({ directory: linked }), dir)).toBe(home);
      expect(unallowedDirectory(agent({ directory: join(linked, 'sub') }), dir)).toBe(
        join(home, 'sub')
      );
      const allowed = {
        ...dir,
        policy: allowInPolicy(emptyDevicePolicy(), 'agent-1', { bypass: false, directory: home }),
      };
      expect(unallowedDirectory(agent({ directory: linked }), allowed)).toBeNull();
    }
  );

  it('accepts a directory in the workspaces folder, and refuses one outside it', () => {
    const { dir, home, workspaces } = layout();
    expect(
      unallowedDirectory(agent({ directory: join(workspaces, 'scout', 'repo') }), dir)
    ).toBeNull();
    expect(unallowedDirectory(agent({ directory: home }), dir)).toBe(home);
  });
});

describe('the device policy as the controller reads it', () => {
  it('ends on what the file says when two reads overlap, a revocation included', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'controller-policy-source-'));
    try {
      const source = new DevicePolicySource(dir, silentLogger);
      const granted = allowInPolicy(emptyDevicePolicy(), 'agent-1', {
        bypass: true,
        directory: null,
      });
      await writeDevicePolicy(dir, granted);
      const first = source.refresh();
      await writeDevicePolicy(dir, disallowInPolicy(granted, 'agent-1', 'all'));
      const second = source.refresh();
      await Promise.all([first, second]);
      expect(source.current()).toEqual(emptyDevicePolicy());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
