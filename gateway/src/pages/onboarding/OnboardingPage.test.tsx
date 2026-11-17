import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  } as unknown as ReturnType<typeof useAuth>);
}

const NONE_LEFT: Answer = [200, []];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OnboardingPage", () => {
  it.each([false, true])(
    "asks for an invite link, platform operator or not (%s)",
    async (isOperator) => {
      const asked = answer({ "GET /organizations/without-workspace": NONE_LEFT });
      signedIn(isOperator);
      render(<OnboardingPage />);

      expect(await screen.findByText(/Ask a workspace admin for an invite link/)).toBeTruthy();
      expect(asked).toEqual(["GET /organizations/without-workspace"]);
    },
  );

  it("offers to leave an organization they're left in with no workspace", async () => {
    const asked = answer({
      "GET /organizations/without-workspace": [
        [200, [{ id: "o1", name: "Acme Inc" }]],
        [200, []],
      ],
      "POST /organizations/o1/leave": [200, { ok: true }],
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
});
