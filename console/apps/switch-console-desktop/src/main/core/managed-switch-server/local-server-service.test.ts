import { beforeEach, expect, it, vi } from "vitest";
import type * as AppIdentity from "@shared/app-identity";
import type { StartLocalServerResult } from "@shared/core/managed-switch-server/managed-switch-server";
import type * as ManagedUpgrade from "./managed-upgrade";
import type { StartStackOptions } from "./pipeline";

const m = vi.hoisted(() => ({
  managed: vi.fn(),
  running: vi.fn(),
  version: vi.fn(),
  journal: vi.fn(),
  start: vi.fn<(opts: StartStackOptions) => Promise<StartLocalServerResult>>(),
  stop: vi.fn(),
  emit: vi.fn(),
  record: vi.fn(),
  ports: vi.fn(),
  remember: vi.fn(),
}));
vi.mock("@shared/app-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof AppIdentity>()),
  COMPATIBLE_SWITCH_VERSION: "0.11.0",
}));
vi.mock("@main/lib/events", () => ({ events: { emit: m.emit } }));
vi.mock("@main/lib/logger", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@main/core/telemetry/managed-server", () => ({
  reportManagedServerOutcome: vi.fn(),
  reportManagedServerStart: vi.fn(),
  reportManagedServerStartThrew: vi.fn(),
}));
vi.mock("@main/core/switch-servers/delete-server-agents", () => ({
  deleteAgentsForServer: vi.fn(),
}));
vi.mock("@main/core/switch-servers/servers-store", () => ({ getManagedServer: m.managed }));
vi.mock("./checkout-build", () => ({
  findCoreCheckout: () => null,
  isCheckoutBuildEnabled: vi.fn(),
  setCheckoutBuildEnabled: vi.fn(),
}));
const images = vi.hoisted(() => vi.fn());
vi.mock("./compose", () => ({
  isStackRunning: m.running,
  coreStartedAt: vi.fn(),
  runningImages: images,
}));
vi.mock("./local-activity", () => ({
  readLocalActivity: vi.fn(),
  recordLocalActivity: m.record,
}));
vi.mock("./ports", () => ({ readPersistedPorts: m.ports, rememberPorts: m.remember }));
vi.mock("./free-port", () => ({ findFreePort: async () => 51234 }));
vi.mock("./deployed-version", () => ({
  readVersionStatus: m.version,
  versionStatusOf: (deployed: { kind: string; version?: string }) =>
    deployed.kind === "deployed"
      ? { deployedVersion: deployed.version, drift: null }
      : { deployedVersion: null, drift: null },
}));
vi.mock("./telemetry-consent", () => ({ readDeployedTelemetry: vi.fn() }));
vi.mock("./managed-upgrade", async (importOriginal) => ({
  ...(await importOriginal<typeof ManagedUpgrade>()),
  readUpgradeJournal: m.journal,
}));
const resetStack = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./pipeline", () => ({ startStack: m.start, stopStack: m.stop, resetStack }));
vi.mock("./host/local-host", () => ({
  LocalServerHost: class {
    label = "this computer";
    removeFile = removeFile;
    dispose() {}
  },
}));
const removeFile = vi.hoisted(() => vi.fn(async () => {}));
const runtime = vi.hoisted(() => ({
  read: vi.fn(async (): Promise<"docker" | "native"> => "docker"),
  write: vi.fn(async () => {}),
}));
vi.mock("./runtime", () => ({ readLocalRuntime: runtime.read, writeLocalRuntime: runtime.write }));
vi.mock("./paths", () => ({
  localServerDir: () => "/data/local-switch-server",
  localServerBundleRoot: () => null,
}));
const native = vi.hoisted(() => ({
  start: vi.fn<
    (opts: unknown) => Promise<{
      result: StartLocalServerResult;
      bringUpMattermost: ((onProgress: (m: string) => void) => Promise<void>) | null;
    }>
  >(),
  stop: vi.fn(async () => {}),
  reset: vi.fn(async () => {}),
  running: vi.fn(async () => false),
  deployed: vi.fn(),
  launcher: vi.fn(),
}));
vi.mock("./native/native-stack", () => ({
  startNativeStack: native.start,
  stopNativeStack: native.stop,
  resetNativeStack: native.reset,
  nativeStackRunning: native.running,
  nativeStartedAt: vi.fn(),
  readNativeDeployedVersion: native.deployed,
  readNativeTelemetry: vi.fn(async () => ({ known: true, enabled: false })),
  nativeMattermostLauncher: native.launcher,
}));
const mattermost = vi.hoisted(() => ({
  write: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
}));
vi.mock("./native/mattermost", () => ({
  readMattermostEnabled: async () => null,
  writeMattermostEnabled: mattermost.write,
  stopMattermost: mattermost.stop,
}));

