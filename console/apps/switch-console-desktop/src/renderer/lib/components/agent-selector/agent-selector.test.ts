import { describe, expect, it } from 'vitest';
import {
  getAgentInstallActionState,
  getAgentInstallErrorMessage,
  commandFailureText,
  getAgentUpdateErrorMessage,
} from './agent-install';
import {
  buildAgentGroups,
  canInstallAgentOption,
  getAssumedInstalledAgents,
  getInstallButtonState,
  isComboboxOptionDisabled,
} from './agent-selector-options';

describe('buildAgentGroups', () => {
  it('marks installed agents selectable and uninstalled agents disabled', () => {
    const groups = buildAgentGroups(['codex']);

    expect(groups.find((group) => group.value === 'installed')?.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: 'codex', disabled: false })])
    );
    expect(groups.find((group) => group.value === 'not-installed')?.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: 'claude', disabled: true })])
    );
  });

  it('keeps the selected agent installed while availability is still unknown', () => {
    const groups = buildAgentGroups([], ['codex']);

    expect(groups.find((group) => group.value === 'installed')?.items).toEqual([
      expect.objectContaining({ agentId: 'codex', disabled: false }),
    ]);
    expect(groups.find((group) => group.value === 'not-installed')?.items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: 'codex' })])
    );
  });

  it('keeps installing agents in the not-installed group until install resolves', () => {
    const groups = buildAgentGroups(['codex', 'claude'], [], new Set(['claude']));

    expect(groups.find((group) => group.value === 'installed')?.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: 'codex', disabled: false })])
    );
    expect(groups.find((group) => group.value === 'installed')?.items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: 'claude' })])
    );
    expect(groups.find((group) => group.value === 'not-installed')?.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: 'claude', disabled: true })])
    );
  });

  it('does not assume an installing selected agent is installed', () => {
    const groups = buildAgentGroups([], ['claude'], new Set(['claude']));

    expect(groups.find((group) => group.value === 'installed')?.items).toBeUndefined();
    expect(groups.find((group) => group.value === 'not-installed')?.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: 'claude', disabled: true })])
    );
  });

  it('keeps the selected agent installed when dependency data is partial', () => {
    const assumedInstalledAgents = getAssumedInstalledAgents('codex', {
      claude: {
        id: 'claude',
        category: 'agent',
        status: 'available',
        version: '1.0.0',
        path: '/bin/claude',
        checkedAt: 1,
      },
    });
    const groups = buildAgentGroups(['claude'], assumedInstalledAgents);

    expect(groups.find((group) => group.value === 'installed')?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: 'claude', disabled: false }),
        expect.objectContaining({ agentId: 'codex', disabled: false }),
      ])
    );
    expect(groups.find((group) => group.value === 'not-installed')?.items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: 'codex' })])
    );
  });

  it('keeps inline-install rows disabled while allowing install actions', () => {
    const item = buildAgentGroups(['codex'])
      .find((group) => group.value === 'not-installed')
      ?.items.find((option) => option.agentId === 'claude');

    expect(item).toBeDefined();
    expect(canInstallAgentOption(item!, true)).toBe(true);
    expect(isComboboxOptionDisabled(item!)).toBe(true);
    expect(getInstallButtonState(item!, true, new Set())).toEqual({
      render: true,
      disabled: false,
      installing: false,
      label: 'Install Claude Code',
    });
  });

  it('maps permission install errors to friendly copy', () => {
    expect(
      getAgentInstallErrorMessage({
        type: 'permission-denied',
        message: 'User does not have sufficient permissions.',
        output: 'permission denied',
        exitCode: 243,
      })
    ).toBe('User does not have sufficient permissions.');
  });

  it('supports non-combobox install actions', () => {
    expect(
      getAgentInstallActionState({
        agentId: 'cursor',
        canInstall: true,
        isInstalled: false,
        isInstalling: true,
      })
    ).toEqual({
      render: true,
      disabled: true,
      installing: true,
      label: 'Install Cursor',
    });

    expect(
      getAgentInstallActionState({
        agentId: 'cursor',
        canInstall: true,
        isInstalled: true,
        isInstalling: false,
      }).render
    ).toBe(false);
  });

  it('only disables the actively installing agent button', () => {
    const notInstalledItems =
      buildAgentGroups(['codex']).find((group) => group.value === 'not-installed')?.items ?? [];
    const claude = notInstalledItems.find((option) => option.agentId === 'claude')!;
    const opencode = notInstalledItems.find((option) => option.agentId === 'opencode')!;

    expect(getInstallButtonState(claude, true, new Set(['claude']))).toEqual({
      render: true,
      disabled: true,
      installing: true,
      label: 'Install Claude Code',
    });
    expect(getInstallButtonState(opencode, true, new Set(['claude']))).toEqual({
      render: true,
      disabled: false,
      installing: false,
      label: 'Install OpenCode',
    });
  });

  it('supports multiple active installs at the same time', () => {
    const notInstalledItems =
      buildAgentGroups(['codex']).find((group) => group.value === 'not-installed')?.items ?? [];
    const claude = notInstalledItems.find((option) => option.agentId === 'claude')!;
    const opencode = notInstalledItems.find((option) => option.agentId === 'opencode')!;

    expect(getInstallButtonState(claude, true, new Set(['claude', 'opencode']))).toEqual({
      render: true,
      disabled: true,
      installing: true,
      label: 'Install Claude Code',
    });
    expect(getInstallButtonState(opencode, true, new Set(['claude', 'opencode']))).toEqual({
      render: true,
      disabled: true,
      installing: true,
      label: 'Install OpenCode',
    });
  });
});

describe('getAgentUpdateErrorMessage across a release line', () => {
  const cause = { type: 'command-failed' as const, message: 'npm failed', output: 'EACCES' };
  it('gives the reason an upgrade could not start', () => {
    expect(
      getAgentUpdateErrorMessage({
        type: 'line-migration-blocked',
        id: 'opencode',
        message: 'OpenCode is running. Nothing was changed.',
      })
    ).toBe('OpenCode is running. Nothing was changed.');
  });
  it('says the earlier version is back and keeps working', () => {
    const message = getAgentUpdateErrorMessage({
      type: 'line-migration-failed',
      id: 'opencode',
      restoredVersion: '1.19.5',
      cause,
    });
    expect(message).toContain('1.19.5 was put back');
    expect(message).toContain('EACCES');
  });
  it("names npm's error code rather than repeating its whole output", () => {
    const output = [
      '(node:1) Warning: EnvHttpProxyAgent is experimental',
      'npm error code ECONNREFUSED',
      'npm error syscall connect',
      'npm error FetchError: request to http://127.0.0.1:9/@opencode%2fcli failed',
      'npm error A complete log of this run can be found in: /tmp/x.log',
    ].join('\n');
    expect(commandFailureText({ type: 'command-failed', message: 'failed', output })).toBe(
      'npm error code ECONNREFUSED'
    );
    expect(
      commandFailureText({ type: 'command-failed', message: 'failed', output: 'x\nlast line' })
    ).toBe('last line');
  });
  it('says nothing is installed and gives both commands when the restore failed too', () => {
    const message = getAgentUpdateErrorMessage({
      type: 'line-migration-unrestored',
      id: 'opencode',
      previousVersion: '1.19.5',
      cause,
      restoreError: cause,
      installCommand: 'npm install -g @opencode/cli',
      restoreCommand: 'npm install -g opencode-ai@1.19.5',
    });
    expect(message).toContain('not installed now');
    expect(message).toContain('npm install -g @opencode/cli');
    expect(message).toContain('npm install -g opencode-ai@1.19.5');
  });
});
