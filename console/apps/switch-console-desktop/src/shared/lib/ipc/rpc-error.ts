/**
 * Carrying a thrown handler error across the IPC boundary without losing it.
 *
 * Left to Electron, a rejected `ipcMain.handle` reaches the renderer as a bare
 * `Error` whose message has been rewritten to
 * `Error invoking remote method '<channel>': <message>` — the app's own routing
 * table, quoted at the user — and with every field but `message` dropped. That
 * second half is the expensive one: `GatewayError` knows whether a call failed
 * because the session expired, because the server answered 500, or because the
 * network never reached it, and all three arrived in the renderer as the same
 * flat string, so no view could tell them apart.
 *
 * A handler failure is therefore returned as a value rather than thrown, and
 * rebuilt into an {@link RpcError} on the far side. The channel name stays out
 * of the message, and a discriminator plus the error's own scalar fields
 * survive the trip.
 */

/** Marks a resolved IPC value as a handler failure rather than a result. */
const RPC_ERROR_MARKER = '__switchConsoleRpcError';

export type SerializedRpcError = {
  [RPC_ERROR_MARKER]: true;
  /**
   * Stable discriminator — the thrown error's class name (`GatewayError`,
   * `HostUnreachableError`, …), or `Error` for anything unremarkable. This is
   * what a view branches on instead of matching substrings of `message`.
   */
  code: string;
  message: string;
  /** The error's own enumerable fields, when they survive serialization. */
  data?: Record<string, unknown>;
};

/**
 * A handler failure, rebuilt in the renderer.
 *
 * `message` is what the main process actually threw — no channel name, no
 * wrapping. Anything more specific lives on `code` and `data`.
 */
export class RpcError extends Error {
  readonly code: string;
  readonly data: Record<string, unknown>;

  constructor(serialized: SerializedRpcError) {
    super(serialized.message);
    this.name = 'RpcError';
    this.code = serialized.code;
    this.data = serialized.data ?? {};
  }

  /** A field carried over from the original error, when it is a string. */
  stringField(key: string): string | undefined {
    const value = this.data[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  /** A field carried over from the original error, when it is a number. */
  numberField(key: string): number | undefined {
    const value = this.data[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
}

/**
 * The error's own enumerable fields, minus anything that cannot cross the
 * structured-clone boundary.
 *
 * A JSON round-trip is the filter: it is exactly the set of values Electron can
 * carry, and it drops functions, symbols and cycles without having to enumerate
 * what those might be. Fields are copied wholesale rather than from an
 * allowlist, so a new modeled error arrives in the renderer intact without
 * anyone remembering to register it here.
 */
function serializableFields(error: object): Record<string, unknown> | undefined {
  const own: Record<string, unknown> = {};
  for (const key of Object.keys(error)) {
    if (key === 'stack' || key === 'message' || key === 'name') continue;
    own[key] = (error as Record<string, unknown>)[key];
  }
  if (Object.keys(own).length === 0) return undefined;
  try {
    const round = JSON.parse(JSON.stringify(own)) as Record<string, unknown>;
    return Object.keys(round).length > 0 ? round : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Turn a thrown handler error into a value the renderer can rebuild.
 *
 * The message is trimmed: several main-process messages interpolate captured
 * command output, which arrives with the trailing newline still attached and
 * reads as a stray space before whatever punctuation follows it.
 */
export function serializeRpcError(error: unknown): SerializedRpcError {
  if (error instanceof Error) {
    return {
      [RPC_ERROR_MARKER]: true,
      code: error.name || 'Error',
      message: error.message.trim(),
      data: serializableFields(error),
    };
  }
  return {
    [RPC_ERROR_MARKER]: true,
    code: 'Error',
    message: String(error).trim(),
  };
}

export function isSerializedRpcError(value: unknown): value is SerializedRpcError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[RPC_ERROR_MARKER] === true &&
    typeof (value as SerializedRpcError).message === 'string'
  );
}
