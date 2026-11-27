import { expect, it, vi } from 'vitest';
import { stampConsole, stampLines } from './log-stamp';

const at = new Date('2026-10-27T15:18:40.123Z');

it('puts the time at the start of every line, a multi-line message included', () => {
  expect(stampLines('Owner record judged stale\n  at line two', at)).toBe(
    '2026-10-27T15:18:40.123Z Owner record judged stale\n2026-10-27T15:18:40.123Z   at line two'
  );
});

it('stamps each console level a host logs through, formatted as the console would', () => {
  const written: string[] = [];
  const target = {
    log: (text: string) => written.push(`log ${text}`),
    info: (text: string) => written.push(`info ${text}`),
    warn: (text: string) => written.push(`warn ${text}`),
    error: (text: string) => written.push(`error ${text}`),
    debug: (text: string) => written.push(`debug ${text}`),
  } as unknown as Console;
  stampConsole(target, () => at);
  target.info('Parking session %s after %d s idle.', 'abc', 900);
  target.warn(new Error('boom').message);
  target.error('two\nlines');
  expect(written).toEqual([
    'info 2026-10-27T15:18:40.123Z Parking session abc after 900 s idle.',
    'warn 2026-10-27T15:18:40.123Z boom',
    'error 2026-10-27T15:18:40.123Z two\n2026-10-27T15:18:40.123Z lines',
  ]);
});

it('takes the time when each line is written, not when it was set up', () => {
  const written: string[] = [];
  const target = { ...console, info: (text: string) => written.push(text) } as Console;
  const clock = vi.fn().mockReturnValueOnce(new Date(0)).mockReturnValueOnce(new Date(1000));
  stampConsole(target, clock);
  target.info('first');
  target.info('second');
  expect(written).toEqual(['1970-01-01T00:00:00.000Z first', '1970-01-01T00:00:01.000Z second']);
});

it('stamps only the long-running supervisor and host modes, never a helper whose output is read', async () => {
  const { longRunning } = await import('./log-stamp');
  expect(longRunning('/data/s', '/data/s/config.json', undefined)).toBe(true); // a session host
  expect(longRunning('/data/s', '/data/s/config.json', '--supervise')).toBe(true);
  expect(longRunning('/data/s', '/data/s/config.json', '--watch-supervise')).toBe(true);
  expect(longRunning('/data/s', '/data/s/config.json', '--watch-worker')).toBe(true);
  expect(longRunning('/data/s', '/data/s/config.json', '--ensure')).toBe(false);
  expect(longRunning('/data/s', '/data/s/config.json', '--restart')).toBe(false);
  expect(longRunning('--models', 'claude', '/tmp')).toBe(false);
  expect(longRunning('--probe', 'claude', undefined)).toBe(false);
  expect(longRunning('--git-credential', 'x', undefined)).toBe(false);
  expect(longRunning('--github-cli', 'x', undefined)).toBe(false);
  expect(longRunning(undefined, undefined, undefined)).toBe(false);
});
