import { describe, expect, it } from 'vitest';
import { type DeviceIdSources, readDeviceId } from './device-id';

const MAC_IOREG = `+-o J316sAP  <class IOPlatformExpertDevice, id 0x100000253, registered, matched, active, busy 0 (65 ms), retain 34>
    {
      "IOPlatformSerialNumber" = "GCXWMY2NX4"
      "IOPlatformUUID" = "4C4C4544-0042-3810-8051-B4C04F4E3732"
    }`;
const WINDOWS_REG = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography
    MachineGuid    REG_SZ    8d3f7a29-1c4e-4b8a-9f2d-3e5a7c1b0d64
`;

function sources(overrides: Partial<DeviceIdSources>): DeviceIdSources {
  return {
    platform: 'linux',
    output: async () => {
      throw new Error('not here');
    },
    read: async () => {
      throw new Error('ENOENT');
    },
    username: () => 'ada',
    hostname: () => 'build-01',
    ...overrides,
  };
}

const mac = (overrides: Partial<DeviceIdSources> = {}) =>
  sources({ platform: 'darwin', output: async () => MAC_IOREG, ...overrides });

describe('readDeviceId', () => {
  it('names a Mac by its hardware UUID and OS account, the same each time', async () => {
    const first = await readDeviceId(mac());
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await readDeviceId(mac())).toBe(first);
    // A Mac's host name changes with the network it is on; the id does not.
    expect(await readDeviceId(mac({ hostname: () => 'Adas-MacBook.local' }))).toBe(first);
    // Another account on the same Mac is another device: its agents' files are elsewhere.
    expect(await readDeviceId(mac({ username: () => 'grace' }))).not.toBe(first);
  });

  it('reads Windows’s machine GUID, with the host name, since a cloned image shares the GUID', async () => {
    const windows = (hostname: string) =>
      sources({ platform: 'win32', output: async () => WINDOWS_REG, hostname: () => hostname });
    const first = await readDeviceId(windows('DESK-1'));
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await readDeviceId(windows('desk-1'))).toBe(first);
    expect(await readDeviceId(windows('DESK-2'))).not.toBe(first);
  });

  it('reads Linux’s machine id, falling back to D-Bus’s, and skips an image’s blank one', async () => {
    const files = (found: Record<string, string>) =>
      sources({
        read: async (path) => {
          const text = found[path];
          if (text === undefined) throw new Error('ENOENT');
          return text;
        },
      });
    const etc = await readDeviceId(
      files({ '/etc/machine-id': 'b08dfa6083e7567a1921a715000001fb\n' })
    );
    expect(etc).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await readDeviceId(files({ '/var/lib/dbus/machine-id': 'b08dfa6083e7567a1921a715000001fb' }))
    ).toBe(etc);
    expect(
      await readDeviceId(
        files({
          '/etc/machine-id': '00000000000000000000000000000000\n',
          '/var/lib/dbus/machine-id': 'b08dfa6083e7567a1921a715000001fb',
        })
      )
    ).toBe(etc);
    expect(await readDeviceId(files({ '/etc/machine-id': '\n' }))).toBeNull();
  });

  it('is null where the id or the account cannot be read, so the machine enrolls as a new device', async () => {
    expect(await readDeviceId(sources({}))).toBeNull();
    expect(await readDeviceId(mac({ output: async () => 'no uuid here' }))).toBeNull();
    expect(
      await readDeviceId(
        mac({
          output: async () => {
            throw new Error('ioreg: not found');
          },
        })
      )
    ).toBeNull();
    expect(
      await readDeviceId(
        mac({
          username: () => {
            throw new Error('no passwd entry');
          },
        })
      )
    ).toBeNull();
    expect(await readDeviceId(sources({ platform: 'freebsd' }))).toBeNull();
  });
});
