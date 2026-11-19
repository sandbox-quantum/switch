import type {
  ConnectionCatalogEntry,
  PasteMethodName,
  ServiceKeyField,
  ServicePasteMethod,
} from '@shared/core/switch-servers/connection-catalog';
import type { ServiceFlow, ServicePaste } from '@shared/core/switch-servers/service-connection';
import { RpcError } from '@shared/lib/ipc/rpc-error';

/**
 * A service sign-in as the dialog holds it: the paste step open in place of
 * the sign-in, if any, the flow Switch is running for the sign-in, if any,
 * the server's callback where the browser returns through it, and what the
 * person is shown.
 */
export type ConnectFlowState = {
  connected: boolean;
  /** The method whose paste step is open; null while the dialog shows the sign-in. */
  pasting: PasteMethodName | null;
  flowId: string | null;
  flow: ServiceFlow | null;
  callbackUrl: string | null;
  busy: boolean;
  warning: string | null;
  error: string | null;
};

export type ConnectFlowEvent =
  /** An action begins: start, cancel, paste or disconnect. */
  | { type: 'act' }
  /** The paste step opens for `method`, or, for null, the sign-in shows again. */
  | { type: 'paste'; method: PasteMethodName | null }
  | { type: 'started'; flowId: string; callbackUrl: string | null }
  /** The flow is still under way, or failed; `failure` is what to say if it failed without saying why. */
  | { type: 'polled'; flow: ServiceFlow; failure: string }
  | { type: 'poll_failed'; error: string }
  /** The server kept the connection, signed in or pasted; the flow is over. */
  | { type: 'connected'; warning: string | null }
  | { type: 'cancelled' }
  | { type: 'cancel_failed'; cause: unknown; error: string }
  | { type: 'disconnected'; warning: string | null }
  /** Starting or disconnecting failed; nothing about a flow changes. */
  | { type: 'failed'; error: string };

/**
 * Where the dialog opens: on the sign-in, or on the paste step for a method
 * (to paste a new token in place of one the service refused).
 */
export function initialConnectFlow(start: {
  connected: boolean;
  pasting: PasteMethodName | null;
}): ConnectFlowState {
  return {
    connected: start.connected,
    pasting: start.pasting,
    flowId: null,
    flow: null,
    callbackUrl: null,
    busy: false,
    warning: null,
    error: null,
  };
}

const NO_FLOW = { flowId: null, flow: null, callbackUrl: null } as const;

/**
 * The sign-in's state after `event`. A flow that failed keeps its id, so the
 * person can cancel it and start over with the reason still showing. A cancel
 * the server answers with 410 found the flow already gone, which is what
 * cancelling wanted.
 */
export function connectFlowReducer(
  state: ConnectFlowState,
  event: ConnectFlowEvent
): ConnectFlowState {
  switch (event.type) {
    case 'act':
      return { ...state, busy: true, error: null };
    case 'paste':
      return { ...state, pasting: event.method, error: null, warning: null };
    case 'started':
      return {
        ...state,
        busy: false,
        flowId: event.flowId,
        flow: null,
        callbackUrl: event.callbackUrl,
        warning: null,
      };
    case 'polled':
      return {
        ...state,
        flow: event.flow,
        error: event.flow.status === 'failed' ? (event.flow.error ?? event.failure) : state.error,
      };
    case 'poll_failed':
      return { ...state, ...NO_FLOW, error: event.error };
    case 'connected':
      return {
        ...state,
        ...NO_FLOW,
        busy: false,
        connected: true,
        pasting: null,
        warning: event.warning,
      };
    case 'cancelled':
      return { ...state, ...NO_FLOW, busy: false, error: null };
    case 'cancel_failed':
      return isGone(event.cause)
        ? { ...state, ...NO_FLOW, busy: false, error: null }
        : { ...state, busy: false, error: event.error };
    case 'disconnected':
      return { ...state, busy: false, connected: false, warning: event.warning };
    case 'failed':
      return { ...state, busy: false, error: event.error };
  }
}

/**
 * What the dialog says under its spinner while a sign-in that returns through
 * the server waits on the browser: a vendor may refuse the server's callback
 * until its admin allow-lists it, and then shows its own error page, which
 * never reaches Switch. Null where the sign-in returns straight to this
 * Console, and once the browser is back or the sign-in failed.
 */
export function allowListHint(
  state: Pick<ConnectFlowState, 'callbackUrl' | 'flow'>,
  name: string
): { text: string; url: string } | null {
  if (state.callbackUrl === null) return null;
  if (state.flow?.status === 'checking' || state.flow?.status === 'failed') return null;
  return {
    text: `If ${name} shows an error, an admin must allow-list this URL at ${name}.`,
    url: state.callbackUrl,
  };
}

/**
 * What the dialog's pickers start on, for a service whose sign-in asks for a
 * choice first (a vendor's site): the person's connection's own, where the
 * service still offers it, so connecting again goes back to the same site;
 * otherwise nothing is picked.
 */
export function initialSignInChoices(
  connection: Pick<ConnectionCatalogEntry, 'sign_in_choices' | 'choices'>
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const field of connection.sign_in_choices ?? []) {
    const value = connection.choices?.[field.name];
    if (value !== undefined && field.choices?.includes(value)) picked[field.name] = value;
  }
  return picked;
}

/**
 * What a sign-in starts with: one value from each field's list, or null while
 * any is not picked, which keeps the dialog from starting it. Empty for a
 * service that asks for nothing.
 */
