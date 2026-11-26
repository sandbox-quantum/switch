import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "../../data/AuthContext";
import OnboardingPage from "./OnboardingPage";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

type Answer = [number, unknown];

/** Answers each `METHOD /path` from `routes`, the answers of one route in
 * turn when it has several; anything else is a 404. */
function answer(routes: Record<string, Answer | Answer[]>) {
  const asked: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input).replace(/^\/gateway/, "")}`;
    asked.push(key);
    const route = routes[key];
    const answers =
      route === undefined ? [] : Array.isArray(route[0]) ? (route as Answer[]) : [route as Answer];
    const turn = asked.filter((k) => k === key).length - 1;
    const [status, body] = answers[Math.min(turn, answers.length - 1)] ?? [
      404,
      { detail: `unmocked ${key}` },
    ];
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return asked;
}

function signedIn(isOperator: boolean) {
  vi.mocked(useAuth).mockReturnValue({
    session: {
      user: { id: "u1", name: "Op", email: "op@example.com", is_operator: isOperator },
      tenant: null,
      tenants: [],
      state: "needs_workspace",
      can_create_workspace: false,
    },
    refresh: vi.fn(),
    capabilities: { features: {} },
  } as unknown as ReturnType<typeof useAuth>);
}

const NONE_LEFT: Answer = [200, []];

/** Nobody invited them, and no workspace is open to their domain. */
const NO_OFFERS = { "GET /invitations/mine": NONE_LEFT, "GET /joinable-tenants": NONE_LEFT };

const realLocation = window.location;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(window, "location", { value: realLocation, configurable: true });
});

function captureNavigation(): { assign: ReturnType<typeof vi.fn> } {
  const location = { assign: vi.fn() };
  Object.defineProperty(window, "location", { value: location, configurable: true });
  return location;
}

describe("OnboardingPage", () => {
  it.each([false, true])(
    "asks for an invite link, platform operator or not (%s)",
    async (isOperator) => {
      const asked = answer({ "GET /organizations/without-workspace": NONE_LEFT, ...NO_OFFERS });
      signedIn(isOperator);
      render(<OnboardingPage />);

      expect(await screen.findByText(/Ask a workspace admin for an invite link/)).toBeTruthy();
      await waitFor(() =>
        expect([...asked].sort()).toEqual([
          "GET /invitations/mine",
          "GET /joinable-tenants",
          "GET /organizations/without-workspace",
        ]),
      );
    },
  );

  it("offers to leave an organization they're left in with no workspace", async () => {
    const asked = answer({
      "GET /organizations/without-workspace": [
        [200, [{ id: "o1", name: "Acme Inc" }]],
        [200, []],
      ],
      "POST /organizations/o1/leave": [200, { ok: true }],
      ...NO_OFFERS,
    });
    signedIn(false);
    render(<OnboardingPage />);

    const notice = await screen.findByText(
      "You're still in Acme Inc, though in none of its workspaces.",
    );
    const alert = notice.closest('[role="alert"]') as HTMLElement;
    fireEvent.click(within(alert).getByRole("button", { name: "Leave" }));
    const dialog = await screen.findByRole("dialog", { name: "Leave Acme Inc?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Leave" }));

    expect(await screen.findByText("You left Acme Inc.")).toBeTruthy();
    expect(asked).toContain("POST /organizations/o1/leave");
    expect(screen.queryByText(/You're still in Acme Inc/)).toBeNull();
  });

  it("accepts an invitation addressed to them, opening its workspace", async () => {
    const asked = answer({
      "GET /organizations/without-workspace": NONE_LEFT,
      "GET /invitations/mine": [
        200,
        [
          {
            id: "i1",
            tenant_id: "t1",
            tenant_slug: "acme",
            tenant_name: "Acme",
            role: "member",
            expires_at: "2099-01-01T00:00:00Z",
            invited_by: "Ada",
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      ],
      "GET /joinable-tenants": NONE_LEFT,
      "POST /invitations/mine/accept": [200, { id: "t1", name: "Acme", role: "member", already_member: false }],
    });
    const location = captureNavigation();
    signedIn(false);
    render(<OnboardingPage />);

    expect(await screen.findByText("Ada invited you as member")).toBeTruthy();
    expect(screen.getByText(/^You can join these\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Acme.*Accept/ }));

    await waitFor(() => expect(location.assign).toHaveBeenCalledWith("/"));
    const sent = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/invitations/mine/accept"));
    expect(JSON.parse(String(sent?.[1]?.body))).toEqual({ tenant_id: "t1", invitation_id: "i1" });
    expect(asked).toContain("POST /invitations/mine/accept");
  });

  it("joins a workspace open to their email domain", async () => {
    const asked = answer({
      "GET /organizations/without-workspace": NONE_LEFT,
      "GET /invitations/mine": NONE_LEFT,
      "GET /joinable-tenants": [
        200,
        [{ tenant_id: "t2", tenant_slug: "example", tenant_name: "Example", domain: "example.com" }],
      ],
      "POST /joinable-tenants/t2/join": [200, { id: "t2", name: "Example", role: "member" }],
    });
    const location = captureNavigation();
    signedIn(false);
    render(<OnboardingPage />);

    expect(await screen.findByText("Open to anyone at example.com")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Example.*Join/ }));

    await waitFor(() => expect(location.assign).toHaveBeenCalledWith("/"));
    expect(asked).toContain("POST /joinable-tenants/t2/join");
  });

  it("says when it could not check for invitations, and checks again on Retry", async () => {
    const asked = answer({
      "GET /organizations/without-workspace": NONE_LEFT,
      "GET /invitations/mine": [
        [500, { detail: "The invitations could not be read." }],
        [200, []],
      ],
      "GET /joinable-tenants": NONE_LEFT,
    });
    signedIn(false);
    render(<OnboardingPage />);

    expect(await screen.findByText("The invitations could not be read.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText("The invitations could not be read.")).toBeNull());
    expect(asked.filter((key) => key === "GET /invitations/mine")).toHaveLength(2);
  });
});