const { LocalServerService } = await import("./local-server-service");

/** Boot, and wait out whatever the boot check started. */
async function boot(service: InstanceType<typeof LocalServerService>): Promise<void> {
  await service.initialize();
  await service.ensureReady("Local").catch(() => {});
}

const behind = {
  deployedVersion: "0.10.0",
  drift: { deployed: "0.10.0", expected: "0.11.0", direction: "upgrade" },
};
const started: StartLocalServerResult = {
  kind: "started",
  serverId: "local",
  telemetryEnabled: false,
  warning: null,
};

/** A start that runs the upgrade the way the pipeline does: announce, then work. */
function upgradingStart(result: StartLocalServerResult = started) {
  return async (opts: StartStackOptions) => {
    opts.onUpgrade({ from: "0.10.0", to: "0.11.0" });
    return result;
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  m.managed.mockResolvedValue({ id: "local", name: "Local" });
  m.running.mockResolvedValue(true);
  m.version.mockResolvedValue(behind);
  m.journal.mockResolvedValue(null);
  m.start.mockImplementation(upgradingStart());
  runtime.read.mockResolvedValue("docker");
  native.running.mockResolvedValue(false);
  native.deployed.mockResolvedValue({ kind: "absent" });
  native.start.mockResolvedValue({ result: started, bringUpMattermost: null });
});

it("upgrades a running server that is behind at boot, without switching to it", async () => {
  const service = new LocalServerService();
  await boot(service);

  expect(m.start).toHaveBeenCalledOnce();
  expect(m.start).toHaveBeenCalledWith(expect.objectContaining({ activate: false }));
  expect(service.getStatus()).toMatchObject({ phase: "running", upgrade: null, drift: null });
  await expect(service.ensureReady("Local")).resolves.toBeUndefined();
});

it("shows the update while it runs and holds sessions until it has finished", async () => {
  let finish: (result: StartLocalServerResult) => void = () => {};
  m.start.mockImplementation(
    (opts) =>
      new Promise((resolve) => {
        opts.onUpgrade({ from: "0.10.0", to: "0.11.0" });
        finish = resolve;
      }),
  );
  const service = new LocalServerService();
  void service.initialize();
  let ready = false;
  const session = service.ensureReady("Local").then(() => {
    ready = true;
  });

  await vi.waitFor(() => expect(m.start).toHaveBeenCalledOnce());
  expect(service.getStatus().upgrade).toEqual({ state: "updating", from: "0.10.0", to: "0.11.0" });
  expect(ready).toBe(false);

  finish(started);
  await session;
  expect(ready).toBe(true);
  expect(service.getStatus().upgrade).toBeNull();
});

it("marks a stopped server that is behind to update at its next start, never earlier", async () => {
  m.running.mockResolvedValue(false);
  const service = new LocalServerService();
  await boot(service);

  expect(m.start).not.toHaveBeenCalled();
  expect(service.getStatus().upgrade).toEqual({ state: "pending", from: "0.10.0", to: "0.11.0" });
  await expect(service.ensureReady("Local")).rejects.toThrow(
    /Local is stopped on switch-core 0\.10\.0.*Start it/,
  );

  const upgraded = vi.fn();
  service.onUpgradeFinished(upgraded);
  expect(await service.start()).toEqual(started);
  expect(m.start).toHaveBeenCalledWith(expect.objectContaining({ activate: true }));
  await expect(service.ensureReady("Local")).resolves.toBeUndefined();
  // Sessions were refused while it was stopped, so they are told it is back.
  expect(upgraded).toHaveBeenCalledExactlyOnceWith("local");
});

