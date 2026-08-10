import { ManagedServerStoppedError } from '@shared/core/managed-switch-server/managed-switch-server';
import { HostUnreachableError } from '@shared/core/remote-hosts/reachability';
import type { RPCInvocationWrapper } from '@shared/lib/ipc/rpc';
import { serializeLogValue, type LogContext } from '@shared/logger';
import { runWithLogContext } from './log-context';
import { log } from './logger';

/**
 * Reads the ids an RPC call already carries in its arguments.
 *
 * Only `sessionId` is looked for: it is the one field the rest of the context
 * can be derived from, and picking it up here means no handler below has to
 * forward it purely so that a log line can mention it.
 */
function rpcLogContext(channel: string, args: unknown[]): LogContext {
  const context: LogContext = { component: `rpc:${channel}` };

  for (const arg of args) {
    if (typeof arg !== 'object' || arg === null) continue;
    const candidate = (arg as Record<string, unknown>).sessionId;
    if (typeof candidate === 'string') {
      context.sessionId = candidate;
      break;
    }
  }

  return context;
}

export const withRPCLogContext: RPCInvocationWrapper = (channel, args, invoke) =>
  runWithLogContext(rpcLogContext(channel, args), () => {
    try {
      const result = invoke();
      // A rejected handler surfaces in the renderer as a failed call with no
      // record of why on this side, so the reason is captured here — the one
      // point every call already passes through.
      if (result instanceof Promise) {
        return result.catch((error: unknown) => {
          logRPCFailure(channel, error);
          throw error;
        });
      }
      return result;
    } catch (error) {
      logRPCFailure(channel, error);
      throw error;
    }
  });

function logRPCFailure(channel: string, error: unknown) {
  // An unreachable host — or a managed stack the user has stopped — is a
  // modeled, displayed state, not a fault of the call: every view scoped to it
  // refuses in the same way, so logging each one as an error buries real
  // failures under a repeating wall of the same fact. The state's own
  // transition is logged once, where it belongs.
  const modeled =
    error instanceof HostUnreachableError || error instanceof ManagedServerStoppedError;
  const level = modeled ? 'debug' : 'error';
  log[level]('RPC handler failed', {
    event: 'rpc_failed',
    component: `rpc:${channel}`,
    error: serializeLogValue(error),
  });
}
