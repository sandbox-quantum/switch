// Plain object, not `defineConfig`: importing vitest/config here would pull vite's types into this package's
// typecheck. These two globs are vitest's own default exclude.
const defaultExclude = ['**/node_modules/**', '**/.git/**'];

export default {
  test: {
    // Box mode runs only on Linux, and its tests lean on Linux process, lock, socket and /proc behaviour.
    exclude:
      process.platform === 'win32'
        ? [...defaultExclude, 'src/host/box/**', '**/*.box.test.ts']
        : defaultExclude,
  },
};
