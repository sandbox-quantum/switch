import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MembersSection, {
  HOSTED_LIST_FAILED,
  boxLabel,
  loadHosted,
  personSwitch,
} from "./MembersSection";

vi.mock("../../data/AuthContext", () => ({
  useAuth: () => ({ refresh: async () => {} }),
}));

const members = [
  { user_id: "u1", name: "Sam Example", email: "sam@example.com", role: "member", created_at: "2026-10-01" },
  { user_id: "u2", name: "Robin Admin", email: "robin@example.com", role: "admin", created_at: "2026-10-01" },
];
const hostedPeople = {
  people: [
    {
      user_id: "u1",
      name: "Sam Example",
      hosted: "on",
      agents: 2,
      box_state: "running",
      memory_band: "high",
      last_active_at: "2026-10-29T10:00:00Z",
    },
  ],
};

/** Answers the members route, and the hosted route with `hostedStatus`. */
function serve(hostedStatus = 200, person?: Record<string, unknown>) {
  const answer = person ? { people: [person], switchable: true } : hostedPeople;
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/members")) return new Response(JSON.stringify(members), { status: 200 });
    if (url.endsWith("/hosted-people"))
      return hostedStatus === 200
        ? new Response(JSON.stringify(answer), { status: 200 })
        : new Response(JSON.stringify({ detail: "no" }), { status: hostedStatus });
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function asked(fetchMock: ReturnType<typeof serve>, path: string): boolean {
  return fetchMock.mock.calls.some(([url]) => String(url).endsWith(path));
}

describe("the Members page's hosted columns (spec A1)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("never asks for hosted fields for an ordinary member", async () => {
    const fetchMock = serve();
    render(<MembersSection tenantId="t1" selfId="u1" canAdmin={false} isOwner={false} />);
    await waitFor(() => expect(asked(fetchMock, "/members")).toBe(true));
    expect(asked(fetchMock, "/hosted-people")).toBe(false);
  });

  it("asks for them for a workspace admin", async () => {
    const fetchMock = serve();
    render(<MembersSection tenantId="t1" selfId="u2" canAdmin isOwner={false} />);
    await waitFor(() => expect(asked(fetchMock, "/tenants/t1/hosted-people")).toBe(true));
  });

  it("shows \"Not enabled by Switch (switch disabled)\" with no working switch for someone the server doesn't admit", async () => {
    serve(200, { ...hostedPeople.people[0], switchable: false });
    render(<MembersSection tenantId="t1" selfId="u2" canAdmin isOwner={false} />);
    await screen.findByText("Not enabled by Switch (switch disabled)");
    const toggle = screen.getByLabelText("Hosted agents for sam@example.com");
    expect((toggle as HTMLInputElement).disabled).toBe(true);
  });

  it("shows a paused person's box as the red Paused badge, and the switch note in full", async () => {
    // Designer's screenshot fix list, items 4 and 9 (copy doc rows "paused" and "Switch note, paused").
    serve(200, { ...hostedPeople.people[0], box_state: "paused", paused_by_switch: true });
    render(<MembersSection tenantId="t1" selfId="u2" canAdmin isOwner={false} />);
    await screen.findByText("Paused by Switch (switch disabled)");
    const badge = screen.getByText("Paused").closest(".MuiChip-root");
    expect(badge?.className).toContain("MuiChip-colorError");
    expect(screen.queryByText("Paused by Swi")).toBeNull();
  });

  it("keeps \"(you)\" on your own name", async () => {
    serve();
    render(<MembersSection tenantId="t1" selfId="u2" canAdmin isOwner={false} />);
    expect(await screen.findByText("Robin Admin (you)")).toBeTruthy();
  });
});

describe("personSwitch", () => {
  it("lets an operator's pause win, then the server's own allow-list", () => {
    expect(personSwitch({ paused_by_switch: true, switchable: false }, true)).toEqual({
      disabled: true,
      note: "Paused by Switch (switch disabled)",
    });
    expect(personSwitch({ switchable: false }, true)).toEqual({
      disabled: true,
      note: "Not enabled by Switch (switch disabled)",
    });
    expect(personSwitch({ switchable: true }, true)).toEqual({ disabled: false, note: null });
    expect(personSwitch({}, false)).toEqual({ disabled: true, note: null });
  });
});

describe("loadHosted", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns nothing, asking nothing, for a member", async () => {
    const fetchMock = serve();
    expect(await loadHosted("t1", false)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the people for an admin", async () => {
    serve();
    expect(await loadHosted("t1", true)).toEqual(hostedPeople);
  });

  it("shows the members as before when the server has no hosted view or refuses", async () => {
    for (const status of [403, 404, 503]) {
      serve(status);
      expect(await loadHosted("t1", true)).toBeNull();
    }
  });

  it("passes any other failure on", async () => {
    serve(500);
    await expect(loadHosted("t1", true)).rejects.toThrow();
  });
});

