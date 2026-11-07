import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAcpAdapter, type AcpAdapter } from "../acp/acp-adapter";
import type { AcpAdapterOptions, AcpProviderHooks } from "../acp/hooks";
import type { AcpToolCall } from "../acp/protocol";
import { readiness, signInWith } from "../readiness";

export const JUNIE_LOGIN = "junie login";

export const JUNIE_ENV_VARS = [
  "JUNIE_API_KEY",
  "JUNIE_AUTH_TOKEN",
  "JUNIE_TOKEN",
  "JETBRAINS_AI_TOKEN",
  "JUNIE_ANTHROPIC_API_KEY",
  "JUNIE_OPENAI_API_KEY",
  "JUNIE_GOOGLE_API_KEY",
  "JUNIE_GROK_API_KEY",
  "JUNIE_META_API_KEY",
  "JUNIE_OPENROUTER_API_KEY",
  "JUNIE_LITELLM_URL",
  "JUNIE_LITELLM_API_KEY",
  "JUNIE_HOME",
  "JUNIE_MODEL",
  "JUNIE_LLM_PROVIDER",
  "JUNIE_EFFORT",
  "JUNIE_CONFIG_LOCATION",
  "JUNIE_CONFIG_DEFAULT_LOCATIONS",
  "JUNIE_MODEL_LOCATIONS",
  "JUNIE_MODEL_DEFAULT_LOCATIONS",
  "JUNIE_MCP_LOCATIONS",
  "JUNIE_MCP_DEFAULT_LOCATIONS",
  "JUNIE_GUIDELINES_FILENAME",
] as const;

function hasJunieKey(env: Record<string, string>): boolean {
  return Boolean(
    env.JUNIE_API_KEY?.trim() ||
      env.JUNIE_AUTH_TOKEN?.trim() ||
      env.JUNIE_TOKEN?.trim() ||
      env.JETBRAINS_AI_TOKEN?.trim() ||
      env.JUNIE_OPENROUTER_API_KEY?.trim() ||
      env.JUNIE_ANTHROPIC_API_KEY?.trim() ||
      env.JUNIE_OPENAI_API_KEY?.trim() ||
      env.JUNIE_GOOGLE_API_KEY?.trim(),
  );
}

/** Resolves whether local JetBrains / Junie credentials exist on the host. */
export async function hasLocalJunieCredentials(
  env: Record<string, string>,
): Promise<boolean> {
  const home =
    env.JUNIE_HOME?.trim() ||
    env.HOME?.trim() ||
    env.USERPROFILE?.trim() ||
    os.homedir();
  const credentialsFiles = [
    path.join(home, ".junie", "secure_credentials.json"),
    path.join(home, ".junie", "config.json"),
  ];
  for (const file of credentialsFiles) {
    try {
      const stat = await fs.stat(file);
      if (stat.isFile() && stat.size > 0) return true;
    } catch {
      // Ignore file missing or inaccessible
    }
  }
  return false;
}

/** Resolves MCP server from tool call metadata, formatted title, or rawInput. */
export function resolveJunieMcpServer(
  toolCall: AcpToolCall,
): string | undefined {
  const meta = toolCall._meta as
    | { is_mcp_tool_call?: boolean; mcp?: { server?: unknown } }
    | undefined;
  if (meta?.is_mcp_tool_call === true) {
    if (typeof meta.mcp?.server === "string" && meta.mcp.server) {
      return meta.mcp.server;
    }
    if (toolCall.title) {
      const sep = toolCall.title.indexOf("/");
      if (sep > 0 && sep < toolCall.title.length - 1) {
        return toolCall.title.slice(0, sep);
      }
    }
  }
  const raw = toolCall.rawInput as { providerIdentifier?: unknown } | undefined;
  if (typeof raw?.providerIdentifier === "string" && raw.providerIdentifier) {
    return raw.providerIdentifier;
  }
  return undefined;
}

/** JetBrains Junie's `junie --acp=true`. */
export const junieAcp: AcpProviderHooks = {
  provider: "junie",
  label: "Junie",
  defaultBinary: "junie",
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ["--acp=true", "--skip-update-check"],
    env,
    rejectOutputLine: (line) =>
      /not (?:logged|signed) in|log.?in required|sign.?in required|junie login|auth required/i.test(
        line,
      )
        ? "Junie is not signed in. Run `junie login` on the machine."
        : undefined,
  }),
  loginCommand: JUNIE_LOGIN,
  inheritEnv: JUNIE_ENV_VARS,
  checkSignIn: async ({ handshake, env }) => {
    if (hasJunieKey(env)) {
      return readiness(
        "authenticated",
        "Signs in with the configured Junie API key.",
      );
    }
    if (await hasLocalJunieCredentials(env)) {
      return readiness(
        "authenticated",
        "Signed in to Junie with local JetBrains account credentials.",
      );
    }
    try {
      const result = await handshake();
      if (!result.authMethods?.length) {
        return readiness("authenticated", "Signed in to Junie.");
      }
      return readiness(
        "unknown",
        `Junie is ready. Sign in on the execution machine with ${JUNIE_LOGIN} or provide JUNIE_API_KEY.`,
      );
    } catch (error) {
      if (
        /sign.?in|auth(?:entication)? required|unauthenticated|unauthorized|not (?:logged|signed) in/i.test(
          String(error),
        )
      ) {
        return readiness("unauthenticated", signInWith(JUNIE_LOGIN));
      }
      throw error;
    }
  },
  authMethodId: (env) => (hasJunieKey(env) ? undefined : "jetbrains-account"),
  promptCapabilities: { image: true },
  mcpServerOf: resolveJunieMcpServer,
};

export function createJunieAdapter(
  options: AcpAdapterOptions = {},
): AcpAdapter {
  return createAcpAdapter(junieAcp, options);
}
