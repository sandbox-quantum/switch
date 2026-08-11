import ReactDOM from 'react-dom/client';
import { setupNavigationGuards, views } from '@renderer/app/view-registry';
import { prefetchAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import './index.css';
import 'devicon/devicon.min.css';
import 'katex/dist/katex.min.css';
import { setupAppCommandProvider } from '@renderer/lib/commands/app-commands';
import {
  setupViewCommandProvider,
  type ViewCommandProviders,
} from '@renderer/lib/commands/registry';
import { wireExternalLinkRequests } from '@renderer/lib/external-link-requests';
import { rpc } from '@renderer/lib/ipc';
import { viewStateCache } from '@renderer/lib/stores/view-state-cache';
import { log } from '@renderer/utils/logger';
import { initSoundPlayer } from '@renderer/utils/soundPlayer';
import type { NavigationSnapshot, SidebarSnapshot } from '@shared/view-state';
import { App } from './App';
import { ErrorBoundary } from './lib/components/error-boundary';
import { appState } from './lib/stores/app-state';

async function bootstrap() {
  wireExternalLinkRequests();

  appState.update.start();
  initSoundPlayer();

  const [navResult, sidebarResult, allViewState] = await Promise.all([
    rpc.viewState.get('navigation') as Promise<NavigationSnapshot> | null,
    rpc.viewState.get('sidebar'),
    rpc.viewState.getAll(),
    appState.locations.load(),
    prefetchAppSettingsKey('interface'),
  ]);

  viewStateCache.populate(allViewState as Record<string, unknown>);

  setupNavigationGuards();
  if (navResult) appState.navigation.restoreSnapshot(navResult);
  setupAppCommandProvider();
  setupViewCommandProvider(views as unknown as ViewCommandProviders);
  if (sidebarResult) {
    appState.sidebar.restoreSnapshot(sidebarResult as Partial<SidebarSnapshot>);
  } else {
    appState.sidebar.expandAllLocations();
  }

  // Avoid double-mount in dev which can duplicate PTY sessions
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}

bootstrap().catch((error: unknown) => {
  log.error('Renderer bootstrap failed:', error);
});
