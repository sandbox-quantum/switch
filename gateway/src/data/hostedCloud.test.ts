import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REFRESH_MS,
  WAKING_REFRESH_MS,
  boxStarting,
  ensureCloudMachine,
  fetchCloudPlace,
  fetchCloudAgents,
  fetchCloudMachine,
  readMachine,
  startCloudMachine,
  useCloudView,
} from "./hostedCloud";

const summary = {
  machine_id: "m-1",
  state: "ready",
  desired_state: "running",
  stop_reason: null,
  sleeping: false,
  revision: 2,
  agents: ["a1"],
  controller_id: "c-1",
  backend: "box",
  room: { used_bytes: 1, total_bytes: 4 },
  awake: { running: 1, max: 15 },
  ai_calls_today: null,
};

function answer(body: unknown, status = 200) {
  return vi.fn().mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("readMachine", () => {
  it("reads a summary in shape", () => {
    expect(readMachine(summary)).toMatchObject({
      machine_id: "m-1",
      revision: 2,
      room: { used_bytes: 1, total_bytes: 4 },
      awake: { running: 1, max: 15 },
    });
  });

  it("drops a machine whose identity or state is out of shape", () => {
    expect(readMachine({ ...summary, state: "exploded" })).toBeNull();
    expect(readMachine({ ...summary, revision: "2" })).toBeNull();
    expect(readMachine({ ...summary, machine_id: 7 })).toBeNull();
    expect(readMachine(null)).toBeNull();
  });

  it("reads the disk with only an agreed scope", () => {
    const disk = { total_bytes: 100, available_bytes: 40 };
    expect(readMachine({ ...summary, disk: { ...disk, scope: "workspace" } })?.disk).toEqual({
      ...disk,
      scope: "workspace",
    });
    expect(readMachine({ ...summary, disk: { ...disk, scope: "unknown" } })?.disk?.scope).toBe(
      "unknown",
    );
    // Anything else reads as not said, so the disk isn't shown.
    expect(readMachine({ ...summary, disk: { ...disk, scope: "system" } })?.disk).toEqual(disk);
    expect(readMachine({ ...summary, disk })?.disk).toEqual(disk);
    expect(readMachine({ ...summary, disk: null })?.disk).toBeNull();
    expect(readMachine({ ...summary, disk: { total_bytes: -1, available_bytes: 0 } })?.disk).toBeNull();
  });

  it("reads an out-of-shape figure as missing, not the whole box", () => {
    const machine = readMachine({
      ...summary,
      room: { used_bytes: 1, total_bytes: 0 },
      awake: { running: -1, max: 15 },
      ai_calls_today: { used: 1, cap: 10, capped: false, resets_at: "soon" },
      stop_reason: "because",
    });
    expect(machine).toMatchObject({ room: null, awake: null, ai_calls_today: null, stop_reason: null });
  });
});

describe("the owner routes", () => {
  it("picks the person's v2 box, never a v1 machine", async () => {
    const fetch = answer({
      available: true,
      machines: [{ ...summary, machine_id: "v1", backend: "vm" }, summary],
    });
    vi.stubGlobal("fetch", fetch);

    expect((await fetchCloudMachine())?.machine_id).toBe("m-1");
    expect(fetch).toHaveBeenCalledWith(
      "/gateway/hosted-machines",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
  });

  it("has no box when there is none", async () => {
    vi.stubGlobal("fetch", answer({ available: false, machines: [] }));
    expect(await fetchCloudMachine()).toBeNull();
  });

  it("says whether this workspace may have a box, from `available`", async () => {
    vi.stubGlobal("fetch", answer({ available: true, machines: [] }));
    expect(await fetchCloudPlace()).toEqual({ available: true, machine: null });
    vi.stubGlobal("fetch", answer({ machines: [summary] }));
    expect((await fetchCloudPlace()).available).toBe(false); // missing reads as no
  });

  it("answers the box ensure gives back, and nothing for a v1 machine", async () => {
    vi.stubGlobal("fetch", answer(summary));
    expect((await ensureCloudMachine())?.machine_id).toBe("m-1");
    vi.stubGlobal("fetch", answer({ ...summary, backend: "vm" }));
    expect(await ensureCloudMachine()).toBeNull();
  });

  it("keeps only agent states in shape", async () => {
    vi.stubGlobal(
      "fetch",
      answer({
        available: true,
        agents: [
          { agent_id: "a1", state: "resting", box_stopped: true, last_reply_at: null },
          { agent_id: "a2", state: "dancing" },
          "nonsense",
        ],
      }),
    );
    const agents = await fetchCloudAgents();
    expect(agents.map((a) => [a.agent_id, a.state, a.box_stopped])).toEqual([
      ["a1", "resting", true],
    ]);
  });

  it("wakes with ensure and starts an owner's stop with lifecycle and the revision", async () => {
    const fetch = answer(summary);
    vi.stubGlobal("fetch", fetch);
    await ensureCloudMachine();
    await startCloudMachine({ ...readMachine(summary)!, machine_id: "m/1" });

    expect(fetch.mock.calls[0][0]).toBe("/gateway/hosted-machines/ensure");
    expect(fetch.mock.calls[0][1].method).toBe("POST");
    expect(fetch.mock.calls[1][0]).toBe("/gateway/hosted-machines/m%2F1/lifecycle");
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ action: "start", revision: 2 });
  });
});

