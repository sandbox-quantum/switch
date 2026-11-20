import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FinishInstallPage from "./FinishInstallPage";
import { rememberInstallReturn } from "./installReturn";

const api = vi.hoisted(() => ({
  fetchPendingInstall: vi.fn(),
  connectInstall: vi.fn(),
  cancelInstall: vi.fn(),
}));
vi.mock("../../data/api", () => api);

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/messaging-apps/finish"]}>
      <Routes>
        <Route path="/messaging-apps/finish" element={<FinishInstallPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

const pending = {
  platform: "slack",
  workspace_name: "Acme",
  external_workspace_id: "T1",
  organisation: "Acme Robotics",
  requested_by: "ada@example.com",
};

beforeEach(() => {
  window.history.replaceState(null, "", "/messaging-apps/finish#platform=slack&ticket=sealed");
  sessionStorage.clear();
  api.connectInstall.mockResolvedValue({ bridge_id: "b1" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FinishInstallPage", () => {
  it("connects an install its own person started and goes back where they were", async () => {
    rememberInstallReturn("/chats/agents/a1?chat=r1");
    api.fetchPendingInstall.mockResolvedValue({ ...pending, started_by_you: true });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/chats/agents/a1"));
    expect(api.connectInstall).toHaveBeenCalledWith("slack", "sealed", false);
    // The sealed confirmation leaves the address at once.
    expect(window.location.hash).toBe("");
  });

  it("asks anyone else before connecting", async () => {
    api.fetchPendingInstall.mockResolvedValue({ ...pending, started_by_you: false });
    renderPage();
    expect(await screen.findByText("Connect this Slack workspace to Switch?")).toBeTruthy();
    expect(screen.getByText(/ada@example.com started this install/)).toBeTruthy();
    expect(api.connectInstall).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(api.connectInstall).toHaveBeenCalledWith("slack", "sealed", true));
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe("/settings/messaging-apps"),
    );
  });
});