export function signInChoicesReady(
  fields: ServiceKeyField[] | null,
  picked: Record<string, string>
): Record<string, string> | null {
  const ready: Record<string, string> = {};
  for (const field of fields ?? []) {
    const value = picked[field.name];
    if (value === undefined || !field.choices?.includes(value)) return null;
    ready[field.name] = value;
  }
  return ready;
}

/**
 * The links under the sign-in that open the paste step in its place, one for
 * each credential the server lets the service take pasted.
 */
export function pasteLinks(
  paste: ServicePasteMethod[]
): { method: PasteMethodName; text: string }[] {
  return paste.map(({ method }) => ({
    method,
    text: method === 'token' ? 'Use a token instead' : 'Use API keys instead',
  }));
}

/**
 * The one short line under each way to connect, on how long what Switch
 * keeps lasts: a sign-in's token, which Switch refreshes; a token the person
 * made, which its vendor ends on the date they set; keys, which only the
 * vendor can revoke. Null for a sign-in whose token's lifetime the server
 * does not say.
 */
export function safetyLine(
  connection: Pick<ConnectionCatalogEntry, 'name' | 'token_lifetime'>,
  way: Pick<ServicePasteMethod, 'expires'> | 'sign_in'
): string | null {
  if (way === 'sign_in')
    return connection.token_lifetime === null
      ? null
      : `Expires: ${lifetimeText(connection.token_lifetime)}, refreshed by Switch`;
  return pastedLasts(connection.name, way.expires);
}

function pastedLasts(name: string, expires: ServicePasteMethod['expires']): string {
  return expires === 'vendor'
    ? `Expires: on the date you set in ${name}`
    : `Never expires; only ${name} can revoke it`;
}

/** A lifetime in seconds as people say it: in minutes, hours or days. */
export function lifetimeText(seconds: number): string {
  if (seconds < 3600) return plural(Math.round(seconds / 60), 'minute');
  if (seconds < 86_400) return plural(Math.round(seconds / 3600), 'hour');
  return plural(Math.round(seconds / 86_400), 'day');
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/**
 * What a connection made with a credential pasted in place of a sign-in
 * reaches, said in place of an access level, the way it was pasted, and how
 * long it lasts; null for a sign-in, a service connected with a key form,
 * and no connection. A method the server no longer offers here (keys that
 * never expire, where it no longer allows them) is still named.
 */
export function pastedConnection(
  connection: Pick<
    ConnectionCatalogEntry,
    'name' | 'auth_type' | 'method' | 'paste' | 'access_note'
  >
): { reach: string; way: string; lasts: string } | null {
  const method = connection.method;
  if (connection.auth_type !== 'oauth' || connection.access_note === null) return null;
  if (method !== 'token' && method !== 'keys') return null;
  const offered = connection.paste.find((way) => way.method === method);
  const expires = offered?.expires ?? (method === 'keys' ? 'never' : 'vendor');
  return {
    reach: connection.access_note,
    way: offered?.label ?? (method === 'token' ? 'Pasted token' : 'Pasted keys'),
    lasts: pastedLasts(connection.name, expires),
  };
}

/**
 * What a paste sends: each of the method's fields, trimmed, and what was
 * picked for the sign-in's choices; null while a field is empty or a choice
 * is not picked (`choices` null), which keeps the dialog from sending it.
 */
export function pasteReady(
  method: ServicePasteMethod,
  values: Record<string, string>,
  choices: Record<string, string> | null
): ServicePaste | null {
  if (choices === null) return null;
  const fields: Record<string, string> = {};
  for (const field of method.fields) {
    const value = (values[field.name] ?? '').trim();
    if (value === '') return null;
    fields[field.name] = value;
  }
  return { method: method.method, fields, choices };
}

/**
 * The method to paste a new credential with, for a connection whose pasted
 * one the service refused (`token_refused`): its own, where the server still
 * offers it; null otherwise, and for any other connection.
 */
export function pasteAgainMethod(
  connection: Pick<ConnectionCatalogEntry, 'reconnect_code' | 'method' | 'paste'>
): PasteMethodName | null {
  if (connection.reconnect_code !== 'token_refused') return null;
  return connection.paste.find((offered) => offered.method === connection.method)?.method ?? null;
}

/**
 * Whether the dialog may close: never mid-call, and not while a sign-in is
 * under way unless an error is showing, so a refusal can never strand it.
 */
export function canCloseConnectFlow(state: ConnectFlowState): boolean {
  return !state.busy && (state.flowId === null || state.error !== null);
}

/**
 * What the dialog says while a sign-in is under way; null once it failed,
 * when the error is what the person reads.
 */
export function signInProgress(flow: ServiceFlow | null, name: string): string | null {
  if (flow?.status === 'failed') return null;
  if (flow?.status === 'checking') return `Connecting ${name}…`;
  return 'Finish signing in in your browser, then return here.';
}

/** How long the browser may be away before the dialog suggests what to check. */
export const SIGN_IN_HINT_AFTER_MS = 60_000;

/**
 * What to check when the browser has not come back: a vendor that refuses the
 * sign-in shows its own error page and never sends the browser back.
 */
export function signInHint(flow: ServiceFlow | null, name: string): string | null {
  if (flow !== null && flow.status !== 'pending') return null;
  return `If ${name} showed an error, cancel, and ask the person who set up ${name} for Switch to check its redirect URI and scopes.`;
}

function isGone(cause: unknown): boolean {
  return cause instanceof RpcError && cause.numberField('status') === 410;
}
