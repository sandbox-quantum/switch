import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  current: {
    user: { id: "me" },
    session: { tenant: { id: "t1" } },
    capabilities: { features: { gateway_onboarding: true, agent_management: true } },
  },
}));
vi.mock("../../data/AuthContext", () => ({ useAuth: () => auth.current }));

const management = vi.hoisted(() => ({ fetchManagedAgents: vi.fn() }));
vi.mock("../../data/management", () => management);

const onboarding = vi.hoisted(() => ({
  fetchHostedMachines: vi.fn(),
  ensureCloudMachine: vi.fn(),
}));
vi.mock("./onboarding", () => onboarding);

function Where() {
  const location = useLocation();
  return <span data-testid="where">{location.pathname}</span>;
}

async function renderAt(path: string) {
  const { default: CloudWarmUp } = await import("./CloudWarmUp");
  return render(
    <MemoryRouter initialEntries={[path]}>
      <CloudWarmUp />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  onboarding.fetchHostedMachines.mockResolvedValue({ available: true, machines: [] });
  onboarding.ensureCloudMachine.mockResolvedValue({});
  management.fetchManagedAgents.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CloudWarmUp", () => {
  it("starts the cloud device and sends someone with no agents to Get started, once", async () => {
    await renderAt("/rooms");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/get-started"));
    expect(onboarding.ensureCloudMachine).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("switch.get-started.sent:me:t1")).not.toBeNull();
  });

  it("only warms the machine for someone who already has agents", async () => {
    management.fetchManagedAgents.mockResolvedValue([{ agent_id: "a1" }]);
    await renderAt("/rooms");
    await waitFor(() => expect(onboarding.ensureCloudMachine).toHaveBeenCalled());
    await waitFor(() => expect(management.fetchManagedAgents).toHaveBeenCalled());
    expect(screen.getByTestId("where").textContent).toBe("/rooms");
  });

  it("still sends someone to Get started when their device cannot be had yet", async () => {
    onboarding.ensureCloudMachine.mockRejectedValue(new Error("All cloud devices are in use."));
    await renderAt("/rooms");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/get-started"));
  });

  it("does nothing where the server has no cloud devices", async () => {
    onboarding.fetchHostedMachines.mockResolvedValue({ available: false, machines: [] });
    await renderAt("/rooms");
    await waitFor(() => expect(onboarding.fetchHostedMachines).toHaveBeenCalled());
    expect(onboarding.ensureCloudMachine).not.toHaveBeenCalled();
    expect(management.fetchManagedAgents).not.toHaveBeenCalled();
    expect(screen.getByTestId("where").textContent).toBe("/rooms");
  });

  it("sends nobody twice", async () => {
    localStorage.setItem("switch.get-started.sent:me:t1", "2026-01-01");
    onboarding.fetchHostedMachines.mockResolvedValue({
      available: true,
      machines: [{ machine_id: "m1" }],
    });
    await renderAt("/rooms");
    await waitFor(() => expect(onboarding.fetchHostedMachines).toHaveBeenCalled());
    expect(onboarding.ensureCloudMachine).not.toHaveBeenCalled();
    expect(screen.getByTestId("where").textContent).toBe("/rooms");
  });
});
