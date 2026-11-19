import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The loop and relay tests run real servers and timers; leave room for a loaded CI machine.
    testTimeout: 30_000,
  },
});
