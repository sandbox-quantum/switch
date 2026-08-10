import { type IpcMain } from 'electron';

// oxlint-disable-next-line typescript/no-explicit-any
type ProcedureMap = Record<string, (...args: any[]) => unknown>;

export function createRPCController<T extends ProcedureMap>(handlers: T): T {
  return handlers;
}

// Groups multiple controllers under a shared namespace prefix so they can be
// registered as rpc.<group>.<namespace>.<procedure>() at the next level up.
export function createRPCNamespace<T extends Record<string, ProcedureMap>>(controllers: T): T {
  return controllers;
}

// Accepts both flat controllers (ProcedureMap values) and namespace groups
// (Record<string, ProcedureMap> values) at the top level.
// oxlint-disable-next-line typescript/no-explicit-any
type RouterMap = Record<string, Record<string, any>>;

export function createRPCRouter<T extends RouterMap>(routers: T): T {
  return routers;
}

/**
 * Wraps a leaf handler invocation. Every RPC call funnels through here, which
 * makes it the one place able to give the whole call tree beneath it an
 * identity (see the main process's log context) without touching call sites.
 */
export type RPCInvocationWrapper = (
  channel: string,
  args: unknown[],
  invoke: () => unknown
) => unknown;

// Recursively walks the handler tree and registers every leaf function with
// ipcMain at its full dot-joined path (e.g. "git.commit", "git.worktree.commit").
function registerHandlers(
  ipcMain: IpcMain,
  prefix: string,
  value: unknown,
  wrap: RPCInvocationWrapper | undefined
): void {
  if (typeof value === 'function') {
    const handler = value as (...a: unknown[]) => unknown;
    ipcMain.handle(prefix, (_event, ...args: unknown[]) =>
      wrap ? wrap(prefix, args, () => handler(...args)) : handler(...args)
    );
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      registerHandlers(ipcMain, `${prefix}.${key}`, child, wrap);
    }
  }
}

export function registerRPCRouter(
  router: RouterMap,
  ipcMain: IpcMain,
  wrap?: RPCInvocationWrapper
): void {
  for (const [ns, handlers] of Object.entries(router)) {
    registerHandlers(ipcMain, ns, handlers, wrap);
  }
}

// Recursively maps every leaf function to its async client equivalent.
// Non-function values recurse, so both 2-level (rpc.agents.getAgentById) and
// 3-level (rpc.fs.watch.watchSetPaths) shapes are handled by a single type.
type IpcClient<R> = {
  [K in keyof R]: R[K] extends (...args: infer A) => infer Ret
    ? (...args: A) => Promise<Awaited<Ret>>
    : IpcClient<R[K]>;
};

// Returns a callable Proxy that accumulates the dot-joined channel path on each
// property access and calls invoke() when invoked as a function.
// Supports arbitrary nesting depth without any knowledge of the router shape.
function makeChannelProxy(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  parts: string[]
): unknown {
  return new Proxy(
    function (...args: unknown[]) {
      return invoke(parts.join('.'), ...args);
    },
    {
      get(_, key: string) {
        if (typeof key !== 'string' || key === 'then') return undefined;
        return makeChannelProxy(invoke, [...parts, key]);
      },
    }
  );
}

export function createRPCClient<Router extends RouterMap>(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
): IpcClient<Router> {
  return new Proxy(
    {},
    {
      get(_, ns: string) {
        if (typeof ns !== 'string' || ns === 'then') return undefined;
        return makeChannelProxy(invoke, [ns]);
      },
    }
  ) as IpcClient<Router>;
}
