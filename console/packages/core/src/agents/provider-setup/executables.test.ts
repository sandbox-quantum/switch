import { noActivity, plainText } from '@switch-console/shared';
import { describe, expect, it } from 'vitest';
import type { IExecutionContext } from '../../exec/execution-context';
import { findExecutables, realpathToInstallation, installationToRealpath } from './executables';
import { setupContext } from './steps';
import type { Executable, SetupHost } from './types';

const host: SetupHost = {
  platform: 'macos',
  exec: {} as IExecutionContext,
  runCommand: () => Promise.reject(new Error('unused')),
  runSetupCheck: null,
  runLegacyCheck: () => Promise.resolve({ ok: false, reason: 'unused' }),
  runLegacyRecheck: () => Promise.resolve({ ok: false, reason: 'unused' }),
  loginCommand: () => 'unused',
};

const onPath: Executable = {
  path: '/usr/local/bin/codex',
  realpath: '/usr/local/lib/node_modules/@openai/codex/bin/codex.js',
  version: '1.0.0',
  provenance: { kind: 'npm', confidence: 'confirmed' },
};
const named: Executable = {
  path: '/opt/codex/codex',
  realpath: '/opt/codex/codex',
  version: null,
  provenance: { kind: 'unknown', confidence: 'inferred' },
};

const noCheck = () => Promise.resolve();

describe('addInstallation', () => {
  it('lists an executable, told by where it is, its version and how it was installed', () => {
    const s = setupContext(host, noActivity, []);
    s.addInstallation(onPath, { installedVia: 'npm' }, noCheck);
    const [installation] = s.state.installations;
    expect(installation).toMatchObject({
      id: `executable-path:${onPath.realpath}`,
      version: '1.0.0',
      installedVia: 'npm',
    });
    expect(plainText(installation!.description)).toBe(
      '/usr/local/bin/codex, version 1.0.0, installed with npm'
    );
    expect(plainText(registerAndDescribe(named))).toBe('/opt/codex/codex');
  });

  it('keeps its check, with the executable, by its id', () => {
    const s = setupContext(host, noActivity, []);
    s.addInstallation(onPath, { installedVia: 'npm' }, noCheck);
    expect(s.installationChecks).toEqual({
      [`executable-path:${onPath.realpath}`]: { executable: onPath, check: noCheck },
    });
  });

  it('refuses to list one installation twice', () => {
    const s = setupContext(host, noActivity, []);
    s.addInstallation(onPath, { installedVia: 'npm' }, noCheck);
    expect(() => s.addInstallation(onPath, { installedVia: 'npm' }, noCheck)).toThrow('already');
  });
});

/** A Mac where `which` finds what `paths` maps a name to, each printing version 1.0.0. */
function machineWith(paths: Record<string, string[]>): SetupHost {
  return {
    platform: 'macos',
    exec: {
      exec: (command: string, args: string[] = []) => {
        const answer = (stdout: string) => Promise.resolve({ stdout, stderr: '' });
        const name = args.at(-1)!;
        if (command === 'which') {
          const found = paths[name] ?? (name.startsWith('/') ? [name] : []);
          if (found.length > 0) return answer(found.join('\n'));
        }
        if (command === 'realpath') return answer(name);
        if (Object.values(paths).flat().includes(command) || command.startsWith('/opt/'))
          return answer('tool 1.0.0');
        return Promise.reject(Object.assign(new Error('not found'), { code: 1 }));
      },
    } as unknown as IExecutionContext,
    runCommand: () => Promise.reject(new Error('unused')),
    runSetupCheck: null,
    runLegacyCheck: () => Promise.resolve({ ok: false, reason: 'unused' }),
    runLegacyRecheck: () => Promise.resolve({ ok: false, reason: 'unused' }),
    loginCommand: () => 'unused',
  };
}

const realpaths = (executables: Executable[]) => executables.map((e) => e.realpath);

describe('findExecutables', () => {
  it('finds every executable with the name on PATH, the first running where none is chosen', async () => {
    const s = setupContext(machineWith({ tool: ['/bin/tool', '/usr/bin/tool'] }), noActivity, []);
    const { executables, defaultExecutable } = await findExecutables(s, 'tool');
    expect(realpaths(executables)).toEqual(['/bin/tool', '/usr/bin/tool']);
    expect(defaultExecutable).toBe(executables[0]);
  });

  it('adds the executables a person chose that are there and not on PATH, after it', async () => {
    const s = setupContext(
      machineWith({ tool: ['/bin/tool'], '/opt/missing/tool': [] }),
      noActivity,
      ['/opt/tool', '/bin/tool', '/opt/missing/tool']
    );
    const { executables, defaultExecutable } = await findExecutables(s, 'tool');
    expect(realpaths(executables)).toEqual(['/bin/tool', '/opt/tool']);
    expect(defaultExecutable?.realpath).toBe('/bin/tool');
  });
});

describe('the legacy realpath of an installation', () => {
  it('goes from an installation to its realpath, and back', () => {
    const s = setupContext(host, noActivity, []);
    s.addInstallation(onPath, { installedVia: 'npm' }, noCheck);
    s.addInstallation(named, { installedVia: null }, noCheck);
    const [first, second] = s.state.installations;
    expect(installationToRealpath(first!)).toBe(onPath.realpath);
    expect(realpathToInstallation(s.state.installations, named.realpath)).toBe(second);
    expect(realpathToInstallation(s.state.installations, '/nowhere')).toBeNull();
  });
});

function registerAndDescribe(executable: Executable) {
  const s = setupContext(host, noActivity, []);
  s.addInstallation(executable, { installedVia: null }, noCheck);
  return s.state.installations[0]!.description;
}
