import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type DeviceIdSources = {
  platform: NodeJS.Platform;
  /** A command's standard output; throws when it cannot run or fails. */
  output: (command: string, args: string[]) => Promise<string>;
  /** A file's text; throws when it cannot be read. */
  read: (path: string) => Promise<string>;
  /** The OS account this runs as; throws when the system cannot say. */
  username: () => string;
  hostname: () => string;
};

export const SYSTEM_SOURCES: DeviceIdSources = {
  platform: process.platform,
  output: async (command, args) => (await run(command, args, { timeout: 5000 })).stdout,
  read: (path) => readFile(path, 'utf8'),
  username: () => userInfo().username,
  hostname,
};

const MAC_UUID = /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]+)"/;
const WINDOWS_GUID = /MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]+)/;
const LINUX_ID_FILES = ['/etc/machine-id', '/var/lib/dbus/machine-id'];

/** The platform's own id for this machine, or null where there is none to read. */
async function machineId(sources: DeviceIdSources): Promise<string | null> {
  switch (sources.platform) {
    case 'darwin': {
      const found = MAC_UUID.exec(
        await sources.output('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
      );
      return found?.[1] ?? null;
    }
    case 'win32': {
      const found = WINDOWS_GUID.exec(
        await sources.output('reg', [
          'query',
          'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
          '/v',
          'MachineGuid',
          '/reg:64',
        ])
      );
      return found?.[1] ?? null;
    }
    case 'linux':
      for (const path of LINUX_ID_FILES) {
        const id = await sources.read(path).then(
          (text) => text.trim(),
          () => ''
        );
        // An image built for cloning leaves the file empty or all zeros, for
        // the first boot to fill in; neither names a machine.
        if (id && !/^0+$/.test(id)) return id;
      }
      return null;
    default:
      return null;
  }
}

/**
 * This machine and OS account as one opaque id, the same each time it is
 * read. Switch matches a controller enrolling again on the same machine to the
 * device it already was, so that device's agents stay put across a reinstall
 * or a fresh data directory.
 *
 * A SHA-256 of the platform's machine id with the OS user name: an agent's
 * files live in that user's home, so two accounts on one computer are two
 * devices. On Linux and Windows the host name goes in too, since a cloned disk
 * or image carries the machine id it was cloned from; a Mac's hardware UUID
 * belongs to the hardware. Null when any of it cannot be read, and the
 * controller enrolls as a new device, as it always did.
 */
export async function readDeviceId(sources: DeviceIdSources): Promise<string | null> {
  let parts: string[];
  try {
    const id = await machineId(sources);
    if (id === null) return null;
    parts = ['switch-device-v1', sources.platform, id.toLowerCase(), sources.username()];
    if (sources.platform !== 'darwin') parts.push(sources.hostname().toLowerCase());
  } catch {
    return null;
  }
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}
