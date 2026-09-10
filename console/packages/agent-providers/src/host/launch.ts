import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { replaceOwner, withOwnershipLock } from './ownership-lock';
import { sharedConfigSchema, type SharedHostConfig } from './shared-config';

export function sharedSessionRoot(sessionId: string): string {
  return join(
    homedir(),
    '.local',
    'state',
    'switch',
    'sdk-sessions',
    createHash('sha256').update(sessionId).digest('hex')
  );
}

type LaunchInput = {
  root: string;
  entrypoint: string;
  config: SharedHostConfig;
  resuming: boolean;
  watcher: boolean;
  restart: boolean;
};

export async function ensureSharedProcess(input: LaunchInput): Promise<{ created: boolean }> {
  return withOwnershipLock(join(input.root, 'launch'), () => launch(input));
}

async function launch(input: LaunchInput): Promise<{ created: boolean }> {
  await mkdir(input.root, { recursive: true, mode: 0o700 });
  const path = join(input.root, 'config.json');
  let created = false;
  try {
    await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (input.restart || (input.resuming && !input.config.start.input.resume))
      throw new Error(
        'This session has no saved SDK conversation. It cannot be reopened as a new conversation.'
      );
    const temporary = `${path}.${randomUUID()}`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(input.config));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, path);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      await unlink(temporary);
    }
    if (process.platform !== 'win32') {
      const directory = await open(input.root, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  }
  const saved = sharedConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  if (
    (!input.watcher && saved.session.sessionId !== input.config.session.sessionId) ||
    saved.session.agentId !== input.config.session.agentId ||
    saved.start.provider !== input.config.start.provider ||
    saved.start.input.cwd !== input.config.start.input.cwd
  )
    throw new Error(
      'The saved SDK host identity or working directory differs from the requested session.'
    );
  if (input.restart) {
    await stopOwnedProcess(input.root, join(input.root, 'supervisor', 'owner.json'));
    await stopOwnedProcess(input.root, join(input.root, 'shared-owner.lock'));
  }
  if (input.restart || input.watcher) {
    await replaceOwner(path, {
      ...input.config,
      session: saved.session,
      roomConnection: saved.roomConnection,
    });
  }
  try {
    const owner = JSON.parse(await readFile(join(input.root, 'supervisor', 'owner.json'), 'utf8'));
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0)
      throw new Error('Invalid shared host supervisor owner.');
    process.kill(owner.pid, 0);
    return { created };
  } catch (error) {
    if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
  const log = await open(join(input.root, 'supervisor.log'), 'a', 0o600);
  try {
    const child = spawn(
      process.execPath,
      [input.entrypoint, input.root, path, input.watcher ? '--watch-supervise' : '--supervise'],
      {
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
        env: process.env,
      }
    );
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
  } finally {
    await log.close();
  }
  return { created };
}

async function stopOwnedProcess(root: string, ownerPath: string): Promise<void> {
  let pid: number;
  try {
    pid = JSON.parse(await readFile(ownerPath, 'utf8')).pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid SDK process owner.');
    process.kill(pid, 0);
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
    throw error;
  }
  if (process.platform === 'win32')
    throw new Error(
      'Automatic host restart requires process fencing, which is not available on Windows.'
    );
  const { stdout } = await promisify(execFile)('ps', ['-p', String(pid), '-o', 'command=']);
  if (!stdout.includes(root))
    throw new Error(
      'The saved PID no longer identifies this SDK host. Refusing to stop another process.'
    );
  process.kill(pid, 'SIGTERM');
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await delay(200);
  }
  throw new Error('The SDK host has not stopped. Recovery cannot start a competing owner.');
}
