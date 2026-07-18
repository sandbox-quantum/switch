import { useEffect, useRef, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { FrontendPty } from '@renderer/lib/pty/pty';
import { PtyPane } from '@renderer/lib/pty/pty-pane';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { ptyExitChannel } from '@shared/core/pty/ptyEvents';

type Props = {
  sshHost: string;
  /** Called when the user dismisses the panel (cancel or done). */
  onDone: () => void;
};

/**
 * Interactive `gh auth login` (device flow) for a remote host, rendered as a live
 * terminal INLINE on the remote-hosts page.
 *
 * This must not live inside a modal: switchdash's terminal input path is disabled
 * whenever a `[role="dialog"]` is present (usePty guards focus, and xterm's key
 * handler discards every event), so a terminal in a dialog can never receive
 * keystrokes. Rendered inline, it behaves like any other terminal.
 *
 * The main process spawns `gh auth login --web` in an SSH PTY; the user reads the
 * one-time code, clicks the printed verification URL (opens in their browser), and
 * authorizes. On exit code 0 the parent re-probes so the gh row flips to
 * authenticated.
 */
export function GhAuthPanel({ sshHost, onDone }: Props) {
  const [pty, setPty] = useState<FrontendPty | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null | undefined>(undefined);

  const ptyRef = useRef<FrontendPty | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const paneRef = useRef<{ focus: () => void } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let offExit: (() => void) | undefined;

    void (async () => {
      try {
        const { sessionId: sid } = await rpc.remoteHosts.startGhAuth({ sshHost });
        if (cancelled) {
          void rpc.pty.kill(sid);
          return;
        }
        sessionIdRef.current = sid;
        setSessionId(sid);

        const frontend = new FrontendPty(sid);
        await frontend.connect();
        if (cancelled) {
          frontend.dispose();
          void rpc.pty.kill(sid);
          return;
        }
        ptyRef.current = frontend;
        setPty(frontend);

        offExit = events.on(
          ptyExitChannel,
          (info: { exitCode: number; signal?: number }) => {
            setExitCode(info.exitCode ?? null);
          },
          sid
        );
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
      offExit?.();
      const sid = sessionIdRef.current;
      if (sid) void rpc.pty.kill(sid);
      ptyRef.current?.dispose();
    };
  }, [sshHost]);

  // Focus the terminal as soon as it mounts so keystrokes reach gh's prompts
  // without having to click into the pane first.
  useEffect(() => {
    if (!pty) return;
    const id = requestAnimationFrame(() => paneRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [pty]);

  const exited = exitCode !== undefined;
  const succeeded = exitCode === 0;

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <h5 className="text-sm font-medium">Authenticate GitHub CLI on {sshHost}</h5>
        <Button size="sm" variant="outline" onClick={onDone}>
          {succeeded ? 'Close' : 'Cancel'}
        </Button>
      </div>

      <p className="text-xs text-foreground-muted">
        gh will print a one-time code and a verification URL below. Click the URL (or open{' '}
        <span className="font-mono">github.com/login/device</span>) in your browser, enter the code,
        and authorize.
      </p>

      {error ? (
        <p className="text-destructive text-xs">{error}</p>
      ) : !pty || !sessionId ? (
        <div className="flex items-center gap-2 text-sm text-foreground-muted">
          <Spinner /> Starting gh auth on the host…
        </div>
      ) : (
        <div className="h-72 overflow-hidden rounded-md border border-border">
          <PtyPane
            ref={paneRef}
            sessionId={sessionId}
            pty={pty}
            locationId=""
            className="h-full w-full"
          />
        </div>
      )}

      {exited &&
        (succeeded ? (
          <p className="text-xs text-green-500">Authenticated successfully.</p>
        ) : (
          <p className="text-destructive text-xs">
            gh auth exited{exitCode == null ? '' : ` with code ${exitCode}`} without completing. You
            can close and try again.
          </p>
        ))}
    </div>
  );
}
