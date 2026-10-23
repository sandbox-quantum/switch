import { describe, expect, it } from 'vitest';
import { LaunchesWhileQuitting } from './relaunch-on-quit';

const findDeeplink = (argv: string[]) => argv.find((arg) => arg.startsWith('switchdash://'));

describe('LaunchesWhileQuitting', () => {
  it('does not relaunch when no launch arrived', () => {
    expect(new LaunchesWhileQuitting(findDeeplink).relaunchArgs()).toBeNull();
  });

  it('relaunches with a plain launch', () => {
    const launches = new LaunchesWhileQuitting(findDeeplink);
    launches.note([]);
    expect(launches.relaunchArgs()).toEqual([]);
    expect(launches.deeplink).toBeNull();
  });

  it('keeps a deep link when a plain launch follows it', () => {
    const launches = new LaunchesWhileQuitting(findDeeplink);
    launches.note(['switchdash://session?room=a']);
    launches.note(['--flag']);
    expect(launches.relaunchArgs()).toEqual(['--flag', 'switchdash://session?room=a']);
    expect(launches.deeplink).toBe('switchdash://session?room=a');
  });

  it('replaces an earlier deep link with a later one', () => {
    const launches = new LaunchesWhileQuitting(findDeeplink);
    launches.note(['switchdash://session?room=a']);
    launches.note(['switchdash://session?room=b']);
    expect(launches.relaunchArgs()).toEqual(['switchdash://session?room=b']);
  });
});
