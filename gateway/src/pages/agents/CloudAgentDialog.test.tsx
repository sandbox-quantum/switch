import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPERATION_POLL_MS } from "../../data/cloudLogins";
import CloudAgentDialog, { BOX_POLL_MS, CREATE_REFUSED, LOGIN_FIRST, NOT_A_BOX } from "./CloudAgentDialog";

// The login dialog itself is tested on its own: here a stand-in "gives" the
// login (the box then lists it) and tells the form it's done.
vi.mock("./cloud/CloudLoginDialog", () => ({
  default: ({ open, provider, onDone, onClose }: { open: boolean; provider: string; onDone: () => void; onClose: () => void }) =>
    open ? (
      <div data-testid="login-dialog">
        {provider}
        <button
          onClick={() => {
            boxLogins = [{ provider, revision: 1, key_id: "k", updated_at: "2026-11-06T00:00:00Z" }];
            onDone();
            onClose();
          }}
        >
          stand-in give
        </button>
      </div>
    ) : null,
}));

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
let boxLogins: { provider: string; revision: number; key_id: string; updated_at: string }[];
let operations: Record<string, unknown>[];
let loginsAnswer: number;
let createAnswer: { status: number; body: unknown };

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
  // By default the box already has a confirmed Claude login.
  boxLogins = [{ provider: "claude", revision: 1, key_id: "k", updated_at: "2026-11-05T00:00:00Z" }];
  operations = [];
  loginsAnswer = 200;
  createAnswer = { status: 201, body: { agent_id: "a-1", name: "web-frontend" } };
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
    if (url === "/gateway/management/agents" && method === "POST") return json(createAnswer.status, createAnswer.body);
    if (url === "/gateway/management/controllers/box-ctl/provider-logins")
      return loginsAnswer === 200 ? json(200, boxLogins) : json(loginsAnswer, {});
    if (url === "/gateway/management/operations?controller_id=box-ctl") return json(200, operations);
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
  it("says the name can't be changed later, since it's the agent's folder and how it's addressed", () => {
    render(<CloudAgentDialog open onClose={() => {}} onCreated={() => {}} />);
    const name = screen.getByLabelText(/Name/);
    const help = document.getElementById(name.getAttribute("aria-describedby") ?? "");
    expect(help?.textContent).toContain("This can't be changed later.");
  });

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

describe("the provider's login comes first (Core places an agent only where it's signed in)", () => {
  async function readyForm() {
    boxOnline = true;
    ensureAnswer = { status: 200, body: { ...BOX, state: "ready" } };
    render(<CloudAgentDialog open onClose={() => {}} onCreated={() => {}} />);
    await waitFor(() => expect(screen.getByText("Your Switch cloud is ready.")).toBeTruthy());
    fill();
  }
  const create = () => screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
  const prompt = async () => (await screen.findByTestId("login-first")).textContent;

  it("with no login on the box, asks for it first and keeps Create off; giving it turns Create on", async () => {
    boxLogins = [];
    await readyForm();
    await waitFor(async () => expect(await prompt()).toContain(LOGIN_FIRST.none("Claude")));
    expect(create().disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Give Claude login" }));
    expect((await screen.findByTestId("login-dialog")).textContent).toContain("claude");
    fireEvent.click(screen.getByRole("button", { name: "stand-in give" }));

    await waitFor(() => expect(create().disabled).toBe(false));
    expect(screen.queryByTestId("login-first")).toBeNull();
    fireEvent.click(create());
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/agents"))).toBe(true));
  });

  it("while the box is still signing in, waits with Create off, and turns it on once the box confirms", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    operations = [
      { id: "op-1", kind: "provider.login", state: "claimed", params: { provider: "claude" }, created_at: "2026-11-06T09:00:00Z" },
    ];
    await readyForm();
    await waitFor(async () => expect(await prompt()).toContain(LOGIN_FIRST.waiting("Claude")));
    expect(create().disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Give Claude login" })).toBeNull();

    operations = [{ ...operations[0], state: "succeeded" }];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OPERATION_POLL_MS + 100);
    });
    await waitFor(() => expect(create().disabled).toBe(false));
  });

  it("when the box couldn't sign in with it, asks for it again with Create off", async () => {
    operations = [
      { id: "op-1", kind: "provider.login", state: "failed", params: { provider: "claude" }, created_at: "2026-11-06T09:00:00Z" },
    ];
    await readyForm();
    await waitFor(async () => expect(await prompt()).toContain(LOGIN_FIRST.failed("Claude")));
    expect(create().disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Give Claude login" })).toBeTruthy();
  });

  it("when the login can't be read, says so with Try again, and Create stays off", async () => {
    loginsAnswer = 502;
    await readyForm();
    await waitFor(async () => expect(await prompt()).toContain(LOGIN_FIRST.unreadable("Claude")));
    expect(create().disabled).toBe(true);
    loginsAnswer = 200;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(create().disabled).toBe(false));
  });

  it.each(Object.keys(CREATE_REFUSED))("shows a fixed line for Core's %s, never Core's own text, and reads the login again", async (code) => {
    createAnswer = { status: 409, body: { error: { code, message: "claude is not logged in on this controller CORE-TEXT" } } };
    await readyForm();
    await waitFor(() => expect(create().disabled).toBe(false));
    const reads = calls.filter((c) => c.url.endsWith("/provider-logins")).length;
    fireEvent.click(create());
    await waitFor(() => expect(screen.getByText(CREATE_REFUSED[code]!)).toBeTruthy());
    expect(document.body.textContent).not.toContain("CORE-TEXT");
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/provider-logins")).length).toBeGreaterThan(reads));
  });
});
