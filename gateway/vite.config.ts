import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist" },
  server: {
    proxy: {
      "/gateway": {
        target: "http://127.0.0.1:8000",
        // Keep the browser's Host, as the gateway container's nginx does:
        // switch-core starts a sign-in on the callback's host when the request
        // names another, so a rewritten Host costs every sign-in a redirect.
        changeOrigin: false,
      },
    },
  },
});
