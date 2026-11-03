import type {
  DeviceAgentReport,
  DeviceDetail,
  ManagedAgentView,
} from '@shared/core/managed-agents/managed-agents';

/** One agent placed on a device, with what the device last reported for it. */
export type DeviceAgentRow = {
  agent: ManagedAgentView;
  /** Null when the device has not reported on it yet. */
  report: DeviceAgentReport | null;
};

/** The owner's managed agents placed on the device, by name, each with the device's report on it. */
export function deviceAgents(
  device: Pick<DeviceDetail, 'id' | 'report'>,
  agents: readonly ManagedAgentView[]
): DeviceAgentRow[] {
  const reports = new Map(device.report.agents.map((report) => [report.agentId, report]));
  return agents
    .filter((agent) => agent.machine?.id === device.id)
    .map((agent) => ({ agent, report: reports.get(agent.agentId) ?? null }))
    .sort((a, b) =>
      (a.agent.displayName || a.agent.name).localeCompare(b.agent.displayName || b.agent.name)
    );
}

const PLATFORM_NAMES: Record<string, string> = {
  macos: 'macOS',
  darwin: 'macOS',
  linux: 'Linux',
  windows: 'Windows',
  win32: 'Windows',
};

/** An operating system as a device reports it (`macos`, `darwin`, `linux`, …), in words. */
export function osName(os: string): string {
  return PLATFORM_NAMES[os] ?? os;
}

/** A device's platform in words, e.g. "macOS 15.1 (arm64)"; null when it has not said. */
export function platformLabel(platform: DeviceDetail['report']['platform']): string | null {
  if (!platform) return null;
  const os = osName(platform.os);
  const version = platform.osVersion ? ` ${platform.osVersion}` : '';
  const arch = platform.arch ? ` (${platform.arch})` : '';
  return `${os}${version}${arch}`;
}

/** A byte count in binary units, one decimal under ten: "512 MB", "7.5 GB". */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * The controller's installer, as published on the default branch: it finds
 * the newest `switch-agent-controller` release and installs it with npm.
 */
export const CONTROLLER_INSTALL_SCRIPT_URL =
  'https://raw.githubusercontent.com/sandbox-quantum/switch/main/console/packages/agent-controller/install.sh';

/** One word for a POSIX shell: as it is when nothing in it is special, else single-quoted. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The commands that enroll another computer with a one-time code, as the
 * gateway's Add machine dialog gives them: one that installs the controller,
 * enrolls and starts it as a service, and one for a computer that has it
 * installed already. A blank name is left out, so it defaults to the host name.
 */
export function enrollCommands(params: {
  serverUrl: string;
  code: string;
  name: string;
  description: string;
}): { install: string; enroll: string } {
  const name = params.name.trim();
  const description = params.description.trim();
  const options = [
    '--server',
    params.serverUrl,
    '--code',
    params.code,
    ...(name ? ['--name', name] : []),
    ...(description ? ['--description', description] : []),
  ];
  return {
    install: `curl -fsSL ${CONTROLLER_INSTALL_SCRIPT_URL} | sh -s -- ${options.map(shellQuote).join(' ')}`,
    enroll: `${['switch-agent-controller', 'enroll', ...options].map(shellQuote).join(' ')} && switch-agent-controller install-service`,
  };
}
