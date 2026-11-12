/* The Vite dev server's side of the dev role switcher (`src/dev/`): it hands
 * the switcher the logins `just seed-dev-roles` wrote. A plugin rather than
 * something bundled, so the logins never become part of the page's code, and
 * `apply: "serve"`, so no build carries the route at all.
 */
import { readFile } from "node:fs/promises";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Answers with `file`'s contents, to this machine only, so `vite --host`
 * does not hand the logins to the network; 404 while it does not exist. */
export function serveDevRoleAccounts(file) {
  return async (req, res) => {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) {
      res.statusCode = 403;
      res.end("The dev role accounts are served to this machine only.");
      return;
    }
    let body;
    try {
      body = await readFile(file, "utf8");
    } catch (error) {
      res.statusCode = error.code === "ENOENT" ? 404 : 500;
      res.end(error.message);
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(body);
  };
}

export function devRoleAccounts(file) {
  return {
    name: "switch-dev-role-accounts",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__dev/role-accounts", serveDevRoleAccounts(file));
    },
  };
}
