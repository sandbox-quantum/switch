import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { relaunch: vi.fn() } }));

const { relaunchPlan } = await import('./relaunch-app');

describe('relaunchPlan', () => {
  it('starts the AppImage file once this process has exited', () => {
    const plan = relaunchPlan(
      ['--no-sandbox', '--disable-gpu'],
      { APPIMAGE: '/home/me/switch-console-x86_64.AppImage' },
      4242
    );
    expect(plan).toEqual({
      kind: 'appimage',
      command: '/bin/sh',
      args: [
        '-c',
        expect.stringContaining('kill -0 "$0"'),
        '4242',
        '/home/me/switch-console-x86_64.AppImage',
        '--no-sandbox',
        '--disable-gpu',
      ],
    });
  });

  it('uses Electron’s relaunch everywhere else', () => {
    expect(relaunchPlan(['--flag'], {}, 4242)).toEqual({ kind: 'electron', args: ['--flag'] });
  });
});
