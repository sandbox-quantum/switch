import { Loader2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef } from 'react';
import { getLocationManagerStore } from '@renderer/features/locations/stores/location-selectors';
import { useIsActiveSession } from '@renderer/features/sessions/hooks/use-is-active-session';
import {
  useSessionAgent,
  useSessionViewContext,
  useSessionLocationId,
  useSessionViewModel,
} from '@renderer/features/sessions/session-view-context';
import { PaneSizingProvider } from '@renderer/lib/pty/pane-sizing-context';
import { PtyPane } from '@renderer/lib/pty/pty-pane';
import { TerminalSearchOverlay } from '@renderer/lib/pty/terminal-search-overlay';
import { useTerminalSearch } from '@renderer/lib/pty/use-terminal-search';
import { SessionAttachmentState } from './session-attachment-state';

/**
 * The entire session view: one `claude` terminal. A switchdash session has
 * exactly one agent, so we mount its PTY directly — no tabs, no panes,
 * no context bar.
 */
export const SessionTerminal = observer(function SessionTerminal() {
  const { sessionId } = useSessionViewContext();
  const sessionView = useSessionViewModel();
  const agentStore = useSessionAgent();
  const locationId = useSessionLocationId();
  const isActive = useIsActiveSession(sessionId);

  const autoFocus = isActive && sessionView.focusedRegion === 'main';

  const agent = agentStore.agent;
  const session = agentStore.pty;
  const ptySessionId = session?.sessionId ?? null;

  const sshHost = getLocationManagerStore().locations.get(locationId)?.data?.sshHost ?? null;
  const isRemote = sshHost !== null;

  const containerRef = useRef<HTMLDivElement>(null);
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<{ focus: () => void }>(null);
  const focusPendingRef = useRef(false);

  const {
    isSearchOpen,
    searchQuery,
    searchStatus,
    searchInputRef,
    closeSearch,
    handleSearchQueryChange,
    stepSearch,
  } = useTerminalSearch({
    terminal: session?.pty?.terminal,
    containerRef: terminalContainerRef,
    enabled: Boolean(session?.pty),
    onCloseFocus: () => terminalRef.current?.focus(),
  });

  useEffect(() => {
    if (!autoFocus) return;
    if (terminalRef.current) {
      terminalRef.current.focus();
      focusPendingRef.current = false;
    } else {
      containerRef.current?.focus();
      focusPendingRef.current = true;
    }
  }, [autoFocus, ptySessionId]);

  const sessionStatus = session?.status;
  useEffect(() => {
    if (sessionStatus === 'ready' && focusPendingRef.current) {
      focusPendingRef.current = false;
      terminalRef.current?.focus();
    }
  }, [sessionStatus]);

  const onInterruptPress = agent ? () => agent.clearWorking() : undefined;

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="flex h-full min-w-0 flex-1 flex-col outline-none"
      onFocus={() => {
        if (isActive) sessionView.setFocusedRegion('main');
      }}
    >
      <PaneSizingProvider
        paneId={`session-${ptySessionId}`}
        sessionIds={ptySessionId ? [ptySessionId] : []}
      >
        {ptySessionId && session?.status === 'ready' && session.pty ? (
          <div ref={terminalContainerRef} className="relative flex h-full min-h-0 flex-1">
            <TerminalSearchOverlay
              isOpen={isSearchOpen}
              fullWidth
              searchQuery={searchQuery}
              searchStatus={searchStatus}
              searchInputRef={searchInputRef}
              onQueryChange={handleSearchQueryChange}
              onStep={stepSearch}
              onClose={closeSearch}
            />
            <PtyPane
              ref={terminalRef}
              sessionId={ptySessionId}
              pty={session.pty}
              className="h-full w-full"
              onInterruptPress={onInterruptPress}
              mapShiftEnterToCtrlJ
              locationId={locationId}
            />
          </div>
        ) : isRemote ? (
          // A remote session without a terminal is a normal resting state, not a
          // loading one — an indefinite spinner here reads as a hung session.
          <SessionAttachmentState
            state={agentStore.attachment === 'attached' ? 'attaching' : agentStore.attachment}
            sessionId={sessionId}
            host={sshHost}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-foreground-muted" />
          </div>
        )}
      </PaneSizingProvider>
    </div>
  );
});
