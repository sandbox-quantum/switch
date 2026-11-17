import { describe, expect, it } from 'vitest';
import { softwareRenderingNeedsX11Restart } from './linux-software-rendering';

const session = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' };
const run = {
  disableGpu: true,
  ozonePlatform: 'wayland',
  argv: ['--disable-gpu'],
  env: session,
};

describe('softwareRenderingNeedsX11Restart', () => {
  it('restarts a --disable-gpu run that settled on Wayland on X11', () => {
    expect(softwareRenderingNeedsX11Restart(run)).toBe(true);
  });

  it('leaves a run that keeps the GPU alone', () => {
    expect(softwareRenderingNeedsX11Restart({ ...run, disableGpu: false, argv: [] })).toBe(false);
  });

  it('leaves a run already on X11 alone, so the restart happens once', () => {
    expect(
      softwareRenderingNeedsX11Restart({
        ...run,
        ozonePlatform: 'x11',
        argv: ['--disable-gpu', '--ozone-platform=x11'],
      })
    ).toBe(false);
  });

  it('keeps a platform the launch chose', () => {
    expect(
      softwareRenderingNeedsX11Restart({
        ...run,
        argv: ['--disable-gpu', '--ozone-platform=wayland'],
      })
    ).toBe(false);
  });

  it('stays on Wayland when there is no X display to reach', () => {
    expect(
      softwareRenderingNeedsX11Restart({
        ...run,
        env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' },
      })
    ).toBe(false);
  });
});
