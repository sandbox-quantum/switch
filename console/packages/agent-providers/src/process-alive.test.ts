import { afterEach, expect, it, vi } from 'vitest';
import { isProcessAlive } from './process-alive';

afterEach(() => {
  vi.restoreAllMocks();
});

function failWith(code: string) {
  return vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error(`kill ${code}`), { code });
  });
}

it('reports a process that can be signalled as alive', () => {
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  expect(isProcessAlive(1234)).toBe(true);
  expect(kill).toHaveBeenCalledWith(1234, 0);
});

it('reports a process that does not exist as gone', () => {
  failWith('ESRCH');
  expect(isProcessAlive(1234)).toBe(false);
});

it('reports a process it may not signal as alive', () => {
  failWith('EPERM');
  expect(isProcessAlive(1234)).toBe(true);
});

it('rethrows any other error', () => {
  failWith('EINVAL');
  expect(() => isProcessAlive(1234)).toThrow('kill EINVAL');
});

it('sees this process as alive', () => {
  expect(isProcessAlive(process.pid)).toBe(true);
});
