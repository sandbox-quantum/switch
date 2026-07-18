import { Loader2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useSessionViewContext } from '@renderer/features/sessions/session-view-context';
import {
  getSessionStore,
  sessionErrorMessage,
  sessionViewKind,
} from '@renderer/features/sessions/stores/session-selectors';
import { SessionTerminal } from './session-terminal';

export const SessionMainPanel = observer(function SessionMainPanel() {
  const { locationId, sessionId } = useSessionViewContext();
  const sessionStore = getSessionStore(locationId, sessionId);
  const kind = sessionViewKind(sessionStore, locationId);

  if (kind === 'creating') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-foreground-muted" />
        <p className="font-mono text-xs text-foreground-muted">Creating session</p>
      </div>
    );
  }

  if (kind === 'create-error') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center p-8">
        <div className="flex max-w-xs flex-col items-center gap-2 text-center">
          <p className="font-mono text-sm font-medium text-foreground-destructive">
            Error creating session
          </p>
          <p className="font-mono text-xs text-foreground-passive">
            {sessionErrorMessage(sessionStore)}
          </p>
        </div>
      </div>
    );
  }

  if (kind === 'location-mounting' || kind === 'provisioning') {
    const progressMessage = sessionStore?.provisionProgressMessage ?? 'Setting up workspace…';
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-foreground-muted" />
        <p className="font-mono text-xs text-foreground-muted">{progressMessage}</p>
      </div>
    );
  }

  if (kind === 'provision-error' || kind === 'location-error') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center p-8">
        <div className="flex max-w-xs flex-col items-center gap-2 text-center">
          <p className="font-mono text-sm font-medium text-foreground-destructive">
            Failed to set up workspace
          </p>
          <p className="font-mono text-xs text-foreground-muted">
            {sessionErrorMessage(sessionStore)}
          </p>
        </div>
      </div>
    );
  }

  if (kind === 'idle' || kind === 'teardown') {
    const progressMessage = sessionStore?.provisionProgressMessage ?? 'Setting up workspace…';
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-foreground-muted" />
        <p className="font-mono text-xs text-foreground-muted">{progressMessage}</p>
      </div>
    );
  }

  if (kind === 'teardown-error') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center p-8">
        <div className="flex max-w-xs flex-col items-center gap-2 text-center">
          <p className="font-mono text-sm font-medium text-foreground-destructive">
            Failed to tear down workspace
          </p>
          <p className="font-mono text-xs text-foreground-muted">
            {sessionErrorMessage(sessionStore)}
          </p>
        </div>
      </div>
    );
  }

  if (kind === 'missing') {
    return null;
  }

  return <SessionTerminal />;
});
