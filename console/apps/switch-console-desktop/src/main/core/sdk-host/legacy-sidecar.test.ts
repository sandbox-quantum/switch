import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const { LocalExecutionContext } =
  await import('@main/core/execution-context/local-execution-context');
const { stopLegacySidecar } = await import('./legacy-sidecar');

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function agentDirectory(slug: string) {
  const repoDir = await mkdtemp(join(tmpdir(), 'legacy-sidecar-'));
  roots.push(repoDir);
  const directory = join(repoDir, '.switchdash', 'agents', slug);
  await mkdir(directory, { recursive: true });
  return { repoDir, directory, credentialsPath: `${repoDir}/.switch/agents/${slug}.json` };
}

it('stops the sidecar an earlier deployment left holding this agent', async () => {
  const { repoDir, directory, credentialsPath } = await agentDirectory('migr-test-c');
  const sidecar = spawn(
    process.execPath,
    ['-e', "console.log('ready');setInterval(() => {}, 1000);"],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  try {
    await once(sidecar.stdout!, 'data');
    await writeFile(
      join(directory, 'sidecar.ready'),
      JSON.stringify({ event: 'ready', port: 1234, token: 'token', pid: sidecar.pid })
    );
    const exited = once(sidecar, 'exit');

    await stopLegacySidecar(new LocalExecutionContext(), repoDir, credentialsPath);

    await exited;
    expect(sidecar.exitCode !== null || sidecar.signalCode !== null).toBe(true);
  } finally {
    if (sidecar.exitCode === null && sidecar.signalCode === null) sidecar.kill('SIGKILL');
  }
});

it('passes over an agent whose superseded sidecar is already gone', async () => {
  const { repoDir, directory, credentialsPath } = await agentDirectory('quiet');
  await writeFile(
    join(directory, 'sidecar.ready'),
    JSON.stringify({ event: 'ready', port: 1, token: 'token', pid: 2147483646 })
  );
  await writeFile(
    join(directory, 'state.json'),
    JSON.stringify({ version: '1', epoch: 1, sessions: [] })
  );
  await expect(
    stopLegacySidecar(new LocalExecutionContext(), repoDir, credentialsPath)
  ).resolves.toBeUndefined();
});

it('passes over an agent that never had one', async () => {
  const { repoDir, credentialsPath } = await agentDirectory('fresh');
  await expect(
    stopLegacySidecar(new LocalExecutionContext(), repoDir, credentialsPath)
  ).resolves.toBeUndefined();
});

it('leaves another agent in the same directory alone', async () => {
  const { repoDir, credentialsPath } = await agentDirectory('mine');
  const neighbour = join(repoDir, '.switchdash', 'agents', 'theirs');
  await mkdir(neighbour, { recursive: true });
  const sidecar = spawn(
    process.execPath,
    ['-e', "console.log('ready');setInterval(() => {}, 1000);"],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  try {
    await once(sidecar.stdout!, 'data');
    await writeFile(
      join(neighbour, 'sidecar.ready'),
      JSON.stringify({ event: 'ready', port: 1234, token: 'token', pid: sidecar.pid })
    );

    await stopLegacySidecar(new LocalExecutionContext(), repoDir, credentialsPath);

    expect(sidecar.exitCode).toBeNull();
    expect(sidecar.signalCode).toBeNull();
  } finally {
    sidecar.kill('SIGKILL');
  }
});
