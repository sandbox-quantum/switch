import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { CHAT_UI_SRC, chatUiResolve } from "./scripts/chat-ui.mjs";
import { devRoleAccounts } from "./scripts/dev-role-accounts.mjs";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    devRoleAccounts(new URL(".dev-role-accounts.json", import.meta.url)),
  ],
  resolve: chatUiResolve,
  build: { outDir: "dist" },
  server: {
    fs: { allow: [".", CHAT_UI_SRC] },
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
