/**
 * Whether a Linux run without the GPU has to start again on X11.
 *
 * On a virtual GPU with no 3D (a VMware VM with 3D acceleration off, say), a
 * Wayland window is never painted even with `--disable-gpu`: the page loads
 * and runs, but the window never appears. The same run on X11 (XWayland under
 * a Wayland session) paints. Chromium settles its platform before any of the
 * app's code runs, so `--ozone-platform` only takes effect on the command line
 * of a launch, never appended from here; hence a restart.
 *
 * `ozonePlatform` is the platform this run settled on (Electron writes it
 * back into its own command line); `argv` is the launch's own arguments, to
 * tell a platform someone chose from one Electron picked.
 *
 * Nothing here touches Electron, so it can be tested as is.
 */
export function softwareRenderingNeedsX11Restart(run: {
  disableGpu: boolean;
  ozonePlatform: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
}): boolean {
  if (!run.disableGpu || run.ozonePlatform !== 'wayland' || !run.env.DISPLAY) return false;
  return !run.argv.some((arg) => arg === '--ozone-platform' || arg.startsWith('--ozone-platform='));
}

export const X11_SWITCH = '--ozone-platform=x11';
