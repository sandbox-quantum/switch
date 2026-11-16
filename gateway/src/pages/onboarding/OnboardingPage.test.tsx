import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "../../data/AuthContext";
import OnboardingPage from "./OnboardingPage";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

function signedIn(isOperator: boolean, switchTo = vi.fn()) {
  vi.mocked(useAuth).mockReturnValue({
    session: {
      user: { id: "u1", name: "Op", email: "op@example.com", is_operator: isOperator },
      tenant: null,
      tenants: [],
      state: "needs_workspace",
      can_create_workspace: false,
    },
    refresh: vi.fn(),
    switchTo,
  } as unknown as ReturnType<typeof useAuth>);
  return switchTo;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OnboardingPage", () => {
  it("lets a platform operator in no workspace open one", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(
          JSON.stringify([
            {
              id: "w1",
              slug: "acme",
              name: "Acme",
              organization_id: "o1",
              organization_name: "Acme Inc",
              archived_at: null,
            },
            {
              id: "w2",
              slug: "old",
              name: "Old",
              organization_id: "o1",
              organization_name: "Acme Inc",
              archived_at: "2026-10-01T00:00:00Z",
            },
          ]),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const switchTo = signedIn(true);
    render(<OnboardingPage />);

    fireEvent.click(await screen.findByText("Acme"));

    await waitFor(() => expect(switchTo).toHaveBeenCalledWith("w1"));
    expect(screen.queryByText("Old")).toBeNull();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/operator/workspaces");
  });

  it("asks anyone else for an invite link", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    signedIn(false);
    render(<OnboardingPage />);

    expect(await screen.findByText(/Ask a workspace admin for an invite link/)).toBeTruthy();
    expect(screen.queryByText("Open a workspace as the platform operator")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
