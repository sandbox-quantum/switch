import { spawn } from 'node:child_process';
import { app } from 'electron';
import { buildExternalToolEnv } from '@main/utils/childProcessEnv';

/**
 * Waits for the process whose id is `$0` to exit, then runs the rest of the
 * arguments. A shell outside the AppImage, so it outlives the image's mount.
 */
const WAIT_THEN_EXEC = 'while kill -0 "$0" 2>/dev/null; do sleep 0.2; done; exec "$@"';

export type RelaunchPlan =
  | { kind: 'electron'; args: string[] }
  | { kind: 'appimage'; command: string; args: string[] };

/**
 * How to start this same app again once it has exited, with `args` (the
 * arguments without the executable).
 *
 * From an AppImage, Electron's own relaunch cannot work: both the executable
 * it starts again and the helper that waits to start it live inside the
 * image's FUSE mount, which goes away when this process exits, so nothing
 * starts. Instead a shell outside the mount waits for this process to exit and
 * then runs the AppImage file itself (`APPIMAGE`, set by its runtime), which
 * mounts the image again and runs its launcher, as a normal launch does.
 * Waiting matters: a copy started while this one still holds the
 * single-instance lock would hand its launch to this one and quit.
 */
export function relaunchPlan(args: string[], env: NodeJS.ProcessEnv, pid: number): RelaunchPlan {
  if (!env.APPIMAGE) return { kind: 'electron', args };
  return {
    kind: 'appimage',
    command: '/bin/sh',
    args: ['-c', WAIT_THEN_EXEC, String(pid), env.APPIMAGE, ...args],
  };
}

/**
 * Starts this app again after it exits. Like `app.relaunch`, it only takes
 * effect once the caller quits.
 */
export function relaunchApp(args: string[] = process.argv.slice(1)): void {
  const plan = relaunchPlan(args, process.env, process.pid);
  if (plan.kind === 'electron') {
    app.relaunch({ args: plan.args });
    return;
  }
  // The AppImage runtime's own variables and mount paths would make the new
  // copy look inside a mount that no longer exists.
  spawn(plan.command, plan.args, {
    detached: true,
    stdio: 'ignore',
    env: buildExternalToolEnv(process.env),
  }).unref();
}
