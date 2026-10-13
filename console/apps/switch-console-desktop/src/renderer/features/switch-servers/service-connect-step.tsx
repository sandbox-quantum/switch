import { CircleCheck, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useCloseGuard } from '@renderer/lib/modal/use-close-guard';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Spinner } from '@renderer/lib/ui/spinner';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import type { ServiceFlow } from '@shared/core/switch-servers/service-connection';

/**
 * Connecting a service through Switch's generic sign-in: the browser signs in
 * at the vendor, this Console takes the result back, and the person confirms
 * the account before Switch keeps it. GitHub has its own step.
 */
export function ServiceConnectStep({
  serverId,
  connection,
  onBack,
}: {
  serverId: string;
  connection: ConnectionCatalogEntry;
  onBack: () => void;
}) {
  const service = connection.slug;
  const [connected, setConnected] = useState(connection.status === 'connected');
  const [flowId, setFlowId] = useState<string | null>(null);
  const [flow, setFlow] = useState<ServiceFlow | null>(null);
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useCloseGuard(busy || flowId !== null);
  useEffect(() => {
    if (!flowId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await rpc.switchServers.getServiceFlow(serverId, service, flowId);
        if (!alive) return;
        setFlow(result);
        if (result.status === 'failed')
          setError(
            result.error ?? `Signing in to ${connection.name} failed. Cancel and try again.`
          );
        else if (result.status !== 'ready') timer = setTimeout(() => void poll(), 2000);
      } catch (cause) {
        if (alive) {
          setFlowId(null);
          setFlow(null);
          setError(failureText(cause, `Could not check the ${connection.name} sign-in.`));
        }
      }
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [serverId, service, flowId, connection.name]);
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(failureText(cause, `Could not update the ${connection.name} connection.`));
    } finally {
      setBusy(false);
    }
  };
  const needsReconnect =
    connection.status === 'needs_reauthorization' || connection.status === 'error';
  return (
    <>
      <DialogHeader showCloseButton={!busy && !flowId}>
        <DialogTitle>
          {connected && !flowId ? `${connection.name} connected` : `Connect ${connection.name}`}
        </DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-4 pt-0">
        {flowId ? (
          flow?.status === 'ready' ? (
            <>
              <p className="flex items-center gap-2 text-sm">
                <CircleCheck className="size-5 text-foreground-success" />
                Signed in as <strong>{flow.account}</strong>
              </p>
              <p className="text-sm text-foreground-muted">
                Confirm this is the {connection.name} account you want to connect to Switch.
              </p>
            </>
          ) : (
            <p className="flex items-center gap-2 text-sm">
              <Spinner /> Finish signing in in your browser, then return here.
            </p>
          )
        ) : (
          <>
            <p className="text-sm text-foreground-muted">{connection.description}</p>
            <p className="text-sm text-foreground-muted">
              {connected
                ? `Agents you turn ${connection.name} on for act as you there, with what you allowed when you signed in.`
                : `You sign in at ${connection.name}, and allow what Switch asks for. Agents you then turn ${connection.name} on for act as you there.`}
            </p>
            {needsReconnect && !connected && (
              <p className="text-sm text-destructive">
                Switch can no longer use your {connection.name} sign-in. Connect again.
              </p>
            )}
            {connected && (
              <p className="text-xs text-foreground-muted">
                Disconnecting removes the sign-in Switch keeps, and every agent's access to{' '}
                {connection.name}.
              </p>
            )}
          </>
        )}
        {connection.unavailable_reason && (
          <p className="text-sm text-foreground-muted">{connection.unavailable_reason}</p>
        )}
        {warning && (
          <p role="status" className="rounded-md border p-3 text-sm text-foreground-muted">
            {warning}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogContentArea>
      <DialogFooter>
        {flowId ? (
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await rpc.switchServers.cancelServiceConnection(serverId, service, flowId);
                  setFlowId(null);
                  setFlow(null);
                })
              }
            >
              Cancel
            </Button>
            {flow?.status === 'ready' && (
              <Button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const result = await rpc.switchServers.confirmServiceConnection(
                      serverId,
                      service,
                      flowId
                    );
                    setFlowId(null);
                    setFlow(null);
                    setWarning(result.warning);
                    setConnected(true);
                  })
                }
              >
                Connect {flow.account}
              </Button>
            )}
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onBack} disabled={busy}>
              Back
            </Button>
            {connected && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const result = await rpc.switchServers.disconnectService(serverId, service);
                    setWarning(result.warning);
                    setConnected(false);
                  })
                }
              >
                Disconnect
              </Button>
            )}
            {(!connected || error) && (
              <Button
                disabled={busy || !connection.connectable}
                onClick={() =>
                  void act(async () => {
                    setFlow(null);
                    setFlowId(await rpc.switchServers.startServiceConnection(serverId, service));
                  })
                }
              >
                Connect {connection.name} <ExternalLink className="size-4" />
              </Button>
            )}
          </>
        )}
      </DialogFooter>
    </>
  );
}
