# Main Process Patterns

## Controller Pattern

Each domain in `src/main/core/` exposes a `controller.ts` that defines RPC handlers:

```ts
// src/main/core/sessions/controller.ts
import { createRPCController } from '@shared/ipc/rpc';
import { createSession } from './createSession';
import { getSessions } from './getSessions';

export const sessionController = createRPCController({
  createSession,
  getSessions,
  deleteSession,
  // ...
});
```

Controllers are assembled into the router in `src/main/rpc.ts`:

```ts
export const rpcRouter = createRPCRouter({
  sessions: sessionController,
  locations: locationsController,
  // ...
});
```

**Rules:**
- Controller handlers are imported functions — keep logic in separate operation files, not inline
- Each controller becomes an RPC namespace (e.g., `rpc.sessions.createSession(...)` on the renderer)
- New domains need their controller added to `src/main/rpc.ts`


## Service Pattern

For stateful concerns, use singleton classes:

```ts
export class AppService {
  private cache = new Map();

  async initialize() { /* ... */ }
  async doSomething(id: string) { /* ... */ }
}

export const appService = new AppService();
```

**Rules:**
- Module-level singleton export
- Initialization method called from `src/main/index.ts`
- Services hold long-lived state (caches, subscriptions, connections)

## Provider Pattern

Some domains expose a provider interface with a single local backend, leaving room for
additional backends without changing call sites:

```
src/main/core/locations/
├── location-provider.ts           # Interface
├── create-location-provider.ts    # Factory
└── location-manager.ts            # Orchestrates the provider
```

Used in: locations, filesystem (`fs/impl/local-fs.ts`), terminals (`terminals/impl/local-terminal-provider.ts`).

**Switch Console is not local-only, and this is the pattern that carries the difference.**
An agent runs either locally or on an SSH host, so the backend behind an interface is a
real choice rather than a placeholder for one:

- `execution-context` has `local-execution-context.ts` **and** `ssh-execution-context.ts`
- `agent-runtime/impl/` has `local-agent-runtime.ts` **and** `ssh-agent-runtime.ts`
- `dependencies` has local detection **and** `remote-dependency-manager.ts` /
  `ssh-install-runner.ts`

`fs` and `terminals` do currently have only a local implementation. When adding a backend,
check whether the remote path needs one too — and see the sidecar section of `AGENTS.md`,
because a remote session is served by `src/sidecar/`, which is a second implementation that
will not follow your change automatically.

## Result Type (`@switch-console/shared`)

Explicit error handling via discriminated union. The type lives in the shared workspace
package (`packages/shared/src/result.ts`), not in `src/main/lib/`:

```ts
import { ok, err, type Result } from '@switch-console/shared';

async function doSomething(): Promise<Result<Data, SomeError>> {
  if (problem) return err({ type: 'not_found' as const });
  return ok(data);
}
```

**Rules:**
- Prefer `Result<T, E>` over thrown exceptions for expected failure modes
- Controllers convert Result types to IPC-compatible responses

## Event System (`src/main/lib/events.ts`)

Topic-based event emitter for main ↔ renderer communication:

```ts
import { events } from '../lib/events';

// Emit to a specific topic (e.g., session ID)
events.emit(ptyDataChannel, buffer, sessionId);

// Listen on a specific topic
const unsub = events.on(ptyDataChannel, (data) => {...}, sessionId);
```

Channel naming: without topic → `eventName`, with topic → `eventName.{topic}`

Event type definitions live in `src/shared/events/`.
