import './app/configure-app-identity';
import { join } from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { app, BrowserWindow, dialog, ipcMain, powerMonitor } from 'electron';
import dockIcon from '@/assets/images/switchdash/icon-dock.png?asset';
import { PRODUCT_NAME } from '@shared/app-identity';
import { registerRPCRouter } from '@shared/lib/ipc/rpc';
import { flushPendingDeeplink, setupDeeplinks } from './app/deeplinks';
import { setupApplicationMenu } from './app/menu';
import { registerAppScheme, setupAppProtocol } from './app/protocol';
import { createMainWindow, getMainWindow } from './app/window';
import { agentHookService } from './core/agent-hooks/agent-hook-service';
import { initializeRemoteDiscovery, initializeRemoteWatchers } from './core/agents/remote-watcher';
import { resolveAgentServers } from './core/agents/resolve-servers';
import { appService } from './core/app/service';
import { localDependencyManager } from './core/dependencies/dependency-managers';
import { locationManager } from './core/locations/location-manager';
import { locationSettingsService } from './core/locations/settings/location-settings-service';
import { promptLibraryService } from './core/prompt-library/service';
import {
  reconcileResourceSampler,
  stopResourceSampler,
} from './core/resource-monitor/resource-sampler';
import { searchService } from './core/search/search-service';
import { locationFileIndexService } from './core/search/location-file-index-service';
import { appSettingsService } from './core/settings/settings-service';
import { sshConnectionManager } from './core/ssh/lifecycle/production-ssh-connection-manager';
import { autoSessionWatcher } from './core/switch-rooms/auto-session-watcher';
import { restoreSwitchRoomSessions } from './core/switch-rooms/restore-sessions';
import { updateService } from './core/updates/update-service';
import { viewStateService } from './core/view-state/view-state-service';
import { initializeDatabase } from './db/initialize';
import {
  initializeFileLogger,
  registerProcessErrorLogging,
  registerRendererLogHandler,
} from './lib/file-logger';
import { log } from './lib/logger';
import { rpcRouter } from './rpc';
import { resolveUserEnv } from './utils/userEnv';

if (import.meta.env.DEV) {
  dotenvConfig({ path: '.env.local', override: false });
}

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
}

registerAppScheme();
setupDeeplinks();

initializeFileLogger();
registerProcessErrorLogging(log);
registerRendererLogHandler(ipcMain);

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win?.isMinimized()) win.restore();
  win?.focus();
});

if (!import.meta.env.DEV && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

if (import.meta.env.DEV) {
  try {
    app.dock?.setIcon(dockIcon);
  } catch (err) {
    log.warn('Failed to set dock icon:', err);
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

void app.whenReady().then(async () => {
  await resolveUserEnv();

  try {
    await initializeDatabase();
    searchService.initialize();
    locationFileIndexService.initialize();
    try {
      viewStateService.pruneOrphans();
    } catch (e: unknown) {
      log.warn('view-state: failed to prune orphaned entries', { error: e });
    }
  } catch (error) {
    log.error('Failed to initialize database:', error);
    dialog.showErrorBox(
      'Database Initialization Failed',
      `${PRODUCT_NAME} could not start because the database failed to initialize.\n\n${error instanceof Error ? error.message : String(error)}`
    );
    app.quit();
    return;
  }

  locationSettingsService.initialize();
  appService.initialize();
  await appSettingsService.initialize();
  await promptLibraryService.initialize();

  try {
    await resolveAgentServers();
  } catch (e) {
    log.warn('switch-agents: failed to reconcile agent → server links at boot', { error: e });
  }

  const agentHookReady = agentHookService.initialize().catch((e) => {
    log.error('Failed to start agent event service:', e);
  });

  registerRPCRouter(rpcRouter, ipcMain);

  void reconcileResourceSampler();

  const dependenciesReady = localDependencyManager.probeAll().catch((e: unknown) => {
    log.error('Failed to probe dependencies:', e);
  });

  // Relaunch every session that was connected to a Switch room before this
  // restart, so it resumes receiving and responding to room events without the
  // user reopening its terminal. Wait for the hook server and dependency probe
  // first — a spawned session needs both to deliver hooks and resolve its CLI.
  // Restore first so already-live sessions register their room connections,
  // then start the auto_session watchers — the watcher's "is a session already
  // attending this room?" check relies on those connections being present.
  void Promise.all([agentHookReady, dependenciesReady]).then(async () => {
    try {
      await restoreSwitchRoomSessions();
    } catch (e) {
      log.error('Failed to restore Switch room sessions at startup:', e);
    }
    try {
      await autoSessionWatcher.initialize();
    } catch (e) {
      log.error('Failed to initialise auto_session watcher at startup:', e);
    }
    try {
      await initializeRemoteWatchers();
    } catch (e) {
      log.error('Failed to initialise remote watchers at startup:', e);
    }
    try {
      await initializeRemoteDiscovery();
    } catch (e) {
      log.error('Failed to initialise remote session discovery at startup:', e);
    }
  });

  // A laptop waking from sleep usually has stale (frozen) SSH sockets to remote
  // agents; refresh them immediately rather than waiting out keepalive probes,
  // so remote sessions reconnect and re-attach on their own.
  powerMonitor.on('resume', () => {
    log.info('powerMonitor: system resumed — refreshing SSH connections');
    sshConnectionManager.handleSystemResume();
  });

  setupAppProtocol(join(app.getAppPath(), 'out', 'renderer'));
  setupApplicationMenu();
  createMainWindow();
  // A deeplink that launched the app (cold start) is buffered until the
  // renderer has loaded its event subscribers, then delivered. The short delay
  // lets React mount and attach the listener after the page finishes loading.
  getMainWindow()?.webContents.on('did-finish-load', () => {
    setTimeout(() => flushPendingDeeplink(), 1000);
  });

  try {
    await updateService.initialize();
  } catch (error) {
    if (app.isPackaged) {
      log.error('Failed to initialize auto-update service:', error);
    }
  }
});

app.on('before-quit', (event) => {
  event.preventDefault();
  agentHookService.dispose();
  stopResourceSampler();
  updateService.dispose();
  void locationManager.dispose().catch((e) => {
    log.error('Failed to shutdown project manager:', e);
  });
  app.exit(0);
});
