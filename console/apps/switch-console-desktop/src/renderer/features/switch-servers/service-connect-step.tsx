import { ExternalLink } from 'lucide-react';
import { useEffect, useReducer, useRef, useState } from 'react';
import {
  allowListHint,
  type ConnectWayName,
  canCloseConnectFlow,
  connectFlowReducer,
  connectWays,
  firstWay,
  initialConnectFlow,
  initialSignInChoices,
  pasteReady,
  SIGN_IN_HINT_AFTER_MS,
  safetyLine,
  signInChoicesReady,
  signInHint,
  signInProgress,
} from '@renderer/features/connectors/connect-flow';
import { ConnectWayList } from '@renderer/features/connectors/connect-way-list';
import { reconnectNote } from '@renderer/features/connectors/connectors-catalog';
import { CreateCredential } from '@renderer/features/connectors/create-credential';
import { LinkedText } from '@renderer/features/connectors/linked-text';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useCloseGuard } from '@renderer/lib/modal/use-close-guard';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Spinner } from '@renderer/lib/ui/spinner';
import type {
  ConnectionCatalogEntry,
  PasteMethodName,
  ServiceKeyField,
} from '@shared/core/switch-servers/connection-catalog';
import type { ServicePaste } from '@shared/core/switch-servers/service-connection';
import type { ServiceCalls } from './service-calls';
import { ServiceKeyFields } from './service-key-step';

/**
 * Connecting a service through Switch's generic sign-in: the browser signs in
 * at the vendor, this Console takes the result back, and Switch keeps the
 * account as soon as it has it. The dialog follows the sign-in and shows the
 * account connected, or why it was not. A service whose sign-in asks for a
 * choice first (a vendor's site) is picked above the button, and the sign-in
 * starts only once each is. GitHub has its own step.
 *
 * A service that also takes a credential pasted in place of the sign-in (a
 * token, or keys) lists every way, the sign-in first, and the person picks one
 * before going on; its paste step asks for the same choices, and Switch checks
 * what is pasted at the vendor before keeping it. Each way says who agents act
 * as, how long what Switch keeps lasts, and who it suits.
 */
