import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CloudAgentDialog, { BOX_POLL_MS, NOT_A_BOX } from "./CloudAgentDialog";

type Call = { url: string; method: string; body: unknown };

const BOX = {
  machine_id: "m-1",
  state: "provisioning",
  desired_state: "running",
  stop_reason: null,
  sleeping: false,
  revision: 3,
  controller_id: "box-ctl",
  backend: "box",
  agents: [],
  error: null,
  error_code: null,
  room: null,
  awake: null,
  ai_calls_today: null,
};

const controller = (over: Record<string, unknown>) => ({
  id: "box-ctl",
  name: "Switch cloud",
  description: null,
  kind: "ec2",
  platform: null,
  version: null,
  state: "offline",
  last_seen_at: null,
  connection: null,
  status: null,
  release: null,
  assignment_revision: 1,
  created_at: "2026-11-05T00:00:00Z",
  revoked_at: null,
  ...over,
});

let calls: Call[];
let boxOnline: boolean;
let backend: string;
let ensureAnswer: { status: number; body: unknown };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  calls = [];
  boxOnline = false;
  backend = "box";
  ensureAnswer = { status: 200, body: BOX };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/gateway/hosted-machines/ensure") return json(ensureAnswer.status, ensureAnswer.body);
    if (url === "/gateway/hosted-machines")
      return json(200, {
        available: true,
        machines: [{ ...BOX, backend, state: boxOnline ? "ready" : "provisioning" }],
      });
    if (url === "/gateway/management/controllers")
      return json(200, [
        // The person's own computer, labelled like a cloud machine: never chosen.
        controller({ id: "my-mac", name: "My Mac", kind: "ec2", state: "online" }),
        controller({ state: boxOnline ? "online" : "offline" }),
      ]);
    if (url === "/gateway/management/providers")
      return json(200, {
        providers: [
          { id: "cursor", label: "Cursor", advanced_fields: [] },
          { id: "claude", label: "Claude", advanced_fields: [] },
        ],
      });
    if (url === "/gateway/management/agents" && method === "POST")
      return json(201, { agent_id: "a-1", name: "web-frontend" });
    return json(404, {});
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fill() {
  fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "web-frontend" } });
  fireEvent.change(screen.getByLabelText(/Description/), { target: { value: "Builds the site" } });
}

describe("Add agent on Switch cloud", () => {
  it("asks for the box once, waits until its own controller is online, then creates the agent there", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onCreated = vi.fn();
    render(<CloudAgentDialog open onClose={() => {}} onCreated={onCreated} />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Starting your Switch cloud/));
    fill();
    const create = screen.getByRole("button", { name: "Create" });
    expect((create as HTMLButtonElement).disabled).toBe(true);

    boxOnline = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOX_POLL_MS + 10);
    });
    await waitFor(() => expect(screen.getByText("Your Switch cloud is ready.")).toBeTruthy());
    expect(calls.filter((c) => c.url.endsWith("/ensure"))).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const post = calls.find((c) => c.url === "/gateway/management/agents" && c.method === "POST")!;
    expect(post.body).toMatchObject({
      name: "web-frontend",
      controller_id: "box-ctl",
      definition: { provider: "claude", isolation: "isolated" },
    });
  });

  it("says a stopped box is stopped, and creates nothing", async () => {
    ensureAnswer = { status: 200, body: { ...BOX, state: "stopped", desired_state: "stopped", stop_reason: "owner" } };
    render(<CloudAgentDialog open onClose={() => {}} onCreated={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Your Switch cloud is stopped/)).toBeTruthy());
    fill();
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/agents"))).toBe(false);
  });

  it("shows Switch's own words when it can't give a box, and creates nothing", async () => {
    ensureAnswer = { status: 503, body: { detail: "Switch cloud isn't offered here." } };
    render(<CloudAgentDialog open onClose={() => {}} onCreated={() => {}} />);
    await waitFor(() => expect(screen.getByText("Switch cloud isn't offered here.")).toBeTruthy());
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers only the providers a box takes a login for", async () => {
    render(<CloudAgentDialog open onClose={() => {}} onCreated={() => {}} />);
    fireEvent.mouseDown(await screen.findByLabelText(/Provider/));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual(["Claude"]);
  });

  it("never creates on a v1 cloud machine", async () => {
    backend = "vm";
    ensureAnswer = { status: 200, body: { ...BOX, backend: "vm", state: "ready" } };
    boxOnline = true;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<CloudAgentDialog open onClose={() => {}} onCreated={() => {}} />);
    await waitFor(() => expect(screen.getByText(NOT_A_BOX)).toBeTruthy());
    fill();
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
    // It stops there: no more looking at the machine or its controllers.
    const looked = calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOX_POLL_MS * 3);
    });
    expect(calls.length).toBe(looked);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/agents"))).toBe(false);
  });

  it("asks nothing while closed", () => {
    render(<CloudAgentDialog open={false} onClose={() => {}} onCreated={() => {}} />);
    expect(calls).toEqual([]);
  });
});
