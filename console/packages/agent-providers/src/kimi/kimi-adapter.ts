import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAcpAdapter, type AcpAdapter } from "../acp/acp-adapter";
import type { AcpAdapterOptions, AcpProviderHooks } from "../acp/hooks";
import { readiness, signInWith } from "../readiness";

export const KIMI_LOGIN = "kimi login";

const API_KEY_VARS = ["KIMI_API_KEY", "MOONSHOT_API_KEY"] as const;

function apiKeyGiven(env: Record<string, string>): boolean {
  return API_KEY_VARS.some((name) => env[name]?.trim());
}

/** Kimi Code's home directory: `$KIMI_CODE_HOME`, or `~/.kimi-code` when unset. */
export function kimiHome(env: Record<string, string>): string {
  return env.KIMI_CODE_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".kimi-code");
}

/**
 * Whether the profile under `home` holds a login credential. `kimi login`
 * (a device-code flow) writes one JSON file per credential into
 * `<home>/credentials`, each holding the OAuth tokens. A file that parses
 * and carries a token is a completed sign-in. Reading files is all this
 * does: it never starts a login.
 */
export async function kimiSignedIn(home: string): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(join(home, "credentials"));
  } catch {
    return false;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const data = JSON.parse(await readFile(join(home, "credentials", name), "utf8")) as Record<
        string,
        unknown
      >;
      if (data.access_token || data.refresh_token || data.id_token) return true;
    } catch {
      // A half-written or unrelated file in the directory is not a sign-in.
    }
  }
  return false;
}

/** Kimi Code's `kimi acp`: Moonshot's coding CLI speaking ACP over stdio. */
export const kimiAcp: AcpProviderHooks = {
  provider: "kimi",
  label: "Kimi Code",
  defaultBinary: "kimi",
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: ["acp"], env }),
  loginCommand: KIMI_LOGIN,
  inheritEnv: [...API_KEY_VARS],
  checkSignIn: async ({ handshake, env }) => {
    if (apiKeyGiven(env))
      return readiness("authenticated", "Signs in with the API key it was given.");
    // The credential store is read before the handshake: a signed-in Kimi
    // may keep advertising its login method (Antigravity does), and the
    // stored token is the surer answer either way.
    if (await kimiSignedIn(kimiHome(env)))
      return readiness("authenticated", "Signed in to Kimi Code.");
    try {
      const init = await handshake();
      // A signed-out Kimi (checked against 2.4.1) advertises exactly one
      // thing here: its terminal login.
      return init.authMethods?.length
        ? readiness("unauthenticated", signInWith(KIMI_LOGIN))
        : readiness("authenticated", "Signed in to Kimi Code.");
    } catch (error) {
      if (/sign in|auth required|unauthenticated/i.test(String(error)))
        return readiness("unauthenticated", signInWith(KIMI_LOGIN));
      throw error;
    }
  },
  // Kimi's one auth method is the terminal login its ACP server names in
  // `initialize` (`kimi acp --login` runs `kimi login`). An API key signs
  // the CLI in without it, so no method is sent then.
  authMethodId: (env) => (apiKeyGiven(env) ? undefined : "login"),
  promptCapabilities: { image: true, embeddedContext: true },
  // Kimi's session modes are permission levels (session/new on 2.4.1):
  // `default` asks before everything, `yolo` runs the routine and asks for
  // the risky, `auto` never asks. `plan` is a workflow, not a permission
  // level, so no runtime mode selects it.
  sessionMode: (runtimeMode) => {
    switch (runtimeMode) {
      case "full-access":
        return "auto";
      case "auto-accept-edits":
      case "auto":
        return "yolo";
      case "approval-required":
        return "default";
    }
  },
};

export function createKimiAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(kimiAcp, options);
}
