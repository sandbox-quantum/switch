import type * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAppServer } from "../codex/fake-app-server";
import type { ProviderRuntimeEvent } from "../events";

let mockStatResult: { isFile: () => boolean; size: number } | null = null;

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
  stat: async (path: string) => {
    if (mockStatResult) return mockStatResult;
    throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
  },
}));

vi.mock("node:child_process", () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways("initialize", () => ({
      agentCapabilities: {
        sessionCapabilities: { resume: {} },
        mcpCapabilities: { http: true },
      },
    }));
    server.replyAlways("authenticate", () => ({}));
    server.replyAlways("session/new", () => ({
      sessionId: "native",
      configOptions: [
        {
          id: "model",
          type: "select",
          options: [{ value: "gpt-4o", name: "GPT-4o" }],
        },
      ],
    }));
    server.replyAlways("session/resume", () => ({}));
    server.replyAlways("session/set_mode", () => ({}));
    server.replyAlways("session/set_config_option", () => ({}));
    servers.push(server);
    return server;
  },
}));

const servers: FakeAppServer[] = [];
const { junieAcp, createJunieAdapter, JUNIE_LOGIN, resolveJunieMcpServer } =
  await import("./junie-acp");

beforeEach(() => {
  servers.length = 0;
  mockStatResult = null;
});
afterEach(() => {
  for (const server of servers) server.kill();
});

