import { createRPCNamespace, createRPCRouter } from '../shared/lib/ipc/rpc';
import { agentsController } from './core/agents/controller';
import { appController } from './core/app/controller';
import { filesController } from './core/fs/controller';
import { locationsController } from './core/locations/controller';
import { locationRuntimeSettingsController } from './core/locations/location-runtime-settings-controller';
import { localSwitchServerController } from './core/managed-switch-server/controller';
import { remoteSwitchServerController } from './core/managed-switch-server/remote-controller';
import { promptLibraryController } from './core/prompt-library/controller';
import { providersController } from './core/providers/controller';
import { ptyController } from './core/pty/controller';
import { remoteHostsController } from './core/remote-hosts/controller';
import { resourceMonitorController } from './core/resource-monitor/controller';
import { searchController } from './core/search/controller';
import { sessionController } from './core/sessions/controller';
import { appSettingsController } from './core/settings/controller';
import { providerSettingsController } from './core/settings/provider-settings-controller';
import { switchRoomsController } from './core/switch-rooms/controller';
import { switchServersController } from './core/switch-servers/controller';
import { switchSetupController } from './core/switch-setup/controller';
import { updateController } from './core/updates/controller';
import { viewStateController } from './core/view-state/controller';

export const rpcRouter = createRPCRouter({
  providers: providersController,
  agents: agentsController,
  app: appController,
  appSettings: appSettingsController,
  providerSettings: providerSettingsController,
  update: updateController,
  pty: ptyController,
  resourceMonitor: resourceMonitorController,
  promptLibrary: promptLibraryController,
  locations: locationsController,
  sessions: sessionController,
  viewState: viewStateController,
  search: searchController,
  switchRooms: switchRoomsController,
  locationRuntimeSettings: locationRuntimeSettingsController,
  switchServers: switchServersController,
  switchSetup: switchSetupController,
  localSwitchServer: localSwitchServerController,
  remoteSwitchServer: remoteSwitchServerController,
  remoteHosts: remoteHostsController,
  fs: createRPCNamespace({
    watch: filesController,
  }),
});

export type RpcRouter = typeof rpcRouter;
