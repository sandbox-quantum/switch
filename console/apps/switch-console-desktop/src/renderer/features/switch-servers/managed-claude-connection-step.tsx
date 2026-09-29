import { CircleCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Spinner } from '@renderer/lib/ui/spinner';
import type { ClaudeConnection } from '@shared/core/switch-servers/claude-credential';
import { ManagedClaudeStep } from './managed-claude-step';

export function ManagedClaudeConnectionStep({
  serverId,
  onBack,
  onDone,
  context,
}: {
  serverId: string;
  onBack: () => void;
  onDone: () => void;
  context: 'onboarding' | 'settings';
}) {
  const [connection, setConnection] = useState<ClaudeConnection | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setConnection(await rpc.switchServers.getClaudeConnection(serverId));
    } catch (cause) {
      setError(failureText(cause, 'Could not load your Claude connection.'));
    } finally {
      setLoading(false);
    }
  }, [serverId]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!loading && connection && (connection.status === 'not_connected' || editing)) {
    return (
      <ManagedClaudeStep
        onBack={() => {
          if (editing) setEditing(false);
          else onBack();
        }}
        onSave={async (kind, credential) => {
          const result = await rpc.switchServers.connectClaude(serverId, kind, credential);
          setConnection(result);
          setEditing(false);
          setError(null);
        }}
      />
    );
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {connection?.status === 'connected' ? 'Claude Code connected' : 'Connect Claude Code'}
        </DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-4 pt-0">
        {loading ? (
          <div className="flex items-center gap-2 text-sm">
            <Spinner /> Checking connection…
          </div>
        ) : connection?.status === 'connected' ? (
          <>
            <div className="flex items-center gap-2 text-sm">
              <CircleCheck className="size-5 text-foreground-success" /> Verified with Claude Code
            </div>
            <p className="text-sm text-foreground-muted">
              {connection.kind === 'api-key' ? 'API key' : 'Subscription setup token'} · Verified{' '}
              {new Date(connection.verified_at).toLocaleString()}
            </p>
            <p className="text-sm">Your credential is stored encrypted on Switch.</p>
            <p className="text-xs text-foreground-muted">
              Removing this connection deletes the saved credential from Switch; it does not revoke
              it with Claude.
            </p>
          </>
        ) : null}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!loading && !connection && (
          <Button variant="outline" onClick={() => void load()}>
            Retry
          </Button>
        )}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onBack} disabled={loading}>
          Back
        </Button>
        {!loading && connection?.status === 'connected' && (
          <>
            <Button variant="outline" onClick={() => setEditing(true)}>
              Replace credential
            </Button>
            <Button
              variant="ghost"
              onClick={async () => {
                setLoading(true);
                setError(null);
                try {
                  await rpc.switchServers.disconnectClaude(serverId);
                  setConnection({ status: 'not_connected' });
                } catch (cause) {
                  setError(failureText(cause, 'Could not remove the Claude connection.'));
                } finally {
                  setLoading(false);
                }
              }}
            >
              Remove
            </Button>
            <Button onClick={onDone}>
              {context === 'settings' ? 'Done' : 'Continue to GitHub'}
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}
