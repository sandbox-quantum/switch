/**
 * How a device is doing, from what it last reported: when it connected or
 * why it went, whether its controller runs the release Switch names, and
 * each provider's install and sign-in. The table says it in a line; the
 * device's details dialog says all of it.
 */
import type { ProviderStatus, WorkspaceDevice } from "../../data/management";
import { absoluteTitle, formatRelative } from "../../theme/format";

const DISCONNECT_REASON: Record<string, string> = {
  socket_closed: "its controller stopped or lost its connection",
  heartbeat_lapsed: "its connection stopped responding",
  server_shutdown: "Switch restarted",
  server_lost: "Switch stopped responding",
  taken_over: "another instance of its controller took over",
  revoked: "it was removed",
};

const NEVER_CONNECTED =
  "Has never connected to Switch. Start its controller with switch-agent-controller run.";

/** When the device connected, or when and why it stopped. */
export function connectionDetail(device: WorkspaceDevice): string {
  const connection = device.connection;
  if (device.state === "revoked") return "Removed from Switch.";
  if (device.state === "unknown" || connection === null) return NEVER_CONNECTED;
  if (device.state === "online") return `Connected since ${absoluteTitle(connection.connected_at)}.`;
  const why = connection.disconnect_reason
    ? (DISCONNECT_REASON[connection.disconnect_reason] ?? connection.disconnect_reason)
    : null;
  const when = connection.disconnected_at !== null ? ` ${formatRelative(connection.disconnected_at)}` : "";
  return `Disconnected${when}${why ? `: ${why}` : ""}.`;
}

export interface ControllerHealth {
  /** What its controller runs, as it last said. */
  running: string | null;
  /** Where it stands against the release Switch names, when it is behind. */
  problem: { label: string; color: "warning" | "error" } | null;
  /** The versions, and why it is where it is. */
  detail: string;
}

/** Whether the device's controller runs the release Switch names: on it,
 *  waiting for its sessions to end, or stuck, with why. */
export function controllerHealth(device: WorkspaceDevice): ControllerHealth {
  const running = device.version;
  const release = device.release;
  if (release === null || release.current) {
    return {
      running,
      problem: null,
      detail:
        release !== null
          ? `Runs ${release.wanted}, the release Switch names.`
          : device.updated_by_console
            ? "Updates with Switch Console, which runs it."
            : "Switch names no controller release for this device.",
    };
  }
  const update = device.update;
  const names = `Runs ${running ?? "an unknown version"}; Switch names ${release.wanted}.`;
  if (device.state !== "online" || update === null || update.target !== release.wanted) {
    return {
      running,
      problem: { label: "behind", color: "warning" },
      detail: `${names} ${
        device.state === "online"
          ? "It has said nothing about moving to it: a controller older than self-update never does. Reinstall it once on the device, or, if Switch Console runs it on an SSH host, update Console."
          : "It moves to it once it is connected again."
      }`,
    };
  }
  if (update.state === "waiting_idle") {
    return {
      running,
      problem: { label: "updating when idle", color: "warning" },
      detail: `${names} It moves to it once no session is running on it.`,
    };
  }
  if (update.state === "restart_needed") {
    return {
      running,
      problem: { label: "restart needed", color: "warning" },
      detail: `${names} ${update.problem ?? "It installed it; restart it to run it."}`,
    };
  }
  return {
    running,
    problem: { label: "update failed", color: "error" },
    detail: `${names} ${update.problem ?? "It did not say why."}`,
  };
}

/** What is wrong with a provider it reported installed, or null when
 *  nothing is: one it reported missing is not a problem, only absent. */
export function providerProblem(report: ProviderStatus): string | null {
  if (!report.installed || report.auth === "ok") return null;
  return report.auth === "unknown" ? "sign-in unknown" : `sign-in ${report.auth}`;
}

/** What needs someone's attention on the device, one line each: its
 *  controller off the release, and each provider whose sign-in is not good. */
export function deviceProblems(device: WorkspaceDevice, label: (provider: string) => string): string[] {
  if (device.state === "revoked") return [];
  const problems: string[] = [];
  const controller = controllerHealth(device);
  if (controller.problem !== null) problems.push(`Controller ${controller.problem.label}.`);
  for (const report of device.provider_reports) {
    const problem = providerProblem(report);
    if (problem !== null) problems.push(`${label(report.provider)}: ${problem}.`);
  }
  return problems;
}
