# Renderer Patterns

All paths are relative to `apps/switch-console-desktop/`.

## Modal System

All modals use a registry-based system. Only one modal can be active at a time.

- `src/renderer/app/modal-registry.ts` — central registry mapping modal IDs to components
  (`createModal`, `modalRegistry`)
- `src/renderer/lib/modal/modal-provider.tsx` — React context managing active modal state
  (`useModalContext`, `showModal`, `BaseModalProps`)
- `src/renderer/lib/modal/modal-renderer.tsx` — renders the currently active modal
- `src/renderer/lib/modal/modal-store.ts` — modal state store
- `src/renderer/lib/modal/use-close-guard.ts` — close-guard hook

**Adding a modal:**
1. Create the component accepting `BaseModalProps<TResult>` (provides `onSuccess` and `onClose` callbacks)
2. Register it in `src/renderer/app/modal-registry.ts`
3. Open it via the hook:

```tsx
const { showModal } = useModalContext();
showModal('myModal', { locationId: '123', onSuccess: (result) => {...} });
```

**Rules:**
- All modals must be registered in `src/renderer/app/modal-registry.ts`
- `showModal` is type-safe — TypeScript infers required args from the registry
- `hasActiveCloseGuard` prevents dismissal during critical operations

## View System

Views use a registry + parameterized navigation pattern.

- `src/renderer/app/view-registry.ts` — view definitions (required `MainPanel`, optional
  `WrapView` and `TitlebarSlot`) plus navigation guards (`setupNavigationGuards`)
- `src/renderer/lib/layout/` — `provider.tsx`, `navigation-provider.tsx` (navigation and
  param persistence), `layout-provider.tsx` (panel collapse/expand/drag state),
  `panel-drag-store.ts`

**Key behaviors:**
- `navigate(viewId, params?)` (from `useNavigate`) is type-safe; params are optional when all fields are optional
- Params persist per-view (navigating away and back preserves params)
- `updateViewParams(viewId, partial)` updates params without re-navigating

**Rules:**
- Views are singletons — one per ViewId
- Add new views to `src/renderer/app/view-registry.ts`

## SDK transcripts

Session views live in `src/renderer/features/sessions/components/transcript/`.
Render persisted SDK events and expose only capabilities reported by the
connected provider. Keep reconnect, stop, interrupt and recovery distinct.
A component remount must never resubmit a user action or initial prompt.

## React Query Context Pattern

Context providers use React Query for data fetching with optimistic updates:

```tsx
// Pattern used in AppSettingsProvider, ProjectProvider, etc.
const { data } = useQuery({ queryKey: ['resource'], queryFn: () => rpc.ns.get() });
const mutation = useMutation({
  mutationFn: (args) => rpc.ns.update(args),
  onMutate: async (args) => {
    // optimistic update via queryClient.setQueryData
  },
  onError: () => {
    // rollback via queryClient.setQueryData with previous snapshot
  },
});
```

**Rules:**
- Contexts combine React Query + local state, not standalone useState
- Use `useAppSettingsKey(key)` for fine-grained per-setting hooks
- Optimistic updates must include rollback on error

## State Outside React

For state that must survive React unmounts or be shared across unrelated components:

- **`useSyncExternalStore`-compatible stores** — e.g., `panelDragStore` in `src/renderer/lib/layout/`
- **Cross-feature stores** — `src/renderer/lib/stores/` (navigation, dependencies, resource monitor, ...)
- **MobX session and location stores** — `src/renderer/features/sessions/stores/` and
  `src/renderer/features/locations/stores/`; access them through selectors
  (`session-selectors.ts`, `location-selectors.ts`) and session view hooks, never directly
