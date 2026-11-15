import { Power } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { ViewId } from '@renderer/app/view-registry';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { cn } from '@renderer/utils/utils';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { managedServerProgress, startManagedServer } from './managed-server-actions';
import { TONE_BOX, ToneDot } from './managed-server-dot';
import {
  type ManagedServerState,
  isFrozenServer,
  managedServerState,
} from './managed-server-state';
import { PrimaryButton } from './server-page-ui';
import { switchServersStore } from './switch-servers-store';

/**
 * Views that stay usable while the workspace's server can't answer: the
 * server's own page, which is where it is started, and the ones that are not
 * about the workspace at all.
 */
const NEVER_FROZEN: ReadonlySet<ViewId> = new Set<ViewId>([
  'managedServer',
  'settings',
  'home',
  'remoteHosts',
  'remoteHost',
]);

/** The active workspace's server when it is frozen and the view is one it
 * freezes, else null. */
export function frozenServer(viewId: ViewId): SwitchServer | null {
  if (NEVER_FROZEN.has(viewId)) return null;
  const server = switchServersStore.activeServer;
  return server && isFrozenServer(server) ? server : null;
}

/** What the banner says. Plain, and about what you can't do rather than why. */
export function frozenSentence(server: SwitchServer, state: ManagedServerState): string {
  const name = server.name;
  switch (state.reason) {
    case 'starting':
      return `${name} is starting. Agents and rooms come back once it's running.`;
    case 'updating':
      return `${name} is updating. Agents and rooms come back once it's done.`;
    case 'stopping':
      return `${name} is stopping.`;
    case 'waiting':
      return `Another Console is busy with ${name}. Agents and rooms come back once it's done.`;
    case 'busy':
      return `${name} is busy. Agents and rooms come back once it's running.`;
    case 'host-unreachable':
      return `Can't reach ${server.sshHost ?? name}, so agents and rooms are unavailable.`;
    case 'update-failed':
      return `${name} couldn't be updated, so agents and rooms are unavailable.`;
    case 'downgrade':
      return `${name} runs a newer switch-core than this app, so it can't be started from here.`;
    case 'docker-unavailable':
      return `Docker isn't running, so ${name} can't start.`;
    case 'start-failed':
      return `${name} couldn't start, so agents and rooms are unavailable.`;
    case 'stopped-unexpectedly':
      return `${name} stopped unexpectedly, so agents and rooms are unavailable.`;
    case 'stop-failed':
      return `${name} didn't stop cleanly, so agents and rooms are unavailable.`;
    case 'reset-failed':
      return `The reset of ${name} didn't finish, so agents and rooms are unavailable.`;
    default:
      return `${name} isn't running, so agents and rooms are unavailable.`;
  }
}

/**
 * Across the top of a frozen workspace: what is wrong, the way to the server's
 * page, and Start when starting is all it takes. Nothing to press while it is
 * already changing state, and no Start after a failed start: the page says why
 * it failed, and starting blind would only fail again. A server that was
 * running and stopped on its own is the exception: it has started before, so
 * Restart is the likeliest way back.
 */
export const FrozenBanner = observer(function FrozenBanner({ server }: { server: SwitchServer }) {
  const { navigate } = useNavigate();
  const state = managedServerState(server);
  if (!state) return null;
  const progress = state.tone === 'working' ? managedServerProgress(server) : null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex shrink-0 items-center gap-3 border-b-[0.5px] px-4 py-2.5',
        TONE_BOX[state.tone]
      )}
    >
      <span className="flex w-3 shrink-0 justify-center">
        <ToneDot tone={state.tone} size={7} />
      </span>
      <p className="min-w-0 flex-1 truncate text-[13px] text-foreground">
        {frozenSentence(server, state)}
        {progress && <span className="text-[var(--fg-dim)]"> {progress}</span>}
      </p>
      <button
        type="button"
        onClick={() => navigate('managedServer', { serverId: server.id })}
        className="shrink-0 rounded-md px-2 py-1 text-[13px] text-[var(--srv-stopped-text)] transition-colors hover:bg-[var(--sel-soft)] hover:text-foreground"
      >
        Server details
      </button>
      {(state.tone === 'stopped' || state.reason === 'stopped-unexpectedly') && (
        <PrimaryButton onClick={() => startManagedServer(server)}>
          <Power />
          {state.reason === 'stopped-unexpectedly' ? 'Restart' : 'Start'}
        </PrimaryButton>
      )}
    </div>
  );
});