describe("boxStarting", () => {
  it("is what the panel shows as Starting…, never a resting, paused or put-away box", () => {
    expect(boxStarting({ ...summary, state: "provisioning" } as never)).toBe(true);
    expect(boxStarting({ ...summary, state: "queued" } as never)).toBe(true);
    expect(boxStarting({ ...summary, state: "stopped" } as never)).toBe(true);
    expect(boxStarting({ ...summary, state: "stopped", sleeping: true } as never)).toBe(false);
    expect(boxStarting({ ...summary, state: "stopped", stop_reason: "paused" } as never)).toBe(false);
    expect(boxStarting({ ...summary, state: "stopped", desired_state: "stopped" } as never)).toBe(false);
    expect(boxStarting({ ...summary, state: "retained", desired_state: "retained" } as never)).toBe(false);
    expect(boxStarting(summary as never)).toBe(false);
    expect(boxStarting(null)).toBe(false);
  });
});

describe("useCloudView's reading rate", () => {
  afterEach(() => {
    // Unmount each test's hook, so its timer and tab listener don't carry over.
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function watch(machine: object) {
    vi.useFakeTimers();
    const fetch = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(url.endsWith("/hosted-machines") ? { available: true, machines: [machine] } : { agents: [] }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const hook = renderHook(() => useCloudView(true));
    const settle = () => act(() => vi.advanceTimersByTimeAsync(0));
    const reads = () => fetch.mock.calls.filter(([url]) => String(url).endsWith("/hosted-machines")).length;
    const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
    await settle();
    return { hook, reads, wait, settle };
  }

  it("reads every 15 s while the box is up", async () => {
    expect(REFRESH_MS).toBe(15_000);
    const { reads, wait } = await watch(summary);
    const first = reads();
    await wait(WAKING_REFRESH_MS);
    expect(reads()).toBe(first);
    await wait(REFRESH_MS - WAKING_REFRESH_MS);
    expect(reads()).toBe(first + 1);
  });

  it("reads every 5 s while the box is starting", async () => {
    expect(WAKING_REFRESH_MS).toBe(5_000);
    const { reads, wait } = await watch({ ...summary, state: "provisioning" });
    const first = reads();
    await wait(WAKING_REFRESH_MS);
    expect(reads()).toBe(first + 1);
    await wait(WAKING_REFRESH_MS);
    expect(reads()).toBe(first + 2);
  });

  it("reads every 5 s while something hurries it, and back to 15 s once let go", async () => {
    const { hook, reads, wait, settle } = await watch(summary);
    let release = () => {};
    act(() => {
      release = hook.result.current.hurry();
    });
    await settle();
    const hurried = reads();
    await wait(WAKING_REFRESH_MS);
    expect(reads()).toBe(hurried + 1);
    act(() => release());
    // Letting go twice counts once.
    act(() => release());
    await settle();
    const calm = reads();
    await wait(WAKING_REFRESH_MS);
    expect(reads()).toBe(calm);
    await wait(REFRESH_MS - WAKING_REFRESH_MS);
    expect(reads()).toBe(calm + 1);
  });

  it("reads once straight away when the tab comes back", async () => {
    const { reads, settle } = await watch(summary);
    const before = reads();
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    expect(reads()).toBe(before + 1);
  });
});
