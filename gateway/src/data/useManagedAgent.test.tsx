import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useManagedAgent } from "./useManagedAgent";

function respond(status: number, body: unknown) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useManagedAgent", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("picks the agent from /gateway/management/agents, never asking for it by id", async () => {
    const fetch = respond(200, [{
      agent_id: "agent-1",
      name: "test-agent",
      display_name: null,
      icon_url: null,
      description: "Test agent",
      controller_id: "controller-1",
      controller_name: "My Machine",
      controller_kind: "console",
      controller_state: "online",
      desired_state: "running",
      revision: 1,
      definition: {
        provider: "claude",
        model: null,
        instructions: "",
        auto_mode: false,
        auto_approve: false,
        directory: null,
        isolation: "shared",
        advanced_config: {},
      },
      status: null,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      can_edit: true,
      can_delete: true,
    }]);

    const { result } = renderHook(() => useManagedAgent("agent-1"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "/gateway/management/agents",
      expect.objectContaining({
        method: "GET",
        credentials: "include",
      }),
    );
    expect(result.current.data).toMatchObject({
      agent_id: "agent-1",
      name: "test-agent",
    });
  });

  it("is null for an agent Switch does not run", async () => {
    respond(200, [{ agent_id: "agent-2" }]);

    const { result } = renderHook(() => useManagedAgent("agent-1"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it("propagates fetch errors instead of returning null", async () => {
    respond(500, { error: { code: "internal_error", message: "Server error" } });

    const { result } = renderHook(() => useManagedAgent("agent-1"), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});
