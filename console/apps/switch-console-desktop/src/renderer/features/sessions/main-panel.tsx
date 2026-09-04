import { Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { getLocationManagerStore } from '@renderer/features/locations/stores/location-selectors';
import { useSessionViewContext } from '@renderer/features/sessions/session-view-context';
import {
  getSessionManagerStore,
  getSessionStore,
  sessionErrorMessage,
  sessionRuntimeKind,
  sessionViewKind,
} from '@renderer/features/sessions/stores/session-selectors';
import { SessionTranscript } from './components/transcript/session-transcript';
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
    const progressMessage = sessionStore?.provisionProgressMessage ?? 'Setting up session…';
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-foreground-muted" />
        <p className="font-mono text-xs text-foreground-muted">{progressMessage}</p>
      </div>
    );
  }

  if (kind === 'provision-error' || kind === 'location-error') {
    const retrySession = () => {
      if (kind === 'location-error') {
        void getLocationManagerStore().mountLocation(locationId);
      } else {
        void getSessionManagerStore(locationId)?.provisionSession(sessionId, 'retry_button');
      }
    };
    return (
      <div className="flex h-full w-full flex-col items-center justify-center p-8">
        <div className="flex max-w-xs flex-col items-center gap-3 text-center">
          <TriangleAlert className="h-6 w-6 text-foreground-destructive" />
          <p className="font-mono text-sm font-medium text-foreground-destructive">
            Failed to set up session
          </p>
          <p className="font-mono text-xs text-foreground-muted">
            {sessionErrorMessage(sessionStore)}
          </p>
          <button
            type="button"
            className="mt-1 inline-flex items-center gap-1.5 text-xs text-foreground-muted underline underline-offset-2 transition-colors hover:text-foreground"
            onClick={retrySession}
          >
            <RefreshCw className="h-3 w-3" />
            Retry connection
          </button>
        </div>
      </div>
    );
  }

  if (kind === 'idle' || kind === 'teardown') {
    const progressMessage = sessionStore?.provisionProgressMessage ?? 'Setting up session…';
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
            Failed to tear down session
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

  if (sessionRuntimeKind(sessionStore) === 'provider') {
    return <SessionTranscript />;
  }

  return <SessionTerminal />;
});
