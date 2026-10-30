import type { ServiceFlow } from '@shared/core/switch-servers/service-connection';
import { RpcError } from '@shared/lib/ipc/rpc-error';

/**
 * A service sign-in as the dialog holds it: the flow Switch is running for
 * it, if any, the server's callback where the browser returns through it, and
 * what the person is shown.
 */
export type ConnectFlowState = {
  connected: boolean;
  flowId: string | null;
  flow: ServiceFlow | null;
  callbackUrl: string | null;
  busy: boolean;
  warning: string | null;
  error: string | null;
};

export type ConnectFlowEvent =
  /** An action begins: start, cancel or disconnect. */
  | { type: 'act' }
  | { type: 'started'; flowId: string; callbackUrl: string | null }
  /** The flow is still under way, or failed; `failure` is what to say if it failed without saying why. */
  | { type: 'polled'; flow: ServiceFlow; failure: string }
  | { type: 'poll_failed'; error: string }
  /** The server kept the connection; the flow is over. */
  | { type: 'connected'; warning: string | null }
  | { type: 'cancelled' }
  | { type: 'cancel_failed'; cause: unknown; error: string }
  | { type: 'disconnected'; warning: string | null }
  /** Starting or disconnecting failed; nothing about a flow changes. */
  | { type: 'failed'; error: string };

export function initialConnectFlow(connected: boolean): ConnectFlowState {
  return {
    connected,
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
      return { ...state, ...NO_FLOW, busy: false, connected: true, warning: event.warning };
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
 * Whether the dialog may close: never mid-call, and not while a sign-in is
 * under way unless an error is showing, so a refusal can never strand it.
 */
export function canCloseConnectFlow(state: ConnectFlowState): boolean {
  return !state.busy && (state.flowId === null || state.error !== null);
}

function isGone(cause: unknown): boolean {
  return cause instanceof RpcError && cause.numberField('status') === 410;
}
