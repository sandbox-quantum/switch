import { loopbackOffProxy, parseLoopback } from './launcher-address';

/**
 * Whether the controller runs as a split box: started with the
 * launcher's loopback address or its socket. The one test for "split", so
 * every setting that differs on a split box (the reserve among them) agrees.
 */
export function isSplitBox(flags: {
  launcherSocket?: string | undefined;
  launcherAddress?: string | undefined;
}): boolean {
  return flags.launcherSocket !== undefined || flags.launcherAddress !== undefined;
}

/**
 * Whether the flags a box template gives the controller make a box
 * it may run as, or why not. Split mode (`--launcher-address 127.0.0.1:<port>`
 * on a gVisor box, or `--launcher-socket` where a socket is shared) needs the
 * agents' folders as the agents container sees them and the provider gateway
 * on, and isn't for agents running as users of their own. Operator exec
 * (`--operator-exec`) is for test boxes only: the template must mark the box
 * (`--test-box`), so it can't be quietly on in production.
 */
export function splitFlagsProblem(
  flags: {
    agentRuntime: string;
    launcherSocket: string | undefined;
    launcherAddress?: string | undefined;
    agentsDataDir: string | undefined;
    agentsWorkspaces: string | undefined;
    testBox: boolean;
    operatorExec: boolean;
  },
  env: NodeJS.ProcessEnv
): string | null {
  const split = isSplitBox(flags);
  if (flags.operatorExec && (!flags.testBox || !split))
    return '--operator-exec is for test boxes only: it needs --test-box and split mode from the box template.';
  if (!split) return null;
  if (flags.launcherSocket !== undefined && flags.launcherAddress !== undefined)
    return '--launcher-socket and --launcher-address are two ways to the same launcher: give one.';
  if (flags.launcherAddress !== undefined) {
    // Loopback inside the pod only: never the pod's address, another interface or IPv6.
    if (!parseLoopback(flags.launcherAddress))
      return '--launcher-address must be 127.0.0.1:<port>: the launcher link stays inside the pod.';
    if (!loopbackOffProxy(env))
      return '--launcher-address needs NO_PROXY to name 127.0.0.1 or localhost while a proxy is set: loopback must never go through the egress proxy.';
  }
  if (flags.agentRuntime !== 'default')
    return 'Split mode runs agents through the launcher, not as users of their own.';
  if (!flags.agentsDataDir || !flags.agentsWorkspaces)
    return 'Split mode needs --agents-data-dir and --agents-workspaces: the agents’ folders as the agents container sees them.';
  // A login must never reach the agents container: on this box logins go only through the gateway.
  if (env.SWITCH_CONTROLLER_PROVIDER_GATEWAY !== '1')
    return 'Split mode needs the provider gateway on (SWITCH_CONTROLLER_PROVIDER_GATEWAY=1): logins reach agents only through it here.';
  return null;
}
