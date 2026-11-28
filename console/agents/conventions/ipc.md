# IPC Conventions

## RPC Pattern

The primary IPC mechanism is a typed RPC system:

- **Controllers**: `src/main/core/*/controller.ts` — define handler functions using `createRPCController`.
- **Router**: `src/main/rpc.ts` — assembles all controllers into a typed router using `createRPCRouter`.
- **Registration**: `registerRPCRouter(router, ipcMain)` in `src/main/index.ts` — auto-registers `namespace.method` channels.
- **Client**: `src/renderer/lib/ipc.ts` — creates a proxy-based typed client using `createRPCClient<RpcRouter>`.

```ts
// Main — src/main/core/example/controller.ts
import { createRPCController } from '@shared/ipc/rpc';
export const exampleController = createRPCController({
  async doSomething(id: string) {
    return await service.doSomething(id);
  },
});

// Renderer — call via typed client
import { rpc } from '@renderer/lib/ipc';
const result = await rpc.example.doSomething('123');
```

## Preload Bridge

The preload bridge in `src/preload/index.ts` is intentionally tiny. It exposes only
`invoke` (for the RPC client), `eventSend`/`eventOn` (for the typed event emitter), and
`getPathForFile` on `window.electronAPI`. Add direct `window.electronAPI` surface only
when a browser/Electron primitive cannot fit the RPC/event path.

`invoke` reaches only the channels `registerRPCRouter` registered: the preload asks main
for them once over `RPC_CHANNELS_CHANNEL` (`rpcChannels`, the same walk that registers
them) and refuses anything else (`src/preload/rpc-invoke.ts`). A handler added with a
bare `ipcMain.handle` is therefore unreachable from the renderer — register it through
a controller.

`eventSend` and `eventOn` reach only the channels of events the app defines — an event's
name, or the name with a topic (`name.topic`) — and throw on anything else
(`src/preload/event-bridge.ts`). The preload builds that set itself, at load, from the
event modules (`src/shared/lib/ipc/event-channels.ts`), so an `ipcMain.on` listener on a
channel that is not an app event is unreachable from the renderer.

## Event System

Typed events use `createEventEmitter` from `src/shared/lib/ipc/events.ts`. Event type
definitions live in `src/shared/events/`, with domain events colocated under
`src/shared/core/<domain>/`. Define an event with `defineEvent` and a string literal name,
in a module named `*Events.ts` or `*-events.ts` under `src/shared/`: those are the modules
the preload loads to learn the app's event channels, and `event-channels.test.ts` fails on
an event defined anywhere else. A channel the renderer passes to `eventSend` directly
(the renderer log) is an event's `.name` too.

## Rules

- Prefer the RPC pattern for new IPC methods — add a handler to the appropriate controller.
- Keep the preload bridge small; do not add manual IPC channels casually.
- Keep the RPC router type (`RpcRouter`) importable by the renderer for type inference.
- Prefer existing service boundaries over adding logic directly inside controllers.
- Update tests when controller shape or IPC wiring changes.
