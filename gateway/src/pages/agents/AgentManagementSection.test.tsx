import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDetail } from "../../data/api";
import AgentManagementSection from "./AgentManagementSection";

const agent: AgentDetail = {
  id: "a1",
  name: "helper",
  description: "Helps",
  connector_type: "claude_code",
  connection_model: "auto_session",
  tool_count: 0,
  model_count: 0,
  owner_id: "u1",
  owner_name: "ada",
  oauth_client_id: null,
  created_at: "2026-10-01T00:00:00Z",
  parent_agent_id: null,
  known_agent_type: null,
  known_agent_options: null,
  agent_type: "auto_session",
  integration_profile: {},
  tools: [],
  models: [],
  rooms: [],
  sessions: [],
  children: [],
  addressing_policy: null,
  can_manage_agents: false,
};

type Call = { path: string; method: string; body: unknown };

function mockServer({ management }: { management: boolean }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (path === "/gateway/management/controllers")
        return management
          ? new Response("[]", { status: 200 })
          : new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 });
      if (path === "/gateway/agents/a1/can-manage-agents" && method === "PUT")
        return new Response(JSON.stringify({ ...agent, can_manage_agents: true }), {
          status: 200,
        });
      return new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 });
    }),
  );
  return calls;
}

describe("AgentManagementSection", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lets the owner turn on 'can manage agents'", async () => {
    const calls = mockServer({ management: true });
    const onUpdated = vi.fn();
    render(<AgentManagementSection agent={agent} canEdit onUpdated={onUpdated} />);
    const toggle = await screen.findByRole("switch", { name: "Can manage agents" });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    expect(calls.find((c) => c.method === "PUT")).toEqual({
      path: "/gateway/agents/a1/can-manage-agents",
      method: "PUT",
      body: { enabled: true },
    });
  });

  it("shows the setting to anyone else without letting them change it", async () => {
    mockServer({ management: true });
    render(
      <AgentManagementSection
        agent={{ ...agent, can_manage_agents: true }}
        canEdit={false}
        onUpdated={() => {}}
      />,
    );
    const toggle = await screen.findByRole("switch", { name: "Can manage agents" });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    expect((toggle as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/Only the agent's owner can change this/)).toBeTruthy();
  });

  it("is not shown where agent management does not run", async () => {
    const calls = mockServer({ management: false });
    render(<AgentManagementSection agent={agent} canEdit onUpdated={() => {}} />);
    await waitFor(() => expect(calls.length).toBe(1));
    expect(screen.queryByText("Can manage agents")).toBeNull();
  });
});
