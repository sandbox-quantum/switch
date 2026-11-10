import { spawnSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { findOnPath } from '../provider-process';
import { launchOpenHands, preflightOpenHands } from './launcher';

const testPython =
  process.platform === 'win32'
    ? null
    : (process.env.OPENHANDS_TEST_PYTHON ?? (await findOnPath('python3', process.env.PATH)));
const hasPackaging = Boolean(
  testPython && spawnSync(testPython, ['-c', 'import packaging.specifiers']).status === 0
);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'switch-openhands-launch-'));
  directories.push(root);
  const bin = join(root, 'bin');
  await mkdir(bin);
  const python = join(bin, 'python3.12');
  await writeFile(python, 'not run by this test');
  await chmod(python, 0o700);
  const cli = join(bin, 'openhands');
  const writeCli = async (
    shebang: string,
    body = 'from openhands_cli.entrypoint import main\n'
  ) => {
    await writeFile(cli, `${shebang}\n${body}`);
    await chmod(cli, 0o700);
  };
  await writeCli(`#!${python}`);
  return { root, bin, python, cli, writeCli };
}

it.skipIf(process.platform === 'win32')(
  'uses the interpreter from the CLI on the supplied PATH',
  async () => {
    const { root, bin, python } = await fixture();
    const env = { PATH: bin, OPENHANDS_PERSISTENCE_DIR: '/isolated', SECRET: 'synthetic' };
    const launch = await launchOpenHands({ binaryPath: 'openhands', cwd: root, env });
    expect(launch.command).toBe(python);
    expect(launch.args.slice(0, 2)).toEqual(['-u', '-c']);
    expect(launch.env).toBe(env);
  }
);

it.skipIf(process.platform === 'win32')(
  'resolves symlinked CLIs and relative PATH entries in the child cwd',
  async () => {
    const { root, python, cli, writeCli } = await fixture();
    const unicode = join(root, '代理');
    await mkdir(unicode);
    const unicodePython = join(unicode, 'python3');
    await symlink(python, unicodePython);
    await writeCli(`#!${unicodePython}`);
    await symlink(cli, join(unicode, 'openhands'));
    const launch = await launchOpenHands({
      binaryPath: 'openhands',
      cwd: root,
      env: { PATH: '代理' },
    });
    expect(launch.command).toBe(unicodePython);
  }
);

it.skipIf(process.platform === 'win32')(
  'resolves an env shebang using the child PATH and preserves the venv symlink',
  async () => {
    const { root, bin, python, writeCli } = await fixture();
    await symlink(python, join(bin, 'python3'));
    await writeCli('#!/usr/bin/env python3');
    const launch = await launchOpenHands({
      binaryPath: 'openhands',
      cwd: root,
      env: { PATH: 'bin' },
    });
    expect(launch.command).toBe(join(bin, 'python3'));
  }
);

it.skipIf(process.platform === 'win32')(
  'does not fall back to another interpreter when the env shebang is absent from PATH',
  async () => {
    const { root, bin, writeCli } = await fixture();
    await writeCli('#!/usr/bin/env python3');
    await expect(
      launchOpenHands({ binaryPath: 'openhands', cwd: root, env: { PATH: bin } })
    ).rejects.toThrow('standalone executables and other launcher formats are not supported');
  }
);

it.skipIf(process.platform === 'win32')(
  'resolves an empty PATH component from the child cwd',
  async () => {
    const { root, python, cli } = await fixture();
    await symlink(cli, join(root, 'openhands'));
    const launch = await launchOpenHands({ binaryPath: 'openhands', cwd: root, env: { PATH: '' } });
    expect(launch.command).toBe(python);
  }
);

it.skipIf(process.platform === 'win32').each([
  [
    'an env shebang with options',
    '#!/usr/bin/env -S python3',
    'from openhands_cli.entrypoint import main\n',
  ],
  ['a native or shell executable', '#!/bin/sh', 'exit 0\n'],
  ['interpreter arguments', '#!/usr/bin/python3 -O', 'from openhands_cli.entrypoint import main\n'],
  ['a different Python script', '#!/usr/bin/python3', 'print("not OpenHands")\n'],
])('rejects %s without executing it', async (_name, shebang, body) => {
  const { root, bin, writeCli } = await fixture();
  await writeCli(shebang, body);
  await expect(
    launchOpenHands({ binaryPath: 'openhands', cwd: root, env: { PATH: bin } })
  ).rejects.toThrow('standalone executables and other launcher formats are not supported');
});

it.skipIf(process.platform === 'win32')('rejects a missing CLI', async () => {
  const { root } = await fixture();
  await expect(
    launchOpenHands({ binaryPath: 'missing', cwd: root, env: { PATH: root } })
  ).rejects.toThrow('OpenHands CLI was not found');
  await expect(
    preflightOpenHands({ binaryPath: 'missing', cwd: root, env: { PATH: root } })
  ).rejects.toThrow('OpenHands CLI was not found');
});

