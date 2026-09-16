import { describe, expect, it, vi } from 'vitest';
import type { ResolvedShellProfile } from '@main/core/terminal-shell/types';
import { classifyInstallCommandFailure, runLocalInstallCommand } from './install-runner';

vi.mock('@main/utils/userEnv', () => ({ ensureUserBinDirsInPath: vi.fn() }));
const profile: ResolvedShellProfile = {
  id: 'bash',
  resolvedShellId: 'bash',
  resolvedFromSystem: false,
  executable: '/bin/bash',
  available: true,
  family: 'posix',
  interactiveArgs: [],
  commandArgs: ['-c'],
};

describe('noninteractive install commands', () => {
  it('preserves literal argv without shell expansion', async () => {
    const value = '$(exit 9) "quoted" ; exit 8';
    const result = await runLocalInstallCommand(
      {
        command: process.execPath,
        args: ['-e', 'process.exit(process.argv[1] === process.argv[2] ? 0 : 1)', value, value],
      },
      profile
    );
    expect(result.success).toBe(true);
  });
  it('runs shell descriptors with closed stdin', async () => {
    expect((await runLocalInstallCommand('test ! -t 0 && test ! -t 1', profile)).success).toBe(
      true
    );
  });
  it('captures stderr and failure status', async () => {
    const result = await runLocalInstallCommand('echo "permission denied" >&2; exit 13', profile);
    expect(result).toMatchObject({
      success: false,
      error: { type: 'permission-denied', exitCode: 13 },
    });
  });
  it('reports missing executables', async () => {
    const result = await runLocalInstallCommand(
      { command: '/nonexistent/switch-install-test', args: [] },
      profile
    );
    expect(result).toMatchObject({ success: false, error: { type: 'process-open-failed' } });
  });
  it('classifies command failures', () => {
    expect(classifyInstallCommandFailure({ exitCode: 1, output: 'failed' }).type).toBe(
      'command-failed'
    );
  });
});
