import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "../data/AuthContext";
import NavRail from "./NavRail";

vi.mock("../data/AuthContext", () => ({ useAuth: vi.fn() }));
vi.mock("../data/hooks", () => ({ useCurrentTenant: () => ({ data: null }) }));
vi.mock("../data/management", () => ({ fetchManagementAvailable: async () => false }));

function renderAs(flags: { isOperator: boolean; isHostedOperator: boolean }) {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: "u1", name: "Jo", email: "jo@example.com", is_operator: flags.isOperator },
    session: null,
    logout: vi.fn(),
    switchTo: vi.fn(),
    ...flags,
  } as unknown as ReturnType<typeof useAuth>);
  render(
    <MemoryRouter>
      <NavRail />
    </MemoryRouter>,
  );
}

describe("the nav rail's Hosted entry", () => {
  afterEach(cleanup);

  it("shows for someone on the operator list", () => {
    renderAs({ isOperator: false, isHostedOperator: true });
    expect(screen.getByRole("link", { name: /Hosted/ }).getAttribute("href")).toBe("/hosted");
  });

  it("never shows for the server admin flag alone", () => {
    renderAs({ isOperator: true, isHostedOperator: false });
    expect(screen.getByRole("link", { name: /Users/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Hosted/ })).toBeNull();
  });

  it("doesn't show for anyone else", () => {
    renderAs({ isOperator: false, isHostedOperator: false });
    expect(screen.queryByRole("link", { name: /Hosted/ })).toBeNull();
  });
});