it.skipIf(!testPython || !hasPackaging)(
  'preflights the selected environment without leaking child output',
  async () => {
    if (!testPython) throw new Error('Python was not found');
    const { root, cli, writeCli } = await fixture();
    await writeCli(`#!${testPython}`);
    const fakePackages = join(root, 'packages');
    await mkdir(fakePackages);
    await writeFile(
      join(fakePackages, 'sitecustomize.py'),
      'import os, sys\nsys.stderr.write(os.environ["SYNTHETIC_SECRET"])\n'
    );
    const versions: Record<string, string> = {
      openhands: '1.16.0',
      'openhands-sdk': '1.21.0',
      'openhands-tools': '1.21.0',
      'agent-client-protocol': '0.8.1',
    };
    for (const [distribution, version] of Object.entries(versions)) {
      const metadata = join(
        fakePackages,
        `${distribution.replaceAll('-', '_')}-${version}.dist-info`,
        'METADATA'
      );
      await mkdir(dirname(metadata), { recursive: true });
      await writeFile(metadata, `Name: ${distribution}\nVersion: ${version}\n`);
    }
    const input = {
      binaryPath: cli,
      cwd: root,
      env: { PATH: '', PYTHONPATH: 'packages', SYNTHETIC_SECRET: 'must-not-appear' },
    };
    await expect(preflightOpenHands(input)).resolves.toBeUndefined();
    await rm(join(fakePackages, 'openhands-1.16.0.dist-info'), { recursive: true });
    const wrongVersion = join(fakePackages, 'openhands-99.0.0.dist-info', 'METADATA');
    await mkdir(dirname(wrongVersion));
    await writeFile(wrongVersion, 'Name: openhands\nVersion: 99.0.0\n');
    await expect(preflightOpenHands(input)).rejects.toThrow('package compatibility check failed');
    await expect(preflightOpenHands(input)).rejects.not.toThrow('must-not-appear');
  }
);

it.skipIf(!testPython || !hasPackaging)(
  'checks the installed package version in the selected Python process',
  async () => {
    if (!testPython) throw new Error('Python was not found');
    const { root, cli, writeCli } = await fixture();
    await writeCli(`#!${testPython}`);
    const fakePackages = join(root, 'packages');
    const metadata = join(fakePackages, 'openhands-99.0.0.dist-info', 'METADATA');
    await mkdir(dirname(metadata), { recursive: true });
    await writeFile(metadata, 'Name: openhands\nVersion: 99.0.0\n');
    // A supplied path is passed as data to filesystem calls, never to a shell.
    const adversarial = join(root, 'openhands;touch injected');
    await symlink(cli, adversarial);
    const launch = await launchOpenHands({
      binaryPath: adversarial,
      cwd: root,
      env: { PATH: process.env.PATH ?? '', PYTHONPATH: fakePackages },
    });
    const result = spawnSync(launch.command, launch.args, {
      cwd: root,
      env: launch.env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires OpenHands CLI 1.16.0');
    expect(result.stdout).toBe('');
    await expect(access(join(root, 'injected'))).rejects.toThrow();
  }
);

it.skipIf(!testPython || !hasPackaging).each([
  ['CLI', 'openhands', '1.17.0'],
  ['SDK', 'openhands-sdk', '1.22.0'],
  ['tools', 'openhands-tools', '1.22.0'],
  ['ACP below range', 'agent-client-protocol', '0.8.0'],
  ['ACP above range', 'agent-client-protocol', '0.9.0'],
])(
  'rejects an unsupported %s in the selected Python environment',
  async (_label, name, badVersion) => {
    if (!testPython) throw new Error('Python was not found');

    const { root, cli, writeCli } = await fixture();
    await writeCli(`#!${testPython}`);
    const fakePackages = join(root, 'packages');
    const versions: Record<string, string> = {
      openhands: '1.16.0',
      'openhands-sdk': '1.21.0',
      'openhands-tools': '1.21.0',
      'agent-client-protocol': '0.8.1',
      [name]: badVersion,
    };
    for (const [distribution, selectedVersion] of Object.entries(versions)) {
      const path = join(
        fakePackages,
        `${distribution.replaceAll('-', '_')}-${selectedVersion}.dist-info`,
        'METADATA'
      );
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `Name: ${distribution}\nVersion: ${selectedVersion}\n`);
    }
    const launch = await launchOpenHands({
      binaryPath: cli,
      cwd: root,
      env: { PATH: process.env.PATH ?? '', PYTHONPATH: fakePackages },
    });
    const result = spawnSync(launch.command, launch.args, {
      cwd: root,
      env: launch.env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('SDK/tools 1.21.0, and agent-client-protocol >=0.8.1,<0.9.0');
  }
);

it.runIf(process.platform === 'win32')(
  'reports that native Windows launchers are unsupported',
  async () => {
    await expect(launchOpenHands({ binaryPath: 'openhands', cwd: '.', env: {} })).rejects.toThrow(
      'standalone executables and other launcher formats are not supported'
    );
  }
);
