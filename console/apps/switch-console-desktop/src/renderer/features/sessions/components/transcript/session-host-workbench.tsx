import {
  SessionChatClient,
  snapshotSchema,
  sessionSchema,
} from '@switch-console/shared/session-v1';
import type { SessionTransport } from '@switch-console/shared/session-v1';
import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { ErrorBoundary } from '@renderer/lib/components/error-boundary';
import { rpc } from '@renderer/lib/ipc';
import { ThemeProvider } from '@renderer/lib/providers/theme-provider';
import { queryClient } from '@renderer/lib/query-client';
import { Button } from '@renderer/lib/ui/button';
import { SessionV1Chat } from './session-v1-chat';
import { SharedSessionWorkbench } from './shared-session-workbench';

const transport: SessionTransport = {
  snapshot: (id) => rpc.sdkHost.snapshot(id),
  submit: (command) => rpc.sdkHost.submit(command),
  commandStatus: (id, commandId) => rpc.sdkHost.commandStatus(id, commandId),
  subscribe(id, after, onEvent, onError, onCursor) {
    let stopped = false;
    let cursor = after;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const batch = z
          .object({ events: z.array(z.unknown()), throughSequence: z.number().int().nonnegative() })
          .parse(await rpc.sdkHost.events(id, cursor));
        if (stopped) return;
        for (const event of batch.events) onEvent(event);
        onCursor(batch.throughSequence);
        cursor = batch.throughSequence;
        timer = setTimeout(() => void poll(), 250);
      } catch (error) {
        if (!stopped) onError(error instanceof Error ? error : new Error(String(error)));
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  },
};
const listSchema = z.object({
  sessions: z.array(sessionSchema),
  errors: z.array(z.object({ sessionId: z.string(), error: z.string() })),
});
function Workbench() {
  const [provider, setProvider] = useState<'claude' | 'codex' | 'opencode' | 'gemini' | 'cursor'>(
    'claude'
  );
  const [cwd, setCwd] = useState('');
  const [sessions, setSessions] = useState<z.infer<typeof listSchema>['sessions']>([]);
  const [client, setClient] = useState<SessionChatClient | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    try {
      const result = listSchema.parse(await rpc.sdkHost.list());
      setSessions(result.sessions);
      setError(result.errors.map((e) => e.error).join('\n') || null);
    } catch (error) {
      setError(String(error));
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const snapshot = snapshotSchema.parse(await rpc.sdkHost.start({ provider, cwd }));
      setClient(new SessionChatClient(snapshot.session.sessionId, transport));
      await refresh();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <div className="flex items-center gap-3 border-b border-border p-4">
        <span className="font-medium">Local sessions</span>
        <select
          aria-label="Agent provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value as typeof provider)}
          className="rounded border border-border bg-background p-2"
        >
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
          <option value="opencode">OpenCode</option>
          <option value="gemini">Gemini</option>
          <option value="cursor">Cursor</option>
        </select>
        <input
          aria-label="Working directory"
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="Working directory"
          className="min-w-64 rounded border border-border bg-background p-2"
        />
        <Button disabled={busy || !cwd.trim()} onClick={() => void start()}>
          {busy ? 'Starting…' : 'New session'}
        </Button>
        <Button variant="outline" onClick={() => void refresh()}>
          Refresh
        </Button>
        <select
          aria-label="Saved sessions"
          value={client?.sessionId ?? ''}
          onChange={(e) =>
            e.target.value && setClient(new SessionChatClient(e.target.value, transport))
          }
          className="rounded border border-border bg-background p-2"
        >
          <option value="">Saved sessions</option>
          {sessions.map((s) => (
            <option key={s.sessionId} value={s.sessionId}>
              {s.provider} · {s.sessionId.slice(0, 8)} · {s.status}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p role="alert" className="p-4 text-foreground-destructive">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1">
        {client ? (
          <SessionV1Chat key={client.sessionId} client={client} />
        ) : (
          <p className="p-8 text-foreground-muted">
            Start a session or reopen a saved conversation. Sessions keep running when this window
            closes.
          </p>
        )}
      </div>
    </div>
  );
}
export function SessionHostWorkbench() {
  const [shared, setShared] = useState(false);
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ErrorBoundary>
          <div className="flex h-screen flex-col">
            <div className="flex gap-2 border-b border-border p-2">
              <Button variant={shared ? 'outline' : 'default'} onClick={() => setShared(false)}>
                Local sessions
              </Button>
              <Button variant={shared ? 'default' : 'outline'} onClick={() => setShared(true)}>
                Shared sessions
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              {shared ? <SharedSessionWorkbench /> : <Workbench />}
            </div>
          </div>
        </ErrorBoundary>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
