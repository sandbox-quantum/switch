/**
 * Installs the preload bridge before any browser test module is evaluated.
 *
 * `renderer/lib/ipc.ts` reads `window.electronAPI.invoke` at module scope, so
 * importing renderer code without a bridge throws on the import itself. Supplying
 * it here, rather than from a test's `beforeAll`, is what allows those imports to
 * stay static.
 *
 * They have to. A runtime `await import()` of app code is the first thing to pull
 * in the renderer's dependency tree, so Vite re-optimizes deps in the middle of
 * the run; modules loaded either side of that boundary resolve through different
 * `?v=` hashes and React is instantiated twice. react-dom then renders with one
 * copy while the component reads hooks from the other, whose dispatcher was never
 * installed — every hook call dies on `Cannot read properties of null`. A warm
 * cache hides it and CI, always cold, does not (CHOO-1430).
 */
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    invoke: async () => undefined,
    eventSend: () => {},
    eventOn: () => () => {},
  },
});
