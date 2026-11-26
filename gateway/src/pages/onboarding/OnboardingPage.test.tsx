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
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return asked;
}

function signedIn(isOperator: boolean, more: Record<string, unknown> = {}) {
  const refresh = vi.fn();
  vi.mocked(useAuth).mockReturnValue({
    session: {
      user: { id: "u1", name: "Op", email: "op@example.com", is_operator: isOperator },
      tenant: null,
      tenants: [],
      state: "needs_workspace",
      can_create_workspace: false,
      ...more,
    },
    refresh,
  } as unknown as ReturnType<typeof useAuth>);
  return refresh;
}

const NONE_LEFT: Answer = [200, []];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
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

describe("OnboardingPage where organizations are kept in the shared account", () => {
  const directory = { organizations_in_directory: true, license_to_accept: null };

  it("asks the license first where one is asked, and records accepting it", async () => {
    const asked = answer({
      "GET /organizations/without-workspace": NONE_LEFT,
      "POST /auth/license": [204, null],
    });
    const refresh = signedIn(false, {
      ...directory,
      can_create_workspace: true,
      license_to_accept: "2026-11",
    });
    render(<OnboardingPage />);

    expect(await screen.findByRole("heading", { name: "Before you start" })).toBeTruthy();
    expect(screen.getByText("Step 1 of 2: License")).toBeTruthy();
    const accept = screen.getByRole("button", { name: "Accept and continue" }) as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "I have read and accept the license" }));
    fireEvent.click(accept);

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(asked).toContain("POST /auth/license");
    expect(window.sessionStorage.getItem("switch.licenseAccepted")).toBe("2026-11");
  });

  it("sets up the organization as Switch Trust asks, with the optional answers", async () => {
    const bodies: unknown[] = [];
    answer({ "GET /organizations/without-workspace": NONE_LEFT });
    const fetchMock = vi.mocked(fetch);
    const answerOthers = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/organizations") && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ detail: "You've already created an organization, Acme, and each person creates one. Nothing was changed." }), { status: 409 });
      }
      return answerOthers(input, init);
    });
    signedIn(false, { ...directory, can_create_workspace: true });
    render(<OnboardingPage />);

    expect(await screen.findByRole("heading", { name: "Welcome to Switch Rooms!" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/What's your organization called/), {
      target: { value: "  Acme  " },
    });
    fireEvent.change(screen.getByLabelText("What will you use Switch for?"), {
      target: { value: "Support agents" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));

    expect(await screen.findByText(/already created an organization, Acme/)).toBeTruthy();
    expect(bodies).toEqual([
      { name: "Acme", setup_answers: { team_size: null, use_case: "Support agents" } },
    ]);
  });

  it("refuses a name the account would refuse before asking it", async () => {
    answer({ "GET /organizations/without-workspace": NONE_LEFT });
    signedIn(false, { ...directory, can_create_workspace: true });
    render(<OnboardingPage />);

    fireEvent.change(await screen.findByLabelText(/What's your organization called/), {
      target: { value: 'Acme "Labs"' },
    });

    expect(screen.getByText(/Leave out double quotes/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Get started" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("offers a fresh sign-in when creating asks for one", async () => {
    answer({
      "GET /organizations/without-workspace": NONE_LEFT,
      "POST /organizations": [
        403,
        {
          detail: {
            error: "directory_sign_in_required",
            message: "Your sign-in has ended. Sign in again to create an organization.",
            access_ended: false,
            organization_id: null,
          },
        },
      ],
    });
    signedIn(false, { ...directory, can_create_workspace: true });
    render(<OnboardingPage />);

    fireEvent.change(await screen.findByLabelText(/What's your organization called/), {
      target: { value: "Acme" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));

    const again = await screen.findByRole("link", { name: "Sign in again" });
    expect(again.getAttribute("href")).toBe("/gateway/auth/oidc/login?next=%2F");
  });

  it("tells someone who may not create one that they aren't in one yet", async () => {
    answer({ "GET /organizations/without-workspace": NONE_LEFT });
    signedIn(false, directory);
    render(<OnboardingPage />);

    expect(
      await screen.findByRole("heading", { name: "You're not in an organization yet" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in again" }).getAttribute("href")).toBe(
      "/gateway/auth/oidc/login?next=%2F",
    );
    expect(screen.queryByLabelText(/What's your organization called/)).toBeNull();
  });
});

describe("OnboardingPage where organizations are kept here", () => {
  it("asks the license before creating one, where one is asked", async () => {
    answer({ "GET /organizations/without-workspace": NONE_LEFT });
    signedIn(false, { can_create_workspace: true, license_to_accept: "2026-11" });
    render(<OnboardingPage />);

    expect(await screen.findByRole("heading", { name: "Before you start" })).toBeTruthy();
    expect(screen.queryByLabelText("Organization name")).toBeNull();
  });
});
