import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "../data/AuthContext";
import NavRail from "./NavRail";

vi.mock("../data/AuthContext", () => ({ useAuth: vi.fn() }));
const hostedV2 = vi.hoisted(() => ({ value: true as boolean | null }));
vi.mock("../data/hooks", () => ({
  useCurrentTenant: () => ({ data: null }),
  useHostedV2: () => hostedV2.value,
}));
vi.mock("../data/management", () => ({ fetchManagementAvailable: async () => false }));
const cloudFiles = vi.hoisted(() => ({ value: false as boolean | null }));
vi.mock("../pages/files/useCloudFiles", () => ({ useCloudFilesShown: () => cloudFiles.value }));

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
  afterEach(() => {
    cleanup();
    hostedV2.value = true;
  });

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

  it("doesn't show, even for the operator list, while hosted agents v2 is off", () => {
    hostedV2.value = false;
    renderAs({ isOperator: false, isHostedOperator: true });
    expect(screen.queryByRole("link", { name: /Hosted/ })).toBeNull();
  });

  it("doesn't show while the switch is still being read", () => {
    hostedV2.value = null;
    renderAs({ isOperator: false, isHostedOperator: true });
    expect(screen.queryByRole("link", { name: /Hosted/ })).toBeNull();
  });
});

describe("the nav rail's Your cloud files entry", () => {
  afterEach(() => {
    cleanup();
    cloudFiles.value = false;
  });

  it("shows where Your cloud files shows", () => {
    cloudFiles.value = true;
    renderAs({ isOperator: false, isHostedOperator: false });
    expect(screen.getByRole("link", { name: /Your cloud files/ }).getAttribute("href")).toBe("/files");
  });

  it("doesn't show where it doesn't, or while it's still being found out", () => {
    for (const value of [false, null]) {
      cloudFiles.value = value;
      renderAs({ isOperator: false, isHostedOperator: false });
      expect(screen.queryByRole("link", { name: /Your cloud files/ })).toBeNull();
      cleanup();
    }
  });
});
