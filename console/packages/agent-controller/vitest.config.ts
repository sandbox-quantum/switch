import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Box mode runs only on Linux, and its tests lean on Linux process, lock, socket and /proc behaviour.
    exclude:
      process.platform === 'win32'
        ? [...configDefaults.exclude, 'src/box/**', '**/*.box.test.ts']
        : configDefaults.exclude,
    // The loop and relay tests run real servers and timers; leave room for a loaded CI machine.
    testTimeout: 30_000,
  },
});
