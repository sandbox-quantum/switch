import { Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import type { AttachState } from './stores/session-agent-store';

/**
 * What a remote session shows on the way to its terminal.
 *
 * Only so many sessions per host keep a terminal open at once — they share one
 * SSH connection, and past a handful the slower tunnels stop answering. Which
 * ones those are is not the user's problem: opening a session attaches it and
 * evicts the least-recently-viewed one on that host, so `detached` is a state
 * this pane passes through, never one it settles in. It therefore asks for the
 * attach itself rather than offering a button — a session you are looking at
 * and cannot see is a bug, not a choice to present.
 *
 * A detached session is not a stopped one: its agent keeps running on the VM
 * and its status in the sidebar stays live.
 */
export function SessionAttachmentState({
  state,
  sessionId,
  host,
}: {
  state: Exclude<AttachState, 'attached'>;
  sessionId: string;
  host: string | null;
}) {
  const attach = useCallback(() => {
    void rpc.sessions.attachSession(sessionId).catch((error: unknown) => {
      log.warn('SessionAttachmentState: attach request failed', { sessionId, error });
    });
  }, [sessionId]);

  // Focus reporting normally attaches before this pane renders. This covers the
  // orders it cannot: a session evicted while its view stays mounted, and a
  // reconnect that replays fewer sessions than are open.
  const shouldSelfAttach = state === 'detached';
  useEffect(() => {
    if (shouldSelfAttach) attach();
  }, [shouldSelfAttach, attach]);

  if (state === 'attaching' || state === 'detached') {
    return (
      <Centered>
        <Loader2 className="h-5 w-5 animate-spin text-foreground-muted" />
        <p className="font-mono text-xs text-foreground-muted">
          {host ? `Attaching to ${host}…` : 'Attaching…'}
        </p>
      </Centered>
    );
  }

  if (state === 'failed') {
    return (
      <Centered>
        <TriangleAlert className="h-6 w-6 text-foreground-destructive" />
        <p className="font-mono text-sm font-medium text-foreground-destructive">
          Could not open the terminal
        </p>
        <p className="font-mono text-xs text-foreground-muted">
          The agent is still running{host ? ` on ${host}` : ''}. Only this view failed.
        </p>
        <ActionButton onClick={attach} icon={<RefreshCw className="h-3 w-3" />} label="Try again" />
      </Centered>
    );
  }

  return null;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center p-8">
      <div className="flex max-w-xs flex-col items-center gap-3 text-center">{children}</div>
    </div>
  );
}

function ActionButton({
  onClick,
  icon,
  label,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      className="mt-1 inline-flex items-center gap-1.5 text-xs text-foreground-muted underline underline-offset-2 transition-colors hover:text-foreground"
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}