it("resumes an interrupted upgrade even when no container survived it", async () => {
  m.running.mockResolvedValue(false);
  m.version.mockResolvedValue({ deployedVersion: "0.11.0", drift: null });
  m.journal.mockResolvedValue({ from: "0.10.0", to: "0.11.0", backup: "/b" });
  const service = new LocalServerService();
  await boot(service);

  expect(m.start).toHaveBeenCalledOnce();
  expect(service.getStatus().upgrade).toBeNull();
});

it("surfaces a failed backup with its error and refuses sessions until a retry succeeds", async () => {
  m.start.mockImplementationOnce(async (opts) => {
    opts.onUpgrade({ from: "0.10.0", to: "0.11.0" });
    throw new Error("pg_dumpall failed: No space left on device");
  });
  const service = new LocalServerService();
  const upgraded = vi.fn();
  service.onUpgradeFinished(upgraded);
  await boot(service);

  expect(service.getStatus()).toMatchObject({
    phase: "error",
    upgrade: {
      state: "failed",
      from: "0.10.0",
      to: "0.11.0",
      error: "pg_dumpall failed: No space left on device",
    },
  });
  await expect(service.ensureReady("Local")).rejects.toThrow(
    /Updating Local from switch-core 0\.10\.0 to 0\.11\.0 failed: pg_dumpall failed/,
  );
  expect(upgraded).not.toHaveBeenCalled();

  await service.start();
  await expect(service.ensureReady("Local")).resolves.toBeUndefined();
  expect(upgraded).toHaveBeenCalledExactlyOnceWith("local");
});

it("records an upgrade that never turned healthy as failed", async () => {
  m.start.mockImplementation(
    upgradingStart({ kind: "error", message: "The server did not become healthy in time." }),
  );
  const service = new LocalServerService();
  await boot(service);

  expect(service.getStatus().upgrade).toMatchObject({
    state: "failed",
    error: "The server did not become healthy in time.",
  });
});

it("fails loudly on an upgrade journal it cannot read", async () => {
  m.journal.mockRejectedValue(new Error("journal cannot be read"));
  const service = new LocalServerService();
  await boot(service);

  expect(m.start).not.toHaveBeenCalled();
  await expect(service.ensureReady("Local")).rejects.toThrow("journal cannot be read");
});

it("neither upgrades nor holds sessions for a downgrade or an unreadable version", async () => {
  for (const drift of [
    { deployed: "0.12.0", expected: "0.11.0", direction: "downgrade" },
    { deployed: "nightly", expected: "0.11.0", direction: "unknown" },
    { deployed: null, expected: "0.11.0", direction: "unreadable", reason: "daemon down" },
  ]) {
    m.version.mockResolvedValue({ deployedVersion: drift.deployed, drift });
    const service = new LocalServerService();
    await boot(service);
    expect(service.getStatus()).toMatchObject({ drift, upgrade: null });
    await expect(service.ensureReady("Local")).resolves.toBeUndefined();
  }
  expect(m.start).not.toHaveBeenCalled();
});

it("does nothing on an installation without a managed server", async () => {
  m.managed.mockResolvedValue(null);
  const service = new LocalServerService();
  await boot(service);

  expect(m.start).not.toHaveBeenCalled();
  expect(m.version).not.toHaveBeenCalled();
  await expect(service.ensureReady("Local")).resolves.toBeUndefined();
});

it("a Start click during the boot upgrade joins it instead of starting twice", async () => {
  let finish: (result: StartLocalServerResult) => void = () => {};
  m.start.mockImplementationOnce(
    (opts) =>
      new Promise((resolve) => {
        opts.onUpgrade({ from: "0.10.0", to: "0.11.0" });
        finish = resolve;
      }),
  );
  const service = new LocalServerService();
  void service.initialize();
  await vi.waitFor(() => expect(m.start).toHaveBeenCalledOnce());

  const click = service.start();
  finish(started);
  expect(await click).toEqual(started);
  expect(m.start).toHaveBeenCalledOnce();
});