describe("junieAcp", () => {
  it("has the correct provider id, label, default binary, and login command", () => {
    expect(junieAcp.provider).toBe("junie");
    expect(junieAcp.label).toBe("Junie");
    expect(junieAcp.defaultBinary).toBe("junie");
    expect(junieAcp.loginCommand).toBe(JUNIE_LOGIN);
  });

  it("declares the expected capabilities", () => {
    expect(junieAcp.capabilities).toEqual({
      modelSwitchInSession: true,
      steering: false,
      resume: true,
      approvals: true,
      userInput: false,
    });
  });

  it("declares image prompt capabilities", () => {
    expect(junieAcp.promptCapabilities).toEqual({ image: true });
  });

  it("inherits documented Junie configuration and key environment variables", () => {
    expect(junieAcp.inheritEnv).toContain("JUNIE_API_KEY");
    expect(junieAcp.inheritEnv).toContain("JUNIE_AUTH_TOKEN");
    expect(junieAcp.inheritEnv).toContain("JETBRAINS_AI_TOKEN");
    expect(junieAcp.inheritEnv).toContain("JUNIE_OPENROUTER_API_KEY");
    expect(junieAcp.inheritEnv).toContain("JUNIE_HOME");
    expect(junieAcp.inheritEnv).toContain("JUNIE_MODEL");
  });

  it("launches with junie --acp=true and --skip-update-check", async () => {
    const launch = await Promise.resolve(
      junieAcp.launch({
        binaryPath: "/path/to/junie",
        cwd: "/work",
        env: { PATH: "/bin" },
      }),
    );
    expect(launch.command).toBe("/path/to/junie");
    expect(launch.args).toEqual(["--acp=true", "--skip-update-check"]);
    expect(launch.env).toEqual({ PATH: "/bin" });
  });

  it("rejects output lines signaling missing sign-in", async () => {
    const launch = await Promise.resolve(
      junieAcp.launch({ binaryPath: "junie", cwd: "/work", env: {} }),
    );
    expect(launch.rejectOutputLine?.("Please log in with junie login")).toMatch(
      /Junie is not signed in/,
    );
    expect(
      launch.rejectOutputLine?.("Auth required: please authenticate"),
    ).toMatch(/Junie is not signed in/);
    expect(
      launch.rejectOutputLine?.("Starting Junie ACP server..."),
    ).toBeUndefined();
  });

  describe("checkSignIn", () => {
    it("reports authenticated when JUNIE_API_KEY is provided in env", async () => {
      const handshake = vi.fn();
      const result = await junieAcp.checkSignIn?.({
        binaryPath: "junie",
        cwd: "/work",
        env: { JUNIE_API_KEY: "token-123" },
        handshake,
      });
      expect(result?.status).toBe("authenticated");
      expect(result?.message).toContain("configured Junie API key");
      expect(handshake).not.toHaveBeenCalled();
    });

    it("reports authenticated when alternative tokens are provided in env", async () => {
      const handshake = vi.fn();
      const resAuth = await junieAcp.checkSignIn?.({
        binaryPath: "junie",
        cwd: "/work",
        env: { JUNIE_AUTH_TOKEN: "token-456" },
        handshake,
      });
      expect(resAuth?.status).toBe("authenticated");

      const resJb = await junieAcp.checkSignIn?.({
        binaryPath: "junie",
        cwd: "/work",
        env: { JETBRAINS_AI_TOKEN: "jb-789" },
        handshake,
      });
      expect(resJb?.status).toBe("authenticated");
    });

    it("reports authenticated when local credentials file exists on disk", async () => {
      mockStatResult = { isFile: () => true, size: 256 };
      const handshake = vi.fn();
      const result = await junieAcp.checkSignIn?.({
        binaryPath: "junie",
        cwd: "/work",
        env: {},
        handshake,
      });
      expect(result?.status).toBe("authenticated");
      expect(result?.message).toContain("local JetBrains account credentials");
      expect(handshake).not.toHaveBeenCalled();
    });

    it("reports unknown with guidance when handshake returns authMethods and no credentials", async () => {
      const handshake = vi.fn().mockResolvedValue({
        authMethods: [{ id: "jetbrains-account", name: "JetBrains Account" }],
      });
      const result = await junieAcp.checkSignIn?.({
        binaryPath: "junie",
        cwd: "/work",
        env: {},
        handshake,
      });
      expect(result?.status).toBe("unknown");
      expect(result?.message).toContain(JUNIE_LOGIN);
      expect(result?.message).toContain("JUNIE_API_KEY");
    });

    it("reports authenticated when handshake succeeds with no authMethods", async () => {
      const handshake = vi.fn().mockResolvedValue({
        authMethods: [],
      });
      const result = await junieAcp.checkSignIn?.({
        binaryPath: "junie",
        cwd: "/work",
        env: {},
        handshake,
      });
      expect(result?.status).toBe("authenticated");
      expect(result?.message).toContain("Signed in to Junie.");
    });

    it("reports unauthenticated when handshake throws an authentication error", async () => {
      const handshake = vi
        .fn()
        .mockRejectedValue(new Error("Authentication required"));
      const result = await junieAcp.checkSignIn?.({
        binaryPath: "junie",
        cwd: "/work",
        env: {},
        handshake,
      });
      expect(result?.status).toBe("unauthenticated");
      expect(result?.message).toContain(JUNIE_LOGIN);
    });

    it("propagates unrelated errors from handshake", async () => {
      const handshake = vi
        .fn()
        .mockRejectedValue(new Error("Connection refused"));
      await expect(
        junieAcp.checkSignIn?.({
          binaryPath: "junie",
          cwd: "/work",
          env: {},
          handshake,
        }),
      ).rejects.toThrow("Connection refused");
    });
  });

  describe("authMethodId", () => {
    it("returns undefined when an API key is configured", () => {
      expect(
        junieAcp.authMethodId?.({ JUNIE_API_KEY: "test-key" }),
      ).toBeUndefined();
      expect(
        junieAcp.authMethodId?.({ JUNIE_OPENROUTER_API_KEY: "or-key" }),
      ).toBeUndefined();
    });

    it("returns jetbrains-account when no API key is provided", () => {
      expect(junieAcp.authMethodId?.({})).toBe("jetbrains-account");
    });
  });

  describe("mcpServerOf", () => {
    it("resolves MCP server from _meta.mcp.server", () => {
      expect(
        resolveJunieMcpServer({
          toolCallId: "call-1",
          title: "some_tool",
          _meta: { is_mcp_tool_call: true, mcp: { server: "github" } },
        }),
      ).toBe("github");
    });

    it("resolves MCP server from title prefix server/tool", () => {
      expect(
        resolveJunieMcpServer({
          toolCallId: "call-2",
          title: "echo/switch_echo",
          _meta: { is_mcp_tool_call: true },
        }),
      ).toBe("echo");
    });

    it("resolves MCP server from rawInput.providerIdentifier", () => {
      expect(
        resolveJunieMcpServer({
          toolCallId: "call-3",
          title: "tool",
          rawInput: { providerIdentifier: "switch" },
        }),
      ).toBe("switch");
    });

    it("returns undefined when tool call is not an MCP call", () => {
      expect(
        resolveJunieMcpServer({
          toolCallId: "call-4",
          title: "bash",
        }),
      ).toBeUndefined();
    });
  });

  it("starts a session and resumes the native session id", async () => {
    const adapter = createJunieAdapter();
    const events: ProviderRuntimeEvent[] = [];
    adapter.subscribe((e) => events.push(e));
    const session = await adapter.startSession({
      sessionId: "s",
      cwd: "/work",
      runtimeMode: "approval-required",
      env: {},
      mcpServers: {
        switch: {
          transport: "stdio",
          command: "node",
          args: ["server.js"],
          env: {},
        },
      },
      connectorMcpServers: [],
      resume: { nativeSessionId: "native" },
    });
    expect(session.nativeSessionId).toBe("native");
    const server = servers.at(-1)!;
    const resumeMsg = server.received.find(
      (m) => m.method === "session/resume",
    );
    expect(resumeMsg?.params).toMatchObject({ sessionId: "native" });
  });
});