describe("boxLabel", () => {
  const person = hostedPeople.people[0] as Parameters<typeof boxLabel>[0] & object;
  it("says Turned off for someone the admin turned off, and keeps a pause as its own state", () => {
    expect(boxLabel({ ...person, hosted: "off", box_state: "stopped" })).toBe("Turned off");
    expect(boxLabel({ ...person, hosted: "off", box_state: "paused" })).toBe("Paused");
    expect(boxLabel({ ...person, paused_by_switch: true })).toBe("Paused");
    expect(boxLabel({ ...person, box_state: "running" })).toBe("Running");
    expect(boxLabel({ ...person, box_state: "error" })).toBe("Can't start");
    expect(boxLabel({ ...person, box_state: null })).toBe("—");
    expect(boxLabel(undefined)).toBe("—");
  });
});

describe("the Members description", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  const LINE =
    "Owners and admins can change roles, remove people, and turn hosted agents on or off for each person. Every change is recorded.";

  it("shows to admins with the hosted view", async () => {
    serve();
    render(<MembersSection tenantId="t1" selfId="u2" canAdmin isOwner={false} />);
    expect(await screen.findByText(LINE)).toBeTruthy();
  });

  it("never shows to an ordinary member", async () => {
    const fetchMock = serve();
    render(<MembersSection tenantId="t1" selfId="u1" canAdmin={false} isOwner={false} />);
    await waitFor(() => expect(asked(fetchMock, "/members")).toBe(true));
    expect(screen.queryByText(LINE)).toBeNull();
  });
});

describe("the switch, end to end on the page (QA)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /** Members, hosted people with Sam on, and the PUT answering `putStatus`. */
  function serveFlow(putStatus: number) {
    let hostedState: "on" | "off" = "on";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/members")) return new Response(JSON.stringify(members), { status: 200 });
      if (url.endsWith("/hosted-people"))
        return new Response(
          JSON.stringify({ people: [{ ...hostedPeople.people[0], hosted: hostedState }], switchable: true }),
          { status: 200 },
        );
      if (url.endsWith("/hosted-people/u1") && init?.method === "PUT") {
        if (putStatus !== 200)
          return new Response(JSON.stringify({ detail: "zebra-marker-7f3c" }), { status: putStatus });
        hostedState = "off";
        return new Response(JSON.stringify({ enabled: false }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function turnOffSam() {
    render(<MembersSection tenantId="t1" selfId="u2" canAdmin isOwner={false} />);
    const toggle = await screen.findByLabelText("Hosted agents for sam@example.com");
    fireEvent.click(toggle);
    await screen.findByText("Turn off hosted agents for Sam Example?");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Left the team" } });
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
  }

  it("toggles, confirms with a reason, sends the PUT and shows the new state", async () => {
    const fetchMock = serveFlow(200);
    await turnOffSam();
    await waitFor(() =>
      expect(screen.queryByText("Turn off hosted agents for Sam Example?")).toBeNull(),
    );
    const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
    expect(JSON.parse(String((put![1] as RequestInit).body))).toEqual({
      enabled: false,
      reason: "Left the team",
    });
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Hosted agents for sam@example.com") as HTMLInputElement).checked,
      ).toBe(false),
    );
  });

  it("keeps the dialog open with the fixed refusal on a 409, and never the server's text", async () => {
    serveFlow(409);
    await turnOffSam();
    expect(
      await screen.findByText(
        "Switch has paused this person. Their switch can change once Switch resumes them.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Turn off hosted agents for Sam Example?")).toBeTruthy();
    expect(document.body.textContent).not.toContain("zebra-marker-7f3c");
  });
});

describe("when the hosted list fails for another reason", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("tells the admin with a fixed line and still shows the members", async () => {
    serve(500);
    render(<MembersSection tenantId="t1" selfId="u2" canAdmin isOwner={false} />);
    expect(await screen.findByText(HOSTED_LIST_FAILED)).toBeTruthy();
    expect((await screen.findAllByText("Sam Example")).length).toBeGreaterThan(0);
  });

  it("says nothing when the server simply has no hosted view", async () => {
    const fetchMock = serve(404);
    render(<MembersSection tenantId="t1" selfId="u2" canAdmin isOwner={false} />);
    await waitFor(() => expect(asked(fetchMock, "/hosted-people")).toBe(true));
    await screen.findAllByText("Sam Example");
    expect(screen.queryByText(HOSTED_LIST_FAILED)).toBeNull();
  });
});