it("keeps an owed upgrade pending across a stop", async () => {
  m.start.mockImplementationOnce(upgradingStart({ kind: "error", message: "unhealthy" }));
  const service = new LocalServerService();
  await boot(service);
  await service.stop();

  expect(service.getStatus()).toMatchObject({
    phase: "stopped",
    upgrade: { state: "pending", from: "0.10.0", to: "0.11.0" },
  });
});

it("resets the stack on this computer holding no lock, since nobody else shares it", async () => {
  const service = new LocalServerService();

  await service.reset();

  expect(resetStack).toHaveBeenCalledWith(expect.anything(), null);
});

it("says its state has been read once the boot check is done, whatever it found", async () => {
  m.running.mockResolvedValue(false);
  m.version.mockResolvedValue({ deployedVersion: "0.11.0", drift: null });
  const service = new LocalServerService();
  expect(service.getStatus().checked).toBe(false);
  await boot(service);
  expect(service.getStatus()).toMatchObject({ phase: "stopped", checked: true });
});

it("records what happens to the stack: an update, a start, a stop, a failed start", async () => {
  m.running.mockResolvedValue(false);
  const service = new LocalServerService();
  await boot(service);
  await service.start();
  expect(m.record.mock.calls).toEqual([
    ["updated", "0.11.0"],
    ["started", null],
  ]);

  m.record.mockClear();
  await service.stop();
  m.start.mockResolvedValue({ kind: "error", message: "bind: address already in use" });
  await service.start();
  expect(m.record.mock.calls).toEqual([
    ["stopped", null],
    ["start-failed", "bind: address already in use"],
  ]);
});

it("moves only the service on the port that was taken, then starts", async () => {
  m.running.mockResolvedValue(false);
  m.version.mockResolvedValue({ deployedVersion: "0.11.0", drift: null });
  m.start.mockResolvedValue(started);
  m.ports.mockResolvedValue({ gateway: 8000, api: 8001, mattermost: 8065, postgres: 5432 });
  const service = new LocalServerService();
  await boot(service);

  await expect(service.useAnotherPort(8000)).resolves.toEqual(started);
  expect(m.remember).toHaveBeenCalledWith(expect.anything(), {
    gateway: 51234,
    api: 8001,
    mattermost: 8065,
    postgres: 5432,
  });
  expect(m.start).toHaveBeenCalledOnce();
});

it("refuses to move a port the server does not use", async () => {
  m.ports.mockResolvedValue({ gateway: 8000, api: 8001, mattermost: 8065, postgres: 5432 });
  const service = new LocalServerService();
  await expect(service.useAnotherPort(9999)).rejects.toThrow("port 9999");
  expect(m.remember).not.toHaveBeenCalled();
});

it("reports a stop that errored but left the stack down as stopped", async () => {
  m.version.mockResolvedValue({ deployedVersion: "0.11.0", drift: null });
  const service = new LocalServerService();
  await boot(service);
  m.stop.mockRejectedValue(new Error("compose down failed: Container switch Stopping"));
  images.mockResolvedValue(new Map());

  await expect(service.stop()).resolves.toBeUndefined();
  expect(service.getStatus()).toMatchObject({ phase: "stopped", error: null, failedTo: null });
  expect(m.record).toHaveBeenCalledWith("stopped", null);
});

it("reports a stop that errored with the stack still up, or unreadable, as a failed stop", async () => {
  m.version.mockResolvedValue({ deployedVersion: "0.11.0", drift: null });
  const service = new LocalServerService();
  await boot(service);
  m.stop.mockRejectedValue(new Error("compose down failed"));
  images.mockRejectedValue(new Error("docker is gone"));

  await expect(service.stop()).rejects.toThrow("compose down failed");
  expect(service.getStatus()).toMatchObject({
    phase: "error",
    failedTo: "stop",
    error: "compose down failed",
  });

  // The next start says nothing about the stop any more.
  m.start.mockResolvedValue({ kind: "error", message: "bind: address already in use" });
  await service.start();
  expect(service.getStatus()).toMatchObject({ phase: "error", failedTo: null });
});

