import { describe, expect, it } from "vitest";
import type { CloudMachine } from "../../data/hostedCloud";
import type { Controller, ProviderInfo } from "../../data/management";
import { BOX_LOGINS, boxPlacement, cloudAgentFormValid, cloudAgentRequest, cloudProviders } from "./cloudAgent";

const BOX: CloudMachine = {
  machine_id: "m-1",
  state: "ready",
  desired_state: "running",
  stop_reason: null,
  sleeping: false,
  revision: 3,
  controller_id: "box-ctl",
  backend: "box",
  agents: [],
  error: null,
  error_code: null,
  room: null,
  awake: null,
  ai_calls_today: null,
};

function controller(over: Partial<Controller>): Controller {
  return {
    id: "box-ctl",
    name: "Switch cloud",
    description: null,
    kind: "ec2",
    platform: null,
    version: null,
    state: "online",
    last_seen_at: null,
    connection: null,
    status: null,
    release: null,
    assignment_revision: 1,
    created_at: "2026-11-05T00:00:00Z",
    revoked_at: null,
    can_edit: true,
    can_remove: true,
    ...over,
  };
}

describe("boxPlacement", () => {
  it("is ready on the box's own controller once it is online", () => {
    expect(boxPlacement(BOX, [controller({})])).toEqual({ kind: "ready", controllerId: "box-ctl" });
  });

  it("never picks another machine, even one labelled as a cloud machine", () => {
    const mac = controller({ id: "mac", name: "My Mac", kind: "ec2" });
    expect(boxPlacement(BOX, [mac])).toEqual({ kind: "starting" });
    expect(boxPlacement({ ...BOX, controller_id: null }, [mac])).toEqual({ kind: "starting" });
  });

  it.each([
    ["offline", controller({ state: "offline" })],
    ["revoked", controller({ revoked_at: "2026-11-05T01:00:00Z", state: "revoked" })],
  ])("keeps starting while the box's controller is %s", (_name, ctl) => {
    expect(boxPlacement(BOX, [ctl])).toEqual({ kind: "starting" });
  });

  it("keeps starting while there's no box yet, or it's asleep and waking", () => {
    expect(boxPlacement(null, [])).toEqual({ kind: "starting" });
    expect(
      boxPlacement({ ...BOX, desired_state: "running", sleeping: true, state: "stopped" }, [
        controller({ state: "offline" }),
      ]),
    ).toEqual({ kind: "starting" });
  });

  it("says a box its owner stopped is stopped, rather than wait for ever", () => {
    expect(
      boxPlacement({ ...BOX, desired_state: "stopped", stop_reason: "owner", state: "stopped" }, [
        controller({ state: "offline" }),
      ]),
    ).toEqual({ kind: "stopped" });
  });

  it("never uses a v1 cloud machine, even with its controller online", () => {
    expect(boxPlacement({ ...BOX, backend: "vm" }, [controller({})]).kind).toBe("error");
    expect(boxPlacement({ ...BOX, backend: undefined }, [controller({})]).kind).toBe("error");
  });

  it("says why a box is in error", () => {
    expect(boxPlacement({ ...BOX, state: "error", error: "No room on Switch cloud." }, [])).toEqual({
      kind: "error",
      message: "No room on Switch cloud.",
    });
  });
});

describe("the create request", () => {
  const form = { name: "web-frontend", description: " Builds the site ", provider: "claude", model: "", instructions: "Be brief." };

  it("puts the agent on the box's controller, isolated and running", () => {
    expect(cloudAgentRequest(form, "box-ctl")).toEqual({
      name: "web-frontend",
      description: "Builds the site",
      display_name: null,
      controller_id: "box-ctl",
      desired_state: "running",
      definition: {
        provider: "claude",
        model: null,
        instructions: "Be brief.",
        auto_mode: true,
        auto_approve: false,
        directory: null,
        isolation: "isolated",
        advanced_config: {},
      },
    });
  });

  it.each([
    ["a bad name", { ...form, name: "Web Frontend" }],
    ["no description", { ...form, description: "  " }],
    ["no provider", { ...form, provider: "" }],
  ])("refuses %s", (_name, bad) => {
    expect(cloudAgentFormValid(bad)).toBe(false);
  });

  it("takes a good form", () => {
    expect(cloudAgentFormValid(form)).toBe(true);
  });
});

describe("the providers a cloud agent is offered", () => {
  const listed: ProviderInfo[] = [
    { id: "cursor", label: "Cursor", advanced_fields: [] },
    { id: "claude", label: "Claude", advanced_fields: [] },
    { id: "opencode", label: "OpenCode", advanced_fields: [] },
    { id: "codex", label: "Codex", advanced_fields: [] },
  ];

  it("are only those a box takes a login for, in the server's order", () => {
    expect(cloudProviders(listed).map((p) => p.id)).toEqual(["claude", "codex"]);
  });

  it("match the box's provider gateway: Claude's three logins and Codex's API key", () => {
    expect(BOX_LOGINS).toEqual({ claude: ["setup-token", "api-key", "vertex"], codex: ["api-key"] });
  });

  it("aren't fooled by a provider named like an object's own property", () => {
    expect(cloudProviders([{ id: "toString", label: "x", advanced_fields: [] }])).toEqual([]);
  });
});
