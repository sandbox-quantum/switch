import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { type Plugin, defineConfig } from "vite";

const DEV_ROLE_ACCOUNTS = fileURLToPath(new URL(".dev-role-accounts.json", import.meta.url));
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** The dev role switcher's logins, written by `just seed-dev-roles`. Served by
 * the dev server alone (`apply: "serve"`), so no build carries the route, and
 * only to this machine, so `vite --host` does not hand them to the network. */
function devRoleAccounts(): Plugin {
  return {
    name: "switch-dev-role-accounts",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__dev/role-accounts", (req, res) => {
        if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) {
          res.statusCode = 403;
          res.end("The dev role accounts are served to this machine only.");
          return;
        }
        readFile(DEV_ROLE_ACCOUNTS, "utf8").then(
          (body) => {
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(body);
          },
          (error: { code?: string; message: string }) => {
            res.statusCode = error.code === "ENOENT" ? 404 : 500;
            res.end(error.message);
          },
        );
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devRoleAccounts()],
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
