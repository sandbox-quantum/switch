/**
 * Enrolling a new machine: what the server issues, and the commands a person
 * runs on the machine with it. The commands match the gateway's Add machine
 * dialog, so both say the same thing.
 */

/**
 * Whether a device other than the one the server runs on could enroll with
 * it, as the server says, with its reason when not.
 */
export type RemoteDevices = { supported: boolean; reason: string | null };

/** A one-time enrollment code and where the machine enrolls with it. */
export type MachineEnrollment = {
  code: string;
  expiresAt: string;
  /** The Switch API address the machine enrolls against. */
  serverUrl: string;
  /** `serverUrl` names this computer, so no other machine can reach it there. */
  loopback: boolean;
  /**
   * The server names no public address (`GATEWAY_PUBLIC_URL`), so `serverUrl`
   * is the one this Console reaches it at, which another machine may not.
   */
  fallback: boolean;
  /** What the server says about other devices enrolling; null from a server too old to say. */
  remoteDevices: RemoteDevices | null;
};

/**
 * Why no other device could enroll with this code, to show in place of the
 * commands, or null when the commands can work. The server's own answer comes
 * first; failing that (an older server, or one with no public address, which
 * leaves the address to this Console), an address on this computer's loopback
 * interface is one no other device reaches.
 */
export function enrollmentRefusal(
  enrollment: Pick<MachineEnrollment, 'serverUrl' | 'loopback' | 'fallback' | 'remoteDevices'>
): string | null {
  if (enrollment.remoteDevices?.supported === false)
    return (
      enrollment.remoteDevices.reason ??
      'This server says no other device can reach it, so none can be added.'
    );
  if (!enrollment.loopback) return null;
  if (enrollment.fallback)
    return `This server has no public address set, and this Console reaches it at ${enrollment.serverUrl}, which only this computer can reach. Set GATEWAY_PUBLIC_URL on the server to an address other devices reach, such as this computer's network IP or name.`;
  return `This server's public address is ${enrollment.serverUrl}, which only the computer it runs on can reach. Set GATEWAY_PUBLIC_URL to an address other devices reach, such as that computer's network IP or name.`;
}

/** The longest name and description a machine can enroll with. */
export const MAX_MACHINE_NAME = 200;
export const MAX_MACHINE_DESCRIPTION = 500;

/**
 * The controller's installer, as published on the default branch: it finds the
 * newest `switch-agent-controller` release and installs it with npm.
 */
export const CONTROLLER_INSTALL_SCRIPT_URL =
  'https://raw.githubusercontent.com/sandbox-quantum/switch/main/console/packages/agent-controller/install.sh';

/** One word for a POSIX shell: as it is when nothing in it is special, else single-quoted. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The enroll options for a name and description, when given: blank is left out, so the name defaults to the host name. */
function machineWords(machine: { name: string; description: string }): string[] {
  const words: string[] = [];
  const name = machine.name.trim();
  const description = machine.description.trim();
  if (name) words.push('--name', name);
  if (description) words.push('--description', description);
  return words;
}

/** The one command that installs the controller, enrolls the machine and starts it as a service. */
export function installCommand(
  server: string,
  code: string,
  machine: { name: string; description: string }
): string {
  const options = ['--server', server, '--code', code, ...machineWords(machine)];
  return `curl -fsSL ${CONTROLLER_INSTALL_SCRIPT_URL} | sh -s -- ${options.map(shellQuote).join(' ')}`;
}

/** The command for a machine where the controller is installed already. */
export function enrollCommand(
  server: string,
  code: string,
  machine: { name: string; description: string }
): string {
  return [
    'switch-agent-controller',
    'enroll',
    '--server',
    server,
    '--code',
    code,
    ...machineWords(machine),
  ]
    .map(shellQuote)
    .join(' ');
}
