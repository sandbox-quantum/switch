import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { checkAcpSignIn } from "../acp/acp-adapter";
import { readiness } from "../readiness";
import { describeConformance, echoMcpServerSpec } from "../testing/index";
import { createJunieAdapter, junieAcp } from "./junie-acp";

const binaryPath = process.env.JUNIE_BINARY ?? "junie";
const env: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  USER: process.env.USER ?? "",
  USERPROFILE: process.env.USERPROFILE ?? "",
  ...Object.fromEntries(
    (junieAcp.inheritEnv ?? [])
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]!]),
  ),
};

const unavailableReason = async () => {
  const probe = spawnSync(binaryPath, ["--version"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (probe.error || probe.status !== 0)
    return "the junie binary is not on PATH";
  const state = await checkAcpSignIn(junieAcp, {
    binaryPath,
    cwd: process.cwd(),
    env,
  });
  if (state.status !== "authenticated") {
    return state.message;
  }
  return null;
};

describeConformance("junie", {
  createAdapter: async () => createJunieAdapter({ binaryPath }),
  unavailableReason,
  mcpServers: { echo: echoMcpServerSpec() },
  env,
  ...(process.env.JUNIE_TIMEOUT_MS
    ? { timeoutMs: Number(process.env.JUNIE_TIMEOUT_MS) }
    : {}),
  ...(process.env.JUNIE_MODEL
    ? { model: { id: process.env.JUNIE_MODEL } }
    : {}),
});

it("advertises the HTTP MCP transport required by Switch room tools", async (ctx) => {
  if (await unavailableReason())
    return ctx.skip("Junie CLI unavailable or not signed in");
  const cwd = await mkdtemp(join(tmpdir(), "junie-http-"));
  try {
    await checkAcpSignIn(
      {
        ...junieAcp,
        checkSignIn: async ({ handshake }) => {
          const metadata = await handshake();
          expect(metadata.agentCapabilities?.mcpCapabilities?.http).toBe(true);
          return readiness("unknown", "Metadata check only");
        },
      },
      { binaryPath, cwd, env },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 30_000);
