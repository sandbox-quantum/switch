import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "../data/AuthContext";
import { capabilitiesOf } from "../data/capabilities";
import { ALL_OFF } from "../data/featureFlags";
import { type Layout, railFor } from "../routes/routeTable";
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

function renderAs(flags: { isOperator: boolean; isHostedOperator: boolean }, layout: Layout = "current") {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: "u1", name: "Jo", email: "jo@example.com", is_operator: flags.isOperator },
    session: null,
    logout: vi.fn(),
    switchTo: vi.fn(),
    // Main's rail lists what these allow; with none, only v2's own entries are in question.
    capabilities: { ...capabilitiesOf(null, null, ALL_OFF), isOperator: flags.isOperator },
    ...flags,
  } as unknown as ReturnType<typeof useAuth>);
  render(
    <MemoryRouter>
      <NavRail layout={layout} />
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

describe("v2's rail items in main's rail", () => {
  afterEach(() => {
    cleanup();
    hostedV2.value = true;
    cloudFiles.value = false;
  });

  /** The rail's page links, in order. */
  const railLinks = () =>
    screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"))
      .filter((href): href is string => href !== null && href.startsWith("/"));

  for (const layout of ["current", "v2"] as const) {
    it(`are exactly main's rail with v2 off (${layout} layout)`, () => {
      hostedV2.value = false;
      cloudFiles.value = false;
      renderAs({ isOperator: true, isHostedOperator: true }, layout);
      const caps = { ...capabilitiesOf(null, null, ALL_OFF), isOperator: true };
      const main = railFor(layout, caps);
      // Main's own order: the pages, then the settings group at the foot.
      const expected = [...main.filter((item) => !item.bottom), ...main.filter((item) => item.bottom)].map(
        (item) => item.to,
      );
      expect(railLinks()).toEqual(expected);
    });
  }

  it("sit with the pages, before the settings group at the rail's foot (v2 layout)", () => {
    cloudFiles.value = true;
    renderAs({ isOperator: true, isHostedOperator: true }, "v2");
    const links = railLinks();
    const platform = links.indexOf("/platform");
    expect(platform).toBeGreaterThan(-1);
    expect(links.indexOf("/files")).toBeGreaterThan(-1);
    expect(links.indexOf("/hosted")).toBeGreaterThan(-1);
    expect(links.indexOf("/files")).toBeLessThan(platform);
    expect(links.indexOf("/hosted")).toBeLessThan(platform);
    // And in the pages' group, not the foot's.
    const group = (href: string) =>
      screen.getAllByRole("link").find((link) => link.getAttribute("href") === href)!.parentElement;
    expect(group("/hosted")).toBe(group(links[0]!));
    expect(group("/hosted")).not.toBe(group("/platform"));
  });
});
