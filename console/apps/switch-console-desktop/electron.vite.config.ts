import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    root: 'src/main',
    envDir: resolve('.'),
    plugins: [externalizeDepsPlugin({ exclude: ['@switch-console/chat-ui'] })],
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
      // Per-instance so two dev builds from different worktrees can run at
      // once; the main process follows through ELECTRON_RENDERER_URL.
      port: Number(process.env.SWITCH_CONSOLE_RENDERER_PORT) || 3000,
      // The bundled Switch expert template is read from `switch-expert/` at
      // the repository root, outside this app's directory, so the dev server
      // has to be allowed to serve it; the production build inlines it.
      fs: { allow: [resolve('../../..')] },
    },
  },
});
