import { ExternalLink } from 'lucide-react';
import { useEffect, useReducer, useRef } from 'react';
import {
  canCloseConnectFlow,
  connectFlowReducer,
  initialConnectFlow,
} from '@renderer/features/connectors/connect-flow';
import { failureText } from '@renderer/lib/errors/describe-failure';
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
import type { ServiceCalls } from './service-calls';

/**
 * Connecting a service through Switch's generic sign-in: the browser signs in
 * at the vendor, this Console takes the result back, and Switch keeps the
 * account as soon as it has it. The dialog follows the sign-in and shows the
 * account connected, or why it was not. GitHub has its own step.
 */
export function ServiceConnectStep({
  calls,
  connection,
  onBack,
  onConnected,
}: {
  calls: ServiceCalls;
  connection: ConnectionCatalogEntry;
  onBack: () => void;
  /** Moves on once the account is connected, with the warning Switch gave. */
  onConnected?: (warning: string | null) => void;
}) {
  const service = connection.slug;
  const [state, dispatch] = useReducer(
    connectFlowReducer,
    connection.status === 'connected',
    initialConnectFlow
  );
  const { connected, flowId, flow, busy, warning, error } = state;
  const closable = canCloseConnectFlow(state);
  useCloseGuard(!closable);
  // Callers build their calls as they render; polling follows the flow, not them.
  const callsRef = useRef(calls);
  callsRef.current = calls;
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;
  useEffect(() => {
    if (!flowId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await callsRef.current.getSignIn(service, flowId);
        if (!alive) return;
        if (result.status === 'connected') {
          onConnectedRef.current?.(result.warning);
          dispatch({ type: 'connected', warning: result.warning });
          return;
        }
        dispatch({
          type: 'polled',
          flow: result,
          failure: `Signing in to ${connection.name} failed. Cancel and try again.`,
        });
        if (result.status !== 'failed') timer = setTimeout(() => void poll(), 2000);
      } catch (cause) {
        if (alive)
          dispatch({
            type: 'poll_failed',
            error: failureText(cause, `Could not check the ${connection.name} sign-in.`),
          });
      }
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [service, flowId, connection.name]);
  const fallback = `Could not update the ${connection.name} connection.`;
  const start = async () => {
    dispatch({ type: 'act' });
    try {
      dispatch({
        type: 'started',
        flowId: await calls.startSignIn(service),
      });
    } catch (cause) {
      dispatch({ type: 'failed', error: failureText(cause, fallback) });
    }
  };
  const cancel = async (id: string) => {
    dispatch({ type: 'act' });
    try {
      await calls.cancelSignIn(service, id);
      dispatch({ type: 'cancelled' });
    } catch (cause) {
      dispatch({ type: 'cancel_failed', cause, error: failureText(cause, fallback) });
    }
  };
  const disconnect = async () => {
    dispatch({ type: 'act' });
    try {
      const result = await calls.disconnect(service);
      dispatch({ type: 'disconnected', warning: result.warning });
    } catch (cause) {
      dispatch({ type: 'failed', error: failureText(cause, fallback) });
    }
  };
  const needsReconnect = connection.status === 'needs_reauthorization';
  return (
    <>
      <DialogHeader showCloseButton={closable}>
        <DialogTitle>
          {connected && !flowId ? `${connection.name} connected` : `Connect ${connection.name}`}
        </DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-4 pt-0">
        {flowId ? (
          flow?.status !== 'failed' && (
            <p className="flex items-center gap-2 text-sm">
              <Spinner />
              {flow?.status === 'checking'
                ? `Connecting ${connection.name}…`
                : 'Finish signing in in your browser, then return here.'}
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
          <Button variant="outline" disabled={busy} onClick={() => void cancel(flowId)}>
            Cancel
          </Button>
        ) : (
          <>
            <Button variant="outline" onClick={onBack} disabled={busy}>
              Back
            </Button>
            {connected && (
              <Button variant="ghost" disabled={busy} onClick={() => void disconnect()}>
                Disconnect
              </Button>
            )}
            {(!connected || error) && (
              <Button disabled={busy || !connection.connectable} onClick={() => void start()}>
                Connect {connection.name} <ExternalLink className="size-4" />
              </Button>
            )}
          </>
        )}
      </DialogFooter>
    </>
  );
}
