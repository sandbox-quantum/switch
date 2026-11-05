import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureCloudMachine,
  fetchCloudPlace,
  fetchCloudAgents,
  fetchCloudMachine,
  readMachine,
  startCloudMachine,
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
