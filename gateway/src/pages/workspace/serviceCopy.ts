import type { WorkspaceService } from "../../data/api";

type Reach = Pick<WorkspaceService, "connected_members" | "granted_agents">;

/** Who a service reaches in the workspace, as one line. */
export function serviceStanding(service: Reach): string {
  const members = service.connected_members;
  const agents = service.granted_agents;
  if (members === 0 && agents === 0) return "Nobody has connected it yet";
  const connected = `${members} ${members === 1 ? "member" : "members"} connected`;
  const using = `${agents} ${agents === 1 ? "agent uses" : "agents use"} it`;
  return `${connected} · ${using}`;
}

/** What to ask before switching a service off, or null when it reaches
 * nobody: switching it off ends other people's running sessions' use of it. */
export function switchOffConfirmation(
  service: Reach & Pick<WorkspaceService, "name">,
): { title: string; description: string } | null {
  const members = service.connected_members;
  const agents = service.granted_agents;
  if (members === 0 && agents === 0) return null;
  const connected = `${members} ${members === 1 ? "member is" : "members are"} connected`;
  const using = `${agents} ${agents === 1 ? "agent uses" : "agents use"} it`;
  return {
    title: `Switch ${service.name} off for this workspace?`,
    description: `${connected} and ${using}. Their sessions lose it within a minute. Their grants are kept, so switching it back on returns them.`,
  };
}

/** Who last changed a switch, and when; one nobody touched takes the
 * workspace's default. */
export function serviceSwitchNote(
  service: Pick<WorkspaceService, "enabled" | "updated_by_name" | "updated_at">,
  formatTime: (iso: string) => string,
): string {
  if (service.updated_at === null) return service.enabled ? "On by default." : "Off by default.";
  const state = service.enabled ? "on" : "off";
  const who = service.updated_by_name ?? "a deleted account";
  return `Switched ${state} by ${who}, ${formatTime(service.updated_at)}.`;
}
