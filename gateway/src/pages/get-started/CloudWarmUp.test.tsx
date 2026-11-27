import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  current: {
    user: { id: "me" },
    session: { tenant: { id: "t1" } },
    capabilities: { features: { gateway_onboarding: true, agent_management: true, switch_buddy: true } as Record<string, boolean> },
  },
}));
vi.mock("../../data/AuthContext", () => ({ useAuth: () => auth.current }));

const management = vi.hoisted(() => ({ fetchManagedAgents: vi.fn() }));
vi.mock("../../data/management", () => management);

const onboarding = vi.hoisted(() => ({
  fetchHostedMachines: vi.fn(),
  ensureCloudMachine: vi.fn(),
  wakeCloudMachine: vi.fn(),
}));
vi.mock("./onboarding", () => onboarding);

const KEY = "switch.get-started.sent:me:t1";

function Where() {
  const location = useLocation();
  return <span data-testid="where">{location.pathname}</span>;
}

async function renderGateAt(path: string) {
  const { FirstVisitGate } = await import("./CloudWarmUp");
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="*"
          element={
            <FirstVisitGate>
              <Where />
            </FirstVisitGate>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

async function renderWarmUp() {
  const { default: CloudWarmUp } = await import("./CloudWarmUp");
  return render(<CloudWarmUp />);
}

beforeEach(() => {
  vi.resetModules();
  auth.current.capabilities.features.switch_buddy = true;
  localStorage.clear();
  onboarding.fetchHostedMachines.mockResolvedValue({ available: true, machines: [] });
  onboarding.ensureCloudMachine.mockResolvedValue({ machine_id: "m-new" });
  onboarding.wakeCloudMachine.mockResolvedValue(undefined);
  management.fetchManagedAgents.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FirstVisitGate", () => {
  it("takes someone with no agents straight to Get started, showing nothing before", async () => {
    let answer: (agents: unknown[]) => void = () => {};
    management.fetchManagedAgents.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await renderGateAt("/");
    expect(screen.queryByTestId("where")).toBeNull();
    answer([]);
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/get-started"));
    expect(localStorage.getItem(KEY)).not.toBeNull();
  });

  it("shows the page asked for to someone who already has agents", async () => {
    management.fetchManagedAgents.mockResolvedValue([{ agent_id: "a1" }]);
    await renderGateAt("/rooms");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/rooms"));
    expect(localStorage.getItem(KEY)).not.toBeNull();
  });

  it("doesn't count a visit where no cloud device could be had", async () => {
    onboarding.fetchHostedMachines.mockResolvedValue({ available: false, machines: [] });
    await renderGateAt("/rooms");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/rooms"));
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("sends nobody to Get started where the server offers no switch-buddy", async () => {
    auth.current.capabilities.features.switch_buddy = false;
    await renderGateAt("/rooms");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/rooms"));
    expect(management.fetchManagedAgents).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("sends nobody twice", async () => {
    localStorage.setItem(KEY, "2026-01-01");
    await renderGateAt("/rooms");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/rooms"));
    expect(management.fetchManagedAgents).not.toHaveBeenCalled();
  });

  it("runs as a first visit again once the visit is forgotten (Start over)", async () => {
    localStorage.setItem(KEY, "2026-01-01");
    const { forgetGetStartedVisit } = await import("./CloudWarmUp");
    forgetGetStartedVisit("me", "t1");
    await renderGateAt("/rooms");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/get-started"));
  });
});

describe("CloudWarmUp", () => {
  it("starts a cloud device for someone who has none", async () => {
    await renderWarmUp();
    await waitFor(() => expect(onboarding.ensureCloudMachine).toHaveBeenCalledTimes(1));
  });

  it("starts a stopped device again on a first visit, as signing in starts a new one", async () => {
    const stopped = { machine_id: "m1", desired_state: "stopped" };
    onboarding.fetchHostedMachines.mockResolvedValue({ available: true, machines: [stopped] });
    await renderWarmUp();
    await waitFor(() => expect(onboarding.wakeCloudMachine).toHaveBeenCalledWith(stopped));
    expect(onboarding.ensureCloudMachine).not.toHaveBeenCalled();
  });

  it("leaves the device of someone who already has agents as it is", async () => {
    onboarding.fetchHostedMachines.mockResolvedValue({
      available: true,
      machines: [{ machine_id: "m1", desired_state: "stopped" }],
    });
    management.fetchManagedAgents.mockResolvedValue([{ agent_id: "a1" }]);
    await renderWarmUp();
    await waitFor(() => expect(management.fetchManagedAgents).toHaveBeenCalled());
    expect(onboarding.wakeCloudMachine).not.toHaveBeenCalled();
  });

  it("does nothing where the server has no cloud devices", async () => {
    onboarding.fetchHostedMachines.mockResolvedValue({ available: false, machines: [] });
    await renderWarmUp();
    await waitFor(() => expect(onboarding.fetchHostedMachines).toHaveBeenCalled());
    expect(onboarding.ensureCloudMachine).not.toHaveBeenCalled();
    expect(management.fetchManagedAgents).not.toHaveBeenCalled();
  });

  it("does nothing when hosted machines are unavailable even if machines exist", async () => {
    onboarding.fetchHostedMachines.mockResolvedValue({
      available: false,
      machines: [{ machine_id: "m1", desired_state: "running" }],
    });
    await renderWarmUp();
    await waitFor(() => expect(onboarding.fetchHostedMachines).toHaveBeenCalled());
    expect(onboarding.ensureCloudMachine).not.toHaveBeenCalled();
    expect(onboarding.wakeCloudMachine).not.toHaveBeenCalled();
    expect(management.fetchManagedAgents).not.toHaveBeenCalled();
  });
});