export function ServiceConnectStep({
  calls,
  connection,
  reconnecting,
  startOn,
  onBack,
  onConnected,
}: {
  calls: ServiceCalls;
  connection: ConnectionCatalogEntry;
  /** Opened to sign in again, so it offers a new sign-in even while one is connected. */
  reconnecting: boolean;
  /** The paste step to open on, to paste a new credential the way it was; null for the sign-in. */
  startOn: PasteMethodName | null;
  onBack: () => void;
  /** Moves on once the account is connected, with the warning Switch gave. */
  onConnected?: (warning: string | null) => void;
}) {
  const service = connection.slug;
  const name = connection.name;
  const [state, dispatch] = useReducer(
    connectFlowReducer,
    { connected: connection.status === 'connected' && !reconnecting, pasting: startOn },
    initialConnectFlow
  );
  const { connected, pasting, flowId, flow, busy, warning, error } = state;
  const closable = canCloseConnectFlow(state);
  const allowHint = allowListHint(state, name);
  const [picked, setPicked] = useState(() => initialSignInChoices(connection));
  const choices = signInChoicesReady(connection.sign_in_choices, picked);
  const pasteMethod =
    pasting === null ? null : (connection.paste.find((way) => way.method === pasting) ?? null);
  const [values, setValues] = useState<Record<string, string>>({});
  const ready = pasteMethod === null ? null : pasteReady(pasteMethod, values, choices);
  // What a connection pasted here, or before, reaches; null for a sign-in.
  const [pastedReach, setPastedReach] = useState(
    connection.status === 'connected' && connection.method !== 'oauth'
      ? connection.access_note
      : null
  );
  const offersConnect = !connected || error !== null;
  const ways = connectWays(connection);
  const [way, setWay] = useState<ConnectWayName>(firstWay(ways, startOn ?? 'sign_in'));
  const choosing = ways.length > 1;
  useCloseGuard(!closable);
  // Callers build their calls as they render; polling follows the flow, not them.
  const callsRef = useRef(calls);
  callsRef.current = calls;
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;
  // The flow whose browser has been away long enough for the hint.
  const [slowFlowId, setSlowFlowId] = useState<string | null>(null);
  useEffect(() => {
    if (!flowId) return;
    const timer = setTimeout(() => setSlowFlowId(flowId), SIGN_IN_HINT_AFTER_MS);
    return () => clearTimeout(timer);
  }, [flowId]);
  useEffect(() => {
    if (!flowId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await callsRef.current.getSignIn(service, flowId);
        if (!alive) return;
        if (result.status === 'connected') {
          setPastedReach(null);
          onConnectedRef.current?.(result.warning);
          dispatch({ type: 'connected', warning: result.warning });
          return;
        }
        dispatch({
          type: 'polled',
          flow: result,
          failure: `Signing in to ${name} failed. Cancel and try again.`,
        });
        if (result.status !== 'failed') timer = setTimeout(() => void poll(), 2000);
      } catch (cause) {
        if (alive)
          dispatch({
            type: 'poll_failed',
            error: failureText(cause, `Could not check the ${name} sign-in.`),
          });
      }
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [service, flowId, name]);
  const fallback = `Could not update the ${name} connection.`;
  const start = async (startWith: Record<string, string>) => {
    dispatch({ type: 'act' });
    try {
      const started = await calls.startSignIn(service, startWith);
      dispatch({ type: 'started', flowId: started.id, callbackUrl: started.callbackUrl });
    } catch (cause) {
      dispatch({ type: 'failed', error: failureText(cause, fallback) });
    }
  };
  const paste = async (body: ServicePaste, reach: string) => {
    dispatch({ type: 'act' });
    // What was pasted is never kept here once it is sent.
    setValues({});
    try {
      const result = await calls.connectWithPaste(service, body);
      setPastedReach(reach);
      onConnectedRef.current?.(result.warning);
      dispatch({ type: 'connected', warning: result.warning });
    } catch (cause) {
      dispatch({ type: 'failed', error: failureText(cause, `Could not connect ${name}.`) });
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
      setPastedReach(null);
      dispatch({ type: 'disconnected', warning: result.warning });
    } catch (cause) {
      dispatch({ type: 'failed', error: failureText(cause, fallback) });
    }
  };
  const progress = signInProgress(flow, connection.name);
  const hint = flowId && slowFlowId === flowId ? signInHint(flow, connection.name) : null;
  const needsReconnect = connection.status === 'needs_reauthorization';
  const pickers = (
    <SignInChoicePickers
      service={service}
      fields={connection.sign_in_choices}
      picked={picked}
      busy={busy}
      onPick={(field, value) => setPicked((current) => ({ ...current, [field]: value }))}
    />
  );
  const showsPaste = offersConnect && !flowId && pasteMethod !== null;
  return (
    <>
      <DialogHeader showCloseButton={closable}>
        <DialogTitle>{connected && !flowId ? `${name} connected` : `Connect ${name}`}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-4 pt-0">
        {flowId ? (
          progress !== null && (
            <>
              <p className="flex items-center gap-2 text-sm">
                <Spinner />
                {progress}
              </p>
              {allowHint && (
                <p className="text-xs text-foreground-muted">
                  {allowHint.text}{' '}
                  <span className="font-mono break-all select-all">{allowHint.url}</span>
                </p>
              )}
              {hint && <p className="text-sm text-foreground-muted">{hint}</p>}
            </>
          )
        ) : showsPaste && pasteMethod ? (
          <>
            <p className="text-sm text-foreground-muted">
              {pasteMethod.method === 'token'
                ? `Paste a token you made in ${name}. Switch checks it at ${name}, stores it encrypted, and never shows it again.`
                : `Paste keys you made in ${name}. Switch checks them at ${name}, stores them encrypted, and never shows them again.`}
            </p>
            {pickers}
            <CreateCredential name={name} method={pasteMethod} busy={busy} />
            <ServiceKeyFields
              service={service}
              name={name}
              label={`${name} ${pasteMethod.label}`}
              fields={pasteMethod.fields}
              values={values}
              busy={busy}
              helpUrl={pasteMethod.create_url ? null : pasteMethod.help_url}
              helpText={
                pasteMethod.method === 'token'
                  ? `How to make a token in ${name}`
                  : `How to make keys in ${name}`
              }
              onChange={(field, next) => setValues((current) => ({ ...current, [field]: next }))}
            />
            <p className="text-xs text-foreground-muted">{pasteMethod.access_note}</p>
            <p className="text-xs text-foreground-muted">{safetyLine(connection, pasteMethod)}</p>
          </>
        ) : (
          <>
            <p className="text-sm text-foreground-muted">{connection.description}</p>
            {connection.agent_access_note && (
              <p className="text-sm text-foreground-muted">{connection.agent_access_note}</p>
            )}
            {(connected || !choosing) && (
              <p className="text-sm text-foreground-muted">
                {connected
                  ? pastedReach
                    ? `Agents you turn ${name} on for use what you pasted. ${pastedReach}`
                    : `Agents you turn ${name} on for act as you there, with what you allowed when you signed in.`
                  : `You sign in at ${name}, and allow what Switch asks for. Agents you then turn ${name} on for act as you there.`}
              </p>
            )}
            {needsReconnect && !connected && (
              <p className="text-sm text-destructive">
                {connection.reconnect_reason ??
                  `Switch can no longer use your ${name} sign-in. Connect again.`}
              </p>
            )}
            {reconnecting && !connected && (
              <p className="text-sm text-foreground-muted">{reconnectNote(connection)}</p>
            )}
            {connected && (
              <p className="text-xs text-foreground-muted">
                {pastedReach
                  ? `Disconnecting removes what you pasted from Switch, and every agent's access to ${name}.`
                  : `Disconnecting removes the sign-in Switch keeps, and every agent's access to ${name}.`}
              </p>
            )}
            {offersConnect && pickers}
            {offersConnect && choosing && (
              <ConnectWayList service={name} ways={ways} picked={way} busy={busy} onPick={setWay} />
            )}
          </>
        )}
        {connection.unavailable_reason && (
          <p className="text-sm text-foreground-muted">{connection.unavailable_reason}</p>
        )}
        {warning && (
          <p role="status" className="rounded-md border p-3 text-sm text-foreground-muted">
            <LinkedText text={warning} />
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
        ) : showsPaste && pasteMethod ? (
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setValues({});
                dispatch({ type: 'paste', method: null });
              }}
            >
              Back
            </Button>
            <Button
              disabled={busy || !connection.connectable || ready === null}
              onClick={() => {
                if (ready !== null) void paste(ready, pasteMethod.access_note);
              }}
            >
              Connect {name}
            </Button>
          </>
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
            {offersConnect && way !== 'sign_in' && (
              <Button
                disabled={busy}
                onClick={() => {
                  setValues({});
                  dispatch({ type: 'paste', method: way });
                }}
              >
                Continue
              </Button>
            )}
            {offersConnect && way === 'sign_in' && (
              <Button
                disabled={busy || !connection.connectable || choices === null}
                onClick={() => {
                  if (choices !== null) void start(choices);
                }}
              >
                Connect {name} <ExternalLink className="size-4" />
              </Button>
            )}
          </>
        )}
      </DialogFooter>
    </>
  );
}

/**
 * What a sign-in asks the person to pick first (a vendor's site), each from
 * its list; a credential pasted in its place is pasted for the same picks.
 */
function SignInChoicePickers({
  service,
  fields,
  picked,
  busy,
  onPick,
}: {
  service: string;
  fields: ServiceKeyField[] | null;
  picked: Record<string, string>;
  busy: boolean;
  onPick: (field: string, value: string) => void;
}) {
  return (fields ?? []).map((field) => {
    const id = `service-sign-in-${service}-${field.name}`;
    const value = picked[field.name] ?? '';
    return (
      <div key={field.name} className="space-y-1">
        <label htmlFor={id} className="block text-sm font-medium">
          {field.label}
        </label>
        <Select
          value={value || null}
          disabled={busy}
          onValueChange={(next) => onPick(field.name, next ?? '')}
        >
          <SelectTrigger id={id} aria-label={field.label} className="w-full">
            <SelectValue placeholder={`Choose a ${field.label.toLowerCase()}`}>
              {value || undefined}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(field.choices ?? []).map((choice) => (
              <SelectItem key={choice} value={choice}>
                {choice}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {field.help && <p className="text-xs text-foreground-muted">{field.help}</p>}
      </div>
    );
  });
}
