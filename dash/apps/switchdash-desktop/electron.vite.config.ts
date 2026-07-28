import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    root: 'src/main',
    envDir: resolve('.'),
    // Externalize node deps (the electron-vite default) EXCEPT glob: the packaged
    // app otherwise resolves an externalized `glob` against a stale transitive
    // copy in the asar (v7, missing fs.realpath) instead of the declared v13.
    // Bundling glob inlines the correct version, matching `dev`.
    plugins: [externalizeDepsPlugin({ exclude: ['glob'] })],
    resolve: {
      alias: {
        '@': resolve('src'),
        '@main': resolve('src/main'),
        '@shared': resolve('src/shared'),
        '@root': resolve('.'),
      },
    },
  },
  preload: {
    root: 'src/preload',
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@root': resolve('.'),
      },
    },
    build: {
      rollupOptions: {
        input: {
          // The app's own preload, attached to the main window.
          index: resolve('src/preload/index.ts'),
          // Guest preload for the embedded Mattermost webview. Built as a
          // separate entry so it can be attached per-webview rather than to
          // the app window.
          'mattermost-guest': resolve('src/preload/mattermost-guest.ts'),
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': resolve('src'),
        '@renderer': resolve('src/renderer'),
        '@shared': resolve('src/shared'),
        '@root': resolve('.'),
        // cli-agent-plugins metadata/icons chunks transitively reference node:buffer
        // (through hook-config helpers bundled in the same tsdown chunk), even though
        // those helpers never run in the renderer. Alias to the browser-safe polyfill.
        'node:buffer': 'buffer',
      },
    },
    server: {
      port: 3000,
    },
  },
});
