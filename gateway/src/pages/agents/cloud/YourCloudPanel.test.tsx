import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../data/api";
import * as hosted from "../../../data/hostedCloud";
import type { CloudMachine } from "../../../data/hostedCloud";
import YourCloudPanel from "./YourCloudPanel";

vi.mock("../../../data/hostedCloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../data/hostedCloud")>();
  return { ...actual, ensureCloudMachine: vi.fn(), startCloudMachine: vi.fn() };
});

function box(overrides: Partial<CloudMachine> = {}): CloudMachine {
  return {
    machine_id: "m-1",
    state: "ready",
    desired_state: "running",
    stop_reason: null,
    sleeping: false,
    revision: 3,
    error: null,
    error_code: null,
    agents: ["a1", "a2"],
    controller_id: "c-1",
    backend: "box",
    room: { used_bytes: 3, total_bytes: 10 },
    awake: { running: 2, max: 15 },
    ai_calls_today: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.mocked(hosted.ensureCloudMachine).mockReset();
  vi.mocked(hosted.startCloudMachine).mockReset();
});

describe("YourCloudPanel", () => {
  it("shows a ready box's figures and no Start", () => {
    render(<YourCloudPanel machine={box()} onChanged={vi.fn()} />);
    expect(screen.getByText("Your cloud")).toBeTruthy();
    expect(screen.getByText("2 agents")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("Room to work: Plenty of room")).toBeTruthy();
    expect(screen.getByText("2 of 15 awake")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  });

  it("starts a put-away box with ensure", async () => {
    const onChanged = vi.fn();
    vi.mocked(hosted.ensureCloudMachine).mockResolvedValue();
    render(<YourCloudPanel machine={box({ state: "retained" })} onChanged={onChanged} />);
    expect(screen.getByText("Stopped")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(hosted.ensureCloudMachine).toHaveBeenCalledOnce();
    expect(hosted.startCloudMachine).not.toHaveBeenCalled();
  });

  it("starts a box its owner stopped with lifecycle", async () => {
    vi.mocked(hosted.startCloudMachine).mockResolvedValue();
    const machine = box({ state: "stopped", desired_state: "stopped", stop_reason: "owner" });
    render(<YourCloudPanel machine={machine} onChanged={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(hosted.startCloudMachine).toHaveBeenCalledWith(machine));
    expect(hosted.ensureCloudMachine).not.toHaveBeenCalled();
  });

  it("wakes a resting box with no agents", async () => {
    vi.mocked(hosted.ensureCloudMachine).mockResolvedValue();
    render(
      <YourCloudPanel
        machine={box({ state: "stopped", sleeping: true, agents: [] })}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText("Start it to add an agent.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(hosted.ensureCloudMachine).toHaveBeenCalledOnce());
  });

  it.each([
    ["paused" as const, "Paused by Switch"],
    ["turned_off" as const, "Turned off by your admin"],
  ])("offers no Start when %s", (reason, heading) => {
    render(
      <YourCloudPanel
        machine={box({ state: "retained", stop_reason: reason })}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText(heading)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  });

  it("shows a refused start as an alert, as plain text", async () => {
    vi.mocked(hosted.ensureCloudMachine).mockRejectedValue(
      new ApiError(409, "<b>no</b> room", "409"),
    );
    render(<YourCloudPanel machine={box({ state: "retained" })} onChanged={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("<b>no</b> room");
    expect(alert.querySelector("b")).toBeNull();
  });

  it("renders Core's error text as text", () => {
    render(
      <YourCloudPanel
        machine={box({ state: "error", error: '<img src=x onerror="alert(1)">' })}
        onChanged={vi.fn()}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(alert.querySelector("img")).toBeNull();
  });
});
