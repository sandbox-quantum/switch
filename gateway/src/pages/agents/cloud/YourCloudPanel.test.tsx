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

const GB = 1024 ** 3;

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
    expect(screen.getByText("Agents awake: 2 of 15")).toBeTruthy();
    expect(screen.getByText("Disk: not available")).toBeTruthy();
    expect(screen.queryByText(/Room to work/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  });

  it("starts a put-away box with ensure", async () => {
    const onChanged = vi.fn();
    vi.mocked(hosted.ensureCloudMachine).mockResolvedValue(null);
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

  it("wakes a resting box with agents from a Wake button", async () => {
    vi.mocked(hosted.ensureCloudMachine).mockResolvedValue(null);
    render(<YourCloudPanel machine={box({ state: "stopped", sleeping: true })} onChanged={vi.fn()} />);
    expect(screen.getByText("Starts when you message an agent.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Wake" }));
    await waitFor(() => expect(hosted.ensureCloudMachine).toHaveBeenCalledOnce());
    expect(hosted.startCloudMachine).not.toHaveBeenCalled();
  });

  it("labels every bar with its figures", () => {
    render(
      <YourCloudPanel
        machine={box({
          room: { used_bytes: 2 * GB, total_bytes: 5 * GB },
          disk: { total_bytes: 15 * GB, available_bytes: 12.9 * GB, scope: "workspace" },
        })}
        onChanged={vi.fn()}
      />,
    );
    const bars = screen.getAllByRole("progressbar");
    expect(bars.map((bar) => bar.getAttribute("aria-label"))).toEqual([
      "Agents awake: 2 of 15",
      "Memory: 2.0 GB of 5.0 GB",
      "Disk: 2.1 GB of 15.0 GB",
    ]);
    for (const bar of bars) expect(bar.getAttribute("aria-valuetext")).toBe(bar.getAttribute("aria-label"));
  });

  it("warns at 80% and says the bar is full at 95%, in the PM's words", () => {
    render(
      <YourCloudPanel
        machine={box({ awake: { running: 12, max: 12 }, room: { used_bytes: 8, total_bytes: 10 } })}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText("Full right now. New work waits until a place frees up.")).toBeTruthy();
    expect(screen.getByText("Nearly full. Agents may slow down.")).toBeTruthy();
  });

  it("wakes a resting box with no agents", async () => {
    vi.mocked(hosted.ensureCloudMachine).mockResolvedValue(null);
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

  describe("setup checklist", () => {
    it("shows each missing step with its button, and they do what they say", () => {
      const onGiveLogin = vi.fn();
      const onAddAgent = vi.fn();
      render(
        <YourCloudPanel
          machine={box({ agents: [] })}
          onChanged={vi.fn()}
          loginSet={false}
          onGiveLogin={onGiveLogin}
          onAddAgent={onAddAgent}
        />,
      );
      expect(screen.getByText("Add your first agent on Switch cloud")).toBeTruthy();
      const list = screen.getByRole("list", { name: "Setting up your cloud" });
      expect(list.textContent).toContain("Your cloud is ready, done");
      fireEvent.click(screen.getByRole("button", { name: "Give login" }));
      fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
      expect(onGiveLogin).toHaveBeenCalledOnce();
      expect(onAddAgent).toHaveBeenCalledOnce();
    });

    it("folds away once all three are ticked, and stays hidden until the login is known", () => {
      render(<YourCloudPanel machine={box()} onChanged={vi.fn()} loginSet />);
      expect(screen.queryByRole("list", { name: "Setting up your cloud" })).toBeNull();
      cleanup();
      render(<YourCloudPanel machine={box({ agents: [] })} onChanged={vi.fn()} loginSet={null} />);
      expect(screen.queryByRole("list", { name: "Setting up your cloud" })).toBeNull();
    });

    it("its Start starts the box, in place of the panel's own Start", async () => {
      const onChanged = vi.fn();
      vi.mocked(hosted.ensureCloudMachine).mockResolvedValue(null);
      render(<YourCloudPanel machine={box({ state: "retained" })} onChanged={onChanged} loginSet={false} />);
      expect(screen.getAllByRole("button", { name: "Start" })).toHaveLength(1);
      expect(screen.getByTestId("setup-cloud").textContent).toContain("Your cloud is stopped");
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
      await waitFor(() => expect(onChanged).toHaveBeenCalled());
      expect(hosted.ensureCloudMachine).toHaveBeenCalledOnce();
    });

    it("offers no Add agent where the workspace can't have one", () => {
      render(<YourCloudPanel machine={box({ agents: [] })} onChanged={vi.fn()} loginSet />);
      expect(screen.getByText("No agent yet")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Add agent" })).toBeNull();
    });
  });

  it("explains a resting box with agents", () => {
    render(<YourCloudPanel machine={box({ sleeping: true })} onChanged={vi.fn()} />);
    expect(
      screen.getByText(
        "Your cloud is resting to save resources. It wakes in about a minute when you message an agent or press Wake it.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Wake" })).toBeTruthy();
  });

  it("fades the heading only when the state changes, and not on first show", () => {
    const { rerender, container } = render(<YourCloudPanel machine={box()} onChanged={vi.fn()} />);
    expect(container.querySelector("[data-state-fade]")).toBeNull();
    rerender(<YourCloudPanel machine={box({ sleeping: true })} onChanged={vi.fn()} />);
    expect(container.querySelector("[data-state-fade='on']")?.textContent).toContain("Resting");
  });
});