it("starts a native server without the Docker pipeline, and records the runtime", async () => {
  runtime.read.mockResolvedValue("native");
  const service = new LocalServerService();
  await boot(service);

  const result = await service.start();

  expect(result).toEqual(started);
  expect(native.start).toHaveBeenCalledOnce();
  expect(m.start).not.toHaveBeenCalled();
  expect(runtime.write).toHaveBeenCalledWith("/data/local-switch-server", "native");
  expect(service.getStatus()).toMatchObject({ phase: "running", runtime: "native" });
});

it("reads a native server as running from its processes, not from Docker", async () => {
  runtime.read.mockResolvedValue("native");
  native.running.mockResolvedValue(true);
  native.deployed.mockResolvedValue({ kind: "deployed", version: "0.11.0", source: "env-file" });
  const service = new LocalServerService();
  await boot(service);

  expect(m.running).not.toHaveBeenCalled();
  expect(service.getStatus()).toMatchObject({
    phase: "running",
    runtime: "native",
    deployedVersion: "0.11.0",
  });
});

it("stops a native server through its own stop", async () => {
  runtime.read.mockResolvedValue("native");
  native.deployed.mockResolvedValue({ kind: "deployed", version: "0.11.0", source: "env-file" });
  const service = new LocalServerService();
  await boot(service);

  await service.stop();

  expect(native.stop).toHaveBeenCalledOnce();
  expect(m.stop).not.toHaveBeenCalled();
  expect(service.getStatus()).toMatchObject({ phase: "stopped" });
});

it("moves a Docker server to native when it is reset", async () => {
  m.version.mockResolvedValue({ deployedVersion: "0.11.0", drift: null });
  const service = new LocalServerService();
  await boot(service);

  await service.reset();

  expect(resetStack).toHaveBeenCalledOnce();
  expect(native.reset).not.toHaveBeenCalled();
  expect(removeFile).toHaveBeenCalledWith("standalone-docker-compose.yml");
  expect(removeFile).toHaveBeenCalledWith(".env");
  expect(runtime.write).toHaveBeenCalledWith("/data/local-switch-server", "native");
  expect(service.getStatus()).toMatchObject({ phase: "stopped", runtime: "native" });
});

it("brings Mattermost up after the start has returned, and says so when it fails", async () => {
  runtime.read.mockResolvedValue("native");
  let fail: (error: Error) => void = () => {};
  native.start.mockResolvedValue({
    result: started,
    bringUpMattermost: () =>
      new Promise<void>((_resolve, reject) => {
        fail = reject;
      }),
  });
  const service = new LocalServerService();
  await boot(service);

  await expect(service.start()).resolves.toEqual(started);
  expect(service.getStatus()).toMatchObject({ phase: "running", mattermostState: "starting" });

  fail(new Error("Docker is not available"));
  await vi.waitFor(() => expect(service.getStatus().mattermostState).toBe("failed"));
  expect(service.getStatus()).toMatchObject({
    phase: "running",
    notice: "The server is running, but Mattermost could not be set up: Docker is not available",
  });
});

it("reports Mattermost running once it is up", async () => {
  runtime.read.mockResolvedValue("native");
  native.start.mockResolvedValue({ result: started, bringUpMattermost: async () => {} });
  const service = new LocalServerService();
  await boot(service);

  await service.start();
  await vi.waitFor(() => expect(service.getStatus().mattermostState).toBe("running"));
});

it("turns Mattermost on for a running server without restarting it", async () => {
  runtime.read.mockResolvedValue("native");
  native.running.mockResolvedValue(true);
  native.deployed.mockResolvedValue({ kind: "deployed", version: "0.11.0", source: "env-file" });
  const bringUp = vi.fn(async () => {});
  native.launcher.mockResolvedValue(bringUp);
  const service = new LocalServerService();
  await boot(service);

  await service.setMattermost(true);

  expect(native.start).not.toHaveBeenCalled();
  expect(mattermost.write).toHaveBeenCalledWith("/data/local-switch-server", true);
  await vi.waitFor(() => expect(service.getStatus().mattermostState).toBe("running"));
  expect(bringUp).toHaveBeenCalledOnce();

  await service.setMattermost(false);
  expect(mattermost.stop).toHaveBeenCalledWith(expect.anything(), false);
  expect(service.getStatus()).toMatchObject({ phase: "running", mattermostState: null });
});
