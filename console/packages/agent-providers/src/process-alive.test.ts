import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IS_PROCESS_ALIVE, isProcessAlive, type PidOrigin } from './process-alive';

const realPlatform = process.platform;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', { value: realPlatform });
});

function failWith(code: string) {
  return vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error(`kill ${code}`), { code });
  });
}

function onPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform });
}

describe.each<PidOrigin>(['recorded', 'any-user'])('for a %s pid', (origin) => {
  it('reports a process that can be signalled as alive', () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    expect(isProcessAlive(1234, origin)).toBe(true);
    expect(kill).toHaveBeenCalledWith(1234, 0);
  });

  it('reports a process that does not exist as gone', () => {
    failWith('ESRCH');
    expect(isProcessAlive(1234, origin)).toBe(false);
  });

  it('rethrows any other error', () => {
    failWith('EINVAL');
    expect(() => isProcessAlive(1234, origin)).toThrow('kill EINVAL');
  });

  it('sees this process as alive', () => {
    expect(isProcessAlive(process.pid, origin)).toBe(true);
  });

  it('reports a process it may not signal on Windows as alive', () => {
    onPlatform('win32');
    failWith('EPERM');
    expect(isProcessAlive(1234, origin)).toBe(true);
  });
});

it.each<NodeJS.Platform>(['linux', 'darwin'])(
  'takes a recorded pid that answers EPERM on %s for one reused by another user',
  (platform) => {
    onPlatform(platform);
    failWith('EPERM');
    expect(isProcessAlive(1234, 'recorded')).toBe(false);
  }
);

it.each<NodeJS.Platform>(['linux', 'darwin'])(
  'reports a pid of any user that answers EPERM on %s as alive',
  (platform) => {
    onPlatform(platform);
    failWith('EPERM');
    expect(isProcessAlive(1234, 'any-user')).toBe(true);
  }
);

const foreignPidAvailable = process.platform !== 'win32' && process.getuid?.() !== 0;

it.skipIf(!foreignPidAvailable)('takes pid 1, owned by root, as stale when recorded', () => {
  expect(isProcessAlive(1, 'recorded')).toBe(false);
  expect(isProcessAlive(1, 'any-user')).toBe(true);
});

it('runs as source in a script on its own', () => {
  const script = `${IS_PROCESS_ALIVE}
const [own, gone] = process.argv.slice(1).map(Number);
console.log(JSON.stringify([isProcessAlive(own, 'recorded'), isProcessAlive(gone, 'any-user')]));`;
  const stdout = execFileSync(
    process.execPath,
    ['-e', script, String(process.pid), String(2 ** 22 + 12345)],
    { encoding: 'utf8' }
  );
  expect(JSON.parse(stdout)).toEqual([true, false]);
});

it.skipIf(!foreignPidAvailable)('applies the recorded rule in a script on its own', () => {
  const script = `${IS_PROCESS_ALIVE}console.log(isProcessAlive(1, 'recorded'));`;
  expect(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim()).toBe('false');
});
