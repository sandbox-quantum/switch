import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSummary, RoomAutoRoute, RoomDetail } from "../../data/api";
import RoomAutoRouteSection from "./RoomAutoRouteSection";

const NO_BACKEND =
  "Auto-route needs a decision service. A workspace admin can set one up in Switch Console → Admin → Decision routing.";

function agent(id: string, name: string): AgentSummary {
  return {
    id,
    name,
    display_name: null,
    description: "",
    connector_type: "claude_code",
    connection_model: "auto_session",
    tool_count: 0,
    model_count: 0,
    owner_id: "u1",
    owner_name: "ada",
    oauth_client_id: null,
    created_at: "2026-10-01T00:00:00Z",
    parent_agent_id: null,
    known_agent_type: "claude-code",
    known_agent_options: null,
  };
}

const room = {
  id: "r1",
  name: "support",
  agent_ids: ["a1", "a2"],
} as RoomDetail;

const AGENTS = [agent("a1", "deploy-bot"), agent("a2", "triage-bot"), agent("a3", "elsewhere")];

type Call = { path: string; method: string; body: unknown };

function mockServer(answer: (body: Record<string, unknown>) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path, method, body });
      if (path === "/gateway/agents") return new Response(JSON.stringify(AGENTS));
      if (path === "/gateway/rooms/r1/auto-route" && method === "PUT") return answer(body);
      return new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 });
    }),
  );
  return calls;
}

function toggle(): HTMLInputElement {
  return screen.getByRole("switch") as HTMLInputElement;
}

function routed(state: RoomAutoRoute): Response {
  return new Response(JSON.stringify(state));
}

const OFF: RoomAutoRoute = { on: false, available: true, reason: null, fallback_agent: null };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RoomAutoRouteSection", () => {
  it("turns auto-route on, and shows on only once the server says so", async () => {
    const calls = mockServer((body) => routed({ ...OFF, on: body.on as boolean }));
    render(<RoomAutoRouteSection room={room} autoRoute={OFF} canManage />);

    expect(toggle().checked).toBe(false);
    screen.getByText("Off");
    fireEvent.click(toggle());

    await waitFor(() => expect(toggle().checked).toBe(true));
    screen.getByText("On");
    expect(calls.filter((c) => c.method === "PUT")).toEqual([
      { path: "/gateway/rooms/r1/auto-route", method: "PUT", body: { on: true } },
    ]);
  });

  it("turns auto-route off", async () => {
    const calls = mockServer((body) => routed({ ...OFF, on: body.on as boolean }));
    render(<RoomAutoRouteSection room={room} autoRoute={{ ...OFF, on: true }} canManage />);

    fireEvent.click(toggle());

    await waitFor(() => expect(toggle().checked).toBe(false));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ on: false });
  });

  it("leaves the toggle as it was and says why when the server refuses", async () => {
    mockServer(
      () => new Response(JSON.stringify({ detail: "Only a room admin can change this." }), { status: 403 }),
    );
    render(<RoomAutoRouteSection room={room} autoRoute={OFF} canManage />);

    fireEvent.click(toggle());

    await screen.findByText("Only a room admin can change this.");
    expect(toggle().checked).toBe(false);
  });

  it("shows unavailable with the server's reason and cannot be turned on", () => {
    mockServer(() => routed(OFF));
    render(
      <RoomAutoRouteSection
        room={room}
        autoRoute={{ ...OFF, available: false, reason: NO_BACKEND }}
        canManage
      />,
    );

    screen.getByText(NO_BACKEND);
    expect(toggle().disabled).toBe(true);
  });

  it("can still be turned off where it is unavailable", () => {
    mockServer(() => routed(OFF));
    render(
      <RoomAutoRouteSection
        room={room}
        autoRoute={{ on: true, available: false, reason: NO_BACKEND, fallback_agent: null }}
        canManage
      />,
    );

    expect(toggle().disabled).toBe(false);
  });

  it("is read-only for someone who neither owns the room nor administers the workspace", () => {
    mockServer(() => routed(OFF));
    render(<RoomAutoRouteSection room={room} autoRoute={OFF} canManage={false} />);

    expect(toggle().disabled).toBe(true);
    expect(screen.getByText("Only the room's owner or a workspace admin can change auto-route.")).toBeTruthy();
  });

  it("offers the room's own agents as triage agent and saves the pick", async () => {
    const calls = mockServer((body) =>
      routed({ ...OFF, fallback_agent: body.fallback_agent as string | null }),
    );
    render(<RoomAutoRouteSection room={room} autoRoute={OFF} canManage />);

    const select = screen.getByRole("combobox", {
      name: "Triage agent while auto-route is unavailable",
    });
    fireEvent.mouseDown(select);
    const listbox = await screen.findByRole("listbox");
    await within(listbox).findByRole("option", { name: "triage-bot" });
    expect(within(listbox).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "None",
      "deploy-bot",
      "triage-bot",
    ]);
    fireEvent.click(within(listbox).getByRole("option", { name: "triage-bot" }));

    await waitFor(() => expect(select.textContent).toContain("triage-bot"));
    // Saved by id, the way the room's setting names its triage agent.
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ fallback_agent: "a2" });
  });

  it("clears the triage agent with None", async () => {
    const calls = mockServer(() => routed(OFF));
    render(
      <RoomAutoRouteSection room={room} autoRoute={{ ...OFF, fallback_agent: "a2" }} canManage />,
    );

    const select = screen.getByRole("combobox", {
      name: "Triage agent while auto-route is unavailable",
    });
    await waitFor(() => expect(select.textContent).toContain("triage-bot"));
    fireEvent.mouseDown(select);
    fireEvent.click(within(await screen.findByRole("listbox")).getByRole("option", { name: "None" }));

    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ fallback_agent: null }));
    await waitFor(() => expect(select.textContent).not.toContain("triage-bot"));
  });

  it("still names a triage agent that has left the room", async () => {
    mockServer(() => routed(OFF));
    render(
      <RoomAutoRouteSection room={room} autoRoute={{ ...OFF, fallback_agent: "a3" }} canManage />,
    );

    const select = screen.getByRole("combobox", {
      name: "Triage agent while auto-route is unavailable",
    });
    await waitFor(() => expect(select.textContent).toContain("elsewhere"));
  });

  it("names a departed triage agent by the name the server gives", async () => {
    mockServer(() => routed(OFF));
    render(
      <RoomAutoRouteSection
        room={room}
        autoRoute={{ ...OFF, fallback_agent: "gone-id", fallback_agent_name: "old-triage" }}
        canManage
      />,
    );

    const select = screen.getByRole("combobox", {
      name: "Triage agent while auto-route is unavailable",
    });
    await waitFor(() => expect(select.textContent).toContain("old-triage"));
  });
});
