import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDetail } from "../../data/api";
import MidTurnDeliverySection from "./MidTurnDeliverySection";

const agent: AgentDetail = {
  id: "a1",
  name: "helper",
  display_name: null,
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
  mid_turn_delivery: "steer",
  can_manage: true,
  can_rename: true,
  can_edit_options: true,
  can_transfer: true,
  transfer_blocked_reason: null,
  can_change_manage_agents: true,
  can_grant_services: true,
};

type Call = { path: string; method: string; body: unknown };

function mockServer(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        path,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (path === "/gateway/agents/a1/mid-turn-delivery" && method === "PUT")
        return new Response(
          JSON.stringify({ ...agent, mid_turn_delivery: "queue" }),
          {
            status: 200,
          },
        );
      return new Response(JSON.stringify({ detail: "Not Found" }), {
        status: 404,
      });
    }),
  );
  return calls;
}

describe("MidTurnDeliverySection", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lets whoever manages the agent switch it to always queue", async () => {
    const calls = mockServer();
    const onUpdated = vi.fn();
    render(
      <MidTurnDeliverySection agent={agent} canEdit onUpdated={onUpdated} />,
    );
    const toggle = await screen.findByRole("switch", {
      name: "Steer into the running turn",
    });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    expect(calls.find((c) => c.method === "PUT")).toEqual({
      path: "/gateway/agents/a1/mid-turn-delivery",
      method: "PUT",
      body: { mid_turn_delivery: "queue" },
    });
  });

  it("shows the setting to anyone else without letting them change it", async () => {
    mockServer();
    render(
      <MidTurnDeliverySection
        agent={{ ...agent, mid_turn_delivery: "queue" }}
        canEdit={false}
        onUpdated={() => {}}
      />,
    );
    const toggle = await screen.findByRole("switch", {
      name: "Steer into the running turn",
    });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect((toggle as HTMLInputElement).disabled).toBe(true);
    expect(
      screen.getByText(/Only the agent's owner or a workspace admin/),
    ).toBeTruthy();
  });

  it("says how a steered message is read, Claude Code's timing included", async () => {
    mockServer();
    render(
      <MidTurnDeliverySection agent={agent} canEdit onUpdated={() => {}} />,
    );
    expect(
      await screen.findByText(
        /Claude Code after the tool call or answer in progress/,
      ),
    ).toBeTruthy();
  });

  it("is not shown by a server that predates the setting", () => {
    const calls = mockServer();
    const { mid_turn_delivery: _, ...older } = agent;
    render(
      <MidTurnDeliverySection agent={older} canEdit onUpdated={() => {}} />,
    );
    expect(screen.queryByText("Steer into the running turn")).toBeNull();
    expect(calls).toEqual([]);
  });
});
