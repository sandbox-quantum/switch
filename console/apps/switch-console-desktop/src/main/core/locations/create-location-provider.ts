import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import { LocalFileSystem } from '@main/core/fs/impl/local-fs';
import { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import type { Location } from '@shared/core/locations/locations';
import { LocationProvider } from './location-provider';
import { locationTransport } from './location-transport';
import { LocalLocationSettingsProvider } from './settings/providers/local-location-settings-provider';
import { RemoteLocationSettingsProvider } from './settings/providers/remote-location-settings-provider';

export async function createProvider(location: Location): Promise<LocationProvider> {
  const transport = locationTransport(location);
  if (transport.kind === 'ssh') {
    const proxy = await ensureSshConnected(transport.connectionId, transport.host);
    const ctx = new SshExecutionContext(proxy, { root: location.dir });
    const remoteFs = new SshFileSystem(proxy, location.dir);
    const settings = new RemoteLocationSettingsProvider(location.id, location.dir, remoteFs);
    await settings.ensure();
    return new LocationProvider(location, transport, { ctx, fs: remoteFs, settings });
  }

  const localFs = new LocalFileSystem(location.dir);
  const ctx = new LocalExecutionContext({ root: location.dir });
  const settings = new LocalLocationSettingsProvider(location.id, location.dir);
  await settings.ensure();
  return new LocationProvider(location, transport, { ctx, fs: localFs, settings });
}
