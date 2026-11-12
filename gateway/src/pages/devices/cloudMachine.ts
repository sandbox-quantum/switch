import type { CloudMachine, CloudMachineAction } from "../../data/management";

/** What the Devices page shows of its owner's cloud machine: the state, any
 *  trouble, and what they may do with it. As Switch Console's machine card
 *  words it, so the two say the same of the same machine. */
export interface CloudPresentation {
  label: string;
  problem: string | null;
  actions: CloudMachineAction[];
}

function isRetained(machine: CloudMachine): boolean {
  return (
    machine.desired_state === "retained" ||
    (machine.state === "retained" && machine.desired_state !== "running")
  );
}

function isBeingDeleted(machine: CloudMachine, now: number): boolean {
  if (machine.state === "error" && machine.error_code === "machine_needs_attention") return false;
  return (
    machine.state === "deleting" ||
    machine.desired_state === "deleted" ||
    (isRetained(machine) && machine.retain_until !== null && Date.parse(machine.retain_until) <= now)
  );
}

function isAsleep(machine: CloudMachine, now: number): boolean {
  return (
    machine.sleeping &&
    !machine.stopped_by_admin &&
    !isBeingDeleted(machine, now) &&
    machine.state !== "error" &&
    !isRetained(machine)
  );
}

function label(machine: CloudMachine, now: number): string {
  if (machine.stopped_by_admin) return "Stopped by an administrator";
  if (isBeingDeleted(machine, now)) return "Deleting disk…";
  if (machine.state === "error") return "Error";
  if (isRetained(machine)) return "Retained";
  if (isAsleep(machine, now)) return "Sleeping";
  if (machine.desired_state === "stopped") return machine.state === "stopped" ? "Stopped" : "Stopping…";
  if (machine.state === "ready") return "Ready";
  return "Provisioning";
}

function problem(machine: CloudMachine, now: number): string | null {
  if (machine.stopped_by_admin)
    return "An administrator stopped the machine. Contact them to have it released.";
  if (isBeingDeleted(machine, now)) return null;
  if (machine.error_code === "disk_full") return "The machine's disk is full.";
  if (machine.state !== "error") return null;
  if (machine.error_code === "machine_needs_attention")
    return "The machine needs attention. Contact your administrator.";
  if (machine.error_code === "machine_connect_timeout")
    return "The machine did not connect in time. Retry, and if it fails again contact your administrator.";
  return machine.error ?? "The machine could not start.";
}

function actions(machine: CloudMachine, now: number): CloudMachineAction[] {
  if (machine.stopped_by_admin || isBeingDeleted(machine, now)) return [];
  if (machine.state === "error") return machine.error_code === "machine_needs_attention" ? [] : ["retry"];
  if (
    isRetained(machine) ||
    machine.state === "retained" ||
    machine.state === "deleting" ||
    machine.state === "deleted" ||
    machine.desired_state === "deleted"
  )
    return [];
  const offered: CloudMachineAction[] = [];
  if (machine.desired_state === "running" || machine.sleeping) offered.push("stop");
  if (machine.desired_state === "stopped") offered.push("start");
  return offered;
}

export function cloudPresentation(machine: CloudMachine, now: number): CloudPresentation {
  return { label: label(machine, now), problem: problem(machine, now), actions: actions(machine, now) };
}
