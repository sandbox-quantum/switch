import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilesRoute, HostedRoute } from "./hostedRoutes";

// With v2 off, both addresses read as main's not-found page, and while Core's
// flags are still being read they show nothing at all (no spinner), as main
// shows nothing extra there.

const state = vi.hoisted(() => ({
  hostedV2: null as boolean | null,
  flags: { data: null as Record<string, boolean> | null, loading: true },
}));
vi.mock("../data/hooks", () => ({
  useHostedV2: () => state.hostedV2,
  useFeatureFlags: () => ({ ...state.flags, error: null, refetch: () => {} }),
}));
vi.mock("../pages/hosted/HostedPage", () => ({ default: () => <h1>Hosted page</h1> }));
vi.mock("../pages/files/CloudFilesPage", () => ({ default: () => <h1>Files page</h1> }));

function show(element: React.ReactNode) {
  return render(<MemoryRouter>{element}</MemoryRouter>);
}

describe("the v2 routes", () => {
  afterEach(cleanup);

  it("show nothing while Core's flags are read", () => {
    state.hostedV2 = null;
    state.flags = { data: null, loading: true };
    const hosted = show(<HostedRoute />);
    expect(hosted.container.innerHTML).toBe("");
    hosted.unmount();
    const files = show(<FilesRoute />);
    expect(files.container.innerHTML).toBe("");
  });

  it("show main's not-found page with v2 off", () => {
    state.hostedV2 = false;
    state.flags = { data: { hosted_v2: false, hosted_cloud_files: true }, loading: false };
    show(
      <>
        <HostedRoute />
        <FilesRoute />
      </>,
    );
    expect(screen.getAllByRole("heading", { name: "There's no page here" })).toHaveLength(2);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("load each page with its flags on", async () => {
    state.hostedV2 = true;
    state.flags = { data: { hosted_v2: true, hosted_cloud_files: true }, loading: false };
    show(
      <>
        <HostedRoute />
        <FilesRoute />
      </>,
    );
    expect(await screen.findByRole("heading", { name: "Hosted page" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Files page" })).toBeTruthy();
  });
});
